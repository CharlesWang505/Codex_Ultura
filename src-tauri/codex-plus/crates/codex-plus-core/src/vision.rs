use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const BATCH_SIZE: usize = 5;
const GOLDEN_WINDOW_DEPTH: usize = 10;
const ANALYZE_DEPTH_LIMIT: usize = 50;
const AVG_DESCRIPTION_TOKENS: u64 = 100;
const MAX_RETRIES: u32 = 2;
const PER_REQUEST_CONCURRENCY: usize = 3;
const MAX_GLOBAL_CONCURRENCY: usize = 5;
const MAX_CACHE_CAPACITY: usize = 500;
const CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const ANALYZE_ALL_TIMEOUT: Duration = Duration::from_secs(120);
const CONTEXT_SAFETY_MARGIN: f64 = 0.9;
const PARTIAL_IMAGE_FAILURE_NOTICE: &str = "[部分图片无法识别]";

#[cfg(not(test))]
const VLM_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(test)]
const VLM_REQUEST_TIMEOUT: Duration = Duration::from_secs(2);

type CacheEntry = (String, Instant);

static VLM_CACHE: LazyLock<Mutex<HashMap<String, CacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static VLM_SEMAPHORE: LazyLock<tokio::sync::Semaphore> =
    LazyLock::new(|| tokio::sync::Semaphore::new(MAX_GLOBAL_CONCURRENCY));

#[derive(Clone)]
pub struct VlmConfig {
    pub api_key: String,
    pub model: String,
    pub base_url: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ImageHandling {
    #[serde(rename = "send-as-is")]
    SendAsIs,
    Strip,
    Vlm,
}

pub fn image_handling_mode(model: &str, model_vlm_json: &str) -> ImageHandling {
    serde_json::from_str::<BTreeMap<String, ImageHandling>>(model_vlm_json)
        .ok()
        .and_then(|map| map.get(model).copied())
        .unwrap_or(ImageHandling::SendAsIs)
}

pub async fn process_request_images(request: &mut Value, relay: &crate::settings::RelayProfile) {
    let model = request
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if model.is_empty() {
        return;
    }

    let mode = image_handling_mode(&model, &relay.model_vlm);
    if mode == ImageHandling::SendAsIs {
        return;
    }
    let config = VlmConfig {
        api_key: relay.vlm_api_key.trim().to_string(),
        model: relay.vlm_model.trim().to_string(),
        base_url: relay.vlm_base_url.trim().trim_end_matches('/').to_string(),
    };
    if mode == ImageHandling::Vlm
        && (config.api_key.is_empty() || config.model.is_empty() || config.base_url.is_empty())
    {
        let _ = crate::diagnostic_log::append_diagnostic_log(
            "vlm_configuration_incomplete",
            json!({
                "relayId": relay.id,
                "requestModel": model,
                "hasApiKey": !config.api_key.is_empty(),
                "hasModel": !config.model.is_empty(),
                "hasBaseUrl": !config.base_url.is_empty()
            }),
        );
        return;
    }

    for key in ["input", "messages"] {
        let Some(messages) = request.get_mut(key).and_then(Value::as_array_mut) else {
            continue;
        };
        match mode {
            ImageHandling::SendAsIs => {}
            ImageHandling::Strip => strip_images_only(messages),
            ImageHandling::Vlm => {
                process_messages_with_vlm(
                    messages,
                    &config,
                    &relay.model_windows,
                    &relay.context_window,
                    &model,
                )
                .await;
            }
        }
    }
}

pub fn strip_images_only(messages: &mut [Value]) {
    for message in messages {
        let Some(content) = message.get_mut("content") else {
            continue;
        };
        let Some(parts) = content.as_array() else {
            continue;
        };
        *content = Value::Array(
            parts
                .iter()
                .map(|part| {
                    if is_image_part(part) {
                        json!({"type": "text", "text": "[图片已省略]"})
                    } else {
                        part.clone()
                    }
                })
                .collect(),
        );
    }
}

async fn process_messages_with_vlm(
    messages: &mut [Value],
    config: &VlmConfig,
    model_windows_json: &str,
    context_window_str: &str,
    request_model: &str,
) {
    let image_messages = collect_recent_image_messages(messages, ANALYZE_DEPTH_LIMIT);
    if image_messages.is_empty() {
        return;
    }

    let context_window =
        resolve_context_window(model_windows_json, context_window_str, request_model);
    let effective_window = (context_window as f64 * CONTEXT_SAFETY_MARGIN) as u64;
    let text_only_tokens = {
        let mut stripped = messages.to_vec();
        strip_all_images(&mut stripped);
        estimate_tokens(&stripped)
    };
    let available_tokens = effective_window.saturating_sub(text_only_tokens as u64);
    if available_tokens <= 1 {
        let image_count = image_messages
            .iter()
            .map(|(_, urls)| urls.len())
            .sum::<usize>();
        strip_images_only(messages);
        let _ = crate::diagnostic_log::append_diagnostic_log(
            "vlm_context_overflow",
            json!({
                "contextWindow": context_window,
                "textOnlyEstimatedTokens": text_only_tokens,
                "skippedImages": image_count
            }),
        );
        return;
    }

    let current_message_index = messages.iter().rposition(is_user_message);
    let golden_cutoff = messages
        .iter()
        .enumerate()
        .filter(|(_, message)| is_user_message(message))
        .map(|(index, _)| index)
        .rev()
        .take(GOLDEN_WINDOW_DEPTH)
        .last()
        .unwrap_or(0);
    let history_budget = (available_tokens / AVG_DESCRIPTION_TOKENS) as usize;
    let mut descriptions = BTreeMap::<usize, String>::new();
    let mut failed_current_messages = HashSet::<usize>::new();
    let mut selected = Vec::<(usize, String)>::new();
    let mut selected_urls = HashSet::<String>::new();
    let mut history_count = 0usize;

    for (message_index, urls) in &image_messages {
        let current = Some(*message_index) == current_message_index;
        let golden = *message_index >= golden_cutoff;
        for url in urls {
            if let Some(cached) = cache_get(&url_hash(url)) {
                if current || (history_count < history_budget && golden) {
                    append_description(&mut descriptions, *message_index, &cached);
                    if !current {
                        history_count += 1;
                    }
                }
                continue;
            }
            if current || (history_count < history_budget && golden) {
                if selected_urls.insert(url.clone()) {
                    selected.push((*message_index, url.clone()));
                }
                if !current {
                    history_count += 1;
                }
            }
        }
    }

    if !selected.is_empty() {
        let urls = selected
            .iter()
            .map(|(_, url)| url.clone())
            .collect::<Vec<_>>();
        match analyze_urls(&urls, config).await {
            Ok(results) => {
                for ((message_index, url), result) in selected.iter().zip(results) {
                    match result {
                        Some(description) => {
                            cache_insert(url_hash(url), description.clone());
                            append_description(&mut descriptions, *message_index, &description);
                        }
                        None if Some(*message_index) == current_message_index => {
                            failed_current_messages.insert(*message_index);
                        }
                        None => {}
                    }
                }
            }
            Err(error) => {
                let current_had_uncached_images = selected
                    .iter()
                    .any(|(index, _)| Some(*index) == current_message_index);
                let _ = crate::diagnostic_log::append_diagnostic_log(
                    "vlm_sync_analysis_failed",
                    json!({
                        "requestModel": request_model,
                        "currentRoundFailClosed": current_had_uncached_images,
                        "error": error
                    }),
                );
                if current_had_uncached_images {
                    return;
                }
            }
        }
    }

    let max_description_chars = available_tokens.saturating_mul(2) as usize;
    trim_descriptions_to_budget(&mut descriptions, max_description_chars);
    strip_all_images(messages);
    for (message_index, description) in descriptions {
        if let Some(message) = messages.get_mut(message_index) {
            inject_text(message, &description);
        }
    }
    for message_index in failed_current_messages {
        if let Some(message) = messages.get_mut(message_index) {
            inject_text(message, PARTIAL_IMAGE_FAILURE_NOTICE);
        }
    }

    let sync_urls = selected_urls;
    let background_urls = image_messages
        .into_iter()
        .filter(|(index, _)| *index < golden_cutoff && Some(*index) != current_message_index)
        .flat_map(|(_, urls)| urls)
        .filter(|url| !sync_urls.contains(url) && cache_get(&url_hash(url)).is_none())
        .take(history_budget.saturating_sub(history_count))
        .collect::<Vec<_>>();
    if !background_urls.is_empty() {
        let config = config.clone();
        tokio::spawn(async move {
            if let Ok(results) = analyze_urls(&background_urls, &config).await {
                for (url, result) in background_urls.iter().zip(results) {
                    if let Some(description) = result {
                        cache_insert(url_hash(url), description);
                    }
                }
            }
        });
    }
}

async fn analyze_urls(urls: &[String], config: &VlmConfig) -> Result<Vec<Option<String>>, String> {
    if urls.is_empty() {
        return Ok(Vec::new());
    }
    let batches = urls
        .chunks(BATCH_SIZE)
        .map(<[String]>::to_vec)
        .collect::<Vec<_>>();
    let outcomes = std::sync::Arc::new(Mutex::new(vec![None; batches.len()]));
    let local = std::sync::Arc::new(tokio::sync::Semaphore::new(PER_REQUEST_CONCURRENCY));

    let work = {
        let outcomes = outcomes.clone();
        async move {
            let mut tasks = tokio::task::JoinSet::new();
            for (index, batch) in batches.into_iter().enumerate() {
                let config = config.clone();
                let outcomes = outcomes.clone();
                let local = local.clone();
                tasks.spawn(async move {
                    let _local_permit = local.acquire_owned().await;
                    let _global_permit = VLM_SEMAPHORE.acquire().await;
                    let result = call_vlm_batch_with_retry(&batch, &config).await;
                    outcomes.lock().unwrap()[index] = Some((batch.len(), result));
                });
            }
            while tasks.join_next().await.is_some() {}
        }
    };

    tokio::select! {
        _ = work => {}
        _ = tokio::time::sleep(ANALYZE_ALL_TIMEOUT) => {}
    }

    let outcomes = std::mem::take(&mut *outcomes.lock().unwrap());
    let mut results = Vec::with_capacity(urls.len());
    let mut success_count = 0usize;
    for outcome in outcomes {
        match outcome {
            Some((batch_len, Ok(description))) => {
                success_count += batch_len;
                results.extend((0..batch_len).map(|_| Some(description.clone())));
            }
            Some((batch_len, Err(_))) => results.extend((0..batch_len).map(|_| None)),
            None => {}
        }
    }
    results.resize(urls.len(), None);
    if success_count == 0 {
        Err("all VLM calls failed; original images were preserved".to_string())
    } else {
        Ok(results)
    }
}

async fn call_vlm_batch_with_retry(urls: &[String], config: &VlmConfig) -> Result<String, String> {
    let mut last_error = String::new();
    for attempt in 0..=MAX_RETRIES {
        match call_vlm_batch(urls, config).await {
            Ok(result) => return Ok(result),
            Err(error) => {
                last_error = error;
                if attempt == MAX_RETRIES || !is_retryable(&last_error) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(500 * 2_u64.pow(attempt))).await;
            }
        }
    }
    Err(last_error)
}

async fn call_vlm_batch(urls: &[String], config: &VlmConfig) -> Result<String, String> {
    let client = crate::http_client::vlm_http_client_with_timeout(
        Duration::from_secs(5),
        VLM_REQUEST_TIMEOUT,
    )
    .map_err(|error| format!("client: {error}"))?;
    let mut content = urls
        .iter()
        .map(|url| json!({"type": "image_url", "image_url": {"url": url}}))
        .collect::<Vec<_>>();
    content.push(json!({
        "type": "text",
        "text": "请描述图片内容。如包含文字，请精确提取图片中的文字。"
    }));
    let response = client
        .post(format!("{}/chat/completions", config.base_url))
        .bearer_auth(&config.api_key)
        .json(&json!({
            "model": config.model,
            "messages": [{"role": "user", "content": content}],
            "stream": false
        }))
        .send()
        .await
        .map_err(|error| format!("request failed: {error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "VLM API {status}: {}",
            body.chars().take(256).collect::<String>()
        ));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("parse failed: {error}"))?;
    payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "VLM response did not contain message content".to_string())
}

fn is_retryable(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("timeout")
        || error.contains("request failed")
        || ["429", "502", "503", "504"]
            .iter()
            .any(|status| error.contains(status))
}

fn collect_recent_image_messages(
    messages: &[Value],
    depth_limit: usize,
) -> Vec<(usize, Vec<String>)> {
    messages
        .iter()
        .enumerate()
        .filter(|(_, message)| is_user_message(message))
        .map(|(index, message)| (index, collect_urls(message)))
        .rev()
        .take(depth_limit)
        .filter(|(_, urls)| !urls.is_empty())
        .collect()
}

fn collect_urls(message: &Value) -> Vec<String> {
    message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|part| is_image_part(part))
        .filter_map(|part| {
            part.pointer("/image_url/url")
                .or_else(|| part.get("image_url"))
                .and_then(Value::as_str)
                .filter(|url| !url.is_empty())
                .map(str::to_string)
        })
        .collect()
}

fn is_image_part(part: &Value) -> bool {
    matches!(
        part.get("type").and_then(Value::as_str),
        Some("input_image" | "image_url")
    )
}

fn is_user_message(message: &Value) -> bool {
    message.get("role").and_then(Value::as_str) == Some("user")
}

fn strip_all_images(messages: &mut [Value]) {
    for message in messages {
        if let Some(parts) = message.get_mut("content").and_then(Value::as_array_mut) {
            parts.retain(|part| !is_image_part(part));
        }
    }
}

fn inject_text(message: &mut Value, text: &str) {
    match message.get_mut("content") {
        Some(Value::Array(parts)) => parts.push(json!({"type": "text", "text": text})),
        Some(Value::String(existing)) => {
            let existing = existing.clone();
            message["content"] = json!([
                {"type": "text", "text": existing},
                {"type": "text", "text": text}
            ]);
        }
        _ => {}
    }
}

fn append_description(descriptions: &mut BTreeMap<usize, String>, index: usize, text: &str) {
    descriptions
        .entry(index)
        .or_default()
        .push_str(&format!("\n[图片描述] {text}"));
}

fn trim_descriptions_to_budget(descriptions: &mut BTreeMap<usize, String>, max_chars: usize) {
    let mut remaining = max_chars;
    for description in descriptions.values_mut().rev() {
        if remaining == 0 {
            description.clear();
            continue;
        }
        let count = description.chars().count();
        if count > remaining {
            *description =
                description.chars().take(remaining).collect::<String>() + "\n[历史图片描述已省略]";
            remaining = 0;
        } else {
            remaining -= count;
        }
    }
    descriptions.retain(|_, description| !description.is_empty());
}

fn resolve_context_window(
    model_windows_json: &str,
    context_window_str: &str,
    request_model: &str,
) -> u64 {
    let model_name = request_model.rsplit('/').next().unwrap_or(request_model);
    if let Ok(map) = serde_json::from_str::<HashMap<String, String>>(model_windows_json)
        && let Some(window) = map
            .get(model_name)
            .and_then(|value| crate::model_suffix::parse_window_token(value))
    {
        return window;
    }
    context_window_str
        .parse::<u64>()
        .ok()
        .filter(|window| *window > 0)
        .unwrap_or(272_000)
}

fn estimate_tokens(messages: &[Value]) -> usize {
    serde_json::to_string(messages).unwrap_or_default().len() / 2
}

fn url_hash(url: &str) -> String {
    let hash = Sha256::digest(url.as_bytes());
    hash[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn cache_get(key: &str) -> Option<String> {
    let mut cache = VLM_CACHE.lock().unwrap();
    let entry = cache.get(key)?;
    if entry.1.elapsed() > CACHE_TTL {
        cache.remove(key);
        None
    } else {
        Some(entry.0.clone())
    }
}

fn cache_insert(key: String, value: String) {
    let mut cache = VLM_CACHE.lock().unwrap();
    if cache.len() >= MAX_CACHE_CAPACITY {
        cache.retain(|_, (_, created)| created.elapsed() <= CACHE_TTL);
        if cache.len() >= MAX_CACHE_CAPACITY {
            let mut keys = cache
                .iter()
                .map(|(key, (_, created))| (key.clone(), *created))
                .collect::<Vec<_>>();
            keys.sort_by_key(|(_, created)| *created);
            for (key, _) in keys.into_iter().take(MAX_CACHE_CAPACITY / 4) {
                cache.remove(&key);
            }
        }
    }
    cache.insert(key, (value, Instant::now()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_modes_default_and_parse() {
        assert_eq!(image_handling_mode("a", ""), ImageHandling::SendAsIs);
        assert_eq!(
            image_handling_mode("a", r#"{"a":"strip"}"#),
            ImageHandling::Strip
        );
        assert_eq!(
            image_handling_mode("a", r#"{"a":"vlm"}"#),
            ImageHandling::Vlm
        );
    }

    #[test]
    fn strip_replaces_responses_and_chat_images() {
        let mut messages = vec![json!({
            "role": "user",
            "content": [
                {"type": "input_text", "text": "hello"},
                {"type": "input_image", "image_url": "data:image/png;base64,abc"},
                {"type": "image_url", "image_url": {"url": "https://example.test/a.png"}}
            ]
        })];
        strip_images_only(&mut messages);
        assert_eq!(messages[0]["content"][1]["text"], json!("[图片已省略]"));
        assert_eq!(messages[0]["content"][2]["text"], json!("[图片已省略]"));
    }

    #[tokio::test]
    async fn request_strip_uses_rewritten_model_policy() {
        let relay = crate::settings::RelayProfile {
            model_vlm: r#"{"upstream-model":"strip"}"#.to_string(),
            ..crate::settings::RelayProfile::default()
        };
        let mut request = json!({
            "model": "upstream-model",
            "input": [{
                "role": "user",
                "content": [{"type": "input_image", "image_url": "https://example.test/a.png"}]
            }]
        });
        process_request_images(&mut request, &relay).await;
        assert_eq!(request["input"][0]["content"][0]["text"], "[图片已省略]");
    }

    #[tokio::test]
    async fn direct_chat_messages_use_the_same_image_policy() {
        let relay = crate::settings::RelayProfile {
            model_vlm: r#"{"chat-model":"strip"}"#.to_string(),
            ..crate::settings::RelayProfile::default()
        };
        let mut request = json!({
            "model": "chat-model",
            "messages": [{
                "role": "user",
                "content": [{"type": "image_url", "image_url": {"url": "https://example.test/a.png"}}]
            }]
        });
        process_request_images(&mut request, &relay).await;
        assert_eq!(request["messages"][0]["content"][0]["text"], "[图片已省略]");
    }

    #[test]
    fn partial_vlm_failure_notice_survives_image_removal() {
        let mut messages = vec![json!({
            "role": "user",
            "content": [
                {"type": "input_text", "text": "describe both"},
                {"type": "input_image", "image_url": "https://example.test/a.png"},
                {"type": "input_image", "image_url": "https://example.test/b.png"}
            ]
        })];
        let mut descriptions = BTreeMap::new();
        append_description(&mut descriptions, 0, "first image");
        let failed_current_messages = HashSet::from([0usize]);

        strip_all_images(&mut messages);
        for (message_index, description) in descriptions {
            inject_text(&mut messages[message_index], &description);
        }
        for message_index in failed_current_messages {
            inject_text(&mut messages[message_index], PARTIAL_IMAGE_FAILURE_NOTICE);
        }

        let content = messages[0]["content"].as_array().unwrap();
        assert!(!content.iter().any(is_image_part));
        assert!(
            content
                .iter()
                .any(|part| part["text"] == PARTIAL_IMAGE_FAILURE_NOTICE)
        );
    }
}
