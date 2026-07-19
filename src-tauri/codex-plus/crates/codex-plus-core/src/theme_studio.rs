use std::collections::HashSet;
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;
use zip::ZipArchive;

const THEME_SCHEMA_VERSION: u32 = 3;
const MAX_CUSTOM_THEME_COUNT: usize = 32;
const MAX_THEME_COUNT: usize = MAX_CUSTOM_THEME_COUNT + 8;
const MAX_PACKAGE_BYTES: usize = 12 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES: u64 = 18 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_PACKAGE_FILES: usize = 24;
const MAX_SHOWCASE_CARDS: usize = 4;
const ROSE_GARDEN_HERO_BYTES: &[u8] =
    include_bytes!("../../../assets/theme-studio/rose-editorial-wallpaper.webp");
const STARLIGHT_STAGE_HERO_BYTES: &[u8] =
    include_bytes!("../../../assets/theme-studio/black-gold-stage-wallpaper.webp");
const ROSE_EDITORIAL_WALLPAPER_BYTES: &[u8] =
    include_bytes!("../../../assets/theme-studio/rose-editorial-wallpaper.webp");
const FORTUNE_WORKBENCH_WALLPAPER_BYTES: &[u8] =
    include_bytes!("../../../assets/theme-studio/fortune-workbench-wallpaper.webp");
const RED_FUTURE_CITY_WALLPAPER_BYTES: &[u8] =
    include_bytes!("../../../assets/theme-studio/red-future-city-wallpaper.webp");
const SAGE_PAPER_WALLPAPER_BYTES: &[u8] =
    include_bytes!("../../../assets/theme-studio/sage-paper-wallpaper.webp");
const ENFP_DOODLE_WALLPAPER_BYTES: &[u8] =
    include_bytes!("../../../assets/theme-studio/enfp-doodle-wallpaper.webp");
const ENFP_DOODLE_WALLPAPER_V2_1_BYTES: &[u8] =
    include_bytes!("../../../assets/theme-studio/enfp-doodle-wallpaper-v2-1.webp");
const BUTTERFLY_COSMOS_WALLPAPER_BYTES: &[u8] =
    include_bytes!("../../../assets/theme-studio/butterfly-cosmos-wallpaper.webp");
const CYAN_VIRTUAL_STAGE_WALLPAPER_BYTES: &[u8] =
    include_bytes!("../../../assets/theme-studio/cyan-virtual-stage-wallpaper.webp");
const BLACK_GOLD_STAGE_WALLPAPER_BYTES: &[u8] =
    include_bytes!("../../../assets/theme-studio/black-gold-stage-wallpaper.webp");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeVisual {
    pub accent: String,
    pub accent_soft: String,
    pub background: String,
    pub surface: String,
    pub surface_alt: String,
    pub text: String,
    pub text_muted: String,
    pub border: String,
    pub sidebar_opacity: u8,
    pub content_opacity: u8,
    pub wallpaper_opacity: u8,
    pub blur_px: u8,
    pub radius_px: u8,
    pub font_scale: u8,
    pub font_family: String,
    pub wallpaper_fit: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeShowcaseCard {
    pub title: String,
    pub prompt: String,
    pub icon: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeShowcase {
    pub enabled: bool,
    pub eyebrow: String,
    pub title: String,
    pub subtitle: String,
    #[serde(default)]
    pub hero_image_data_url: String,
    #[serde(default)]
    pub portrait_image_data_url: String,
    #[serde(default = "default_true")]
    pub show_cards: bool,
    #[serde(default = "default_showcase_cards")]
    pub cards: Vec<ThemeShowcaseCard>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemePresentation {
    #[serde(default = "default_layout_style")]
    pub layout_style: String,
    #[serde(default = "default_card_style")]
    pub card_style: String,
    #[serde(default = "default_motif_style")]
    pub motif_style: String,
    #[serde(default)]
    pub header_badge: String,
    #[serde(default = "default_hero_position")]
    pub hero_position: String,
    #[serde(default = "default_overlay_strength")]
    pub overlay_strength: u8,
    #[serde(default = "default_task_wallpaper_opacity")]
    pub task_wallpaper_opacity: u8,
    #[serde(default = "default_task_mode")]
    pub task_mode: String,
}

impl Default for ThemePresentation {
    fn default() -> Self {
        Self {
            layout_style: default_layout_style(),
            card_style: default_card_style(),
            motif_style: default_motif_style(),
            header_badge: String::new(),
            hero_position: default_hero_position(),
            overlay_strength: default_overlay_strength(),
            task_wallpaper_opacity: default_task_wallpaper_opacity(),
            task_mode: default_task_mode(),
        }
    }
}

impl Default for ThemeShowcase {
    fn default() -> Self {
        Self {
            enabled: false,
            eyebrow: String::new(),
            title: String::new(),
            subtitle: String::new(),
            hero_image_data_url: String::new(),
            portrait_image_data_url: String::new(),
            show_cards: true,
            cards: default_showcase_cards(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeDefinition {
    pub id: String,
    pub name: String,
    pub description: String,
    pub author: String,
    pub version: String,
    pub license: String,
    pub builtin: bool,
    pub decorative_style: String,
    #[serde(default)]
    pub wallpaper_data_url: String,
    #[serde(default)]
    pub showcase: ThemeShowcase,
    #[serde(default)]
    pub presentation: ThemePresentation,
    pub visual: ThemeVisual,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeStudioSettings {
    pub schema_version: u32,
    pub enabled: bool,
    pub selected_theme_id: String,
    pub themes: Vec<ThemeDefinition>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeStudioPayload {
    pub settings: ThemeStudioSettings,
    pub settings_path: String,
    pub package_format: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeTitleBarTextColor {
    Default,
    Black,
    White,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThemePackageManifest {
    #[serde(default)]
    schema_version: u32,
    id: String,
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    license: String,
    #[serde(default)]
    decorative_style: String,
    #[serde(default)]
    wallpaper: String,
    #[serde(default)]
    showcase: ThemePackageShowcaseManifest,
    #[serde(default)]
    presentation: ThemePresentation,
    visual: ThemeVisual,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThemePackageShowcaseManifest {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    eyebrow: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    subtitle: String,
    #[serde(default)]
    hero_image: String,
    #[serde(default)]
    portrait_image: String,
    #[serde(default = "default_true")]
    show_cards: bool,
    #[serde(default = "default_showcase_cards")]
    cards: Vec<ThemeShowcaseCard>,
}

impl Default for ThemePackageShowcaseManifest {
    fn default() -> Self {
        Self {
            enabled: false,
            eyebrow: String::new(),
            title: String::new(),
            subtitle: String::new(),
            hero_image: String::new(),
            portrait_image: String::new(),
            show_cards: true,
            cards: default_showcase_cards(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ThemeStudioManager {
    root: PathBuf,
    settings_path: PathBuf,
    legacy_settings_path: PathBuf,
    assets_path: PathBuf,
}

impl Default for ThemeStudioManager {
    fn default() -> Self {
        Self::new(crate::paths::default_app_state_dir().join("theme-studio"))
    }
}

impl ThemeStudioManager {
    pub fn new(root: PathBuf) -> Self {
        Self {
            settings_path: root.join("themes-v3.json"),
            legacy_settings_path: root.join("themes.json"),
            assets_path: root.join("assets"),
            root,
        }
    }

    pub fn load(&self) -> ThemeStudioSettings {
        self.try_load().unwrap_or_default()
    }

    fn try_load(&self) -> anyhow::Result<ThemeStudioSettings> {
        let source_path = if self.settings_path.is_file() {
            &self.settings_path
        } else if self.legacy_settings_path.is_file() {
            &self.legacy_settings_path
        } else {
            return Ok(ThemeStudioSettings::default());
        };
        let text = fs::read_to_string(source_path)
            .with_context(|| format!("failed to read theme settings {}", source_path.display()))?;
        let mut settings = serde_json::from_str::<ThemeStudioSettings>(&text)
            .with_context(|| format!("failed to parse theme settings {}", source_path.display()))?;
        let had_embedded_images = settings_contain_embedded_images(&settings);
        self.hydrate_theme_assets(&mut settings)?;
        let settings = normalize_settings(settings)?;
        if had_embedded_images {
            let _ = self.persist_normalized_settings(&settings);
        }
        Ok(settings)
    }

    pub fn payload(&self) -> ThemeStudioPayload {
        ThemeStudioPayload {
            settings: self.load(),
            settings_path: self.settings_path.to_string_lossy().to_string(),
            package_format: "Codex Compass Theme v3 (.zip or .cc-theme)".to_string(),
        }
    }

    pub fn save(&self, settings: ThemeStudioSettings) -> anyhow::Result<ThemeStudioSettings> {
        let settings = normalize_settings(settings)?;
        self.persist_normalized_settings(&settings)?;
        Ok(settings)
    }

    pub fn reset(&self) -> anyhow::Result<ThemeStudioSettings> {
        self.save(ThemeStudioSettings::default())
    }

    pub fn delete_theme(&self, theme_id: &str) -> anyhow::Result<ThemeStudioSettings> {
        let mut settings = self.try_load()?;
        let Some(theme) = settings.themes.iter().find(|theme| theme.id == theme_id) else {
            bail!("theme not found");
        };
        if theme.builtin {
            bail!("built-in themes cannot be deleted");
        }
        settings.themes.retain(|theme| theme.id != theme_id);
        if settings.selected_theme_id == theme_id {
            settings.selected_theme_id = default_theme_id().to_string();
        }
        settings.updated_at = unix_timestamp_string();
        self.save(settings)
    }

    pub fn import_package(
        &self,
        file_name: &str,
        contents_base64: &str,
    ) -> anyhow::Result<ThemeStudioSettings> {
        if !file_name.to_ascii_lowercase().ends_with(".zip")
            && !file_name.to_ascii_lowercase().ends_with(".cc-theme")
        {
            bail!("theme package must use .zip or .cc-theme");
        }
        let bytes = STANDARD
            .decode(contents_base64.trim())
            .context("theme package is not valid base64")?;
        if bytes.len() > MAX_PACKAGE_BYTES {
            bail!("theme package exceeds 12 MB");
        }
        let imported = read_theme_package(&bytes)?;
        self.install_theme(imported)
    }

    pub fn install_theme(&self, imported: ThemeDefinition) -> anyhow::Result<ThemeStudioSettings> {
        let imported = normalize_theme(imported)?;
        if imported.builtin {
            bail!("installed themes cannot be marked as built-in");
        }
        let mut settings = self.try_load()?;
        if settings
            .themes
            .iter()
            .any(|theme| theme.id == imported.id && theme.builtin)
        {
            bail!("installed theme id conflicts with a built-in theme");
        }
        if let Some(position) = settings
            .themes
            .iter()
            .position(|theme| theme.id == imported.id && !theme.builtin)
        {
            settings.themes[position] = imported.clone();
        } else {
            if settings
                .themes
                .iter()
                .filter(|theme| !theme.builtin)
                .count()
                >= MAX_CUSTOM_THEME_COUNT
            {
                bail!("theme library is full");
            }
            settings.themes.push(imported.clone());
        }
        settings.selected_theme_id = imported.id;
        settings.updated_at = unix_timestamp_string();
        self.save(settings)
    }

    pub fn state_root(&self) -> &Path {
        &self.root
    }

    pub fn build_runtime_bundle(&self) -> anyhow::Result<String> {
        build_runtime_bundle(&self.try_load()?)
    }

    pub fn title_bar_text_color(&self) -> ThemeTitleBarTextColor {
        theme_title_bar_text_color(&self.load())
    }

    fn hydrate_theme_assets(&self, settings: &mut ThemeStudioSettings) -> anyhow::Result<()> {
        for theme in &mut settings.themes {
            let theme_id = match normalize_identifier(&theme.id) {
                Ok(theme_id) => theme_id,
                Err(_) => continue,
            };
            hydrate_asset_data_url(
                &self.assets_path,
                &theme_id,
                "wallpaper",
                &mut theme.wallpaper_data_url,
            )?;
            hydrate_asset_data_url(
                &self.assets_path,
                &theme_id,
                "hero",
                &mut theme.showcase.hero_image_data_url,
            )?;
            hydrate_asset_data_url(
                &self.assets_path,
                &theme_id,
                "portrait",
                &mut theme.showcase.portrait_image_data_url,
            )?;
        }
        Ok(())
    }

    fn persist_normalized_settings(&self, settings: &ThemeStudioSettings) -> anyhow::Result<()> {
        fs::create_dir_all(&self.root)
            .with_context(|| format!("failed to create theme directory {}", self.root.display()))?;

        let transaction_id = Uuid::new_v4();
        let staging_path = self.root.join(format!(".assets-staging-{transaction_id}"));
        let backup_path = self.root.join(format!(".assets-backup-{transaction_id}"));
        fs::create_dir_all(&staging_path).with_context(|| {
            format!(
                "failed to create theme asset staging directory {}",
                staging_path.display()
            )
        })?;

        let mut stored_settings = settings.clone();
        let prepare_result = (|| -> anyhow::Result<()> {
            for theme in &mut stored_settings.themes {
                persist_asset_data_url(
                    &staging_path,
                    &theme.id,
                    "wallpaper",
                    &theme.wallpaper_data_url,
                )?;
                persist_asset_data_url(
                    &staging_path,
                    &theme.id,
                    "hero",
                    &theme.showcase.hero_image_data_url,
                )?;
                persist_asset_data_url(
                    &staging_path,
                    &theme.id,
                    "portrait",
                    &theme.showcase.portrait_image_data_url,
                )?;
                theme.wallpaper_data_url.clear();
                theme.showcase.hero_image_data_url.clear();
                theme.showcase.portrait_image_data_url.clear();
            }
            Ok(())
        })();
        if let Err(error) = prepare_result {
            let _ = fs::remove_dir_all(&staging_path);
            return Err(error);
        }
        let bytes = match serde_json::to_vec_pretty(&stored_settings) {
            Ok(bytes) => bytes,
            Err(error) => {
                let _ = fs::remove_dir_all(&staging_path);
                return Err(error.into());
            }
        };

        if self.assets_path.exists() {
            if !self.assets_path.is_dir() {
                let _ = fs::remove_dir_all(&staging_path);
                bail!(
                    "theme asset path is not a directory: {}",
                    self.assets_path.display()
                );
            }
            if let Err(error) = fs::rename(&self.assets_path, &backup_path) {
                let _ = fs::remove_dir_all(&staging_path);
                return Err(error).with_context(|| {
                    format!(
                        "failed to back up theme assets {}",
                        self.assets_path.display()
                    )
                });
            }
        }

        if let Err(error) = fs::rename(&staging_path, &self.assets_path) {
            if backup_path.exists() {
                let _ = fs::rename(&backup_path, &self.assets_path);
            }
            let _ = fs::remove_dir_all(&staging_path);
            return Err(error).with_context(|| {
                format!(
                    "failed to activate theme assets {}",
                    self.assets_path.display()
                )
            });
        }

        if let Err(error) = crate::settings::atomic_write(&self.settings_path, &bytes) {
            let _ = fs::remove_dir_all(&self.assets_path);
            if backup_path.exists() {
                let _ = fs::rename(&backup_path, &self.assets_path);
            }
            return Err(error).context("failed to persist theme settings");
        }

        if backup_path.exists() {
            let _ = fs::remove_dir_all(backup_path);
        }
        Ok(())
    }
}

fn settings_contain_embedded_images(settings: &ThemeStudioSettings) -> bool {
    settings.themes.iter().any(|theme| {
        !theme.wallpaper_data_url.is_empty()
            || !theme.showcase.hero_image_data_url.is_empty()
            || !theme.showcase.portrait_image_data_url.is_empty()
    })
}

fn persist_asset_data_url(
    assets_root: &Path,
    theme_id: &str,
    slot: &str,
    value: &str,
) -> anyhow::Result<()> {
    if value.is_empty() {
        return Ok(());
    }
    let theme_id = normalize_identifier(theme_id)?;
    let (extension, bytes) = decode_image_data_url(value)?;
    let theme_dir = assets_root.join(theme_id);
    fs::create_dir_all(&theme_dir).with_context(|| {
        format!(
            "failed to create theme asset directory {}",
            theme_dir.display()
        )
    })?;
    crate::settings::atomic_write(&theme_dir.join(format!("{slot}.{extension}")), &bytes)
}

fn hydrate_asset_data_url(
    assets_root: &Path,
    theme_id: &str,
    slot: &str,
    value: &mut String,
) -> anyhow::Result<()> {
    if !value.is_empty() {
        return Ok(());
    }
    let theme_dir = assets_root.join(theme_id);
    for (extension, mime) in [
        ("png", "image/png"),
        ("jpg", "image/jpeg"),
        ("webp", "image/webp"),
        ("svg", "image/svg+xml"),
    ] {
        let path = theme_dir.join(format!("{slot}.{extension}"));
        if !path.is_file() {
            continue;
        }
        let metadata = fs::metadata(&path)
            .with_context(|| format!("failed to inspect theme asset {}", path.display()))?;
        if metadata.len() > MAX_IMAGE_BYTES as u64 {
            bail!("theme asset exceeds 8 MB: {}", path.display());
        }
        let bytes = fs::read(&path)
            .with_context(|| format!("failed to read theme asset {}", path.display()))?;
        *value = format!("data:{mime};base64,{}", STANDARD.encode(bytes));
        return Ok(());
    }
    Ok(())
}

fn decode_image_data_url(value: &str) -> anyhow::Result<(&'static str, Vec<u8>)> {
    let formats = [
        ("data:image/png;base64,", "png"),
        ("data:image/jpeg;base64,", "jpg"),
        ("data:image/webp;base64,", "webp"),
        ("data:image/svg+xml;base64,", "svg"),
    ];
    let Some((prefix, extension)) = formats
        .iter()
        .find(|(prefix, _)| value.starts_with(*prefix))
    else {
        bail!("theme image must be a local PNG, JPEG or WebP image");
    };
    let bytes = STANDARD
        .decode(&value[prefix.len()..])
        .context("theme image data is not valid base64")?;
    if bytes.len() > MAX_IMAGE_BYTES {
        bail!("theme image exceeds 8 MB");
    }
    Ok((extension, bytes))
}

impl Default for ThemeStudioSettings {
    fn default() -> Self {
        Self {
            schema_version: THEME_SCHEMA_VERSION,
            enabled: false,
            selected_theme_id: default_theme_id().to_string(),
            themes: builtin_themes(),
            updated_at: unix_timestamp_string(),
        }
    }
}

fn default_theme_id() -> &'static str {
    "rose-garden"
}

fn default_true() -> bool {
    true
}

fn default_layout_style() -> String {
    "editorial".to_string()
}

fn default_card_style() -> String {
    "glass".to_string()
}

fn default_motif_style() -> String {
    "roses".to_string()
}

fn default_hero_position() -> String {
    "right".to_string()
}

fn default_overlay_strength() -> u8 {
    82
}

fn default_task_wallpaper_opacity() -> u8 {
    10
}

fn default_task_mode() -> String {
    "ambient".to_string()
}

fn default_showcase_cards() -> Vec<ThemeShowcaseCard> {
    vec![
        ThemeShowcaseCard {
            title: "探索与理解代码".to_string(),
            prompt: "请先阅读当前项目，解释关键结构，并指出最值得从哪里开始。".to_string(),
            icon: "code".to_string(),
        },
        ThemeShowcaseCard {
            title: "构建新功能".to_string(),
            prompt: "请根据当前项目实现一个完整的新功能，先分析现有结构，再编码、测试并汇报结果。"
                .to_string(),
            icon: "build".to_string(),
        },
        ThemeShowcaseCard {
            title: "审查代码并提出建议".to_string(),
            prompt: "请审查当前项目的代码，优先查找缺陷、回归风险和缺失测试，并给出可执行建议。"
                .to_string(),
            icon: "review".to_string(),
        },
        ThemeShowcaseCard {
            title: "修复问题和失败".to_string(),
            prompt: "请诊断当前项目中的问题或失败，定位根因，实施修复并运行验证。".to_string(),
            icon: "repair".to_string(),
        },
    ]
}

fn legacy_builtin_showcase_v2(theme_id: &str) -> ThemeShowcase {
    let (eyebrow, title, subtitle) = match theme_id {
        "mint-paper" => (
            "薄荷稿纸 · Codex Compass",
            "让思路清晰地生长",
            "选择一个方向，或在下方写下今天的任务。",
        ),
        "starlight-stage" => (
            "星夜舞台 · Codex Compass",
            "把灵感指向下一行代码",
            "从舞台灯光下开始一个新任务。",
        ),
        "ink-night" => (
            "墨夜星图 · Codex Compass",
            "把想法变成可靠的代码",
            "从探索、构建、审查或修复开始。",
        ),
        "warm-manuscript" => (
            "暖灰手稿 · Codex Compass",
            "从一页草稿开始",
            "选择一个起点，Codex 会继续完成后面的工作。",
        ),
        _ => (
            "蔷薇花笺 · Codex Compass",
            "今天想构建什么？",
            "选择一个方向，或在下方输入你的任务。",
        ),
    };
    ThemeShowcase {
        enabled: true,
        eyebrow: eyebrow.to_string(),
        title: title.to_string(),
        subtitle: subtitle.to_string(),
        hero_image_data_url: String::new(),
        portrait_image_data_url: String::new(),
        show_cards: true,
        cards: default_showcase_cards(),
    }
}

fn builtin_showcase_v2(theme_id: &str) -> ThemeShowcase {
    let mut showcase = legacy_builtin_showcase_v2(theme_id);
    let hero_bytes = match theme_id {
        "rose-garden" => Some(ROSE_GARDEN_HERO_BYTES),
        "starlight-stage" => Some(STARLIGHT_STAGE_HERO_BYTES),
        _ => None,
    };
    if let Some(hero_bytes) = hero_bytes {
        showcase.hero_image_data_url =
            format!("data:image/webp;base64,{}", STANDARD.encode(hero_bytes));
    }
    showcase
}

fn legacy_builtin_themes_v2() -> Vec<ThemeDefinition> {
    vec![
        ThemeDefinition {
            id: "rose-garden".to_string(),
            name: "蔷薇花笺".to_string(),
            description: "浅粉花卉、柔和玻璃面板与暖色强调。".to_string(),
            author: "Codex Compass".to_string(),
            version: "1.1.0".to_string(),
            license: "Built-in".to_string(),
            builtin: true,
            decorative_style: "botanical".to_string(),
            wallpaper_data_url: builtin_wallpaper("botanical", "#fff7f8", "#d66d88", "#f0b8c5"),
            showcase: builtin_showcase_v2("rose-garden"),
            presentation: ThemePresentation::default(),
            visual: ThemeVisual {
                accent: "#c95f7b".to_string(),
                accent_soft: "#f7dce3".to_string(),
                background: "#fff8f9".to_string(),
                surface: "#fffdfd".to_string(),
                surface_alt: "#fbeef1".to_string(),
                text: "#39252c".to_string(),
                text_muted: "#806b72".to_string(),
                border: "#eacbd3".to_string(),
                sidebar_opacity: 96,
                content_opacity: 94,
                wallpaper_opacity: 58,
                blur_px: 16,
                radius_px: 14,
                font_scale: 100,
                font_family: "system".to_string(),
                wallpaper_fit: "cover".to_string(),
            },
        },
        ThemeDefinition {
            id: "starlight-stage".to_string(),
            name: "星夜舞台".to_string(),
            description: "深蓝舞台、洋红灯光与人物主视觉。".to_string(),
            author: "Codex Compass".to_string(),
            version: "1.0.0".to_string(),
            license: "User-provided asset".to_string(),
            builtin: true,
            decorative_style: "constellation".to_string(),
            wallpaper_data_url: format!(
                "data:image/webp;base64,{}",
                STANDARD.encode(STARLIGHT_STAGE_HERO_BYTES)
            ),
            showcase: builtin_showcase_v2("starlight-stage"),
            presentation: ThemePresentation::default(),
            visual: ThemeVisual {
                accent: "#e35b91".to_string(),
                accent_soft: "#3d1c3d".to_string(),
                background: "#080918".to_string(),
                surface: "#111429".to_string(),
                surface_alt: "#191b35".to_string(),
                text: "#f8f3f8".to_string(),
                text_muted: "#bbaec2".to_string(),
                border: "#47324f".to_string(),
                sidebar_opacity: 96,
                content_opacity: 94,
                wallpaper_opacity: 54,
                blur_px: 16,
                radius_px: 10,
                font_scale: 100,
                font_family: "system".to_string(),
                wallpaper_fit: "cover".to_string(),
            },
        },
        ThemeDefinition {
            id: "mint-paper".to_string(),
            name: "薄荷稿纸".to_string(),
            description: "清爽薄荷、纸张质感与克制的青绿色强调。".to_string(),
            author: "Codex Compass".to_string(),
            version: "1.0.0".to_string(),
            license: "Built-in".to_string(),
            builtin: true,
            decorative_style: "leaves".to_string(),
            wallpaper_data_url: builtin_wallpaper("leaves", "#f4fbf8", "#2f8c78", "#a7d8ca"),
            showcase: builtin_showcase_v2("mint-paper"),
            presentation: ThemePresentation::default(),
            visual: ThemeVisual {
                accent: "#277d6d".to_string(),
                accent_soft: "#d9f0e9".to_string(),
                background: "#f5fbf9".to_string(),
                surface: "#fbfefd".to_string(),
                surface_alt: "#e8f5f1".to_string(),
                text: "#173d35".to_string(),
                text_muted: "#617c75".to_string(),
                border: "#bfdcd4".to_string(),
                sidebar_opacity: 97,
                content_opacity: 95,
                wallpaper_opacity: 50,
                blur_px: 12,
                radius_px: 10,
                font_scale: 100,
                font_family: "system".to_string(),
                wallpaper_fit: "cover".to_string(),
            },
        },
        ThemeDefinition {
            id: "ink-night".to_string(),
            name: "墨夜星图".to_string(),
            description: "深墨背景、青蓝边线和适合长时间编码的低亮度面板。".to_string(),
            author: "Codex Compass".to_string(),
            version: "1.0.0".to_string(),
            license: "Built-in".to_string(),
            builtin: true,
            decorative_style: "constellation".to_string(),
            wallpaper_data_url: builtin_wallpaper("constellation", "#11171b", "#65c8bd", "#285f67"),
            showcase: builtin_showcase_v2("ink-night"),
            presentation: ThemePresentation::default(),
            visual: ThemeVisual {
                accent: "#67c8bd".to_string(),
                accent_soft: "#173b3e".to_string(),
                background: "#10171b".to_string(),
                surface: "#172126".to_string(),
                surface_alt: "#1d2b31".to_string(),
                text: "#e9f5f2".to_string(),
                text_muted: "#9bb5b0".to_string(),
                border: "#315057".to_string(),
                sidebar_opacity: 96,
                content_opacity: 94,
                wallpaper_opacity: 60,
                blur_px: 14,
                radius_px: 12,
                font_scale: 100,
                font_family: "system".to_string(),
                wallpaper_fit: "cover".to_string(),
            },
        },
        ThemeDefinition {
            id: "warm-manuscript".to_string(),
            name: "暖灰手稿".to_string(),
            description: "温暖纸色、墨水文字与低饱和的编辑器气质。".to_string(),
            author: "Codex Compass".to_string(),
            version: "1.0.0".to_string(),
            license: "Built-in".to_string(),
            builtin: true,
            decorative_style: "manuscript".to_string(),
            wallpaper_data_url: builtin_wallpaper("manuscript", "#f8f5ef", "#8b6e54", "#d8c9b6"),
            showcase: builtin_showcase_v2("warm-manuscript"),
            presentation: ThemePresentation::default(),
            visual: ThemeVisual {
                accent: "#826346".to_string(),
                accent_soft: "#eadfce".to_string(),
                background: "#f7f4ee".to_string(),
                surface: "#fdfbf7".to_string(),
                surface_alt: "#efe9df".to_string(),
                text: "#332a23".to_string(),
                text_muted: "#766a60".to_string(),
                border: "#d8ccbc".to_string(),
                sidebar_opacity: 97,
                content_opacity: 95,
                wallpaper_opacity: 48,
                blur_px: 10,
                radius_px: 8,
                font_scale: 100,
                font_family: "serif".to_string(),
                wallpaper_fit: "cover".to_string(),
            },
        },
    ]
}

fn builtin_asset(bytes: &[u8]) -> String {
    format!("data:image/webp;base64,{}", STANDARD.encode(bytes))
}

fn themed_cards(theme_id: &str) -> Vec<ThemeShowcaseCard> {
    let titles = match theme_id {
        "rose-garden" => [
            "探索代码脉络",
            "构建心动功能",
            "审查实现细节",
            "修复问题回归",
        ],
        "warm-manuscript" => ["成本优化", "技术债清账", "报表自动生成", "冲突合并开运"],
        "red-future-city" => ["构建应用", "分析洞察", "自动化流程", "调试优化"],
        "mint-paper" => [
            "理清代码脉络",
            "构建清晰功能",
            "审查实现细节",
            "修复问题根因",
        ],
        "enfp-doodle" => ["灵感脑暴", "快速原型", "边玩边改", "欢乐修 Bug"],
        "ink-night" => [
            "探索代码星图",
            "构建闪光功能",
            "审查实现轨迹",
            "修复隐藏问题",
        ],
        "cyan-virtual-stage" => [
            "编写灵感代码",
            "构建互动功能",
            "审查舞台表现",
            "修复节拍问题",
        ],
        "starlight-stage" => [
            "探索代码节奏",
            "构建舞台功能",
            "审查实现表现",
            "修复幕后问题",
        ],
        _ => ["探索与理解代码", "构建新功能", "审查代码", "修复问题"],
    };
    let prompts = match theme_id {
        "rose-garden" => [
            "梳理模块关系与关键数据流。请阅读当前项目，说明核心结构、依赖和最合适的切入点。",
            "把灵感做成完整可用的功能。请分析现有结构，完成实现、测试和结果说明。",
            "检查正确性、可读性与体验细节。请审查当前改动，优先处理缺陷、回归风险和缺失测试。",
            "定位根因并恢复稳定。请修复当前问题，补充回归验证并说明影响范围。",
        ],
        "warm-manuscript" => [
            "找到最能省钱提效的机会。请分析当前项目的成本、性能和重复工作，实施最值得优先推进的优化。",
            "按风险和收益清理技术债。请扫描当前项目并先修复最关键、回报最高的一项。",
            "把项目状态自动整理成报告。请汇总进度、测试结果、风险和下一步待办。",
            "安全处理冲突并完成合并验证。请检查当前分支的冲突与集成风险，制定方案并验证。",
        ],
        "red-future-city" => [
            "编写代码与应用。请基于当前项目设计并实现一个完整的新功能，完成编码、测试和验证。",
            "提炼数据与系统洞察。请分析当前项目中最复杂的问题，拆解根因并给出可执行结论。",
            "让智能体接管重复工作。请识别可自动化流程，并实现可靠、可维护的自动化工具。",
            "修复问题并优化性能。请定位当前失败或瓶颈，实施修复并运行完整验证。",
        ],
        "mint-paper" => [
            "整理结构，让思路清晰生长。请阅读项目并梳理模块职责、依赖关系和关键数据流。",
            "用克制的方式完成新功能。请沿用现有架构，实现功能、测试和必要文档。",
            "逐项检查实现细节。请审查正确性、可维护性、边界条件和缺失测试。",
            "找到根因再动手修复。请复现问题、实施最小可靠修复并完成回归验证。",
        ],
        "enfp-doodle" => [
            "把脑子里的一万种可能都倒出来！请围绕当前项目快速脑暴，按价值、可行性和新鲜度筛选最值得立即实现的方向。",
            "想法不等人，先跑起来再说！请用最小完整范围做出可运行原型，完成关键流程验证并标明后续扩展点。",
            "改到爽为止，体验即正义！请运行并体验当前功能，边验证边改进交互、反馈、边界条件和实现质量。",
            "Bug 不可怕，把它变成段子吧！请稳定复现问题、定位根因、完成修复并补上防回归测试。",
        ],
        "ink-night" => [
            "绘制项目的代码星图。请梳理核心模块、调用链和高风险区域，指出最佳切入点。",
            "把闪光想法落成可靠功能。请完成设计、实现、测试和边界验证。",
            "沿着实现轨迹检查风险。请审查缺陷、回归点、性能问题和缺失测试。",
            "找出藏在暗处的问题。请复现故障、定位根因并完成可靠修复。",
        ],
        "cyan-virtual-stage" => [
            "让灵感写成清晰代码。请理解当前项目并完成一项高质量编码任务。",
            "把互动创意带上舞台。请设计并实现完整功能，覆盖交互、状态和测试。",
            "检查功能在舞台上的表现。请审查正确性、体验、性能和可维护性。",
            "校准出错的开发节拍。请定位失败原因，完成修复并验证全部相关流程。",
        ],
        "starlight-stage" => [
            "听清项目的代码节奏。请梳理架构、依赖与关键执行链路。",
            "让下一项功能正式登台。请完成设计、编码、测试和交付说明。",
            "审查每一处实现表现。请优先发现缺陷、回归风险和维护成本。",
            "解决藏在幕后的问题。请定位根因、实施修复并补充回归测试。",
        ],
        _ => [
            "请先阅读当前项目，解释关键结构，并指出最值得从哪里开始。",
            "请根据当前项目实现一个完整的新功能，先分析现有结构，再编码、测试并汇报结果。",
            "请审查当前项目的代码，优先查找缺陷、回归风险和缺失测试，并给出可执行建议。",
            "请诊断当前项目中的问题或失败，定位根因，实施修复并运行验证。",
        ],
    };
    let icons = ["code", "build", "review", "repair"];
    (0..4)
        .map(|index| ThemeShowcaseCard {
            title: titles[index].to_string(),
            prompt: prompts[index].to_string(),
            icon: icons[index].to_string(),
        })
        .collect()
}

fn concept_showcase(theme_id: &str) -> ThemeShowcase {
    let (eyebrow, title, subtitle) = match theme_id {
        "warm-manuscript" => (
            "财神打工版 · Codex Compass",
            "今天先把项目搞赚钱",
            "优化成本、清理技术债、催进度，让代码为结果服务。",
        ),
        "red-future-city" => (
            "人民 AI · Codex Compass",
            "OpenAI 是人民的 AI。",
            "用先进的工具，为每一个人创造更多可能。",
        ),
        "mint-paper" => (
            "橄榄纸笺 · Codex Compass",
            "我们该构建什么？",
            "让思路在纸张与叶影中沉淀，再把它写成可靠代码。",
        ),
        "enfp-doodle" => (
            "ENFP · 灵感发动机已启动 ♥",
            "先有灵感，再把它变成真的",
            "ENFP 模式：脑暴、试错、灵感乱飞，但最后都能落地。",
        ),
        "ink-night" => (
            "蝶光星河 · Codex Compass",
            "我们该构建什么？",
            "与蝶光一起，用灵感创造无限可能。",
        ),
        "cyan-virtual-stage" => (
            "未来歌姬舞台 · Codex Compass",
            "我们今天来构建什么？",
            "让灵感写成代码，让每一次迭代都有节拍。",
        ),
        "starlight-stage" => (
            "黑金茉莉舞台 · Codex Compass",
            "我们一起创造什么？",
            "让灵感与代码同频，在舞台灯光下完成下一项任务。",
        ),
        _ => (
            "玫瑰灵感 · Codex Compass",
            "我们该构建什么？",
            "在玫瑰与灵感里，把下一段代码认真做好。",
        ),
    };
    ThemeShowcase {
        enabled: true,
        eyebrow: eyebrow.to_string(),
        title: title.to_string(),
        subtitle: subtitle.to_string(),
        hero_image_data_url: String::new(),
        portrait_image_data_url: String::new(),
        show_cards: true,
        cards: themed_cards(theme_id),
    }
}

fn concept_presentation(
    layout_style: &str,
    card_style: &str,
    motif_style: &str,
    header_badge: &str,
    hero_position: &str,
    overlay_strength: u8,
    task_wallpaper_opacity: u8,
    task_mode: &str,
) -> ThemePresentation {
    ThemePresentation {
        layout_style: layout_style.to_string(),
        card_style: card_style.to_string(),
        motif_style: motif_style.to_string(),
        header_badge: header_badge.to_string(),
        hero_position: hero_position.to_string(),
        overlay_strength,
        task_wallpaper_opacity,
        task_mode: task_mode.to_string(),
    }
}

#[allow(clippy::too_many_arguments)]
fn concept_theme(
    id: &str,
    name: &str,
    description: &str,
    decorative_style: &str,
    wallpaper: &[u8],
    presentation: ThemePresentation,
    colors: [&str; 8],
    opacities: [u8; 4],
    radius_px: u8,
    font_family: &str,
) -> ThemeDefinition {
    ThemeDefinition {
        id: id.to_string(),
        name: name.to_string(),
        description: description.to_string(),
        author: "Codex Compass".to_string(),
        version: "2.1.0".to_string(),
        license: "AI-generated original asset".to_string(),
        builtin: true,
        decorative_style: decorative_style.to_string(),
        wallpaper_data_url: builtin_asset(wallpaper),
        showcase: concept_showcase(id),
        presentation,
        visual: ThemeVisual {
            accent: colors[0].to_string(),
            accent_soft: colors[1].to_string(),
            background: colors[2].to_string(),
            surface: colors[3].to_string(),
            surface_alt: colors[4].to_string(),
            text: colors[5].to_string(),
            text_muted: colors[6].to_string(),
            border: colors[7].to_string(),
            sidebar_opacity: opacities[0],
            content_opacity: opacities[1],
            wallpaper_opacity: opacities[2],
            blur_px: opacities[3],
            radius_px,
            font_scale: 100,
            font_family: font_family.to_string(),
            wallpaper_fit: "cover".to_string(),
        },
    }
}

fn builtin_themes() -> Vec<ThemeDefinition> {
    let mut themes = vec![
        concept_theme(
            "rose-garden",
            "玫瑰灵感",
            "奶油白、樱花粉、玫瑰花笺与原创人物的柔和灵感主题。",
            "botanical",
            ROSE_EDITORIAL_WALLPAPER_BYTES,
            concept_presentation(
                "editorial",
                "paper",
                "roses",
                "玫瑰灵感限定",
                "far-right",
                88,
                8,
                "ambient",
            ),
            [
                "#c85f7d", "#f7dce5", "#fff8fa", "#fffdfd", "#fbeef2", "#39252d", "#806b73",
                "#e9c9d3",
            ],
            [96, 95, 58, 16],
            10,
            "serif",
        ),
        concept_theme(
            "warm-manuscript",
            "财神工作台",
            "宣纸、春节红金、金币与原创财神程序员工作台。",
            "manuscript",
            FORTUNE_WORKBENCH_WALLPAPER_BYTES,
            concept_presentation(
                "fortune",
                "paper",
                "coins",
                "今日财运在线",
                "far-right",
                90,
                7,
                "ambient",
            ),
            [
                "#b72d22", "#f4dfae", "#fbf3dd", "#fffaf0", "#f4ead1", "#3c2518", "#78634d",
                "#dfc996",
            ],
            [97, 96, 56, 12],
            8,
            "serif",
        ),
        concept_theme(
            "red-future-city",
            "红色未来城市",
            "红白未来城市、巨型能量核心与面向每个人的科技广场。",
            "constellation",
            RED_FUTURE_CITY_WALLPAPER_BYTES,
            concept_presentation(
                "future",
                "solid",
                "orbit",
                "面向每一个人",
                "right",
                86,
                8,
                "banner",
            ),
            [
                "#d92727", "#f6c7c7", "#fff8f7", "#fffdfc", "#f9eaea", "#251d1d", "#766767",
                "#e8caca",
            ],
            [96, 95, 54, 14],
            8,
            "system",
        ),
        concept_theme(
            "mint-paper",
            "橄榄纸笺",
            "暖白手工纸、橄榄绿叶影与原创人物的安静纸笺主题。",
            "leaves",
            SAGE_PAPER_WALLPAPER_BYTES,
            concept_presentation(
                "paper",
                "paper",
                "leaves",
                "纸笺限定",
                "far-right",
                90,
                7,
                "ambient",
            ),
            [
                "#7d8e55", "#e4e8cf", "#f7f5eb", "#fffdf7", "#eeeee1", "#303326", "#727566",
                "#d8d8c3",
            ],
            [97, 96, 56, 10],
            8,
            "serif",
        ),
        concept_theme(
            "enfp-doodle",
            "ENFP 灵感宇宙",
            "彩色草图纸、原创动漫创作者与高能灵感宇宙。",
            "none",
            ENFP_DOODLE_WALLPAPER_BYTES,
            concept_presentation(
                "doodle",
                "outline",
                "doodles",
                "好点子 +99",
                "far-right",
                88,
                5,
                "ambient",
            ),
            [
                "#12a890", "#d3f3ea", "#fff9e9", "#fffef8", "#eefaf6", "#24302d", "#687b76",
                "#b7ddd4",
            ],
            [97, 95, 58, 10],
            8,
            "system",
        ),
        concept_theme(
            "ink-night",
            "蝶光星河",
            "深蓝紫星河、蝶光与原创人物的沉浸式夜间主题。",
            "constellation",
            BUTTERFLY_COSMOS_WALLPAPER_BYTES,
            concept_presentation(
                "cosmic",
                "glass",
                "butterflies",
                "蝶光限定",
                "far-right",
                78,
                9,
                "ambient",
            ),
            [
                "#a961f2", "#30235d", "#0b1028", "#171b38", "#22234a", "#f8f4ff", "#beb4d5",
                "#4e4780",
            ],
            [96, 94, 54, 16],
            10,
            "system",
        ),
        concept_theme(
            "cyan-virtual-stage",
            "未来歌姬舞台",
            "青蓝粉彩数字舞台、星光音符与原创虚拟歌姬。",
            "constellation",
            CYAN_VIRTUAL_STAGE_WALLPAPER_BYTES,
            concept_presentation(
                "idol",
                "glass",
                "stars",
                "未来舞台",
                "far-right",
                86,
                7,
                "ambient",
            ),
            [
                "#10b9bf", "#c8f4f2", "#f1fcfd", "#fbffff", "#e5f7fa", "#173b43", "#66858d",
                "#b5e3e6",
            ],
            [96, 94, 52, 14],
            10,
            "system",
        ),
        concept_theme(
            "starlight-stage",
            "黑金茉莉舞台",
            "近黑舞台、香槟金灯光、茉莉花与原创人物。",
            "constellation",
            BLACK_GOLD_STAGE_WALLPAPER_BYTES,
            concept_presentation(
                "stage",
                "solid",
                "jasmine",
                "茉莉舞台",
                "far-right",
                76,
                8,
                "ambient",
            ),
            [
                "#c8a66a", "#362c1e", "#090a09", "#151714", "#20231e", "#f7f1e6", "#bdb3a4",
                "#4b4438",
            ],
            [96, 94, 50, 14],
            8,
            "serif",
        ),
    ];
    if let Some(theme) = themes.iter_mut().find(|theme| theme.id == "enfp-doodle") {
        theme.version = "2.2.0".to_string();
    }
    themes
}

fn legacy_enfp_cards_v2_1() -> Vec<ThemeShowcaseCard> {
    let titles = ["灵感脑暴", "快速原型", "边玩边改", "欢乐修 Bug"];
    let prompts = [
        "一次发散出更多可能。请围绕当前项目快速脑暴，并筛选最值得立即实现的方向。",
        "先做出能跑的第一版。请用最小完整范围完成原型，并标明后续扩展点。",
        "边体验边把细节改顺。请运行当前功能，持续验证并改进交互与实现。",
        "把恼人的 Bug 彻底解决。请定位根因、完成修复并补上防回归测试。",
    ];
    let icons = ["code", "build", "review", "repair"];
    (0..4)
        .map(|index| ThemeShowcaseCard {
            title: titles[index].to_string(),
            prompt: prompts[index].to_string(),
            icon: icons[index].to_string(),
        })
        .collect()
}

fn legacy_builtin_themes_v3_1() -> Vec<ThemeDefinition> {
    let mut themes = builtin_themes();
    if let Some(theme) = themes.iter_mut().find(|theme| theme.id == "enfp-doodle") {
        theme.version = "2.1.0".to_string();
        theme.wallpaper_data_url = builtin_asset(ENFP_DOODLE_WALLPAPER_V2_1_BYTES);
        theme.showcase.eyebrow = "ENFP 灵感模式 · Codex Compass".to_string();
        theme.showcase.subtitle = "脑暴、试错、快速原型，最后都能落地。".to_string();
        theme.showcase.cards = legacy_enfp_cards_v2_1();
        theme.presentation.header_badge = "ENERGY 100%".to_string();
        theme.presentation.overlay_strength = 84;
        theme.presentation.task_wallpaper_opacity = 6;
        theme.visual.accent_soft = "#c8f1e9".to_string();
        theme.visual.background = "#fffdf3".to_string();
        theme.visual.surface = "#fffefa".to_string();
        theme.visual.surface_alt = "#edf9f5".to_string();
        theme.visual.text = "#202d2a".to_string();
        theme.visual.text_muted = "#677a75".to_string();
        theme.visual.border = "#b9ddd5".to_string();
        theme.visual.sidebar_opacity = 96;
        theme.visual.wallpaper_opacity = 52;
    }
    themes
}

fn legacy_themed_cards_v3(theme_id: &str) -> Vec<ThemeShowcaseCard> {
    let titles = match theme_id {
        "warm-manuscript" => ["成本优化", "技术债清账", "自动报表总结", "冲突合并开运"],
        "red-future-city" => ["构建新功能", "分析复杂问题", "设计自动化流程", "调试与优化"],
        "enfp-doodle" => ["灵感脑暴", "快速原型", "边玩边改", "欢乐修 Bug"],
        _ => [
            "探索并理解代码",
            "构建新功能或工具",
            "审查代码并提出建议",
            "修复问题和失败",
        ],
    };
    let prompts = match theme_id {
        "warm-manuscript" => [
            "请分析当前项目的成本、性能和重复工作，给出最值得优先实施的优化。",
            "请扫描当前项目的技术债，按风险和收益排序，并先修复最关键的一项。",
            "请总结当前项目状态、测试结果和待办事项，生成清晰的进度报告。",
            "请检查当前分支冲突和集成风险，制定安全的合并方案并完成验证。",
        ],
        "red-future-city" => [
            "请基于当前项目设计并实现一个完整的新功能，完成编码和验证。",
            "请分析当前项目中最复杂的问题，拆解根因并提出可执行方案。",
            "请识别可以自动化的重复流程，并实现可靠的自动化工具。",
            "请定位当前失败或性能瓶颈，实施修复并运行验证。",
        ],
        "enfp-doodle" => [
            "请围绕当前项目快速发散可行创意，并筛选最值得实现的方向。",
            "请用最小完整范围快速做出可运行原型，并说明后续扩展点。",
            "请先运行并体验当前功能，边验证边改进交互和实现。",
            "请定位这个恼人的问题，修复根因并补上防回归测试。",
        ],
        _ => [
            "请先阅读当前项目，解释关键结构，并指出最值得从哪里开始。",
            "请根据当前项目实现一个完整的新功能，先分析现有结构，再编码、测试并汇报结果。",
            "请审查当前项目的代码，优先查找缺陷、回归风险和缺失测试，并给出可执行建议。",
            "请诊断当前项目中的问题或失败，定位根因，实施修复并运行验证。",
        ],
    };
    let icons = ["code", "build", "review", "repair"];
    (0..4)
        .map(|index| ThemeShowcaseCard {
            title: titles[index].to_string(),
            prompt: prompts[index].to_string(),
            icon: icons[index].to_string(),
        })
        .collect()
}

fn legacy_concept_showcase_v3(theme_id: &str) -> ThemeShowcase {
    let (eyebrow, title, subtitle) = match theme_id {
        "warm-manuscript" => (
            "财神工作台 · Codex Compass",
            "今天先把项目搞赚钱",
            "优化成本、清理技术债，顺手推进交付。",
        ),
        "red-future-city" => (
            "未来城市 · Codex Compass",
            "把想法构建成真正可用的系统",
            "从构建、分析、自动化或调试开始。",
        ),
        "mint-paper" => (
            "橄榄纸张 · Codex Compass",
            "我们该构建什么？",
            "在安静的纸张与叶影中整理思路。",
        ),
        "enfp-doodle" => (
            "ENFP 灵感模式 · Codex Compass",
            "先有灵感，再把它变成真的",
            "脑暴、试错、快速原型，最后都能落地。",
        ),
        "ink-night" => (
            "蓝紫蝴蝶 · Codex Compass",
            "让灵感穿过星夜",
            "探索代码、构建功能、审查实现或修复问题。",
        ),
        "cyan-virtual-stage" => (
            "青蓝虚拟舞台 · Codex Compass",
            "今天想构建什么？",
            "让灵感与代码一起在舞台上成形。",
        ),
        "starlight-stage" => (
            "黑金舞台 · Codex Compass",
            "我们一起创造什么？",
            "在安静的舞台灯光下完成下一项任务。",
        ),
        _ => (
            "粉色玫瑰 · Codex Compass",
            "我们该构建什么？",
            "选择一个方向，或在下方输入今天的任务。",
        ),
    };
    ThemeShowcase {
        enabled: true,
        eyebrow: eyebrow.to_string(),
        title: title.to_string(),
        subtitle: subtitle.to_string(),
        hero_image_data_url: String::new(),
        portrait_image_data_url: String::new(),
        show_cards: true,
        cards: legacy_themed_cards_v3(theme_id),
    }
}

fn legacy_builtin_themes_v3() -> Vec<ThemeDefinition> {
    let mut themes = builtin_themes();
    for theme in &mut themes {
        theme.version = "2.0.0".to_string();
        theme.showcase = legacy_concept_showcase_v3(&theme.id);
        let (name, description, badge) = match theme.id.as_str() {
            "rose-garden" => (
                "粉色玫瑰",
                "奶油白与樱花粉的原创成年人物玫瑰主题。",
                "ROSE EDITION",
            ),
            "warm-manuscript" => (
                "财神工作台",
                "宣纸、春节红金与原创财神程序员工作台。",
                "今日财运在线",
            ),
            "red-future-city" => (
                "红色未来城市",
                "红白未来城市、巨型能量球与开阔科技广场。",
                "FUTURE READY",
            ),
            "mint-paper" => (
                "橄榄纸张",
                "暖白手工纸、鼠尾草叶影与原创成年人物。",
                "PAPER EDITION",
            ),
            "enfp-doodle" => (
                "ENFP 彩色涂鸦",
                "彩色草图纸、原创成年动漫创作者与高能灵感。",
                "ENERGY 100%",
            ),
            "ink-night" => (
                "蓝紫蝴蝶",
                "深蓝紫星夜、蝴蝶光点与原创成年人物。",
                "COSMIC EDITION",
            ),
            "cyan-virtual-stage" => (
                "青蓝虚拟舞台",
                "青蓝粉彩数字舞台与原创成年虚拟歌姬。",
                "FUTURE STAGE",
            ),
            "starlight-stage" => (
                "黑金舞台",
                "近黑舞台、香槟金灯光与原创成年人物。",
                "STAGE EDITION",
            ),
            _ => continue,
        };
        theme.name = name.to_string();
        theme.description = description.to_string();
        theme.presentation.header_badge = badge.to_string();
    }
    themes
}

fn normalize_settings(mut settings: ThemeStudioSettings) -> anyhow::Result<ThemeStudioSettings> {
    let source_schema_version = settings.schema_version;
    if source_schema_version > THEME_SCHEMA_VERSION {
        bail!("theme settings schema is newer than this Codex Compass build");
    }
    if settings
        .themes
        .iter()
        .filter(|theme| !theme.builtin)
        .count()
        > MAX_CUSTOM_THEME_COUNT
    {
        bail!("theme library contains too many custom themes");
    }
    if source_schema_version < THEME_SCHEMA_VERSION {
        settings = migrate_settings_to_v3(settings, source_schema_version);
    }
    settings.schema_version = THEME_SCHEMA_VERSION;
    if settings.themes.len() > MAX_THEME_COUNT {
        bail!("theme library exceeds the supported limit");
    }
    let mut seen = HashSet::new();
    let mut normalized = Vec::with_capacity(settings.themes.len() + 8);
    let builtin_defaults = builtin_themes();
    let legacy_v3_defaults = legacy_builtin_themes_v3();
    let legacy_v3_1_defaults = legacy_builtin_themes_v3_1();
    for theme in settings.themes {
        let theme = if theme.builtin {
            let old_default = legacy_v3_1_defaults
                .iter()
                .find(|default| default.id == theme.id && default.version == theme.version)
                .or_else(|| {
                    legacy_v3_defaults
                        .iter()
                        .find(|default| default.id == theme.id && default.version == theme.version)
                });
            let new_default = builtin_defaults
                .iter()
                .find(|default| default.id == theme.id);
            match (old_default, new_default) {
                (Some(old_default), Some(new_default)) => {
                    merge_builtin_theme(theme, old_default, new_default)
                }
                _ => theme,
            }
        } else {
            theme
        };
        let theme = normalize_theme(theme)?;
        if seen.insert(theme.id.clone()) {
            normalized.push(theme);
        }
    }
    for builtin in builtin_defaults {
        if seen.insert(builtin.id.clone()) {
            normalized.push(builtin);
        }
    }
    settings.themes = normalized;
    if !settings
        .themes
        .iter()
        .any(|theme| theme.id == settings.selected_theme_id)
    {
        settings.selected_theme_id = default_theme_id().to_string();
    }
    settings.updated_at = unix_timestamp_string();
    Ok(settings)
}

fn migrate_settings_to_v3(
    mut settings: ThemeStudioSettings,
    source_schema_version: u32,
) -> ThemeStudioSettings {
    let old_defaults = legacy_builtin_themes_v2();
    let new_defaults = builtin_themes();
    if source_schema_version < 2 {
        for theme in settings.themes.iter_mut().filter(|theme| theme.builtin) {
            if let Some(old_default) = old_defaults.iter().find(|default| default.id == theme.id) {
                if theme.id == "rose-garden" && theme.version == "1.0.0" {
                    theme.version = old_default.version.clone();
                }
                theme.showcase = old_default.showcase.clone();
                migrate_v1_builtin_visual_defaults(theme, old_default);
            }
        }
    }

    let mut saved_themes = settings.themes;
    let mut migrated = Vec::with_capacity(saved_themes.len() + 3);
    let mut used_ids = HashSet::new();
    for new_default in &new_defaults {
        let theme = saved_themes
            .iter()
            .position(|theme| theme.builtin && theme.id == new_default.id)
            .map(|position| saved_themes.remove(position))
            .map(|saved| {
                if let Some(old_default) = old_defaults
                    .iter()
                    .find(|old_default| old_default.id == saved.id)
                {
                    merge_builtin_theme(saved, old_default, new_default)
                } else {
                    saved
                }
            })
            .unwrap_or_else(|| new_default.clone());
        used_ids.insert(theme.id.clone());
        migrated.push(theme);
    }

    for mut theme in saved_themes {
        if theme.builtin {
            theme.builtin = false;
        }
        if used_ids.contains(&theme.id) {
            theme.id = unique_custom_theme_id(&theme.id, &used_ids);
        }
        used_ids.insert(theme.id.clone());
        migrated.push(theme);
    }

    settings.themes = migrated;
    settings.schema_version = THEME_SCHEMA_VERSION;
    settings
}

fn merge_builtin_theme(
    saved: ThemeDefinition,
    old_default: &ThemeDefinition,
    new_default: &ThemeDefinition,
) -> ThemeDefinition {
    ThemeDefinition {
        id: new_default.id.clone(),
        name: updated_value(saved.name, &old_default.name, &new_default.name),
        description: updated_value(
            saved.description,
            &old_default.description,
            &new_default.description,
        ),
        author: updated_value(saved.author, &old_default.author, &new_default.author),
        version: updated_value(saved.version, &old_default.version, &new_default.version),
        license: updated_value(saved.license, &old_default.license, &new_default.license),
        builtin: true,
        decorative_style: updated_value(
            saved.decorative_style,
            &old_default.decorative_style,
            &new_default.decorative_style,
        ),
        wallpaper_data_url: updated_value(
            saved.wallpaper_data_url,
            &old_default.wallpaper_data_url,
            &new_default.wallpaper_data_url,
        ),
        showcase: merge_showcase(saved.showcase, &old_default.showcase, &new_default.showcase),
        presentation: merge_presentation(
            saved.presentation,
            &old_default.presentation,
            &new_default.presentation,
        ),
        visual: merge_visual(saved.visual, &old_default.visual, &new_default.visual),
    }
}

fn updated_value<T: PartialEq + Clone>(saved: T, old_default: &T, new_default: &T) -> T {
    if &saved == old_default {
        new_default.clone()
    } else {
        saved
    }
}

fn merge_showcase(
    saved: ThemeShowcase,
    old_default: &ThemeShowcase,
    new_default: &ThemeShowcase,
) -> ThemeShowcase {
    ThemeShowcase {
        enabled: updated_value(saved.enabled, &old_default.enabled, &new_default.enabled),
        eyebrow: updated_value(saved.eyebrow, &old_default.eyebrow, &new_default.eyebrow),
        title: updated_value(saved.title, &old_default.title, &new_default.title),
        subtitle: updated_value(saved.subtitle, &old_default.subtitle, &new_default.subtitle),
        hero_image_data_url: updated_value(
            saved.hero_image_data_url,
            &old_default.hero_image_data_url,
            &new_default.hero_image_data_url,
        ),
        portrait_image_data_url: updated_value(
            saved.portrait_image_data_url,
            &old_default.portrait_image_data_url,
            &new_default.portrait_image_data_url,
        ),
        show_cards: updated_value(
            saved.show_cards,
            &old_default.show_cards,
            &new_default.show_cards,
        ),
        cards: updated_value(saved.cards, &old_default.cards, &new_default.cards),
    }
}

fn merge_visual(
    saved: ThemeVisual,
    old_default: &ThemeVisual,
    new_default: &ThemeVisual,
) -> ThemeVisual {
    ThemeVisual {
        accent: updated_value(saved.accent, &old_default.accent, &new_default.accent),
        accent_soft: updated_value(
            saved.accent_soft,
            &old_default.accent_soft,
            &new_default.accent_soft,
        ),
        background: updated_value(
            saved.background,
            &old_default.background,
            &new_default.background,
        ),
        surface: updated_value(saved.surface, &old_default.surface, &new_default.surface),
        surface_alt: updated_value(
            saved.surface_alt,
            &old_default.surface_alt,
            &new_default.surface_alt,
        ),
        text: updated_value(saved.text, &old_default.text, &new_default.text),
        text_muted: updated_value(
            saved.text_muted,
            &old_default.text_muted,
            &new_default.text_muted,
        ),
        border: updated_value(saved.border, &old_default.border, &new_default.border),
        sidebar_opacity: updated_value(
            saved.sidebar_opacity,
            &old_default.sidebar_opacity,
            &new_default.sidebar_opacity,
        ),
        content_opacity: updated_value(
            saved.content_opacity,
            &old_default.content_opacity,
            &new_default.content_opacity,
        ),
        wallpaper_opacity: updated_value(
            saved.wallpaper_opacity,
            &old_default.wallpaper_opacity,
            &new_default.wallpaper_opacity,
        ),
        blur_px: updated_value(saved.blur_px, &old_default.blur_px, &new_default.blur_px),
        radius_px: updated_value(
            saved.radius_px,
            &old_default.radius_px,
            &new_default.radius_px,
        ),
        font_scale: updated_value(
            saved.font_scale,
            &old_default.font_scale,
            &new_default.font_scale,
        ),
        font_family: updated_value(
            saved.font_family,
            &old_default.font_family,
            &new_default.font_family,
        ),
        wallpaper_fit: updated_value(
            saved.wallpaper_fit,
            &old_default.wallpaper_fit,
            &new_default.wallpaper_fit,
        ),
    }
}

fn merge_presentation(
    saved: ThemePresentation,
    old_default: &ThemePresentation,
    new_default: &ThemePresentation,
) -> ThemePresentation {
    ThemePresentation {
        layout_style: updated_value(
            saved.layout_style,
            &old_default.layout_style,
            &new_default.layout_style,
        ),
        card_style: updated_value(
            saved.card_style,
            &old_default.card_style,
            &new_default.card_style,
        ),
        motif_style: updated_value(
            saved.motif_style,
            &old_default.motif_style,
            &new_default.motif_style,
        ),
        header_badge: updated_value(
            saved.header_badge,
            &old_default.header_badge,
            &new_default.header_badge,
        ),
        hero_position: updated_value(
            saved.hero_position,
            &old_default.hero_position,
            &new_default.hero_position,
        ),
        overlay_strength: updated_value(
            saved.overlay_strength,
            &old_default.overlay_strength,
            &new_default.overlay_strength,
        ),
        task_wallpaper_opacity: updated_value(
            saved.task_wallpaper_opacity,
            &old_default.task_wallpaper_opacity,
            &new_default.task_wallpaper_opacity,
        ),
        task_mode: updated_value(
            saved.task_mode,
            &old_default.task_mode,
            &new_default.task_mode,
        ),
    }
}

fn unique_custom_theme_id(base: &str, used_ids: &HashSet<String>) -> String {
    let stem = format!("{base}-custom");
    if !used_ids.contains(&stem) {
        return stem;
    }
    (2..=999)
        .map(|suffix| format!("{stem}-{suffix}"))
        .find(|candidate| !used_ids.contains(candidate))
        .unwrap_or_else(|| format!("custom-{}", unix_timestamp_string()))
}

fn migrate_v1_builtin_visual_defaults(theme: &mut ThemeDefinition, old_default: &ThemeDefinition) {
    let legacy_visual = match theme.id.as_str() {
        "rose-garden" => (88, 82, 100, 18),
        "mint-paper" => (91, 86, 92, 14),
        "ink-night" => (91, 88, 78, 16),
        "warm-manuscript" => (94, 90, 84, 10),
        _ => return,
    };
    let current_visual = (
        theme.visual.sidebar_opacity,
        theme.visual.content_opacity,
        theme.visual.wallpaper_opacity,
        theme.visual.blur_px,
    );
    if current_visual == legacy_visual {
        theme.visual.sidebar_opacity = old_default.visual.sidebar_opacity;
        theme.visual.content_opacity = old_default.visual.content_opacity;
        theme.visual.wallpaper_opacity = old_default.visual.wallpaper_opacity;
        theme.visual.blur_px = old_default.visual.blur_px;
    }
}

fn normalize_theme(mut theme: ThemeDefinition) -> anyhow::Result<ThemeDefinition> {
    theme.id = normalize_identifier(&theme.id)?;
    theme.name = bounded_text(&theme.name, 80, "theme name")?;
    theme.description = bounded_text(&theme.description, 240, "theme description")?;
    theme.author = bounded_text(&theme.author, 80, "theme author")?;
    theme.version = bounded_text(&theme.version, 32, "theme version")?;
    theme.license = bounded_text(&theme.license, 80, "theme license")?;
    theme.decorative_style = normalize_decorative_style(&theme.decorative_style);
    theme.visual = normalize_visual(theme.visual)?;
    theme.showcase = normalize_showcase(theme.showcase)?;
    theme.presentation = normalize_presentation(theme.presentation)?;
    validate_theme_image_data_url(&theme.wallpaper_data_url, "wallpaper")?;
    Ok(theme)
}

fn normalize_presentation(
    mut presentation: ThemePresentation,
) -> anyhow::Result<ThemePresentation> {
    presentation.layout_style = match presentation.layout_style.as_str() {
        "fortune" | "future" | "paper" | "doodle" | "cosmic" | "idol" | "stage" => {
            presentation.layout_style
        }
        _ => "editorial".to_string(),
    };
    presentation.card_style = match presentation.card_style.as_str() {
        "paper" | "solid" | "outline" => presentation.card_style,
        _ => "glass".to_string(),
    };
    presentation.motif_style = match presentation.motif_style.as_str() {
        "coins" | "orbit" | "leaves" | "doodles" | "butterflies" | "stars" | "jasmine" => {
            presentation.motif_style
        }
        _ => "roses".to_string(),
    };
    presentation.header_badge = bounded_text(&presentation.header_badge, 48, "theme header badge")?;
    presentation.hero_position = match presentation.hero_position.as_str() {
        "center" | "far-right" => presentation.hero_position,
        _ => "right".to_string(),
    };
    presentation.overlay_strength = presentation.overlay_strength.clamp(40, 96);
    presentation.task_wallpaper_opacity = presentation.task_wallpaper_opacity.min(28);
    presentation.task_mode = match presentation.task_mode.as_str() {
        "banner" | "off" => presentation.task_mode,
        _ => "ambient".to_string(),
    };
    Ok(presentation)
}

fn normalize_showcase(mut showcase: ThemeShowcase) -> anyhow::Result<ThemeShowcase> {
    showcase.eyebrow = bounded_text(&showcase.eyebrow, 80, "showcase brand text")?;
    showcase.title = bounded_text(&showcase.title, 80, "showcase title")?;
    showcase.subtitle = bounded_text(&showcase.subtitle, 180, "showcase subtitle")?;
    validate_theme_image_data_url(&showcase.hero_image_data_url, "showcase hero image")?;
    validate_theme_image_data_url(&showcase.portrait_image_data_url, "showcase portrait image")?;
    if showcase.cards.len() > MAX_SHOWCASE_CARDS {
        bail!("showcase supports at most four shortcut cards");
    }
    if showcase.cards.is_empty() {
        showcase.cards = default_showcase_cards();
    }
    showcase.cards = showcase
        .cards
        .into_iter()
        .map(normalize_showcase_card)
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(showcase)
}

fn normalize_showcase_card(mut card: ThemeShowcaseCard) -> anyhow::Result<ThemeShowcaseCard> {
    card.title = bounded_text(&card.title, 48, "showcase card title")?;
    card.prompt = bounded_text(&card.prompt, 800, "showcase card prompt")?;
    card.icon = match card.icon.as_str() {
        "build" | "review" | "repair" => card.icon,
        _ => "code".to_string(),
    };
    Ok(card)
}

fn normalize_visual(mut visual: ThemeVisual) -> anyhow::Result<ThemeVisual> {
    visual.accent = normalize_color(&visual.accent)?;
    visual.accent_soft = normalize_color(&visual.accent_soft)?;
    visual.background = normalize_color(&visual.background)?;
    visual.surface = normalize_color(&visual.surface)?;
    visual.surface_alt = normalize_color(&visual.surface_alt)?;
    visual.text = normalize_color(&visual.text)?;
    visual.text_muted = normalize_color(&visual.text_muted)?;
    visual.border = normalize_color(&visual.border)?;
    visual.sidebar_opacity = visual.sidebar_opacity.clamp(45, 100);
    visual.content_opacity = visual.content_opacity.clamp(45, 100);
    visual.wallpaper_opacity = visual.wallpaper_opacity.clamp(0, 100);
    visual.blur_px = visual.blur_px.min(32);
    visual.radius_px = visual.radius_px.clamp(0, 24);
    visual.font_scale = visual.font_scale.clamp(85, 120);
    visual.font_family = match visual.font_family.as_str() {
        "serif" | "mono" => visual.font_family,
        _ => "system".to_string(),
    };
    visual.wallpaper_fit = match visual.wallpaper_fit.as_str() {
        "contain" | "center" | "tile" => visual.wallpaper_fit,
        _ => "cover".to_string(),
    };
    Ok(visual)
}

fn normalize_identifier(value: &str) -> anyhow::Result<String> {
    let trimmed = value.trim().to_ascii_lowercase();
    if trimmed.is_empty()
        || trimmed.len() > 64
        || !trimmed
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        bail!("theme id may contain only letters, numbers, hyphens and underscores");
    }
    Ok(trimmed)
}

fn bounded_text(value: &str, max_chars: usize, label: &str) -> anyhow::Result<String> {
    let trimmed = value.trim();
    if trimmed.chars().count() > max_chars {
        bail!("{label} is too long");
    }
    Ok(trimmed.to_string())
}

fn normalize_color(value: &str) -> anyhow::Result<String> {
    let trimmed = value.trim().to_ascii_lowercase();
    let valid = matches!(trimmed.len(), 7 | 9)
        && trimmed.starts_with('#')
        && trimmed[1..]
            .chars()
            .all(|character| character.is_ascii_hexdigit());
    if !valid {
        bail!("theme colors must use #RRGGBB or #RRGGBBAA");
    }
    Ok(trimmed)
}

fn theme_title_bar_text_color(settings: &ThemeStudioSettings) -> ThemeTitleBarTextColor {
    if !settings.enabled {
        return ThemeTitleBarTextColor::Default;
    }
    let Some(theme) = settings
        .themes
        .iter()
        .find(|theme| theme.id == settings.selected_theme_id)
        .or_else(|| settings.themes.first())
    else {
        return ThemeTitleBarTextColor::Default;
    };
    // Prefer the window background, but fall back to the surface color when the
    // background is empty or unparseable. As a last resort, infer brightness from
    // the text color (dark text implies a light window, and vice versa) so the
    // native title-bar buttons never get stranded on the theme's system default.
    if let Some(rgb) = parse_theme_rgb(&theme.visual.background) {
        return title_bar_color_for_luminance(rgb_luminance(rgb));
    }
    if let Some(rgb) = parse_theme_rgb(&theme.visual.surface) {
        return title_bar_color_for_luminance(rgb_luminance(rgb));
    }
    if let Some(rgb) = parse_theme_rgb(&theme.visual.text) {
        return title_bar_color_for_luminance(1.0 - rgb_luminance(rgb));
    }
    ThemeTitleBarTextColor::Default
}

fn rgb_luminance((red, green, blue): (u8, u8, u8)) -> f64 {
    (0.2126 * f64::from(red) + 0.7152 * f64::from(green) + 0.0722 * f64::from(blue)) / 255.0
}

fn title_bar_color_for_luminance(luminance: f64) -> ThemeTitleBarTextColor {
    if luminance < 0.46 {
        ThemeTitleBarTextColor::White
    } else {
        ThemeTitleBarTextColor::Black
    }
}

fn parse_theme_rgb(value: &str) -> Option<(u8, u8, u8)> {
    let hex = value.trim().strip_prefix('#')?;
    if hex.len() < 6 {
        return None;
    }
    Some((
        u8::from_str_radix(&hex[0..2], 16).ok()?,
        u8::from_str_radix(&hex[2..4], 16).ok()?,
        u8::from_str_radix(&hex[4..6], 16).ok()?,
    ))
}

fn normalize_decorative_style(value: &str) -> String {
    match value {
        "botanical" | "leaves" | "constellation" | "manuscript" | "none" => value.to_string(),
        _ => "none".to_string(),
    }
}

fn validate_theme_image_data_url(value: &str, label: &str) -> anyhow::Result<()> {
    if value.is_empty() {
        return Ok(());
    }
    let allowed = [
        "data:image/png;base64,",
        "data:image/jpeg;base64,",
        "data:image/webp;base64,",
        "data:image/svg+xml;base64,",
    ];
    let Some(prefix) = allowed.iter().find(|prefix| value.starts_with(**prefix)) else {
        bail!("{label} must be a local PNG, JPEG or WebP image");
    };
    let bytes = STANDARD
        .decode(&value[prefix.len()..])
        .with_context(|| format!("{label} data is not valid base64"))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        bail!("{label} exceeds 8 MB");
    }
    if *prefix == "data:image/svg+xml;base64," {
        let builtins = builtin_themes();
        if !builtins
            .iter()
            .any(|theme| theme.wallpaper_data_url == value)
        {
            bail!("imported SVG theme images are not allowed");
        }
    }
    Ok(())
}

fn read_theme_package(bytes: &[u8]) -> anyhow::Result<ThemeDefinition> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).context("invalid theme archive")?;
    if archive.len() > MAX_PACKAGE_FILES {
        bail!("theme package contains too many files");
    }
    let mut manifest_text = None;
    let mut image_files = Vec::new();
    let mut uncompressed_total = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        uncompressed_total = uncompressed_total.saturating_add(entry.size());
        if uncompressed_total > MAX_UNCOMPRESSED_BYTES {
            bail!("theme package expands beyond 18 MB");
        }
        let path = safe_archive_path(entry.name())?;
        if entry.is_dir() {
            continue;
        }
        let lower = path.to_string_lossy().to_ascii_lowercase();
        let allowed_metadata = lower.ends_with("readme.md")
            || lower.ends_with("license")
            || lower.ends_with("license.md")
            || lower.ends_with("license.txt");
        let allowed_image = lower.ends_with(".png")
            || lower.ends_with(".jpg")
            || lower.ends_with(".jpeg")
            || lower.ends_with(".webp");
        if lower == "theme.json" {
            let mut text = String::new();
            entry
                .by_ref()
                .take(256 * 1024)
                .read_to_string(&mut text)
                .context("failed to read theme.json")?;
            manifest_text = Some(text);
        } else if allowed_image {
            if entry.size() as usize > MAX_IMAGE_BYTES {
                bail!("theme image exceeds 8 MB");
            }
            let mut data = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut data)?;
            image_files.push((lower, data));
        } else if !allowed_metadata {
            bail!("theme packages may not contain scripts, stylesheets or executable files");
        }
    }
    let manifest_text = manifest_text.context("theme package is missing theme.json")?;
    let manifest: ThemePackageManifest =
        serde_json::from_str(&manifest_text).context("invalid theme.json")?;
    if manifest.schema_version > THEME_SCHEMA_VERSION {
        bail!("theme package schema is newer than this Codex Compass build");
    }
    let wallpaper_data_url =
        package_image_data_url(&manifest.wallpaper, &image_files, "wallpaper")?;
    let hero_image_data_url = package_image_data_url(
        &manifest.showcase.hero_image,
        &image_files,
        "showcase hero image",
    )?;
    let portrait_image_data_url = package_image_data_url(
        &manifest.showcase.portrait_image,
        &image_files,
        "showcase portrait image",
    )?;
    normalize_theme(ThemeDefinition {
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        author: manifest.author,
        version: if manifest.version.trim().is_empty() {
            "1.0.0".to_string()
        } else {
            manifest.version
        },
        license: manifest.license,
        builtin: false,
        decorative_style: manifest.decorative_style,
        wallpaper_data_url,
        showcase: ThemeShowcase {
            enabled: manifest.showcase.enabled,
            eyebrow: manifest.showcase.eyebrow,
            title: manifest.showcase.title,
            subtitle: manifest.showcase.subtitle,
            hero_image_data_url,
            portrait_image_data_url,
            show_cards: manifest.showcase.show_cards,
            cards: manifest.showcase.cards,
        },
        presentation: manifest.presentation,
        visual: manifest.visual,
    })
}

fn package_image_data_url(
    value: &str,
    image_files: &[(String, Vec<u8>)],
    label: &str,
) -> anyhow::Result<String> {
    let image_name = value.trim().to_ascii_lowercase();
    if image_name.is_empty() {
        return Ok(String::new());
    }
    if image_name.starts_with("http:")
        || image_name.starts_with("https:")
        || image_name.starts_with("file:")
        || image_name.starts_with("data:")
    {
        bail!("theme package {label} must be a local archive file");
    }
    let safe_path = safe_archive_path(&image_name)?;
    let normalized_name = safe_path.to_string_lossy().to_ascii_lowercase();
    let (_, data) = image_files
        .iter()
        .find(|(name, _)| name == &normalized_name)
        .with_context(|| format!("theme {label} file was not found"))?;
    image_data_url(&normalized_name, data)
}

fn safe_archive_path(name: &str) -> anyhow::Result<PathBuf> {
    if name.contains('\\') {
        bail!("theme package paths must use forward slashes");
    }
    let path = Path::new(name);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        bail!("theme package contains an unsafe path");
    }
    Ok(path.to_path_buf())
}

fn image_data_url(name: &str, bytes: &[u8]) -> anyhow::Result<String> {
    let lower = name.to_ascii_lowercase();
    let mime = if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else {
        bail!("unsupported theme image format");
    };
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

pub fn build_runtime_bundle(settings: &ThemeStudioSettings) -> anyhow::Result<String> {
    let selected = settings
        .themes
        .iter()
        .find(|theme| theme.id == settings.selected_theme_id)
        .or_else(|| settings.themes.first());
    let theme = if settings.enabled { selected } else { None };
    let config = theme
        .map(|theme| {
            json!({
                "enabled": true,
                "id": theme.id,
                "name": theme.name,
                "wallpaper": theme.wallpaper_data_url,
                "showcase": theme.showcase,
                "presentation": theme.presentation,
                "visual": theme.visual,
            })
        })
        .unwrap_or_else(|| json!({ "enabled": false }));
    let config = serde_json::to_string(&config)?;
    Ok(format!(
        r##"
(() => {{
  const config = {config};
  const runtimeKey = "__codexCompassThemeRuntime";
  const styleId = "codex-compass-theme-style";
  const showcaseId = "codex-compass-theme-showcase";
  const showcaseHostClass = "cc-theme-showcase-host";
  const showcaseHomeClass = "cc-theme-showcase-home";
  const showcaseComposerClass = "cc-theme-showcase-composer";
  const shellSidebarClass = "cc-theme-shell-sidebar";
  const shellSidebarStaticClass = "cc-theme-shell-sidebar-static";
  const shellAccountStaticClass = "cc-theme-shell-account-static";
  const shellTopbarClass = "cc-theme-shell-topbar";
  const shellSessionbarClass = "cc-theme-shell-sessionbar";
  const shellComposerClass = "cc-theme-shell-composer";
  const projectContextMenuSelector = '[data-codex-theme-project-context-menu="true"]';
  const projectRenameDialogSelector = '[data-codex-theme-project-rename-dialog="true"]';
  const shellSidebarClassNames = [
    shellSidebarClass,
    shellSidebarStaticClass,
    shellAccountStaticClass,
    "cc-theme-shell-product-button",
    "cc-theme-shell-search-button",
    "cc-theme-shell-new-task",
    "cc-theme-shell-nav-row",
    "cc-theme-shell-nav-coral",
    "cc-theme-shell-nav-mint",
    "cc-theme-shell-nav-sky",
    "cc-theme-shell-nav-violet",
    "cc-theme-shell-project-row",
    "cc-theme-shell-thread-row",
    "cc-theme-shell-active-row",
    "cc-theme-shell-group-heading",
    "cc-theme-shell-account-row",
  ];
  const shellClassNames = [
    ...shellSidebarClassNames,
    shellTopbarClass,
    shellSessionbarClass,
    shellComposerClass,
    "cc-theme-shell-model-button",
    "cc-theme-shell-send-button",
    "cc-theme-shell-stop-button",
    "cc-theme-shell-attach-button",
    "cc-theme-shell-window-control",
    "cc-theme-shell-window-minimize",
    "cc-theme-shell-window-maximize",
    "cc-theme-shell-window-close",
  ];
  const shellInjectedSelector = "[data-codex-theme-shell-injected]";
  function clearSidebarDecorations() {{
    document.querySelectorAll('[data-codex-theme-shell-injected="brand"]').forEach((node) => node.remove());
    shellSidebarClassNames.forEach((className) => {{
      document.querySelectorAll(`.${{className}}`).forEach((node) => {{
        node.classList.remove(className);
        delete node.dataset.ccThemeLabel;
        delete node.dataset.ccThemeMark;
      }});
    }});
  }}
  function clearShellDom() {{
    document.querySelectorAll(shellInjectedSelector).forEach((node) => node.remove());
    shellClassNames.forEach((className) => {{
      document.querySelectorAll(`.${{className}}`).forEach((node) => {{
        node.classList.remove(className);
        delete node.dataset.ccThemeLabel;
        delete node.dataset.ccThemeMark;
      }});
    }});
    document.querySelectorAll(projectContextMenuSelector).forEach((node) => {{
      delete node.dataset.codexThemeProjectContextMenu;
      delete node.dataset.codexThemeProjectContextMenuVersion;
    }});
    document.querySelectorAll('[data-codex-theme-project-menu-action]').forEach((node) => {{
      delete node.dataset.codexThemeProjectMenuAction;
    }});
    document.querySelectorAll(projectRenameDialogSelector).forEach((node) => {{
      delete node.dataset.codexThemeProjectRenameDialog;
    }});
    document.querySelectorAll('[data-codex-theme-project-rename-field], [data-codex-theme-project-rename-action], [data-codex-theme-project-rename-actions]').forEach((node) => {{
      delete node.dataset.codexThemeProjectRenameField;
      delete node.dataset.codexThemeProjectRenameAction;
      delete node.dataset.codexThemeProjectRenameActions;
    }});
    delete document.documentElement.dataset.codexCompassThemeShell;
  }}
  function clearShowcaseDom() {{
    document.getElementById(showcaseId)?.remove();
    document.querySelectorAll(`.${{showcaseHostClass}}`).forEach((node) => node.classList.remove(showcaseHostClass));
    document.querySelectorAll(`.${{showcaseHomeClass}}`).forEach((node) => node.classList.remove(showcaseHomeClass));
    document.querySelectorAll(`.${{showcaseComposerClass}}`).forEach((node) => {{
      node.classList.remove(showcaseComposerClass);
      delete node.dataset.codexThemeNativeComposer;
    }});
    delete document.documentElement.dataset.codexCompassShowcase;
  }}
  const previous = window[runtimeKey];
  try {{ previous?.cleanup?.(); }} catch (_) {{}}
  document.getElementById(styleId)?.remove();
    clearShowcaseDom();
    clearShellDom();
    delete document.documentElement.dataset.codexCompassTheme;
    delete document.documentElement.dataset.codexCompassThemePage;
    delete document.documentElement.dataset.codexCompassTaskMode;
    delete document.documentElement.dataset.codexCompassLayout;
  if (!config.enabled) {{
    window[runtimeKey] = {{
      status: "disabled",
      themeId: "",
      cleanup: () => {{
        document.getElementById(styleId)?.remove();
        clearShowcaseDom();
        clearShellDom();
      }}
    }};
    return;
  }}
  const v = config.visual;
  const p = config.presentation || {{}};
  const fontFamily = v.fontFamily === "serif"
    ? 'Georgia, "Noto Serif SC", "Microsoft YaHei", serif'
    : v.fontFamily === "mono"
      ? '"Cascadia Code", "SFMono-Regular", Consolas, monospace'
      : 'Inter, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
  const fit = v.wallpaperFit === "contain"
    ? "contain"
    : v.wallpaperFit === "center"
      ? "auto"
      : v.wallpaperFit === "tile"
        ? "auto"
        : "cover";
  const repeat = v.wallpaperFit === "tile" ? "repeat" : "no-repeat";
  const heroPosition = p.heroPosition === "center"
    ? "center"
    : p.heroPosition === "far-right"
      ? "82% center"
      : "72% center";
  const wallpaper = JSON.stringify(config.wallpaper || "");
  const backgroundHex = String(v.background || "#ffffff").slice(1, 7);
  const backgroundNumber = Number.parseInt(backgroundHex, 16);
  const red = (backgroundNumber >> 16) & 255;
  const green = (backgroundNumber >> 8) & 255;
  const blue = backgroundNumber & 255;
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  const colorScheme = luminance < 0.46 ? "dark" : "light";
  let codexAppActionsPromise = null;
  let appearanceSyncTimer = 0;
  let appearanceSyncInFlight = false;
  let appearanceRetryCount = 0;
  function appActionModuleCandidates() {{
    const candidates = new Set();
    const add = (value) => {{
      if (!value) return;
      try {{
        const url = new URL(value, location.href);
        if (/\/assets\/rpc-[^/]+\.js$/.test(url.pathname)) candidates.add(`.${{url.pathname}}`);
      }} catch (_) {{}}
    }};
    document.querySelectorAll("script[src],link[href]").forEach((node) => {{
      add(node.getAttribute("src") || node.getAttribute("href"));
    }});
    (performance.getEntriesByType?.("resource") || []).forEach((entry) => add(entry.name));
    return Array.from(candidates);
  }}
  async function getCodexAppActions() {{
    const injectedAppActions = window.__codexCompassThemeAppActions;
    if (typeof injectedAppActions?.runInPrimaryWindow === "function") return injectedAppActions;
    if (!codexAppActionsPromise) {{
      codexAppActionsPromise = (async () => {{
        const errors = [];
        for (const candidate of appActionModuleCandidates()) {{
          try {{
            const module = await import(candidate);
            const appActions = module?.n?.appActions || module?.appServices?.appActions;
            if (typeof appActions?.runInPrimaryWindow === "function") return appActions;
            errors.push(`${{candidate}}: missing appActions`);
          }} catch (error) {{
            errors.push(`${{candidate}}: ${{error?.message || error}}`);
          }}
        }}
        throw new Error(`Codex app actions unavailable (${{errors.join("; ")}})`);
      }})();
    }}
    try {{
      return await codexAppActionsPromise;
    }} catch (error) {{
      codexAppActionsPromise = null;
      throw error;
    }}
  }}
  function explicitCodexAppearanceMode() {{
    const tokens = [
      document.documentElement.className,
      document.documentElement.getAttribute("data-theme"),
      document.documentElement.getAttribute("color-scheme"),
      document.body?.className,
      document.body?.getAttribute("data-theme"),
    ].filter(Boolean).join(" ");
    if (/\b(?:electron-dark|theme-dark|dark)\b/i.test(tokens)) return "dark";
    if (/\b(?:electron-light|theme-light|light)\b/i.test(tokens)) return "light";
    return "";
  }}
  async function forceCodexAppearanceMode() {{
    if (appearanceSyncInFlight || explicitCodexAppearanceMode() === colorScheme) return;
    appearanceSyncInFlight = true;
    try {{
      const appActions = await getCodexAppActions();
      await appActions.runInPrimaryWindow({{
        action: {{ type: "app.appearance.set_mode", mode: colorScheme }},
      }});
      appearanceRetryCount = 0;
    }} catch (error) {{
      appearanceRetryCount += 1;
      if (appearanceRetryCount >= 4) {{
        console.warn("[Codex Compass Theme] Failed to synchronize Codex appearance", error);
      }} else {{
        scheduleAppearanceSync(appearanceRetryCount * 500);
      }}
    }} finally {{
      appearanceSyncInFlight = false;
    }}
  }}
  function scheduleAppearanceSync(delay = 80) {{
    if (appearanceSyncTimer) window.clearTimeout(appearanceSyncTimer);
    appearanceSyncTimer = window.setTimeout(() => {{
      appearanceSyncTimer = 0;
      forceCodexAppearanceMode();
    }}, delay);
  }}
  const accentHex = String(v.accent || "#000000").slice(1, 7);
  const accentNumber = Number.parseInt(accentHex, 16);
  const accentRed = (accentNumber >> 16) & 255;
  const accentGreen = (accentNumber >> 8) & 255;
  const accentBlue = accentNumber & 255;
  const accentLuminance = (0.2126 * accentRed + 0.7152 * accentGreen + 0.0722 * accentBlue) / 255;
  const onAccent = accentLuminance > 0.62 ? "#171717" : "#ffffff";
  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = `
    :root {{
      color-scheme: ${{colorScheme}};
      --cc-theme-accent: ${{v.accent}};
      --cc-theme-accent-soft: ${{v.accentSoft}};
      --cc-theme-bg: ${{v.background}};
      --cc-theme-surface: ${{v.surface}};
      --cc-theme-surface-alt: ${{v.surfaceAlt}};
      --cc-theme-text: ${{v.text}};
      --cc-theme-muted: ${{v.textMuted}};
      --cc-theme-border: ${{v.border}};
      --cc-theme-radius: ${{v.radiusPx}}px;
      --cc-theme-blur: ${{v.blurPx}}px;
      --cc-theme-task-wallpaper-opacity: ${{Math.max(0, Math.min(28, Number(p.taskWallpaperOpacity) || 0)) / 100}};
      --cc-theme-overlay-strength: ${{Math.max(40, Math.min(96, Number(p.overlayStrength) || 82))}}%;
      --cc-showcase-position: ${{heroPosition}};
      --codex-base-accent: var(--cc-theme-accent) !important;
      --codex-base-ink: var(--cc-theme-text) !important;
      --codex-base-surface: color-mix(in srgb, var(--cc-theme-surface) ${{v.contentOpacity}}%, transparent) !important;
      --color-token-primary: var(--cc-theme-accent) !important;
      --color-token-link: var(--cc-theme-accent) !important;
      --color-token-on-accent: ${{onAccent}} !important;
      --color-token-main-surface-primary: color-mix(in srgb, var(--cc-theme-surface) ${{v.contentOpacity}}%, transparent) !important;
      --color-token-bg-primary: color-mix(in srgb, var(--cc-theme-bg) ${{v.contentOpacity}}%, transparent) !important;
      --color-token-bg-secondary: color-mix(in srgb, var(--cc-theme-surface) ${{Math.max(45, v.contentOpacity - 7)}}%, transparent) !important;
      --color-token-bg-tertiary: color-mix(in srgb, var(--cc-theme-surface-alt) ${{Math.max(45, v.contentOpacity - 14)}}%, transparent) !important;
      --color-token-bg-appshot: color-mix(in srgb, var(--cc-theme-bg) 74%, transparent) !important;
      --color-token-bg-fog: color-mix(in srgb, var(--cc-theme-surface) 18%, transparent) !important;
      --color-token-side-bar-background: color-mix(in srgb, var(--cc-theme-surface) ${{v.sidebarOpacity}}%, transparent) !important;
      --color-token-foreground: var(--cc-theme-text) !important;
      --color-token-text-primary: var(--cc-theme-text) !important;
      --color-token-text-secondary: color-mix(in srgb, var(--cc-theme-muted) 92%, transparent) !important;
      --color-token-text-tertiary: color-mix(in srgb, var(--cc-theme-muted) 76%, transparent) !important;
      --color-token-description-foreground: color-mix(in srgb, var(--cc-theme-muted) 84%, transparent) !important;
      --color-token-disabled-foreground: color-mix(in srgb, var(--cc-theme-muted) 62%, transparent) !important;
      --color-token-icon-foreground: color-mix(in srgb, var(--cc-theme-text) 90%, transparent) !important;
      --color-token-border: color-mix(in srgb, var(--cc-theme-border) 86%, transparent) !important;
      --color-token-border-default: color-mix(in srgb, var(--cc-theme-border) 86%, transparent) !important;
      --color-token-border-heavy: color-mix(in srgb, var(--cc-theme-border) 100%, var(--cc-theme-text) 14%) !important;
      --color-token-border-light: color-mix(in srgb, var(--cc-theme-border) 48%, transparent) !important;
      --color-token-input-background: color-mix(in srgb, var(--cc-theme-surface) 92%, transparent) !important;
      --color-token-input-border: var(--cc-theme-border) !important;
      --color-token-input-foreground: var(--cc-theme-text) !important;
      --color-token-input-placeholder-foreground: color-mix(in srgb, var(--cc-theme-muted) 80%, transparent) !important;
      --color-token-dropdown-background: color-mix(in srgb, var(--cc-theme-surface) 96%, transparent) !important;
      --color-token-dropdown-foreground: var(--cc-theme-text) !important;
      --color-token-menu-background: color-mix(in srgb, var(--cc-theme-surface) 96%, transparent) !important;
      --color-token-menu-border: var(--cc-theme-border) !important;
      --color-background-elevated-primary: color-mix(in srgb, var(--cc-theme-surface) 96%, transparent) !important;
      --color-background-elevated-primary-opaque: var(--cc-theme-surface) !important;
      --color-background-elevated-secondary: color-mix(in srgb, var(--cc-theme-surface-alt) 70%, transparent) !important;
      --color-background-elevated-secondary-opaque: var(--cc-theme-surface-alt) !important;
      --color-token-checkbox-background: color-mix(in srgb, var(--cc-theme-surface-alt) 94%, transparent) !important;
      --color-token-checkbox-border: var(--cc-theme-border) !important;
      --color-token-checkbox-foreground: var(--cc-theme-text) !important;
      --color-token-list-active-selection-background: color-mix(in srgb, var(--cc-theme-accent-soft) 72%, transparent) !important;
      --color-token-list-active-selection-foreground: var(--cc-theme-text) !important;
      --color-token-list-hover-background: color-mix(in srgb, var(--cc-theme-accent-soft) 48%, transparent) !important;
      --color-token-toolbar-hover-background: color-mix(in srgb, var(--cc-theme-accent-soft) 48%, transparent) !important;
      --color-token-button-secondary-hover-background: color-mix(in srgb, var(--cc-theme-accent-soft) 56%, transparent) !important;
      --color-token-focus-border: color-mix(in srgb, var(--cc-theme-accent) 76%, transparent) !important;
      --color-token-text-link-active-foreground: var(--cc-theme-accent) !important;
      --color-token-text-link-foreground: var(--cc-theme-accent) !important;
      --color-token-text-code-block-background: color-mix(in srgb, var(--cc-theme-surface-alt) 88%, transparent) !important;
      --color-token-text-preformat-background: color-mix(in srgb, var(--cc-theme-surface-alt) 72%, transparent) !important;
      --color-token-text-preformat-foreground: var(--cc-theme-text) !important;
      --color-token-conversation-body: color-mix(in srgb, var(--cc-theme-text) 96%, transparent) !important;
      --color-token-conversation-header: color-mix(in srgb, var(--cc-theme-muted) 86%, transparent) !important;
      --color-token-conversation-summary-leading: color-mix(in srgb, var(--cc-theme-muted) 86%, transparent) !important;
      --color-token-conversation-summary-trailing: color-mix(in srgb, var(--cc-theme-muted) 82%, transparent) !important;
      --color-token-non-assistant-body-descendant: color-mix(in srgb, var(--cc-theme-muted) 92%, transparent) !important;
      --color-token-editor-background: color-mix(in srgb, var(--cc-theme-surface-alt) 94%, transparent) !important;
      --color-token-editor-foreground: var(--cc-theme-text) !important;
      --color-token-editor-widget-background: color-mix(in srgb, var(--cc-theme-surface) 96%, transparent) !important;
      --color-token-terminal-background: color-mix(in srgb, var(--cc-theme-surface-alt) 94%, transparent) !important;
      --color-token-terminal-foreground: var(--cc-theme-text) !important;
      --color-token-terminal-border: var(--cc-theme-border) !important;
      --color-token-scrollbar-slider-background: color-mix(in srgb, var(--cc-theme-accent) 26%, transparent) !important;
      --color-token-scrollbar-slider-hover-background: color-mix(in srgb, var(--cc-theme-accent) 42%, transparent) !important;
      --color-token-scrollbar-slider-active-background: color-mix(in srgb, var(--cc-theme-accent) 52%, transparent) !important;
      --vscode-foreground: var(--cc-theme-text) !important;
      --vscode-descriptionForeground: color-mix(in srgb, var(--cc-theme-muted) 84%, transparent) !important;
      --vscode-disabledForeground: color-mix(in srgb, var(--cc-theme-muted) 62%, transparent) !important;
      --vscode-icon-foreground: color-mix(in srgb, var(--cc-theme-text) 90%, transparent) !important;
      --vscode-focusBorder: color-mix(in srgb, var(--cc-theme-accent) 76%, transparent) !important;
      --vscode-sideBar-background: color-mix(in srgb, var(--cc-theme-surface) ${{v.sidebarOpacity}}%, transparent) !important;
      --vscode-sideBar-foreground: var(--cc-theme-text) !important;
      --vscode-sideBarTitle-foreground: var(--cc-theme-text) !important;
      --vscode-sideBarSectionHeader-foreground: var(--cc-theme-text) !important;
      --vscode-list-activeSelectionBackground: color-mix(in srgb, var(--cc-theme-accent-soft) 72%, transparent) !important;
      --vscode-list-activeSelectionForeground: var(--cc-theme-text) !important;
      --vscode-list-inactiveSelectionBackground: color-mix(in srgb, var(--cc-theme-accent-soft) 56%, transparent) !important;
      --vscode-list-inactiveSelectionForeground: var(--cc-theme-text) !important;
      --vscode-list-hoverBackground: color-mix(in srgb, var(--cc-theme-accent-soft) 48%, transparent) !important;
      --vscode-list-hoverForeground: var(--cc-theme-text) !important;
      --vscode-input-background: color-mix(in srgb, var(--cc-theme-surface) 92%, transparent) !important;
      --vscode-input-foreground: var(--cc-theme-text) !important;
      --vscode-input-border: var(--cc-theme-border) !important;
      --vscode-input-placeholderForeground: color-mix(in srgb, var(--cc-theme-muted) 80%, transparent) !important;
      --vscode-editor-background: color-mix(in srgb, var(--cc-theme-surface-alt) 94%, transparent) !important;
      --vscode-editor-foreground: var(--cc-theme-text) !important;
      --vscode-editorGutter-background: color-mix(in srgb, var(--cc-theme-surface-alt) 94%, transparent) !important;
      --vscode-editorPane-background: color-mix(in srgb, var(--cc-theme-surface-alt) 94%, transparent) !important;
      --vscode-editorWidget-background: color-mix(in srgb, var(--cc-theme-surface) 96%, transparent) !important;
      --vscode-editorWidget-border: var(--cc-theme-border) !important;
      --vscode-editorWidget-foreground: var(--cc-theme-text) !important;
      font-size: ${{v.fontScale}}% !important;
    }}
    html, body, #root {{ min-height: 100%; background: transparent !important; }}
    body {{
      color: var(--cc-theme-text) !important;
      font-family: ${{fontFamily}} !important;
      isolation: isolate;
    }}
    body::before {{
      content: "";
      position: fixed;
      z-index: -2;
      inset: 0;
      pointer-events: none;
      background-color: var(--cc-theme-bg);
      background-image: url(${{wallpaper}});
      background-size: ${{fit}};
      background-position: var(--cc-showcase-position);
      background-repeat: ${{repeat}};
      opacity: ${{v.wallpaperOpacity / 100}};
    }}
    html[data-codex-compass-theme-page="thread"] body::before {{
      opacity: var(--cc-theme-task-wallpaper-opacity);
    }}
    html[data-codex-compass-theme-page="thread"][data-codex-compass-task-mode="off"] body::before {{
      opacity: 0;
    }}
    html[data-codex-compass-theme-page="thread"][data-codex-compass-task-mode="banner"] body::before {{
      background-size: min(1440px, 100vw) auto;
      background-position: top right;
      background-repeat: no-repeat;
    }}
    body::after {{
      content: "";
      position: fixed;
      z-index: -1;
      inset: 0;
      pointer-events: none;
      background: color-mix(in srgb, var(--cc-theme-bg) ${{Math.max(0, 100 - v.contentOpacity)}}%, transparent);
    }}
    html[data-codex-compass-theme-page="thread"] body::after {{
      background: color-mix(in srgb, var(--cc-theme-bg) 72%, transparent);
    }}
    body > #root,
    #root > div {{
      background: color-mix(in srgb, var(--cc-theme-bg) ${{v.contentOpacity}}%, transparent) !important;
    }}
    body > div.pointer-events-none.fixed {{
      background: transparent !important;
      border: 0 !important;
      border-radius: 0 !important;
      backdrop-filter: none !important;
    }}
    aside,
    nav,
    [data-slot="sidebar"],
    [class*="sidebar"],
    [class*="Sidebar"] {{
      color: var(--cc-theme-text) !important;
      background: color-mix(in srgb, var(--cc-theme-surface) ${{v.sidebarOpacity}}%, transparent) !important;
      border-color: var(--cc-theme-border) !important;
      backdrop-filter: blur(var(--cc-theme-blur)) !important;
    }}
    .cc-theme-shell-sidebar {{
      isolation: isolate;
      overflow: hidden !important;
      border-right: 1px solid color-mix(in srgb, var(--cc-theme-accent) 22%, var(--cc-theme-border)) !important;
      background:
        linear-gradient(180deg,
          color-mix(in srgb, var(--cc-theme-surface) ${{v.sidebarOpacity}}%, transparent),
          color-mix(in srgb, var(--cc-theme-bg) ${{Math.max(78, v.sidebarOpacity - 5)}}%, transparent)) !important;
      box-shadow: 10px 0 34px color-mix(in srgb, var(--cc-theme-text) 7%, transparent);
      backdrop-filter: blur(max(14px, var(--cc-theme-blur))) saturate(1.08) !important;
    }}
    .cc-theme-shell-sidebar-static {{
      position: relative !important;
    }}
    .cc-theme-shell-sidebar::before {{
      content: "";
      position: absolute;
      z-index: -1;
      inset: 0;
      pointer-events: none;
      background:
        linear-gradient(135deg, color-mix(in srgb, var(--cc-theme-accent-soft) 34%, transparent), transparent 36%),
        radial-gradient(circle at 100% 8%, color-mix(in srgb, var(--cc-theme-accent) 14%, transparent), transparent 24%);
      opacity: .9;
    }}
    .cc-theme-shell-sidebar::after {{
      content: "";
      position: absolute;
      z-index: 4;
      top: 72px;
      right: 0;
      width: 2px;
      height: min(180px, 24vh);
      pointer-events: none;
      background: linear-gradient(180deg, transparent, var(--cc-theme-accent), transparent);
      opacity: .42;
    }}
    .cc-theme-shell-product-button {{
      position: relative !important;
      min-height: 54px !important;
      padding: 8px 12px 8px 46px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: flex-start !important;
      color: var(--cc-theme-text) !important;
      border: 1px solid color-mix(in srgb, var(--cc-theme-accent) 20%, var(--cc-theme-border)) !important;
      background: color-mix(in srgb, var(--cc-theme-surface) 72%, transparent) !important;
      box-shadow: inset 0 1px color-mix(in srgb, #ffffff 28%, transparent);
      font-family: Georgia, "Noto Serif SC", "Microsoft YaHei", serif !important;
      font-size: 17px !important;
      font-weight: 720 !important;
    }}
    .cc-theme-shell-product-button::before {{
      content: attr(data-cc-theme-mark);
      position: absolute;
      left: 10px;
      top: 50%;
      width: 28px;
      height: 28px;
      display: grid;
      place-items: center;
      transform: translateY(-50%);
      color: var(--cc-theme-accent);
      border: 1px solid color-mix(in srgb, var(--cc-theme-accent) 34%, var(--cc-theme-border));
      border-radius: 8px;
      background: color-mix(in srgb, var(--cc-theme-accent-soft) 72%, transparent);
      font-family: ${{fontFamily}};
      font-size: 13px;
      font-weight: 800;
    }}
    .cc-theme-shell-product-button::after {{
      content: attr(data-cc-theme-label);
      position: absolute;
      left: 46px;
      right: 22px;
      bottom: 6px;
      overflow: hidden;
      color: color-mix(in srgb, var(--cc-theme-muted) 86%, transparent);
      font-family: ${{fontFamily}};
      font-size: 9px;
      font-weight: 650;
      line-height: 1;
      text-overflow: ellipsis;
      white-space: nowrap;
    }}
    .cc-theme-shell-search-button {{
      z-index: 5 !important;
      color: color-mix(in srgb, var(--cc-theme-accent) 86%, var(--cc-theme-text)) !important;
      border-color: transparent !important;
      background: transparent !important;
      box-shadow: none !important;
    }}
    .cc-theme-shell-search-button:hover {{
      color: var(--cc-theme-accent) !important;
      background: color-mix(in srgb, var(--cc-theme-accent-soft) 72%, transparent) !important;
    }}
    .cc-theme-shell-new-task {{
      min-height: 38px !important;
      color: ${{onAccent}} !important;
      border-color: color-mix(in srgb, var(--cc-theme-accent) 74%, var(--cc-theme-border)) !important;
      background: linear-gradient(135deg,
        color-mix(in srgb, var(--cc-theme-accent) 92%, #ffffff 8%),
        color-mix(in srgb, var(--cc-theme-accent) 76%, var(--cc-theme-text) 24%)) !important;
      box-shadow: 0 8px 18px color-mix(in srgb, var(--cc-theme-accent) 20%, transparent) !important;
      font-weight: 700 !important;
    }}
    .cc-theme-shell-new-task:hover {{
      color: ${{onAccent}} !important;
      filter: brightness(1.04);
      transform: translateY(-1px);
    }}
    .cc-theme-shell-nav-row {{
      position: relative !important;
      min-height: 30px !important;
      margin-block: 1px !important;
      color: color-mix(in srgb, var(--cc-theme-text) 92%, transparent) !important;
      border: 1px solid transparent !important;
      background: transparent !important;
      transition: color 140ms ease, background-color 140ms ease, border-color 140ms ease !important;
    }}
    .cc-theme-shell-project-row,
    .cc-theme-shell-thread-row {{
      box-sizing: border-box !important;
      min-height: 30px !important;
      max-height: 32px !important;
      margin-block: 0 !important;
      padding-block: 0 !important;
      overflow: clip !important;
      border-radius: 6px !important;
      font-size: 12px !important;
      line-height: 1.25 !important;
    }}
    .cc-theme-shell-project-row {{
      font-weight: 680 !important;
    }}
    .cc-theme-shell-thread-row {{
      margin-left: 8px !important;
      color: color-mix(in srgb, var(--cc-theme-text) 84%, transparent) !important;
      border-top-color: transparent !important;
      border-right-color: transparent !important;
      border-bottom-color: transparent !important;
      border-left: 1px solid color-mix(in srgb, var(--cc-theme-accent) 14%, transparent) !important;
      background: transparent !important;
      box-shadow: none !important;
      font-weight: 500 !important;
    }}
    .cc-theme-shell-project-row button,
    .cc-theme-shell-project-row [role="button"],
    .cc-theme-shell-thread-row button,
    .cc-theme-shell-thread-row [role="button"] {{
      color: inherit !important;
      border-color: transparent !important;
      background: transparent !important;
      box-shadow: none !important;
    }}
    .cc-theme-shell-group-heading button,
    .cc-theme-shell-group-heading [role="button"] {{
      border-color: transparent !important;
      background: transparent !important;
      box-shadow: none !important;
    }}
    .cc-theme-shell-nav-row:hover {{
      color: var(--cc-theme-text) !important;
      border-color: color-mix(in srgb, var(--cc-theme-accent) 18%, transparent) !important;
      background: color-mix(in srgb, var(--cc-theme-accent-soft) 48%, transparent) !important;
    }}
    .cc-theme-shell-nav-row svg {{
      color: color-mix(in srgb, var(--cc-theme-accent) 82%, var(--cc-theme-text)) !important;
      filter: drop-shadow(0 2px 4px color-mix(in srgb, var(--cc-theme-accent) 12%, transparent));
    }}
    .cc-theme-shell-nav-coral svg {{
      color: #ef765d !important;
    }}
    .cc-theme-shell-nav-mint svg {{
      color: #12a890 !important;
    }}
    .cc-theme-shell-nav-sky svg {{
      color: #37a9dc !important;
    }}
    .cc-theme-shell-nav-violet svg {{
      color: #8a6fd1 !important;
    }}
    .cc-theme-shell-active-row {{
      color: var(--cc-theme-text) !important;
      border-color: color-mix(in srgb, var(--cc-theme-accent) 28%, var(--cc-theme-border)) !important;
      background: linear-gradient(90deg,
        color-mix(in srgb, var(--cc-theme-accent-soft) 76%, transparent),
        color-mix(in srgb, var(--cc-theme-surface) 32%, transparent)) !important;
      box-shadow: inset 3px 0 0 var(--cc-theme-accent) !important;
      font-weight: 650 !important;
    }}
    .cc-theme-shell-group-heading {{
      position: relative !important;
      margin-top: 10px !important;
      padding-top: 9px !important;
      color: color-mix(in srgb, var(--cc-theme-accent) 78%, var(--cc-theme-text)) !important;
      border-top: 1px solid color-mix(in srgb, var(--cc-theme-accent) 18%, var(--cc-theme-border)) !important;
      font-size: 10px !important;
      font-weight: 800 !important;
      text-transform: none !important;
    }}
    .cc-theme-shell-account-row {{
      border-color: color-mix(in srgb, var(--cc-theme-accent) 20%, var(--cc-theme-border)) !important;
      background: color-mix(in srgb, var(--cc-theme-surface-alt) 58%, transparent) !important;
    }}
    .cc-theme-shell-account-static {{
      position: relative !important;
    }}
    .cc-theme-shell-topbar {{
      position: relative !important;
      color: var(--cc-theme-text) !important;
      border-bottom-color: color-mix(in srgb, var(--cc-theme-accent) 18%, var(--cc-theme-border)) !important;
      background: color-mix(in srgb, var(--cc-theme-surface) 84%, transparent) !important;
      backdrop-filter: blur(max(12px, var(--cc-theme-blur))) !important;
    }}
    .cc-theme-shell-topbar::after {{
      content: attr(data-cc-theme-label);
      position: absolute;
      z-index: 2;
      left: 50%;
      top: 50%;
      max-width: 34vw;
      padding: 4px 10px 4px 22px;
      overflow: hidden;
      transform: translate(-50%, -50%);
      pointer-events: none;
      color: color-mix(in srgb, var(--cc-theme-accent) 78%, var(--cc-theme-text));
      border: 1px solid color-mix(in srgb, var(--cc-theme-accent) 22%, var(--cc-theme-border));
      border-radius: 999px;
      background:
        radial-gradient(circle at 10px 50%, var(--cc-theme-accent) 0 3px, transparent 3.5px),
        color-mix(in srgb, var(--cc-theme-surface) 78%, transparent);
      font-size: 10px;
      font-weight: 720;
      line-height: 1.4;
      text-overflow: ellipsis;
      white-space: nowrap;
    }}
    .cc-theme-shell-topbar::before {{
      display: none;
    }}
    .cc-theme-shell-sessionbar {{
      color: var(--cc-theme-text) !important;
      border-bottom-color: color-mix(in srgb, var(--cc-theme-accent) 14%, var(--cc-theme-border)) !important;
      background:
        linear-gradient(90deg,
          color-mix(in srgb, var(--cc-theme-accent-soft) 12%, transparent),
          transparent 42%),
        color-mix(in srgb, var(--cc-theme-surface) 76%, transparent) !important;
      backdrop-filter: blur(max(10px, var(--cc-theme-blur))) !important;
    }}
    main,
    [role="main"],
    [data-slot="content"],
    [class*="content"],
    [class*="Content"] {{
      color: var(--cc-theme-text) !important;
      background-color: transparent !important;
    }}
    html[data-codex-compass-theme-page="thread"] main,
    html[data-codex-compass-theme-page="thread"] [role="main"],
    html[data-codex-compass-theme-page="thread"] [data-slot="content"] {{
      background-color: color-mix(in srgb, var(--cc-theme-bg) 86%, transparent) !important;
    }}
    [role="dialog"],
    [role="menu"],
    [role="listbox"],
    [data-slot="dialog-content"],
    [data-slot="alert-dialog-content"],
    [data-slot="popover-content"],
    [data-slot="dropdown-menu-content"],
    [data-slot="context-menu-content"],
    [data-slot="command"],
    [data-radix-menu-content],
    [data-radix-popover-content] {{
      position: relative;
      z-index: 2147483001 !important;
      isolation: isolate;
      color: var(--cc-theme-text) !important;
      background: var(--cc-theme-surface) !important;
      border-color: var(--cc-theme-border) !important;
      border-radius: var(--cc-theme-radius) !important;
      box-shadow: 0 18px 54px color-mix(in srgb, var(--cc-theme-text) 18%, transparent) !important;
      backdrop-filter: none !important;
      opacity: 1 !important;
    }}
    html[data-codex-compass-theme] [role="dialog"][aria-label="图片预览"],
    html[data-codex-compass-theme] [role="dialog"][aria-label="Image preview"] {{
      position: fixed !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100dvh !important;
      z-index: 2147483001 !important;
      isolation: auto;
      color: inherit !important;
      background: transparent !important;
      border: 0 !important;
      border-radius: 0 !important;
      box-shadow: none !important;
      backdrop-filter: none !important;
      transform: none !important;
      opacity: 1 !important;
    }}
    [data-slot="dialog-overlay"],
    [data-slot="alert-dialog-overlay"],
    [data-radix-dialog-overlay],
    [data-radix-alert-dialog-overlay] {{
      z-index: 2147483000 !important;
      background: color-mix(in srgb, var(--cc-theme-text) 34%, transparent) !important;
      backdrop-filter: none !important;
      opacity: 1 !important;
    }}
    [role="dialog"] aside,
    [role="dialog"] nav,
    [data-slot="dialog-content"] aside,
    [data-slot="dialog-content"] nav {{
      color: var(--cc-theme-text) !important;
      background: var(--cc-theme-surface-alt) !important;
      border-color: var(--cc-theme-border) !important;
      backdrop-filter: none !important;
      opacity: 1 !important;
    }}
    html[data-codex-compass-theme] [role="dialog"] [data-slot="content"],
    html[data-codex-compass-theme] [role="dialog"] [class*="content"],
    html[data-codex-compass-theme] [role="dialog"] [class*="Content"],
    html[data-codex-compass-theme] [data-slot="dialog-content"] [data-slot="content"],
    html[data-codex-compass-theme] [data-slot="dialog-content"] [class*="content"],
    html[data-codex-compass-theme] [data-slot="dialog-content"] [class*="Content"] {{
      color: var(--cc-theme-text) !important;
      background-color: var(--cc-theme-surface) !important;
      backdrop-filter: none !important;
      opacity: 1 !important;
    }}
    [role="dialog"] input:not([type="checkbox"]):not([type="radio"]),
    [role="dialog"] textarea,
    [role="dialog"] [contenteditable="true"],
    [role="dialog"] [role="combobox"],
    [data-slot="dialog-content"] input:not([type="checkbox"]):not([type="radio"]),
    [data-slot="dialog-content"] textarea,
    [data-slot="dialog-content"] [contenteditable="true"],
    [data-slot="dialog-content"] [role="combobox"] {{
      color: var(--cc-theme-text) !important;
      background: var(--cc-theme-surface-alt) !important;
      border-color: var(--cc-theme-border) !important;
      backdrop-filter: none !important;
      opacity: 1 !important;
    }}
    [role="switch"],
    [data-slot="switch"] {{
      color: var(--cc-theme-text) !important;
      background: var(--cc-theme-surface-alt) !important;
      border-color: var(--cc-theme-border) !important;
      opacity: 1 !important;
    }}
    [role="switch"][aria-checked="true"],
    [role="switch"][data-state="checked"],
    [data-slot="switch"][data-state="checked"] {{
      color: ${{onAccent}} !important;
      background: color-mix(in srgb, var(--cc-theme-accent) 66%, var(--cc-theme-text)) !important;
      border-color: var(--cc-theme-accent) !important;
    }}
    input[type="checkbox"],
    input[type="radio"],
    [role="checkbox"] {{
      accent-color: var(--cc-theme-accent) !important;
    }}
    [role="menuitem"],
    [role="option"],
    [data-slot="command-item"] {{
      color: var(--cc-theme-text) !important;
    }}
    [role="menuitem"]:hover,
    [role="menuitem"][data-highlighted],
    [role="option"]:hover,
    [role="option"][data-highlighted],
    [data-slot="command-item"]:hover,
    [data-slot="command-item"][data-selected="true"] {{
      color: var(--cc-theme-text) !important;
      background: color-mix(in srgb, var(--cc-theme-accent-soft) 82%, var(--cc-theme-surface)) !important;
    }}
    html[data-codex-compass-theme] [data-codex-theme-project-context-menu="true"] {{
      min-width: min(248px, calc(100vw - 24px)) !important;
      padding: 6px !important;
      color: var(--cc-theme-text) !important;
      background: var(--cc-theme-surface) !important;
      border: 1px solid var(--cc-theme-border) !important;
      border-radius: 8px !important;
      box-shadow: 0 16px 42px color-mix(in srgb, var(--cc-theme-text) 18%, transparent) !important;
      opacity: 1 !important;
      backdrop-filter: none !important;
    }}
    html[data-codex-compass-theme] [data-codex-theme-project-menu-action] {{
      min-height: 38px !important;
      padding: 7px 10px !important;
      display: flex !important;
      align-items: center !important;
      gap: 10px !important;
      color: var(--cc-theme-text) !important;
      border-radius: 6px !important;
      background: transparent !important;
      opacity: 1 !important;
    }}
    html[data-codex-compass-theme] [data-codex-theme-project-menu-action] svg {{
      width: 18px !important;
      height: 18px !important;
      flex: 0 0 18px !important;
      color: var(--cc-theme-muted) !important;
      stroke: currentColor !important;
      opacity: 1 !important;
    }}
    html[data-codex-compass-theme] [data-codex-theme-project-menu-action]:is(:hover, :focus-visible, [data-highlighted]) {{
      color: var(--cc-theme-text) !important;
      background: color-mix(in srgb, var(--cc-theme-accent-soft) 82%, var(--cc-theme-surface)) !important;
      outline: none !important;
    }}
    html[data-codex-compass-theme] [data-codex-theme-project-menu-action="archive"]:is(:hover, :focus-visible, [data-highlighted]) svg {{
      color: var(--cc-theme-accent) !important;
    }}
    html[data-codex-compass-theme] [data-codex-theme-project-rename-dialog="true"] {{
      position: fixed !important;
      z-index: 2147483002 !important;
      inset: auto !important;
      top: 50% !important;
      left: 50% !important;
      right: auto !important;
      bottom: auto !important;
      transform: translate(-50%, -50%) !important;
      width: min(520px, calc(100vw - 40px)) !important;
      min-width: 0 !important;
      max-width: 520px !important;
      max-height: calc(100dvh - 40px) !important;
      margin: 0 !important;
      padding: 24px !important;
      overflow: auto !important;
      color: var(--cc-theme-text) !important;
      background: var(--cc-theme-surface) !important;
      border: 1px solid var(--cc-theme-border) !important;
      border-radius: 8px !important;
      box-shadow: 0 24px 72px color-mix(in srgb, var(--cc-theme-text) 24%, transparent) !important;
      opacity: 1 !important;
      backdrop-filter: none !important;
      pointer-events: auto !important;
    }}
    html[data-codex-compass-theme] [data-codex-theme-project-rename-dialog="true"] [data-codex-theme-project-rename-field="true"] {{
      width: 100% !important;
      min-height: 44px !important;
      margin-top: 16px !important;
      padding: 9px 12px !important;
      color: var(--cc-theme-text) !important;
      background: var(--cc-theme-surface-alt) !important;
      border: 1px solid var(--cc-theme-border) !important;
      border-radius: 7px !important;
      outline: none !important;
      opacity: 1 !important;
    }}
    html[data-codex-compass-theme] [data-codex-theme-project-rename-dialog="true"] [data-codex-theme-project-rename-field="true"]:focus {{
      border-color: var(--cc-theme-accent) !important;
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--cc-theme-accent) 18%, transparent) !important;
    }}
    html[data-codex-compass-theme] [data-codex-theme-project-rename-actions="true"] {{
      display: flex !important;
      align-items: center !important;
      justify-content: flex-end !important;
      flex-wrap: nowrap !important;
      gap: 10px !important;
      margin-top: 16px !important;
    }}
    html[data-codex-compass-theme] [data-codex-theme-project-rename-action] {{
      min-width: 82px !important;
      min-height: 38px !important;
      padding: 7px 14px !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      border: 1px solid var(--cc-theme-border) !important;
      border-radius: 7px !important;
      color: var(--cc-theme-text) !important;
      background: var(--cc-theme-surface-alt) !important;
      opacity: 1 !important;
    }}
    html[data-codex-compass-theme] [data-codex-theme-project-rename-action="save"] {{
      color: ${{onAccent}} !important;
      background: var(--cc-theme-accent) !important;
      border-color: var(--cc-theme-accent) !important;
    }}
    html[data-codex-compass-theme] [data-codex-theme-project-rename-action="close"] {{
      position: absolute !important;
      top: 12px !important;
      right: 12px !important;
      width: 32px !important;
      min-width: 32px !important;
      height: 32px !important;
      min-height: 32px !important;
      padding: 0 !important;
      border: 0 !important;
      border-radius: 6px !important;
      background: transparent !important;
      font-size: 18px !important;
      line-height: 1 !important;
    }}
    html[data-codex-compass-theme] [data-codex-theme-project-rename-action="close"] svg {{
      width: 18px !important;
      height: 18px !important;
      display: block !important;
    }}
    textarea,
    input,
    [contenteditable="true"] {{
      color: var(--cc-theme-text) !important;
      caret-color: var(--cc-theme-accent) !important;
      background: color-mix(in srgb, var(--cc-theme-surface) 88%, transparent) !important;
      border-color: var(--cc-theme-border) !important;
      border-radius: var(--cc-theme-radius) !important;
    }}
    button:not(:where(
      [role="dialog"][aria-label="图片预览"] *,
      [role="dialog"][aria-label="Image preview"] *
    )),
    [role="button"]:not(:where(
      [role="dialog"][aria-label="图片预览"] *,
      [role="dialog"][aria-label="Image preview"] *
    )) {{
      border-color: var(--cc-theme-border) !important;
      border-radius: min(var(--cc-theme-radius), 12px) !important;
    }}
    button:not(:where(
      [role="dialog"][aria-label="图片预览"] *,
      [role="dialog"][aria-label="Image preview"] *
    )):hover,
    [role="button"]:not(:where(
      [role="dialog"][aria-label="图片预览"] *,
      [role="dialog"][aria-label="Image preview"] *
    )):hover {{
      background-color: color-mix(in srgb, var(--cc-theme-accent-soft) 72%, transparent) !important;
    }}
    .cc-theme-shell-window-control {{
      position: relative !important;
      z-index: 2147482000 !important;
      width: 28px !important;
      min-width: 28px !important;
      max-width: 28px !important;
      min-height: 30px !important;
      color: var(--cc-theme-text) !important;
      border: 0 !important;
      border-radius: 0 !important;
      background: transparent !important;
      box-shadow: none !important;
      opacity: 1 !important;
      filter: none !important;
      backdrop-filter: none !important;
      pointer-events: auto !important;
    }}
    .cc-theme-shell-window-control svg,
    .cc-theme-shell-window-control path,
    .cc-theme-shell-window-control span {{
      color: currentColor !important;
      stroke: currentColor !important;
      opacity: 1 !important;
      filter: none !important;
    }}
    .cc-theme-shell-window-minimize:hover,
    .cc-theme-shell-window-maximize:hover {{
      color: var(--cc-theme-text) !important;
      background: color-mix(in srgb, var(--cc-theme-accent-soft) 86%, var(--cc-theme-surface)) !important;
    }}
    .cc-theme-shell-window-close:hover {{
      color: #ffffff !important;
      background: #d92d20 !important;
    }}
    a, [data-state="active"], [aria-current="page"] {{
      color: var(--cc-theme-accent) !important;
    }}
    hr, [class*="separator"], [class*="Separator"] {{
      border-color: var(--cc-theme-border) !important;
      background-color: var(--cc-theme-border) !important;
    }}
    pre,
    code,
    .monaco-editor,
    .monaco-editor .margin,
    .monaco-editor-background,
    [data-slot="code-block"],
    [data-testid*="code-block"],
    [data-testid*="diff"],
    [data-testid*="terminal"] {{
      color: var(--cc-theme-text) !important;
      background-color: var(--cc-theme-surface-alt) !important;
      border-color: var(--cc-theme-border) !important;
      backdrop-filter: none !important;
      opacity: 1 !important;
    }}
    pre code {{
      background: transparent !important;
    }}
    .cc-theme-showcase-host {{
      position: relative !important;
      width: calc(100% - 48px) !important;
      max-width: 1180px !important;
      min-height: clamp(410px, 42cqw, 520px) !important;
      height: auto !important;
      flex: 0 0 auto !important;
      padding: 0 !important;
      overflow: visible !important;
      border: 0 !important;
      background: transparent !important;
      box-shadow: none !important;
    }}
    .cc-theme-showcase-host > :not(.cc-theme-showcase) {{
      display: none !important;
    }}
    .cc-theme-showcase {{
      position: relative;
      isolation: isolate;
      box-sizing: border-box;
      width: 100%;
      min-height: clamp(410px, 42cqw, 520px);
      display: grid;
      grid-template-rows: minmax(0, 1fr) auto;
      gap: 22px;
      padding: clamp(30px, 4cqw, 48px) clamp(24px, 4cqw, 48px) 26px;
      overflow: hidden;
      color: var(--cc-theme-text);
      border: 1px solid color-mix(in srgb, var(--cc-theme-border) 88%, transparent);
      border-radius: max(14px, var(--cc-theme-radius));
      background-color: color-mix(in srgb, var(--cc-theme-surface) 78%, transparent);
      background-image: var(--cc-showcase-hero, none);
      background-position: var(--cc-showcase-position);
      background-repeat: no-repeat;
      background-size: cover;
      box-shadow: 0 20px 52px color-mix(in srgb, var(--cc-theme-text) 14%, transparent);
    }}
    .cc-theme-showcase::before {{
      content: "";
      position: absolute;
      z-index: -1;
      inset: 0;
      pointer-events: none;
      background:
        linear-gradient(90deg,
          color-mix(in srgb, var(--cc-theme-surface) 96%, transparent) 0%,
          color-mix(in srgb, var(--cc-theme-surface) 84%, transparent) 42%,
          color-mix(in srgb, var(--cc-theme-surface) 16%, transparent) 72%,
          transparent 100%);
    }}
    .cc-theme-showcase::after {{
      content: "";
      position: absolute;
      z-index: -1;
      inset: auto -8% -42% 38%;
      height: 72%;
      pointer-events: none;
      background:
        radial-gradient(circle at 36% 42%, color-mix(in srgb, var(--cc-theme-accent-soft) 70%, transparent) 0 4%, transparent 5%),
        radial-gradient(circle at 58% 58%, color-mix(in srgb, var(--cc-theme-accent) 22%, transparent) 0 7%, transparent 8%),
        radial-gradient(ellipse at center, color-mix(in srgb, var(--cc-theme-accent-soft) 46%, transparent), transparent 68%);
      filter: blur(2px);
      opacity: .85;
    }}
    .cc-theme-showcase-copy {{
      position: relative;
      z-index: 2;
      width: min(58%, 620px);
      align-self: center;
    }}
    .cc-theme-showcase.has-portrait .cc-theme-showcase-copy {{
      width: min(54%, 560px);
    }}
    .cc-theme-showcase-eyebrow {{
      display: block;
      margin-bottom: 14px;
      color: var(--cc-theme-accent);
      font-size: 12px;
      line-height: 1.4;
      font-weight: 750;
    }}
    .cc-theme-showcase-title {{
      margin: 0;
      color: var(--cc-theme-text);
      font-size: clamp(28px, 3.5cqw, 46px);
      line-height: 1.12;
      font-weight: 720;
      letter-spacing: 0;
      text-wrap: balance;
    }}
    .cc-theme-showcase-subtitle {{
      max-width: 560px;
      margin: 14px 0 0;
      color: color-mix(in srgb, var(--cc-theme-muted) 92%, transparent);
      font-size: 14px;
      line-height: 1.65;
      font-weight: 500;
      text-wrap: balance;
    }}
    .cc-theme-showcase-portrait {{
      position: absolute;
      z-index: 1;
      top: 2%;
      right: 1%;
      width: min(42%, 470px);
      height: 70%;
      object-fit: contain;
      object-position: right bottom;
      pointer-events: none;
      filter: drop-shadow(0 18px 28px color-mix(in srgb, var(--cc-theme-text) 16%, transparent));
    }}
    .cc-theme-showcase-cards {{
      position: relative;
      z-index: 3;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }}
    .cc-theme-showcase-card {{
      position: relative;
      min-width: 0;
      min-height: 124px;
      padding: 16px 14px !important;
      display: grid !important;
      grid-template-columns: 44px minmax(0, 1fr) 18px;
      grid-template-rows: auto;
      align-items: center;
      gap: 11px;
      color: var(--cc-theme-text) !important;
      text-align: left;
      border: 1px solid color-mix(in srgb, var(--cc-theme-border) 82%, transparent) !important;
      border-radius: min(max(12px, var(--cc-theme-radius)), 18px) !important;
      background: color-mix(in srgb, var(--cc-theme-surface) 88%, transparent) !important;
      box-shadow: 0 8px 22px color-mix(in srgb, var(--cc-theme-text) 9%, transparent);
      backdrop-filter: blur(max(8px, var(--cc-theme-blur)));
      transition: transform 160ms ease, border-color 160ms ease, background-color 160ms ease;
    }}
    .cc-theme-showcase-card:hover {{
      transform: translateY(-2px);
      color: var(--cc-theme-text) !important;
      border-color: color-mix(in srgb, var(--cc-theme-accent) 60%, var(--cc-theme-border)) !important;
      background: color-mix(in srgb, var(--cc-theme-accent-soft) 58%, var(--cc-theme-surface)) !important;
    }}
    .cc-theme-showcase-card:focus-visible {{
      outline: 2px solid color-mix(in srgb, var(--cc-theme-accent) 72%, transparent);
      outline-offset: 2px;
    }}
    .cc-theme-showcase-card-icon {{
      width: 40px;
      height: 40px;
      display: grid;
      place-items: center;
      border-radius: 50%;
      color: var(--cc-theme-accent);
      background: color-mix(in srgb, var(--cc-theme-accent-soft) 78%, transparent);
      box-shadow: 0 0 0 5px color-mix(in srgb, var(--cc-theme-accent-soft) 34%, transparent);
    }}
    .cc-theme-showcase-card-icon svg {{
      width: 21px;
      height: 21px;
      stroke: currentColor;
      stroke-width: 1.9;
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
    }}
    .cc-theme-showcase-card-label {{
      display: block;
      overflow-wrap: anywhere;
      font-size: 13px;
      line-height: 1.45;
      font-weight: 720;
    }}
    .cc-theme-showcase-card-copy {{
      min-width: 0;
      align-self: center;
    }}
    .cc-theme-showcase-card-description {{
      display: -webkit-box;
      margin-top: 5px;
      overflow: hidden;
      color: color-mix(in srgb, var(--cc-theme-muted) 84%, transparent);
      font-size: 10px;
      font-weight: 500;
      line-height: 1.5;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
    }}
    .cc-theme-showcase-card-index {{
      position: absolute;
      top: 8px;
      right: 9px;
      color: color-mix(in srgb, var(--cc-theme-accent) 62%, transparent);
      font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace;
      font-size: 9px;
      font-variant-numeric: tabular-nums;
      font-weight: 800;
    }}
    .cc-theme-showcase-card-arrow {{
      width: 18px;
      height: 18px;
      display: grid;
      place-items: center;
      align-self: end;
      justify-self: end;
      color: ${{onAccent}};
      border-radius: 50%;
      background: var(--cc-theme-accent);
      box-shadow: 0 4px 10px color-mix(in srgb, var(--cc-theme-accent) 22%, transparent);
    }}
    .cc-theme-showcase-card-arrow svg {{
      width: 11px;
      height: 11px;
      fill: none;
      stroke: currentColor;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-width: 2;
    }}
    .cc-theme-showcase-badge {{
      display: inline-flex;
      width: fit-content;
      margin-top: 18px;
      padding: 6px 10px;
      color: var(--cc-theme-accent);
      border: 1px solid color-mix(in srgb, var(--cc-theme-accent) 34%, var(--cc-theme-border));
      border-radius: 999px;
      background: color-mix(in srgb, var(--cc-theme-surface) 76%, transparent);
      font-size: 11px;
      line-height: 1;
      font-weight: 750;
    }}
    .cc-theme-showcase-motif {{
      position: absolute;
      z-index: 0;
      right: 2.5%;
      top: 5%;
      width: clamp(96px, 13cqw, 170px);
      aspect-ratio: 1;
      pointer-events: none;
      border: 1px solid color-mix(in srgb, var(--cc-theme-accent) 24%, transparent);
      border-radius: 50%;
      opacity: .42;
    }}
    .cc-theme-showcase-motif::before,
    .cc-theme-showcase-motif::after {{
      content: "";
      position: absolute;
      inset: 18%;
      border: 1px dashed color-mix(in srgb, var(--cc-theme-accent) 36%, transparent);
      border-radius: inherit;
      transform: rotate(18deg);
    }}
    .cc-theme-showcase-motif::after {{
      inset: 38%;
      border-style: solid;
      background: color-mix(in srgb, var(--cc-theme-accent-soft) 42%, transparent);
      transform: none;
    }}
    .cc-theme-showcase-brandline {{
      position: absolute;
      z-index: 4;
      top: 16px;
      left: 24px;
      right: 24px;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 9px;
      pointer-events: none;
    }}
    .cc-theme-showcase-brandmark {{
      width: 28px;
      height: 28px;
      display: grid;
      flex: 0 0 auto;
      place-items: center;
      color: var(--cc-theme-accent);
      border: 1px solid color-mix(in srgb, var(--cc-theme-accent) 34%, var(--cc-theme-border));
      border-radius: 8px;
      background: color-mix(in srgb, var(--cc-theme-surface) 76%, transparent);
      box-shadow: 0 5px 14px color-mix(in srgb, var(--cc-theme-text) 8%, transparent);
      font-size: 12px;
      font-weight: 850;
    }}
    .cc-theme-showcase-brandcopy {{
      min-width: 0;
      display: grid;
      gap: 1px;
    }}
    .cc-theme-showcase-brandname {{
      overflow: hidden;
      color: var(--cc-theme-text);
      font-size: 11px;
      font-weight: 780;
      line-height: 1.2;
      text-overflow: ellipsis;
      white-space: nowrap;
    }}
    .cc-theme-showcase-brandmeta {{
      overflow: hidden;
      color: color-mix(in srgb, var(--cc-theme-muted) 78%, transparent);
      font-size: 9px;
      font-weight: 600;
      line-height: 1.2;
      text-overflow: ellipsis;
      white-space: nowrap;
    }}
    .cc-theme-showcase-status {{
      position: relative;
      margin-left: auto;
      padding: 5px 9px 5px 18px;
      color: color-mix(in srgb, var(--cc-theme-accent) 72%, var(--cc-theme-text));
      border: 1px solid color-mix(in srgb, var(--cc-theme-accent) 24%, var(--cc-theme-border));
      border-radius: 999px;
      background: color-mix(in srgb, var(--cc-theme-surface) 76%, transparent);
      font-size: 9px;
      font-weight: 720;
      line-height: 1;
      white-space: nowrap;
    }}
    .cc-theme-showcase-status::before {{
      content: "";
      position: absolute;
      width: 6px;
      height: 6px;
      margin: 1px 0 0 -11px;
      border-radius: 50%;
      background: #55a957;
      box-shadow: 0 0 0 3px color-mix(in srgb, #55a957 18%, transparent);
    }}
    .cc-theme-showcase-companion {{
      position: absolute;
      z-index: 2;
      right: 18px;
      bottom: 150px;
      width: 118px;
      min-height: 74px;
      display: grid;
      place-items: end center;
      padding: 10px;
      overflow: hidden;
      pointer-events: none;
      color: var(--cc-theme-text);
      border: 1px solid color-mix(in srgb, var(--cc-theme-accent) 28%, var(--cc-theme-border));
      border-radius: 10px;
      background:
        linear-gradient(180deg, transparent 24%, color-mix(in srgb, var(--cc-theme-surface) 92%, transparent) 88%),
        var(--cc-showcase-hero, none) right 34% / 340% auto no-repeat,
        color-mix(in srgb, var(--cc-theme-surface-alt) 82%, transparent);
      box-shadow: 0 12px 28px color-mix(in srgb, var(--cc-theme-text) 16%, transparent);
    }}
    .cc-theme-showcase-companion-mark {{
      position: absolute;
      inset: 8px auto auto 8px;
      width: 24px;
      height: 24px;
      display: grid;
      place-items: center;
      color: ${{onAccent}};
      border-radius: 7px;
      background: color-mix(in srgb, var(--cc-theme-accent) 88%, transparent);
      font-size: 11px;
      font-weight: 850;
    }}
    .cc-theme-showcase-companion-label {{
      position: relative;
      z-index: 1;
      width: 100%;
      overflow: hidden;
      padding: 4px 6px;
      color: var(--cc-theme-text);
      border-radius: 5px;
      background: color-mix(in srgb, var(--cc-theme-surface) 78%, transparent);
      font-size: 9px;
      font-weight: 720;
      line-height: 1.25;
      text-align: center;
      text-overflow: ellipsis;
      white-space: nowrap;
    }}
    .cc-theme-showcase.cards-paper .cc-theme-showcase-card {{
      background: color-mix(in srgb, var(--cc-theme-surface) 94%, #ffffff 18%) !important;
      box-shadow: 0 10px 24px color-mix(in srgb, var(--cc-theme-text) 10%, transparent);
      backdrop-filter: none;
    }}
    .cc-theme-showcase.cards-solid .cc-theme-showcase-card {{
      background: var(--cc-theme-surface) !important;
      box-shadow: 0 10px 24px color-mix(in srgb, var(--cc-theme-text) 12%, transparent);
      backdrop-filter: none;
    }}
    .cc-theme-showcase.cards-outline .cc-theme-showcase-card {{
      border-width: 2px !important;
      background: color-mix(in srgb, var(--cc-theme-surface) 72%, transparent) !important;
      box-shadow: none;
    }}
    .cc-theme-showcase-composer {{
      border-color: color-mix(in srgb, var(--cc-theme-accent) 30%, var(--cc-theme-border)) !important;
      box-shadow:
        0 14px 34px color-mix(in srgb, var(--cc-theme-text) 12%, transparent),
        inset 0 0 0 1px color-mix(in srgb, var(--cc-theme-accent-soft) 46%, transparent) !important;
      background:
        radial-gradient(circle at 18% 100%, color-mix(in srgb, var(--cc-theme-accent-soft) 42%, transparent), transparent 26%),
        color-mix(in srgb, var(--cc-theme-surface) 92%, transparent) !important;
    }}
    .cc-theme-shell-composer {{
      position: relative !important;
      isolation: isolate;
      overflow: hidden !important;
      color: var(--cc-theme-text) !important;
      border: 1px solid color-mix(in srgb, var(--cc-theme-accent) 32%, var(--cc-theme-border)) !important;
      border-radius: min(max(12px, var(--cc-theme-radius)), 18px) !important;
      background:
        linear-gradient(135deg,
          color-mix(in srgb, var(--cc-theme-accent-soft) 18%, transparent),
          transparent 42%),
        color-mix(in srgb, var(--cc-theme-surface) 94%, transparent) !important;
      box-shadow:
        0 16px 38px color-mix(in srgb, var(--cc-theme-text) 13%, transparent),
        inset 0 0 0 1px color-mix(in srgb, #ffffff 16%, transparent) !important;
      backdrop-filter: blur(max(14px, var(--cc-theme-blur))) saturate(1.06) !important;
    }}
    .cc-theme-shell-composer::before {{
      content: attr(data-cc-theme-mark);
      position: absolute;
      z-index: 0;
      top: 10px;
      right: 12px;
      width: 28px;
      height: 28px;
      display: grid;
      place-items: center;
      pointer-events: none;
      color: color-mix(in srgb, var(--cc-theme-accent) 54%, transparent);
      border: 1px solid color-mix(in srgb, var(--cc-theme-accent) 18%, transparent);
      border-radius: 8px;
      background: color-mix(in srgb, var(--cc-theme-accent-soft) 30%, transparent);
      font-size: 11px;
      font-weight: 820;
      opacity: .62;
    }}
    .cc-theme-shell-composer::after {{
      content: "";
      position: absolute;
      z-index: 0;
      right: 0;
      bottom: 0;
      width: 130px;
      height: 2px;
      pointer-events: none;
      background: linear-gradient(90deg, transparent, var(--cc-theme-accent));
      opacity: .55;
    }}
    .cc-theme-shell-composer textarea,
    .cc-theme-shell-composer input,
    .cc-theme-shell-composer [contenteditable="true"] {{
      position: relative;
      z-index: 1;
      color: var(--cc-theme-text) !important;
      background: transparent !important;
      border-color: transparent !important;
    }}
    .cc-theme-shell-composer button,
    .cc-theme-shell-composer [role="button"] {{
      position: relative;
      z-index: 2;
      color: color-mix(in srgb, var(--cc-theme-text) 90%, transparent) !important;
    }}
    .cc-theme-shell-composer .cc-theme-shell-model-button {{
      min-height: 26px !important;
      padding-inline: 9px !important;
      color: color-mix(in srgb, var(--cc-theme-accent) 72%, var(--cc-theme-text)) !important;
      border-color: color-mix(in srgb, var(--cc-theme-accent) 24%, var(--cc-theme-border)) !important;
      background: color-mix(in srgb, var(--cc-theme-surface-alt) 68%, transparent) !important;
      font-size: 10px !important;
      font-weight: 700 !important;
    }}
    .cc-theme-shell-composer .cc-theme-shell-send-button {{
      width: 32px !important;
      min-width: 32px !important;
      height: 32px !important;
      color: ${{onAccent}} !important;
      border-color: color-mix(in srgb, var(--cc-theme-accent) 78%, transparent) !important;
      border-radius: 50% !important;
      background: var(--cc-theme-accent) !important;
      box-shadow: 0 6px 14px color-mix(in srgb, var(--cc-theme-accent) 25%, transparent) !important;
    }}
    .cc-theme-shell-composer .cc-theme-shell-stop-button {{
      color: #ffffff !important;
      border-color: color-mix(in srgb, #c64747 78%, transparent) !important;
      background: #c64747 !important;
      box-shadow: 0 6px 14px color-mix(in srgb, #c64747 25%, transparent) !important;
    }}
    .cc-theme-shell-composer .cc-theme-shell-attach-button {{
      color: color-mix(in srgb, var(--cc-theme-accent) 70%, var(--cc-theme-text)) !important;
      border-color: color-mix(in srgb, var(--cc-theme-accent) 22%, transparent) !important;
      background: color-mix(in srgb, var(--cc-theme-accent-soft) 40%, transparent) !important;
    }}
    html[data-codex-compass-theme="rose-garden"] .cc-theme-showcase-host {{
      min-height: clamp(510px, 44cqw, 570px) !important;
    }}
    .cc-theme-showcase.theme-rose-garden {{
      min-height: clamp(510px, 44cqw, 570px);
      grid-template-rows: minmax(300px, 1fr) auto;
      gap: 0;
      padding: clamp(38px, 4.4cqw, 58px) clamp(24px, 3.2cqw, 38px) 26px;
      border-color: color-mix(in srgb, var(--cc-theme-accent) 28%, var(--cc-theme-border));
      border-radius: 10px;
      background-position: center right;
      box-shadow:
        0 24px 58px color-mix(in srgb, #7d3145 18%, transparent),
        inset 0 0 0 1px color-mix(in srgb, #ffffff 58%, transparent);
    }}
    .cc-theme-showcase.theme-rose-garden::before {{
      background:
        linear-gradient(90deg,
          color-mix(in srgb, #fffafa 98%, transparent) 0%,
          color-mix(in srgb, #fffafa 94%, transparent) 38%,
          color-mix(in srgb, #fffafa 62%, transparent) 54%,
          color-mix(in srgb, #fffafa 12%, transparent) 72%,
          transparent 100%);
    }}
    .cc-theme-showcase.theme-rose-garden::after {{
      display: none;
    }}
    .cc-theme-showcase.theme-rose-garden .cc-theme-showcase-copy {{
      width: min(49%, 540px);
      align-self: start;
      margin-top: clamp(24px, 3.2cqw, 48px);
    }}
    .cc-theme-showcase.theme-rose-garden .cc-theme-showcase-eyebrow {{
      width: fit-content;
      margin-bottom: 18px;
      padding-bottom: 7px;
      border-bottom: 1px solid color-mix(in srgb, var(--cc-theme-accent) 28%, transparent);
      font-size: 13px;
    }}
    .cc-theme-showcase.theme-rose-garden .cc-theme-showcase-title {{
      max-width: 520px;
      font-family: Georgia, "Noto Serif SC", "Microsoft YaHei", serif;
      font-size: clamp(34px, 4.1cqw, 52px);
      font-weight: 650;
    }}
    .cc-theme-showcase.theme-rose-garden .cc-theme-showcase-subtitle {{
      max-width: 480px;
      margin-top: 18px;
      font-size: 15px;
    }}
    .cc-theme-showcase.theme-rose-garden .cc-theme-showcase-cards {{
      margin-top: -50px;
      gap: 12px;
    }}
    .cc-theme-showcase.theme-rose-garden .cc-theme-showcase-card {{
      min-height: 132px;
      padding: 16px 12px !important;
      border-radius: 8px !important;
      border-color: color-mix(in srgb, var(--cc-theme-accent) 24%, #ffffff) !important;
      background:
        linear-gradient(180deg,
          color-mix(in srgb, #ffffff 94%, transparent),
          color-mix(in srgb, #fff8f9 90%, transparent)) !important;
      box-shadow:
        0 12px 28px color-mix(in srgb, #7d3145 15%, transparent),
        inset 0 0 0 1px color-mix(in srgb, #ffffff 70%, transparent);
    }}
    .cc-theme-showcase.theme-rose-garden .cc-theme-showcase-card-icon {{
      width: 44px;
      height: 44px;
      background: color-mix(in srgb, var(--cc-theme-accent-soft) 88%, #ffffff);
      box-shadow:
        0 0 0 6px color-mix(in srgb, var(--cc-theme-accent-soft) 34%, transparent),
        0 6px 14px color-mix(in srgb, var(--cc-theme-accent) 14%, transparent);
    }}
    html[data-codex-compass-showcase="rose-garden"] .cc-theme-showcase-composer {{
      position: relative !important;
      overflow: hidden !important;
      border-color: color-mix(in srgb, var(--cc-theme-accent) 38%, var(--cc-theme-border)) !important;
      background:
        linear-gradient(180deg,
          color-mix(in srgb, #ffffff 94%, transparent),
          color-mix(in srgb, #fff7f9 91%, transparent)) !important;
    }}
    html[data-codex-compass-showcase="rose-garden"] .cc-theme-showcase-composer::after {{
      content: "✿";
      position: absolute;
      right: 18px;
      bottom: 8px;
      pointer-events: none;
      color: var(--cc-theme-accent);
      font-size: 28px;
      line-height: 1;
      opacity: .12;
    }}
    html[data-codex-compass-theme="starlight-stage"] .cc-theme-showcase-host {{
      min-height: clamp(520px, 45cqw, 580px) !important;
    }}
    .cc-theme-showcase.theme-starlight-stage {{
      min-height: clamp(520px, 45cqw, 580px);
      grid-template-rows: minmax(310px, 1fr) auto;
      gap: 0;
      padding: clamp(40px, 4.6cqw, 60px) clamp(24px, 3.2cqw, 38px) 26px;
      border-color: color-mix(in srgb, var(--cc-theme-accent) 34%, var(--cc-theme-border));
      border-radius: 10px;
      background-position: center right;
      box-shadow:
        0 26px 62px color-mix(in srgb, #02030c 62%, transparent),
        0 0 42px color-mix(in srgb, var(--cc-theme-accent) 10%, transparent),
        inset 0 0 0 1px color-mix(in srgb, #ffffff 8%, transparent);
    }}
    .cc-theme-showcase.theme-starlight-stage::before {{
      background:
        linear-gradient(90deg,
          color-mix(in srgb, #070817 98%, transparent) 0%,
          color-mix(in srgb, #070817 94%, transparent) 38%,
          color-mix(in srgb, #070817 68%, transparent) 55%,
          color-mix(in srgb, #070817 14%, transparent) 74%,
          transparent 100%);
    }}
    .cc-theme-showcase.theme-starlight-stage::after {{
      display: none;
    }}
    .cc-theme-showcase.theme-starlight-stage .cc-theme-showcase-copy {{
      width: min(48%, 530px);
      align-self: start;
      margin-top: clamp(26px, 3.4cqw, 50px);
    }}
    .cc-theme-showcase.theme-starlight-stage .cc-theme-showcase-eyebrow {{
      width: fit-content;
      margin-bottom: 18px;
      padding: 6px 10px;
      color: #ff86b4;
      border: 1px solid color-mix(in srgb, var(--cc-theme-accent) 36%, transparent);
      border-radius: 999px;
      background: color-mix(in srgb, #120b23 78%, transparent);
      box-shadow: 0 0 18px color-mix(in srgb, var(--cc-theme-accent) 12%, transparent);
    }}
    .cc-theme-showcase.theme-starlight-stage .cc-theme-showcase-title {{
      max-width: 520px;
      color: #fff9fd;
      font-size: clamp(36px, 4.2cqw, 54px);
      font-weight: 720;
      text-shadow: 0 8px 26px color-mix(in srgb, #000000 72%, transparent);
    }}
    .cc-theme-showcase.theme-starlight-stage .cc-theme-showcase-subtitle {{
      max-width: 470px;
      margin-top: 18px;
      color: color-mix(in srgb, #f5e8f1 82%, transparent);
      font-size: 15px;
    }}
    .cc-theme-showcase.theme-starlight-stage .cc-theme-showcase-cards {{
      margin-top: -52px;
      gap: 12px;
    }}
    .cc-theme-showcase.theme-starlight-stage .cc-theme-showcase-card {{
      min-height: 132px;
      padding: 16px 12px !important;
      color: #fff8fc !important;
      border-radius: 8px !important;
      border-color: color-mix(in srgb, var(--cc-theme-accent) 32%, #2c2844) !important;
      background:
        linear-gradient(180deg,
          color-mix(in srgb, #1a1931 88%, transparent),
          color-mix(in srgb, #0d1024 91%, transparent)) !important;
      box-shadow:
        0 14px 30px color-mix(in srgb, #02030c 54%, transparent),
        inset 0 0 0 1px color-mix(in srgb, #ffffff 7%, transparent);
      backdrop-filter: blur(max(12px, var(--cc-theme-blur)));
    }}
    .cc-theme-showcase.theme-starlight-stage .cc-theme-showcase-card:hover {{
      color: #ffffff !important;
      border-color: color-mix(in srgb, var(--cc-theme-accent) 72%, #5d3c72) !important;
      background:
        linear-gradient(180deg,
          color-mix(in srgb, #30203f 88%, transparent),
          color-mix(in srgb, #17142d 92%, transparent)) !important;
    }}
    .cc-theme-showcase.theme-starlight-stage .cc-theme-showcase-card-icon {{
      width: 44px;
      height: 44px;
      color: #ff86b4;
      background: color-mix(in srgb, #3d1c3d 88%, transparent);
      box-shadow:
        0 0 0 6px color-mix(in srgb, var(--cc-theme-accent) 11%, transparent),
        0 0 22px color-mix(in srgb, var(--cc-theme-accent) 22%, transparent);
    }}
    html[data-codex-compass-showcase="starlight-stage"] .cc-theme-showcase-composer {{
      position: relative !important;
      overflow: hidden !important;
      border-color: color-mix(in srgb, var(--cc-theme-accent) 46%, var(--cc-theme-border)) !important;
      background:
        linear-gradient(180deg,
          color-mix(in srgb, #17172d 94%, transparent),
          color-mix(in srgb, #0c0e20 94%, transparent)) !important;
      box-shadow:
        0 16px 38px color-mix(in srgb, #02030c 58%, transparent),
        0 0 22px color-mix(in srgb, var(--cc-theme-accent) 10%, transparent) !important;
    }}
    html[data-codex-compass-showcase="starlight-stage"] .cc-theme-showcase-composer::after {{
      content: "✦";
      position: absolute;
      right: 18px;
      bottom: 8px;
      pointer-events: none;
      color: #ff86b4;
      font-size: 25px;
      line-height: 1;
      opacity: .18;
    }}
    .cc-theme-showcase.layout-editorial,
    .cc-theme-showcase.layout-paper {{
      min-height: clamp(510px, 44cqw, 570px);
      grid-template-rows: minmax(300px, 1fr) auto;
      gap: 0;
      border-radius: 10px;
      background-position: var(--cc-showcase-position);
    }}
    .cc-theme-showcase.layout-editorial::before,
    .cc-theme-showcase.layout-paper::before {{
      background: linear-gradient(90deg,
        color-mix(in srgb, var(--cc-theme-surface) 98%, transparent) 0%,
        color-mix(in srgb, var(--cc-theme-surface) var(--cc-theme-overlay-strength), transparent) 42%,
        color-mix(in srgb, var(--cc-theme-surface) 36%, transparent) 62%,
        transparent 82%);
    }}
    .cc-theme-showcase.layout-paper .cc-theme-showcase-copy,
    .cc-theme-showcase.layout-editorial .cc-theme-showcase-copy {{
      width: min(50%, 540px);
      align-self: start;
      margin-top: clamp(24px, 3.2cqw, 48px);
    }}
    .cc-theme-showcase.layout-editorial .cc-theme-showcase-title,
    .cc-theme-showcase.layout-paper .cc-theme-showcase-title {{
      font-family: Georgia, "Noto Serif SC", "Microsoft YaHei", serif;
      font-size: clamp(34px, 4cqw, 52px);
      font-weight: 650;
    }}
    .cc-theme-showcase.layout-editorial .cc-theme-showcase-cards,
    .cc-theme-showcase.layout-paper .cc-theme-showcase-cards {{
      margin-top: -46px;
      gap: 12px;
    }}
    .cc-theme-showcase.layout-fortune {{
      min-height: clamp(500px, 43cqw, 560px);
      grid-template-rows: minmax(290px, 1fr) auto;
      gap: 0;
      border-color: color-mix(in srgb, #b72d22 26%, var(--cc-theme-border));
      background-position: var(--cc-showcase-position);
    }}
    .cc-theme-showcase.layout-fortune::before {{
      background: linear-gradient(90deg,
        color-mix(in srgb, #fff8e8 98%, transparent) 0%,
        color-mix(in srgb, #fff8e8 var(--cc-theme-overlay-strength), transparent) 44%,
        color-mix(in srgb, #fff8e8 24%, transparent) 70%,
        transparent 86%);
    }}
    .cc-theme-showcase.layout-fortune .cc-theme-showcase-copy {{
      width: min(52%, 590px);
      align-self: start;
      margin-top: clamp(24px, 3cqw, 46px);
    }}
    .cc-theme-showcase.layout-fortune .cc-theme-showcase-title {{
      color: #8f2118;
      font-family: Georgia, "Noto Serif SC", "Microsoft YaHei", serif;
      font-size: clamp(34px, 4.1cqw, 52px);
    }}
    .cc-theme-showcase.layout-fortune .cc-theme-showcase-cards {{
      margin-top: -42px;
      gap: 12px;
    }}
    .cc-theme-showcase.layout-fortune .cc-theme-showcase-card:nth-child(even) .cc-theme-showcase-card-icon {{
      color: #3f7b43;
      background: #e0ecd4;
    }}
    .cc-theme-showcase.layout-future {{
      min-height: clamp(480px, 41cqw, 545px);
      grid-template-rows: minmax(275px, 1fr) auto;
      gap: 0;
      border-radius: 8px;
      background-position: var(--cc-showcase-position);
    }}
    .cc-theme-showcase.layout-future::before {{
      background: linear-gradient(90deg,
        color-mix(in srgb, #fffafa 98%, transparent) 0%,
        color-mix(in srgb, #fffafa var(--cc-theme-overlay-strength), transparent) 43%,
        color-mix(in srgb, #fffafa 18%, transparent) 70%,
        transparent 86%);
    }}
    .cc-theme-showcase.layout-future .cc-theme-showcase-copy {{
      width: min(54%, 640px);
      align-self: center;
    }}
    .cc-theme-showcase.layout-future .cc-theme-showcase-title {{
      max-width: 650px;
      color: #171717;
      font-size: clamp(38px, 4.4cqw, 58px);
      font-weight: 790;
    }}
    .cc-theme-showcase.layout-future .cc-theme-showcase-cards {{
      margin-top: -32px;
      gap: 12px;
    }}
    .cc-theme-showcase.layout-doodle {{
      min-height: clamp(500px, 43cqw, 565px);
      grid-template-rows: minmax(292px, 1fr) auto;
      gap: 0;
      border: 2px solid color-mix(in srgb, #12a890 54%, var(--cc-theme-border));
      background-position: var(--cc-showcase-position);
    }}
    .cc-theme-showcase.layout-doodle::before {{
      background: linear-gradient(90deg,
        color-mix(in srgb, #fffdf3 98%, transparent) 0%,
        color-mix(in srgb, #fffdf3 var(--cc-theme-overlay-strength), transparent) 44%,
        color-mix(in srgb, #fffdf3 18%, transparent) 70%,
        transparent 86%);
    }}
    .cc-theme-showcase.layout-doodle .cc-theme-showcase-copy {{
      width: min(53%, 620px);
      align-self: start;
      margin-top: 20px;
    }}
    .cc-theme-showcase.layout-doodle .cc-theme-showcase-title {{
      font-size: clamp(34px, 4.1cqw, 52px);
      font-weight: 780;
    }}
    .cc-theme-showcase.layout-doodle .cc-theme-showcase-cards {{
      margin-top: -34px;
      gap: 12px;
    }}
    .cc-theme-showcase.layout-doodle .cc-theme-showcase-card:nth-child(1) {{ border-color: #ef765d !important; }}
    .cc-theme-showcase.layout-doodle .cc-theme-showcase-card:nth-child(2) {{ border-color: #12a890 !important; }}
    .cc-theme-showcase.layout-doodle .cc-theme-showcase-card:nth-child(3) {{ border-color: #37a9dc !important; }}
    .cc-theme-showcase.layout-doodle .cc-theme-showcase-card:nth-child(4) {{ border-color: #efbd31 !important; }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-sidebar {{
      border-right-color: color-mix(in srgb, #12a890 28%, #b7ddd4) !important;
      background: #fffef8 !important;
      box-shadow: 8px 0 24px color-mix(in srgb, #24302d 6%, transparent);
      backdrop-filter: none !important;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-sidebar::before {{
      background:
        linear-gradient(145deg, color-mix(in srgb, #d3f3ea 30%, transparent), transparent 28%),
        linear-gradient(18deg, transparent 88%, color-mix(in srgb, #f2c84b 12%, transparent) 88%);
      opacity: .72;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-sidebar::after {{
      display: none;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-product-button {{
      min-height: 58px !important;
      padding: 10px 42px 8px 14px !important;
      color: #0f8f7c !important;
      border-color: transparent !important;
      background: transparent !important;
      box-shadow: none !important;
      font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif !important;
      font-size: 26px !important;
      font-weight: 850 !important;
      letter-spacing: 0 !important;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-product-button::before {{
      display: none;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-product-button::after {{
      content: "✦";
      left: auto;
      right: 20px;
      top: 13px;
      bottom: auto;
      width: auto;
      color: #f2c84b;
      overflow: visible;
      font-size: 17px;
      font-weight: 900;
      line-height: 1;
      text-shadow: 9px 8px 0 #f2c84b;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-search-button {{
      color: #12a890 !important;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-search-button:hover {{
      background: #e7f8f2 !important;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-new-task {{
      min-height: 36px !important;
      color: #26332f !important;
      border-color: transparent !important;
      background: transparent !important;
      box-shadow: none !important;
      font-weight: 650 !important;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-new-task svg {{
      color: #ffffff !important;
      width: 21px !important;
      height: 21px !important;
      padding: 4px !important;
      overflow: visible !important;
      border-radius: 50% !important;
      background: #ef765d !important;
      box-shadow: 0 2px 6px color-mix(in srgb, #ef765d 22%, transparent);
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-new-task:hover {{
      color: #26332f !important;
      background: #fff0eb !important;
      transform: none !important;
      filter: none !important;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-nav-row {{
      min-height: 34px !important;
      color: #33433e !important;
      font-size: 13px !important;
      font-weight: 560 !important;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-nav-row:hover {{
      border-color: transparent !important;
      background: #f0faf6 !important;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-nav-row svg {{
      filter: none !important;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-group-heading {{
      margin-top: 12px !important;
      padding: 8px 8px 4px 18px !important;
      color: #0f907d !important;
      border-top: 1px solid color-mix(in srgb, #12a890 13%, #d7e9e4) !important;
      font-size: 11px !important;
      font-weight: 760 !important;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-group-heading::before {{
      content: "•";
      position: absolute;
      left: 7px;
      top: 7px;
      color: #12a890;
      font-size: 14px;
      line-height: 1;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-project-row {{
      min-height: 31px !important;
      color: #273a34 !important;
      border-color: transparent !important;
      background: transparent !important;
      box-shadow: none !important;
      font-size: 12.5px !important;
      font-weight: 680 !important;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-project-row svg {{
      color: #12a890 !important;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-thread-row {{
      position: relative !important;
      min-height: 29px !important;
      margin-left: 14px !important;
      padding-left: 16px !important;
      color: #465750 !important;
      border: 0 !important;
      background: transparent !important;
      box-shadow: none !important;
      font-size: 12px !important;
      font-weight: 520 !important;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-thread-row::before {{
      content: "";
      position: absolute;
      left: 4px;
      top: 50%;
      width: 6px;
      height: 6px;
      transform: translateY(-50%);
      border: 1.5px solid #12a890;
      border-radius: 50%;
      background: #e8f8ef;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-thread-row:hover {{
      color: #20332d !important;
      background: #f0faf6 !important;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-active-row {{
      color: #1f4f44 !important;
      border-color: transparent !important;
      background: #e8f8ef !important;
      box-shadow: inset 3px 0 0 #12a890 !important;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-active-row::before {{
      border-color: #12a890;
      background: #12a890;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-sidebar {{
      --sidebar-footer-height: 84px;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-sidebar [data-app-action-sidebar-scroll] {{
      scrollbar-gutter: stable;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-account-row {{
      margin-top: 0 !important;
      overflow: visible !important;
      color: #273832 !important;
      border-color: transparent !important;
      background: transparent !important;
      box-shadow: none !important;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-account-row::before {{
      content: "⚡  ENFP 能量值                         100%";
      position: absolute;
      left: 0;
      right: 0;
      top: -38px;
      height: 30px;
      padding: 0 9px;
      display: flex;
      align-items: center;
      overflow: hidden;
      pointer-events: none;
      color: #277669;
      border: 1px solid color-mix(in srgb, #12a890 18%, #b7ddd4);
      border-radius: 8px;
      background: #e8f8ef;
      font-size: 9px;
      font-weight: 760;
      line-height: 1;
      white-space: pre;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-account-row::after {{
      content: "";
      position: absolute;
      left: 10px;
      right: 10px;
      top: -14px;
      height: 3px;
      pointer-events: none;
      border-radius: 2px;
      background: linear-gradient(90deg, #ef765d 0 34%, #f2c84b 34% 67%, #12a890 67% 100%);
      box-shadow: none;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-topbar::after {{
      display: none;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-topbar,
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-sessionbar {{
      color: #26332f !important;
      border-color: #e3ded0 !important;
      background: #fffdf6 !important;
      backdrop-filter: none !important;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-window-control {{
      color: #27332f !important;
      background: transparent !important;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-window-minimize:hover,
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-window-maximize:hover {{
      color: #163f36 !important;
      background: #dff5ee !important;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-window-close:hover {{
      color: #ffffff !important;
      background: #d92d20 !important;
    }}
    .cc-theme-showcase.theme-enfp-doodle {{
      min-height: 620px;
      grid-template-rows: minmax(392px, 1fr) auto;
      gap: 0;
      padding: 46px 40px 26px;
      border: 2px solid color-mix(in srgb, #12a890 42%, #b7ddd4);
      border-radius: 10px;
      background-color: #fff9e9;
      background-position: 86% center;
      font-family: "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
      box-shadow:
        0 22px 52px color-mix(in srgb, #24302d 13%, transparent),
        7px 7px 0 color-mix(in srgb, #d3f3ea 72%, transparent);
    }}
    .cc-theme-showcase.theme-enfp-doodle::before {{
      background:
        linear-gradient(90deg,
          color-mix(in srgb, #fff9e9 99%, transparent) 0%,
          color-mix(in srgb, #fff9e9 95%, transparent) 35%,
          color-mix(in srgb, #fff9e9 62%, transparent) 48%,
          color-mix(in srgb, #fff9e9 10%, transparent) 62%,
          transparent 100%);
    }}
    .cc-theme-showcase.theme-enfp-doodle::after {{
      content: "✦     〰     ♥     ↗";
      z-index: 0;
      inset: 76px auto auto 35%;
      width: 34%;
      height: auto;
      color: #12a890;
      background: none;
      filter: none;
      font-size: clamp(13px, 1.6cqw, 20px);
      letter-spacing: 10px;
      opacity: .34;
      transform: rotate(-5deg);
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-brandline {{
      top: 32px;
      left: 42px;
      right: auto;
      align-items: flex-start;
      gap: 0;
      transform: rotate(-1deg);
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-brandmark {{
      display: none;
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-brandcopy {{
      gap: 2px;
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-brandname {{
      color: #ef6f43;
      font-family: "Arial Black", "Microsoft YaHei UI", sans-serif;
      font-size: 44px;
      font-weight: 900;
      line-height: .92;
      overflow: visible;
      text-overflow: clip;
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-brandmeta {{
      color: #27332f;
      font-size: 14px;
      font-weight: 650;
      line-height: 1.2;
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-status {{
      display: none;
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-status::before {{
      background: #ef765d;
      box-shadow: 0 0 0 3px color-mix(in srgb, #ef765d 14%, transparent);
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-copy {{
      width: min(68%, 780px);
      align-self: start;
      margin-top: 108px;
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-eyebrow {{
      display: none;
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-title {{
      max-width: none;
      color: #1d2926;
      font-family: "STXingkai", "FZShuTi", "STKaiti", "KaiTi", "Microsoft YaHei", serif;
      font-size: 52px;
      font-weight: 400;
      line-height: 1.08;
      text-wrap: nowrap;
      white-space: nowrap;
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-title .cc-theme-enfp-title-accent {{
      text-decoration: underline;
      text-decoration-color: #ef765d;
      text-decoration-thickness: 4px;
      text-underline-offset: 9px;
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-subtitle {{
      display: none;
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-badge {{
      display: none;
    }}
    .cc-theme-enfp-mode {{
      max-width: 680px;
      margin: 24px 0 0;
      color: #34433f;
      font-size: 14px;
      line-height: 1.65;
      font-weight: 620;
    }}
    .cc-theme-enfp-mode strong {{
      color: #24302d;
      font-weight: 820;
    }}
    .cc-theme-enfp-mode .coral {{ color: #d95f49; }}
    .cc-theme-enfp-mode .teal {{ color: #0a9581; }}
    .cc-theme-enfp-mode .blue {{ color: #2188b5; }}
    .cc-theme-enfp-tags {{
      margin-top: 16px;
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
    }}
    .cc-theme-enfp-tags span {{
      min-height: 27px;
      padding: 0 11px;
      display: inline-flex;
      align-items: center;
      color: #28665d;
      border: 1px solid color-mix(in srgb, #12a890 22%, #b7ddd4);
      border-radius: 999px;
      background: color-mix(in srgb, #e3f8f2 88%, transparent);
      font-size: 11px;
      font-weight: 720;
    }}
    .cc-theme-enfp-tags span:nth-child(2) {{
      color: #86640c;
      border-color: color-mix(in srgb, #f2c84b 34%, #e5d59a);
      background: color-mix(in srgb, #fff3c9 90%, transparent);
    }}
    .cc-theme-enfp-tags span:nth-child(3) {{
      color: #a84b3a;
      border-color: color-mix(in srgb, #ef765d 28%, #f3b8a9);
      background: color-mix(in srgb, #ffe4dc 90%, transparent);
    }}
    .cc-theme-enfp-tags span:nth-child(4) {{
      color: #21759b;
      border-color: color-mix(in srgb, #37a9dc 28%, #acd9ec);
      background: color-mix(in srgb, #dff3fb 90%, transparent);
    }}
    .cc-theme-enfp-bubbles {{
      position: absolute;
      z-index: 4;
      top: 48px;
      right: 3%;
      width: 194px;
      display: grid;
      justify-items: end;
      gap: 9px;
      pointer-events: none;
    }}
    .cc-theme-enfp-bubbles span {{
      padding: 8px 13px;
      color: #a84b3a;
      border: 1px solid color-mix(in srgb, #ef765d 38%, #f3b8a9);
      border-radius: 14px 14px 5px 14px;
      background: color-mix(in srgb, #ffe4dc 92%, transparent);
      box-shadow: 3px 3px 0 color-mix(in srgb, #f2c84b 24%, transparent);
      font-size: 11px;
      font-weight: 760;
      transform: rotate(2deg);
    }}
    .cc-theme-enfp-bubbles span:last-child {{
      margin-right: 18px;
      color: #277669;
      border-color: color-mix(in srgb, #12a890 34%, #b7ddd4);
      border-radius: 14px 5px 14px 14px;
      background: color-mix(in srgb, #dff6ef 92%, transparent);
      transform: rotate(-2deg);
    }}
    .cc-theme-enfp-skin-card {{
      position: absolute;
      z-index: 4;
      top: 42%;
      right: 2.5%;
      width: 168px;
      padding: 11px 13px;
      display: grid;
      gap: 3px;
      pointer-events: none;
      color: #31433e;
      border: 1px solid color-mix(in srgb, #f2c84b 42%, #dfc96f);
      border-radius: 7px;
      background: color-mix(in srgb, #fffef8 92%, transparent);
      box-shadow: 5px 5px 0 color-mix(in srgb, #12a890 16%, transparent);
      font-size: 10px;
      transform: rotate(2deg);
    }}
    .cc-theme-enfp-skin-card strong {{
      color: #a56f00;
      font-size: 11px;
    }}
    .cc-theme-enfp-mood-card {{
      position: absolute;
      z-index: 4;
      right: 18px;
      bottom: 176px;
      width: 126px;
      padding: 10px 11px;
      display: grid;
      gap: 4px;
      pointer-events: none;
      color: #40514c;
      border: 1px solid color-mix(in srgb, #f2c84b 38%, #dfc96f);
      border-radius: 6px;
      background: color-mix(in srgb, #fff7ce 91%, transparent);
      box-shadow: 4px 4px 0 color-mix(in srgb, #37a9dc 17%, transparent);
      font-size: 9px;
      transform: rotate(-2deg);
    }}
    .cc-theme-enfp-mood-card strong {{
      color: #6d5b12;
      font-size: 10px;
    }}
    .cc-theme-enfp-mood-card span {{
      display: flex;
      justify-content: space-between;
      gap: 6px;
    }}
    .cc-theme-enfp-mood-card i,
    .cc-theme-enfp-mood-card b {{
      font-style: normal;
      font-weight: 650;
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-motif {{
      top: 10%;
      right: 25%;
      width: 72px;
      border: 0;
      opacity: .52;
      transform: rotate(10deg);
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-motif::before {{
      content: "☆";
      inset: 0;
      display: grid;
      place-items: center;
      color: #f2c84b;
      border: 0;
      font-size: 48px;
      transform: none;
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-motif::after {{
      content: "↗";
      inset: 38px -24px auto auto;
      color: #37a9dc;
      border: 0;
      background: none;
      font-size: 28px;
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-cards {{
      margin-top: -10px;
      gap: 16px;
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-card {{
      min-height: 150px;
      padding: 18px 15px !important;
      grid-template-columns: 54px minmax(0, 1fr) 22px;
      gap: 13px;
      border-radius: 8px !important;
      background: color-mix(in srgb, #fffef8 90%, transparent) !important;
      box-shadow:
        0 10px 22px color-mix(in srgb, #24302d 9%, transparent),
        inset 0 0 0 1px color-mix(in srgb, #ffffff 70%, transparent);
      backdrop-filter: blur(8px);
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-card:nth-child(1) {{
      background: color-mix(in srgb, #fff0e9 92%, transparent) !important;
      transform: rotate(-.5deg);
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-card:nth-child(2) {{
      background: color-mix(in srgb, #e9f9f4 92%, transparent) !important;
      transform: rotate(.4deg);
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-card:nth-child(3) {{
      background: color-mix(in srgb, #e9f6fc 92%, transparent) !important;
      transform: rotate(-.35deg);
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-card:nth-child(4) {{
      background: color-mix(in srgb, #fff8d8 92%, transparent) !important;
      transform: rotate(.55deg);
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-card:hover {{
      transform: translateY(-3px) rotate(0);
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-card-icon {{
      width: 52px;
      height: 52px;
      color: #ffffff;
      border-radius: 12px 16px 11px 15px;
      background: #ef765d;
      box-shadow: 4px 4px 0 color-mix(in srgb, #ef765d 18%, transparent);
      transform: rotate(-5deg);
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-card-label {{
      font-size: 15px;
      line-height: 1.35;
      font-weight: 760;
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-card-description {{
      margin-top: 7px;
      font-size: 11px;
      line-height: 1.55;
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-card:nth-child(2) .cc-theme-showcase-card-icon,
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-card:nth-child(2) .cc-theme-showcase-card-arrow {{
      background: #12a890;
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-card:nth-child(3) .cc-theme-showcase-card-icon,
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-card:nth-child(3) .cc-theme-showcase-card-arrow {{
      background: #37a9dc;
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-card:nth-child(4) .cc-theme-showcase-card-icon,
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-card:nth-child(4) .cc-theme-showcase-card-arrow {{
      color: #5b4a06;
      background: #f2c84b;
    }}
    .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-card-index {{
      color: color-mix(in srgb, #24302d 38%, transparent);
    }}
    html[data-codex-compass-showcase="enfp-doodle"] .cc-theme-showcase-composer,
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-composer {{
      border: 2px solid color-mix(in srgb, #12a890 62%, #b7ddd4) !important;
      border-radius: 12px !important;
      background:
        linear-gradient(180deg,
          color-mix(in srgb, #fffef8 96%, transparent),
          color-mix(in srgb, #fff9e9 94%, transparent)) !important;
      box-shadow:
        0 14px 32px color-mix(in srgb, #24302d 10%, transparent),
        5px 5px 0 color-mix(in srgb, #d3f3ea 60%, transparent) !important;
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-composer::before {{
      content: "✦";
      color: #ef765d;
      border-color: color-mix(in srgb, #ef765d 28%, #f3b8a9);
      background: color-mix(in srgb, #fff0e7 78%, transparent);
      transform: rotate(-5deg);
    }}
    html[data-codex-compass-theme="enfp-doodle"] .cc-theme-shell-composer::after {{
      width: 180px;
      height: 3px;
      background: #12a890;
      box-shadow: -48px 0 0 #f2c84b, -96px 0 0 #ef765d;
    }}
    @media (max-width: 980px) {{
      .cc-theme-enfp-bubbles,
      .cc-theme-enfp-skin-card,
      .cc-theme-enfp-mood-card {{
        display: none;
      }}
      .cc-theme-showcase.theme-enfp-doodle {{
        min-height: 560px;
        grid-template-rows: minmax(250px, 1fr) auto;
        padding: 32px 24px 20px;
        background-position: 76% center;
      }}
      .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-brandline {{
        top: 24px;
        left: 28px;
      }}
      .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-copy {{
        width: min(72%, 620px);
        margin-top: 76px;
      }}
      .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-brandname {{
        font-size: 36px;
      }}
      .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-title {{
        font-size: 36px;
        text-wrap: balance;
        white-space: normal;
      }}
      .cc-theme-showcase.theme-enfp-doodle .cc-theme-enfp-mode {{
        margin-top: 16px;
        font-size: 12px;
      }}
      .cc-theme-showcase.theme-enfp-doodle .cc-theme-enfp-tags {{
        margin-top: 12px;
        gap: 7px;
      }}
      .cc-theme-showcase.theme-enfp-doodle .cc-theme-enfp-tags span {{
        padding: 5px 9px;
        font-size: 9px;
      }}
      .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-cards {{
        margin-top: 0;
        gap: 10px;
      }}
      .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-card {{
        min-height: 108px;
        padding: 12px 10px !important;
        grid-template-columns: 38px minmax(0, 1fr) 18px;
        gap: 8px;
      }}
      .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-card-icon {{
        width: 38px;
        height: 38px;
        border-radius: 9px 11px 8px 10px;
      }}
      .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-card-icon svg {{
        width: 18px;
        height: 18px;
      }}
      .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-card-label {{
        font-size: 13px;
      }}
      .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-card-description {{
        margin-top: 4px;
        font-size: 9px;
        line-height: 1.4;
        -webkit-line-clamp: 2;
      }}
    }}
    @media (max-width: 620px) {{
      .cc-theme-showcase.theme-enfp-doodle {{
        min-height: 610px;
        grid-template-rows: minmax(285px, 1fr) auto;
        background-position: 72% center;
      }}
      .cc-theme-showcase.theme-enfp-doodle::before {{
        background: color-mix(in srgb, #fff9e9 84%, transparent);
      }}
      .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-copy {{
        width: 100%;
        margin-top: 86px;
      }}
      .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-title {{
        font-size: 34px;
        text-wrap: balance;
        white-space: normal;
      }}
      .cc-theme-enfp-tags span:nth-child(4) {{
        display: none;
      }}
      .cc-theme-showcase.theme-enfp-doodle .cc-theme-showcase-cards {{
        margin-top: 0;
      }}
    }}
    .cc-theme-showcase.layout-cosmic,
    .cc-theme-showcase.layout-stage {{
      min-height: clamp(520px, 45cqw, 585px);
      grid-template-rows: minmax(310px, 1fr) auto;
      gap: 0;
      background-position: var(--cc-showcase-position);
    }}
    .cc-theme-showcase.layout-cosmic::before,
    .cc-theme-showcase.layout-stage::before {{
      background: linear-gradient(90deg,
        color-mix(in srgb, var(--cc-theme-bg) 98%, transparent) 0%,
        color-mix(in srgb, var(--cc-theme-bg) var(--cc-theme-overlay-strength), transparent) 42%,
        color-mix(in srgb, var(--cc-theme-bg) 26%, transparent) 70%,
        transparent 88%);
    }}
    .cc-theme-showcase.layout-cosmic .cc-theme-showcase-copy,
    .cc-theme-showcase.layout-stage .cc-theme-showcase-copy {{
      width: min(50%, 560px);
      align-self: start;
      margin-top: clamp(24px, 3.2cqw, 50px);
    }}
    .cc-theme-showcase.layout-cosmic .cc-theme-showcase-title,
    .cc-theme-showcase.layout-stage .cc-theme-showcase-title {{
      color: #fffafc;
      font-size: clamp(36px, 4.2cqw, 54px);
      text-shadow: 0 8px 26px color-mix(in srgb, #000000 72%, transparent);
    }}
    .cc-theme-showcase.layout-cosmic .cc-theme-showcase-subtitle,
    .cc-theme-showcase.layout-stage .cc-theme-showcase-subtitle {{
      color: color-mix(in srgb, #ffffff 78%, transparent);
    }}
    .cc-theme-showcase.layout-cosmic .cc-theme-showcase-cards,
    .cc-theme-showcase.layout-stage .cc-theme-showcase-cards {{
      margin-top: -46px;
      gap: 12px;
    }}
    .cc-theme-showcase.layout-idol {{
      min-height: clamp(510px, 44cqw, 575px);
      grid-template-rows: minmax(300px, 1fr) auto;
      gap: 0;
      border-color: color-mix(in srgb, #10b9bf 42%, var(--cc-theme-border));
      background-position: var(--cc-showcase-position);
    }}
    .cc-theme-showcase.layout-idol::before {{
      background: linear-gradient(90deg,
        color-mix(in srgb, #f5ffff 98%, transparent) 0%,
        color-mix(in srgb, #f5ffff var(--cc-theme-overlay-strength), transparent) 42%,
        color-mix(in srgb, #f5ffff 24%, transparent) 70%,
        transparent 87%);
    }}
    .cc-theme-showcase.layout-idol .cc-theme-showcase-copy {{
      width: min(52%, 590px);
      align-self: start;
      margin-top: 24px;
    }}
    .cc-theme-showcase.layout-idol .cc-theme-showcase-title {{
      color: #164e58;
      font-size: clamp(35px, 4.1cqw, 53px);
    }}
    .cc-theme-showcase.layout-idol .cc-theme-showcase-cards {{
      margin-top: -42px;
      gap: 12px;
    }}
    @media (max-width: 920px) {{
      .cc-theme-showcase-host {{
        width: calc(100% - 28px) !important;
        min-height: 470px !important;
      }}
      .cc-theme-showcase {{
        min-height: 470px;
        padding: 28px 22px 22px;
      }}
      .cc-theme-showcase-copy,
      .cc-theme-showcase.has-portrait .cc-theme-showcase-copy {{
        width: min(62%, 520px);
      }}
      .cc-theme-showcase-title {{ font-size: 30px; }}
      .cc-theme-showcase-cards {{ grid-template-columns: repeat(2, minmax(0, 1fr)); }}
      .cc-theme-showcase-card {{ min-height: 102px; }}
      .cc-theme-showcase-card-icon {{ width: 32px; height: 32px; }}
      .cc-theme-showcase-card-icon svg {{ width: 18px; height: 18px; }}
      .cc-theme-showcase-companion {{ display: none; }}
      .cc-theme-shell-topbar::before,
      .cc-theme-shell-topbar::after {{ display: none; }}
      html[data-codex-compass-theme="rose-garden"] .cc-theme-showcase-host {{
        min-height: 540px !important;
      }}
      .cc-theme-showcase.theme-rose-garden {{
        min-height: 540px;
        grid-template-rows: minmax(270px, 1fr) auto;
        background-position: 62% center;
      }}
      .cc-theme-showcase.theme-rose-garden .cc-theme-showcase-copy {{
        width: min(58%, 460px);
        margin-top: 18px;
      }}
      .cc-theme-showcase.theme-rose-garden .cc-theme-showcase-title {{
        font-size: 34px;
      }}
      .cc-theme-showcase.theme-rose-garden .cc-theme-showcase-cards {{
        margin-top: -24px;
      }}
      .cc-theme-showcase.theme-rose-garden .cc-theme-showcase-card {{
        min-height: 96px;
      }}
      html[data-codex-compass-theme="starlight-stage"] .cc-theme-showcase-host {{
        min-height: 550px !important;
      }}
      .cc-theme-showcase.theme-starlight-stage {{
        min-height: 550px;
        grid-template-rows: minmax(280px, 1fr) auto;
        background-position: 64% center;
      }}
      .cc-theme-showcase.theme-starlight-stage .cc-theme-showcase-copy {{
        width: min(58%, 450px);
        margin-top: 18px;
      }}
      .cc-theme-showcase.theme-starlight-stage .cc-theme-showcase-title {{
        font-size: 35px;
      }}
      .cc-theme-showcase.theme-starlight-stage .cc-theme-showcase-cards {{
        margin-top: -24px;
      }}
      .cc-theme-showcase.theme-starlight-stage .cc-theme-showcase-card {{
        min-height: 96px;
      }}
    }}
    @media (max-width: 620px) {{
      .cc-theme-showcase {{
        min-height: 500px;
        gap: 16px;
      }}
      .cc-theme-showcase::before {{
        background: color-mix(in srgb, var(--cc-theme-surface) 78%, transparent);
      }}
      .cc-theme-showcase-copy,
      .cc-theme-showcase.has-portrait .cc-theme-showcase-copy {{
        width: 100%;
      }}
      .cc-theme-showcase-portrait {{
        right: -10%;
        opacity: .22;
      }}
      .cc-theme-showcase-cards {{ gap: 8px; }}
      .cc-theme-showcase-card {{
        min-height: 94px;
        grid-template-columns: 34px minmax(0, 1fr) 16px;
        gap: 8px;
        padding: 10px 8px !important;
      }}
      .cc-theme-showcase-card-label {{ font-size: 11px; }}
      .cc-theme-showcase-card-description {{ font-size: 9px; -webkit-line-clamp: 1; }}
      .cc-theme-showcase-brandline {{ left: 16px; right: 16px; }}
      .cc-theme-showcase-status {{ display: none; }}
      html[data-codex-compass-theme="rose-garden"] .cc-theme-showcase-host {{
        min-height: 610px !important;
      }}
      .cc-theme-showcase.theme-rose-garden {{
        min-height: 610px;
        grid-template-rows: minmax(250px, 1fr) auto;
        background-position: 70% center;
      }}
      .cc-theme-showcase.theme-rose-garden::before {{
        background: color-mix(in srgb, #fffafa 82%, transparent);
      }}
      .cc-theme-showcase.theme-rose-garden .cc-theme-showcase-copy {{
        width: 100%;
        margin-top: 0;
      }}
      .cc-theme-showcase.theme-rose-garden .cc-theme-showcase-title {{
        font-size: 31px;
      }}
      .cc-theme-showcase.theme-rose-garden .cc-theme-showcase-cards {{
        margin-top: 0;
      }}
      .cc-theme-showcase.theme-rose-garden .cc-theme-showcase-card {{
        min-height: 92px;
      }}
      html[data-codex-compass-theme="starlight-stage"] .cc-theme-showcase-host {{
        min-height: 620px !important;
      }}
      .cc-theme-showcase.theme-starlight-stage {{
        min-height: 620px;
        grid-template-rows: minmax(255px, 1fr) auto;
        background-position: 72% center;
      }}
      .cc-theme-showcase.theme-starlight-stage::before {{
        background: color-mix(in srgb, #070817 84%, transparent);
      }}
      .cc-theme-showcase.theme-starlight-stage .cc-theme-showcase-copy {{
        width: 100%;
        margin-top: 0;
      }}
      .cc-theme-showcase.theme-starlight-stage .cc-theme-showcase-title {{
        font-size: 31px;
      }}
      .cc-theme-showcase.theme-starlight-stage .cc-theme-showcase-cards {{
        margin-top: 0;
      }}
      .cc-theme-showcase.theme-starlight-stage .cc-theme-showcase-card {{
        min-height: 92px;
      }}
    }}
    @media (prefers-reduced-motion: reduce) {{
      .cc-theme-showcase-card {{ transition-duration: .01ms !important; }}
    }}
    ::selection {{ color: var(--cc-theme-text); background: var(--cc-theme-accent-soft); }}
    ::-webkit-scrollbar-thumb {{ background: color-mix(in srgb, var(--cc-theme-accent) 45%, transparent); }}
  `;
  document.documentElement.appendChild(style);
  setDatasetValue(document.documentElement, "codexCompassTheme", config.id);
  const showcase = config.showcase || {{}};
  const iconMarkup = {{
    code: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 9-3 3 3 3"/><path d="m16 9 3 3-3 3"/><path d="m14 5-4 14"/></svg>',
    build: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v5"/><path d="M12 17v5"/><path d="m4.93 4.93 3.54 3.54"/><path d="m15.54 15.54 3.53 3.53"/><path d="M2 12h5"/><path d="M17 12h5"/><path d="m4.93 19.07 3.54-3.54"/><path d="m15.54 8.46 3.53-3.53"/></svg>',
    review: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
    repair: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.7 6.3 3 3"/><path d="m5 21 4.3-4.3"/><path d="M12 8.5A5 5 0 0 0 5.5 15L2 18.5 5.5 22 9 18.5A5 5 0 0 0 15.5 12"/><path d="M15 3a4 4 0 0 0 5.6 5.6L16 13.2 10.8 8l4.6-4.6A4 4 0 0 0 15 3Z"/></svg>',
  }};
  const arrowMarkup = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h8"/><path d="m8.5 4.5 3.5 3.5-3.5 3.5"/></svg>';
  const layoutMarks = {{
    editorial: "R",
    paper: "叶",
    fortune: "福",
    future: "F",
    doodle: "E",
    cosmic: "星",
    idol: "V",
    stage: "光",
  }};
  const themeMark = layoutMarks[p.layoutStyle] || "C";
  function normalizedText(node) {{
    return String(node?.textContent || "").replace(/\s+/g, " ").trim();
  }}
  const projectArchiveCleanupTimers = new Set();
  function projectContextMenuItems(menu) {{
    const semanticItems = Array.from(menu.querySelectorAll('[role="menuitem"], [data-radix-collection-item]'));
    return semanticItems.length ? semanticItems : Array.from(menu.querySelectorAll("button"));
  }}
  function visibleProjectArchiveConfirmation() {{
    return Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).some((dialog) => {{
      if (!isVisibleElement(dialog)) return false;
      return /(?:归档|archive)/i.test(normalizedText(dialog)) && dialog.querySelector("button");
    }});
  }}
  function dismissStaleProjectArchiveSurfaces() {{
    if (visibleProjectArchiveConfirmation()) return;
    document.dispatchEvent(new KeyboardEvent("keydown", {{
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    }}));
  }}
  function scheduleProjectArchiveCleanup(delay) {{
    let timer = 0;
    timer = window.setTimeout(() => {{
      projectArchiveCleanupTimers.delete(timer);
      dismissStaleProjectArchiveSurfaces();
    }}, delay);
    projectArchiveCleanupTimers.add(timer);
  }}
  function handleProjectArchiveClick(event) {{
    const target = event.target instanceof Element
      ? event.target.closest('[data-codex-theme-project-menu-action="archive"]')
      : null;
    if (!target) return;
    scheduleProjectArchiveCleanup(120);
    scheduleProjectArchiveCleanup(360);
  }}
  function decorateProjectContextMenus() {{
    document.querySelectorAll('[role="menu"], [data-radix-menu-content]').forEach((menu) => {{
      if (!(menu instanceof HTMLElement)) return;
      const items = projectContextMenuItems(menu);
      const hasRenameProject = items.some((item) => /^(?:重命名项目|rename project)$/i.test(normalizedText(item)));
      if (!hasRenameProject) return;
      setDatasetValue(menu, "codexThemeProjectContextMenu", "true");
      setDatasetValue(menu, "codexThemeProjectContextMenuVersion", "1");
      items.forEach((item) => {{
        const label = normalizedText(item);
        if (/^(?:重命名项目|rename project)$/i.test(label)) {{
          setDatasetValue(item, "codexThemeProjectMenuAction", "rename");
          return;
        }}
        if (/^(?:归档任务|归档项目|archive(?: task| project)?)$/i.test(label)) {{
          setDatasetValue(item, "codexThemeProjectMenuAction", "archive");
        }}
      }});
    }});
  }}
  function decorateProjectRenameDialogs() {{
    document.querySelectorAll('[role="dialog"], [data-slot="dialog-content"]').forEach((dialog) => {{
      if (!(dialog instanceof HTMLElement)) return;
      const label = [
        dialog.getAttribute("aria-label"),
        normalizedText(dialog.querySelector('h1, h2, h3, [data-slot="dialog-title"]')),
        normalizedText(dialog).slice(0, 120),
      ].filter(Boolean).join(" ");
      if (!/(?:重命名项目|rename project)/i.test(label)) return;
      setDatasetValue(dialog, "codexThemeProjectRenameDialog", "true");
      const field = dialog.querySelector('input:not([type="hidden"]), textarea');
      setDatasetValue(field, "codexThemeProjectRenameField", "true");
      const buttons = Array.from(dialog.querySelectorAll("button"));
      const cancel = buttons.find((button) => /^(?:取消|cancel)$/i.test(normalizedText(button)));
      const save = buttons.find((button) => /^(?:保存|save)$/i.test(normalizedText(button)));
      const close = buttons.find((button) => {{
        const labels = [
          button.getAttribute("aria-label"),
          button.getAttribute("title"),
        ].filter(Boolean).map((value) => String(value).trim());
        return labels.some((value) => /^(?:关闭|close)$/i.test(value))
          || /^(?:×|✕)$/i.test(normalizedText(button));
      }});
      setDatasetValue(cancel, "codexThemeProjectRenameAction", "cancel");
      setDatasetValue(save, "codexThemeProjectRenameAction", "save");
      setDatasetValue(close, "codexThemeProjectRenameAction", "close");
      const actions = cancel && save && cancel.parentElement === save.parentElement ? cancel.parentElement : null;
      setDatasetValue(actions, "codexThemeProjectRenameActions", "true");
    }});
  }}
  function decorateProjectContextUi() {{
    decorateProjectContextMenus();
    decorateProjectRenameDialogs();
  }}
  function isVisibleElement(node) {{
    if (!(node instanceof HTMLElement)) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  }}
  function isSettingsNavigationSurface(node) {{
    let current = node;
    for (let depth = 0; current instanceof HTMLElement && depth < 5; depth += 1, current = current.parentElement) {{
      const rect = current.getBoundingClientRect();
      const isLeftNavigationColumn = rect.left <= 32
        && rect.width >= 140
        && rect.width <= 480
        && rect.height >= window.innerHeight * .45;
      if (!isLeftNavigationColumn) continue;
      const navigationControls = Array.from(
        current.querySelectorAll('a,button,[role="link"],[role="button"]')
      ).filter(isVisibleElement);
      const hasBackToApp = navigationControls.some((control) =>
        /^(返回应用|back to app)$/i.test(normalizedText(control))
      );
      const hasSettingsSearch = Array.from(current.querySelectorAll('input,[role="searchbox"]')).some((control) => {{
        if (!isVisibleElement(control)) return false;
        const label = [
          control.getAttribute("aria-label"),
          control.getAttribute("placeholder"),
          control.getAttribute("title"),
        ].filter(Boolean).join(" ");
        return /搜索设置|search settings/i.test(label);
      }});
      if (hasBackToApp || hasSettingsSearch) return true;
    }}
    return false;
  }}
  function directChildWithin(node, root) {{
    let current = node;
    while (current?.parentElement && current.parentElement !== root) current = current.parentElement;
    return current?.parentElement === root ? current : null;
  }}
  function setClassState(node, className, enabled) {{
    if (!(node instanceof HTMLElement)) return;
    if (node.classList.contains(className) === enabled) return;
    node.classList.toggle(className, enabled);
  }}
  function setDatasetValue(node, key, value) {{
    if (!(node instanceof HTMLElement)) return;
    const next = String(value);
    if (node.dataset[key] === next) return;
    node.dataset[key] = next;
  }}
  function setSingletonClass(className, node) {{
    document.querySelectorAll(`.${{className}}`).forEach((candidate) => {{
      if (candidate !== node) setClassState(candidate, className, false);
    }});
    setClassState(node, className, true);
  }}
  function syncClassMembers(className, nodes) {{
    const wanted = new Set(Array.from(nodes || []).filter((node) => node instanceof HTMLElement));
    document.querySelectorAll(`.${{className}}`).forEach((node) => {{
      if (!wanted.has(node)) setClassState(node, className, false);
    }});
    wanted.forEach((node) => setClassState(node, className, true));
  }}
  function findSidebar() {{
    const scroll = document.querySelector('[data-app-action-sidebar-scroll]');
    let current = scroll;
    const scrollRect = scroll instanceof HTMLElement ? scroll.getBoundingClientRect() : null;
    for (let depth = 0; current instanceof HTMLElement && depth < 7; depth += 1, current = current.parentElement) {{
      if (current.matches('nav,aside,[data-slot="sidebar"]') && !isSettingsNavigationSurface(current)) return current;
      const rect = current.getBoundingClientRect();
      if (depth > 0
        && scrollRect
        && rect.left <= 24
        && rect.width >= 150
        && rect.width <= 440
        && rect.height >= scrollRect.height + 36
        && !isSettingsNavigationSurface(current)) return current;
    }}
    const newTask = Array.from(document.querySelectorAll('button,[role="button"]')).find((node) =>
      /^(新建任务|新任务|new task|new chat)$/i.test(normalizedText(node))
    );
    current = newTask;
    for (let depth = 0; current instanceof HTMLElement && depth < 9; depth += 1, current = current.parentElement) {{
      const rect = current.getBoundingClientRect();
      if (rect.left <= 24
        && rect.width >= 150
        && rect.width <= 440
        && rect.height >= window.innerHeight * .54
        && !isSettingsNavigationSurface(current)) {{
        return current;
      }}
    }}
    return Array.from(document.querySelectorAll('aside,nav,[data-slot="sidebar"]')).find((node) => {{
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.left <= 24
        && rect.width >= 150
        && rect.width <= 440
        && rect.height >= window.innerHeight * .54
        && !isSettingsNavigationSurface(node);
    }}) || null;
  }}
  function forwardSidebarRowWheel(event) {{
    if (event.defaultPrevented || event.ctrlKey || !(event.target instanceof Element)) return;
    const row = event.target.closest(".cc-theme-shell-project-row,.cc-theme-shell-thread-row");
    if (!(row instanceof HTMLElement)) return;
    const scroll = row.closest('[data-app-action-sidebar-scroll]');
    if (!(scroll instanceof HTMLElement) || scroll.scrollHeight <= scroll.clientHeight) return;
    const multiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? scroll.clientHeight
        : 1;
    const delta = event.deltaY * multiplier;
    if (!Number.isFinite(delta) || delta === 0) return;
    const previousTop = scroll.scrollTop;
    scroll.scrollTop += delta;
    if (scroll.scrollTop !== previousTop) event.preventDefault();
  }}
  document.addEventListener("wheel", forwardSidebarRowWheel, {{ capture: true, passive: false }});
  function findTopbars(sidebar) {{
    const appHeader = document.querySelector('.app-header-tint') || Array.from(document.querySelectorAll('header,[role="banner"]')).find((node) => {{
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.top <= 12 && rect.height > 22 && rect.height <= 82 && rect.width >= window.innerWidth * .5;
    }});
    const appRect = appHeader instanceof HTMLElement ? appHeader.getBoundingClientRect() : {{ bottom: 44 }};
    const sidebarRect = sidebar instanceof HTMLElement ? sidebar.getBoundingClientRect() : {{ right: 0 }};
    const sessionbar = Array.from(document.querySelectorAll('.draggable')).filter((node) => {{
      if (!(node instanceof HTMLElement) || node === appHeader) return false;
      const rect = node.getBoundingClientRect();
      return rect.left >= sidebarRect.right - 4
        && rect.top >= appRect.bottom - 2
        && rect.top <= appRect.bottom + 92
        && rect.width >= Math.max(420, window.innerWidth * .38)
        && rect.height >= 28
        && rect.height <= 72;
    }}).sort((left, right) => {{
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return leftRect.top - rightRect.top || rightRect.width - leftRect.width;
    }})[0] || null;
    return {{ appHeader: appHeader || null, sessionbar }};
  }}
  function findSidebarAccountScope(sidebar) {{
    if (!(sidebar instanceof HTMLElement)) return null;
    const sidebarRect = sidebar.getBoundingClientRect();
    let scope = sidebar;
    let current = sidebar.parentElement;
    for (let depth = 0; current instanceof HTMLElement && depth < 6; depth += 1, current = current.parentElement) {{
      const rect = current.getBoundingClientRect();
      const sharesSidebarColumn = Math.abs(rect.left - sidebarRect.left) <= 4
        && Math.abs(rect.right - sidebarRect.right) <= 4
        && rect.width >= 150
        && rect.width <= 440;
      const coversSidebar = rect.top <= sidebarRect.top + 16
        && rect.bottom >= sidebarRect.bottom - 16;
      if (!sharesSidebarColumn || !coversSidebar) break;
      scope = current;
    }}
    return scope;
  }}
  function decorateSidebar(sidebar) {{
    if (!(sidebar instanceof HTMLElement) || isSettingsNavigationSurface(sidebar)) {{
      clearSidebarDecorations();
      return null;
    }}
    setSingletonClass(shellSidebarClass, sidebar);
    const keepSidebarStatic = sidebar.classList.contains(shellSidebarStaticClass)
      || getComputedStyle(sidebar).position === "static";
    setSingletonClass(shellSidebarStaticClass, keepSidebarStatic ? sidebar : null);
    const rect = sidebar.getBoundingClientRect();
    const accountScope = findSidebarAccountScope(sidebar) || sidebar;
    const allButtons = Array.from(sidebar.querySelectorAll('button,[role="button"]'));
    const accountButtons = accountScope === sidebar
      ? allButtons
      : Array.from(accountScope.querySelectorAll('button,[role="button"]'));
    const topButtons = allButtons.slice(0, 40).filter(isVisibleElement);
    const productButton = sidebar.querySelector('button[aria-haspopup="menu"]')
      || topButtons.find((node) => /^codex\b/i.test(normalizedText(node)))
      || topButtons.find((node) => node.querySelector?.('[data-testid="home-icon"]'));
    let productNode = productButton;
    if (productButton instanceof HTMLElement) {{
      setDatasetValue(productButton, "ccThemeLabel", config.name || "Codex Compass");
      setDatasetValue(productButton, "ccThemeMark", themeMark);
    }} else if (!document.getElementById("codex-compass-theme-shell-brand")) {{
      const brand = document.createElement("div");
      brand.id = "codex-compass-theme-shell-brand";
      brand.className = "cc-theme-shell-product-button";
      brand.dataset.codexThemeShellInjected = "brand";
      brand.dataset.ccThemeLabel = config.name || "Codex Compass";
      brand.dataset.ccThemeMark = themeMark;
      brand.textContent = "Codex";
      const firstButton = topButtons[0];
      const anchor = firstButton ? directChildWithin(firstButton, sidebar) : sidebar.firstElementChild;
      sidebar.insertBefore(brand, anchor || null);
      productNode = brand;
    }} else {{
      productNode = document.getElementById("codex-compass-theme-shell-brand");
    }}
    setSingletonClass("cc-theme-shell-product-button", productNode);
    const newTaskButton = topButtons.find((button) => /^(新建任务|新任务|new task|new chat)$/i.test(normalizedText(button)));
    const searchButton = topButtons.find((button) => /search|搜索/i.test([
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      normalizedText(button),
    ].filter(Boolean).join(" ")));
    const topNavigation = topButtons.filter((button) => {{
      if (button === productButton || button === newTaskButton || button === searchButton) return;
      if (button.closest?.('[data-app-action-sidebar-section-heading]')) return false;
      const buttonRect = button.getBoundingClientRect();
      const label = [
        button.getAttribute("aria-label"),
        button.getAttribute("title"),
        normalizedText(button),
      ].filter(Boolean).join(" ");
      const knownNavigation = /scheduled|已安排|calendar|日程|skill|技能|plugin|插件|site|站点|chat|聊天|pull request|拉取请求|review|审查/i.test(label);
      return buttonRect.width >= rect.width * .48
        && buttonRect.height <= 72
        && (knownNavigation || buttonRect.top < rect.top + 250);
    }});
    const projectRows = Array.from(sidebar.querySelectorAll('[data-app-action-sidebar-project-row]'));
    const threadRows = Array.from(sidebar.querySelectorAll('[data-app-action-sidebar-thread-row]'));
    const activeRows = threadRows.filter((node) => node.matches('[data-app-action-sidebar-thread-active="true"],[aria-current="page"]'));
    const headings = Array.from(sidebar.querySelectorAll('[data-app-action-sidebar-section-heading]'));
    const belongsToSidebarCollection = (button) =>
      button.matches?.('[data-app-action-sidebar-project-row],[data-app-action-sidebar-thread-row]')
      || !!button.closest?.(
        '[data-app-action-sidebar-project-row],[data-app-action-sidebar-thread-row],[data-app-action-sidebar-section-heading]'
      );
    const profileTrigger = accountButtons.find((button) => {{
      if (!isVisibleElement(button) || belongsToSidebarCollection(button)) return false;
      const label = [
        button.getAttribute("aria-label"),
        button.getAttribute("title"),
      ].filter(Boolean).join(" ");
      return /profile|personal profile|account|个人资料|个人档案|账户|账号/i.test(label);
    }}) || null;
    const accountRow = profileTrigger || accountButtons.slice(-24).filter((button) => {{
      if (!isVisibleElement(button)) return;
      if (belongsToSidebarCollection(button)) return false;
      const buttonRect = button.getBoundingClientRect();
      return buttonRect.top >= rect.bottom - 116
        && buttonRect.bottom <= rect.bottom + 12
        && buttonRect.width >= rect.width * .48;
    }}).sort((left, right) => {{
      const leftPopup = left.getAttribute("aria-haspopup") === "menu" ? 1 : 0;
      const rightPopup = right.getAttribute("aria-haspopup") === "menu" ? 1 : 0;
      if (leftPopup !== rightPopup) return rightPopup - leftPopup;
      return right.getBoundingClientRect().width - left.getBoundingClientRect().width;
    }})[0] || null;
    const navToneRows = {{ coral: [], mint: [], sky: [], violet: [] }};
    topNavigation.forEach((button, index) => {{
      const label = [
        button.getAttribute("aria-label"),
        button.getAttribute("title"),
        normalizedText(button),
      ].filter(Boolean).join(" ");
      const tone = /scheduled|已安排|calendar|日程/i.test(label)
        ? "coral"
        : /skill|技能|plugin|插件/i.test(label)
          ? "mint"
          : /site|站点|chat|聊天/i.test(label)
            ? "sky"
            : /pull request|拉取请求|review|审查/i.test(label)
              ? "violet"
              : ["coral", "mint", "sky", "violet"][index % 4];
      navToneRows[tone].push(button);
    }});
    syncClassMembers("cc-theme-shell-search-button", searchButton ? [searchButton] : []);
    syncClassMembers("cc-theme-shell-new-task", newTaskButton ? [newTaskButton] : []);
    syncClassMembers("cc-theme-shell-nav-row", [
      ...(newTaskButton ? [newTaskButton] : []),
      ...topNavigation,
      ...projectRows,
      ...threadRows,
    ]);
    syncClassMembers("cc-theme-shell-project-row", projectRows);
    syncClassMembers("cc-theme-shell-thread-row", threadRows);
    syncClassMembers("cc-theme-shell-active-row", activeRows);
    syncClassMembers("cc-theme-shell-group-heading", headings);
    syncClassMembers("cc-theme-shell-account-row", accountRow ? [accountRow] : []);
    const keepAccountStatic = accountRow instanceof HTMLElement
      && (accountRow.classList.contains(shellAccountStaticClass)
        || getComputedStyle(accountRow).position === "static");
    setSingletonClass(shellAccountStaticClass, keepAccountStatic ? accountRow : null);
    syncClassMembers("cc-theme-shell-nav-coral", navToneRows.coral);
    syncClassMembers("cc-theme-shell-nav-mint", navToneRows.mint);
    syncClassMembers("cc-theme-shell-nav-sky", navToneRows.sky);
    syncClassMembers("cc-theme-shell-nav-violet", navToneRows.violet);
    return sidebar;
  }}
  function decorateWindowControls(appHeader) {{
    const declaredAction = (node) => String(
      node?.getAttribute?.("data-window-action")
      || node?.getAttribute?.("data-app-window-action")
      || node?.getAttribute?.("data-window-control")
      || ""
    ).trim().toLowerCase();
    const semanticAction = (node, allowLabel) => {{
      const declared = declaredAction(node);
      if (/^(minimize|minimise)$/.test(declared)) return "minimize";
      if (/^(maximize|maximise|restore)$/.test(declared)) return "maximize";
      if (declared === "close") return "close";
      if (!allowLabel) return "";
      const labels = [
        node?.getAttribute?.("aria-label"),
        node?.getAttribute?.("title"),
      ].filter(Boolean).map((value) => String(value).trim());
      if (labels.some((value) => /^(minimi[sz]e|最小化)$/i.test(value))) return "minimize";
      if (labels.some((value) => /^(maximi[sz]e|restore|最大化|还原|最大化或还原)$/i.test(value))) return "maximize";
      if (labels.some((value) => /^(close|关闭)$/i.test(value))) return "close";
      return "";
    }};
    const explicit = Array.from(document.querySelectorAll(
      '[data-window-action],[data-app-window-action],[data-window-control]'
    )).filter((node) => isVisibleElement(node) && semanticAction(node, false));
    const labeled = appHeader instanceof HTMLElement
      ? Array.from(appHeader.querySelectorAll('button,[role="button"]'))
        .filter((node) => isVisibleElement(node) && semanticAction(node, true))
      : [];
    const candidates = Array.from(new Set([...explicit, ...labeled]));
    const minimize = candidates.find((node) => semanticAction(node, true) === "minimize") || null;
    const maximize = candidates.find((node) => semanticAction(node, true) === "maximize") || null;
    const close = candidates.find((node) => semanticAction(node, true) === "close") || null;
    syncClassMembers("cc-theme-shell-window-control", candidates);
    syncClassMembers("cc-theme-shell-window-minimize", minimize ? [minimize] : []);
    syncClassMembers("cc-theme-shell-window-maximize", maximize ? [maximize] : []);
    syncClassMembers("cc-theme-shell-window-close", close ? [close] : []);
  }}
  function decorateTopbars(topbars) {{
    setSingletonClass(shellTopbarClass, topbars?.appHeader);
    setSingletonClass(shellSessionbarClass, topbars?.sessionbar);
    if (topbars?.appHeader instanceof HTMLElement) {{
      setDatasetValue(topbars.appHeader, "ccThemeLabel", p.headerBadge || config.name || "Codex Compass");
    }}
    decorateWindowControls(topbars?.appHeader);
  }}
  function decorateComposer(composer) {{
    setSingletonClass(shellComposerClass, composer);
    if (!(composer instanceof HTMLElement)) {{
      syncClassMembers("cc-theme-shell-model-button", []);
      syncClassMembers("cc-theme-shell-send-button", []);
      syncClassMembers("cc-theme-shell-stop-button", []);
      syncClassMembers("cc-theme-shell-attach-button", []);
      return;
    }}
    setDatasetValue(composer, "ccThemeMark", themeMark);
    const buttons = Array.from(composer.querySelectorAll('button,[role="button"]')).filter(isVisibleElement);
    const sendButton = composer.querySelector('button[aria-label="发送"],button[aria-label="Send"],button[aria-label="提交"],button[aria-label="Submit"],button[aria-label="停止"],button[aria-label="Stop"]')
      || buttons.find((button) => /send|submit|stop|发送|提交|停止/i.test([
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      normalizedText(button),
    ].filter(Boolean).join(" "))) || buttons
      .filter((button) => {{
        const item = button.getBoundingClientRect();
        return item.width <= 48 && item.height <= 48;
      }})
      .sort((left, right) => right.getBoundingClientRect().right - left.getBoundingClientRect().right)[0];
    const isStopButton = /stop|停止/i.test(String(sendButton?.getAttribute?.("aria-label") || sendButton?.getAttribute?.("title") || ""));
    const attachButton = composer.querySelector('button[aria-label="添加文件等内容"],button[aria-label="Add files and more"]')
      || buttons.find((button) => /attach|upload|附件|上传|添加文件/i.test([
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      normalizedText(button),
    ].filter(Boolean).join(" ")));
    const modelButton = composer.querySelector('[data-codex-intelligence-trigger="true"]')
      || buttons.find((button) => /\b(gpt|claude|codex|o[134])[-\w.]*/i.test(normalizedText(button))
      || /model|模型/i.test(String(button.getAttribute("aria-label") || button.getAttribute("title") || "")));
    syncClassMembers("cc-theme-shell-send-button", sendButton ? [sendButton] : []);
    syncClassMembers("cc-theme-shell-stop-button", isStopButton && sendButton ? [sendButton] : []);
    syncClassMembers("cc-theme-shell-attach-button", attachButton ? [attachButton] : []);
    syncClassMembers("cc-theme-shell-model-button", modelButton ? [modelButton] : []);
  }}
  function decorateCodexShell(home) {{
    const sidebar = decorateSidebar(findSidebar());
    decorateTopbars(findTopbars(sidebar));
    decorateComposer(findComposer(home));
    setDatasetValue(document.documentElement, "codexCompassThemeShell", "v3");
  }}
  function summarizeCardPrompt(card) {{
    const prompt = String(card?.prompt || "").replace(/\s+/g, " ").trim();
    if (!prompt) return "选择后填入输入框";
    const firstClause = prompt.split(/[。！？!?；;]/, 1)[0] || prompt;
    return firstClause.length > 30 ? `${{firstClause.slice(0, 29)}}…` : firstClause;
  }}
  function findHomeSurface() {{
    const icon = document.querySelector('[data-testid="home-icon"]');
    const iconHome = icon?.closest?.('[role="main"]');
    if (iconHome) return iconHome;
    return Array.from(document.querySelectorAll('[role="main"]')).find((candidate) =>
      candidate.querySelector?.('[data-feature="game-source"]')
      && candidate.querySelector?.('.group\\/home-suggestions')
    ) || null;
  }}
  function findShowcaseHost(home) {{
    const structuralHost = home?.firstElementChild?.firstElementChild?.firstElementChild;
    if (structuralHost instanceof HTMLElement) return structuralHost;
    const heading = home?.querySelector?.('[data-feature="game-source"]');
    let node = heading?.parentElement || null;
    for (let depth = 0; node instanceof HTMLElement && depth < 6; depth += 1, node = node.parentElement) {{
      if (node.querySelector?.('.group\\/home-suggestions')) return node;
    }}
    return heading?.parentElement || null;
  }}
  function findComposer(home) {{
    return home?.querySelector?.('.composer-surface-chrome')
      || document.querySelector('.composer-surface-chrome');
  }}
  function fillComposer(prompt, home) {{
    const composer = findComposer(home);
    const editable = composer?.querySelector?.('[contenteditable="true"], textarea, input[type="text"]');
    if (!(editable instanceof HTMLElement) || !prompt) return false;
    editable.focus();
    if (editable instanceof HTMLTextAreaElement || editable instanceof HTMLInputElement) {{
      const prototype = editable instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(editable, prompt);
      else editable.value = prompt;
      editable.dispatchEvent(new InputEvent("input", {{ bubbles: true, inputType: "insertText", data: prompt }}));
      editable.dispatchEvent(new Event("change", {{ bubbles: true }}));
      return true;
    }}
    const selection = window.getSelection?.();
    if (selection && document.createRange) {{
      const range = document.createRange();
      range.selectNodeContents(editable);
      selection.removeAllRanges();
      selection.addRange(range);
    }}
    let inserted = false;
    try {{ inserted = document.execCommand?.("insertText", false, prompt) === true; }} catch (_) {{}}
    if (!inserted) {{
      editable.textContent = prompt;
      editable.dispatchEvent(new InputEvent("input", {{ bubbles: true, inputType: "insertText", data: prompt }}));
    }}
    editable.focus();
    return true;
  }}
  function createShowcase(home, host) {{
    const root = document.createElement("section");
    root.id = showcaseId;
    root.className = "cc-theme-showcase";
    root.classList.add(`theme-${{config.id}}`);
    root.classList.add(`layout-${{p.layoutStyle || "editorial"}}`);
    root.classList.add(`cards-${{p.cardStyle || "glass"}}`);
    root.dataset.codexThemeRoot = "v3";
    root.dataset.codexThemeId = config.id;
    root.dataset.codexThemeLayout = p.layoutStyle || "editorial";
    root.dataset.codexThemeCardGrid = "true";
    root.setAttribute("aria-label", showcase.title || config.name || "Codex theme");
    const heroImage = showcase.heroImageDataUrl || config.wallpaper || "";
    const safeHero = String(heroImage).replaceAll('"', "%22");
    root.style.setProperty("--cc-showcase-hero", safeHero ? `url("${{safeHero}}")` : "none");

    const brandline = document.createElement("div");
    brandline.className = "cc-theme-showcase-brandline";
    brandline.setAttribute("aria-hidden", "true");
    const brandmark = document.createElement("span");
    brandmark.className = "cc-theme-showcase-brandmark";
    brandmark.textContent = themeMark;
    const brandcopy = document.createElement("span");
    brandcopy.className = "cc-theme-showcase-brandcopy";
    const brandname = document.createElement("span");
    brandname.className = "cc-theme-showcase-brandname";
    const brandmeta = document.createElement("span");
    brandmeta.className = "cc-theme-showcase-brandmeta";
    if (config.id === "enfp-doodle") {{
      const [brand, ...statusParts] = String(showcase.eyebrow || "")
        .split("·")
        .map((part) => part.trim())
        .filter(Boolean);
      brandname.textContent = brand || "ENFP";
      brandmeta.textContent = statusParts.join(" · ") || "灵感发动机已启动 ♥";
    }} else {{
      brandname.textContent = config.name || "Codex Compass";
      brandmeta.textContent = showcase.eyebrow || "Codex Compass Theme Studio";
    }}
    brandcopy.append(brandname, brandmeta);
    const status = document.createElement("span");
    status.className = "cc-theme-showcase-status";
    status.textContent = String(p.headerBadge || "Codex online");
    brandline.append(brandmark, brandcopy, status);
    root.appendChild(brandline);

    const copy = document.createElement("div");
    copy.className = "cc-theme-showcase-copy";
    if (showcase.eyebrow && config.id !== "enfp-doodle") {{
      const eyebrow = document.createElement("span");
      eyebrow.className = "cc-theme-showcase-eyebrow";
      eyebrow.textContent = showcase.eyebrow;
      copy.appendChild(eyebrow);
    }}
    const title = document.createElement("h1");
    title.className = "cc-theme-showcase-title";
    const titleText = showcase.title || config.name || "Codex";
    if (config.id === "enfp-doodle" && titleText === "先有灵感，再把它变成真的") {{
      [["先有灵感", true], ["，再把它变成", false], ["真的", true]].forEach(([text, accent]) => {{
        const segment = document.createElement("span");
        segment.textContent = String(text);
        if (accent) segment.className = "cc-theme-enfp-title-accent";
        title.appendChild(segment);
      }});
    }} else {{
      title.textContent = titleText;
    }}
    copy.appendChild(title);
    if (config.id === "enfp-doodle") {{
      const mode = document.createElement("p");
      mode.className = "cc-theme-enfp-mode";
      mode.innerHTML = '<strong>ENFP 模式：</strong><span class="coral">脑暴</span>、<span class="teal">试错</span>、<span class="blue">灵感乱飞</span>，但最后都能落地。';
      copy.appendChild(mode);
      const tags = document.createElement("div");
      tags.className = "cc-theme-enfp-tags";
      ["# 自由探索", "# 创意无限", "# 热情驱动", "# 趣味至上"].forEach((label) => {{
        const tag = document.createElement("span");
        tag.textContent = label;
        tags.appendChild(tag);
      }});
      copy.appendChild(tags);
    }} else if (showcase.subtitle) {{
      const subtitle = document.createElement("p");
      subtitle.className = "cc-theme-showcase-subtitle";
      subtitle.textContent = showcase.subtitle;
      copy.appendChild(subtitle);
    }}
    if (p.headerBadge) {{
      const badge = document.createElement("span");
      badge.className = "cc-theme-showcase-badge";
      badge.textContent = String(p.headerBadge);
      copy.appendChild(badge);
    }}
    root.appendChild(copy);

    if (p.motifStyle) {{
      const motif = document.createElement("div");
      motif.className = "cc-theme-showcase-motif";
      motif.dataset.codexThemeDecoration = String(p.motifStyle);
      motif.setAttribute("aria-hidden", "true");
      root.appendChild(motif);
    }}

    if (config.id === "enfp-doodle") {{
      const bubbles = document.createElement("div");
      bubbles.className = "cc-theme-enfp-bubbles";
      bubbles.setAttribute("aria-hidden", "true");
      ["今天适合开脑洞 ✦", "好点子 +99"].forEach((label) => {{
        const bubble = document.createElement("span");
        bubble.textContent = label;
        bubbles.appendChild(bubble);
      }});
      root.appendChild(bubbles);

      const skinCard = document.createElement("div");
      skinCard.className = "cc-theme-enfp-skin-card";
      skinCard.setAttribute("aria-hidden", "true");
      const skinTitle = document.createElement("strong");
      skinTitle.textContent = "♛ 专属皮肤 · ENFP";
      const skinId = document.createElement("span");
      skinId.textContent = "ID: ENFP_灵感小王子";
      skinCard.append(skinTitle, skinId);
      root.appendChild(skinCard);

      const moodCard = document.createElement("div");
      moodCard.className = "cc-theme-enfp-mood-card";
      moodCard.setAttribute("aria-hidden", "true");
      const moodTitle = document.createElement("strong");
      moodTitle.textContent = "今日心情卡 ☺";
      moodCard.appendChild(moodTitle);
      [["创意", "+100"], ["动力", "+100"], ["乐趣", "+100"]].forEach(([label, value]) => {{
        const row = document.createElement("span");
        const name = document.createElement("i");
        const score = document.createElement("b");
        name.textContent = label;
        score.textContent = value;
        row.append(name, score);
        moodCard.appendChild(row);
      }});
      root.appendChild(moodCard);
    }}

    const companion = document.createElement("div");
    companion.className = "cc-theme-showcase-companion";
    companion.setAttribute("aria-hidden", "true");
    const companionMark = document.createElement("span");
    companionMark.className = "cc-theme-showcase-companion-mark";
    companionMark.textContent = themeMark;
    const companionLabel = document.createElement("span");
    companionLabel.className = "cc-theme-showcase-companion-label";
    companionLabel.textContent = String(p.headerBadge || config.name || "Codex");
    companion.append(companionMark, companionLabel);
    root.appendChild(companion);

    if (showcase.portraitImageDataUrl) {{
      const portrait = document.createElement("img");
      portrait.className = "cc-theme-showcase-portrait";
      portrait.alt = "";
      portrait.setAttribute("aria-hidden", "true");
      portrait.src = showcase.portraitImageDataUrl;
      root.classList.add("has-portrait");
      root.appendChild(portrait);
    }}

    const cards = Array.isArray(showcase.cards) ? showcase.cards.slice(0, 4) : [];
    if (showcase.showCards !== false && cards.length) {{
      const cardList = document.createElement("div");
      cardList.className = "cc-theme-showcase-cards";
      cardList.dataset.codexThemeCardGrid = "true";
      cards.forEach((card, index) => {{
        const button = document.createElement("button");
        button.type = "button";
        button.className = "cc-theme-showcase-card";
        button.dataset.codexThemeQuickCard = String(card.icon || "code");
        button.dataset.codexThemeCardIndex = String(index);
        button.title = card.title || "填入任务";
        const icon = document.createElement("span");
        icon.className = "cc-theme-showcase-card-icon";
        icon.innerHTML = iconMarkup[card.icon] || iconMarkup.code;
        const label = document.createElement("span");
        label.className = "cc-theme-showcase-card-label";
        label.textContent = card.title || "开始任务";
        const description = document.createElement("span");
        description.className = "cc-theme-showcase-card-description";
        description.textContent = summarizeCardPrompt(card);
        const cardCopy = document.createElement("span");
        cardCopy.className = "cc-theme-showcase-card-copy";
        cardCopy.append(label, description);
        const cardIndex = document.createElement("span");
        cardIndex.className = "cc-theme-showcase-card-index";
        cardIndex.textContent = String(index + 1).padStart(2, "0");
        const arrow = document.createElement("span");
        arrow.className = "cc-theme-showcase-card-arrow";
        arrow.innerHTML = arrowMarkup;
        button.append(icon, cardCopy, arrow, cardIndex);
        button.addEventListener("click", (event) => {{
          event.preventDefault();
          event.stopPropagation();
          fillComposer(String(card.prompt || ""), home);
        }});
        cardList.appendChild(button);
      }});
      root.appendChild(cardList);
    }}
    host.appendChild(root);
    return root;
  }}
  function syncShowcase() {{
    if (!document.getElementById(styleId)) document.documentElement.appendChild(style);
    setDatasetValue(document.documentElement, "codexCompassTheme", config.id);
    setDatasetValue(document.documentElement, "codexCompassTaskMode", p.taskMode || "ambient");
    setDatasetValue(document.documentElement, "codexCompassLayout", p.layoutStyle || "editorial");
    decorateProjectContextUi();
    const home = findHomeSurface();
    decorateCodexShell(home);
    if (!showcase.enabled) {{
      clearShowcaseDom();
      return false;
    }}
    const host = home ? findShowcaseHost(home) : null;
    if (!(home instanceof HTMLElement) || !(host instanceof HTMLElement)) {{
      clearShowcaseDom();
      setDatasetValue(document.documentElement, "codexCompassThemePage", "thread");
      return false;
    }}
    setDatasetValue(document.documentElement, "codexCompassThemePage", "home");
    document.querySelectorAll(`.${{showcaseHomeClass}}`).forEach((node) => {{
      if (node !== home) node.classList.remove(showcaseHomeClass);
    }});
    document.querySelectorAll(`.${{showcaseHostClass}}`).forEach((node) => {{
      if (node !== host) node.classList.remove(showcaseHostClass);
    }});
    setClassState(home, showcaseHomeClass, true);
    setClassState(host, showcaseHostClass, true);
    let root = document.getElementById(showcaseId);
    if (!root || root.parentElement !== host) {{
      root?.remove();
      root = createShowcase(home, host);
    }}
    document.querySelectorAll(`.${{showcaseComposerClass}}`).forEach((node) => {{
      if (node !== findComposer(home)) node.classList.remove(showcaseComposerClass);
    }});
    const composer = findComposer(home);
    setClassState(composer, showcaseComposerClass, true);
    setDatasetValue(composer, "codexThemeNativeComposer", "true");
    setDatasetValue(document.documentElement, "codexCompassShowcase", config.id);
    return true;
  }}
  let syncTimer = 0;
  function scheduleShowcaseSync() {{
    if (syncTimer) return;
    syncTimer = window.setTimeout(() => {{
      syncTimer = 0;
      syncShowcase();
    }}, 72);
  }}
  const observer = new MutationObserver(() => {{
    if (!document.getElementById(styleId)) document.documentElement.appendChild(style);
    setDatasetValue(document.documentElement, "codexCompassTheme", config.id);
    scheduleShowcaseSync();
  }});
  observer.observe(document.documentElement, {{ childList: true, subtree: true }});
  const appearanceObserver = new MutationObserver(() => scheduleAppearanceSync());
  appearanceObserver.observe(document.documentElement, {{
    attributes: true,
    attributeFilter: ["class", "data-theme", "color-scheme"],
  }});
  if (document.body) {{
    appearanceObserver.observe(document.body, {{
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    }});
  }}
  document.addEventListener("click", handleProjectArchiveClick, true);
  scheduleAppearanceSync(0);
  syncShowcase();
  window[runtimeKey] = {{
    status: "loaded",
    themeId: config.id,
    themeName: config.name,
    loadedAt: new Date().toISOString(),
    syncShowcase,
    syncShell: () => decorateCodexShell(findHomeSurface()),
    cleanup: () => {{
      observer.disconnect();
      appearanceObserver.disconnect();
      if (syncTimer) window.clearTimeout(syncTimer);
      if (appearanceSyncTimer) window.clearTimeout(appearanceSyncTimer);
      document.removeEventListener("click", handleProjectArchiveClick, true);
      projectArchiveCleanupTimers.forEach((timer) => window.clearTimeout(timer));
      projectArchiveCleanupTimers.clear();
      document.removeEventListener("wheel", forwardSidebarRowWheel, true);
      style.remove();
      clearShowcaseDom();
      clearShellDom();
      delete document.documentElement.dataset.codexCompassTheme;
      delete document.documentElement.dataset.codexCompassThemePage;
      delete document.documentElement.dataset.codexCompassTaskMode;
      delete document.documentElement.dataset.codexCompassLayout;
    }}
  }};
}})();
"##
    ))
}

fn builtin_wallpaper(style: &str, background: &str, accent: &str, soft: &str) -> String {
    let decoration = match style {
        "botanical" => format!(
            r#"<g fill="none" stroke="{accent}" stroke-width="3" opacity=".28"><path d="M0 210 C160 70 260 180 360 0"/><path d="M1600 1130 C1440 930 1320 1040 1230 900"/><circle cx="112" cy="132" r="42"/><circle cx="1480" cy="1018" r="55"/></g><g fill="{soft}" opacity=".45"><circle cx="235" cy="78" r="24"/><circle cx="1370" cy="1120" r="18"/><path d="M420 60 q42 40 0 80 q-42-40 0-80"/><path d="M1190 1040 q48 44 0 88 q-48-44 0-88"/></g>"#
        ),
        "leaves" => format!(
            r#"<g fill="none" stroke="{accent}" stroke-width="2.5" opacity=".24"><path d="M90 0 q80 110 10 250"/><path d="M1510 1200 q-110-120 -20-300"/></g><g fill="{soft}" opacity=".42"><ellipse cx="112" cy="110" rx="28" ry="62" transform="rotate(-34 112 110)"/><ellipse cx="154" cy="190" rx="24" ry="54" transform="rotate(32 154 190)"/><ellipse cx="1482" cy="1050" rx="30" ry="68" transform="rotate(38 1482 1050)"/></g>"#
        ),
        "constellation" => format!(
            r#"<g fill="{soft}" opacity=".62"><circle cx="120" cy="126" r="3"/><circle cx="310" cy="210" r="2"/><circle cx="1410" cy="160" r="3"/><circle cx="1240" cy="1010" r="2"/><circle cx="1520" cy="1090" r="3"/></g><g fill="none" stroke="{accent}" stroke-width="1.5" opacity=".24"><path d="M120 126 L310 210 L470 80"/><path d="M1160 1110 L1240 1010 L1520 1090"/></g>"#
        ),
        _ => format!(
            r#"<g fill="none" stroke="{accent}" stroke-width="1.5" opacity=".16"><path d="M0 120 H1600 M0 240 H1600 M0 360 H1600 M0 480 H1600 M0 600 H1600 M0 720 H1600 M0 840 H1600 M0 960 H1600 M0 1080 H1600"/></g><path d="M130 0 V1200" stroke="{soft}" stroke-width="3" opacity=".45"/>"#
        ),
    };
    let svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200" viewBox="0 0 1600 1200"><rect width="1600" height="1200" fill="{background}"/>{decoration}</svg>"#
    );
    format!("data:image/svg+xml;base64,{}", STANDARD.encode(svg))
}

fn unix_timestamp_string() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    #[test]
    fn manager_persists_images_outside_settings_json() {
        let temp = tempfile::tempdir().unwrap();
        let manager = ThemeStudioManager::new(temp.path().join("theme-studio"));
        let mut settings = ThemeStudioSettings::default();
        settings.themes[0].wallpaper_data_url = "data:image/png;base64,cHJlc2VydmVk".to_string();

        manager.save(settings).unwrap();

        let stored = fs::read_to_string(&manager.settings_path).unwrap();
        assert!(!stored.contains("data:image"));
        assert!(
            manager
                .assets_path
                .join("rose-garden")
                .join("wallpaper.png")
                .is_file()
        );
        let loaded = manager.try_load().unwrap();
        assert_eq!(
            loaded.themes[0].wallpaper_data_url,
            "data:image/png;base64,cHJlc2VydmVk"
        );
    }

    #[test]
    fn manager_migrates_embedded_images_during_load() {
        let temp = tempfile::tempdir().unwrap();
        let manager = ThemeStudioManager::new(temp.path().join("theme-studio"));
        fs::create_dir_all(&manager.root).unwrap();
        let mut settings = ThemeStudioSettings::default();
        settings.themes[0].wallpaper_data_url = "data:image/png;base64,bGVnYWN5".to_string();
        fs::write(
            &manager.settings_path,
            serde_json::to_vec_pretty(&settings).unwrap(),
        )
        .unwrap();

        let loaded = manager.try_load().unwrap();

        assert_eq!(
            loaded.themes[0].wallpaper_data_url,
            "data:image/png;base64,bGVnYWN5"
        );
        let stored = fs::read_to_string(&manager.settings_path).unwrap();
        assert!(!stored.contains("data:image"));
        assert!(
            manager
                .assets_path
                .join("rose-garden")
                .join("wallpaper.png")
                .is_file()
        );
    }

    #[test]
    fn deleting_theme_removes_its_asset_directory() {
        let temp = tempfile::tempdir().unwrap();
        let manager = ThemeStudioManager::new(temp.path().join("theme-studio"));
        let mut settings = ThemeStudioSettings::default();
        let mut custom = settings.themes[0].clone();
        custom.id = "custom-cleanup".to_string();
        custom.builtin = false;
        custom.wallpaper_data_url = "data:image/png;base64,Y3VzdG9t".to_string();
        settings.themes.push(custom);
        manager.save(settings).unwrap();
        let custom_assets = manager.assets_path.join("custom-cleanup");
        assert!(custom_assets.is_dir());

        manager.delete_theme("custom-cleanup").unwrap();

        assert!(!custom_assets.exists());
    }

    fn legacy_v2_settings() -> ThemeStudioSettings {
        ThemeStudioSettings {
            schema_version: 2,
            enabled: false,
            selected_theme_id: default_theme_id().to_string(),
            themes: legacy_builtin_themes_v2(),
            updated_at: unix_timestamp_string(),
        }
    }

    #[test]
    fn defaults_are_disabled_and_include_builtin_themes() {
        let settings = ThemeStudioSettings::default();
        assert!(!settings.enabled);
        assert_eq!(settings.selected_theme_id, "rose-garden");
        assert_eq!(settings.schema_version, 3);
        assert_eq!(settings.themes.len(), 8);
        assert!(settings.themes[0].showcase.enabled);
        assert_eq!(settings.themes[0].showcase.cards.len(), 4);
        assert!(settings.themes[0].showcase.hero_image_data_url.is_empty());
        assert!(
            settings.themes[0]
                .wallpaper_data_url
                .starts_with("data:image/webp;base64,")
        );
        let ids = settings
            .themes
            .iter()
            .map(|theme| theme.id.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(ids.len(), 8);
    }

    #[test]
    fn title_bar_text_color_tracks_theme_brightness() {
        let mut settings = ThemeStudioSettings::default();
        assert_eq!(
            theme_title_bar_text_color(&settings),
            ThemeTitleBarTextColor::Default
        );

        settings.enabled = true;
        settings.themes[0].visual.background = "#ffffff".to_string();
        assert_eq!(
            theme_title_bar_text_color(&settings),
            ThemeTitleBarTextColor::Black
        );

        settings.themes[0].visual.background = "#080918".to_string();
        assert_eq!(
            theme_title_bar_text_color(&settings),
            ThemeTitleBarTextColor::White
        );
    }

    #[test]
    fn title_bar_text_color_falls_back_to_surface_then_text() {
        let mut settings = ThemeStudioSettings::default();
        settings.enabled = true;

        // Empty/unparseable background must not strand the buttons on Default.
        settings.themes[0].visual.background = String::new();
        settings.themes[0].visual.surface = "#fffef8".to_string();
        settings.themes[0].visual.text = "#24302d".to_string();
        assert_eq!(
            theme_title_bar_text_color(&settings),
            ThemeTitleBarTextColor::Black,
            "light surface should request dark caption buttons"
        );

        // No background and no surface: infer from a light text color (dark window).
        settings.themes[0].visual.surface = String::new();
        settings.themes[0].visual.text = "#f4f4f4".to_string();
        assert_eq!(
            theme_title_bar_text_color(&settings),
            ThemeTitleBarTextColor::White,
            "light text implies a dark window that needs light caption buttons"
        );
    }

    #[test]
    fn builtin_theme_presets_keep_codex_surfaces_readable() {
        for theme in builtin_themes() {
            assert!(
                theme.visual.sidebar_opacity >= 96,
                "{} sidebar is too transparent",
                theme.id
            );
            assert!(
                theme.visual.content_opacity >= 94,
                "{} content is too transparent",
                theme.id
            );
            assert!(
                theme.visual.wallpaper_opacity <= 60,
                "{} wallpaper is too prominent",
                theme.id
            );
            assert!(
                theme.presentation.task_wallpaper_opacity < theme.visual.wallpaper_opacity,
                "{} task wallpaper should be quieter than the home page",
                theme.id
            );
        }
    }

    #[test]
    fn legacy_builtin_visual_defaults_are_migrated_without_replacing_wallpaper() {
        let mut settings = legacy_v2_settings();
        settings.schema_version = 1;
        let theme = settings
            .themes
            .iter_mut()
            .find(|theme| theme.id == "rose-garden")
            .unwrap();
        theme.visual.sidebar_opacity = 88;
        theme.visual.content_opacity = 82;
        theme.visual.wallpaper_opacity = 100;
        theme.visual.blur_px = 18;
        theme.decorative_style = "none".to_string();
        theme.wallpaper_data_url = "data:image/png;base64,cHJlc2VydmVk".to_string();

        let normalized = normalize_settings(settings).unwrap();
        let theme = normalized
            .themes
            .iter()
            .find(|theme| theme.id == "rose-garden")
            .unwrap();
        assert_eq!(
            (
                theme.visual.sidebar_opacity,
                theme.visual.content_opacity,
                theme.visual.wallpaper_opacity,
                theme.visual.blur_px,
            ),
            (96, 95, 58, 16)
        );
        assert_eq!(theme.decorative_style, "none");
        assert_eq!(
            theme.wallpaper_data_url,
            "data:image/png;base64,cHJlc2VydmVk"
        );
    }

    #[test]
    fn user_modified_builtin_visual_values_are_not_migrated() {
        let mut settings = legacy_v2_settings();
        settings.schema_version = 1;
        let theme = settings
            .themes
            .iter_mut()
            .find(|theme| theme.id == "rose-garden")
            .unwrap();
        theme.visual.sidebar_opacity = 88;
        theme.visual.content_opacity = 83;
        theme.visual.wallpaper_opacity = 100;
        theme.visual.blur_px = 18;

        let normalized = normalize_settings(settings).unwrap();
        let theme = normalized
            .themes
            .iter()
            .find(|theme| theme.id == "rose-garden")
            .unwrap();
        assert_eq!(
            (
                theme.visual.sidebar_opacity,
                theme.visual.content_opacity,
                theme.visual.wallpaper_opacity,
                theme.visual.blur_px,
            ),
            (88, 83, 100, 18)
        );
    }

    #[test]
    fn legacy_rose_showcase_gains_concept_defaults_without_replacing_custom_wallpaper() {
        let mut settings = legacy_v2_settings();
        settings.schema_version = 1;
        let theme = settings
            .themes
            .iter_mut()
            .find(|theme| theme.id == "rose-garden")
            .unwrap();
        theme.version = "1.0.0".to_string();
        theme.showcase = ThemeShowcase::default();
        theme.wallpaper_data_url = "data:image/png;base64,cHJlc2VydmVk".to_string();

        let normalized = normalize_settings(settings).unwrap();
        let theme = normalized
            .themes
            .iter()
            .find(|theme| theme.id == "rose-garden")
            .unwrap();
        assert_eq!(theme.version, "2.1.0");
        assert_eq!(theme.showcase.title, "我们该构建什么？");
        assert!(theme.showcase.hero_image_data_url.is_empty());
        assert_eq!(theme.presentation.layout_style, "editorial");
        assert_eq!(
            theme.wallpaper_data_url,
            "data:image/png;base64,cHJlc2VydmVk"
        );
    }

    #[test]
    fn customized_rose_showcase_does_not_receive_builtin_hero() {
        let mut settings = legacy_v2_settings();
        let theme = settings
            .themes
            .iter_mut()
            .find(|theme| theme.id == "rose-garden")
            .unwrap();
        theme.showcase.title = "我的自定义标题".to_string();

        let normalized = normalize_settings(settings).unwrap();
        let theme = normalized
            .themes
            .iter()
            .find(|theme| theme.id == "rose-garden")
            .unwrap();
        assert!(theme.showcase.hero_image_data_url.is_empty());
        assert_eq!(theme.showcase.title, "我的自定义标题");
        assert_eq!(theme.version, "2.1.0");
    }

    #[test]
    fn runtime_bundle_loads_and_cleans_up_theme() {
        let mut settings = ThemeStudioSettings::default();
        settings.enabled = true;
        let bundle = build_runtime_bundle(&settings).unwrap();
        assert!(bundle.contains("__codexCompassThemeRuntime"));
        assert!(bundle.contains("MutationObserver"));
        assert!(bundle.contains("--color-token-main-surface-primary"));
        assert!(bundle.contains("--vscode-foreground"));
        assert!(bundle.contains("--vscode-list-activeSelectionForeground"));
        assert!(bundle.contains("--vscode-editor-background"));
        assert!(bundle.contains("rose-garden"));
        assert!(bundle.contains("theme-rose-garden"));
        assert!(bundle.contains("codex-compass-theme-showcase"));
        assert!(bundle.contains("fillComposer"));
        assert!(bundle.contains("[data-testid=\"home-icon\"]"));
        assert!(bundle.contains("cc-theme-shell-sidebar"));
        assert!(bundle.contains("cc-theme-shell-sidebar-static"));
        assert!(bundle.contains("cc-theme-shell-account-static"));
        assert!(bundle.contains("cc-theme-shell-search-button"));
        assert!(bundle.contains("cc-theme-shell-window-control"));
        assert!(bundle.contains("cc-theme-shell-window-close"));
        assert!(bundle.contains("[data-app-action-sidebar-project-row]"));
        assert!(bundle.contains("[data-app-action-sidebar-thread-row]"));
        assert!(bundle.contains("[data-codex-intelligence-trigger=\"true\"]"));
        assert!(bundle.contains("[data-slot=\"dialog-overlay\"]"));
        assert!(bundle.contains("[data-slot=\"alert-dialog-overlay\"]"));
        assert!(bundle.contains("[data-slot=\"popover-content\"]"));
        assert!(bundle.contains("[role=\"switch\"][aria-checked=\"true\"]"));
        assert!(bundle.contains("background: var(--cc-theme-surface)"));
        assert!(bundle.contains("syncClassMembers"));
        assert!(bundle.contains("clearShellDom"));
        assert!(bundle.contains("cc-theme-showcase-card-description"));
        assert!(bundle.contains("cc-theme-showcase-brandline"));
        assert!(bundle.contains("cc-theme-showcase-companion"));
        assert!(bundle.contains("cc-theme-shell-stop-button"));
        assert!(bundle.contains("cc-theme-enfp-mode"));
        assert!(bundle.contains("cc-theme-enfp-bubbles"));
        assert!(bundle.contains("ENFP 能量值"));
        assert!(bundle.contains("cc-theme-shell-nav-violet"));
        assert!(bundle.contains("cc-theme-shell-window-minimize"));
        assert!(bundle.contains("[data-window-action]"));
        assert!(bundle.contains("app.appearance.set_mode"));
        assert!(bundle.contains("mode: colorScheme"));
        assert!(bundle.contains("appearanceObserver"));
        assert!(bundle.contains("[role=\"dialog\"][aria-label=\"图片预览\"] *"));
        assert!(bundle.contains("[role=\"dialog\"][aria-label=\"Image preview\"] *"));
        assert!(bundle.contains("decorateProjectContextUi"));
        assert!(bundle.contains("data-codex-theme-project-context-menu"));
        assert!(bundle.contains("data-codex-theme-project-rename-dialog"));
        assert!(bundle.contains("data-codex-theme-project-menu-action=\"archive\""));
        assert!(bundle.contains("handleProjectArchiveClick"));
        assert!(bundle.contains("visibleProjectArchiveConfirmation"));
        assert!(bundle.contains("top: 50% !important"));
        assert!(bundle.contains("transform: translate(-50%, -50%) !important"));
        assert!(!bundle.contains("top: 88px !important"));
        assert!(!bundle.contains("linear-gradient(45deg, transparent 44%"));
        assert!(!bundle.contains("item.top <= 74"));
        assert!(!bundle.contains("window.innerWidth - 240"));
        assert!(bundle.contains("linear-gradient(90deg, #ef765d"));
        assert!(!bundle.contains("https://"));
    }

    #[test]
    fn enfp_v2_1_defaults_upgrade_without_losing_customizations() {
        let mut settings = ThemeStudioSettings {
            schema_version: THEME_SCHEMA_VERSION,
            enabled: true,
            selected_theme_id: "enfp-doodle".to_string(),
            themes: legacy_builtin_themes_v3_1(),
            updated_at: unix_timestamp_string(),
        };
        let theme = settings
            .themes
            .iter_mut()
            .find(|theme| theme.id == "enfp-doodle")
            .unwrap();
        let old_wallpaper = theme.wallpaper_data_url.clone();
        theme.showcase.title = "保留我的 ENFP 标题".to_string();
        theme.visual.accent = "#123456".to_string();

        let normalized = normalize_settings(settings).unwrap();
        let theme = normalized
            .themes
            .iter()
            .find(|theme| theme.id == "enfp-doodle")
            .unwrap();
        assert_eq!(theme.version, "2.2.0");
        assert_eq!(theme.showcase.title, "保留我的 ENFP 标题");
        assert_eq!(theme.visual.accent, "#123456");
        assert_eq!(theme.presentation.header_badge, "好点子 +99");
        assert_eq!(theme.presentation.task_wallpaper_opacity, 5);
        assert_ne!(theme.wallpaper_data_url, old_wallpaper);
        assert!(
            theme.showcase.cards[0]
                .prompt
                .starts_with("把脑子里的一万种可能")
        );
    }

    #[test]
    fn enfp_runtime_bundle_contains_real_concept_components() {
        let mut settings = ThemeStudioSettings::default();
        settings.enabled = true;
        settings.selected_theme_id = "enfp-doodle".to_string();
        let bundle = build_runtime_bundle(&settings).unwrap();
        assert!(bundle.contains("theme-enfp-doodle"));
        assert!(bundle.contains("今天适合开脑洞"));
        assert!(bundle.contains("专属皮肤 · ENFP"));
        assert!(bundle.contains("今日心情卡"));
        assert!(bundle.contains("# 自由探索"));
        assert!(bundle.contains("把脑子里的一万种可能都倒出来"));
    }

    #[test]
    fn remote_wallpapers_are_rejected() {
        let mut theme = builtin_themes().remove(0);
        theme.wallpaper_data_url = "https://example.com/wallpaper.png".to_string();
        assert!(normalize_theme(theme).is_err());
    }

    #[test]
    fn remote_showcase_images_are_rejected() {
        let mut theme = builtin_themes().remove(0);
        theme.showcase.hero_image_data_url = "https://example.com/hero.png".to_string();
        assert!(normalize_theme(theme).is_err());
    }

    #[test]
    fn legacy_settings_gain_builtin_showcase_defaults() {
        let mut settings = legacy_v2_settings();
        settings.schema_version = 1;
        settings.themes[0].showcase = ThemeShowcase::default();
        let normalized = normalize_settings(settings).unwrap();
        assert_eq!(normalized.schema_version, 3);
        assert_eq!(normalized.themes.len(), 8);
        assert!(normalized.themes[0].showcase.enabled);
        assert_eq!(normalized.themes[0].showcase.cards.len(), 4);
    }

    #[test]
    fn v2_settings_gain_three_new_builtin_themes() {
        let normalized = normalize_settings(legacy_v2_settings()).unwrap();
        let ids = normalized
            .themes
            .iter()
            .map(|theme| theme.id.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(normalized.schema_version, 3);
        assert_eq!(ids.len(), 8);
        assert!(ids.contains("red-future-city"));
        assert!(ids.contains("enfp-doodle"));
        assert!(ids.contains("cyan-virtual-stage"));
    }

    #[test]
    fn v2_customizations_survive_builtin_theme_upgrade() {
        let mut settings = legacy_v2_settings();
        let theme = settings
            .themes
            .iter_mut()
            .find(|theme| theme.id == "rose-garden")
            .unwrap();
        theme.wallpaper_data_url = "data:image/png;base64,cHJlc2VydmVk".to_string();
        theme.showcase.title = "保留我的标题".to_string();
        theme.showcase.cards[0].title = "保留我的快捷卡".to_string();
        theme.visual.accent = "#123456".to_string();

        let normalized = normalize_settings(settings).unwrap();
        let theme = normalized
            .themes
            .iter()
            .find(|theme| theme.id == "rose-garden")
            .unwrap();
        assert_eq!(
            theme.wallpaper_data_url,
            "data:image/png;base64,cHJlc2VydmVk"
        );
        assert_eq!(theme.showcase.title, "保留我的标题");
        assert_eq!(theme.showcase.cards[0].title, "保留我的快捷卡");
        assert_eq!(theme.visual.accent, "#123456");
        assert_eq!(theme.presentation.layout_style, "editorial");
    }

    #[test]
    fn future_settings_schema_is_rejected() {
        let mut settings = ThemeStudioSettings::default();
        settings.schema_version = THEME_SCHEMA_VERSION + 1;
        assert!(normalize_settings(settings).is_err());
    }

    #[test]
    fn showcase_rejects_more_than_four_cards() {
        let mut theme = builtin_themes().remove(0);
        theme.showcase.cards.push(ThemeShowcaseCard {
            title: "Extra".to_string(),
            prompt: "Extra".to_string(),
            icon: "code".to_string(),
        });
        assert!(normalize_theme(theme).is_err());
    }

    #[test]
    fn package_rejects_scripts() {
        let bytes = package_with_files(&[
            ("theme.json", sample_manifest("wallpaper.png").as_bytes()),
            ("wallpaper.png", b"png"),
            ("install.js", b"alert(1)"),
        ]);
        assert!(read_theme_package(&bytes).is_err());
    }

    #[test]
    fn package_rejects_path_traversal() {
        assert!(safe_archive_path("../theme.json").is_err());
        assert!(safe_archive_path("folder\\theme.json").is_err());
    }

    #[test]
    fn package_imports_manifest_and_wallpaper() {
        let bytes = package_with_files(&[
            ("theme.json", sample_manifest("wallpaper.png").as_bytes()),
            ("wallpaper.png", b"png"),
        ]);
        let theme = read_theme_package(&bytes).unwrap();
        assert_eq!(theme.id, "custom-theme");
        assert!(
            theme
                .wallpaper_data_url
                .starts_with("data:image/png;base64,")
        );
        assert!(!theme.builtin);
    }

    #[test]
    fn package_imports_showcase_images() {
        let manifest = serde_json::to_string(&json!({
            "schemaVersion": 2,
            "id": "custom-showcase",
            "name": "Custom Showcase",
            "wallpaper": "wallpaper.png",
            "showcase": {
                "enabled": true,
                "title": "Build something",
                "heroImage": "hero.webp",
                "portraitImage": "portrait.jpg",
                "cards": default_showcase_cards(),
            },
            "visual": builtin_themes()[0].visual,
        }))
        .unwrap();
        let bytes = package_with_files(&[
            ("theme.json", manifest.as_bytes()),
            ("wallpaper.png", b"png"),
            ("hero.webp", b"webp"),
            ("portrait.jpg", b"jpeg"),
        ]);
        let theme = read_theme_package(&bytes).unwrap();
        assert!(theme.showcase.enabled);
        assert!(
            theme
                .showcase
                .hero_image_data_url
                .starts_with("data:image/webp;base64,")
        );
        assert!(
            theme
                .showcase
                .portrait_image_data_url
                .starts_with("data:image/jpeg;base64,")
        );
    }

    fn sample_manifest(wallpaper: &str) -> String {
        serde_json::to_string(&json!({
            "schemaVersion": 1,
            "id": "custom-theme",
            "name": "Custom Theme",
            "wallpaper": wallpaper,
            "visual": builtin_themes()[0].visual,
        }))
        .unwrap()
    }

    fn package_with_files(files: &[(&str, &[u8])]) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        for (name, bytes) in files {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }
}
