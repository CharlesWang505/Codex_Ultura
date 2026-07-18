use std::ffi::OsStr;
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::json;

const FAILED_DETECTION_CACHE_TTL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
struct CachedDetection {
    checked_at: Instant,
    path: Option<PathBuf>,
}

#[derive(Debug, Default)]
struct AppDetectionCache {
    state: Mutex<Option<CachedDetection>>,
}

#[derive(Debug, Clone, Copy)]
struct AppPackageSpec {
    identity: &'static str,
    app_id: &'static str,
    executable_names: &'static [&'static str],
    priority: u8,
}

const CODEX_PACKAGE_EXECUTABLES: &[&str] = &["ChatGPT.exe", "Codex.exe", "codex.exe"];
const STANDALONE_CODEX_EXECUTABLES: &[&str] = &["Codex.exe", "ChatGPT.exe", "codex.exe"];

const APP_PACKAGE_SPECS: &[AppPackageSpec] = &[
    AppPackageSpec {
        identity: "OpenAI.Codex",
        app_id: "App",
        executable_names: CODEX_PACKAGE_EXECUTABLES,
        priority: 1,
    },
    AppPackageSpec {
        identity: "OpenAI.CodexBeta",
        app_id: "App",
        executable_names: CODEX_PACKAGE_EXECUTABLES,
        priority: 1,
    },
];

impl AppDetectionCache {
    fn resolve_with<F>(&self, detect: F) -> Option<PathBuf>
    where
        F: FnOnce() -> Option<PathBuf>,
    {
        let mut state = self.state.lock().ok()?;
        if let Some(cached) = state.as_ref() {
            if let Some(path) = cached.path.as_deref().and_then(validated_codex_app_dir) {
                return Some(path);
            }
            if cached.path.is_none() && cached.checked_at.elapsed() < FAILED_DETECTION_CACHE_TTL {
                return None;
            }
        }

        let path = detect().as_deref().and_then(validated_codex_app_dir);
        *state = Some(CachedDetection {
            checked_at: Instant::now(),
            path: path.clone(),
        });
        path
    }
}

fn app_detection_cache() -> &'static AppDetectionCache {
    static CACHE: OnceLock<AppDetectionCache> = OnceLock::new();
    CACHE.get_or_init(AppDetectionCache::default)
}

pub fn find_latest_codex_app_dir(root: &Path) -> Option<PathBuf> {
    let mut matches = std::fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter_map(|path| {
            let spec = package_spec_from_path(&path)?;
            let version = version_tuple(&path)?;
            let app_dir = package_entry_dir(&path, spec)?;
            Some((spec.priority, version, app_dir))
        })
        .collect::<Vec<_>>();
    matches.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .reverse()
            .then_with(|| left.1.cmp(&right.1))
    });
    let (_, _, latest) = matches.pop()?;
    Some(latest)
}

pub fn find_latest_codex_app_dir_from_roots(roots: &[PathBuf]) -> Option<PathBuf> {
    roots
        .iter()
        .filter_map(|root| find_latest_codex_app_dir(root))
        .max_by(compare_app_dir_candidates)
}

pub fn find_latest_codex_app_dir_default() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        find_latest_codex_app_dir_from_roots(&windows_app_package_roots())
            .or_else(find_latest_codex_app_dir_from_appx_package)
    }

    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(windows)]
fn find_latest_codex_app_dir_from_appx_package() -> Option<PathBuf> {
    let mut command = crate::windows_integration::background_command("powershell.exe");
    command
        .args(appx_package_powershell_args())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    latest_appx_install_location_from_output(&String::from_utf8_lossy(&output.stdout))
        .and_then(|location| normalize_codex_app_path(Path::new(&location)))
}

#[cfg(windows)]
fn appx_package_powershell_args() -> [&'static str; 7] {
    [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$names=@('OpenAI.Codex','OpenAI.CodexBeta'); Get-AppxPackage | Where-Object { $names -contains $_.Name } | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty InstallLocation",
    ]
}

pub fn latest_appx_install_location_from_output(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToString::to_string)
}

#[cfg(windows)]
fn windows_app_package_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        roots.push(PathBuf::from(program_files).join("WindowsApps"));
    }
    if let Some(program_files) = std::env::var_os("ProgramW6432") {
        roots.push(PathBuf::from(program_files).join("WindowsApps"));
    }
    roots.push(PathBuf::from(r"C:\Program Files\WindowsApps"));
    roots.sort();
    roots.dedup();
    roots
}

pub fn user_data_candidates() -> Vec<PathBuf> {
    user_data_candidates_from(
        std::env::var_os("LOCALAPPDATA").as_deref().map(Path::new),
        std::env::var_os("APPDATA").as_deref().map(Path::new),
    )
}

pub fn user_data_candidates_from(local: Option<&Path>, roaming: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(local) = local {
        append_user_data_variants(&mut candidates, local);
    }
    if let Some(roaming) = roaming {
        append_user_data_variants(&mut candidates, roaming);
    }
    candidates
}

pub fn find_macos_codex_app(search_roots: &[PathBuf]) -> Option<PathBuf> {
    for root in search_roots {
        for candidate in macos_app_candidates(root) {
            if candidate.is_dir() {
                return Some(candidate);
            }
        }
    }
    None
}

pub fn find_macos_codex_app_default() -> Option<PathBuf> {
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = directories::BaseDirs::new().map(|dirs| dirs.home_dir().to_path_buf()) {
        roots.push(home.join("Applications"));
    }
    find_macos_codex_app(&roots)
}

pub fn resolve_codex_app_dir(app_dir: Option<&Path>) -> Option<PathBuf> {
    if let Some(app_dir) = app_dir {
        return normalize_codex_app_path(app_dir);
    }
    if cfg!(target_os = "macos") {
        return find_macos_codex_app_default();
    }
    // Windows: try MS Store version first, then standalone install
    find_latest_codex_app_dir_default().or_else(|| find_standalone_codex_app_dir())
}

/// Search for standalone Codex installations (non-MS Store).
///
/// Common paths:
/// - %LOCALAPPDATA%\OpenAI\Codex\bin\  (standalone installer)
/// - %LOCALAPPDATA%\OpenAI\Codex\      (user data root)
/// - %LOCALAPPDATA%\Programs\OpenAI\Codex\ (alternative)
pub fn find_standalone_codex_app_dir() -> Option<PathBuf> {
    let local_appdata = std::env::var_os("LOCALAPPDATA")?;

    let candidates: &[PathBuf] = &[
        PathBuf::from(&local_appdata)
            .join("OpenAI")
            .join("Codex")
            .join("bin"),
        PathBuf::from(&local_appdata).join("OpenAI").join("Codex"),
        PathBuf::from(&local_appdata)
            .join("Programs")
            .join("OpenAI")
            .join("Codex"),
    ];

    for candidate in candidates {
        if let Some(path) = normalize_codex_app_path(candidate) {
            if build_codex_executable(&path).exists() {
                return Some(path);
            }
        }
    }
    None
}

pub fn resolve_codex_app_dir_with_saved(
    app_dir: Option<&Path>,
    saved_app_path: Option<&str>,
) -> Option<PathBuf> {
    if let Some(app_dir) = app_dir {
        return normalize_codex_app_path(app_dir);
    }
    if let Some(saved) = saved_app_path
        .map(str::trim)
        .filter(|saved| !saved.is_empty())
    {
        if let Some(path) = normalize_codex_app_path(Path::new(saved)) {
            return Some(path);
        }
    }
    resolve_codex_app_dir(None)
}

/// Resolve a launchable Codex application directory and persist an auto-detected
/// path without replacing unrelated settings fields.
pub fn resolve_codex_app_dir_with_store(
    app_dir: Option<&Path>,
    store: &crate::settings::SettingsStore,
) -> Option<PathBuf> {
    resolve_codex_app_dir_with_store_and_detector(app_dir, store, || {
        app_detection_cache().resolve_with(|| resolve_codex_app_dir(None))
    })
}

fn resolve_codex_app_dir_with_store_and_detector<F>(
    app_dir: Option<&Path>,
    store: &crate::settings::SettingsStore,
    detect: F,
) -> Option<PathBuf>
where
    F: FnOnce() -> Option<PathBuf>,
{
    let settings = store.load().unwrap_or_default();
    let saved = (!settings.codex_app_path.trim().is_empty())
        .then(|| validated_codex_app_dir(Path::new(&settings.codex_app_path)))
        .flatten();
    let resolved = match app_dir {
        Some(app_dir) => validated_codex_app_dir(app_dir),
        None => saved.or_else(detect),
    }?;

    if settings.codex_app_path != resolved.to_string_lossy() {
        if let Err(error) = store.update(json!({
            "codexAppPath": resolved.to_string_lossy()
        })) {
            let _ = crate::diagnostic_log::append_diagnostic_log(
                "app_paths.persist_detected_path_failed",
                json!({
                    "path": resolved,
                    "message": error.to_string()
                }),
            );
        }
    }
    Some(resolved)
}

/// Normalize a configured path only when it points to an executable application.
pub fn validated_codex_app_dir(path: &Path) -> Option<PathBuf> {
    let app_dir = normalize_codex_app_path(path)?;
    build_codex_executable(&app_dir)
        .is_file()
        .then_some(app_dir)
}

pub fn normalize_codex_app_path(path: &Path) -> Option<PathBuf> {
    if path.as_os_str().is_empty() {
        return None;
    }

    if is_codex_manager_path(path) {
        return None;
    }

    let file_name = path.file_name().and_then(OsStr::to_str).unwrap_or_default();
    if is_supported_app_executable_name(file_name) {
        return path.parent().map(Path::to_path_buf);
    }

    if path.extension() == Some(OsStr::new("app")) {
        return Some(path.to_path_buf());
    }

    if path.is_file() {
        return path.parent().map(Path::to_path_buf);
    }

    if executable_in_dir(path).is_some() {
        return Some(path.to_path_buf());
    }

    let nested_app = path.join("app");
    if nested_app.is_dir() {
        if executable_in_dir(&nested_app).is_some() {
            return Some(nested_app);
        }
    }

    if path.is_dir() {
        return Some(path.to_path_buf());
    }

    None
}

fn is_codex_manager_path(path: &Path) -> bool {
    for component in path.components() {
        let std::path::Component::Normal(name) = component else {
            continue;
        };
        let Some(name) = name.to_str() else {
            continue;
        };
        let lower = name.to_ascii_lowercase();
        if lower == "codex++"
            || lower == "codexplusplus"
            || lower == "codex-plus-plus"
            || lower == "codex-compass"
            || lower == "codex_compass"
            || lower.contains("codex-plus-manager")
            || lower.contains("codex compass")
        {
            return true;
        }
    }
    let normalized = path
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    normalized.contains("\\programs\\codex++")
        || normalized.contains("\\codex++\\")
        || normalized.ends_with("\\codex++")
        || normalized.contains("\\codex-compass\\")
        || normalized.ends_with("\\codex-compass")
}

pub fn build_codex_executable(app_dir: &Path) -> PathBuf {
    if app_dir.extension() == Some(OsStr::new("app")) {
        let macos_dir = app_dir.join("Contents").join("MacOS");
        if let Some(executable) = macos_app_plist_value(app_dir, "CFBundleExecutable")
            .filter(|value| !value.contains('/') && !value.contains('\\'))
        {
            return macos_dir.join(executable);
        }
        return macos_dir.join("Codex");
    }
    if let Some(executable) = executable_in_dir(app_dir) {
        return executable;
    }
    if let Some(spec) = package_spec_from_path(app_dir) {
        return app_dir.join(spec.executable_names[0]);
    }
    app_dir.join("Codex.exe")
}

pub fn codex_app_version(app_dir: &Path) -> Option<String> {
    if app_dir.extension() == Some(OsStr::new("app")) {
        return macos_app_version(app_dir);
    }
    let package_dir = if app_dir
        .file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| name.eq_ignore_ascii_case("app"))
    {
        app_dir.parent()?
    } else {
        app_dir
    };
    codex_package_version(package_dir)
}

pub fn packaged_app_user_model_id(app_dir: &Path) -> Option<String> {
    let package_name = package_name_from_app_dir(app_dir)?;
    let (spec, _, publisher_id) = codex_package_parts(&package_name)?;
    if publisher_id.is_empty() {
        return None;
    }
    Some(format!("{}_{publisher_id}!{}", spec.identity, spec.app_id))
}

fn package_name_from_app_dir(app_dir: &Path) -> Option<String> {
    let path = app_dir.to_string_lossy().replace('\\', "/");
    let mut parts = path.split('/').filter(|part| !part.is_empty());
    let mut package_name = parts.next_back()?;
    if package_name.eq_ignore_ascii_case("app") {
        package_name = parts.next_back()?;
    }
    Some(package_name.to_string())
}

fn codex_package_version(package_dir: &Path) -> Option<String> {
    let path = package_dir.to_string_lossy().replace('\\', "/");
    let name = path
        .split('/')
        .rev()
        .find(|part| codex_package_parts(part).is_some())?;
    let (_, version, _) = codex_package_parts(name)?;
    if version.is_empty() {
        None
    } else {
        Some(version.to_string())
    }
}

fn macos_app_version(app_dir: &Path) -> Option<String> {
    macos_app_plist_value(app_dir, "CFBundleShortVersionString")
        .or_else(|| macos_app_plist_value(app_dir, "CFBundleVersion"))
}

fn macos_app_plist_value(app_dir: &Path, key: &str) -> Option<String> {
    let plist = std::fs::read_to_string(app_dir.join("Contents").join("Info.plist")).ok()?;
    plist_string_value(&plist, key)
}

fn plist_string_value(plist: &str, key: &str) -> Option<String> {
    let (_, after_key) = plist.split_once(&format!("<key>{key}</key>"))?;
    let (_, after_string_open) = after_key.split_once("<string>")?;
    let (value, _) = after_string_open.split_once("</string>")?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn append_user_data_variants(candidates: &mut Vec<PathBuf>, base: &Path) {
    candidates.push(base.join("OpenAI").join("ChatGPT"));
    candidates.push(base.join("OpenAI.ChatGPT-Desktop"));
    candidates.push(base.join("ChatGPT"));
    candidates.push(base.join("OpenAI").join("Codex"));
    candidates.push(base.join("OpenAI.Codex"));
    candidates.push(base.join("Codex"));
}

fn macos_app_candidates(root: &Path) -> Vec<PathBuf> {
    if root.extension() == Some(OsStr::new("app")) {
        return vec![root.to_path_buf()];
    }
    [
        "Codex.app",
        "OpenAI Codex.app",
        "OpenAI.Codex.app",
        "ChatGPT.app",
    ]
    .into_iter()
    .map(|name| root.join(name))
    .collect()
}

fn version_tuple(path: &Path) -> Option<Vec<u32>> {
    let name = path.file_name()?.to_str()?;
    let (_, version, _) = codex_package_parts(name)?;
    let parts = version
        .split('.')
        .map(str::parse::<u32>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if parts.is_empty() { None } else { Some(parts) }
}

pub(crate) fn is_supported_windows_app_package_name(package_name: &str) -> bool {
    codex_package_parts(package_name).is_some()
}

pub(crate) fn is_supported_app_executable_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("Codex.exe") || name.eq_ignore_ascii_case("ChatGPT.exe")
}

fn package_spec_from_path(path: &Path) -> Option<AppPackageSpec> {
    let package_name = package_name_from_app_dir(path)?;
    let (spec, _, _) = codex_package_parts(&package_name)?;
    Some(spec)
}

fn compare_app_dir_candidates(left: &PathBuf, right: &PathBuf) -> std::cmp::Ordering {
    app_dir_sort_key(left).cmp(&app_dir_sort_key(right))
}

fn app_dir_sort_key(app_dir: &Path) -> Option<(std::cmp::Reverse<u8>, Vec<u32>)> {
    let spec = package_spec_from_path(app_dir)?;
    let package_dir = if app_dir
        .file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| name.eq_ignore_ascii_case("app"))
    {
        app_dir.parent().unwrap_or(app_dir)
    } else {
        app_dir
    };
    Some((
        std::cmp::Reverse(spec.priority),
        version_tuple(package_dir)?,
    ))
}

fn package_entry_dir(package_dir: &Path, spec: AppPackageSpec) -> Option<PathBuf> {
    let app = package_dir.join("app");
    if app.is_dir() {
        return Some(app);
    }
    for name in spec.executable_names {
        if package_dir.join(name).is_file() {
            return Some(package_dir.to_path_buf());
        }
    }
    None
}

fn executable_in_dir(dir: &Path) -> Option<PathBuf> {
    let names = package_spec_from_path(dir)
        .map(|spec| spec.executable_names)
        .unwrap_or(STANDALONE_CODEX_EXECUTABLES);
    for name in names {
        let candidate = dir.join(name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn codex_package_parts(package_name: &str) -> Option<(AppPackageSpec, &str, &str)> {
    for spec in APP_PACKAGE_SPECS {
        let Some(rest) = strip_prefix_ignore_ascii_case(package_name, spec.identity) else {
            continue;
        };
        let Some(rest) = rest.strip_prefix('_') else {
            continue;
        };
        let Some((version, rest)) = rest.split_once('_') else {
            continue;
        };
        let Some((_, publisher_id)) = rest.rsplit_once("__") else {
            continue;
        };
        return Some((*spec, version, publisher_id));
    }
    None
}

fn strip_prefix_ignore_ascii_case<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    if value.len() < prefix.len() {
        return None;
    }
    let (head, rest) = value.split_at(prefix.len());
    head.eq_ignore_ascii_case(prefix).then_some(rest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};

    fn launchable_test_app(root: &Path) -> PathBuf {
        let app = root.join("OpenAI.Codex_26.707.3748.0_x64__abc").join("app");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("ChatGPT.exe"), b"").unwrap();
        app
    }

    #[cfg(windows)]
    #[test]
    fn appx_detection_uses_noninteractive_hidden_powershell() {
        let args = appx_package_powershell_args();
        assert!(args.contains(&"-NoLogo"));
        assert!(args.contains(&"-NoProfile"));
        assert!(args.contains(&"-NonInteractive"));
        let source = include_str!("app_paths.rs");
        assert!(source.contains("windows_integration::background_command"));
        assert!(source.contains(".stdin(Stdio::null())"));
        assert!(source.contains(".stderr(Stdio::null())"));
    }

    #[test]
    fn validated_path_requires_the_application_executable() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        std::fs::create_dir_all(&app).unwrap();
        assert_eq!(validated_codex_app_dir(&app), None);

        std::fs::write(app.join("ChatGPT.exe"), b"").unwrap();
        assert_eq!(
            validated_codex_app_dir(&app).as_deref(),
            Some(app.as_path())
        );
    }

    #[test]
    fn detected_path_is_persisted_without_replacing_other_settings() {
        let temp = tempfile::tempdir().unwrap();
        let store = crate::settings::SettingsStore::new(temp.path().join("settings.json"));
        let mut settings = crate::settings::BackendSettings::default();
        settings.relay_test_model = "keep-this-model".to_string();
        settings.default_reasoning = "high".to_string();
        store.save(&settings).unwrap();
        let app = launchable_test_app(temp.path());

        let resolved =
            resolve_codex_app_dir_with_store_and_detector(None, &store, || Some(app.clone()));

        assert_eq!(resolved.as_deref(), Some(app.as_path()));
        let loaded = store.load().unwrap();
        assert_eq!(loaded.codex_app_path, app.to_string_lossy());
        assert_eq!(loaded.relay_test_model, "keep-this-model");
        assert_eq!(loaded.default_reasoning, "high");
    }

    #[test]
    fn valid_saved_path_skips_detection_and_invalid_saved_path_is_replaced() {
        let temp = tempfile::tempdir().unwrap();
        let store = crate::settings::SettingsStore::new(temp.path().join("settings.json"));
        let app = launchable_test_app(temp.path());
        let calls = AtomicUsize::new(0);
        let mut settings = crate::settings::BackendSettings::default();
        settings.codex_app_path = app.to_string_lossy().to_string();
        store.save(&settings).unwrap();

        assert_eq!(
            resolve_codex_app_dir_with_store_and_detector(None, &store, || {
                calls.fetch_add(1, Ordering::SeqCst);
                None
            })
            .as_deref(),
            Some(app.as_path())
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        settings.codex_app_path = temp
            .path()
            .join("missing-app")
            .to_string_lossy()
            .to_string();
        store.save(&settings).unwrap();
        assert_eq!(
            resolve_codex_app_dir_with_store_and_detector(None, &store, || {
                calls.fetch_add(1, Ordering::SeqCst);
                Some(app.clone())
            })
            .as_deref(),
            Some(app.as_path())
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(store.load().unwrap().codex_app_path, app.to_string_lossy());
    }

    #[test]
    fn concurrent_detection_is_coalesced_by_the_process_cache() {
        let temp = tempfile::tempdir().unwrap();
        let app = launchable_test_app(temp.path());
        let cache = Arc::new(AppDetectionCache::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(8));
        let mut handles = Vec::new();

        for _ in 0..8 {
            let app = app.clone();
            let cache = cache.clone();
            let calls = calls.clone();
            let barrier = barrier.clone();
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                cache.resolve_with(|| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(20));
                    Some(app)
                })
            }));
        }

        for handle in handles {
            assert_eq!(handle.join().unwrap().as_deref(), Some(app.as_path()));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
