#[cfg(windows)]
use std::collections::HashMap;
use std::ffi::OsStr;
#[cfg(windows)]
use std::ffi::OsString;
#[cfg(windows)]
use std::iter::once;
#[cfg(windows)]
use std::os::windows::ffi::{OsStrExt, OsStringExt};
#[cfg(windows)]
use std::path::PathBuf;
use std::process::{Command, Stdio};
#[cfg(windows)]
use std::sync::{Mutex, OnceLock};

#[cfg(windows)]
use anyhow::Context;
#[cfg(windows)]
use windows::Win32::Foundation::{BOOL, CloseHandle, HANDLE, HWND, LPARAM, MAX_PATH, WPARAM};
#[cfg(windows)]
use windows::Win32::Graphics::Dwm::{
    DWMWINDOWATTRIBUTE, DwmGetWindowAttribute, DwmSetWindowAttribute,
};
#[cfg(windows)]
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
    CoTaskMemFree, CoUninitialize, IPersistFile,
};
#[cfg(windows)]
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
#[cfg(windows)]
use windows::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE, REG_EXPAND_SZ, REG_SZ,
    RegCloseKey, RegCreateKeyW, RegDeleteKeyW, RegDeleteValueW, RegEnumValueW, RegOpenKeyExW,
    RegSetValueExW,
};
#[cfg(windows)]
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, QueryFullProcessImageNameW,
    TerminateProcess,
};
#[cfg(windows)]
use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow};
#[cfg(windows)]
use windows::Win32::UI::Shell::{
    ExtractIconExW, FOLDERID_Desktop, IShellLinkW, KF_FLAG_DEFAULT, SHGetKnownFolderPath,
    ShellExecuteW, ShellLink,
};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWMINNOACTIVE;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SW_RESTORE,
    SetForegroundWindow, ShowWindow,
};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    HICON, ICON_BIG, ICON_SMALL, PostMessageW, SendMessageW, WM_CLOSE, WM_SETICON,
};
#[cfg(windows)]
use windows::core::{Interface, PCWSTR, PROPVARIANT, PWSTR};

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn background_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    configure_background_command(&mut command);
    command
}

pub fn configure_background_command(command: &mut Command) {
    command.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

pub fn silent_background_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = background_command(program);
    command.stdout(Stdio::null()).stderr(Stdio::null());
    command
}

#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsProcessInfo {
    pub process_id: u32,
    pub parent_process_id: u32,
    pub exe_file: String,
    pub executable_path: Option<PathBuf>,
}

#[cfg(windows)]
pub struct ComApartment;

#[cfg(windows)]
impl ComApartment {
    pub fn init() -> windows::core::Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        }
        Ok(Self)
    }
}

#[cfg(windows)]
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortcutSpec {
    pub path: PathBuf,
    pub target: PathBuf,
    pub arguments: String,
    pub working_directory: Option<PathBuf>,
    pub description: String,
    pub icon: Option<PathBuf>,
    pub show_minimized: bool,
}

#[cfg(windows)]
pub fn create_shortcut(spec: &ShortcutSpec) -> anyhow::Result<()> {
    if let Some(parent) = spec.path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let _com = ComApartment::init().context("初始化 COM 失败")?;
    unsafe {
        let shell_link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .context("创建 ShellLink COM 对象失败")?;
        shell_link
            .SetPath(PCWSTR(wide_null(spec.target.as_os_str()).as_ptr()))
            .context("设置快捷方式目标失败")?;
        shell_link
            .SetArguments(PCWSTR(wide_null(spec.arguments.as_str()).as_ptr()))
            .context("设置快捷方式参数失败")?;
        if let Some(working_directory) = &spec.working_directory {
            shell_link
                .SetWorkingDirectory(PCWSTR(wide_null(working_directory.as_os_str()).as_ptr()))
                .context("设置快捷方式工作目录失败")?;
        }
        shell_link
            .SetDescription(PCWSTR(wide_null(spec.description.as_str()).as_ptr()))
            .context("设置快捷方式描述失败")?;
        if let Some(icon) = &spec.icon {
            shell_link
                .SetIconLocation(PCWSTR(wide_null(icon.as_os_str()).as_ptr()), 0)
                .context("设置快捷方式图标失败")?;
        }
        if spec.show_minimized {
            shell_link
                .SetShowCmd(SW_SHOWMINNOACTIVE)
                .context("设置快捷方式窗口模式失败")?;
        }
        let persist_file: IPersistFile = shell_link.cast().context("获取 IPersistFile 失败")?;
        persist_file
            .Save(PCWSTR(wide_null(spec.path.as_os_str()).as_ptr()), true)
            .context("保存快捷方式失败")?;
    }
    Ok(())
}

#[cfg(windows)]
pub fn desktop_dir() -> Option<PathBuf> {
    unsafe {
        let path = SHGetKnownFolderPath(&FOLDERID_Desktop, KF_FLAG_DEFAULT, None).ok()?;
        let value = path.to_string().ok().map(PathBuf::from);
        CoTaskMemFree(Some(path.as_ptr().cast()));
        value
    }
}

#[cfg(windows)]
pub fn open_url(url: &str) -> anyhow::Result<()> {
    let operation = wide_null("open");
    let file = wide_null(url);
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(operation.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWMINNOACTIVE,
        )
    };
    let code = result.0 as isize;
    if code <= 32 {
        anyhow::bail!("ShellExecuteW returned {code}");
    }
    Ok(())
}

#[cfg(windows)]
pub fn set_current_user_string_value(subkey: &str, name: &str, value: &str) -> anyhow::Result<()> {
    with_created_current_user_key(subkey, |key| {
        let value = wide_null(value);
        let bytes = slice_as_u8(&value);
        unsafe {
            RegSetValueExW(
                key,
                PCWSTR(wide_null(name).as_ptr()),
                0,
                REG_SZ,
                Some(bytes),
            )
        }
        .ok()
        .with_context(|| format!("写入注册表值 {subkey}\\{name} 失败"))
    })
}

#[cfg(windows)]
pub fn delete_current_user_value(subkey: &str, name: &str) -> anyhow::Result<()> {
    let subkey = wide_null(subkey);
    let name = wide_null(name);
    let mut key = HKEY::default();
    if unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            0,
            KEY_SET_VALUE,
            &mut key,
        )
    }
    .is_err()
    {
        return Ok(());
    }
    let _guard = RegistryKeyGuard(key);
    unsafe { RegDeleteValueW(key, PCWSTR(name.as_ptr())) }
        .ok()
        .or_else(|_| Ok(()))
}

#[cfg(windows)]
pub fn read_current_user_string_values(
    subkey: &str,
) -> anyhow::Result<Vec<(String, Option<String>)>> {
    read_registry_string_values(HKEY_CURRENT_USER, subkey)
}

#[cfg(windows)]
pub fn read_local_machine_string_values(
    subkey: &str,
) -> anyhow::Result<Vec<(String, Option<String>)>> {
    read_registry_string_values(HKEY_LOCAL_MACHINE, subkey)
}

#[cfg(windows)]
fn read_registry_string_values(
    root: HKEY,
    subkey: &str,
) -> anyhow::Result<Vec<(String, Option<String>)>> {
    let subkey = wide_null(subkey);
    let mut key = HKEY::default();
    if unsafe { RegOpenKeyExW(root, PCWSTR(subkey.as_ptr()), 0, KEY_READ, &mut key) }.is_err() {
        return Ok(Vec::new());
    }
    let _guard = RegistryKeyGuard(key);
    let mut values = Vec::new();
    for index in 0.. {
        let mut name = vec![0u16; 256];
        let mut name_len = name.len() as u32;
        let mut value_type = 0u32;
        let mut data = vec![0u8; 8192];
        let mut data_len = data.len() as u32;
        let result = unsafe {
            RegEnumValueW(
                key,
                index,
                PWSTR(name.as_mut_ptr()),
                &mut name_len,
                None,
                Some(&mut value_type),
                Some(data.as_mut_ptr()),
                Some(&mut data_len),
            )
        };
        if result.is_err() {
            break;
        }
        let name = OsString::from_wide(&name[..name_len as usize])
            .to_string_lossy()
            .to_string();
        let value = if value_type == REG_SZ.0 || value_type == REG_EXPAND_SZ.0 {
            let units = unsafe {
                std::slice::from_raw_parts(
                    data.as_ptr().cast::<u16>(),
                    (data_len as usize).div_ceil(2),
                )
            };
            let len = units.iter().position(|ch| *ch == 0).unwrap_or(units.len());
            Some(
                OsString::from_wide(&units[..len])
                    .to_string_lossy()
                    .to_string(),
            )
        } else {
            None
        };
        values.push((name, value));
    }
    Ok(values)
}

#[cfg(windows)]
pub fn delete_current_user_key(subkey: &str) -> anyhow::Result<()> {
    let subkey = wide_null(subkey);
    unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, PCWSTR(subkey.as_ptr())) }
        .ok()
        .or_else(|_| Ok(()))
}

#[cfg(windows)]
pub fn enumerate_processes() -> Vec<WindowsProcessInfo> {
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return Vec::new();
    };
    if snapshot.is_invalid() {
        return Vec::new();
    }
    let _guard = HandleGuard(snapshot);
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut processes = Vec::new();
    if unsafe { Process32FirstW(snapshot, &mut entry) }.is_err() {
        return Vec::new();
    }
    loop {
        let process_id = entry.th32ProcessID;
        processes.push(WindowsProcessInfo {
            process_id,
            parent_process_id: entry.th32ParentProcessID,
            exe_file: nul_terminated_wide_to_string(&entry.szExeFile),
            executable_path: query_process_image_path(process_id),
        });
        if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
            break;
        }
    }
    processes
}

#[cfg(windows)]
pub fn terminate_process(process_id: u32) -> bool {
    let Ok(handle) = (unsafe {
        OpenProcess(
            PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
            false,
            process_id,
        )
    }) else {
        return false;
    };
    if handle.is_invalid() {
        return false;
    }
    let _guard = HandleGuard(handle);
    unsafe { TerminateProcess(handle, 0) }.is_ok()
}

#[cfg(windows)]
pub fn request_process_window_close(process_id: u32) -> bool {
    let Some(hwnd) = visible_window_for_process(process_id) else {
        return false;
    };
    unsafe { PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0)) }.is_ok()
}

#[cfg(windows)]
pub fn activate_process_window(process_id: u32) -> bool {
    let mut state = ActivateWindowState {
        process_id,
        hwnd: HWND::default(),
    };
    unsafe {
        let _ = EnumWindows(
            Some(find_process_window_proc),
            LPARAM((&mut state as *mut ActivateWindowState) as isize),
        );
    }
    if state.hwnd.is_invalid() {
        return false;
    }
    unsafe {
        if IsIconic(state.hwnd).as_bool() {
            let _ = ShowWindow(state.hwnd, SW_RESTORE);
        }
        SetForegroundWindow(state.hwnd).as_bool()
    }
}

#[cfg(windows)]
pub fn apply_codexplusplus_icon_to_process_window(
    process_id: u32,
    icon_resource_path: PathBuf,
) -> bool {
    let Some(hwnd) = visible_window_for_process(process_id) else {
        return false;
    };
    let mut applied = false;
    if apply_window_icons(hwnd, &icon_resource_path) {
        applied = true;
    }
    if apply_taskbar_properties(hwnd, &icon_resource_path).is_ok() {
        applied = true;
    }
    applied
}

#[cfg(windows)]
pub fn apply_codex_title_bar_text_color_to_process_window(
    process_id: u32,
    color: crate::theme_studio::ThemeTitleBarTextColor,
) -> bool {
    let Some(hwnd) = visible_window_for_process(process_id) else {
        return false;
    };
    let color_ref = match color {
        crate::theme_studio::ThemeTitleBarTextColor::Default => 0xFFFF_FFFFu32,
        crate::theme_studio::ThemeTitleBarTextColor::Black => 0x0000_0000u32,
        crate::theme_studio::ThemeTitleBarTextColor::White => 0x00FF_FFFFu32,
    };
    let text_color_applied = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWINDOWATTRIBUTE(36),
            std::ptr::from_ref(&color_ref).cast(),
            std::mem::size_of_val(&color_ref) as u32,
        )
        .is_ok()
    };
    let dark_mode_applied = match immersive_dark_mode_for_title_bar_color(color) {
        Some(dark_mode) => {
            remember_original_title_bar_dark_mode(process_id, hwnd);
            apply_title_bar_dark_mode(hwnd, dark_mode)
        }
        None => restore_original_title_bar_dark_mode(process_id, hwnd),
    };
    // The immersive dark-mode attribute is what actually flips the native
    // caption buttons between light and dark glyphs, so treat it as the source of
    // truth. Some Windows 11 builds reject the caption text-color attribute (36)
    // even though the set call reports success elsewhere; requiring both flags
    // caused the launcher to burn all 30 retries and report failure while the
    // buttons were in fact already visible. Prefer the dark-mode result, and only
    // fall back to the text-color result when dark mode reported no change.
    dark_mode_applied || text_color_applied
}

#[cfg(windows)]
fn immersive_dark_mode_for_title_bar_color(
    color: crate::theme_studio::ThemeTitleBarTextColor,
) -> Option<i32> {
    match color {
        crate::theme_studio::ThemeTitleBarTextColor::Default => None,
        crate::theme_studio::ThemeTitleBarTextColor::Black => Some(0),
        crate::theme_studio::ThemeTitleBarTextColor::White => Some(1),
    }
}

#[cfg(windows)]
fn title_bar_dark_mode_store() -> &'static Mutex<HashMap<(u32, isize), i32>> {
    static ORIGINAL_DARK_MODES: OnceLock<Mutex<HashMap<(u32, isize), i32>>> = OnceLock::new();
    ORIGINAL_DARK_MODES.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(windows)]
fn title_bar_dark_mode_key(process_id: u32, hwnd: HWND) -> (u32, isize) {
    (process_id, hwnd.0 as isize)
}

#[cfg(windows)]
fn remember_original_title_bar_dark_mode(process_id: u32, hwnd: HWND) {
    let key = title_bar_dark_mode_key(process_id, hwnd);
    let Ok(mut originals) = title_bar_dark_mode_store().lock() else {
        return;
    };
    if originals.contains_key(&key) {
        return;
    }
    if let Some(original) = read_title_bar_dark_mode(hwnd) {
        originals.insert(key, original);
    }
}

#[cfg(windows)]
fn restore_original_title_bar_dark_mode(process_id: u32, hwnd: HWND) -> bool {
    let key = title_bar_dark_mode_key(process_id, hwnd);
    let original = title_bar_dark_mode_store()
        .lock()
        .ok()
        .and_then(|mut originals| originals.remove(&key));
    original.is_none_or(|value| apply_title_bar_dark_mode(hwnd, value))
}

#[cfg(windows)]
fn read_title_bar_dark_mode(hwnd: HWND) -> Option<i32> {
    for attribute in [20, 19] {
        let mut value = 0i32;
        if unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWINDOWATTRIBUTE(attribute),
                std::ptr::from_mut(&mut value).cast(),
                std::mem::size_of_val(&value) as u32,
            )
            .is_ok()
        } {
            return Some(value);
        }
    }
    None
}

#[cfg(windows)]
fn apply_title_bar_dark_mode(hwnd: HWND, value: i32) -> bool {
    [20, 19].into_iter().any(|attribute| unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWINDOWATTRIBUTE(attribute),
            std::ptr::from_ref(&value).cast(),
            std::mem::size_of_val(&value) as u32,
        )
        .is_ok()
    })
}

#[cfg(windows)]
fn query_process_image_path(process_id: u32) -> Option<PathBuf> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()? };
    if handle.is_invalid() {
        return None;
    }
    let _guard = HandleGuard(handle);
    let mut buffer = vec![0u16; MAX_PATH as usize * 4];
    let mut len = buffer.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            handle,
            Default::default(),
            PWSTR(buffer.as_mut_ptr()),
            &mut len,
        )
        .ok()?;
    }
    Some(PathBuf::from(OsString::from_wide(&buffer[..len as usize])))
}

#[cfg(windows)]
fn visible_window_for_process(process_id: u32) -> Option<HWND> {
    let mut state = ActivateWindowState {
        process_id,
        hwnd: HWND::default(),
    };
    unsafe {
        let _ = EnumWindows(
            Some(find_process_window_proc),
            LPARAM((&mut state as *mut ActivateWindowState) as isize),
        );
    }
    if state.hwnd.is_invalid() {
        None
    } else {
        Some(state.hwnd)
    }
}

#[cfg(windows)]
struct ActivateWindowState {
    process_id: u32,
    hwnd: HWND,
}

#[cfg(windows)]
unsafe extern "system" fn find_process_window_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let state = unsafe { &mut *(lparam.0 as *mut ActivateWindowState) };
    if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return BOOL(1);
    }
    let mut window_process_id = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut window_process_id));
    }
    if window_process_id == state.process_id {
        state.hwnd = hwnd;
        return BOOL(0);
    }
    BOOL(1)
}

#[cfg(windows)]
fn apply_window_icons(hwnd: HWND, icon_resource_path: &PathBuf) -> bool {
    let Some((large_icon, small_icon)) = load_cached_icons(icon_resource_path) else {
        return false;
    };
    unsafe {
        SendMessageW(
            hwnd,
            WM_SETICON,
            WPARAM(ICON_BIG as usize),
            LPARAM(large_icon.0 as isize),
        );
        SendMessageW(
            hwnd,
            WM_SETICON,
            WPARAM(ICON_SMALL as usize),
            LPARAM(small_icon.0 as isize),
        );
    }
    true
}

#[cfg(windows)]
fn load_cached_icons(icon_resource_path: &PathBuf) -> Option<(HICON, HICON)> {
    static ICONS: OnceLock<(usize, usize)> = OnceLock::new();
    let icons = ICONS.get_or_init(|| {
        let path = wide_null(icon_resource_path.as_os_str());
        let mut large_icon = HICON::default();
        let mut small_icon = HICON::default();
        let loaded = unsafe {
            ExtractIconExW(
                PCWSTR(path.as_ptr()),
                0,
                Some(&mut large_icon),
                Some(&mut small_icon),
                1,
            )
        };
        if loaded == 0 {
            (0, 0)
        } else {
            (large_icon.0 as usize, small_icon.0 as usize)
        }
    });
    if icons.0 == 0 || icons.1 == 0 {
        None
    } else {
        Some((
            HICON(icons.0 as *mut core::ffi::c_void),
            HICON(icons.1 as *mut core::ffi::c_void),
        ))
    }
}

#[cfg(windows)]
fn apply_taskbar_properties(hwnd: HWND, icon_resource_path: &PathBuf) -> anyhow::Result<()> {
    use windows::Win32::Storage::EnhancedStorage::{
        PKEY_AppUserModel_ID, PKEY_AppUserModel_RelaunchCommand,
        PKEY_AppUserModel_RelaunchDisplayNameResource, PKEY_AppUserModel_RelaunchIconResource,
    };

    let store: IPropertyStore = unsafe { SHGetPropertyStoreForWindow(hwnd)? };
    let icon_resource = format!("{},0", icon_resource_path.to_string_lossy());
    let relaunch_command = std::env::current_exe()
        .ok()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| "codex_plus.exe".to_string());
    set_property_string(
        &store,
        &PKEY_AppUserModel_ID,
        "com.bigpizzav3.codexplus.codex",
    )?;
    set_property_string(
        &store,
        &PKEY_AppUserModel_RelaunchIconResource,
        &icon_resource,
    )?;
    set_property_string(
        &store,
        &PKEY_AppUserModel_RelaunchDisplayNameResource,
        "Codex_Plus",
    )?;
    set_property_string(
        &store,
        &PKEY_AppUserModel_RelaunchCommand,
        &relaunch_command,
    )?;
    unsafe {
        store.Commit()?;
    }
    Ok(())
}

#[cfg(windows)]
fn set_property_string(
    store: &IPropertyStore,
    key: &windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY,
    value: &str,
) -> anyhow::Result<()> {
    let variant = PROPVARIANT::from(value);
    unsafe {
        store.SetValue(key, &variant)?;
    }
    Ok(())
}

#[cfg(windows)]
fn with_created_current_user_key<T>(
    subkey: &str,
    f: impl FnOnce(HKEY) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    let mut key = HKEY::default();
    unsafe {
        RegCreateKeyW(
            HKEY_CURRENT_USER,
            PCWSTR(wide_null(subkey).as_ptr()),
            &mut key,
        )
    }
    .ok()
    .with_context(|| format!("打开注册表键 HKCU\\{subkey} 失败"))?;
    let _guard = RegistryKeyGuard(key);
    f(key)
}

#[cfg(windows)]
fn slice_as_u8(value: &[u16]) -> &[u8] {
    unsafe { std::slice::from_raw_parts(value.as_ptr().cast::<u8>(), std::mem::size_of_val(value)) }
}

#[cfg(windows)]
fn wide_null(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(once(0)).collect()
}

#[cfg(windows)]
fn nul_terminated_wide_to_string(value: &[u16]) -> String {
    let len = value.iter().position(|ch| *ch == 0).unwrap_or(value.len());
    OsString::from_wide(&value[..len])
        .to_string_lossy()
        .to_string()
}

#[cfg(windows)]
struct HandleGuard(HANDLE);

#[cfg(windows)]
impl Drop for HandleGuard {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

#[cfg(windows)]
struct RegistryKeyGuard(HKEY);

#[cfg(windows)]
impl Drop for RegistryKeyGuard {
    fn drop(&mut self) {
        let _ = unsafe { RegCloseKey(self.0) };
    }
}

#[cfg(test)]
mod background_command_tests {
    #[test]
    fn automatic_windows_cli_calls_use_background_command_helpers() {
        let app_paths = include_str!("app_paths.rs");
        let git = include_str!("upstream_worktree/git.rs");
        let remote = include_str!("upstream_worktree/remote.rs");
        let watcher = include_str!("watcher.rs");

        assert!(app_paths.contains("windows_integration::background_command(\"powershell.exe\")"));
        assert!(!git.contains("Command::new(\"git\")"));
        assert!(git.contains("windows_integration::background_command(\"git\")"));
        assert!(!remote.contains("Command::new(\"ssh\")"));
        assert!(remote.contains("windows_integration::background_command(\"ssh\")"));
        assert!(watcher.contains("windows_integration::silent_background_command(exe)"));
    }

    #[cfg(windows)]
    #[test]
    fn title_bar_button_mode_tracks_requested_glyph_color() {
        use crate::theme_studio::ThemeTitleBarTextColor;

        assert_eq!(
            super::immersive_dark_mode_for_title_bar_color(ThemeTitleBarTextColor::Black),
            Some(0)
        );
        assert_eq!(
            super::immersive_dark_mode_for_title_bar_color(ThemeTitleBarTextColor::White),
            Some(1)
        );
        assert_eq!(
            super::immersive_dark_mode_for_title_bar_color(ThemeTitleBarTextColor::Default),
            None
        );
    }
}
