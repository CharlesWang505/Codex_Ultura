use std::collections::HashSet;
use std::path::Path;

use anyhow::{Context, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use crate::theme_studio::{
    ThemeDefinition, ThemePresentation, ThemeShowcase, ThemeShowcaseCard, ThemeStudioManager,
    ThemeStudioSettings, ThemeVisual,
};

pub const DEFAULT_MARKET_INDEX_URL: &str =
    "https://raw.githubusercontent.com/BigPizzaV3/CodexPlusPlus-Themes/main/index.json";
pub const DEFAULT_MARKET_RAW_BASE_URL: &str =
    "https://raw.githubusercontent.com/BigPizzaV3/CodexPlusPlus-Themes/main/";
pub const DEFAULT_MARKET_REPOSITORY_URL: &str =
    "https://github.com/BigPizzaV3/CodexPlusPlus-Themes";

const MARKET_CACHE_FILE: &str = "market/index.json";
const MARKET_INDEX_LIMIT: usize = 1024 * 1024;
const MARKET_THEME_LIMIT: usize = 256 * 1024;
const MARKET_IMAGE_LIMIT: usize = 8 * 1024 * 1024;
const MARKET_THEME_COUNT_LIMIT: usize = 200;
const ALLOWED_DOWNLOAD_HOST: &str = "raw.githubusercontent.com";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeMarketManifest {
    pub schema_version: u8,
    #[serde(default, alias = "updated_at")]
    pub updated_at: String,
    pub themes: Vec<ThemeMarketTheme>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeMarketTheme {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    #[serde(default)]
    pub description: String,
    pub license: String,
    #[serde(alias = "source_url")]
    pub source_url: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub theme: String,
    pub image: String,
    pub preview: String,
    #[serde(alias = "theme_sha256")]
    pub theme_sha256: String,
    #[serde(alias = "image_sha256")]
    pub image_sha256: String,
    #[serde(skip)]
    pub preview_url: String,
    #[serde(skip)]
    pub installed: bool,
    #[serde(skip)]
    pub installed_version: String,
    #[serde(skip)]
    pub update_available: bool,
}

#[derive(Debug, Clone)]
pub struct ThemeMarketLoad {
    pub manifest: ThemeMarketManifest,
    pub cached: bool,
    pub warning: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketThemeConfig {
    #[serde(default)]
    schema_version: u8,
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    style_preset: String,
    #[serde(default)]
    brand_subtitle: String,
    #[serde(default)]
    tagline: String,
    #[serde(default)]
    status_text: String,
    #[serde(default)]
    quote: String,
    #[serde(default)]
    colors: Option<MarketThemeColors>,
    #[serde(default)]
    art: MarketThemeArt,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketThemeColors {
    #[serde(default)]
    background: String,
    #[serde(default)]
    panel: String,
    #[serde(default)]
    panel_alt: String,
    #[serde(default)]
    accent: String,
    #[serde(default)]
    accent_alt: String,
    #[serde(default)]
    secondary: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    muted: String,
    #[serde(default)]
    line: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketThemeArt {
    #[serde(default)]
    safe_area: String,
    #[serde(default)]
    task_mode: String,
}

pub async fn load_market(manager: &ThemeStudioManager) -> anyhow::Result<ThemeMarketLoad> {
    match fetch_market_manifest(DEFAULT_MARKET_INDEX_URL).await {
        Ok(manifest) => {
            cache_manifest(manager.state_root(), &manifest)?;
            Ok(ThemeMarketLoad {
                manifest: enrich_market_manifest(manager, manifest),
                cached: false,
                warning: None,
            })
        }
        Err(network_error) => {
            let cached = read_cached_manifest(manager.state_root())
                .with_context(|| format!("主题市场加载失败，且没有可用缓存：{network_error}"))?;
            Ok(ThemeMarketLoad {
                manifest: enrich_market_manifest(manager, cached),
                cached: true,
                warning: Some(format!(
                    "远程市场暂不可用，当前显示本地缓存：{network_error}"
                )),
            })
        }
    }
}

pub async fn fetch_market_manifest(url: &str) -> anyhow::Result<ThemeMarketManifest> {
    let bytes = download_limited(url, MARKET_INDEX_LIMIT, "主题市场清单").await?;
    let mut manifest: ThemeMarketManifest =
        serde_json::from_slice(&bytes).context("主题市场清单不是有效 JSON")?;
    validate_manifest(&mut manifest)?;
    Ok(manifest)
}

pub async fn install_market_theme(
    manager: &ThemeStudioManager,
    theme: &ThemeMarketTheme,
) -> anyhow::Result<ThemeStudioSettings> {
    install_market_theme_from_base(manager, theme, DEFAULT_MARKET_RAW_BASE_URL).await
}

async fn install_market_theme_from_base(
    manager: &ThemeStudioManager,
    theme: &ThemeMarketTheme,
    raw_base_url: &str,
) -> anyhow::Result<ThemeStudioSettings> {
    validate_market_theme(theme)?;
    let theme_url = market_asset_url(raw_base_url, &theme.theme)?;
    let image_url = market_asset_url(raw_base_url, &theme.image)?;

    let theme_bytes = download_limited(&theme_url, MARKET_THEME_LIMIT, "主题配置").await?;
    verify_sha256(&theme_bytes, &theme.theme_sha256, "主题配置")?;
    let config: MarketThemeConfig =
        serde_json::from_slice(&theme_bytes).context("市场主题配置不是有效 JSON")?;
    if config.schema_version > 1 {
        bail!("市场主题配置版本高于当前支持版本");
    }
    if config.id != theme.id || config.name != theme.name {
        bail!("市场主题配置与清单身份不一致");
    }

    let image_bytes = download_limited(&image_url, MARKET_IMAGE_LIMIT, "主题图片").await?;
    verify_sha256(&image_bytes, &theme.image_sha256, "主题图片")?;
    let mime = detect_image_mime(&image_bytes).context("市场主题图片格式无效或不受支持")?;
    let image_data_url = format!("data:{mime};base64,{}", STANDARD.encode(image_bytes));
    manager.install_theme(market_theme_definition(theme, config, image_data_url))
}

pub fn enrich_market_manifest(
    manager: &ThemeStudioManager,
    mut manifest: ThemeMarketManifest,
) -> ThemeMarketManifest {
    let settings = manager.load();
    for theme in &mut manifest.themes {
        theme.preview_url =
            market_asset_url(DEFAULT_MARKET_RAW_BASE_URL, &theme.preview).unwrap_or_default();
        let installed = settings
            .themes
            .iter()
            .find(|installed| !installed.builtin && installed.id == theme.id);
        theme.installed = installed.is_some();
        theme.installed_version = installed
            .map(|installed| installed.version.clone())
            .unwrap_or_default();
        theme.update_available = theme.installed
            && !theme.installed_version.is_empty()
            && theme.installed_version != theme.version;
    }
    manifest
}

fn market_theme_definition(
    theme: &ThemeMarketTheme,
    config: MarketThemeConfig,
    image_data_url: String,
) -> ThemeDefinition {
    let colors = config.colors.unwrap_or_default();
    let classification =
        format!("{} {}", config.style_preset, theme.tags.join(" ")).to_ascii_lowercase();
    let (layout_style, card_style, motif_style) = classify_theme(&classification);
    let task_mode = match config.art.task_mode.as_str() {
        "banner" | "off" => config.art.task_mode,
        _ => "ambient".to_string(),
    };
    let hero_position = match config.art.safe_area.as_str() {
        "left" => "far-right",
        "right" => "center",
        _ => "right",
    };
    let title = if config.tagline.trim().is_empty() {
        theme.name.as_str()
    } else {
        config.tagline.as_str()
    };

    ThemeDefinition {
        id: theme.id.clone(),
        name: truncate_text(&theme.name, 80),
        description: truncate_text(&theme.description, 240),
        author: truncate_text(&theme.author, 80),
        version: truncate_text(&theme.version, 32),
        license: truncate_text(&theme.license, 80),
        builtin: false,
        decorative_style: "none".to_string(),
        wallpaper_data_url: image_data_url.clone(),
        showcase: ThemeShowcase {
            enabled: true,
            eyebrow: truncate_text(&config.brand_subtitle, 80),
            title: truncate_text(title, 80),
            subtitle: truncate_text(&config.quote, 180),
            hero_image_data_url: image_data_url,
            portrait_image_data_url: String::new(),
            show_cards: true,
            cards: market_showcase_cards(),
        },
        presentation: ThemePresentation {
            layout_style: layout_style.to_string(),
            card_style: card_style.to_string(),
            motif_style: motif_style.to_string(),
            header_badge: truncate_text(&config.status_text, 48),
            hero_position: hero_position.to_string(),
            overlay_strength: 82,
            task_wallpaper_opacity: 8,
            task_mode,
        },
        visual: ThemeVisual {
            accent: market_color(&colors.accent, "#e25563"),
            accent_soft: market_color_fallback(&colors.secondary, &colors.accent_alt, "#f3a8af"),
            background: market_color(&colors.background, "#f7f4f5"),
            surface: market_color(&colors.panel, "#ffffff"),
            surface_alt: market_color(&colors.panel_alt, "#fff7f8"),
            text: market_color(&colors.text, "#2b2224"),
            text_muted: market_color(&colors.muted, "#8a7a7d"),
            border: market_color(&colors.line, "#d8c5ca"),
            sidebar_opacity: 92,
            content_opacity: 94,
            wallpaper_opacity: 72,
            blur_px: 12,
            radius_px: 8,
            font_scale: 100,
            font_family: if classification.contains("mono") {
                "mono".to_string()
            } else if classification.contains("paper")
                || classification.contains("serif")
                || classification.contains("fortune")
            {
                "serif".to_string()
            } else {
                "system".to_string()
            },
            wallpaper_fit: "cover".to_string(),
        },
    }
}

fn classify_theme(value: &str) -> (&'static str, &'static str, &'static str) {
    if value.contains("fortune") || value.contains("caishen") {
        ("fortune", "paper", "coins")
    } else if value.contains("future") || value.contains("cyber") {
        ("future", "solid", "orbit")
    } else if value.contains("doodle") {
        ("doodle", "outline", "doodles")
    } else if value.contains("cosmic") || value.contains("night") {
        ("cosmic", "glass", "stars")
    } else if value.contains("idol") {
        ("idol", "glass", "stars")
    } else if value.contains("stage") {
        ("stage", "solid", "jasmine")
    } else if value.contains("paper") || value.contains("serif") {
        ("paper", "paper", "leaves")
    } else {
        ("editorial", "glass", "roses")
    }
}

fn market_showcase_cards() -> Vec<ThemeShowcaseCard> {
    vec![
        ThemeShowcaseCard {
            title: "开始编码".to_string(),
            prompt: "分析当前项目并开始实现最重要的待办事项。".to_string(),
            icon: "code".to_string(),
        },
        ThemeShowcaseCard {
            title: "构建功能".to_string(),
            prompt: "根据当前需求实现功能，并补充必要的验证。".to_string(),
            icon: "build".to_string(),
        },
        ThemeShowcaseCard {
            title: "审查代码".to_string(),
            prompt: "审查当前改动，优先发现行为回归、风险和缺失测试。".to_string(),
            icon: "review".to_string(),
        },
        ThemeShowcaseCard {
            title: "修复问题".to_string(),
            prompt: "定位当前错误的根因，完成修复并验证结果。".to_string(),
            icon: "repair".to_string(),
        },
    ]
}

fn validate_manifest(manifest: &mut ThemeMarketManifest) -> anyhow::Result<()> {
    if manifest.schema_version != 1 {
        bail!("不支持的主题市场清单版本");
    }
    if manifest.themes.len() > MARKET_THEME_COUNT_LIMIT {
        bail!("主题市场清单超过 {MARKET_THEME_COUNT_LIMIT} 项限制");
    }
    let mut ids = HashSet::new();
    for theme in &mut manifest.themes {
        validate_market_theme(theme)?;
        if !ids.insert(theme.id.clone()) {
            bail!("主题市场清单包含重复 ID：{}", theme.id);
        }
        theme.preview_url = market_asset_url(DEFAULT_MARKET_RAW_BASE_URL, &theme.preview)?;
    }
    Ok(())
}

fn validate_market_theme(theme: &ThemeMarketTheme) -> anyhow::Result<()> {
    if !valid_theme_id(&theme.id) {
        bail!("主题市场包含无效 ID：{}", theme.id);
    }
    for (label, value, limit) in [
        ("名称", theme.name.as_str(), 80usize),
        ("版本", theme.version.as_str(), 32usize),
        ("作者", theme.author.as_str(), 80usize),
        ("许可证", theme.license.as_str(), 80usize),
    ] {
        if value.trim().is_empty() || value.chars().count() > limit {
            bail!("市场主题 {} 的{}无效", theme.id, label);
        }
    }
    if theme.description.chars().count() > 500 || theme.tags.len() > 12 {
        bail!("市场主题 {} 的描述或标签数量超过限制", theme.id);
    }
    if theme
        .tags
        .iter()
        .any(|tag| tag.trim().is_empty() || tag.chars().count() > 32)
    {
        bail!("市场主题 {} 包含无效标签", theme.id);
    }
    let source = Url::parse(&theme.source_url)
        .with_context(|| format!("市场主题 {} 的来源地址无效", theme.id))?;
    if !matches!(source.scheme(), "http" | "https") {
        bail!("市场主题 {} 的来源地址协议无效", theme.id);
    }
    for path in [&theme.theme, &theme.image, &theme.preview] {
        validate_market_path(path)?;
    }
    validate_sha256(&theme.theme_sha256)?;
    validate_sha256(&theme.image_sha256)?;
    Ok(())
}

async fn download_limited(url: &str, limit: usize, label: &str) -> anyhow::Result<Vec<u8>> {
    let parsed = Url::parse(url).with_context(|| format!("{label}地址无效"))?;
    validate_download_url(&parsed)?;
    let response =
        crate::http_client::proxied_client(&format!("Codex-Compass/{}", crate::version::VERSION))?
            .get(parsed)
            .send()
            .await
            .with_context(|| format!("{label}请求失败"))?
            .error_for_status()
            .with_context(|| format!("{label}服务器返回错误状态"))?;
    validate_download_url(response.url())?;
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        bail!("{label}超过 {limit} 字节限制");
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.with_context(|| format!("读取{label}失败"))?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            bail!("{label}超过 {limit} 字节限制");
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        bail!("{label}内容为空");
    }
    Ok(bytes)
}

fn cache_manifest(state_dir: &Path, manifest: &ThemeMarketManifest) -> anyhow::Result<()> {
    crate::settings::atomic_write(
        &state_dir.join(MARKET_CACHE_FILE),
        &serde_json::to_vec_pretty(manifest)?,
    )
}

fn read_cached_manifest(state_dir: &Path) -> anyhow::Result<ThemeMarketManifest> {
    let path = state_dir.join(MARKET_CACHE_FILE);
    let metadata = std::fs::metadata(&path)
        .with_context(|| format!("主题市场缓存不存在：{}", path.display()))?;
    if metadata.len() > MARKET_INDEX_LIMIT as u64 {
        bail!("主题市场缓存超过大小限制");
    }
    let mut manifest: ThemeMarketManifest =
        serde_json::from_slice(&std::fs::read(&path)?).context("主题市场缓存不是有效 JSON")?;
    validate_manifest(&mut manifest)?;
    Ok(manifest)
}

fn market_asset_url(base_url: &str, relative: &str) -> anyhow::Result<String> {
    validate_market_path(relative)?;
    let base = Url::parse(base_url).context("主题市场基础地址无效")?;
    validate_download_url(&base)?;
    let joined = base.join(relative).context("主题市场资源地址无效")?;
    if joined.scheme() != base.scheme() || joined.host_str() != base.host_str() {
        bail!("主题市场资源地址越界");
    }
    Ok(joined.to_string())
}

fn validate_download_url(url: &Url) -> anyhow::Result<()> {
    if url.scheme() != "https"
        || url.host_str() != Some(ALLOWED_DOWNLOAD_HOST)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        bail!("主题市场下载地址必须使用受信任的 HTTPS 主机");
    }
    Ok(())
}

fn validate_market_path(value: &str) -> anyhow::Result<()> {
    if value.is_empty()
        || value.len() > 256
        || value.starts_with('/')
        || value.contains('\\')
        || value.contains(['?', '#', '\0'])
    {
        bail!("无效的主题市场相对路径");
    }
    for segment in value.split('/') {
        if segment.is_empty()
            || matches!(segment, "." | "..")
            || !segment
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            bail!("无效的主题市场相对路径");
        }
    }
    Ok(())
}

fn valid_theme_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        })
}

fn validate_sha256(value: &str) -> anyhow::Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("主题市场包含无效 SHA-256");
    }
    Ok(())
}

fn verify_sha256(bytes: &[u8], expected: &str, label: &str) -> anyhow::Result<()> {
    validate_sha256(expected)?;
    if format!("{:x}", Sha256::digest(bytes)) != expected {
        bail!("{label} SHA-256 校验失败");
    }
    Ok(())
}

fn detect_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn market_color(value: &str, fallback: &str) -> String {
    let value = value.trim().to_ascii_lowercase();
    if matches!(value.len(), 7 | 9)
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        value
    } else {
        fallback.to_string()
    }
}

fn market_color_fallback(value: &str, secondary: &str, fallback: &str) -> String {
    let primary = market_color(value, "");
    if primary.is_empty() {
        market_color(secondary, fallback)
    } else {
        primary
    }
}

fn truncate_text(value: &str, max_chars: usize) -> String {
    value.trim().chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn market_paths_reject_traversal_and_remote_urls() {
        for path in [
            "../theme.json",
            "themes\\x.png",
            "https://example.com/x",
            "/x",
        ] {
            assert!(validate_market_path(path).is_err(), "accepted {path}");
        }
        assert!(validate_market_path("themes/demo/theme.json").is_ok());
    }

    #[test]
    fn image_detection_uses_file_contents() {
        assert_eq!(
            detect_image_mime(b"\x89PNG\r\n\x1a\nrest"),
            Some("image/png")
        );
        assert_eq!(detect_image_mime(b"not-an-image"), None);
    }

    #[test]
    fn market_colors_reject_css_expressions() {
        assert_eq!(market_color("rgba(1, 2, 3, .5)", "#112233"), "#112233");
        assert_eq!(market_color("#AABBCC", "#112233"), "#aabbcc");
    }

    #[test]
    fn manifest_accepts_the_live_snake_case_fields() {
        let mut manifest: ThemeMarketManifest = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "updated_at": "2026-07-18",
            "themes": [{
                "id": "demo-theme",
                "name": "Demo Theme",
                "version": "1.0.0",
                "author": "Demo",
                "description": "Demo",
                "license": "MIT",
                "source_url": "https://github.com/example/demo",
                "tags": ["demo"],
                "theme": "themes/demo/theme.json",
                "image": "themes/demo/image.png",
                "preview": "themes/demo/preview.jpg",
                "theme_sha256": "a".repeat(64),
                "image_sha256": "b".repeat(64)
            }]
        }))
        .unwrap();

        validate_manifest(&mut manifest).unwrap();

        assert_eq!(manifest.updated_at, "2026-07-18");
        assert_eq!(manifest.themes[0].theme_sha256, "a".repeat(64));
        assert!(!manifest.themes[0].preview_url.is_empty());
    }
}
