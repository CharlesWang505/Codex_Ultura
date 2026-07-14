use std::collections::{HashMap, HashSet};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[cfg(windows)]
pub use crate::windows_integration::WindowsProcessInfo;

pub const WATCHER_INTERVAL_SECONDS: f64 = 3.0;
pub const CDP_PROBE_TIMEOUT_SECONDS: f64 = 0.5;
pub const TAKEOVER_FAILURE_BACKOFF_SECONDS: f64 = 30.0;
pub const RESTART_STOP_WAIT_TIMEOUT_MS: u64 = 5_000;
const RESTART_GRACEFUL_CLOSE_WAIT_MS: u64 = 2_500;
const RESTART_STOP_WAIT_INTERVAL_MS: u64 = 100;
pub const WATCHER_RUN_NAME: &str = "CodexPlusWatcher";
pub const WATCHER_RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
pub const WATCHER_STARTUP_SHORTCUT_NAME: &str = "CodexPlusWatcher.lnk";
const LEGACY_WATCHER_RUN_NAME: &str = "CodexPlusPlusWatcher";
const LEGACY_WATCHER_STARTUP_SHORTCUT_NAME: &str = "CodexPlusPlusWatcher.lnk";
const WATCHER_RUNTIME_STATE_NAME: &str = "watcher-runtime.json";
const WATCHER_RUNTIME_STALE_MS: u128 = 15_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatcherInstallPlan {
    pub run_value_name: String,
    pub run_value: String,
    pub shortcut_name: String,
    pub shortcut_target: String,
    pub shortcut_arguments: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatcherRegistrationStatus {
    pub installed: bool,
    pub valid: bool,
    pub registered_value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherRuntimeRecord {
    pub process_id: u32,
    pub executable_path: String,
    pub heartbeat_ms: u128,
    #[serde(default)]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatcherRuntimeStatus {
    pub running: bool,
    pub process_id: Option<u32>,
    pub last_error: Option<String>,
}

pub fn watcher_disabled_flag(root: &Path) -> PathBuf {
    root.join("watcher.disabled")
}

pub fn default_watcher_disabled_flag() -> PathBuf {
    watcher_disabled_flag(&crate::paths::default_app_state_dir())
}

pub fn watcher_runtime_state_path(root: &Path) -> PathBuf {
    root.join(WATCHER_RUNTIME_STATE_NAME)
}

pub fn default_watcher_runtime_state_path() -> PathBuf {
    watcher_runtime_state_path(&crate::paths::default_app_state_dir())
}

pub fn write_watcher_runtime_state(
    root: &Path,
    process_id: u32,
    executable_path: &Path,
    last_error: Option<&str>,
) -> anyhow::Result<()> {
    let record = WatcherRuntimeRecord {
        process_id,
        executable_path: executable_path.to_string_lossy().to_string(),
        heartbeat_ms: now_unix_ms(),
        last_error: last_error.map(ToString::to_string),
    };
    let bytes = serde_json::to_vec_pretty(&record)?;
    crate::settings::atomic_write(&watcher_runtime_state_path(root), &bytes)
}

pub fn clear_watcher_runtime_state(root: &Path, process_id: u32) {
    let path = watcher_runtime_state_path(root);
    let owned = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<WatcherRuntimeRecord>(&bytes).ok())
        .is_some_and(|record| record.process_id == process_id);
    if owned {
        let _ = std::fs::remove_file(path);
    }
}

pub fn watcher_runtime_status(expected_executable: &Path) -> WatcherRuntimeStatus {
    watcher_runtime_status_at(
        &crate::paths::default_app_state_dir(),
        expected_executable,
        now_unix_ms(),
    )
}

fn watcher_runtime_status_at(
    root: &Path,
    expected_executable: &Path,
    now_ms: u128,
) -> WatcherRuntimeStatus {
    let record = std::fs::read(watcher_runtime_state_path(root))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<WatcherRuntimeRecord>(&bytes).ok());
    let Some(record) = record else {
        return WatcherRuntimeStatus {
            running: false,
            process_id: None,
            last_error: None,
        };
    };
    let heartbeat_fresh = now_ms.saturating_sub(record.heartbeat_ms) <= WATCHER_RUNTIME_STALE_MS;
    let executable_matches = paths_equal(Path::new(&record.executable_path), expected_executable);
    let process_matches = watcher_process_matches(record.process_id, expected_executable);
    WatcherRuntimeStatus {
        running: heartbeat_fresh && executable_matches && process_matches,
        process_id: Some(record.process_id),
        last_error: record.last_error,
    }
}

fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

pub fn enable_watcher_at(root: &Path) -> std::io::Result<()> {
    let flag = watcher_disabled_flag(root);
    if flag.exists() {
        std::fs::remove_file(flag)?;
    }
    Ok(())
}

pub fn disable_watcher_at(root: &Path) -> std::io::Result<()> {
    let flag = watcher_disabled_flag(root);
    if let Some(parent) = flag.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(flag, b"disabled")
}

pub fn enable_watcher() -> std::io::Result<()> {
    enable_watcher_at(&crate::paths::default_app_state_dir())
}

pub fn disable_watcher() -> std::io::Result<()> {
    disable_watcher_at(&crate::paths::default_app_state_dir())
}

pub fn cdp_listening(port: u16) -> bool {
    [
        SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        SocketAddr::from((Ipv6Addr::LOCALHOST, port)),
    ]
    .into_iter()
    .any(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok())
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    let left = std::fs::canonicalize(left).unwrap_or_else(|_| left.to_path_buf());
    let right = std::fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
    if cfg!(windows) {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

#[cfg(windows)]
fn watcher_process_matches(process_id: u32, expected_executable: &Path) -> bool {
    crate::windows_integration::enumerate_processes()
        .into_iter()
        .find(|process| process.process_id == process_id)
        .and_then(|process| process.executable_path)
        .is_some_and(|path| paths_equal(&path, expected_executable))
}

#[cfg(not(windows))]
fn watcher_process_matches(process_id: u32, expected_executable: &Path) -> bool {
    process_id == std::process::id()
        && std::env::current_exe()
            .ok()
            .is_some_and(|path| paths_equal(&path, expected_executable))
}

pub fn build_spawn_launcher_command(launcher_path: &str, debug_port: u16) -> Vec<String> {
    vec![
        launcher_path.to_string(),
        "--watcher".to_string(),
        "--hidden".to_string(),
        "--debug-port".to_string(),
        debug_port.to_string(),
    ]
}

pub fn build_watcher_install_plan(launcher_path: PathBuf, debug_port: u16) -> WatcherInstallPlan {
    let launcher = launcher_path.to_string_lossy().to_string();
    let arguments = format!("--watcher --hidden --debug-port {debug_port}");
    WatcherInstallPlan {
        run_value_name: WATCHER_RUN_NAME.to_string(),
        run_value: format!("\"{launcher}\" {arguments}"),
        shortcut_name: WATCHER_STARTUP_SHORTCUT_NAME.to_string(),
        shortcut_target: launcher,
        shortcut_arguments: arguments,
    }
}

pub fn codex_process_ids<'a>(processes: impl IntoIterator<Item = (u32, &'a str)>) -> Vec<u32> {
    processes
        .into_iter()
        .filter_map(|(process_id, executable)| {
            is_windowsapps_codex_app_process(executable).then_some(process_id)
        })
        .collect()
}

fn is_windowsapps_codex_app_process(executable: &str) -> bool {
    let executable = executable.replace('/', "\\").to_ascii_lowercase();
    let Some((_, after_windows_apps)) = executable.split_once("\\windowsapps\\") else {
        return false;
    };
    let Some((package_name, after_package)) = after_windows_apps.split_once('\\') else {
        return false;
    };
    crate::app_paths::is_supported_windows_app_package_name(package_name)
        && after_package.starts_with("app\\")
        && !after_package.starts_with("app\\resources\\")
        && after_package
            .rsplit('\\')
            .next()
            .is_some_and(crate::app_paths::is_supported_app_executable_name)
}

pub fn filter_killable_launcher_processes<'a>(
    processes: impl IntoIterator<Item = (u32, u32, &'a str)>,
    current_process_id: u32,
) -> Vec<u32> {
    let processes = processes.into_iter().collect::<Vec<_>>();
    let parents = processes
        .iter()
        .map(|(process_id, parent_process_id, _)| (*process_id, *parent_process_id))
        .collect::<HashMap<_, _>>();
    let mut protected = HashSet::new();
    let mut cursor = current_process_id;
    while cursor != 0 && protected.insert(cursor) {
        cursor = parents.get(&cursor).copied().unwrap_or(0);
    }
    processes
        .into_iter()
        .filter(|(process_id, _, exe_file)| {
            !protected.contains(process_id) && exe_file.eq_ignore_ascii_case("codex_plus.exe")
        })
        .map(|(process_id, _, _)| process_id)
        .collect()
}

pub fn should_recover_stale_launcher(has_codex_process: bool, cdp_listening: bool) -> bool {
    !has_codex_process && !cdp_listening
}

pub fn process_ids_still_running(
    expected: &[u32],
    running: impl IntoIterator<Item = u32>,
) -> Vec<u32> {
    let expected = expected.iter().copied().collect::<HashSet<_>>();
    running
        .into_iter()
        .filter(|process_id| expected.contains(process_id))
        .collect()
}

#[cfg(windows)]
pub fn watcher_registration_status(
    executable_path: &Path,
    debug_port: u16,
) -> WatcherRegistrationStatus {
    let expected = build_watcher_install_plan(executable_path.to_path_buf(), debug_port);
    let registered_value =
        crate::windows_integration::read_current_user_string_values(WATCHER_RUN_KEY)
            .ok()
            .and_then(|values| {
                values
                    .into_iter()
                    .find(|(name, _)| name == WATCHER_RUN_NAME)
                    .and_then(|(_, value)| value)
            });
    evaluate_watcher_registration(executable_path, &expected.run_value, registered_value)
}

fn evaluate_watcher_registration(
    executable_path: &Path,
    expected_run_value: &str,
    registered_value: Option<String>,
) -> WatcherRegistrationStatus {
    let installed = registered_value.is_some();
    let valid = executable_path.is_file()
        && registered_value.as_deref().is_some_and(|value| {
            if cfg!(windows) {
                value.eq_ignore_ascii_case(expected_run_value)
            } else {
                value == expected_run_value
            }
        });
    WatcherRegistrationStatus {
        installed,
        valid,
        registered_value,
    }
}

#[cfg(not(windows))]
pub fn watcher_registration_status(
    _executable_path: &Path,
    _debug_port: u16,
) -> WatcherRegistrationStatus {
    WatcherRegistrationStatus {
        installed: false,
        valid: false,
        registered_value: None,
    }
}

#[cfg(windows)]
pub fn install_watcher(launcher_path: &Path, debug_port: u16) -> anyhow::Result<()> {
    let plan = build_watcher_install_plan(launcher_path.to_path_buf(), debug_port);
    crate::windows_integration::set_current_user_string_value(
        WATCHER_RUN_KEY,
        &plan.run_value_name,
        &plan.run_value,
    )?;
    let _ = crate::windows_integration::delete_current_user_value(
        WATCHER_RUN_KEY,
        LEGACY_WATCHER_RUN_NAME,
    );
    remove_legacy_startup_shortcuts();
    stop_launcher_processes();
    if let Err(error) = start_watcher(launcher_path, debug_port) {
        let _ = crate::windows_integration::delete_current_user_value(
            WATCHER_RUN_KEY,
            WATCHER_RUN_NAME,
        );
        return Err(error);
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn install_watcher(_launcher_path: &Path, _debug_port: u16) -> anyhow::Result<()> {
    anyhow::bail!("watcher install is only supported on Windows")
}

#[cfg(windows)]
pub fn start_watcher(launcher_path: &Path, debug_port: u16) -> anyhow::Result<()> {
    if watcher_runtime_status(launcher_path).running {
        return Ok(());
    }
    spawn_launcher(launcher_path, debug_port)
}

#[cfg(not(windows))]
pub fn start_watcher(_launcher_path: &Path, _debug_port: u16) -> anyhow::Result<()> {
    anyhow::bail!("watcher start is only supported on Windows")
}

#[cfg(windows)]
pub fn uninstall_watcher() -> anyhow::Result<()> {
    let _ =
        crate::windows_integration::delete_current_user_value(WATCHER_RUN_KEY, WATCHER_RUN_NAME);
    let _ = crate::windows_integration::delete_current_user_value(
        WATCHER_RUN_KEY,
        LEGACY_WATCHER_RUN_NAME,
    );
    remove_legacy_startup_shortcuts();
    stop_launcher_processes();
    Ok(())
}

#[cfg(not(windows))]
pub fn uninstall_watcher() -> anyhow::Result<()> {
    Ok(())
}

#[cfg(windows)]
pub fn find_codex_processes() -> Vec<u32> {
    let processes: Vec<_> = crate::windows_integration::enumerate_processes()
        .into_iter()
        .filter(|process| crate::app_paths::is_supported_app_executable_name(&process.exe_file))
        .collect();
    find_codex_processes_from_snapshot(&processes)
}

/// Filter the list of already enumerated Windows processes for Codex processes.
/// Exposed so the Windows-specific logic can be unit-tested without scanning the live system.
#[cfg(windows)]
pub fn find_codex_processes_from_snapshot(
    processes: &[crate::windows_integration::WindowsProcessInfo],
) -> Vec<u32> {
    let mut ids = codex_process_ids(
        processes
            .iter()
            .filter_map(|process| {
                process
                    .executable_path
                    .as_deref()
                    .map(|path| (process.process_id, path.to_string_lossy().to_string()))
            })
            .collect::<Vec<_>>()
            .iter()
            .map(|(pid, path)| (*pid, path.as_str())),
    );

    // Local/portable installs use Codex.exe as the Electron main process. Do not match
    // lowercase codex.exe here; that is commonly the CLI binary. ChatGPT.exe is accepted
    // only for packaged Store apps above, because the standalone ChatGPT app can be a
    // normal ChatGPT session rather than Codex.
    for process in processes {
        if process.exe_file == "Codex.exe" {
            ids.push(process.process_id);
        }
    }

    ids.sort_unstable();
    ids.dedup();
    ids
}

#[cfg(not(windows))]
pub fn find_codex_processes() -> Vec<u32> {
    Vec::new()
}

#[cfg(windows)]
pub fn stop_launcher_processes() {
    let processes = crate::windows_integration::enumerate_processes();
    let killable = filter_killable_launcher_processes(
        processes.iter().map(|process| {
            (
                process.process_id,
                process.parent_process_id,
                process.exe_file.as_str(),
            )
        }),
        std::process::id(),
    );
    for process_id in killable {
        let _ = crate::windows_integration::terminate_process(process_id);
    }
}

#[cfg(not(windows))]
pub fn stop_launcher_processes() {}

#[cfg(windows)]
pub fn stop_launcher_processes_and_wait() {
    let processes = crate::windows_integration::enumerate_processes();
    let killable = filter_killable_launcher_processes(
        processes.iter().map(|process| {
            (
                process.process_id,
                process.parent_process_id,
                process.exe_file.as_str(),
            )
        }),
        std::process::id(),
    );
    terminate_and_wait_for_exit(
        killable,
        RESTART_STOP_WAIT_TIMEOUT_MS,
        RESTART_STOP_WAIT_INTERVAL_MS,
    );
}

#[cfg(not(windows))]
pub fn stop_launcher_processes_and_wait() {}

#[cfg(windows)]
pub fn stop_codex_processes() {
    for process_id in find_codex_processes() {
        let _ = crate::windows_integration::terminate_process(process_id);
    }
}

#[cfg(not(windows))]
pub fn stop_codex_processes() {}

#[cfg(windows)]
pub fn stop_codex_processes_and_wait() {
    let process_ids = find_codex_processes();
    if process_ids.is_empty() {
        return;
    }
    let graceful_requested = process_ids
        .iter()
        .filter(|process_id| crate::windows_integration::request_process_window_close(**process_id))
        .count();
    let remaining = wait_for_processes_exit(
        &process_ids,
        RESTART_GRACEFUL_CLOSE_WAIT_MS,
        RESTART_STOP_WAIT_INTERVAL_MS,
    );
    let _ = crate::diagnostic_log::append_diagnostic_log(
        "watcher.graceful_codex_close",
        serde_json::json!({
            "process_count": process_ids.len(),
            "window_close_requested": graceful_requested,
            "remaining_process_ids": remaining
        }),
    );
    terminate_and_wait_for_exit(
        remaining,
        RESTART_STOP_WAIT_TIMEOUT_MS,
        RESTART_STOP_WAIT_INTERVAL_MS,
    );
}

#[cfg(not(windows))]
pub fn stop_codex_processes_and_wait() {}

#[cfg(windows)]
fn terminate_and_wait_for_exit(process_ids: Vec<u32>, timeout_ms: u64, interval_ms: u64) {
    if process_ids.is_empty() {
        return;
    }
    for process_id in &process_ids {
        let _ = crate::windows_integration::terminate_process(*process_id);
    }
    let remaining = wait_for_processes_exit(&process_ids, timeout_ms, interval_ms);
    if !remaining.is_empty() {
        let _ = crate::diagnostic_log::append_diagnostic_log(
            "watcher.stop_wait_timeout",
            serde_json::json!({
                "remaining_process_ids": remaining,
                "timeout_ms": timeout_ms
            }),
        );
    }
}

#[cfg(windows)]
fn wait_for_processes_exit(process_ids: &[u32], timeout_ms: u64, interval_ms: u64) -> Vec<u32> {
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let running_process_ids = crate::windows_integration::enumerate_processes()
            .into_iter()
            .map(|process| process.process_id);
        let remaining = process_ids_still_running(process_ids, running_process_ids);
        if remaining.is_empty() || std::time::Instant::now() >= deadline {
            return remaining;
        }
        std::thread::sleep(Duration::from_millis(interval_ms));
    }
}

#[cfg(windows)]
fn spawn_launcher(launcher_path: &Path, debug_port: u16) -> anyhow::Result<()> {
    let command = build_spawn_launcher_command(&launcher_path.to_string_lossy(), debug_port);
    let Some((exe, args)) = command.split_first() else {
        anyhow::bail!("watcher launch command is empty")
    };
    let mut command = crate::windows_integration::silent_background_command(exe);
    command.args(args);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| anyhow::anyhow!("启动 watcher 失败：{error}"))
}

#[cfg(windows)]
fn remove_legacy_startup_shortcuts() {
    if let Some(startup) = startup_dir() {
        for name in [
            WATCHER_STARTUP_SHORTCUT_NAME,
            LEGACY_WATCHER_STARTUP_SHORTCUT_NAME,
        ] {
            let _ = std::fs::remove_file(startup.join(name));
        }
    }
}

#[cfg(windows)]
fn startup_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|appdata| {
        PathBuf::from(appdata)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join("Startup")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_state_requires_fresh_heartbeat_and_matching_process() {
        let temp = tempfile::tempdir().unwrap();
        let executable = std::env::current_exe().unwrap();
        write_watcher_runtime_state(
            temp.path(),
            std::process::id(),
            &executable,
            Some("sample error"),
        )
        .unwrap();
        let record: WatcherRuntimeRecord = serde_json::from_slice(
            &std::fs::read(watcher_runtime_state_path(temp.path())).unwrap(),
        )
        .unwrap();

        let running = watcher_runtime_status_at(temp.path(), &executable, record.heartbeat_ms);
        assert!(running.running);
        assert_eq!(running.process_id, Some(std::process::id()));
        assert_eq!(running.last_error.as_deref(), Some("sample error"));

        let stale = watcher_runtime_status_at(
            temp.path(),
            &executable,
            record.heartbeat_ms + WATCHER_RUNTIME_STALE_MS + 1,
        );
        assert!(!stale.running);
    }

    #[test]
    fn runtime_state_cleanup_only_removes_the_current_process_record() {
        let temp = tempfile::tempdir().unwrap();
        let executable = std::env::current_exe().unwrap();
        write_watcher_runtime_state(temp.path(), 123, &executable, None).unwrap();

        clear_watcher_runtime_state(temp.path(), 456);
        assert!(watcher_runtime_state_path(temp.path()).exists());

        clear_watcher_runtime_state(temp.path(), 123);
        assert!(!watcher_runtime_state_path(temp.path()).exists());
    }

    #[test]
    fn registration_status_distinguishes_missing_drifted_and_valid_entries() {
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("Codex Compass.exe");
        std::fs::write(&executable, b"").unwrap();
        let expected = format!(
            "\"{}\" --watcher --hidden --debug-port 9239",
            executable.to_string_lossy()
        );

        let missing = evaluate_watcher_registration(&executable, &expected, None);
        assert!(!missing.installed);
        assert!(!missing.valid);

        let drifted = evaluate_watcher_registration(
            &executable,
            &expected,
            Some("\"C:/Old/codex_plus.exe\" --debug-port 9239".to_string()),
        );
        assert!(drifted.installed);
        assert!(!drifted.valid);

        let valid = evaluate_watcher_registration(&executable, &expected, Some(expected.clone()));
        assert!(valid.installed);
        assert!(valid.valid);
    }

    #[cfg(windows)]
    #[test]
    fn watcher_spawn_failure_is_returned_to_the_caller() {
        let missing = std::env::temp_dir().join(format!(
            "missing-codex-compass-{}-{}.exe",
            std::process::id(),
            now_unix_ms()
        ));

        let error = start_watcher(&missing, 9239).unwrap_err();

        assert!(error.to_string().contains("启动 watcher 失败"));
    }
}
