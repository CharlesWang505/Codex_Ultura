# Key 级模型成本路由与自动故障切换实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Codex Compass 内置网关中实现“站点 + API Key + 模型”级独立健康检测、7 天实测倍率选路、任务内 Key 粘性、熔断和同模型自动故障切换。

**Architecture:** Tauri 层负责读取敏感站点配置、生成 HMAC Key 指纹、调用 New API/Sub2API 管理接口并写入私有 SQLite；`codex-plus-core` 只接收内存通道快照，负责成本策略、任务绑定、错误分类、熔断和协议代理尝试。前端通过批量 Tauri 快照和事件按站点、Key、模型展示状态，原始 Key、Cookie、请求正文和响应正文不离开后端。

**Tech Stack:** Rust 2024、Tokio、Tauri 2、Reqwest、Rusqlite、HMAC-SHA256、Serde、React 19、TypeScript、Recharts、Node test runner。

---

## 文件结构

新增或拆分后的职责如下：

- `src-tauri/codex-plus/crates/codex-plus-core/src/model_routing/types.rs`：共享通道、成本、健康、路由和事件类型。
- `src-tauri/codex-plus/crates/codex-plus-core/src/model_routing/failure.rs`：网络、超时和 HTTP 错误分类。
- `src-tauri/codex-plus/crates/codex-plus-core/src/model_routing/circuit_breaker.rs`：每 Key/模型熔断状态机。
- `src-tauri/codex-plus/crates/codex-plus-core/src/model_routing/cost_policy.rs`：7 天实测倍率、10% 门槛和稳定排序。
- `src-tauri/codex-plus/crates/codex-plus-core/src/model_routing/runtime.rs`：运行时通道快照、任务绑定、请求反馈和事件广播。
- `src-tauri/src/model_channels/registry.rs`：站点/RelayProfile 关联、URL 规范化、HMAC 指纹、模型选择。
- `src-tauri/src/model_channels/providers/new_api.rs`：New API 登录、模型、令牌和日志解析。
- `src-tauri/src/model_channels/providers/sub2api.rs`：Sub2API 模型、用量和 Billing 解析。
- `src-tauri/src/model_channels/cost_ledger.rs`：SQLite 表、幂等写入、7 天汇总和 30 天清理。
- `src-tauri/src/model_channels/mod.rs`：调度器、Tauri 命令、事件和前端脱敏快照。
- `src-tauri/src/model_health.rs`：复用现有检测请求，改为按注册后的 Key/模型执行。
- `src/features/codex/providers/modelChannelState.ts`：前端分组、筛选和展示辅助函数。
- `src/features/codex/providers/ModelHealthPanel.tsx`：Key 分组、模型卡片、详情、选择器和四个开关。

### Task 1: 配置字段、兼容迁移和前端镜像类型

**Files:**
- Modify: `src-tauri/codex-plus/crates/codex-plus-core/src/settings.rs`
- Modify: `src/features/codex/types.ts`
- Test: `src-tauri/codex-plus/crates/codex-plus-core/tests/model_health.rs`
- Test: `tests/codex-ui-logic.test.mjs`

- [ ] **Step 1: 编写旧配置兼容和四开关默认值失败测试**

在 `model_health.rs` 测试中加入：

```rust
#[test]
fn routing_switches_are_independent_and_disabled_by_default() {
    let settings = BackendSettings::default();
    assert!(!settings.model_health_check_enabled);
    assert!(!settings.model_cost_routing_enabled);
    assert!(!settings.model_auto_failover_enabled);
    assert!(!settings.model_timeout_failover_enabled);
}

#[test]
fn legacy_settings_create_empty_channel_preferences() {
    let settings: BackendSettings = serde_json::from_value(serde_json::json!({})).unwrap();
    assert!(settings.model_channel_preferences.is_empty());
    assert!(settings.model_route_locks.is_empty());
}
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
cargo test -p codex-plus-core --test model_health routing_switches_are_independent_and_disabled_by_default
```

Expected: FAIL，`BackendSettings` 尚无成本路由、故障切换和通道偏好字段。

- [ ] **Step 3: 增加可序列化设置类型和默认值**

在 `settings.rs` 增加：

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ModelSelectionMode {
    #[default]
    All,
    Custom,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChannelPreference {
    pub source_ref: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub selection_mode: ModelSelectionMode,
    #[serde(default)]
    pub selected_models: Vec<String>,
    #[serde(default)]
    pub manual_rate: Option<f64>,
    #[serde(default)]
    pub manual_priority: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRouteLock {
    pub canonical_model: String,
    pub source_ref: String,
}
```

在 `BackendSettings` 和 `Default` 中加入：

```rust
#[serde(rename = "modelCostRoutingEnabled", default)]
pub model_cost_routing_enabled: bool,
#[serde(rename = "modelAutoFailoverEnabled", default)]
pub model_auto_failover_enabled: bool,
#[serde(rename = "modelTimeoutFailoverEnabled", default)]
pub model_timeout_failover_enabled: bool,
#[serde(rename = "modelChannelPreferences", default)]
pub model_channel_preferences: Vec<ModelChannelPreference>,
#[serde(rename = "modelRouteLocks", default)]
pub model_route_locks: Vec<ModelRouteLock>,
```

全部开关默认 `false`，两个集合默认空。

- [ ] **Step 4: 镜像 TypeScript 类型并增加纯类型测试**

在 `src/features/codex/types.ts` 增加与 Rust 同名 camelCase 字段：

```ts
export type ModelSelectionMode = 'all' | 'custom'

export type ModelChannelPreference = {
  sourceRef: string
  enabled: boolean
  selectionMode: ModelSelectionMode
  selectedModels: string[]
  manualRate: number | null
  manualPriority: number
}

export type ModelRouteLock = {
  canonicalModel: string
  sourceRef: string
}
```

并将五个字段加入 `BackendSettings`。在 `tests/codex-ui-logic.test.mjs` 断言旧设置合并函数补出默认值，且 `modelTimeoutFailoverEnabled` 不会随 `modelAutoFailoverEnabled` 自动开启。

- [ ] **Step 5: 运行设置和前端测试**

Run:

```powershell
cargo test -p codex-plus-core --test model_health
npm.cmd run test:codex-ui
```

Expected: PASS。

- [ ] **Step 6: 提交配置迁移**

```powershell
git add -p src-tauri/codex-plus/crates/codex-plus-core/src/settings.rs src/features/codex/types.ts tests/codex-ui-logic.test.mjs
git add src-tauri/codex-plus/crates/codex-plus-core/tests/model_health.rs
git commit -m "feat: configure key model routing"
```

### Task 2: Key 通道注册、URL 规范化和 HMAC 指纹

**Files:**
- Create: `src-tauri/codex-plus/crates/codex-plus-core/src/model_routing/mod.rs`
- Create: `src-tauri/codex-plus/crates/codex-plus-core/src/model_routing/types.rs`
- Modify: `src-tauri/codex-plus/crates/codex-plus-core/src/lib.rs`
- Create: `src-tauri/src/model_channels/registry.rs`
- Create: `src-tauri/src/model_channels/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/model_channels/registry.rs`

- [ ] **Step 1: 编写规范化、平台识别、去重和指纹失败测试**

```rust
#[test]
fn management_origin_removes_only_terminal_v1() {
    assert_eq!(normalize_management_origin("HTTPS://Code-Plan.Site/v1/").unwrap(), "https://code-plan.site");
    assert_eq!(normalize_management_origin("https://example.com/api/v1").unwrap(), "https://example.com/api");
}

#[test]
fn provider_kind_matches_the_four_confirmed_sites() {
    assert_eq!(detect_provider_kind("https://code-plan.site"), ProviderKind::NewApi);
    assert_eq!(detect_provider_kind("https://synapse-ai.uk"), ProviderKind::NewApi);
    assert_eq!(detect_provider_kind("https://bizdecipher.com"), ProviderKind::Sub2Api);
    assert_eq!(detect_provider_kind("https://sub.anzhiyu.com"), ProviderKind::Sub2Api);
    assert_eq!(detect_provider_kind("https://relay.example"), ProviderKind::OpenAiCompatible);
}

#[test]
fn same_origin_and_key_merge_site_and_relay_sources() {
    let channels = build_registry(&fixture_sites(), &fixture_settings(), b"01234567890123456789012345678901").unwrap();
    assert_eq!(channels.iter().filter(|channel| channel.key_preview == "sk-a...1234").count(), 1);
    assert!(channels[0].relay_profile.is_some());
    assert!(channels[0].monitor_site_id.is_some());
}
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
cargo test -p codex-compass model_channels::registry
```

Expected: FAIL，`model_channels` 模块不存在。

- [ ] **Step 3: 定义共享运行时通道类型**

`types.rs` 定义：

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    NewApi,
    Sub2Api,
    OpenAiCompatible,
}

#[derive(Debug, Clone)]
pub struct KeyChannel {
    pub channel_id: String,
    pub source_refs: Vec<String>,
    pub relay_profile: RelayProfile,
    pub monitor_site_id: Option<String>,
    pub provider_kind: ProviderKind,
    pub normalized_origin: String,
    pub key_fingerprint: String,
    pub key_preview: String,
    pub display_name: String,
    pub enabled: bool,
    pub selection_mode: ModelSelectionMode,
    pub selected_models: BTreeSet<String>,
    pub discovered_models: BTreeSet<String>,
    pub canonical_to_upstream: BTreeMap<String, String>,
    pub manual_rate: Option<f64>,
    pub manual_priority: i32,
    pub balance_state: BalanceState,
}

impl KeyChannel {
    pub fn participates(&self, canonical_model: &str) -> bool {
        self.enabled
            && self.selected_models.contains(canonical_model)
            && self.canonical_to_upstream.contains_key(canonical_model)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BalanceState {
    Unknown,
    Available,
    Zero,
    Exhausted,
    Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CostConfidence {
    Trusted,
    Provisional,
    CurrentOnly,
    ManualOnly,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ModelChannelKey {
    pub channel_id: String,
    pub canonical_model: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelChannelHealthStatus {
    Unknown,
    Checking,
    Available,
    Degraded,
    Unavailable,
    Disabled,
    NotSelected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCostSummary {
    pub measured_rate: Option<f64>,
    pub confidence: CostConfidence,
    pub sample_count: u64,
    pub standard_cost: f64,
    pub actual_cost: f64,
    pub current_rate: Option<f64>,
    pub current_rate_observed_at: Option<u64>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ModelRoutingOptions {
    pub cost_routing_enabled: bool,
    pub auto_failover_enabled: bool,
    pub timeout_failover_enabled: bool,
}

#[derive(Debug, Clone)]
pub struct RouteCandidate {
    pub channel_id: String,
    pub canonical_model: String,
    pub upstream_model: String,
    pub relay: RelayProfile,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TaskModelKey {
    pub task_id: String,
    pub canonical_model: String,
}

#[derive(Debug, Clone)]
pub struct ModelChannelHealth {
    pub status: ModelChannelHealthStatus,
    pub checked_at: Option<u64>,
    pub last_success_at: Option<u64>,
    pub detail: String,
}
```

原始 Key 只存在 `relay_profile.api_key` 的后端内存副本，序列化前端快照不包含 `relay_profile`。

- [ ] **Step 4: 实现安全站点读取和通道注册**

`registry.rs` 使用以下稳定来源标识：

```rust
fn primary_source_ref(site_id: &str) -> String {
    format!("site:{site_id}:primary")
}

fn probe_source_ref(site_id: &str, probe_id: &str) -> String {
    format!("site:{site_id}:probe:{probe_id}")
}

fn relay_source_ref(relay_id: &str) -> String {
    format!("relay:{relay_id}")
}
```

HMAC 密钥位于应用敏感目录 `model-channel-hmac.key`，首次创建时由两个 `Uuid::new_v4()` 的 16 字节拼成 32 字节。指纹实现：

```rust
type HmacSha256 = hmac::Hmac<sha2::Sha256>;

fn key_fingerprint(secret: &[u8], api_key: &str) -> anyhow::Result<String> {
    let mut mac = <HmacSha256 as hmac::Mac>::new_from_slice(secret)?;
    mac.update(api_key.trim().as_bytes());
    Ok(encode_hex(mac.finalize().into_bytes().as_slice()))
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}
```

合并键为 `(normalized_origin, key_fingerprint)`。

- [ ] **Step 5: 运行注册表测试和隐私断言**

Run:

```powershell
cargo test -p codex-compass model_channels::registry
cargo test -p codex-compass model_channels::registry::tests::serialized_snapshot_never_contains_raw_key
```

Expected: PASS，快照 JSON 不包含 fixture 中的 Key、Cookie 或密码。

- [ ] **Step 6: 提交通道注册**

```powershell
git add src-tauri/codex-plus/crates/codex-plus-core/src/model_routing src-tauri/codex-plus/crates/codex-plus-core/src/lib.rs src-tauri/src/model_channels
git add -p src-tauri/src/lib.rs
git commit -m "feat: register key model channels"
```

### Task 3: 每 Key 模型发现和自定义选择

**Files:**
- Modify: `src-tauri/src/model_channels/registry.rs`
- Modify: `src-tauri/codex-plus/crates/codex-plus-core/src/hot_switch_mapping.rs`
- Modify: `src-tauri/codex-plus/crates/codex-plus-core/src/model_catalog.rs`
- Test: `src-tauri/src/model_channels/registry.rs`
- Test: `src-tauri/codex-plus/crates/codex-plus-core/src/hot_switch_mapping.rs`

- [ ] **Step 1: 编写 all/custom 模式和精确映射失败测试**

```rust
#[test]
fn all_mode_selects_every_discovered_model() {
    let selected = selected_models(
        ModelSelectionMode::All,
        &["gpt-a".into(), "gpt-b".into()],
        &["gpt-a".into()],
    );
    assert_eq!(selected, BTreeSet::from(["gpt-a".into(), "gpt-b".into()]));
}

#[test]
fn custom_mode_never_selects_new_models_implicitly() {
    let selected = selected_models(
        ModelSelectionMode::Custom,
        &["gpt-a".into(), "gpt-b".into()],
        &["gpt-a".into()],
    );
    assert_eq!(selected, BTreeSet::from(["gpt-a".into()]));
}

#[test]
fn manual_mapping_is_exact_and_does_not_fuzzy_match() {
    assert_eq!(canonical_model_for("gpt-5.6-luna", &fixture_mappings()), "codex-luna");
    assert_eq!(canonical_model_for("gpt-5.6-luna-preview", &fixture_mappings()), "gpt-5.6-luna-preview");
}
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
cargo test -p codex-compass model_channels::registry::tests::all_mode_selects_every_discovered_model
```

Expected: FAIL，模型选择函数尚不存在。

- [ ] **Step 3: 实现发现回退顺序和规范模型映射**

每个 Key 的模型来源按以下顺序合并去重：

```rust
fn merge_discovered_models(
    api_models: Vec<String>,
    token_models: Vec<String>,
    relay_models: Vec<String>,
    manual_models: Vec<String>,
) -> BTreeSet<String> {
    api_models
        .into_iter()
        .chain(token_models)
        .chain(relay_models)
        .chain(manual_models)
        .map(|model| parse_model_suffix(&model).0.trim().to_string())
        .filter(|model| !model.is_empty())
        .collect()
}
```

`HotSwitchModelMapping` 只在 `relay_id` 和 `upstream_model` 精确匹配时产生 `canonical_to_upstream`；无映射时 canonical 与 upstream 相同。

- [ ] **Step 4: 保存选择时立即唤醒一次指定模型检测**

`model_channels/mod.rs` 暴露：

```rust
pub async fn update_selection(
    &self,
    source_ref: String,
    selection_mode: ModelSelectionMode,
    selected_models: Vec<String>,
) -> Result<(), String>;
```

写入 `SettingsStore` 后重新注册通道；新勾选模型调用 `ModelHealthManager::run_selected_channels`，未选模型生成 `notSelected` 状态且不发请求。

- [ ] **Step 5: 运行模型发现和映射测试**

Run:

```powershell
cargo test -p codex-compass model_channels::registry
cargo test -p codex-plus-core hot_switch_mapping
```

Expected: PASS。

- [ ] **Step 6: 提交模型选择**

```powershell
git add src-tauri/src/model_channels/registry.rs src-tauri/codex-plus/crates/codex-plus-core/src/hot_switch_mapping.rs src-tauri/codex-plus/crates/codex-plus-core/src/model_catalog.rs
git commit -m "feat: select models per api key"
```

### Task 4: New API 和 Sub2API 供应商适配

**Files:**
- Create: `src-tauri/src/model_channels/providers/mod.rs`
- Create: `src-tauri/src/model_channels/providers/new_api.rs`
- Create: `src-tauri/src/model_channels/providers/sub2api.rs`
- Modify: `src-tauri/src/model_channels/mod.rs`
- Test: `src-tauri/src/model_channels/providers/new_api.rs`
- Test: `src-tauri/src/model_channels/providers/sub2api.rs`

- [ ] **Step 1: 编写 New API 日志、令牌和倍率解析失败测试**

```rust
#[test]
fn parses_new_api_request_cost_pair_and_token_name() {
    let rows = parse_usage_rows(&serde_json::json!({
        "data": [{"id": 41, "model_name": "gpt-5", "token_name": "cheap-key",
          "quota": 200000, "actual_cost": 0.12, "cost": 0.20, "created_at": 1784772000}]
    }));
    assert_eq!(rows[0].source_record_id, "41");
    assert_eq!(rows[0].model, "gpt-5");
    assert_eq!(rows[0].token_name.as_deref(), Some("cheap-key"));
    assert_eq!(rows[0].standard_cost, Some(0.20));
    assert_eq!(rows[0].actual_cost, Some(0.12));
}

#[test]
fn cookie_is_preferred_for_new_api_management_requests() {
    let headers = management_headers(&fixture_site_with_cookie(), "/api/log/self");
    assert!(headers.get("cookie").is_some());
    assert!(headers.get("authorization").is_none());
    assert_eq!(headers.get("new-api-user").unwrap(), "17");
}
```

- [ ] **Step 2: 编写 Sub2API 用量窗口和 Billing 解析失败测试**

```rust
#[test]
fn parses_sub2api_model_window_without_losing_actual_cost() {
    let snapshot = parse_usage_snapshot(&serde_json::json!({
        "start_time": "2026-07-16T00:00:00Z",
        "end_time": "2026-07-23T00:00:00Z",
        "model_stats": {"gpt-5": {"requests": 8, "cost": 4.0, "actual_cost": 2.0,
          "input_tokens": 1000, "output_tokens": 400, "cache_read_tokens": 200}}
    })).unwrap();
    assert_eq!(snapshot.models[0].successful_requests, 8);
    assert_eq!(snapshot.models[0].standard_cost, 4.0);
    assert_eq!(snapshot.models[0].actual_cost, 2.0);
}

#[test]
fn parses_sub2api_current_multiplier() {
    assert_eq!(
        parse_billing_rate(&serde_json::json!({"effective_rate_multiplier": 0.65})),
        Some(0.65),
    );
}
```

- [ ] **Step 3: 运行适配器测试并确认失败**

Run:

```powershell
cargo test -p codex-compass model_channels::providers
```

Expected: FAIL，适配器模块尚不存在。

- [ ] **Step 4: 实现统一适配器接口**

```rust
#[async_trait::async_trait]
pub trait ProviderUsageAdapter: Send + Sync {
    async fn discover_models(&self, channel: &KeyChannel) -> anyhow::Result<Vec<String>>;
    async fn fetch_cost_data(
        &self,
        channel: &KeyChannel,
        window: UsageWindow,
    ) -> anyhow::Result<ProviderCostBatch>;
}

pub struct ProviderCostBatch {
    pub request_observations: Vec<RequestCostObservation>,
    pub window_observations: Vec<WindowCostObservation>,
    pub current_rates: Vec<CurrentModelRate>,
    pub balance_state: BalanceState,
}

pub struct UsageWindow {
    pub start_unix_seconds: u64,
    pub end_unix_seconds: u64,
}

pub struct RequestCostObservation {
    pub channel_id: String,
    pub canonical_model: String,
    pub source_record_id: String,
    pub successful_requests: u64,
    pub standard_cost: f64,
    pub actual_cost: f64,
    pub observed_at: u64,
    pub source: String,
}

pub struct WindowCostObservation {
    pub channel_id: String,
    pub canonical_model: String,
    pub window_start: u64,
    pub window_end: u64,
    pub successful_requests: u64,
    pub standard_cost: f64,
    pub actual_cost: f64,
    pub source: String,
}

pub struct CurrentModelRate {
    pub canonical_model: String,
    pub rate: f64,
    pub source: String,
    pub observed_at: u64,
}
```

New API 请求管理根地址时移除末尾 `/v1`，使用 `/api/token/`、`/api/log/self`、`/api/pricing`、`/api/ratio_config`、`/api/user/self/groups`。Cookie 失效且 `autoLogin` 为真时调用 `/api/user/login`，成功后原子更新 `sites.json` 中 Cookie、访问令牌和 User ID。

Sub2API 对每个具体 Key 调用 `/v1/models`、`/v1/usage`、`/v1/sub2api/billing`，不使用网页登录凭据。`/v1/usage` 失败时保留旧完整窗口，并使用 Billing 当前倍率作为 `currentOnly` 降级，不把失败响应覆盖进账本。

- [ ] **Step 5: 实现普通 OpenAI 兼容降级**

普通兼容站只返回 `/v1/models`；成本批次为空，路由评分随后使用手工倍率和优先级。

- [ ] **Step 6: 运行适配器测试**

Run:

```powershell
cargo test -p codex-compass model_channels::providers
```

Expected: PASS，测试日志输出不含 fixture Key 和 Cookie。

- [ ] **Step 7: 提交供应商适配**

```powershell
git add src-tauri/src/model_channels/providers src-tauri/src/model_channels/mod.rs
git commit -m "feat: adapt provider usage apis"
```

### Task 5: SQLite 成本账本、幂等刷新和实测倍率

**Files:**
- Create: `src-tauri/src/model_channels/cost_ledger.rs`
- Modify: `src-tauri/src/model_channels/mod.rs`
- Test: `src-tauri/src/model_channels/cost_ledger.rs`

- [ ] **Step 1: 编写请求去重、窗口 upsert 和可信度失败测试**

```rust
#[test]
fn duplicate_new_api_request_id_counts_once() {
    let ledger = fixture_ledger();
    ledger.upsert_request(&request_observation("req-1", 1.0, 0.6)).unwrap();
    ledger.upsert_request(&request_observation("req-1", 1.0, 0.6)).unwrap();
    let summary = ledger.summary("channel-a", "gpt-5", fixture_now()).unwrap();
    assert_eq!(summary.sample_count, 1);
    assert_eq!(summary.standard_cost, 1.0);
}

#[test]
fn overlapping_sub2api_window_replaces_instead_of_accumulates() {
    let ledger = fixture_ledger();
    ledger.upsert_window(&window_observation(5, 5.0, 3.0)).unwrap();
    ledger.upsert_window(&window_observation(6, 6.0, 3.0)).unwrap();
    let summary = ledger.summary("channel-a", "gpt-5", fixture_now()).unwrap();
    assert_eq!(summary.sample_count, 6);
    assert_eq!(summary.standard_cost, 6.0);
}

#[test]
fn measured_rate_requires_five_paid_successes() {
    let ledger = fixture_ledger();
    for index in 0..4 {
        ledger.upsert_request(&request_observation(&format!("req-{index}"), 1.0, 0.5)).unwrap();
    }
    assert_eq!(ledger.summary("channel-a", "gpt-5", fixture_now()).unwrap().confidence, CostConfidence::Provisional);
    ledger.upsert_request(&request_observation("req-4", 1.0, 0.5)).unwrap();
    assert_eq!(ledger.summary("channel-a", "gpt-5", fixture_now()).unwrap().confidence, CostConfidence::Trusted);
}
```

- [ ] **Step 2: 运行账本测试并确认失败**

Run:

```powershell
cargo test -p codex-compass model_channels::cost_ledger
```

Expected: FAIL，成本账本尚不存在。

- [ ] **Step 3: 建表并实现事务写入**

数据库路径为应用数据目录 `model-routing.sqlite3`。初始化 SQL：

```sql
CREATE TABLE IF NOT EXISTS model_cost_observations (
  channel_id TEXT NOT NULL,
  canonical_model TEXT NOT NULL,
  observation_kind TEXT NOT NULL CHECK (observation_kind IN ('request', 'window_snapshot')),
  source_record_id TEXT,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  successful_requests INTEGER NOT NULL,
  standard_cost REAL NOT NULL,
  actual_cost REAL NOT NULL,
  source TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  UNIQUE(channel_id, canonical_model, source, source_record_id),
  UNIQUE(channel_id, canonical_model, source, observation_kind, window_start, window_end)
);

CREATE TABLE IF NOT EXISTS model_cost_summaries (
  channel_id TEXT NOT NULL,
  canonical_model TEXT NOT NULL,
  measured_rate REAL,
  confidence TEXT NOT NULL,
  sample_count INTEGER NOT NULL,
  standard_cost REAL NOT NULL,
  actual_cost REAL NOT NULL,
  current_rate REAL,
  current_rate_source TEXT,
  current_rate_observed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(channel_id, canonical_model)
);

CREATE TABLE IF NOT EXISTS model_route_preferences (
  canonical_model TEXT PRIMARY KEY,
  preferred_channel_id TEXT NOT NULL,
  selected_reason TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

每个通道刷新使用独立事务；解析失败不开始事务，写入失败回滚该通道，不影响其他通道。

- [ ] **Step 4: 实现 7 天汇总、30 天清理和 24 小时倍率缓存**

合法观测要求 `standard_cost > 0`、费用有限且非负、成功请求数大于零。`actual_cost == 0` 的订阅/套餐记录不参与最低成本评分。逐请求样本不少于 7 条时，先按单条 `actual_cost / standard_cost` 计算中位数和中位数绝对偏差，排除偏离中位数超过 `3 * MAD` 的明显异常值；MAD 为零时只保留与中位数相同的样本。实测倍率仍使用过滤后的费用总和：

```rust
let measured_rate = total_actual_cost / total_standard_cost;
```

最近 7 天至少 5 个成功请求为 `trusted`；有效样本不足为 `provisional`；只有 24 小时内接口倍率为 `currentOnly`；只有手工倍率为 `manualOnly`；否则 `unknown`。

- [ ] **Step 5: 运行账本测试**

Run:

```powershell
cargo test -p codex-compass model_channels::cost_ledger
```

Expected: PASS。

- [ ] **Step 6: 提交成本账本**

```powershell
git add src-tauri/src/model_channels/cost_ledger.rs src-tauri/src/model_channels/mod.rs
git commit -m "feat: store measured model costs"
```

### Task 6: 成本选路、任务粘性、错误分类和熔断

**Files:**
- Create: `src-tauri/codex-plus/crates/codex-plus-core/src/model_routing/cost_policy.rs`
- Create: `src-tauri/codex-plus/crates/codex-plus-core/src/model_routing/failure.rs`
- Create: `src-tauri/codex-plus/crates/codex-plus-core/src/model_routing/circuit_breaker.rs`
- Create: `src-tauri/codex-plus/crates/codex-plus-core/src/model_routing/runtime.rs`
- Modify: `src-tauri/codex-plus/crates/codex-plus-core/src/model_routing/mod.rs`
- Create: `src-tauri/codex-plus/crates/codex-plus-core/tests/model_routing.rs`

- [ ] **Step 1: 编写 10% 门槛、排序和任务绑定失败测试**

```rust
#[test]
fn trusted_candidate_must_be_ten_percent_cheaper() {
    let current = candidate("current", 1.00, CostConfidence::Trusted);
    let nine_percent = candidate("nine", 0.91, CostConfidence::Trusted);
    let ten_percent = candidate("ten", 0.90, CostConfidence::Trusted);
    assert_eq!(choose_preferred(Some("current"), &[current.clone(), nine_percent]).unwrap().channel_id, "current");
    assert_eq!(choose_preferred(Some("current"), &[current, ten_percent]).unwrap().channel_id, "ten");
}

#[test]
fn task_binding_survives_cost_refresh_until_failure() {
    let runtime = fixture_runtime();
    assert_eq!(runtime.route("task-a", "gpt-5").unwrap()[0].channel_id, "cheap");
    runtime.install_cost(candidate_summary("other", 0.20));
    assert_eq!(runtime.route("task-a", "gpt-5").unwrap()[0].channel_id, "cheap");
}

#[test]
fn equal_cost_uses_failure_rate_latency_priority_and_stable_id() {
    let ordered = rank_candidates(vec![
        candidate_with_metrics("b", 0.5, 0.01, 900, 10),
        candidate_with_metrics("a", 0.5, 0.01, 800, 5),
    ], None);
    assert_eq!(ordered[0].channel_id, "a");
}
```

- [ ] **Step 2: 编写错误分类和熔断失败测试**

```rust
#[test]
fn retryable_http_statuses_and_validation_errors_are_separated() {
    assert!(classify_http(429, b"rate limit").retryable);
    assert!(classify_http(503, b"upstream unavailable").retryable);
    assert!(classify_http(404, b"model not found").retryable);
    assert!(!classify_http(400, b"invalid request").retryable);
    assert!(!classify_http(413, b"payload too large").retryable);
    assert!(!classify_http(422, b"context length exceeded").retryable);
}

#[test]
fn timeout_requires_the_independent_switch() {
    assert!(!classify_transport(TransportFailure::ResponseTimeout, false).retryable);
    assert!(classify_transport(TransportFailure::ResponseTimeout, true).retryable);
}

#[test]
fn circuit_opens_after_three_failures_and_allows_one_half_open_probe() {
    let mut circuit = CircuitBreaker::default();
    circuit.record_failure(0);
    circuit.record_failure(1);
    circuit.record_failure(2);
    assert_eq!(circuit.state(3), CircuitState::Open);
    assert_eq!(circuit.acquire(300_002), CircuitPermit::Probe);
    assert_eq!(circuit.acquire(300_003), CircuitPermit::Rejected);
    circuit.record_success();
    assert_eq!(circuit.state(300_004), CircuitState::Closed);
}
```

- [ ] **Step 3: 运行核心路由测试并确认失败**

Run:

```powershell
cargo test -p codex-plus-core --test model_routing
```

Expected: FAIL，路由模块尚无实现。

- [ ] **Step 4: 实现成本策略**

候选过滤顺序为：已选择模型、启用、余额未耗尽、非明确不可用、熔断允许。可信倍率优先于当前倍率，当前倍率优先于手工倍率；倍率相同依次比较当前首选、故障率、P95、手工优先级和 `channel_id`。

替换条件使用精确公式：

```rust
fn is_ten_percent_cheaper(current: f64, candidate: f64) -> bool {
    current.is_finite()
        && candidate.is_finite()
        && current > 0.0
        && candidate <= current * 0.90
}
```

- [ ] **Step 5: 实现运行时和事件广播**

`ModelRoutingRuntime` 保存：

```rust
pub struct ModelRoutingRuntime {
    options: RwLock<ModelRoutingOptions>,
    channels: RwLock<HashMap<String, KeyChannel>>,
    costs: RwLock<HashMap<ModelChannelKey, ModelCostSummary>>,
    health: RwLock<HashMap<ModelChannelKey, ModelChannelHealth>>,
    bindings: Mutex<HashMap<TaskModelKey, String>>,
    circuits: Mutex<HashMap<ModelChannelKey, CircuitBreaker>>,
    metrics: Mutex<HashMap<ModelChannelKey, RuntimeMetrics>>,
    events: tokio::sync::broadcast::Sender<ModelRoutingEvent>,
}
```

`ModelRoutingEvent` 定义 `HealthChanged`、`PreferredChanged`、`FailoverOccurred`、`InvalidKey` 和 `AllChannelsUnavailable` 五种负载，均只含通道 ID、模型、状态和时间。

`route(task_id, canonical_model)` 最多返回 3 个同模型通道；未选模型、跨模型通道和打开熔断通道不会进入自动结果。用户显式选择某个 RelayProfile 和模型时，即使该模型未被勾选，也允许单通道直接调用，但不得参与成本排序或自动故障切换。真实成功清零连续失败并可更新任务绑定；可重试失败增加计数并尝试下一个；不可重试失败立即结束。

熔断常量固定为：

```rust
pub const CIRCUIT_FAILURE_THRESHOLD: u32 = 3;
pub const CIRCUIT_OPEN_DURATION: Duration = Duration::from_secs(5 * 60);
pub const MAX_CHANNEL_ATTEMPTS: usize = 3;
```

冷却满 5 分钟后进入半开状态，只允许一个探测许可；探测成功关闭熔断，探测失败重新打开 5 分钟。

- [ ] **Step 6: 运行核心路由测试**

Run:

```powershell
cargo test -p codex-plus-core --test model_routing
cargo test -p codex-plus-core model_routing
```

Expected: PASS。

- [ ] **Step 7: 提交核心路由**

```powershell
git add src-tauri/codex-plus/crates/codex-plus-core/src/model_routing src-tauri/codex-plus/crates/codex-plus-core/tests/model_routing.rs
git commit -m "feat: route and fail over model keys"
```

### Task 7: 注册表、成本调度器和现有健康检测整合

**Files:**
- Modify: `src-tauri/src/model_channels/mod.rs`
- Modify: `src-tauri/src/model_health.rs`
- Modify: `src-tauri/codex-plus/crates/codex-plus-core/src/model_health.rs`
- Modify: `src-tauri/codex-plus/crates/codex-plus-core/tests/model_health.rs`
- Modify: `src-tauri/src/codex_commands.rs`
- Test: `src-tauri/src/model_channels/mod.rs`
- Test: `src-tauri/src/model_health.rs`

- [ ] **Step 1: 编写调度和未选模型排除失败测试**

```rust
#[test]
fn scheduler_runs_immediately_then_waits_ten_minutes() {
    assert_eq!(scheduler_action(true, true), SchedulerAction::RunThenDelay);
    assert_eq!(MODEL_CHANNEL_REFRESH_INTERVAL, Duration::from_secs(600));
}

#[test]
fn unselected_models_never_become_probe_targets() {
    let channels = fixture_channels_with_custom_selection();
    let targets = selected_probe_targets(&channels);
    assert_eq!(targets.iter().map(|target| target.model.as_str()).collect::<Vec<_>>(), vec!["gpt-a"]);
}
```

- [ ] **Step 2: 运行调度测试并确认失败**

Run:

```powershell
cargo test -p codex-compass model_channels::tests
cargo test -p codex-compass model_health::tests::unselected_models_never_become_probe_targets
```

Expected: FAIL，调度器尚未整合注册表。

- [ ] **Step 3: 实现统一启动和 10 分钟刷新**

`ModelChannelManager` 启动两个独立循环：

```rust
async fn run_health_scheduler(self) {
    loop {
        if self.settings().model_health_check_enabled {
            let _ = self.refresh_health(None).await;
            self.wait_or_wake(Duration::from_secs(600)).await;
        } else {
            self.wake.notified().await;
        }
    }
}

async fn run_cost_scheduler(self) {
    loop {
        if self.settings().model_cost_routing_enabled {
            let _ = self.refresh_costs(None).await;
            self.wait_or_wake(Duration::from_secs(600)).await;
        } else {
            self.wake.notified().await;
        }
    }
}
```

两者均在功能开启后的首次循环立即运行；关闭定时检测后，代理真实请求反馈仍写入内存健康、故障率和延迟。

- [ ] **Step 4: 将现有健康结果从 RelayProfile/model 改为 channel/model**

`ModelHealthResult` 增加 `channel_id`、`source_ref`、`key_name`，状态扩展为 `unknown/checking/available/degraded/unavailable/disabled/notSelected`。保留旧 Tauri 命令返回兼容字段，前端迁移完成后仍不删除命令名称。

探测成功调用：

```rust
model_routing_runtime().record_probe_success(&channel.channel_id, &target.model, latency_ms);
```

探测失败调用：

```rust
model_routing_runtime().record_probe_failure(&channel.channel_id, &target.model, failure);
```

- [ ] **Step 5: 保存设置时只使受影响通道失效**

`save_settings` 继续使用配置锁；Key、URL、模型选择或映射变化时重建注册表，删除旧指纹的任务外熔断和健康状态，保留 SQLite 历史至 30 天清理。

- [ ] **Step 6: 运行调度和健康测试**

Run:

```powershell
cargo test -p codex-compass model_channels
cargo test -p codex-compass model_health
cargo test -p codex-plus-core --test model_health
```

Expected: PASS。

- [ ] **Step 7: 提交调度整合**

```powershell
git add src-tauri/src/model_channels/mod.rs src-tauri/src/model_health.rs src-tauri/codex-plus/crates/codex-plus-core/src/model_health.rs src-tauri/codex-plus/crates/codex-plus-core/tests/model_health.rs
git add -p src-tauri/src/codex_commands.rs
git commit -m "feat: schedule key model refreshes"
```

### Task 8: Responses 和 Chat Completions 代理故障切换

**Files:**
- Modify: `src-tauri/codex-plus/crates/codex-plus-core/src/protocol_proxy.rs`
- Modify: `src-tauri/codex-plus/crates/codex-plus-core/src/launcher.rs`
- Modify: `src-tauri/codex-plus/crates/codex-plus-core/tests/protocol_proxy.rs`
- Test: `src-tauri/codex-plus/crates/codex-plus-core/tests/model_routing.rs`

- [ ] **Step 1: 编写两种协议一致切换、三通道上限和不可重试错误测试**

```rust
#[tokio::test]
async fn responses_retries_429_but_not_400() {
    let server = fixture_sequence_server([429, 200, 400, 200]).await;
    let first = open_responses_proxy_request_with_runtime(&request("task-a"), server.runtime()).await.unwrap();
    assert_eq!(first.status_code, 200);
    let second = open_responses_proxy_request_with_runtime(&request("task-b"), server.runtime()).await.unwrap();
    assert_eq!(second.status_code, 400);
    assert_eq!(server.request_count(), 3);
}

#[tokio::test]
async fn chat_completions_uses_the_same_failover_classifier() {
    let server = fixture_sequence_server([503, 200]).await;
    let response = open_chat_completions_proxy_request_with_runtime(&chat_request("task-a"), server.runtime()).await.unwrap();
    assert_eq!(response.status_code, 200);
    assert_eq!(server.request_count(), 2);
}

#[tokio::test]
async fn one_request_never_attempts_more_than_three_channels() {
    let server = fixture_sequence_server([503, 503, 503, 200]).await;
    let response = open_responses_proxy_request_with_runtime(&request("task-a"), server.runtime()).await.unwrap();
    assert_eq!(response.status_code, 503);
    assert_eq!(server.request_count(), 3);
}
```

- [ ] **Step 2: 运行协议代理测试并确认失败**

Run:

```powershell
cargo test -p codex-plus-core --test protocol_proxy responses_retries_429_but_not_400
cargo test -p codex-plus-core --test protocol_proxy chat_completions_uses_the_same_failover_classifier
```

Expected: FAIL；Responses 当前会重试所有非 2xx，Chat Completions 当前不执行完整备用链。

- [ ] **Step 3: 提取统一代理尝试器**

`protocol_proxy.rs` 增加内部请求上下文：

```rust
#[derive(Debug, Clone)]
pub struct ProxyRequestContext {
    pub task_id: String,
    pub canonical_model: String,
    pub response_timeout_failover_enabled: bool,
}
```

任务标识按顺序读取 `conversation`、`conversation_id`、`metadata.thread_id`、`metadata.conversation_id`、`user`、`previous_response_id`；均不存在时使用 launcher 为当前本地请求生成的 `gateway_request_id`。后者只保证该请求内一致，不伪造跨任务粘性。

统一尝试器接收 `Vec<RouteCandidate>`，每次请求使用候选自己的 `RelayProfile` 和 upstream model。非 2xx 读取最多 1024 字节错误预览用于分类，预览只写脱敏分类，不写诊断日志。

- [ ] **Step 4: 保持流式边界**

只有收到上游响应头且状态可接受后，`open_*_proxy_request` 才把 `UpstreamProxyResponse` 交给 launcher。launcher 写出 HTTP/SSE 响应头或任意正文后不再调用路由器；流中断直接结束当前响应。

- [ ] **Step 5: 真实成功和失败反馈运行时**

成功记录延迟、清理熔断并把任务绑定到成功通道。401/403 发送 Key 失效事件；实际切换发送 `FailoverOccurred`；所有候选失败发送 `AllChannelsUnavailable`。诊断日志只写 `channelId`、模型、状态码、尝试次数和错误类别。

- [ ] **Step 6: 运行代理和 launcher 测试**

Run:

```powershell
cargo test -p codex-plus-core --test protocol_proxy
cargo test -p codex-plus-core --test model_routing
cargo test -p codex-plus-core launcher
```

Expected: PASS。

- [ ] **Step 7: 提交代理整合**

```powershell
git add src-tauri/codex-plus/crates/codex-plus-core/src/protocol_proxy.rs src-tauri/codex-plus/crates/codex-plus-core/src/launcher.rs src-tauri/codex-plus/crates/codex-plus-core/tests/protocol_proxy.rs src-tauri/codex-plus/crates/codex-plus-core/tests/model_routing.rs
git commit -m "feat: fail over proxy model keys"
```

### Task 9: Tauri 快照、命令、事件和手工锁定

**Files:**
- Modify: `src-tauri/src/model_channels/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/codex_commands.rs`
- Test: `src-tauri/src/model_channels/mod.rs`

- [ ] **Step 1: 编写脱敏快照和锁定失败测试**

```rust
#[test]
fn frontend_snapshot_contains_key_preview_but_no_secret() {
    let snapshot = snapshot_from_fixture();
    let json = serde_json::to_string(&snapshot).unwrap();
    assert!(json.contains("sk-a...1234"));
    assert!(!json.contains("sk-a-secret-1234"));
    assert!(!json.to_ascii_lowercase().contains("cookie"));
}

#[test]
fn locked_unavailable_channel_is_reported_but_not_routed() {
    let snapshot = locked_fixture_snapshot();
    assert_eq!(snapshot.models[0].route_role, ModelRouteRole::LockedUnavailable);
    assert_ne!(snapshot.models[0].active_channel_id.as_deref(), Some("broken"));
}
```

- [ ] **Step 2: 运行命令层测试并确认失败**

Run:

```powershell
cargo test -p codex-compass model_channels::tests::frontend_snapshot_contains_key_preview_but_no_secret
```

Expected: FAIL，前端快照尚未实现。

- [ ] **Step 3: 实现批量命令**

注册：

```rust
get_model_channel_snapshot
refresh_model_channels
update_model_channel_selection
set_model_routing_options
set_model_channel_lock
get_model_channel_detail
```

`refresh_model_channels` 接收可选 `sourceRef` 和 `canonicalModel`；手动刷新始终可用。`set_model_routing_options` 一次更新四个独立开关，不隐式开启依赖开关；超时切换关闭时保留自动故障切换。

- [ ] **Step 4: 实现批量事件**

事件名称固定为：

```rust
pub const MODEL_CHANNEL_HEALTH_UPDATED: &str = "model-channel-health:updated";
pub const MODEL_CHANNEL_COST_UPDATED: &str = "model-channel-cost:updated";
pub const MODEL_CHANNEL_ROUTE_CHANGED: &str = "model-channel-route:changed";
pub const MODEL_CHANNEL_FAILOVER_OCCURRED: &str = "model-channel-failover:occurred";
pub const MODEL_CHANNEL_REFRESH_COMPLETED: &str = "model-channel-refresh:completed";
```

事件负载只包含 `channelId`、`canonicalModel`、变化字段和时间。普通首选变化只更新面板；状态变化、实际切换、Key 失效、锁定不可用和全部通道不可用才生成顶层通知。

- [ ] **Step 5: 运行命令层测试**

Run:

```powershell
cargo test -p codex-compass model_channels
cargo check -p codex-compass
```

Expected: PASS。

- [ ] **Step 6: 提交 Tauri 接口**

```powershell
git add src-tauri/src/model_channels/mod.rs
git add -p src-tauri/src/lib.rs src-tauri/src/codex_commands.rs
git commit -m "feat: expose model channel controls"
```

### Task 10: Key 分组模型面板和模型详情

**Files:**
- Modify: `src/features/codex/types.ts`
- Create: `src/features/codex/providers/modelChannelState.ts`
- Modify: `src/features/codex/providers/modelMonitoring.ts`
- Modify: `src/features/codex/providers/ModelHealthPanel.tsx`
- Modify: `src/features/codex/providers/ModelHealthPanel.css`
- Modify: `src/features/codex/providers/modelHealth.ts`
- Modify: `src/features/codex/CodexWorkspace.tsx`
- Modify: `tests/model-monitor-logic.test.mjs`
- Create: `tests/model-channel-logic.test.mjs`

- [ ] **Step 1: 编写站点/Key/模型分组和秘密过滤失败测试**

```javascript
test('groups cards by site and key without borrowing another key state', () => {
  const groups = buildModelChannelGroups(snapshot)
  assert.deepEqual(groups.map((group) => group.keyName), ['主 Key', '低倍率 Key'])
  assert.equal(groups[0].models[0].health.status, 'available')
  assert.equal(groups[1].models[0].health.status, 'unavailable')
})

test('custom selection excludes unchecked models from routing badges', () => {
  const groups = buildModelChannelGroups(customSnapshot)
  const unchecked = groups[0].models.find((model) => model.canonicalModel === 'gpt-b')
  assert.equal(unchecked.routeRole, 'notSelected')
})

test('render model never contains raw credentials', () => {
  const text = JSON.stringify(buildModelChannelGroups(snapshot))
  assert.equal(text.includes('sk-secret-value'), false)
  assert.equal(text.toLowerCase().includes('cookie='), false)
})
```

- [ ] **Step 2: 运行前端逻辑测试并确认失败**

Run:

```powershell
node --experimental-strip-types --test tests/model-channel-logic.test.mjs
```

Expected: FAIL，`modelChannelState.ts` 尚不存在。

- [ ] **Step 3: 定义前端快照类型和纯分组函数**

快照类型包含：

```ts
export type ModelChannelSnapshot = {
  options: {
    healthCheckEnabled: boolean
    costRoutingEnabled: boolean
    autoFailoverEnabled: boolean
    timeoutFailoverEnabled: boolean
  }
  checking: boolean
  refreshingCosts: boolean
  channels: ModelKeyChannelView[]
  models: ModelChannelModelView[]
  lastHealthRefreshAt: number | null
  lastCostRefreshAt: number | null
  error: string | null
}
```

模型视图只消费后端按 Key 计算的健康、实测倍率、当前倍率、样本数、P50/P95、故障率、熔断和路由原因；删除当前 `modelMonitoring.ts` 中“按同名模型复制监控站点日志到所有 RelayProfile”的行为。

- [ ] **Step 4: 将面板改为站点和 Key 分组**

Key 行显示站点、平台、Key 名称、脱敏预览、全部/自定义模式、倍率来源、余额状态、启用、锁定和刷新。每个模型使用固定尺寸小方框，显示健康、实测倍率、当前倍率、样本数、最近成功时间和首选/备用/熔断/未选择标记。

四个开关均使用独立 toggle；“响应超时后切换”在自动故障切换关闭时可编辑但显示不会生效，不自动改变其保存值。

- [ ] **Step 5: 实现全屏详情和模型选择器**

详情页标签为“概览、成本、性能、故障”。显示最近检测、成功率、P50/P95、7 天倍率趋势、标准费用/实际扣费、路由原因、最近故障、切换记录、熔断恢复时间。选择模式使用 segmented control；自定义模式使用模型 checkbox 列表。

详情页和菜单背景使用现有不透明表面变量，z-index 高于主题蒙版；关闭按钮使用 Lucide `X` 并保持 18px 图标几何居中。

- [ ] **Step 6: 接入命令和批量事件**

进入“供应商配置”时加载 `get_model_channel_snapshot`。监听五个 `model-channel-*` 事件后只刷新一次批量快照；组件卸载时清理监听。保存选择、锁定和开关后使用命令返回的最新快照更新 UI。

- [ ] **Step 7: 运行前端测试、构建和 lint**

Run:

```powershell
node --experimental-strip-types --test tests/model-monitor-logic.test.mjs tests/model-channel-logic.test.mjs
npm.cmd run test:codex-ui
npm.cmd run build
npm.cmd run lint
```

Expected: PASS；lint 不增加新错误。

- [ ] **Step 8: 提交前端面板**

```powershell
git add src/features/codex/types.ts src/features/codex/providers/modelChannelState.ts src/features/codex/providers/modelMonitoring.ts src/features/codex/providers/ModelHealthPanel.tsx src/features/codex/providers/ModelHealthPanel.css src/features/codex/providers/modelHealth.ts src/features/codex/CodexWorkspace.tsx tests/model-monitor-logic.test.mjs tests/model-channel-logic.test.mjs
git commit -m "feat: show key model routing status"
```

### Task 11: 集成、安全、兼容和最终验证

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-07-23-key-model-cost-failover-routing-design.md`
- Test: `src-tauri/codex-plus/crates/codex-plus-core/tests/model_routing.rs`
- Test: `src-tauri/codex-plus/crates/codex-plus-core/tests/protocol_proxy.rs`
- Test: `tests/model-channel-logic.test.mjs`

- [ ] **Step 1: 添加全开关关闭兼容和四站点验收测试**

```rust
#[tokio::test]
async fn all_switches_off_preserve_static_relay_order() {
    let settings = fixture_settings_with_all_routing_switches(false);
    let route = route_candidates_for_request(&settings, "task-a", "gpt-5").unwrap();
    assert_eq!(route.iter().map(|item| item.relay.id.as_str()).collect::<Vec<_>>(), vec!["primary", "fallback"]);
}

#[test]
fn confirmed_sites_select_the_expected_adapters() {
    assert_eq!(adapter_name("https://code-plan.site/v1"), "newApi");
    assert_eq!(adapter_name("https://synapse-ai.uk/v1"), "newApi");
    assert_eq!(adapter_name("https://bizdecipher.com/v1"), "sub2api");
    assert_eq!(adapter_name("https://sub.anzhiyu.com/v1"), "sub2api");
}
```

- [ ] **Step 2: 运行定向回归**

Run:

```powershell
cargo test -p codex-plus-core --test model_health
cargo test -p codex-plus-core --test model_routing
cargo test -p codex-plus-core --test protocol_proxy
cargo test -p codex-compass model_channels
cargo test -p codex-compass model_health
node --experimental-strip-types --test tests/model-monitor-logic.test.mjs tests/model-channel-logic.test.mjs
npm.cmd run test:codex-ui
```

Expected: 全部 PASS。

- [ ] **Step 3: 运行完整编译和静态检查**

Run:

```powershell
cargo fmt --all -- --check
cargo check -p codex-compass
npm.cmd run build
npm.cmd run lint
git diff --check
```

Expected: 全部退出码为 0；仅允许仓库已有且与本功能无关的 lint 警告。

- [ ] **Step 4: 执行秘密扫描和数据库检查**

Run:

```powershell
git diff -- src-tauri/src/model_channels src-tauri/codex-plus/crates/codex-plus-core/src/model_routing src/features/codex/providers | Select-String -Pattern 'Authorization: Bearer sk-|Cookie:|loginPassword|sk-secret-value'
```

Expected: 无生产代码硬编码秘密；仅测试 fixture 的占位字符串允许出现。

运行账本测试后检查表结构只含指纹和聚合字段，不含 `api_key`、`cookie`、`password`、`request_body`、`response_body` 列。

- [ ] **Step 5: 更新变更记录和设计状态**

`CHANGELOG.md` 增加未发布条目，使用“实测倍率”而不是“折扣”，说明四开关默认关闭、每 Key/模型独立检测、7 天成本学习、任务内粘性、三通道故障切换和五分钟熔断。

设计文档状态改为“已实现并验证”，附上实现模块和测试命令，不写本地站点账号、Key、Cookie、绝对用户目录或数据库内容。

- [ ] **Step 6: 审查工作区和提交范围**

Run:

```powershell
git status --short --branch
git diff --stat
git diff --name-only
```

确认不暂存 `.build-target/`、`data/`、`target/`、备份、主题资源、远程控制文件和其他用户改动。

- [ ] **Step 7: 提交文档并推送当前分支**

```powershell
git add CHANGELOG.md docs/superpowers/specs/2026-07-23-key-model-cost-failover-routing-design.md
git commit -m "docs: document key model routing"
git push origin codex/model-health-auto-check
```

Expected: 推送成功，远端分支更新到最终提交。
