use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use codex_plus_core::theme_studio::{
    ThemeShowcaseCard, ThemeStudioManager, ThemeStudioSettings, build_runtime_bundle,
};

const BUILTIN_THEME_IDS: [&str; 8] = [
    "rose-garden",
    "warm-manuscript",
    "red-future-city",
    "mint-paper",
    "enfp-doodle",
    "ink-night",
    "cyan-virtual-stage",
    "starlight-stage",
];

#[test]
fn default_library_uses_schema_v3_and_eight_unique_presentations() {
    let settings = ThemeStudioSettings::default();

    assert_eq!(settings.schema_version, 3);
    assert_eq!(settings.themes.len(), BUILTIN_THEME_IDS.len());

    let expected_ids: HashSet<_> = BUILTIN_THEME_IDS.into_iter().collect();
    let mut actual_ids = HashSet::new();

    for theme in &settings.themes {
        assert!(theme.builtin, "{} should remain a built-in theme", theme.id);
        assert_eq!(
            theme.version, "2.1.0",
            "{} should use the matched-copy preset version",
            theme.id
        );
        assert!(
            actual_ids.insert(theme.id.as_str()),
            "duplicate built-in theme id: {}",
            theme.id
        );
        assert!(theme.showcase.enabled, "{} showcase is disabled", theme.id);
        assert_eq!(
            theme.showcase.cards.len(),
            4,
            "{} should expose four showcase cards",
            theme.id
        );

        let presentation = &theme.presentation;
        assert!(
            !presentation.layout_style.is_empty(),
            "{} has no presentation layout",
            theme.id
        );
        assert!(
            !presentation.card_style.is_empty(),
            "{} has no presentation card style",
            theme.id
        );
        assert!(
            !presentation.motif_style.is_empty(),
            "{} has no presentation motif",
            theme.id
        );
        assert!(
            !presentation.header_badge.is_empty(),
            "{} has no presentation badge",
            theme.id
        );
        assert!(
            matches!(
                presentation.hero_position.as_str(),
                "right" | "far-right" | "center"
            ),
            "{} has unsupported hero position {}",
            theme.id,
            presentation.hero_position
        );
        assert!(
            (40..=96).contains(&presentation.overlay_strength),
            "{} overlay strength is outside the runtime range",
            theme.id
        );
        assert!(
            matches!(
                presentation.task_mode.as_str(),
                "ambient" | "banner" | "off"
            ),
            "{} has unsupported task mode {}",
            theme.id,
            presentation.task_mode
        );
        assert!(
            presentation.task_wallpaper_opacity <= 28,
            "{} task wallpaper exceeds the runtime cap",
            theme.id
        );
        assert!(
            presentation.task_wallpaper_opacity < theme.visual.wallpaper_opacity,
            "{} should reduce wallpaper opacity on task pages",
            theme.id
        );
    }

    assert_eq!(actual_ids, expected_ids);
}

#[test]
fn default_library_copy_matches_each_visual_concept() {
    let settings = ThemeStudioSettings::default();
    let expected = [
        (
            "rose-garden",
            "玫瑰灵感",
            "我们该构建什么？",
            "玫瑰灵感限定",
            "探索代码脉络",
        ),
        (
            "warm-manuscript",
            "财神工作台",
            "今天先把项目搞赚钱",
            "今日财运在线",
            "成本优化",
        ),
        (
            "red-future-city",
            "红色未来城市",
            "OpenAI 是人民的 AI。",
            "面向每一个人",
            "构建应用",
        ),
        (
            "mint-paper",
            "橄榄纸笺",
            "我们该构建什么？",
            "纸笺限定",
            "理清代码脉络",
        ),
        (
            "enfp-doodle",
            "ENFP 灵感宇宙",
            "先有灵感，再把它变成真的",
            "ENERGY 100%",
            "灵感脑暴",
        ),
        (
            "ink-night",
            "蝶光星河",
            "我们该构建什么？",
            "蝶光限定",
            "探索代码星图",
        ),
        (
            "cyan-virtual-stage",
            "未来歌姬舞台",
            "我们今天来构建什么？",
            "未来舞台",
            "编写灵感代码",
        ),
        (
            "starlight-stage",
            "黑金茉莉舞台",
            "我们一起创造什么？",
            "茉莉舞台",
            "探索代码节奏",
        ),
    ];

    for (id, name, title, badge, first_card) in expected {
        let theme = settings.themes.iter().find(|theme| theme.id == id).unwrap();
        assert_eq!(theme.name, name);
        assert_eq!(theme.showcase.title, title);
        assert_eq!(theme.presentation.header_badge, badge);
        assert_eq!(theme.showcase.cards[0].title, first_card);
        assert!(
            theme.showcase.cards[0].prompt.contains('。'),
            "{id} should provide a short card summary before the full prompt"
        );
    }
}

#[test]
fn v3_builtin_copy_upgrade_preserves_user_custom_text() {
    let root = unique_temp_dir("theme-copy-migration");
    let manager = ThemeStudioManager::new(root.clone());
    let mut settings = ThemeStudioSettings::default();
    let rose = settings
        .themes
        .iter_mut()
        .find(|theme| theme.id == "rose-garden")
        .unwrap();
    rose.version = "2.0.0".to_string();
    rose.name = "我的玫瑰主题".to_string();
    rose.description = "奶油白与樱花粉的原创成年人物玫瑰主题。".to_string();
    rose.showcase.eyebrow = "粉色玫瑰 · Codex Compass".to_string();
    rose.showcase.title = "我们该构建什么？".to_string();
    rose.showcase.subtitle = "选择一个方向，或在下方输入今天的任务。".to_string();
    rose.showcase.cards = legacy_default_cards();
    rose.presentation.header_badge = "ROSE EDITION".to_string();

    let migrated = manager.save(settings).unwrap();
    let rose = migrated
        .themes
        .iter()
        .find(|theme| theme.id == "rose-garden")
        .unwrap();

    assert_eq!(rose.version, "2.1.0");
    assert_eq!(rose.name, "我的玫瑰主题");
    assert_eq!(
        rose.description,
        "奶油白、樱花粉、玫瑰花笺与原创人物的柔和灵感主题。"
    );
    assert_eq!(rose.showcase.eyebrow, "玫瑰灵感 · Codex Compass");
    assert_eq!(
        rose.showcase.subtitle,
        "在玫瑰与灵感里，把下一段代码认真做好。"
    );
    assert_eq!(rose.showcase.cards[0].title, "探索代码脉络");
    assert_eq!(rose.presentation.header_badge, "玫瑰灵感限定");

    let _ = fs::remove_dir_all(root);
}

#[test]
fn generated_runtime_bundle_is_valid_javascript() {
    if Command::new("node").arg("--version").output().is_err() {
        return;
    }
    for theme_id in BUILTIN_THEME_IDS {
        let mut settings = ThemeStudioSettings::default();
        settings.enabled = true;
        settings.selected_theme_id = theme_id.to_string();
        let selected = settings
            .themes
            .iter()
            .find(|theme| theme.id == theme_id)
            .unwrap()
            .clone();
        let bundle = build_runtime_bundle(&settings).unwrap();
        assert!(bundle.contains(&selected.name));
        assert!(bundle.contains(&selected.showcase.title));
        for card in &selected.showcase.cards {
            assert!(bundle.contains(&card.title));
            assert!(bundle.contains(&card.prompt));
        }
        let mut child = Command::new("node")
            .args([
                "-e",
                r#"new Function(require("fs").readFileSync(0, "utf8"));"#,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(bundle.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "Node rejected the {theme_id} runtime: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn runtime_bundle_preserves_codex_annotation_overlay_and_readability() {
    let mut settings = ThemeStudioSettings::default();
    settings.enabled = true;
    settings.selected_theme_id = "warm-manuscript".to_string();

    let bundle = build_runtime_bundle(&settings).unwrap();

    assert!(!bundle.contains("body > div,\n    #root > div"));
    assert!(bundle.contains("body > #root,\n    #root > div"));
    assert!(bundle.contains("body > div.pointer-events-none.fixed"));
    assert!(
        bundle.contains(
            "--color-token-conversation-body: color-mix(in srgb, var(--cc-theme-text) 96%"
        )
    );
    assert!(bundle.contains(
        "--color-token-conversation-header: color-mix(in srgb, var(--cc-theme-muted) 86%"
    ));
    assert!(bundle.contains(
        "--color-token-non-assistant-body-descendant: color-mix(in srgb, var(--cc-theme-muted) 92%"
    ));
    assert!(bundle.contains("\"presentation\":{"));
    assert!(bundle.contains("\"taskWallpaperOpacity\":7"));
    assert!(bundle.contains("\"taskMode\":\"ambient\""));
    assert!(bundle.contains("--cc-theme-task-wallpaper-opacity:"));
    assert!(bundle.contains("html[data-codex-compass-theme-page=\"thread\"] body::before"));
    assert!(bundle.contains("opacity: var(--cc-theme-task-wallpaper-opacity);"));
    assert!(bundle.contains("html[data-codex-compass-theme-page=\"thread\"] body::after"));
    assert!(
        bundle.contains("background: color-mix(in srgb, var(--cc-theme-bg) 72%, transparent);")
    );
    assert!(
        bundle.contains("document.documentElement.dataset.codexCompassThemePage = \"thread\";")
    );
    assert!(bundle.contains(
        "document.documentElement.dataset.codexCompassTaskMode = p.taskMode || \"ambient\";"
    ));
    assert!(!bundle.contains("[class*=\"modal\"]"));
    assert!(!bundle.contains("[class*=\"popover\"]"));
}

fn legacy_default_cards() -> Vec<ThemeShowcaseCard> {
    vec![
        ThemeShowcaseCard {
            title: "探索并理解代码".to_string(),
            prompt: "请先阅读当前项目，解释关键结构，并指出最值得从哪里开始。".to_string(),
            icon: "code".to_string(),
        },
        ThemeShowcaseCard {
            title: "构建新功能或工具".to_string(),
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

fn unique_temp_dir(label: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("codex-compass-{label}-{suffix}"))
}
