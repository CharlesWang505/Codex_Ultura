use codex_plus_core::settings::{FloatingSwitchPosition, SettingsStore};
use serde_json::json;
use tauri::{
    App, AppHandle, Manager, PhysicalPosition, Position, WebviewUrl, WebviewWindowBuilder,
};

const BALL_SIZE: f64 = 58.0;
const PANEL_WIDTH: f64 = 340.0;
const PANEL_HEIGHT: f64 = 390.0;

pub fn setup(app: &mut App) -> tauri::Result<()> {
    let settings = SettingsStore::default().load().unwrap_or_default();
    let position = settings
        .floating_switch_position
        .unwrap_or(FloatingSwitchPosition { x: 24, y: 240 });

    if app.get_webview_window("floating-ball").is_none() {
        WebviewWindowBuilder::new(
            app,
            "floating-ball",
            WebviewUrl::App("index.html?surface=floating".into()),
        )
        .title("Codex Compass 热切换")
        .inner_size(BALL_SIZE, BALL_SIZE)
        .position(position.x as f64, position.y as f64)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(settings.floating_switch_enabled)
        .build()?;
    }

    if app.get_webview_window("floating-panel").is_none() {
        let panel = WebviewWindowBuilder::new(
            app,
            "floating-panel",
            WebviewUrl::App("index.html?surface=floating-panel".into()),
        )
        .title("Codex Compass 热切换")
        .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .build()?;
        let panel_for_event = panel.clone();
        panel.on_window_event(move |event| {
            if let tauri::WindowEvent::Focused(false) = event {
                let _ = panel_for_event.hide();
            }
        });
    }

    start_visibility_sync(app.handle().clone());
    Ok(())
}

fn start_visibility_sync(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_enabled = None;
        loop {
            let enabled = SettingsStore::default()
                .load()
                .map(|settings| settings.floating_switch_enabled)
                .unwrap_or(false);
            if last_enabled != Some(enabled) {
                if let Some(ball) = app.get_webview_window("floating-ball") {
                    if enabled {
                        let _ = ball.show();
                    } else {
                        let _ = ball.hide();
                        if let Some(panel) = app.get_webview_window("floating-panel") {
                            let _ = panel.hide();
                        }
                    }
                }
                last_enabled = Some(enabled);
            }
            tokio::time::sleep(std::time::Duration::from_millis(900)).await;
        }
    });
}

fn apply_floating_visibility(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let ball = app
        .get_webview_window("floating-ball")
        .ok_or_else(|| "悬浮球窗口不存在".to_string())?;
    if enabled {
        ball.show().map_err(|error| error.to_string())?;
    } else {
        ball.hide().map_err(|error| error.to_string())?;
        if let Some(panel) = app.get_webview_window("floating-panel") {
            panel.hide().map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn floating_set_enabled(app: AppHandle, enabled: bool) -> Result<bool, String> {
    SettingsStore::default()
        .update(json!({ "floatingSwitchEnabled": enabled }))
        .map_err(|error| error.to_string())?;
    apply_floating_visibility(&app, enabled)?;
    Ok(enabled)
}

#[tauri::command]
pub fn floating_reset_position(app: AppHandle) -> Result<bool, String> {
    SettingsStore::default()
        .update(json!({ "floatingSwitchPosition": null }))
        .map_err(|error| error.to_string())?;
    let ball = app
        .get_webview_window("floating-ball")
        .ok_or_else(|| "悬浮球窗口不存在".to_string())?;
    ball.set_position(Position::Physical(PhysicalPosition::new(24, 240)))
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn floating_toggle_panel(app: AppHandle) -> Result<(), String> {
    let panel = app
        .get_webview_window("floating-panel")
        .ok_or_else(|| "悬浮面板不存在".to_string())?;
    if panel.is_visible().unwrap_or(false) {
        panel.hide().map_err(|error| error.to_string())?;
        return Ok(());
    }
    if let Some(ball) = app.get_webview_window("floating-ball") {
        if let (Ok(position), Ok(size)) = (ball.outer_position(), ball.outer_size()) {
            let x = position.x + size.width as i32 + 8;
            let y = (position.y - ((PANEL_HEIGHT as i32 - size.height as i32) / 2)).max(0);
            let _ = panel.set_position(Position::Physical(PhysicalPosition::new(x, y)));
        }
    }
    panel.show().map_err(|error| error.to_string())?;
    panel.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn floating_hide_panel(app: AppHandle) -> Result<(), String> {
    if let Some(panel) = app.get_webview_window("floating-panel") {
        panel.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn floating_show_main(app: AppHandle) -> Result<(), String> {
    if let Some(panel) = app.get_webview_window("floating-panel") {
        let _ = panel.hide();
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    let _ = window.unminimize();
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn floating_save_position(x: i32, y: i32) -> Result<(), String> {
    let store = SettingsStore::default();
    let mut settings = store.load().unwrap_or_default();
    settings.floating_switch_position = Some(FloatingSwitchPosition { x, y });
    store.save(&settings).map_err(|error| error.to_string())
}
