use std::{env, path::PathBuf};

use codex_plus_core::theme_studio::{
    ThemeStudioManager, ThemeStudioSettings, build_runtime_bundle,
};

fn main() -> anyhow::Result<()> {
    let mut args = env::args().skip(1);
    let selected_theme_id = args.next();
    let settings_root = args.next().map(PathBuf::from);
    let mut settings = settings_root
        .map(|root| ThemeStudioManager::new(root).load())
        .unwrap_or_else(ThemeStudioSettings::default);
    settings.enabled = true;
    if let Some(selected_theme_id) = selected_theme_id {
        settings.selected_theme_id = selected_theme_id;
    }
    print!("{}", build_runtime_bundle(&settings)?);
    Ok(())
}
