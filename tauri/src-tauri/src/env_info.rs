use crate::packets::netstat;
use std::ffi::c_void;
use std::net::Ipv4Addr;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_SERVICE_DOES_NOT_EXIST, HANDLE, NO_ERROR,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO,
};
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows_sys::Win32::System::Registry::{
    RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
};
use windows_sys::Win32::System::Services::{
    CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceConfigW, QueryServiceStatus,
    QUERY_SERVICE_CONFIGW, SC_MANAGER_CONNECT, SERVICE_QUERY_CONFIG, SERVICE_QUERY_STATUS,
    SERVICE_RUNNING, SERVICE_START_PENDING, SERVICE_STATUS, SERVICE_STOPPED,
    SERVICE_STOP_PENDING,
};
use windows_sys::Win32::System::SystemInformation::{
    IMAGE_FILE_MACHINE_AMD64, IMAGE_FILE_MACHINE_ARM64, IMAGE_FILE_MACHINE_I386,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

const WINDOWS_VERSION_KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
/// QueryServiceConfigW の資料にあるバッファの上限
const SERVICE_CONFIG_BUFFER_BYTES: usize = 8 * 1024;

type IsWow64Process2Fn = unsafe extern "system" fn(HANDLE, *mut u16, *mut u16) -> i32;

pub fn log_environment() {
    crate::diag!("[env] Windows: {}", windows_version());
    crate::diag!(
        "[env] CPU: ネイティブ {} / ツール {}",
        native_machine(),
        std::env::consts::ARCH
    );
    crate::diag!("[env] 管理者権限: {}", elevation());
    match std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    {
        Some(dir) => {
            crate::diag!("[env] 実行フォルダ: {}", dir.display());
            for name in ["WinDivert.dll", "WinDivert64.sys"] {
                crate::diag!("[env] {}: {}", name, describe_file(&dir.join(name)));
            }
        }
        None => crate::diag!("[env] 実行フォルダ: 不明"),
    }
    for adapter in netstat::adapters() {
        let ipv4: Vec<String> = adapter
            .ipv4
            .iter()
            .map(|addr| Ipv4Addr::from(*addr).to_string())
            .collect();
        crate::diag!(
            "[env] アダプタ: {} 状態: {} IPv4: {}",
            adapter.label,
            if adapter.up { "有効" } else { "無効" },
            if ipv4.is_empty() {
                "なし".to_string()
            } else {
                ipv4.join(", ")
            }
        );
    }
}

pub fn windivert_service() -> String {
    unsafe {
        let manager = OpenSCManagerW(null(), null(), SC_MANAGER_CONNECT);
        if manager.is_null() {
            return format!("取得失敗 コード {}", GetLastError());
        }
        let name = to_wide("WinDivert");
        let service = OpenServiceW(
            manager,
            name.as_ptr(),
            SERVICE_QUERY_STATUS | SERVICE_QUERY_CONFIG,
        );
        if service.is_null() {
            let code = GetLastError();
            CloseServiceHandle(manager);
            return if code == ERROR_SERVICE_DOES_NOT_EXIST {
                "未登録".to_string()
            } else {
                format!("取得失敗 コード {}", code)
            };
        }

        let mut status = SERVICE_STATUS::default();
        let state = if QueryServiceStatus(service, &mut status) != 0 {
            describe_service_state(status.dwCurrentState)
        } else {
            format!("取得失敗 コード {}", GetLastError())
        };

        let mut buffer = vec![0u64; SERVICE_CONFIG_BUFFER_BYTES / 8];
        let mut needed = 0u32;
        let path = if QueryServiceConfigW(
            service,
            buffer.as_mut_ptr().cast(),
            SERVICE_CONFIG_BUFFER_BYTES as u32,
            &mut needed,
        ) != 0
        {
            netstat::from_wide((*buffer.as_ptr().cast::<QUERY_SERVICE_CONFIGW>()).lpBinaryPathName)
        } else {
            format!("取得失敗 コード {}", GetLastError())
        };

        CloseServiceHandle(service);
        CloseServiceHandle(manager);
        format!("{} パス: {}", state, path)
    }
}

fn describe_service_state(state: u32) -> String {
    match state {
        SERVICE_STOPPED => "停止".to_string(),
        SERVICE_START_PENDING => "開始中".to_string(),
        SERVICE_STOP_PENDING => "停止中".to_string(),
        SERVICE_RUNNING => "実行中".to_string(),
        other => format!("状態 {}", other),
    }
}

fn windows_version() -> String {
    let build = reg_string(WINDOWS_VERSION_KEY, "CurrentBuildNumber")
        .unwrap_or_else(|| "不明".to_string());
    let ubr = reg_dword(WINDOWS_VERSION_KEY, "UBR").map_or("不明".to_string(), |v| v.to_string());
    let display = reg_string(WINDOWS_VERSION_KEY, "DisplayVersion")
        .unwrap_or_else(|| "不明".to_string());
    format!("ビルド {}.{} ({})", build, ubr, display)
}

/// IsWow64Process2 は Windows 10 1709 より前には存在せず、直接リンクするとツール自体が起動できなくなるため実行時に探す
fn native_machine() -> String {
    unsafe {
        let kernel32 = to_wide("kernel32.dll");
        let module = GetModuleHandleW(kernel32.as_ptr());
        if module.is_null() {
            return "取得不可".to_string();
        }
        let Some(proc) = GetProcAddress(module, b"IsWow64Process2\0".as_ptr()) else {
            return "取得不可".to_string();
        };
        let is_wow64_process2: IsWow64Process2Fn = std::mem::transmute(proc);
        let mut process_machine = 0u16;
        let mut native = 0u16;
        if is_wow64_process2(GetCurrentProcess(), &mut process_machine, &mut native) == 0 {
            return "取得不可".to_string();
        }
        match native {
            IMAGE_FILE_MACHINE_AMD64 => "x64".to_string(),
            IMAGE_FILE_MACHINE_ARM64 => "ARM64".to_string(),
            IMAGE_FILE_MACHINE_I386 => "x86".to_string(),
            other => format!("0x{:04x}", other),
        }
    }
}

fn elevation() -> &'static str {
    unsafe {
        let mut token: HANDLE = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return "取得不可";
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut size = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut size,
        ) != 0;
        CloseHandle(token);
        match (ok, elevation.TokenIsElevated != 0) {
            (false, _) => "取得不可",
            (true, true) => "あり",
            (true, false) => "なし",
        }
    }
}

fn describe_file(path: &Path) -> String {
    match std::fs::metadata(path) {
        Ok(meta) => format!(
            "あり {} bytes {}",
            meta.len(),
            file_version(path).map_or("バージョン情報なし".to_string(), |v| format!("バージョン {}", v))
        ),
        Err(_) => "なし".to_string(),
    }
}

fn file_version(path: &Path) -> Option<String> {
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        let mut handle = 0u32;
        let size = GetFileVersionInfoSizeW(wide.as_ptr(), &mut handle);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        if GetFileVersionInfoW(wide.as_ptr(), 0, size, data.as_mut_ptr().cast()) == 0 {
            return None;
        }
        let root = to_wide("\\");
        let mut info: *mut c_void = null_mut();
        let mut len = 0u32;
        if VerQueryValueW(data.as_ptr().cast(), root.as_ptr(), &mut info, &mut len) == 0
            || info.is_null()
        {
            return None;
        }
        let info = info.cast::<VS_FIXEDFILEINFO>().read_unaligned();
        Some(format!(
            "{}.{}.{}.{}",
            info.dwFileVersionMS >> 16,
            info.dwFileVersionMS & 0xffff,
            info.dwFileVersionLS >> 16,
            info.dwFileVersionLS & 0xffff
        ))
    }
}

fn reg_string(key: &str, value: &str) -> Option<String> {
    let key = to_wide(key);
    let value = to_wide(value);
    let mut size = 0u32;
    unsafe {
        if RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            null_mut(),
            null_mut(),
            &mut size,
        ) != NO_ERROR
        {
            return None;
        }
        let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
        if RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        ) != NO_ERROR
        {
            return None;
        }
        let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..len]))
    }
}

fn reg_dword(key: &str, value: &str) -> Option<u32> {
    let key = to_wide(key);
    let value = to_wide(value);
    let mut data = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let result = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            null_mut(),
            (&mut data as *mut u32).cast(),
            &mut size,
        )
    };
    (result == NO_ERROR).then_some(data)
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
