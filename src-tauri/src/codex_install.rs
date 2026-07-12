use std::path::{Path, PathBuf};

pub use codex_plus_core::install::{
    EntryPointState, InstallActionResult, InstallOptions, ShortcutState,
};

const SHORTCUT_NAME: &str = "Codex Compass.lnk";
const LEGACY_SHORTCUT_NAME: &str = "Codex_Ultura.lnk";

fn api_detect_options(mut options: InstallOptions) -> InstallOptions {
    if let Ok(executable) = std::env::current_exe() {
        options
            .launcher_path
            .get_or_insert_with(|| executable.clone());
        options.manager_path.get_or_insert(executable);
    }
    options
}

pub fn install_entrypoints() -> InstallActionResult {
    let options = api_detect_options(InstallOptions::default());
    action_result(platform_install(&options), "Codex Compass 入口已安装。")
}

pub fn uninstall_entrypoints(options: InstallOptions) -> InstallActionResult {
    let options = api_detect_options(options);
    action_result(
        platform_uninstall(&options),
        "Codex Compass 入口已卸载，应用数据已保留。",
    )
}

pub fn repair_shortcuts() -> InstallActionResult {
    let options = api_detect_options(InstallOptions::default());
    action_result(platform_install(&options), "Codex Compass 快捷方式已修复。")
}

pub fn inspect_entrypoints() -> EntryPointState {
    let path = shortcut_path(&InstallOptions::default());
    let state = ShortcutState::from_candidates(path.into_iter().collect());
    // The unified application replaces the former launcher/manager pair, so
    // both compatibility fields intentionally describe the same entrypoint.
    EntryPointState {
        silent_shortcut: state.clone(),
        management_shortcut: state,
    }
}

fn action_result(result: Result<(), String>, success_message: &str) -> InstallActionResult {
    let state = inspect_entrypoints();
    match result {
        Ok(()) => InstallActionResult {
            status: "ok".to_string(),
            message: success_message.to_string(),
            silent_shortcut: state.silent_shortcut,
            management_shortcut: state.management_shortcut,
        },
        Err(error) => InstallActionResult {
            status: "failed".to_string(),
            message: error,
            silent_shortcut: state.silent_shortcut,
            management_shortcut: state.management_shortcut,
        },
    }
}

fn shortcut_path(options: &InstallOptions) -> Option<PathBuf> {
    shortcut_path_named(options, SHORTCUT_NAME)
}

fn legacy_shortcut_path(options: &InstallOptions) -> Option<PathBuf> {
    shortcut_path_named(options, LEGACY_SHORTCUT_NAME)
}

fn shortcut_path_named(options: &InstallOptions, name: &str) -> Option<PathBuf> {
    options
        .install_root
        .clone()
        .or_else(|| {
            directories::UserDirs::new()?
                .desktop_dir()
                .map(Path::to_path_buf)
        })
        .map(|root| root.join(name))
}

#[cfg(windows)]
fn platform_install(options: &InstallOptions) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;

    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
        CoUninitialize, IPersistFile,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    use windows::core::{Interface, PCWSTR};

    fn wide_null(value: impl AsRef<OsStr>) -> Vec<u16> {
        value.as_ref().encode_wide().chain(once(0)).collect()
    }

    let shortcut = shortcut_path(options).ok_or_else(|| "无法定位桌面目录".to_string())?;
    let target = options
        .manager_path
        .as_ref()
        .or(options.launcher_path.as_ref())
        .cloned()
        .ok_or_else(|| "无法定位 Codex Compass 可执行文件".to_string())?;
    if let Some(parent) = shortcut.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|error| format!("初始化快捷方式组件失败：{error}"))?;
        let result = (|| -> windows::core::Result<()> {
            let shell_link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            shell_link.SetPath(PCWSTR(wide_null(&target).as_ptr()))?;
            shell_link.SetArguments(PCWSTR(wide_null("").as_ptr()))?;
            if let Some(directory) = target.parent() {
                shell_link.SetWorkingDirectory(PCWSTR(wide_null(directory).as_ptr()))?;
            }
            shell_link.SetDescription(PCWSTR(wide_null("Open Codex Compass").as_ptr()))?;
            shell_link.SetIconLocation(PCWSTR(wide_null(&target).as_ptr()), 0)?;
            let persist_file: IPersistFile = shell_link.cast()?;
            persist_file.Save(PCWSTR(wide_null(&shortcut).as_ptr()), true)?;
            Ok(())
        })();
        CoUninitialize();
        result.map_err(|error| format!("创建 Codex Compass 快捷方式失败：{error}"))?;
    }
    if let Some(legacy) = legacy_shortcut_path(options) {
        match std::fs::remove_file(legacy) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("清理旧 Codex_Ultura 快捷方式失败：{error}")),
        }
    }
    Ok(())
}

#[cfg(windows)]
fn platform_uninstall(options: &InstallOptions) -> Result<(), String> {
    let Some(shortcut) = shortcut_path(options) else {
        return Err("无法定位桌面目录".to_string());
    };
    for path in [Some(shortcut), legacy_shortcut_path(options)]
        .into_iter()
        .flatten()
    {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn platform_install(_options: &InstallOptions) -> Result<(), String> {
    Err("当前平台由系统应用包管理入口，无需额外安装快捷方式。".to_string())
}

#[cfg(not(windows))]
fn platform_uninstall(_options: &InstallOptions) -> Result<(), String> {
    Err("当前平台由系统应用包管理入口，无需额外卸载快捷方式。".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspect_entrypoints_reports_unified_app_entrypoint() {
        let state = inspect_entrypoints();

        assert!(matches!(state.silent_shortcut.installed, true | false));
        assert_eq!(state.silent_shortcut, state.management_shortcut);
    }

    #[test]
    fn api_detect_entrypoint_targets_current_executable() {
        let executable = std::env::current_exe().unwrap();
        let options = api_detect_options(InstallOptions::default());

        assert_eq!(options.launcher_path.as_deref(), Some(executable.as_path()));
        assert_eq!(options.manager_path.as_deref(), Some(executable.as_path()));
    }

    #[test]
    fn unified_shortcut_uses_codex_compass_name() {
        let root = tempfile::tempdir().unwrap();
        let options = InstallOptions {
            install_root: Some(root.path().to_path_buf()),
            ..InstallOptions::default()
        };

        assert_eq!(
            shortcut_path(&options),
            Some(root.path().join("Codex Compass.lnk"))
        );
    }
}
