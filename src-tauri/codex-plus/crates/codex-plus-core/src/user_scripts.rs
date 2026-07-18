use std::collections::{BTreeMap, hash_map::DefaultHasher};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::Context;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::script_market::MarketScript;

const USER_SCRIPT_RUNTIME_REVISION: &str = "2";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UserScriptConfig {
    pub enabled: bool,
    pub scripts: BTreeMap<String, bool>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub market: BTreeMap<String, MarketScriptInstall>,
}

impl Default for UserScriptConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            scripts: BTreeMap::new(),
            market: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MarketScriptInstall {
    pub id: String,
    pub name: String,
    pub version: String,
    pub script_url: String,
    pub homepage: String,
    pub installed_at: String,
}

#[derive(Debug, Clone)]
pub struct UserScriptManager {
    builtin_dir: PathBuf,
    user_dir: PathBuf,
    config_path: PathBuf,
    config_lock: Arc<Mutex<()>>,
}

impl UserScriptManager {
    pub fn new(
        builtin_dir: impl Into<PathBuf>,
        user_dir: impl Into<PathBuf>,
        config_path: impl Into<PathBuf>,
    ) -> Self {
        Self {
            builtin_dir: builtin_dir.into(),
            user_dir: user_dir.into(),
            config_path: config_path.into(),
            config_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn load_config(&self) -> UserScriptConfig {
        let _guard = self.config_lock.lock().unwrap();
        self.load_config_unlocked()
    }

    fn load_config_unlocked(&self) -> UserScriptConfig {
        let Ok(text) = fs::read_to_string(&self.config_path) else {
            return UserScriptConfig::default();
        };
        let Ok(Value::Object(raw)) = serde_json::from_str::<Value>(&text) else {
            return UserScriptConfig::default();
        };
        config_from_object(&raw)
    }

    pub fn save_config(&self, config: &UserScriptConfig) -> anyhow::Result<()> {
        let _guard = self.config_lock.lock().unwrap();
        self.save_config_unlocked(config)
    }

    fn save_config_unlocked(&self, config: &UserScriptConfig) -> anyhow::Result<()> {
        if let Some(parent) = self.config_path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!(
                    "failed to create user script config directory {}",
                    parent.display()
                )
            })?;
        }
        crate::settings::atomic_write(
            &self.config_path,
            serde_json::to_string_pretty(config)?.as_bytes(),
        )
    }

    pub fn set_global_enabled(&self, enabled: bool) -> anyhow::Result<UserScriptConfig> {
        let _guard = self.config_lock.lock().unwrap();
        let mut config = self.load_config_unlocked();
        config.enabled = enabled;
        self.save_config_unlocked(&config)?;
        Ok(config)
    }

    pub fn set_script_enabled(&self, key: &str, enabled: bool) -> anyhow::Result<UserScriptConfig> {
        let _guard = self.config_lock.lock().unwrap();
        let mut config = self.load_config_unlocked();
        config.scripts.insert(key.to_string(), enabled);
        self.save_config_unlocked(&config)?;
        Ok(config)
    }

    pub fn delete_user_script(&self, key: &str) -> anyhow::Result<UserScriptConfig> {
        let Some(file_name) = key.strip_prefix("user:").filter(|value| !value.is_empty()) else {
            anyhow::bail!("only user scripts can be deleted");
        };
        if file_name.contains(['/', '\\']) || file_name == "." || file_name == ".." {
            anyhow::bail!("invalid user script key");
        }
        let path = self.user_dir.join(file_name);
        let canonical_user_dir = self
            .user_dir
            .canonicalize()
            .or_else(|_| {
                fs::create_dir_all(&self.user_dir)?;
                self.user_dir.canonicalize()
            })
            .with_context(|| {
                format!(
                    "failed to resolve user script directory {}",
                    self.user_dir.display()
                )
            })?;
        let canonical_path = if path.exists() {
            let canonical_path = path
                .canonicalize()
                .with_context(|| format!("failed to resolve user script {}", path.display()))?;
            if !canonical_path.starts_with(&canonical_user_dir) {
                anyhow::bail!("refusing to delete script outside user script directory");
            }
            Some(canonical_path)
        } else {
            None
        };

        let _guard = self.config_lock.lock().unwrap();
        let previous = self.load_config_unlocked();
        let mut next = previous.clone();
        next.scripts.remove(key);
        next.market.remove(key);

        let backup_path = if let Some(canonical_path) = canonical_path.as_ref() {
            let backup_path = delete_backup_path(canonical_path);
            fs::rename(canonical_path, &backup_path).with_context(|| {
                format!(
                    "failed to stage user script deletion {}",
                    canonical_path.display()
                )
            })?;
            Some(backup_path)
        } else {
            None
        };

        if let Err(error) = self.save_config_unlocked(&next) {
            let rollback = restore_staged_delete(canonical_path.as_deref(), backup_path.as_deref());
            return Err(transaction_error(
                "failed to save script deletion",
                error,
                rollback,
            ));
        }

        if let Some(backup_path) = backup_path.as_ref()
            && let Err(error) = fs::remove_file(backup_path)
        {
            let config_rollback = self.save_config_unlocked(&previous);
            let file_rollback = restore_staged_delete(canonical_path.as_deref(), Some(backup_path));
            let rollback = config_rollback.and(file_rollback);
            return Err(transaction_error(
                "failed to finalize script deletion",
                error,
                rollback,
            ));
        }
        Ok(next)
    }

    pub fn user_script_path_for_market_id(&self, id: &str) -> PathBuf {
        self.user_dir.join(market_script_filename(id))
    }

    pub fn record_market_install(&self, script: &MarketScript) -> anyhow::Result<UserScriptConfig> {
        let _guard = self.config_lock.lock().unwrap();
        let mut config = self.load_config_unlocked();
        apply_market_install(&mut config, script);
        self.save_config_unlocked(&config)?;
        Ok(config)
    }

    pub fn install_market_script_transaction(
        &self,
        script: &MarketScript,
        content: &[u8],
    ) -> anyhow::Result<UserScriptConfig> {
        let _guard = self.config_lock.lock().unwrap();
        fs::create_dir_all(&self.user_dir).with_context(|| {
            format!(
                "failed to create user script directory {}",
                self.user_dir.display()
            )
        })?;
        let path = self.user_script_path_for_market_id(&script.id);
        let previous_script = match fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to back up script {}", path.display()));
            }
        };
        let previous_config = self.load_config_unlocked();

        crate::settings::atomic_write(&path, content)
            .with_context(|| format!("failed to write script {}", path.display()))?;
        let mut next = previous_config.clone();
        apply_market_install(&mut next, script);
        if let Err(error) = self.save_config_unlocked(&next) {
            let script_rollback = restore_script_contents(&path, previous_script.as_deref());
            let config_rollback = self.save_config_unlocked(&previous_config);
            let rollback = script_rollback.and(config_rollback);
            return Err(transaction_error(
                "failed to save installed script metadata",
                error,
                rollback,
            ));
        }
        Ok(next)
    }

    pub fn inventory(&self) -> anyhow::Result<Value> {
        let config = self.load_config();
        let scripts = self.scan_scripts(&config)?;
        Ok(json!({
            "enabled": config.enabled,
            "builtin_dir": self.builtin_dir.to_string_lossy(),
            "user_dir": self.user_dir.to_string_lossy(),
            "scripts": scripts
        }))
    }

    pub fn build_enabled_bundle(&self) -> anyhow::Result<String> {
        let config = self.load_config();
        let scripts = self.scan_script_files(&config)?;
        let enabled_scripts = scripts
            .iter()
            .filter(|script| config.enabled && script.enabled)
            .collect::<Vec<_>>();
        let enabled_keys = enabled_scripts
            .iter()
            .map(|script| script.key.as_str())
            .collect::<Vec<_>>();
        let mut blocks = vec![user_script_runtime_prelude(&enabled_keys)];
        for script in enabled_scripts {
            let source = fs::read_to_string(&script.path)
                .unwrap_or_else(|error| format!("throw new Error({});", json!(error.to_string())));
            blocks.push(wrap_script(script, &source));
        }
        Ok(blocks.join("\n"))
    }

    fn scan_scripts(&self, config: &UserScriptConfig) -> anyhow::Result<Vec<Value>> {
        Ok(self
            .scan_script_files(config)?
            .into_iter()
            .map(|script| {
                let market = config.market.get(&script.key);
                let status = if !config.enabled || !script.enabled {
                    "disabled"
                } else {
                    "pending_restart"
                };
                json!({
                    "key": script.key,
                    "name": script.name,
                    "source": script.source,
                    "enabled": script.enabled,
                    "status": status,
                    "error": "",
                    "status_message": if status == "pending_restart" {
                        "尚未确认已加载到当前 Codex；请重新加载脚本或重启 Codex。"
                    } else {
                        "脚本当前未启用。"
                    },
                    "market_id": market.as_ref().map(|item| item.id.as_str()).unwrap_or(""),
                    "version": market.as_ref().map(|item| item.version.as_str()).unwrap_or(""),
                    "installed": market.is_some(),
                    "source_url": market.as_ref().map(|item| item.script_url.as_str()).unwrap_or(""),
                    "homepage": market.as_ref().map(|item| item.homepage.as_str()).unwrap_or("")
                })
            })
            .collect())
    }

    fn scan_script_files(&self, config: &UserScriptConfig) -> anyhow::Result<Vec<UserScriptFile>> {
        fs::create_dir_all(&self.user_dir).with_context(|| {
            format!(
                "failed to create user scripts directory {}",
                self.user_dir.display()
            )
        })?;
        let mut scripts = Vec::new();
        self.append_scripts("builtin", &self.builtin_dir, config, &mut scripts)?;
        self.append_scripts("user", &self.user_dir, config, &mut scripts)?;
        Ok(scripts)
    }

    fn append_scripts(
        &self,
        source: &str,
        directory: &std::path::Path,
        config: &UserScriptConfig,
        scripts: &mut Vec<UserScriptFile>,
    ) -> anyhow::Result<()> {
        let Ok(entries) = fs::read_dir(directory) else {
            return Ok(());
        };
        let mut paths = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("js"))
            .collect::<Vec<_>>();
        paths.sort_by_key(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().to_lowercase())
                .unwrap_or_default()
        });

        for path in paths {
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default();
            let key = format!("{source}:{name}");
            scripts.push(UserScriptFile {
                enabled: config.scripts.get(&key).copied().unwrap_or(true),
                key,
                name,
                source: source.to_string(),
                path,
            });
        }
        Ok(())
    }
}

fn apply_market_install(config: &mut UserScriptConfig, script: &MarketScript) {
    let key = format!("user:{}", market_script_filename(&script.id));
    config.scripts.entry(key.clone()).or_insert(true);
    config.market.insert(
        key,
        MarketScriptInstall {
            id: script.id.clone(),
            name: script.name.clone(),
            version: script.version.clone(),
            script_url: script.script_url.clone(),
            homepage: script.homepage.clone(),
            installed_at: current_unix_timestamp_string(),
        },
    );
}

fn restore_script_contents(path: &std::path::Path, previous: Option<&[u8]>) -> anyhow::Result<()> {
    match previous {
        Some(bytes) => crate::settings::atomic_write(path, bytes),
        None => match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        },
    }
}

fn delete_backup_path(path: &std::path::Path) -> PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let mut backup = path.to_path_buf();
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("js");
    backup.set_extension(format!("{extension}.delete-{}-{nonce}", std::process::id()));
    backup
}

fn restore_staged_delete(
    original: Option<&std::path::Path>,
    backup: Option<&std::path::Path>,
) -> anyhow::Result<()> {
    match (original, backup) {
        (Some(original), Some(backup)) if backup.exists() => fs::rename(backup, original)
            .with_context(|| format!("failed to restore deleted script {}", original.display())),
        _ => Ok(()),
    }
}

fn transaction_error(
    operation: &str,
    error: impl std::fmt::Display,
    rollback: anyhow::Result<()>,
) -> anyhow::Error {
    match rollback {
        Ok(()) => anyhow::anyhow!("{operation}: {error}; changes were rolled back"),
        Err(rollback_error) => {
            anyhow::anyhow!("{operation}: {error}; rollback also failed: {rollback_error}")
        }
    }
}

#[derive(Debug)]
struct UserScriptFile {
    key: String,
    name: String,
    source: String,
    path: PathBuf,
    enabled: bool,
}

fn user_script_runtime_prelude(enabled_keys: &[&str]) -> String {
    format!(
        r#"
(() => {{
  const registry = window.__codexPlusUserScripts = window.__codexPlusUserScripts || {{ scripts: {{}} }};
  registry.scripts = registry.scripts && typeof registry.scripts === "object" ? registry.scripts : {{}};
  registry.resolveCleanup = (key, name) => {{
    const identity = `${{String(key || "").toLowerCase()}} ${{String(name || "").toLowerCase()}}`;
    if (identity.includes("bennett-ui-improvements")) {{
      return () => window.__bennettUiImprovementsBigPizza?.stop?.();
    }}
    if (identity.includes("codex-daily-token-usage")) {{
      return () => window.__codexDailyTokenUsage?.destroy?.();
    }}
    if (identity.includes("codex-list-pagebuster")) {{
      return () => window.__codexListPagebuster?.stop?.();
    }}
    if (identity.includes("tux-toolbar-buddy")) {{
      return () => window.__tuxToolbarBuddy?.dispose?.();
    }}
    if (identity.includes("codex-token-usage")) {{
      return () => window.__codexTokenUsage?.destroy?.();
    }}
    return null;
  }};
  registry.installPerformanceGuard = (key, name) => {{
    const identity = `${{String(key || "").toLowerCase()}} ${{String(name || "").toLowerCase()}}`;
    if (!identity.includes("tux-toolbar-buddy")) return null;
    const NativeMutationObserver = window.MutationObserver;
    if (typeof NativeMutationObserver !== "function") return null;
    const toolbarSelector = '#codex-plus-menu, [data-codex-plus-menu="true"]';
    const nodeTouchesToolbar = (node) => {{
      const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      if (!(element instanceof Element)) return false;
      return element.matches?.(toolbarSelector)
        || !!element.closest?.(toolbarSelector)
        || !!element.querySelector?.(toolbarSelector);
    }};
    const ScopedMutationObserver = class {{
      constructor(callback) {{
        this.nativeObserver = new NativeMutationObserver((mutations) => {{
          const relevant = mutations.filter((mutation) => {{
            if (nodeTouchesToolbar(mutation.target)) return true;
            return Array.from(mutation.addedNodes || []).some(nodeTouchesToolbar)
              || Array.from(mutation.removedNodes || []).some(nodeTouchesToolbar);
          }});
          if (relevant.length) callback(relevant, this);
        }});
      }}
      observe(...args) {{
        return this.nativeObserver.observe(...args);
      }}
      disconnect() {{
        return this.nativeObserver.disconnect();
      }}
      takeRecords() {{
        return this.nativeObserver.takeRecords();
      }}
    }};
    window.MutationObserver = ScopedMutationObserver;
    return () => {{
      if (window.MutationObserver === ScopedMutationObserver) {{
        window.MutationObserver = NativeMutationObserver;
      }}
    }};
  }};
  registry.cleanupEntry = (key, reason = "disabled") => {{
    const entry = registry.scripts[key];
    if (!entry || (entry.status === "disabled" && typeof entry.cleanup !== "function")) return;
    let cleanupError = "";
    const cleanup = typeof entry.cleanup === "function"
      ? entry.cleanup
      : registry.resolveCleanup(key, entry.name);
    if (typeof cleanup === "function") {{
      try {{
        cleanup();
      }} catch (error) {{
        cleanupError = String(error && (error.stack || error.message) || error);
      }}
    }}
    entry.status = "disabled";
    entry.error = "";
    entry.cleanupError = cleanupError;
    entry.disabledReason = reason;
    entry.disabledAt = new Date().toISOString();
    entry.cleanup = null;
  }};
  const enabledKeys = new Set({enabled_keys});
  for (const key of Object.keys(registry.scripts)) {{
    if (!enabledKeys.has(key)) registry.cleanupEntry(key, "disabled-or-removed");
  }}
}})();
"#,
        enabled_keys = json!(enabled_keys).to_string(),
    )
}

fn wrap_script(script: &UserScriptFile, source: &str) -> String {
    let fingerprint = script_fingerprint(&script.key, source);
    format!(
        r#"
(() => {{
  const registry = window.__codexPlusUserScripts = window.__codexPlusUserScripts || {{ scripts: {{}} }};
  const key = {key};
  const name = {name};
  const fingerprint = {fingerprint};
  const previous = registry.scripts[key];
  if (previous && previous.fingerprint === fingerprint && previous.status === "loaded") {{
    previous.lastCheckedAt = new Date().toISOString();
    return;
  }}
  let cleanupError = "";
  if (previous && typeof previous.cleanup === "function") {{
    try {{
      previous.cleanup();
    }} catch (error) {{
      cleanupError = String(error && (error.stack || error.message) || error);
    }}
  }}
  registry.scripts[key] = {{ key, name, source: {source_name}, fingerprint, status: "loading", error: "", cleanupError, loadedAt: new Date().toISOString(), cleanup: null }};
  let performanceGuardCleanup = null;
  try {{
    performanceGuardCleanup = registry.installPerformanceGuard?.(key, name) || null;
{source}
    const current = registry.scripts[key];
    if (typeof current.cleanup !== "function") {{
      current.cleanup = registry.resolveCleanup?.(key, name) || null;
    }}
    current.status = "loaded";
    current.loadedAt = new Date().toISOString();
  }} catch (error) {{
    registry.scripts[key].status = "failed";
    registry.scripts[key].error = String(error && (error.stack || error.message) || error);
  }} finally {{
    if (typeof performanceGuardCleanup === "function") performanceGuardCleanup();
  }}
}})();
"#,
        key = json!(script.key).to_string(),
        name = json!(script.name).to_string(),
        source_name = json!(script.source).to_string(),
        fingerprint = json!(fingerprint).to_string(),
        source = source
    )
}

fn script_fingerprint(key: &str, source: &str) -> String {
    let mut hasher = DefaultHasher::new();
    USER_SCRIPT_RUNTIME_REVISION.hash(&mut hasher);
    key.hash(&mut hasher);
    source.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn config_from_object(raw: &Map<String, Value>) -> UserScriptConfig {
    let enabled = raw.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let scripts = raw
        .get("scripts")
        .and_then(Value::as_object)
        .map(|items| {
            items
                .iter()
                .filter_map(|(key, value)| Some((key.clone(), value.as_bool()?)))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    let market = raw
        .get("market")
        .and_then(Value::as_object)
        .map(|items| {
            items
                .iter()
                .filter_map(|(key, value)| Some((key.clone(), market_install_from_value(value)?)))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    UserScriptConfig {
        enabled,
        scripts,
        market,
    }
}

pub fn market_script_filename(id: &str) -> String {
    let sanitized = sanitize_market_id(id);
    format!(
        "market-{}.js",
        if sanitized.is_empty() {
            "script".to_string()
        } else {
            sanitized
        }
    )
}

fn market_install_from_value(value: &Value) -> Option<MarketScriptInstall> {
    let raw = value.as_object()?;
    Some(MarketScriptInstall {
        id: string_field(raw, "id")?,
        name: string_field(raw, "name").unwrap_or_default(),
        version: string_field(raw, "version")?,
        script_url: string_field(raw, "script_url")?,
        homepage: string_field(raw, "homepage").unwrap_or_default(),
        installed_at: string_field(raw, "installed_at").unwrap_or_default(),
    })
}

fn string_field(raw: &Map<String, Value>, key: &str) -> Option<String> {
    raw.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn sanitize_market_id(id: &str) -> String {
    id.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn current_unix_timestamp_string() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}
