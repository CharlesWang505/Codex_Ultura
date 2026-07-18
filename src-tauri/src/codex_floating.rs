use codex_plus_core::settings::{FloatingSwitchPosition, SettingsStore};
use serde_json::json;
use tauri::{
    App, AppHandle, Emitter, Manager, PhysicalPosition, Position, WebviewUrl, WebviewWindowBuilder,
    menu::{Menu, MenuItem},
};

const BALL_SIZE: f64 = 66.0;
const PANEL_WIDTH: f64 = 360.0;
const PANEL_HEIGHT: f64 = 460.0;
const FLOATING_OPEN_MAIN_ID: &str = "floating-open-main";
const FLOATING_CLOSE_ID: &str = "floating-close";
const FLOATING_CHANGED_EVENT: &str = "floating-switch-changed";

pub fn setup(_app: &mut App) -> tauri::Result<()> {
    let store = SettingsStore::default();
    let mut settings = store.load().unwrap_or_default();
    if settings.floating_switch_enabled {
        settings.floating_switch_enabled = false;
        let _ = store.save(&settings);
    }
    Ok(())
}

fn create_floating_ball(
    app: &AppHandle,
    position: FloatingSwitchPosition,
) -> tauri::Result<tauri::WebviewWindow> {
    let ball = WebviewWindowBuilder::new(
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
    .visible(false)
    .additional_browser_args("--disable-gpu")
    .build()?;
    let app_handle = app.clone();
    ball.on_menu_event(move |_window, event| match event.id.as_ref() {
        FLOATING_OPEN_MAIN_ID => {
            let _ = floating_show_main(app_handle.clone());
        }
        FLOATING_CLOSE_ID => {
            let _ = set_floating_enabled(&app_handle, false);
        }
        _ => {}
    });
    Ok(ball)
}

fn create_floating_panel(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
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
    .additional_browser_args("--disable-gpu")
    .build()?;
    let panel_for_event = panel.clone();
    panel.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
            let _ = panel_for_event.close();
        }
    });
    Ok(panel)
}

fn ensure_floating_ball(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(ball) = app.get_webview_window("floating-ball") {
        return Ok(ball);
    }
    let position = SettingsStore::default()
        .load()
        .ok()
        .and_then(|settings| settings.floating_switch_position)
        .unwrap_or(FloatingSwitchPosition { x: 24, y: 240 });
    create_floating_ball(app, position).map_err(|error| error.to_string())
}

fn ensure_floating_panel(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(panel) = app.get_webview_window("floating-panel") {
        return Ok(panel);
    }
    create_floating_panel(app).map_err(|error| error.to_string())
}

fn close_floating_windows(app: &AppHandle) {
    if let Some(panel) = app.get_webview_window("floating-panel") {
        let _ = panel.close();
    }
    if let Some(ball) = app.get_webview_window("floating-ball") {
        let _ = ball.close();
    }
}

fn apply_floating_visibility(app: &AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        let ball = ensure_floating_ball(app)?;
        ball.show().map_err(|error| error.to_string())?;
    } else {
        close_floating_windows(app);
    }
    Ok(())
}

fn set_floating_enabled(app: &AppHandle, enabled: bool) -> Result<bool, String> {
    SettingsStore::default()
        .update(json!({ "floatingSwitchEnabled": enabled }))
        .map_err(|error| error.to_string())?;
    apply_floating_visibility(app, enabled)?;
    let _ = app.emit(FLOATING_CHANGED_EVENT, enabled);
    Ok(enabled)
}

#[tauri::command]
pub fn floating_set_enabled(app: AppHandle, enabled: bool) -> Result<bool, String> {
    set_floating_enabled(&app, enabled)
}

#[tauri::command]
pub fn floating_show_context_menu(app: AppHandle) -> Result<(), String> {
    let open_main = MenuItem::with_id(
        &app,
        FLOATING_OPEN_MAIN_ID,
        "打开 Codex Compass",
        true,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let close = MenuItem::with_id(&app, FLOATING_CLOSE_ID, "关闭悬浮球", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let menu = Menu::with_items(&app, &[&open_main, &close]).map_err(|error| error.to_string())?;
    let ball = app
        .get_webview_window("floating-ball")
        .ok_or_else(|| "悬浮球窗口不存在".to_string())?;
    ball.popup_menu(&menu).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn floating_reset_position(app: AppHandle) -> Result<bool, String> {
    SettingsStore::default()
        .update(json!({ "floatingSwitchPosition": null }))
        .map_err(|error| error.to_string())?;
    if let Some(ball) = app.get_webview_window("floating-ball") {
        ball.set_position(Position::Physical(PhysicalPosition::new(24, 240)))
            .map_err(|error| error.to_string())?;
    }
    Ok(true)
}

#[tauri::command]
pub fn floating_toggle_panel(app: AppHandle) -> Result<(), String> {
    let _ = ensure_floating_ball(&app)?;
    let panel = ensure_floating_panel(&app)?;
    if panel.is_visible().unwrap_or(false) {
        panel.close().map_err(|error| error.to_string())?;
        return Ok(());
    }
    if let Some(ball) = app.get_webview_window("floating-ball") {
        if let (Ok(position), Ok(size), Ok(panel_size)) =
            (ball.outer_position(), ball.outer_size(), panel.outer_size())
        {
            let preferred_right = position.x + size.width as i32 + 8;
            let preferred_left = position.x - panel_size.width as i32 - 8;
            let centered_y = position.y + (size.height as i32 - panel_size.height as i32) / 2;
            let (mut x, mut y) = (preferred_right, centered_y.max(0));

            if let Ok(Some(monitor)) = ball.current_monitor() {
                let monitor_position = monitor.position();
                let monitor_size = monitor.size();
                let max_x = (monitor_position.x + monitor_size.width as i32
                    - panel_size.width as i32)
                    .max(monitor_position.x);
                let max_y = (monitor_position.y + monitor_size.height as i32
                    - panel_size.height as i32)
                    .max(monitor_position.y);
                x = if preferred_right <= max_x {
                    preferred_right
                } else if preferred_left >= monitor_position.x {
                    preferred_left
                } else {
                    preferred_right.clamp(monitor_position.x, max_x)
                };
                y = centered_y.clamp(monitor_position.y, max_y);
            }

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
        panel.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn floating_show_main(app: AppHandle) -> Result<(), String> {
    if let Some(panel) = app.get_webview_window("floating-panel") {
        let _ = panel.close();
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
