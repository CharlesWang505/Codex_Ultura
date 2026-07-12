use reqwest::header::{
    ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue, SET_COOKIE,
};
use reqwest::{Client, Method, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::webview::PageLoadEvent;
#[cfg(target_os = "windows")]
use tauri::window::Color;
#[cfg(target_os = "macos")]
use tauri::window::EffectState;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use tauri::window::{Effect, EffectsBuilder};
use tauri::{AppHandle, Manager};

mod app_preferences;
pub(crate) mod codex_commands;
mod codex_floating;
mod codex_install;
mod codex_storage;
mod proxy_latency;

mod codex_plus_manager_lib {
    pub(crate) use crate::codex_commands as commands;
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestInput {
    url: String,
    api_key: Option<String>,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<Value>,
    timeout_ms: Option<u64>,
    include_headers: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestResult {
    ok: bool,
    status: u16,
    status_text: String,
    data: Value,
    duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    headers: Option<HashMap<String, String>>,
}

fn elapsed_ms(started_at: Instant) -> u64 {
    started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

fn request_error(started_at: Instant, message: String) -> RequestResult {
    RequestResult {
        ok: false,
        status: 0,
        status_text: message,
        data: Value::Null,
        duration_ms: elapsed_ms(started_at),
        headers: None,
    }
}

fn collect_response_headers(headers: &HeaderMap) -> HashMap<String, String> {
    let mut collected = HashMap::new();

    for (name, value) in headers {
        if name == SET_COOKIE {
            continue;
        }
        if let Ok(text) = value.to_str() {
            collected.insert(name.as_str().to_ascii_lowercase(), text.to_string());
        }
    }

    let set_cookies = headers
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .collect::<Vec<_>>()
        .join("\n");
    if !set_cookies.is_empty() {
        collected.insert("set-cookie".to_string(), set_cookies);
    }

    collected
}

#[tauri::command]
async fn relay_request(input: RequestInput) -> RequestResult {
    let started_at = Instant::now();
    let timeout = Duration::from_millis(input.timeout_ms.unwrap_or(12_000).max(1));
    let client = match Client::builder()
        .redirect(Policy::limited(10))
        .timeout(timeout)
        .build()
    {
        Ok(client) => client,
        Err(error) => return request_error(started_at, error.to_string()),
    };

    let method = input
        .method
        .as_deref()
        .unwrap_or("GET")
        .parse::<Method>()
        .unwrap_or(Method::GET);
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

    for (name, value) in input.headers.unwrap_or_default() {
        let Ok(header_name) = HeaderName::from_bytes(name.as_bytes()) else {
            continue;
        };
        let Ok(header_value) = HeaderValue::from_str(&value) else {
            continue;
        };
        headers.insert(header_name, header_value);
    }

    if let Some(api_key) = input.api_key.filter(|value| !value.trim().is_empty()) {
        if let Ok(value) = HeaderValue::from_str(&format!("Bearer {}", api_key.trim())) {
            headers.insert(AUTHORIZATION, value);
        }
    }

    let mut request = client.request(method, &input.url).headers(headers);
    if let Some(body) = input.body {
        request = request.json(&body);
    }

    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            let message = if error.is_timeout() {
                "Request timed out".to_string()
            } else {
                error.to_string()
            };
            return request_error(started_at, message);
        }
    };

    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or_default().to_string();
    let response_headers = input
        .include_headers
        .unwrap_or(false)
        .then(|| collect_response_headers(response.headers()));
    let body = match response.text().await {
        Ok(body) => body,
        Err(error) => return request_error(started_at, error.to_string()),
    };
    let data = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&body).unwrap_or(Value::String(body))
    };

    RequestResult {
        ok: status.is_success(),
        status: status.as_u16(),
        status_text,
        data,
        duration_ms: elapsed_ms(started_at),
        headers: response_headers,
    }
}

fn sensitive_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("sensitive");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn sites_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(sensitive_directory(app)?.join("sites.json"))
}

#[tauri::command]
fn load_sites(app: AppHandle) -> Result<Vec<Value>, String> {
    let path = sites_file(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_sites(app: AppHandle, sites: Vec<Value>) -> Result<(), String> {
    let path = sites_file(&app)?;
    let bytes = serde_json::to_vec_pretty(&sites).map_err(|error| error.to_string())?;
    fs::write(path, bytes).map_err(|error| error.to_string())
}

#[tauri::command]
fn sensitive_storage_path(app: AppHandle) -> Result<String, String> {
    Ok(sensitive_directory(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let watcher_hidden = watcher_hidden_from_args(std::env::args());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            codex_storage::setup(app).map_err(std::io::Error::other)?;
            if !watcher_hidden {
                app_preferences::setup_tray(app)?;
                codex_floating::setup(app)?;
            }

            let hot_switch_runtime = codex_plus_manager_lib::commands::HotSwitchRuntime::default();
            let saved_settings = codex_plus_core::settings::SettingsStore::default()
                .load()
                .unwrap_or_default();
            if !watcher_hidden && saved_settings.hot_switch_enabled {
                let _ =
                    tauri::async_runtime::block_on(hot_switch_runtime.start_for_saved_settings());
            }
            app.manage(hot_switch_runtime);

            if watcher_hidden {
                setup_hidden_watcher(app.handle().clone())?;
            }

            let window = app
                .get_webview_window("main")
                .ok_or_else(|| std::io::Error::other("main window was not created"))?;

            #[cfg(target_os = "windows")]
            window.set_effects(
                EffectsBuilder::new()
                    .effect(Effect::Acrylic)
                    .color(Color(8, 12, 18, 150))
                    .build(),
            )?;

            #[cfg(target_os = "macos")]
            window.set_effects(
                EffectsBuilder::new()
                    .effect(Effect::Sidebar)
                    .state(EffectState::Active)
                    .radius(8.0)
                    .build(),
            )?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main"
                && let tauri::WindowEvent::CloseRequested { api, .. } = event
            {
                app_preferences::handle_close_requested(window, api);
            }
        })
        .on_page_load(move |webview, payload| {
            if !watcher_hidden
                && webview.label() == "main"
                && payload.event() == PageLoadEvent::Finished
            {
                let _ = webview.window().show();
            }
        })
        .invoke_handler(tauri::generate_handler![
            relay_request,
            load_sites,
            save_sites,
            sensitive_storage_path,
            app_version,
            app_preferences::load_app_preferences,
            app_preferences::save_close_behavior,
            app_preferences::resolve_close_request,
            codex_floating::floating_toggle_panel,
            codex_floating::floating_set_enabled,
            codex_floating::floating_reset_position,
            codex_floating::floating_hide_panel,
            codex_floating::floating_show_main,
            codex_floating::floating_save_position,
            proxy_latency::load_proxy_latency_config,
            proxy_latency::save_proxy_latency_config,
            proxy_latency::import_proxy_subscription,
            proxy_latency::remove_proxy_subscription,
            proxy_latency::discover_proxy_controllers,
            proxy_latency::list_proxy_nodes,
            proxy_latency::test_proxy_delay,
            proxy_latency::test_direct_delay,
            proxy_latency::managed_mihomo_status,
            proxy_latency::enable_managed_mihomo,
            proxy_latency::disable_managed_mihomo,
            codex_plus_manager_lib::commands::backend_version,
            codex_plus_manager_lib::commands::startup_options,
            codex_plus_manager_lib::commands::load_overview,
            codex_plus_manager_lib::commands::launch_codex_plus,
            codex_plus_manager_lib::commands::restart_codex_plus,
            codex_plus_manager_lib::commands::load_settings,
            codex_plus_manager_lib::commands::save_settings,
            codex_plus_manager_lib::commands::hot_switch_status,
            codex_plus_manager_lib::commands::set_hot_switch,
            codex_plus_manager_lib::commands::scan_hot_switch_model_mappings,
            codex_plus_manager_lib::commands::save_hot_switch_model_mappings,
            codex_plus_manager_lib::commands::load_ccs_providers,
            codex_plus_manager_lib::commands::import_ccs_providers,
            codex_plus_manager_lib::commands::load_pending_provider_import,
            codex_plus_manager_lib::commands::confirm_pending_provider_import,
            codex_plus_manager_lib::commands::dismiss_pending_provider_import,
            codex_plus_manager_lib::commands::list_local_sessions,
            codex_plus_manager_lib::commands::delete_local_session,
            codex_plus_manager_lib::commands::load_provider_sync_targets,
            codex_plus_manager_lib::commands::sync_providers_now,
            codex_plus_manager_lib::commands::refresh_script_market,
            codex_plus_manager_lib::commands::install_market_script,
            codex_plus_manager_lib::commands::set_user_script_enabled,
            codex_plus_manager_lib::commands::load_user_script_runtime,
            codex_plus_manager_lib::commands::reload_user_scripts,
            codex_plus_manager_lib::commands::delete_user_script,
            codex_plus_manager_lib::commands::open_external_url,
            codex_plus_manager_lib::commands::install_entrypoints,
            codex_plus_manager_lib::commands::uninstall_entrypoints,
            codex_plus_manager_lib::commands::repair_shortcuts,
            codex_plus_manager_lib::commands::plugin_marketplace_status,
            codex_plus_manager_lib::commands::repair_plugin_marketplace,
            codex_plus_manager_lib::commands::remote_plugin_marketplace_status,
            codex_plus_manager_lib::commands::repair_remote_plugin_marketplace,
            codex_plus_manager_lib::commands::check_update,
            codex_plus_manager_lib::commands::perform_update,
            codex_plus_manager_lib::commands::load_watcher_state,
            codex_plus_manager_lib::commands::install_watcher,
            codex_plus_manager_lib::commands::uninstall_watcher,
            codex_plus_manager_lib::commands::enable_watcher,
            codex_plus_manager_lib::commands::disable_watcher,
            codex_plus_manager_lib::commands::read_latest_logs,
            codex_plus_manager_lib::commands::copy_diagnostics,
            codex_plus_manager_lib::commands::reset_settings,
            codex_plus_manager_lib::commands::reset_image_overlay_settings,
            codex_plus_manager_lib::commands::relay_status,
            codex_plus_manager_lib::commands::read_relay_files,
            codex_plus_manager_lib::commands::check_env_conflicts,
            codex_plus_manager_lib::commands::remove_env_conflicts,
            codex_plus_manager_lib::commands::save_relay_file,
            codex_plus_manager_lib::commands::write_diagnostic_event,
            codex_plus_manager_lib::commands::backfill_relay_profile_from_live,
            codex_plus_manager_lib::commands::list_context_entries,
            codex_plus_manager_lib::commands::read_live_context_entries,
            codex_plus_manager_lib::commands::sync_live_context_entries,
            codex_plus_manager_lib::commands::upsert_context_entry,
            codex_plus_manager_lib::commands::delete_context_entry,
            codex_plus_manager_lib::commands::extract_relay_common_config,
            codex_plus_manager_lib::commands::test_relay_profile,
            codex_plus_manager_lib::commands::diagnose_relay_profile,
            codex_plus_manager_lib::commands::test_stepwise_settings,
            codex_plus_manager_lib::commands::fetch_relay_profile_models,
            codex_plus_manager_lib::commands::switch_relay_profile,
            codex_plus_manager_lib::commands::apply_relay_injection,
            codex_plus_manager_lib::commands::apply_pure_api_injection,
            codex_plus_manager_lib::commands::clear_relay_injection
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                proxy_latency::shutdown_managed_mihomo();
                if watcher_hidden {
                    codex_plus_core::watcher::clear_watcher_runtime_state(
                        &codex_plus_core::paths::default_app_state_dir(),
                        std::process::id(),
                    );
                }
            }
        });
}

fn watcher_hidden_from_args<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut watcher = false;
    let mut hidden = false;
    for arg in args {
        watcher |= arg.as_ref() == "--watcher";
        hidden |= arg.as_ref() == "--hidden";
    }
    watcher && hidden
}

fn setup_hidden_watcher(app: AppHandle) -> tauri::Result<()> {
    let executable = std::env::current_exe().map_err(std::io::Error::other)?;
    let registration = codex_plus_core::watcher::watcher_registration_status(&executable, 9239);
    if codex_plus_core::watcher::default_watcher_disabled_flag().exists() || !registration.valid {
        app.exit(0);
        return Ok(());
    }

    let state_root = codex_plus_core::paths::default_app_state_dir();
    let launch_error = codex_plus_manager_lib::commands::start_hidden_watcher_launcher()
        .err()
        .map(|error| error.to_string());
    codex_plus_core::watcher::write_watcher_runtime_state(
        &state_root,
        std::process::id(),
        &executable,
        launch_error.as_deref(),
    )
    .map_err(std::io::Error::other)?;

    let startup_error = launch_error;
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(3));
        loop {
            interval.tick().await;
            let registration =
                codex_plus_core::watcher::watcher_registration_status(&executable, 9239);
            if codex_plus_core::watcher::default_watcher_disabled_flag().exists()
                || !registration.valid
            {
                codex_plus_core::watcher::clear_watcher_runtime_state(
                    &state_root,
                    std::process::id(),
                );
                app.exit(0);
                break;
            }
            let (_, last_error) =
                codex_plus_manager_lib::commands::embedded_launcher_runtime_status();
            let last_error = last_error.or_else(|| startup_error.clone());
            let _ = codex_plus_core::watcher::write_watcher_runtime_state(
                &state_root,
                std::process::id(),
                &executable,
                last_error.as_deref(),
            );
        }
    });
    Ok(())
}

#[cfg(test)]
mod watcher_startup_tests {
    use super::watcher_hidden_from_args;

    #[test]
    fn hidden_watcher_mode_requires_both_flags() {
        assert!(watcher_hidden_from_args([
            "codex-compass",
            "--watcher",
            "--hidden"
        ]));
        assert!(!watcher_hidden_from_args(["codex-compass", "--watcher"]));
        assert!(!watcher_hidden_from_args(["codex-compass", "--hidden"]));
    }
}
