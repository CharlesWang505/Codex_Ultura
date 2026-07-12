use anyhow::Context;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;

use crate::user_scripts::UserScriptManager;

pub const DEFAULT_MARKET_INDEX_URL: &str =
    "https://raw.githubusercontent.com/BigPizzaV3/CodexPlusPlusScriptMarket/main/index.json";
pub const MAX_MARKET_MANIFEST_BYTES: usize = 1024 * 1024;
pub const MAX_MARKET_SCRIPT_BYTES: usize = 2 * 1024 * 1024;
const ALLOWED_MARKET_HOSTS: &[&str] = &["raw.githubusercontent.com", "gist.githubusercontent.com"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScriptMarketManifest {
    pub version: u64,
    pub updated_at: Option<String>,
    pub scripts: Vec<MarketScript>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarketScript {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub version: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub homepage: String,
    pub script_url: String,
    #[serde(default)]
    pub sha256: String,
}

pub fn parse_market_manifest(raw: Value) -> anyhow::Result<ScriptMarketManifest> {
    let version = raw.get("version").and_then(Value::as_u64).unwrap_or(1);
    let updated_at = raw
        .get("updated_at")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let scripts = raw
        .get("scripts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(parse_market_script)
        .collect();

    Ok(ScriptMarketManifest {
        version,
        updated_at,
        scripts,
    })
}

pub async fn fetch_market_manifest(url: &str) -> anyhow::Result<ScriptMarketManifest> {
    let url = validate_market_url(url, "script market index")?;
    let response =
        crate::http_client::proxied_client(&format!("Codex-Compass/{}", crate::version::VERSION))?
            .get(url)
            .send()
            .await
            .with_context(|| "failed to request script market index".to_string())?
            .error_for_status()
            .context("script market index returned an error status")?;
    validate_market_url(response.url().as_str(), "script market redirect")?;
    reject_oversized_content_length(&response, MAX_MARKET_MANIFEST_BYTES, "market manifest")?;
    let bytes = response
        .bytes()
        .await
        .context("failed to read script market index")?;
    ensure_size(&bytes, MAX_MARKET_MANIFEST_BYTES, "market manifest")?;
    let raw = serde_json::from_slice::<Value>(&bytes)
        .context("failed to decode script market index JSON")?;
    parse_market_manifest(raw)
}

pub async fn download_script(url: &str) -> anyhow::Result<Vec<u8>> {
    let url = validate_market_url(url, "market script")?;
    let response =
        crate::http_client::proxied_client(&format!("Codex-Compass/{}", crate::version::VERSION))?
            .get(url)
            .send()
            .await
            .context("failed to request market script")?
            .error_for_status()
            .context("script download returned an error status")?;
    validate_market_url(response.url().as_str(), "market script redirect")?;
    reject_oversized_content_length(&response, MAX_MARKET_SCRIPT_BYTES, "market script")?;
    let bytes = response
        .bytes()
        .await
        .context("failed to read script download body")?;
    ensure_size(&bytes, MAX_MARKET_SCRIPT_BYTES, "market script")?;
    std::str::from_utf8(&bytes).context("market script must be valid UTF-8")?;
    Ok(bytes.to_vec())
}

pub fn install_market_script_content(
    manager: &UserScriptManager,
    script: &MarketScript,
    content: &[u8],
) -> anyhow::Result<()> {
    validate_market_script_content(script, content)?;
    manager.install_market_script_transaction(script, content)?;
    Ok(())
}

pub async fn install_market_script(
    manager: &UserScriptManager,
    script: &MarketScript,
) -> anyhow::Result<()> {
    let content = download_script(&script.script_url).await?;
    install_market_script_content(manager, script, &content)
}

fn parse_market_script(raw: Value) -> Option<MarketScript> {
    let id = required_string(&raw, "id")?;
    let name = required_string(&raw, "name")?;
    let version = required_string(&raw, "version")?;
    let script_url = required_string(&raw, "script_url")?;
    validate_market_url(&script_url, "market script").ok()?;
    let sha256 = required_string(&raw, "sha256")?.to_ascii_lowercase();
    if !is_sha256_hex(&sha256) {
        return None;
    }
    Some(MarketScript {
        id,
        name,
        description: optional_string(&raw, "description"),
        version,
        author: optional_string(&raw, "author"),
        tags: raw
            .get("tags")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToOwned::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        homepage: optional_string(&raw, "homepage"),
        script_url,
        sha256,
    })
}

pub fn validate_market_script_content(script: &MarketScript, content: &[u8]) -> anyhow::Result<()> {
    validate_market_url(&script.script_url, "market script")?;
    ensure_size(content, MAX_MARKET_SCRIPT_BYTES, "market script")?;
    std::str::from_utf8(content).context("market script must be valid UTF-8")?;
    let expected = script.sha256.trim().to_ascii_lowercase();
    if !is_sha256_hex(&expected) {
        anyhow::bail!("market script sha256 must contain 64 hexadecimal characters");
    }
    let actual = sha256_hex(content);
    if actual != expected {
        anyhow::bail!("market script sha256 mismatch");
    }
    Ok(())
}

pub fn sha256_hex(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}

fn validate_market_url(value: &str, label: &str) -> anyhow::Result<Url> {
    let url = Url::parse(value).with_context(|| format!("invalid {label} URL"))?;
    if url.scheme() != "https" {
        anyhow::bail!("{label} URL must use HTTPS");
    }
    if !url.username().is_empty() || url.password().is_some() {
        anyhow::bail!("{label} URL must not contain credentials");
    }
    if url.port_or_known_default() != Some(443) {
        anyhow::bail!("{label} URL must use the standard HTTPS port");
    }
    let host = url
        .host_str()
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| anyhow::anyhow!("{label} URL is missing a host"))?;
    if !ALLOWED_MARKET_HOSTS.contains(&host.as_str()) {
        anyhow::bail!("{label} host is not allowed: {host}");
    }
    Ok(url)
}

fn reject_oversized_content_length(
    response: &reqwest::Response,
    maximum: usize,
    label: &str,
) -> anyhow::Result<()> {
    if response
        .content_length()
        .is_some_and(|length| length > maximum as u64)
    {
        anyhow::bail!("{label} exceeds the maximum size of {maximum} bytes");
    }
    Ok(())
}

fn ensure_size(content: &[u8], maximum: usize, label: &str) -> anyhow::Result<()> {
    if content.len() > maximum {
        anyhow::bail!("{label} exceeds the maximum size of {maximum} bytes");
    }
    Ok(())
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn market_urls_require_https_and_an_allowed_host() {
        assert!(validate_market_url(DEFAULT_MARKET_INDEX_URL, "index").is_ok());
        assert!(validate_market_url("http://raw.githubusercontent.com/a/b.js", "script").is_err());
        assert!(validate_market_url("https://example.com/a.js", "script").is_err());
        assert!(
            validate_market_url("https://user@raw.githubusercontent.com/a/b.js", "script").is_err()
        );
    }

    #[test]
    fn script_content_requires_utf8_size_and_matching_checksum() {
        let content = b"window.demo = true;";
        let script = MarketScript {
            id: "demo".to_string(),
            name: "Demo".to_string(),
            description: String::new(),
            version: "1".to_string(),
            author: String::new(),
            tags: Vec::new(),
            homepage: String::new(),
            script_url: "https://raw.githubusercontent.com/example/repo/main/demo.js".to_string(),
            sha256: sha256_hex(content),
        };
        assert!(validate_market_script_content(&script, content).is_ok());

        let mut mismatch = script.clone();
        mismatch.sha256 = "0".repeat(64);
        assert!(validate_market_script_content(&mismatch, content).is_err());
        assert!(validate_market_script_content(&script, &[0xff, 0xfe]).is_err());
        assert!(
            validate_market_script_content(&script, &vec![b'a'; MAX_MARKET_SCRIPT_BYTES + 1])
                .is_err()
        );
    }
}

fn required_string(raw: &Value, key: &str) -> Option<String> {
    raw.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn optional_string(raw: &Value, key: &str) -> String {
    raw.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}
