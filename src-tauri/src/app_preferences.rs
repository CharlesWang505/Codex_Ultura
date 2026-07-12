use serde::{Deserialize, Serialize};
use std::fs;
use std::fs::OpenOptions;
use std::io;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, CloseRequestApi, Emitter, Manager, Runtime, WebviewWindow, Window};

const CLOSE_REQUEST_EVENT: &str = "app-close-requested";
const TRAY_SHOW_ID: &str = "tray-show-main";
const TRAY_QUIT_ID: &str = "tray-quit-app";
static PREFERENCES_LOCK: Mutex<()> = Mutex::new(());
static FORCE_EXIT: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CloseBehavior {
    #[default]
    Ask,
    Tray,
    Exit,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPreferences {
    pub close_behavior: CloseBehavior,
}

impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            close_behavior: CloseBehavior::Ask,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CloseResolution {
    Tray,
    Exit,
    Cancel,
}

fn preferences_file(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|_| "无法创建应用设置目录".to_string())?;
    let path = directory.join("app-preferences.json");
    let legacy_path = directory.join("settings").join("app-preferences.json");
    if !path.exists() && legacy_path.is_file() {
        copy_file_if_missing(&legacy_path, &path).map_err(|_| "无法迁移应用设置".to_string())?;
    }
    Ok(path)
}

fn copy_file_if_missing(source: &std::path::Path, target: &std::path::Path) -> io::Result<()> {
    let mut source_file = fs::File::open(source)?;
    let mut target_file = match OpenOptions::new().write(true).create_new(true).open(target) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => return Err(error),
    };
    if let Err(error) = io::copy(&mut source_file, &mut target_file) {
        drop(target_file);
        let _ = fs::remove_file(target);
        return Err(error);
    }
    Ok(())
}

fn read_preferences(app: &AppHandle) -> Result<AppPreferences, String> {
    let _guard = PREFERENCES_LOCK
        .lock()
        .map_err(|_| "应用设置锁异常".to_string())?;
    let path = preferences_file(app)?;
    if !path.exists() {
        return Ok(AppPreferences::default());
    }
    let bytes = fs::read(path).map_err(|_| "无法读取应用设置".to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| "应用设置格式无效".to_string())
}

fn write_preferences(app: &AppHandle, preferences: &AppPreferences) -> Result<(), String> {
    let _guard = PREFERENCES_LOCK
        .lock()
        .map_err(|_| "应用设置锁异常".to_string())?;
    let path = preferences_file(app)?;
    let bytes =
        serde_json::to_vec_pretty(preferences).map_err(|_| "无法序列化应用设置".to_string())?;
    fs::write(path, bytes).map_err(|_| "无法保存应用设置".to_string())
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn hide_main_window(window: &WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|error| error.to_string())
}

fn exit_application<R: Runtime>(app: &AppHandle<R>) {
    FORCE_EXIT.store(true, Ordering::SeqCst);
    app.exit(0);
}

pub fn setup_tray(app: &mut App) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, TRAY_SHOW_ID, "显示主窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, TRAY_QUIT_ID, "退出软件", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip("Codex Compass · 法典指南针")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            TRAY_SHOW_ID => show_main_window(app),
            TRAY_QUIT_ID => exit_application(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main_window(tray.app_handle()),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

pub fn handle_close_requested(window: &Window, api: &CloseRequestApi) {
    if FORCE_EXIT.load(Ordering::SeqCst) {
        return;
    }

    api.prevent_close();
    let app = window.app_handle();
    let behavior = read_preferences(app).unwrap_or_default().close_behavior;
    match behavior {
        CloseBehavior::Ask => {
            let _ = window.emit(CLOSE_REQUEST_EVENT, ());
        }
        CloseBehavior::Tray => {
            let _ = window.hide();
        }
        CloseBehavior::Exit => exit_application(app),
    }
}

#[tauri::command]
pub fn load_app_preferences(app: AppHandle) -> Result<AppPreferences, String> {
    read_preferences(&app)
}

#[tauri::command]
pub fn save_close_behavior(
    app: AppHandle,
    close_behavior: CloseBehavior,
) -> Result<AppPreferences, String> {
    let preferences = AppPreferences { close_behavior };
    write_preferences(&app, &preferences)?;
    Ok(preferences)
}

#[tauri::command]
pub fn resolve_close_request(
    app: AppHandle,
    resolution: CloseResolution,
    remember: bool,
) -> Result<(), String> {
    if remember {
        let close_behavior = match resolution {
            CloseResolution::Tray => Some(CloseBehavior::Tray),
            CloseResolution::Exit => Some(CloseBehavior::Exit),
            CloseResolution::Cancel => None,
        };
        if let Some(close_behavior) = close_behavior {
            write_preferences(&app, &AppPreferences { close_behavior })?;
        }
    }

    match resolution {
        CloseResolution::Tray => {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "主窗口不存在".to_string())?;
            hide_main_window(&window)
        }
        CloseResolution::Exit => {
            exit_application(&app);
            Ok(())
        }
        CloseResolution::Cancel => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_behavior_serializes_as_stable_string() {
        let preferences = AppPreferences {
            close_behavior: CloseBehavior::Tray,
        };
        let json = serde_json::to_string(&preferences).expect("serialize preferences");
        assert_eq!(json, r#"{"closeBehavior":"tray"}"#);
    }

    #[test]
    fn missing_close_behavior_defaults_to_ask() {
        assert_eq!(AppPreferences::default().close_behavior, CloseBehavior::Ask);
    }

    #[test]
    fn preference_migration_never_overwrites_existing_file() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("legacy.json");
        let target = directory.path().join("app-preferences.json");
        fs::write(&source, b"legacy").unwrap();
        fs::write(&target, b"current").unwrap();

        copy_file_if_missing(&source, &target).unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"current");
        assert_eq!(fs::read(&source).unwrap(), b"legacy");
    }
}
