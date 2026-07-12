use base64::{Engine as _, engine::general_purpose};
use reqwest::{Client, StatusCode, Url, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
#[cfg(target_os = "windows")]
use std::net::TcpListener;
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use super::sensitive_directory;

const CONFIG_VERSION: u32 = 5;
const DEFAULT_PIPE: &str = r"\\.\pipe\verge-mihomo";
const DEFAULT_TIMEOUT_MS: u64 = 5_000;
const DEFAULT_CONCURRENCY: usize = 16;
const MAX_SUBSCRIPTION_BYTES: usize = 8 * 1024 * 1024;
const MAX_MANAGED_CORE_BYTES: usize = 96 * 1024 * 1024;
static CONFIG_LOCK: Mutex<()> = Mutex::new(());
static ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
struct ManagedCoreProcess {
    child: Child,
    signature: String,
    version: String,
}

#[cfg(target_os = "windows")]
static MANAGED_CORE: Mutex<Option<ManagedCoreProcess>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyLatencyTarget {
    pub id: String,
    pub name: String,
    pub url: String,
    pub enabled: bool,
}

fn default_targets() -> Vec<ProxyLatencyTarget> {
    vec![
        ProxyLatencyTarget {
            id: "default-cloudflare".to_string(),
            name: "示例线路 A".to_string(),
            url: "https://relay-a.example.com".to_string(),
            enabled: true,
        },
        ProxyLatencyTarget {
            id: "default-asia".to_string(),
            name: "示例线路 B".to_string(),
            url: "https://relay-b.example.com".to_string(),
            enabled: true,
        },
        ProxyLatencyTarget {
            id: "default-global".to_string(),
            name: "示例线路 C".to_string(),
            url: "https://relay-c.example.com".to_string(),
            enabled: true,
        },
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscriptionUsage {
    upload: Option<u64>,
    download: Option<u64>,
    total: Option<u64>,
    expire: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredProxySubscription {
    id: String,
    name: String,
    url: String,
    node_names: Vec<String>,
    updated_at: u64,
    usage: Option<SubscriptionUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct StoredControllerSettings {
    mode: String,
    endpoint: String,
    secret: String,
}

impl Default for StoredControllerSettings {
    fn default() -> Self {
        Self {
            mode: "namedPipe".to_string(),
            endpoint: DEFAULT_PIPE.to_string(),
            secret: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct StoredProxyLatencyConfig {
    version: u32,
    subscriptions: Vec<StoredProxySubscription>,
    selected_subscription_ids: Vec<String>,
    controller: StoredControllerSettings,
    targets: Vec<ProxyLatencyTarget>,
    timeout_ms: u64,
    concurrency: usize,
    only_imported_nodes: bool,
    include_local_test: bool,
    use_managed_engine: bool,
    managed_previous_controller: Option<StoredControllerSettings>,
}

impl Default for StoredProxyLatencyConfig {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            subscriptions: Vec::new(),
            selected_subscription_ids: Vec::new(),
            controller: StoredControllerSettings::default(),
            targets: default_targets(),
            timeout_ms: DEFAULT_TIMEOUT_MS,
            concurrency: DEFAULT_CONCURRENCY,
            only_imported_nodes: false,
            include_local_test: true,
            use_managed_engine: false,
            managed_previous_controller: None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxySubscriptionView {
    id: String,
    name: String,
    url_preview: String,
    node_names: Vec<String>,
    node_count: usize,
    updated_at: u64,
    usage: Option<SubscriptionUsage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyControllerView {
    mode: String,
    endpoint: String,
    has_secret: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyLatencyConfigView {
    subscriptions: Vec<ProxySubscriptionView>,
    selected_subscription_ids: Vec<String>,
    controller: ProxyControllerView,
    targets: Vec<ProxyLatencyTarget>,
    timeout_ms: u64,
    concurrency: usize,
    only_imported_nodes: bool,
    include_local_test: bool,
    use_managed_engine: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyLatencySettingsInput {
    controller_mode: String,
    controller_endpoint: String,
    controller_secret: Option<String>,
    clear_controller_secret: Option<bool>,
    targets: Vec<ProxyLatencyTarget>,
    timeout_ms: u64,
    concurrency: usize,
    only_imported_nodes: bool,
    selected_subscription_ids: Vec<String>,
    include_local_test: bool,
    use_managed_engine: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxySubscriptionImportInput {
    subscription_id: Option<String>,
    name: Option<String>,
    url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyControllerCandidate {
    mode: String,
    endpoint: String,
    label: String,
    version: Option<String>,
    available: bool,
    requires_secret: bool,
    detail: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProxyNode {
    name: String,
    proxy_type: String,
    alive: Option<bool>,
    udp: Option<bool>,
    provider_names: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyNodeList {
    controller_version: String,
    controller_mode: String,
    controller_endpoint: String,
    nodes: Vec<ProxyNode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyDelayInput {
    node: String,
    target_url: String,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectDelayInput {
    target_url: String,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyDelayResult {
    node: String,
    target_url: String,
    status: String,
    delay_ms: Option<u64>,
    duration_ms: u64,
    detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedMihomoStatus {
    installed: bool,
    running: bool,
    version: Option<String>,
    detail: String,
}

struct ControllerHttpResponse {
    status: u16,
    body: Vec<u8>,
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn create_id(prefix: &str) -> String {
    let sequence = ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{:x}_{sequence:x}", now_epoch_seconds())
}

fn proxy_config_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(sensitive_directory(app)?.join("proxy-latency.json"))
}

fn read_config(app: &AppHandle) -> Result<StoredProxyLatencyConfig, String> {
    let _guard = CONFIG_LOCK
        .lock()
        .map_err(|_| "代理测速配置锁异常".to_string())?;
    let path = proxy_config_file(app)?;
    if !path.exists() {
        return Ok(StoredProxyLatencyConfig::default());
    }
    let bytes = fs::read(path).map_err(|_| "无法读取代理测速敏感配置".to_string())?;
    let mut config: StoredProxyLatencyConfig =
        serde_json::from_slice(&bytes).map_err(|_| "代理测速敏感配置格式无效".to_string())?;
    normalize_config(&mut config);
    Ok(config)
}

fn write_config(app: &AppHandle, config: &StoredProxyLatencyConfig) -> Result<(), String> {
    let _guard = CONFIG_LOCK
        .lock()
        .map_err(|_| "代理测速配置锁异常".to_string())?;
    let path = proxy_config_file(app)?;
    let bytes =
        serde_json::to_vec_pretty(config).map_err(|_| "无法序列化代理测速配置".to_string())?;
    fs::write(path, bytes).map_err(|_| "无法保存代理测速敏感配置".to_string())
}

fn normalize_config(config: &mut StoredProxyLatencyConfig) {
    let previous_version = config.version;
    if config.version < 2 {
        config.only_imported_nodes = false;
    }
    let available_subscription_ids = config
        .subscriptions
        .iter()
        .map(|subscription| subscription.id.clone())
        .collect::<HashSet<_>>();
    if previous_version < 3 && config.selected_subscription_ids.is_empty() {
        config.selected_subscription_ids = config
            .subscriptions
            .iter()
            .map(|subscription| subscription.id.clone())
            .collect();
    }
    if previous_version < 5 && config.concurrency == 6 {
        config.concurrency = DEFAULT_CONCURRENCY;
    }
    if config.targets.is_empty() {
        config.targets = default_targets();
    }
    let mut seen_subscription_ids = HashSet::new();
    config.selected_subscription_ids.retain(|id| {
        available_subscription_ids.contains(id) && seen_subscription_ids.insert(id.clone())
    });
    config.version = CONFIG_VERSION;
    if config.controller.mode != "http" && config.controller.mode != "namedPipe" {
        config.controller.mode = "namedPipe".to_string();
    }
    if config.controller.endpoint.trim().is_empty() {
        config.controller.endpoint = if config.controller.mode == "http" {
            "http://127.0.0.1:9090".to_string()
        } else {
            DEFAULT_PIPE.to_string()
        };
    }
    config.timeout_ms = config.timeout_ms.clamp(500, 60_000);
    config.concurrency = config.concurrency.clamp(1, 32);
    config.targets.retain(|target| !target.id.trim().is_empty());
}

fn mask_subscription_url(raw: &str) -> String {
    let Ok(url) = Url::parse(raw) else {
        return "已保存（地址已隐藏）".to_string();
    };
    let Some(host) = url.host_str() else {
        return "已保存（地址已隐藏）".to_string();
    };
    let port = url
        .port()
        .map(|value| format!(":{value}"))
        .unwrap_or_default();
    format!("{}://{host}{port}/••••", url.scheme())
}

fn config_view(config: &StoredProxyLatencyConfig) -> ProxyLatencyConfigView {
    ProxyLatencyConfigView {
        subscriptions: config
            .subscriptions
            .iter()
            .map(|subscription| ProxySubscriptionView {
                id: subscription.id.clone(),
                name: subscription.name.clone(),
                url_preview: mask_subscription_url(&subscription.url),
                node_names: subscription.node_names.clone(),
                node_count: subscription.node_names.len(),
                updated_at: subscription.updated_at,
                usage: subscription.usage.clone(),
            })
            .collect(),
        selected_subscription_ids: config.selected_subscription_ids.clone(),
        controller: ProxyControllerView {
            mode: config.controller.mode.clone(),
            endpoint: config.controller.endpoint.clone(),
            has_secret: !config.controller.secret.is_empty(),
        },
        targets: config.targets.clone(),
        timeout_ms: config.timeout_ms,
        concurrency: config.concurrency,
        only_imported_nodes: config.only_imported_nodes,
        include_local_test: config.include_local_test,
        use_managed_engine: config.use_managed_engine,
    }
}

fn validate_http_url(raw: &str, label: &str) -> Result<String, String> {
    let value = raw.trim();
    let url = Url::parse(value).map_err(|_| format!("{label}不是有效的 HTTP/HTTPS 地址"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!("{label}仅支持 HTTP/HTTPS 地址"));
    }
    Ok(value.trim_end_matches('/').to_string())
}

fn sanitize_targets(targets: Vec<ProxyLatencyTarget>) -> Result<Vec<ProxyLatencyTarget>, String> {
    if targets.len() > 30 {
        return Err("Base URL 目标最多保存 30 个".to_string());
    }
    let mut ids = HashSet::new();
    let mut normalized = Vec::with_capacity(targets.len());
    for (index, target) in targets.into_iter().enumerate() {
        let url = validate_http_url(&target.url, "Base URL")?;
        let id = if target.id.trim().is_empty() {
            create_id("target")
        } else {
            target.id.trim().to_string()
        };
        if !ids.insert(id.clone()) {
            continue;
        }
        normalized.push(ProxyLatencyTarget {
            id,
            name: if target.name.trim().is_empty() {
                format!("目标 {}", index + 1)
            } else {
                target.name.trim().to_string()
            },
            url,
            enabled: target.enabled,
        });
    }
    Ok(normalized)
}

#[tauri::command]
pub fn load_proxy_latency_config(app: AppHandle) -> Result<ProxyLatencyConfigView, String> {
    read_config(&app).map(|config| config_view(&config))
}

#[tauri::command]
pub fn save_proxy_latency_config(
    app: AppHandle,
    input: ProxyLatencySettingsInput,
) -> Result<ProxyLatencyConfigView, String> {
    let mut config = read_config(&app)?;
    let was_managed = config.use_managed_engine;
    let mode = match input.controller_mode.as_str() {
        "namedPipe" => "namedPipe",
        "http" => "http",
        _ => return Err("控制器类型无效".to_string()),
    };
    let endpoint = input.controller_endpoint.trim();
    if endpoint.is_empty() {
        return Err("请填写 Clash/Mihomo 控制器地址".to_string());
    }
    if mode == "http" {
        validate_http_url(endpoint, "控制器地址")?;
    } else if !endpoint.starts_with(r"\\.\pipe\") {
        return Err(r"Windows 命名管道应以 \\.\pipe\ 开头".to_string());
    }

    if !was_managed && input.use_managed_engine {
        config.managed_previous_controller = Some(config.controller.clone());
    }

    config.controller.mode = mode.to_string();
    config.controller.endpoint = endpoint.trim_end_matches('/').to_string();
    if input.clear_controller_secret.unwrap_or(false) {
        config.controller.secret.clear();
    } else if let Some(secret) = input.controller_secret.filter(|value| !value.is_empty()) {
        config.controller.secret = secret;
    }
    config.targets = sanitize_targets(input.targets)?;
    config.timeout_ms = input.timeout_ms.clamp(500, 60_000);
    config.concurrency = input.concurrency.clamp(1, 32);
    config.only_imported_nodes = input.only_imported_nodes;
    config.selected_subscription_ids = input.selected_subscription_ids;
    config.include_local_test = input.include_local_test;
    config.use_managed_engine = input.use_managed_engine;
    if was_managed && !config.use_managed_engine {
        stop_managed_process();
        config.managed_previous_controller = None;
    }
    normalize_config(&mut config);
    write_config(&app, &config)?;
    Ok(config_view(&config))
}

fn parse_subscription_usage(raw: Option<&str>) -> Option<SubscriptionUsage> {
    let raw = raw?;
    let mut values = HashMap::new();
    for part in raw.split(';') {
        let Some((key, value)) = part.trim().split_once('=') else {
            continue;
        };
        if let Ok(number) = value.trim().parse::<u64>() {
            values.insert(key.trim().to_ascii_lowercase(), number);
        }
    }
    let usage = SubscriptionUsage {
        upload: values.get("upload").copied(),
        download: values.get("download").copied(),
        total: values.get("total").copied(),
        expire: values.get("expire").copied(),
    };
    (usage.upload.is_some()
        || usage.download.is_some()
        || usage.total.is_some()
        || usage.expire.is_some())
    .then_some(usage)
}

fn decoded_base64_utf8(value: &str) -> Option<String> {
    let compact: String = value
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    for engine in [
        &general_purpose::STANDARD,
        &general_purpose::STANDARD_NO_PAD,
        &general_purpose::URL_SAFE,
        &general_purpose::URL_SAFE_NO_PAD,
    ] {
        if let Ok(bytes) = engine.decode(&compact)
            && let Ok(text) = String::from_utf8(bytes)
        {
            return Some(text);
        }
    }
    None
}

fn uri_fragment_name(uri: &str) -> Option<String> {
    let (_, fragment) = uri.rsplit_once('#')?;
    let decoded = urlencoding::decode(fragment).ok()?.trim().to_string();
    (!decoded.is_empty()).then_some(decoded)
}

fn vmess_name(uri: &str) -> Option<String> {
    let payload = uri.strip_prefix("vmess://")?.split('#').next()?.trim();
    let decoded = decoded_base64_utf8(payload)?;
    let json = serde_json::from_str::<Value>(&decoded).ok()?;
    json.get("ps")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn collect_uri_names(content: &str, names: &mut Vec<String>, seen: &mut HashSet<String>) {
    const SUPPORTED_SCHEMES: &[&str] = &[
        "vmess://",
        "ss://",
        "ssr://",
        "trojan://",
        "vless://",
        "hysteria://",
        "hysteria2://",
        "hy2://",
        "tuic://",
        "wireguard://",
        "socks5://",
        "http://",
    ];

    for line in content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if !SUPPORTED_SCHEMES
            .iter()
            .any(|scheme| line.starts_with(scheme))
        {
            continue;
        }
        let name = if line.starts_with("vmess://") {
            vmess_name(line).or_else(|| uri_fragment_name(line))
        } else {
            uri_fragment_name(line)
        };
        if let Some(name) = name
            && seen.insert(name.clone())
        {
            names.push(name);
        }
    }
}

fn collect_yaml_names(content: &str, names: &mut Vec<String>, seen: &mut HashSet<String>) {
    let Ok(root) = serde_yaml::from_str::<serde_yaml::Value>(content) else {
        return;
    };
    let Some(proxies) = root.get("proxies").and_then(serde_yaml::Value::as_sequence) else {
        return;
    };
    for proxy in proxies {
        let Some(name) = proxy
            .get("name")
            .and_then(serde_yaml::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if seen.insert(name.to_string()) {
            names.push(name.to_string());
        }
    }
}

fn parse_subscription_nodes(content: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut seen = HashSet::new();
    collect_yaml_names(content, &mut names, &mut seen);
    collect_uri_names(content, &mut names, &mut seen);

    if names.is_empty()
        && let Some(decoded) = decoded_base64_utf8(content)
    {
        collect_yaml_names(&decoded, &mut names, &mut seen);
        collect_uri_names(&decoded, &mut names, &mut seen);
    }
    names
}

fn subscription_request_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(25))
        .redirect(Policy::limited(6))
        .user_agent("Clash.Meta")
        .build()
        .map_err(|_| "无法创建订阅请求客户端".to_string())
}

#[tauri::command]
pub async fn import_proxy_subscription(
    app: AppHandle,
    input: ProxySubscriptionImportInput,
) -> Result<ProxyLatencyConfigView, String> {
    let existing_config = read_config(&app)?;
    let existing = input.subscription_id.as_deref().and_then(|id| {
        existing_config
            .subscriptions
            .iter()
            .find(|subscription| subscription.id == id)
    });
    let raw_url = input
        .url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| existing.map(|subscription| subscription.url.as_str()))
        .ok_or_else(|| "请填写代理订阅地址".to_string())?;
    let url = validate_http_url(raw_url, "订阅地址")?;

    let client = subscription_request_client()?;
    let response = client.get(&url).send().await.map_err(|error| {
        if error.is_timeout() {
            "获取订阅超时".to_string()
        } else {
            "无法获取订阅，请检查地址和当前网络".to_string()
        }
    })?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("订阅服务器返回 HTTP {}", status.as_u16()));
    }
    let usage_header = response
        .headers()
        .get("subscription-userinfo")
        .and_then(|value| value.to_str().ok())
        .map(ToString::to_string);
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "无法读取订阅内容".to_string())?;
    if bytes.len() > MAX_SUBSCRIPTION_BYTES {
        return Err("订阅内容过大，已拒绝解析".to_string());
    }
    let content =
        String::from_utf8(bytes.to_vec()).map_err(|_| "订阅内容不是有效文本".to_string())?;
    let node_names = parse_subscription_nodes(&content);
    if node_names.is_empty() {
        return Err("订阅内容中没有识别到可命名的代理节点".to_string());
    }

    let mut config = read_config(&app)?;
    let subscription_id = input
        .subscription_id
        .filter(|id| {
            config
                .subscriptions
                .iter()
                .any(|subscription| subscription.id == *id)
        })
        .unwrap_or_else(|| create_id("subscription"));
    let existing_name = config
        .subscriptions
        .iter()
        .find(|subscription| subscription.id == subscription_id)
        .map(|subscription| subscription.name.clone());
    let name = input
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or(existing_name)
        .unwrap_or_else(|| format!("代理订阅 {}", config.subscriptions.len() + 1));
    let next = StoredProxySubscription {
        id: subscription_id.clone(),
        name,
        url,
        node_names,
        updated_at: now_epoch_seconds(),
        usage: parse_subscription_usage(usage_header.as_deref()),
    };
    if let Some(index) = config
        .subscriptions
        .iter()
        .position(|subscription| subscription.id == subscription_id)
    {
        config.subscriptions[index] = next;
    } else {
        config.subscriptions.push(next);
        config.selected_subscription_ids.push(subscription_id);
    }
    normalize_config(&mut config);
    write_config(&app, &config)?;
    Ok(config_view(&config))
}

#[tauri::command]
pub fn remove_proxy_subscription(
    app: AppHandle,
    subscription_id: String,
) -> Result<ProxyLatencyConfigView, String> {
    let mut config = read_config(&app)?;
    config
        .subscriptions
        .retain(|subscription| subscription.id != subscription_id);
    config
        .selected_subscription_ids
        .retain(|id| id != &subscription_id);
    normalize_config(&mut config);
    write_config(&app, &config)?;
    Ok(config_view(&config))
}

#[cfg(target_os = "windows")]
#[derive(Serialize)]
struct ManagedProviderHealthCheck {
    enable: bool,
}

#[cfg(target_os = "windows")]
#[derive(Serialize)]
struct ManagedProviderConfig {
    #[serde(rename = "type")]
    provider_type: String,
    url: String,
    path: String,
    interval: u64,
    header: HashMap<String, Vec<String>>,
    #[serde(rename = "health-check")]
    health_check: ManagedProviderHealthCheck,
}

#[cfg(target_os = "windows")]
#[derive(Serialize)]
struct ManagedProxyGroupConfig {
    name: String,
    #[serde(rename = "type")]
    group_type: String,
    #[serde(rename = "use")]
    providers: Vec<String>,
}

#[cfg(target_os = "windows")]
#[derive(Serialize)]
struct ManagedMihomoConfig {
    #[serde(rename = "allow-lan")]
    allow_lan: bool,
    mode: String,
    #[serde(rename = "log-level")]
    log_level: String,
    #[serde(rename = "external-controller")]
    external_controller: String,
    secret: String,
    #[serde(rename = "unified-delay")]
    unified_delay: bool,
    #[serde(rename = "proxy-providers")]
    proxy_providers: HashMap<String, ManagedProviderConfig>,
    #[serde(rename = "proxy-groups")]
    proxy_groups: Vec<ManagedProxyGroupConfig>,
    rules: Vec<String>,
}

#[cfg(target_os = "windows")]
fn managed_mihomo_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = sensitive_directory(app)?.join("managed-mihomo");
    fs::create_dir_all(&directory).map_err(|_| "无法创建内置测试引擎目录".to_string())?;
    Ok(directory)
}

#[cfg(target_os = "windows")]
fn managed_mihomo_executable(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(managed_mihomo_directory(app)?.join("mihomo.exe"))
}

#[cfg(target_os = "windows")]
fn managed_mihomo_version(app: &AppHandle) -> Option<String> {
    fs::read_to_string(managed_mihomo_directory(app).ok()?.join("version.txt"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(target_os = "windows")]
fn managed_asset_name(tag: &str) -> Result<String, String> {
    #[cfg(target_arch = "x86_64")]
    {
        return Ok(format!("mihomo-windows-amd64-compatible-{tag}.zip"));
    }
    #[cfg(target_arch = "aarch64")]
    {
        return Ok(format!("mihomo-windows-arm64-{tag}.zip"));
    }
    #[allow(unreachable_code)]
    Err("当前 Windows CPU 架构暂不支持自动安装 Mihomo".to_string())
}

#[cfg(target_os = "windows")]
fn find_mihomo_executable(directory: &PathBuf) -> Option<PathBuf> {
    let entries = fs::read_dir(directory).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_mihomo_executable(&path) {
                return Some(found);
            }
            continue;
        }
        if path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("exe"))
            && path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.to_ascii_lowercase().contains("mihomo"))
        {
            return Some(path);
        }
    }
    None
}

#[cfg(target_os = "windows")]
async fn install_managed_mihomo(app: &AppHandle) -> Result<String, String> {
    let executable = managed_mihomo_executable(app)?;
    if executable.exists() {
        return Ok(managed_mihomo_version(app).unwrap_or_else(|| "已安装".to_string()));
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(120))
        .redirect(Policy::limited(10))
        .user_agent("Codex-Compass/1.3 managed-mihomo-installer")
        .build()
        .map_err(|_| "无法创建内置测试引擎下载客户端".to_string())?;
    let latest = client
        .get("https://github.com/MetaCubeX/mihomo/releases/latest")
        .send()
        .await
        .map_err(|_| "无法访问 Mihomo 官方发布页，请检查当前网络".to_string())?;
    if !latest.status().is_success() {
        return Err(format!(
            "Mihomo 官方发布页返回 HTTP {}",
            latest.status().as_u16()
        ));
    }
    let tag = latest
        .url()
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .map(str::trim)
        .filter(|value| value.starts_with('v'))
        .ok_or_else(|| "无法识别 Mihomo 最新版本".to_string())?
        .to_string();
    let asset_name = managed_asset_name(&tag)?;
    let asset_url =
        format!("https://github.com/MetaCubeX/mihomo/releases/download/{tag}/{asset_name}");
    let response = client
        .get(asset_url)
        .send()
        .await
        .map_err(|_| "下载 Mihomo 内置测试引擎失败".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "下载 Mihomo 失败，HTTP {}",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length as usize > MAX_MANAGED_CORE_BYTES)
    {
        return Err("Mihomo 下载文件异常过大，已停止安装".to_string());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "无法读取 Mihomo 下载文件".to_string())?;
    if bytes.len() > MAX_MANAGED_CORE_BYTES {
        return Err("Mihomo 下载文件异常过大，已停止安装".to_string());
    }
    if bytes.len() < 4 || &bytes[..2] != b"PK" {
        return Err("Mihomo 官方下载内容不是有效 ZIP，已停止安装".to_string());
    }

    let directory = managed_mihomo_directory(app)?;
    let archive = directory.join("mihomo-download.zip");
    let extract_directory = directory.join("extracting");
    let _ = fs::remove_file(&archive);
    let _ = fs::remove_dir_all(&extract_directory);
    fs::create_dir_all(&extract_directory).map_err(|_| "无法准备 Mihomo 解压目录".to_string())?;
    fs::write(&archive, &bytes).map_err(|_| "无法保存 Mihomo 下载文件".to_string())?;

    let status = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
        ])
        .arg(&archive)
        .arg(&extract_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|_| "无法调用 PowerShell 解压 Mihomo".to_string())?;
    if !status.success() {
        return Err("PowerShell 解压 Mihomo 失败".to_string());
    }
    let extracted = find_mihomo_executable(&extract_directory)
        .ok_or_else(|| "Mihomo 压缩包中没有找到可执行文件".to_string())?;
    let executable_bytes =
        fs::read(&extracted).map_err(|_| "无法读取解压后的 Mihomo 可执行文件".to_string())?;
    if executable_bytes.len() < 2 || &executable_bytes[..2] != b"MZ" {
        return Err("解压后的 Mihomo 文件不是有效 Windows 可执行文件".to_string());
    }
    fs::copy(extracted, &executable).map_err(|_| "无法安装 Mihomo 可执行文件".to_string())?;
    fs::write(directory.join("version.txt"), &tag)
        .map_err(|_| "无法记录 Mihomo 版本".to_string())?;
    let _ = fs::remove_file(archive);
    let _ = fs::remove_dir_all(extract_directory);
    Ok(tag)
}

#[cfg(target_os = "windows")]
fn stop_managed_process() {
    let Ok(mut process) = MANAGED_CORE.lock() else {
        return;
    };
    if let Some(mut running) = process.take() {
        let _ = running.child.kill();
        let _ = running.child.wait();
    }
}

#[cfg(not(target_os = "windows"))]
fn stop_managed_process() {}

pub fn shutdown_managed_mihomo() {
    stop_managed_process();
}

#[cfg(target_os = "windows")]
fn managed_process_status() -> (bool, Option<String>) {
    let Ok(mut process) = MANAGED_CORE.lock() else {
        return (false, None);
    };
    let Some(running) = process.as_mut() else {
        return (false, None);
    };
    match running.child.try_wait() {
        Ok(None) => (true, Some(running.version.clone())),
        _ => {
            *process = None;
            (false, None)
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn managed_process_status() -> (bool, Option<String>) {
    (false, None)
}

#[cfg(target_os = "windows")]
fn managed_signature(config: &StoredProxyLatencyConfig) -> String {
    let selected = config
        .selected_subscription_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    config
        .subscriptions
        .iter()
        .filter(|subscription| selected.contains(subscription.id.as_str()))
        .map(|subscription| format!("{}:{}", subscription.id, subscription.updated_at))
        .collect::<Vec<_>>()
        .join("|")
}

#[cfg(target_os = "windows")]
fn write_managed_mihomo_config(
    app: &AppHandle,
    config: &StoredProxyLatencyConfig,
    port: u16,
    secret: &str,
) -> Result<PathBuf, String> {
    let selected = config
        .selected_subscription_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let subscriptions = config
        .subscriptions
        .iter()
        .filter(|subscription| selected.contains(subscription.id.as_str()))
        .collect::<Vec<_>>();
    if subscriptions.is_empty() {
        return Err("请先选择至少一个机场，再启用内置测试引擎".to_string());
    }

    let directory = managed_mihomo_directory(app)?.join("runtime");
    fs::create_dir_all(&directory).map_err(|_| "无法创建 Mihomo 运行目录".to_string())?;
    let providers_directory = directory.join("providers");
    let _ = fs::remove_dir_all(&providers_directory);
    fs::create_dir_all(&providers_directory)
        .map_err(|_| "无法创建 Mihomo 订阅缓存目录".to_string())?;

    let mut providers = HashMap::new();
    let mut provider_names = Vec::new();
    for (index, subscription) in subscriptions.iter().enumerate() {
        let name = format!("airport_{}", index + 1);
        provider_names.push(name.clone());
        providers.insert(
            name,
            ManagedProviderConfig {
                provider_type: "http".to_string(),
                url: subscription.url.clone(),
                path: format!("./providers/airport_{}.yaml", index + 1),
                interval: 3_600,
                header: HashMap::from([("User-Agent".to_string(), vec!["Clash.Meta".to_string()])]),
                health_check: ManagedProviderHealthCheck { enable: false },
            },
        );
    }
    let managed_config = ManagedMihomoConfig {
        allow_lan: false,
        mode: "rule".to_string(),
        log_level: "warning".to_string(),
        external_controller: format!("127.0.0.1:{port}"),
        secret: secret.to_string(),
        unified_delay: true,
        proxy_providers: providers,
        proxy_groups: vec![ManagedProxyGroupConfig {
            name: "Codex Compass".to_string(),
            group_type: "select".to_string(),
            providers: provider_names,
        }],
        rules: vec!["MATCH,Codex Compass".to_string()],
    };
    let yaml = serde_yaml::to_string(&managed_config)
        .map_err(|_| "无法生成 Mihomo 隔离配置".to_string())?;
    let path = directory.join("config.yaml");
    fs::write(&path, yaml).map_err(|_| "无法保存 Mihomo 隔离配置".to_string())?;
    Ok(path)
}

#[cfg(target_os = "windows")]
async fn ensure_managed_mihomo(
    app: &AppHandle,
    config: &mut StoredProxyLatencyConfig,
) -> Result<String, String> {
    let executable = managed_mihomo_executable(app)?;
    if !executable.exists() {
        return Err("内置测试引擎尚未安装，请点击“安装并启用”".to_string());
    }
    let signature = managed_signature(config);
    if signature.is_empty() {
        return Err("请先选择至少一个机场，再启用内置测试引擎".to_string());
    }
    {
        let mut process = MANAGED_CORE
            .lock()
            .map_err(|_| "内置测试引擎状态锁异常".to_string())?;
        if let Some(running) = process.as_mut()
            && running.signature == signature
            && matches!(running.child.try_wait(), Ok(None))
        {
            return Ok(running.version.clone());
        }
    }
    stop_managed_process();

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|_| "无法为内置测试引擎分配本地端口".to_string())?;
    let port = listener
        .local_addr()
        .map_err(|_| "无法读取内置测试引擎端口".to_string())?
        .port();
    drop(listener);
    let secret = format!(
        "relay-meter-{:x}",
        ID_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let config_path = write_managed_mihomo_config(app, config, port, &secret)?;
    let runtime_directory = config_path
        .parent()
        .ok_or_else(|| "内置测试引擎运行目录无效".to_string())?;
    let mut child = Command::new(&executable)
        .arg("-d")
        .arg(runtime_directory)
        .arg("-f")
        .arg(&config_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|_| "无法启动 Mihomo 内置测试引擎".to_string())?;
    let controller = StoredControllerSettings {
        mode: "http".to_string(),
        endpoint: format!("http://127.0.0.1:{port}"),
        secret,
    };
    let mut detected_version = managed_mihomo_version(app).unwrap_or_else(|| "managed".to_string());
    let mut ready = false;
    for _ in 0..60 {
        if child.try_wait().ok().flatten().is_some() {
            break;
        }
        if let Ok(response) = controller_request(&controller, "/version", 1_000).await
            && (200..300).contains(&response.status)
        {
            detected_version = controller_version(&response).unwrap_or(detected_version);
            ready = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    if !ready {
        let _ = child.kill();
        let _ = child.wait();
        return Err("内置测试引擎启动超时，请检查安全软件是否拦截 mihomo.exe".to_string());
    }

    if !config.use_managed_engine {
        config.managed_previous_controller = Some(config.controller.clone());
    }
    config.controller = controller;
    config.use_managed_engine = true;
    normalize_config(config);
    write_config(app, config)?;
    let mut process = MANAGED_CORE
        .lock()
        .map_err(|_| "内置测试引擎状态锁异常".to_string())?;
    *process = Some(ManagedCoreProcess {
        child,
        signature,
        version: detected_version.clone(),
    });
    Ok(detected_version)
}

#[tauri::command]
pub fn managed_mihomo_status(app: AppHandle) -> Result<ManagedMihomoStatus, String> {
    let executable = {
        #[cfg(target_os = "windows")]
        {
            managed_mihomo_executable(&app)?
        }
        #[cfg(not(target_os = "windows"))]
        {
            PathBuf::new()
        }
    };
    let (running, running_version) = managed_process_status();
    let installed = executable.exists();
    let version = running_version.or_else(|| {
        #[cfg(target_os = "windows")]
        {
            managed_mihomo_version(&app)
        }
        #[cfg(not(target_os = "windows"))]
        {
            None
        }
    });
    Ok(ManagedMihomoStatus {
        installed,
        running,
        version,
        detail: if running {
            "内置测试引擎运行中".to_string()
        } else if installed {
            "内置测试引擎已安装，可随时启动".to_string()
        } else {
            "尚未安装内置测试引擎".to_string()
        },
    })
}

#[tauri::command]
pub async fn enable_managed_mihomo(app: AppHandle) -> Result<ProxyNodeList, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        return Err("内置 Mihomo 测试引擎当前仅支持 Windows".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        install_managed_mihomo(&app).await?;
        let mut config = read_config(&app)?;
        let version = ensure_managed_mihomo(&app, &mut config).await?;
        let nodes = read_proxy_nodes(&config.controller, true).await?;
        Ok(ProxyNodeList {
            controller_version: format!("内置 Mihomo {version}"),
            controller_mode: config.controller.mode,
            controller_endpoint: config.controller.endpoint,
            nodes,
        })
    }
}

#[tauri::command]
pub fn disable_managed_mihomo(app: AppHandle) -> Result<ProxyLatencyConfigView, String> {
    stop_managed_process();
    let mut config = read_config(&app)?;
    if config.use_managed_engine {
        config.controller = config
            .managed_previous_controller
            .take()
            .unwrap_or_default();
    }
    config.use_managed_engine = false;
    normalize_config(&mut config);
    write_config(&app, &config)?;
    Ok(config_view(&config))
}

fn auth_header(secret: &str) -> String {
    if secret.is_empty() {
        String::new()
    } else {
        format!("Authorization: Bearer {secret}\r\n")
    }
}

fn parse_http_response(raw: &[u8]) -> Result<ControllerHttpResponse, String> {
    let header_end = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "控制器返回了无效 HTTP 响应".to_string())?;
    let header_bytes = &raw[..header_end];
    let header_text = String::from_utf8_lossy(header_bytes);
    let mut lines = header_text.split("\r\n");
    let status_line = lines
        .next()
        .ok_or_else(|| "控制器响应缺少状态行".to_string())?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "控制器返回了无效状态码".to_string())?;
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let raw_body = &raw[header_end + 4..];
    let body = if headers
        .get("transfer-encoding")
        .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"))
    {
        decode_chunked_body(raw_body)?
    } else if let Some(length) = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
    {
        raw_body
            .get(..length.min(raw_body.len()))
            .unwrap_or(raw_body)
            .to_vec()
    } else {
        raw_body.to_vec()
    };
    Ok(ControllerHttpResponse { status, body })
}

fn decode_chunked_body(raw: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoded = Vec::new();
    let mut cursor = 0usize;
    while cursor < raw.len() {
        let line_end = raw[cursor..]
            .windows(2)
            .position(|window| window == b"\r\n")
            .map(|offset| cursor + offset)
            .ok_or_else(|| "控制器 Chunked 响应不完整".to_string())?;
        let size_text = String::from_utf8_lossy(&raw[cursor..line_end]);
        let size =
            usize::from_str_radix(size_text.split(';').next().unwrap_or_default().trim(), 16)
                .map_err(|_| "控制器 Chunked 响应长度无效".to_string())?;
        cursor = line_end + 2;
        if size == 0 {
            break;
        }
        let chunk_end = cursor
            .checked_add(size)
            .filter(|end| *end <= raw.len())
            .ok_or_else(|| "控制器 Chunked 响应正文不完整".to_string())?;
        decoded.extend_from_slice(&raw[cursor..chunk_end]);
        cursor = chunk_end;
        if raw.get(cursor..cursor + 2) != Some(b"\r\n") {
            return Err("控制器 Chunked 响应分隔符无效".to_string());
        }
        cursor += 2;
    }
    Ok(decoded)
}

#[cfg(target_os = "windows")]
async fn named_pipe_request(
    endpoint: &str,
    path: &str,
    secret: &str,
    timeout_ms: u64,
) -> Result<ControllerHttpResponse, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::windows::named_pipe::ClientOptions;
    use tokio::time::{sleep, timeout};

    let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(500));
    let mut pipe = loop {
        match ClientOptions::new().open(endpoint) {
            Ok(pipe) => break pipe,
            Err(error) if error.raw_os_error() == Some(231) && Instant::now() < deadline => {
                sleep(Duration::from_millis(40)).await;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err("未找到 Mihomo 命名管道，请确认 Clash Verge 正在运行".to_string());
            }
            Err(_) => return Err("无法连接 Mihomo 命名管道".to_string()),
        }
    };
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: localhost\r\nAccept: application/json\r\n{}Connection: close\r\n\r\n",
        auth_header(secret),
    );
    timeout(
        Duration::from_millis(timeout_ms.max(500)),
        pipe.write_all(request.as_bytes()),
    )
    .await
    .map_err(|_| "写入 Mihomo 命名管道超时".to_string())?
    .map_err(|_| "无法写入 Mihomo 命名管道".to_string())?;
    let mut response = Vec::new();
    timeout(
        Duration::from_millis(timeout_ms.max(500) + 1_500),
        pipe.read_to_end(&mut response),
    )
    .await
    .map_err(|_| "读取 Mihomo 命名管道超时".to_string())?
    .map_err(|_| "无法读取 Mihomo 命名管道".to_string())?;
    parse_http_response(&response)
}

#[cfg(not(target_os = "windows"))]
async fn named_pipe_request(
    _endpoint: &str,
    _path: &str,
    _secret: &str,
    _timeout_ms: u64,
) -> Result<ControllerHttpResponse, String> {
    Err("命名管道控制器仅支持 Windows".to_string())
}

async fn http_controller_request(
    endpoint: &str,
    path: &str,
    secret: &str,
    timeout_ms: u64,
) -> Result<ControllerHttpResponse, String> {
    let client = Client::builder()
        .timeout(Duration::from_millis(timeout_ms.max(500) + 1_500))
        .redirect(Policy::none())
        .build()
        .map_err(|_| "无法创建控制器请求客户端".to_string())?;
    let url = format!("{}{}", endpoint.trim_end_matches('/'), path);
    let mut request = client.get(url);
    if !secret.is_empty() {
        request = request.bearer_auth(secret);
    }
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            "连接 Mihomo 控制器超时".to_string()
        } else {
            "无法连接 Mihomo HTTP 控制器".to_string()
        }
    })?;
    let status = response.status().as_u16();
    let body = response
        .bytes()
        .await
        .map_err(|_| "无法读取 Mihomo 控制器响应".to_string())?
        .to_vec();
    Ok(ControllerHttpResponse { status, body })
}

async fn controller_request(
    controller: &StoredControllerSettings,
    path: &str,
    timeout_ms: u64,
) -> Result<ControllerHttpResponse, String> {
    if controller.mode == "http" {
        http_controller_request(&controller.endpoint, path, &controller.secret, timeout_ms).await
    } else {
        named_pipe_request(&controller.endpoint, path, &controller.secret, timeout_ms).await
    }
}

fn response_json(response: &ControllerHttpResponse) -> Result<Value, String> {
    serde_json::from_slice(&response.body).map_err(|_| "控制器返回了无法解析的数据".to_string())
}

fn controller_status_error(status: u16) -> String {
    match status {
        401 | 403 => "控制器拒绝访问，请检查 Secret".to_string(),
        404 => "控制器不支持该接口".to_string(),
        408 | 504 => "控制器请求超时".to_string(),
        _ => format!("控制器返回 HTTP {status}"),
    }
}

fn controller_version(response: &ControllerHttpResponse) -> Option<String> {
    response_json(response)
        .ok()?
        .get("version")?
        .as_str()
        .map(ToString::to_string)
}

fn is_actual_proxy(proxy_type: &str) -> bool {
    !matches!(
        proxy_type.to_ascii_lowercase().as_str(),
        "direct"
            | "reject"
            | "rejectdrop"
            | "pass"
            | "compatible"
            | "selector"
            | "urltest"
            | "fallback"
            | "loadbalance"
            | "relay"
    )
}

fn parse_proxy_nodes(response: &ControllerHttpResponse) -> Result<Vec<ProxyNode>, String> {
    let json = response_json(response)?;
    let proxies = json
        .get("proxies")
        .and_then(Value::as_object)
        .ok_or_else(|| "控制器没有返回代理节点列表".to_string())?;
    let mut nodes = proxies
        .iter()
        .filter_map(|(fallback_name, proxy)| {
            let proxy_type = proxy
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("Unknown");
            if !is_actual_proxy(proxy_type) {
                return None;
            }
            let name = proxy
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(fallback_name)
                .trim();
            if name.is_empty() {
                return None;
            }
            Some(ProxyNode {
                name: name.to_string(),
                proxy_type: proxy_type.to_string(),
                alive: proxy.get("alive").and_then(Value::as_bool),
                udp: proxy.get("udp").and_then(Value::as_bool),
                provider_names: Vec::new(),
            })
        })
        .collect::<Vec<_>>();
    nodes.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    nodes.dedup_by(|left, right| left.name == right.name);
    Ok(nodes)
}

fn parse_proxy_provider_memberships(
    response: &ControllerHttpResponse,
) -> Result<HashMap<String, Vec<String>>, String> {
    let json = response_json(response)?;
    let providers = json
        .get("providers")
        .and_then(Value::as_object)
        .ok_or_else(|| "控制器没有返回 provider 列表".to_string())?;
    let mut memberships = HashMap::<String, Vec<String>>::new();
    for (fallback_name, provider) in providers {
        let provider_name = provider
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(fallback_name)
            .trim();
        if provider_name.is_empty() {
            continue;
        }
        let Some(proxies) = provider.get("proxies").and_then(Value::as_array) else {
            continue;
        };
        for proxy in proxies {
            let node_name = proxy
                .get("name")
                .and_then(Value::as_str)
                .or_else(|| proxy.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty());
            if let Some(node_name) = node_name {
                let provider_names = memberships.entry(node_name.to_string()).or_default();
                if !provider_names.iter().any(|name| name == provider_name) {
                    provider_names.push(provider_name.to_string());
                }
            }
        }
    }
    Ok(memberships)
}

async fn attach_proxy_provider_memberships(
    controller: &StoredControllerSettings,
    nodes: &mut [ProxyNode],
) {
    let Ok(response) = controller_request(controller, "/providers/proxies", 2_000).await else {
        return;
    };
    if !(200..300).contains(&response.status) {
        return;
    }
    let Ok(memberships) = parse_proxy_provider_memberships(&response) else {
        return;
    };
    for node in nodes {
        node.provider_names = memberships.get(&node.name).cloned().unwrap_or_default();
    }
}

async fn read_proxy_nodes(
    controller: &StoredControllerSettings,
    wait_for_provider: bool,
) -> Result<Vec<ProxyNode>, String> {
    let attempts = if wait_for_provider { 60 } else { 1 };
    for attempt in 0..attempts {
        let response = controller_request(controller, "/proxies", 6_000).await?;
        if !(200..300).contains(&response.status) {
            return Err(controller_status_error(response.status));
        }
        let mut nodes = parse_proxy_nodes(&response)?;
        if !wait_for_provider || !nodes.is_empty() {
            attach_proxy_provider_memberships(controller, &mut nodes).await;
            return Ok(nodes);
        }
        if attempt + 1 < attempts {
            std::thread::sleep(Duration::from_millis(250));
        }
    }
    Err(
        "内置测试引擎已启动，但所选机场暂未返回可用节点；请检查订阅是否支持 Clash.Meta 格式"
            .to_string(),
    )
}

#[tauri::command]
pub async fn discover_proxy_controllers(
    app: AppHandle,
) -> Result<Vec<ProxyControllerCandidate>, String> {
    let config = read_config(&app)?;
    let mut candidates = vec![
        StoredControllerSettings {
            mode: config.controller.mode.clone(),
            endpoint: config.controller.endpoint.clone(),
            secret: config.controller.secret.clone(),
        },
        StoredControllerSettings {
            mode: "namedPipe".to_string(),
            endpoint: DEFAULT_PIPE.to_string(),
            secret: String::new(),
        },
        StoredControllerSettings {
            mode: "http".to_string(),
            endpoint: "http://127.0.0.1:9090".to_string(),
            secret: config.controller.secret.clone(),
        },
        StoredControllerSettings {
            mode: "http".to_string(),
            endpoint: "http://127.0.0.1:9097".to_string(),
            secret: config.controller.secret.clone(),
        },
    ];
    let mut seen = HashSet::new();
    candidates
        .retain(|candidate| seen.insert((candidate.mode.clone(), candidate.endpoint.clone())));
    let mut results = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let response = controller_request(&candidate, "/version", 1_800).await;
        let view = match response {
            Ok(response) => {
                let available = (200..300).contains(&response.status);
                ProxyControllerCandidate {
                    mode: candidate.mode.clone(),
                    endpoint: candidate.endpoint.clone(),
                    label: if candidate.mode == "namedPipe" {
                        "Mihomo 命名管道".to_string()
                    } else {
                        "Mihomo HTTP 控制器".to_string()
                    },
                    version: available.then(|| controller_version(&response)).flatten(),
                    available,
                    requires_secret: response.status == StatusCode::UNAUTHORIZED.as_u16()
                        || response.status == StatusCode::FORBIDDEN.as_u16(),
                    detail: if available {
                        "可连接".to_string()
                    } else {
                        controller_status_error(response.status)
                    },
                }
            }
            Err(error) => ProxyControllerCandidate {
                mode: candidate.mode,
                endpoint: candidate.endpoint,
                label: "Mihomo 控制器".to_string(),
                version: None,
                available: false,
                requires_secret: false,
                detail: error,
            },
        };
        results.push(view);
    }
    results.sort_by_key(|candidate| !candidate.available);
    Ok(results)
}

#[tauri::command]
pub async fn list_proxy_nodes(app: AppHandle) -> Result<ProxyNodeList, String> {
    let mut config = read_config(&app)?;
    let managed_version = if config.use_managed_engine {
        #[cfg(target_os = "windows")]
        {
            Some(ensure_managed_mihomo(&app, &mut config).await?)
        }
        #[cfg(not(target_os = "windows"))]
        {
            return Err("内置 Mihomo 测试引擎当前仅支持 Windows".to_string());
        }
    } else {
        None
    };
    let version_response = controller_request(&config.controller, "/version", 3_000).await?;
    if !(200..300).contains(&version_response.status) {
        return Err(controller_status_error(version_response.status));
    }
    let nodes = read_proxy_nodes(&config.controller, config.use_managed_engine).await?;
    Ok(ProxyNodeList {
        controller_version: managed_version
            .map(|version| format!("内置 Mihomo {version}"))
            .or_else(|| controller_version(&version_response))
            .unwrap_or_else(|| "unknown".to_string()),
        controller_mode: config.controller.mode,
        controller_endpoint: config.controller.endpoint,
        nodes,
    })
}

fn response_detail(response: &ControllerHttpResponse, target_url: &str) -> String {
    let detail = response_json(response)
        .ok()
        .and_then(|json| {
            json.get("message")
                .or_else(|| json.get("error"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| controller_status_error(response.status));
    let sanitized = detail.replace(target_url, "<target>");
    sanitized.chars().take(180).collect()
}

async fn request_proxy_delay(
    controller: &StoredControllerSettings,
    node: &str,
    target_url: &str,
    timeout_ms: u64,
) -> Result<ControllerHttpResponse, String> {
    let path = format!(
        "/proxies/{}/delay?url={}&timeout={timeout_ms}",
        urlencoding::encode(node),
        urlencoding::encode(target_url),
    );
    controller_request(controller, &path, timeout_ms + 1_500).await
}

#[tauri::command]
pub async fn test_proxy_delay(
    app: AppHandle,
    input: ProxyDelayInput,
) -> Result<ProxyDelayResult, String> {
    let config = read_config(&app)?;
    let node = input.node.trim().to_string();
    if node.is_empty() {
        return Err("代理节点名称不能为空".to_string());
    }
    let target_url = validate_http_url(&input.target_url, "Base URL")?;
    let timeout_ms = input
        .timeout_ms
        .unwrap_or(config.timeout_ms)
        .clamp(500, 60_000);
    let started = Instant::now();
    let response = request_proxy_delay(&config.controller, &node, &target_url, timeout_ms).await;
    let duration_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    let Ok(response) = response else {
        let detail = response.err().unwrap_or_else(|| "代理测速失败".to_string());
        let status = if detail.contains("超时") {
            "timeout"
        } else {
            "error"
        };
        return Ok(ProxyDelayResult {
            node,
            target_url,
            status: status.to_string(),
            delay_ms: None,
            duration_ms,
            detail,
        });
    };
    if !(200..300).contains(&response.status) {
        let detail = response_detail(&response, &target_url);
        let status = if response.status == 408
            || response.status == 504
            || detail.to_ascii_lowercase().contains("timeout")
            || detail.contains("超时")
        {
            "timeout"
        } else {
            "error"
        };
        return Ok(ProxyDelayResult {
            node,
            target_url,
            status: status.to_string(),
            delay_ms: None,
            duration_ms,
            detail,
        });
    }
    let delay_ms = response_json(&response)
        .ok()
        .and_then(|json| json.get("delay").and_then(Value::as_u64));
    Ok(ProxyDelayResult {
        node,
        target_url,
        status: if delay_ms.is_some() { "ok" } else { "error" }.to_string(),
        delay_ms,
        duration_ms,
        detail: if delay_ms.is_some() {
            "测速成功".to_string()
        } else {
            "控制器未返回延迟值".to_string()
        },
    })
}

#[tauri::command]
pub async fn test_direct_delay(
    app: AppHandle,
    input: DirectDelayInput,
) -> Result<ProxyDelayResult, String> {
    let config = read_config(&app)?;
    let target_url = validate_http_url(&input.target_url, "Base URL")?;
    let timeout_ms = input
        .timeout_ms
        .unwrap_or(config.timeout_ms)
        .clamp(500, 60_000);
    let client = Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_millis(timeout_ms))
        .timeout(Duration::from_millis(timeout_ms))
        .redirect(Policy::limited(5))
        .user_agent("Codex-Compass/1.3")
        .build()
        .map_err(|_| "无法创建本地直连测速客户端".to_string())?;
    let started = Instant::now();
    let response = client
        .get(&target_url)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .send()
        .await;
    let duration_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;

    match response {
        Ok(response) => Ok(ProxyDelayResult {
            node: "本地直连".to_string(),
            target_url,
            status: "ok".to_string(),
            delay_ms: Some(duration_ms),
            duration_ms,
            detail: format!("本地直连 HTTP {}", response.status().as_u16()),
        }),
        Err(error) => {
            let timed_out = error.is_timeout();
            Ok(ProxyDelayResult {
                node: "本地直连".to_string(),
                target_url,
                status: if timed_out { "timeout" } else { "error" }.to_string(),
                delay_ms: None,
                duration_ms,
                detail: if timed_out {
                    "本地直连请求超时".to_string()
                } else {
                    "本地直连失败，请检查当前网络或目标地址".to_string()
                },
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_windows_processes_are_noninteractive_and_windowless() {
        let source = include_str!("proxy_latency.rs");
        assert!(source.contains("\"-NoLogo\""));
        assert!(source.contains("\"-NoProfile\""));
        assert!(source.contains("\"-NonInteractive\""));
        assert!(source.contains(".creation_flags(CREATE_NO_WINDOW)"));
        assert!(source.contains(".stdin(Stdio::null())"));
        assert!(source.contains(".stdout(Stdio::null())"));
        assert!(source.contains(".stderr(Stdio::null())"));
    }

    #[test]
    fn defaults_to_all_controller_nodes() {
        let config = StoredProxyLatencyConfig::default();
        assert!(!config.only_imported_nodes);
        assert!(config.include_local_test);
        assert_eq!(config.timeout_ms, 5_000);
        assert_eq!(config.concurrency, 16);
        assert_eq!(config.targets.len(), 3);
    }

    #[test]
    fn migrates_legacy_subscription_only_default() {
        let mut config = StoredProxyLatencyConfig::default();
        config.version = 1;
        config.only_imported_nodes = true;
        normalize_config(&mut config);
        assert_eq!(config.version, CONFIG_VERSION);
        assert!(!config.only_imported_nodes);
    }

    #[test]
    fn parses_clash_yaml_node_names() {
        let content = r#"
proxies:
  - name: 香港 01
    type: vmess
    server: example.com
  - name: 新加坡 02
    type: trojan
    server: example.net
"#;
        assert_eq!(
            parse_subscription_nodes(content),
            vec!["香港 01", "新加坡 02"]
        );
    }

    #[test]
    fn parses_base64_uri_subscription() {
        let raw =
            "trojan://password@example.com:443#Tokyo%2001\nvless://id@example.net:443#Seoul%2002";
        let encoded = general_purpose::STANDARD.encode(raw);
        assert_eq!(
            parse_subscription_nodes(&encoded),
            vec!["Tokyo 01", "Seoul 02"]
        );
    }

    #[test]
    fn parses_vmess_ps_name() {
        let payload = general_purpose::STANDARD
            .encode(r#"{"v":"2","ps":"US West 03","add":"example.com","port":"443","id":"id"}"#);
        let subscription = format!("vmess://{payload}");
        assert_eq!(parse_subscription_nodes(&subscription), vec!["US West 03"]);
    }

    #[test]
    fn decodes_chunked_http_body() {
        let raw = b"4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n";
        assert_eq!(
            decode_chunked_body(raw).expect("chunked body"),
            b"Wikipedia"
        );
    }

    #[test]
    fn parses_proxy_provider_memberships() {
        let response = ControllerHttpResponse {
            status: 200,
            body: r#"{
                "providers": {
                    "三毛机场": {
                        "name": "三毛机场",
                        "proxies": [
                            {"name": "香港 01", "type": "Trojan"},
                            {"name": "日本 02", "type": "VLESS"}
                        ]
                    },
                    "备用机场": {
                        "proxies": [
                            {"name": "香港 01", "type": "Trojan"}
                        ]
                    }
                }
            }"#
            .as_bytes()
            .to_vec(),
        };
        let memberships =
            parse_proxy_provider_memberships(&response).expect("provider memberships");
        assert_eq!(
            memberships.get("香港 01"),
            Some(&vec!["三毛机场".to_string(), "备用机场".to_string()])
        );
        assert_eq!(
            memberships.get("日本 02"),
            Some(&vec!["三毛机场".to_string()])
        );
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    #[ignore = "requires a running local Mihomo controller"]
    async fn live_mihomo_named_pipe_delay() {
        let controller = StoredControllerSettings::default();
        let version = controller_request(&controller, "/version", 3_000)
            .await
            .expect("Mihomo version endpoint");
        assert_eq!(version.status, 200);
        let proxies = controller_request(&controller, "/proxies", 6_000)
            .await
            .expect("Mihomo proxies endpoint");
        let nodes = parse_proxy_nodes(&proxies).expect("proxy nodes");
        assert!(!nodes.is_empty(), "no actual proxy nodes available");

        let mut success = false;
        for node in nodes.iter().take(12) {
            let response = request_proxy_delay(
                &controller,
                &node.name,
                "https://www.gstatic.com/generate_204",
                5_000,
            )
            .await
            .expect("delay request");
            if response.status == 200
                && response_json(&response)
                    .ok()
                    .and_then(|json| json.get("delay").and_then(Value::as_u64))
                    .is_some()
            {
                success = true;
                break;
            }
        }
        assert!(success, "no tested proxy node returned a delay");
    }
}
