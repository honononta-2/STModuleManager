use super::netstat;
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr::null;
use std::sync::OnceLock;
use windows_sys::Win32::Foundation::{GetLastError, ERROR_SERVICE_DOES_NOT_EXIST};
use windows_sys::Win32::Storage::FileSystem::DELETE;
use windows_sys::Win32::System::LibraryLoader::LoadLibraryW;
use windows_sys::Win32::System::Services::{
    CloseServiceHandle, DeleteService, OpenSCManagerW, OpenServiceW, QueryServiceConfigW,
    QueryServiceStatus, QUERY_SERVICE_CONFIGW, SC_HANDLE, SC_MANAGER_CONNECT,
    SERVICE_QUERY_CONFIG, SERVICE_QUERY_STATUS, SERVICE_STATUS, SERVICE_STOPPED,
};

const SERVICE_NAME: &str = "WinDivert";
const DLL_NAME: &str = "WinDivert.dll";
const DRIVER_FILES: [&str; 2] = [DLL_NAME, "WinDivert64.sys"];
/// QueryServiceConfigW のバッファの上限
const SERVICE_CONFIG_BUFFER_BYTES: usize = 8 * 1024;

static LOADED_DLL: OnceLock<Option<PathBuf>> = OnceLock::new();

/// アプリデータ配下に WinDivert を配置し、WinDivert.dll を読み込む
pub fn prepare(app_data_dir: &Path) {
    let loaded = load_dll(app_data_dir);
    match &loaded {
        Some(dll) => crate::diag!("[driver] WinDivert.dll を読み込み: {}", dll.display()),
        None => crate::diag!("[driver] WinDivert.dll を読み込めませんでした"),
    }
    let _ = LOADED_DLL.set(loaded);
}

pub fn is_ready() -> bool {
    matches!(LOADED_DLL.get(), Some(Some(_)))
}

fn load_dll(app_data_dir: &Path) -> Option<PathBuf> {
    let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    else {
        crate::diag!("[driver] 実行フォルダを取得できません");
        return None;
    };

    let install_dir = app_data_dir.join("WinDivert");
    match install(&exe_dir, &install_dir) {
        Ok(()) => {
            let dll = install_dir.join(DLL_NAME);
            match load_library(&dll) {
                Ok(()) => return Some(dll),
                Err(code) => crate::diag!(
                    "[driver] {} の読み込みに失敗: コード {}",
                    dll.display(),
                    code
                ),
            }
        }
        Err(e) => crate::diag!(
            "[driver] {} への WinDivert の配置に失敗: {}",
            install_dir.display(),
            e
        ),
    }

    let dll = exe_dir.join(DLL_NAME);
    match load_library(&dll) {
        Ok(()) => Some(dll),
        Err(code) => {
            crate::diag!("[driver] {} の読み込みに失敗: コード {}", dll.display(), code);
            None
        }
    }
}

fn install(src_dir: &Path, dst_dir: &Path) -> std::io::Result<()> {
    if DRIVER_FILES.iter().all(|name| dst_dir.join(name).is_file()) {
        return Ok(());
    }
    std::fs::create_dir_all(dst_dir)?;
    for name in DRIVER_FILES {
        std::fs::copy(src_dir.join(name), dst_dir.join(name))?;
    }
    crate::diag!("[driver] WinDivert を配置: {}", dst_dir.display());
    Ok(())
}

fn load_library(path: &Path) -> Result<(), u32> {
    let wide = to_wide(path);
    unsafe {
        if LoadLibraryW(wide.as_ptr()).is_null() {
            Err(GetLastError())
        } else {
            Ok(())
        }
    }
}

/// 停止中の WinDivert サービスの登録先にドライバーファイルが存在しなければ、その登録を削除する
pub fn remove_stale_service() {
    unsafe {
        let manager = OpenSCManagerW(null(), null(), SC_MANAGER_CONNECT);
        if manager.is_null() {
            crate::diag!("[driver] サービスマネージャーを開けません: コード {}", GetLastError());
            return;
        }
        let name = to_wide(SERVICE_NAME);
        let service = OpenServiceW(
            manager,
            name.as_ptr(),
            SERVICE_QUERY_STATUS | SERVICE_QUERY_CONFIG | DELETE,
        );
        if service.is_null() {
            let code = GetLastError();
            if code != ERROR_SERVICE_DOES_NOT_EXIST {
                crate::diag!("[driver] WinDivert サービスを開けません: コード {}", code);
            }
        } else {
            remove_if_stale(service);
            CloseServiceHandle(service);
        }
        CloseServiceHandle(manager);
    }
}

unsafe fn remove_if_stale(service: SC_HANDLE) {
    let mut status = SERVICE_STATUS::default();
    if QueryServiceStatus(service, &mut status) == 0 {
        crate::diag!("[driver] WinDivert サービスの状態を取得できません: コード {}", GetLastError());
        return;
    }
    if status.dwCurrentState != SERVICE_STOPPED {
        return;
    }

    let mut buffer = vec![0u64; SERVICE_CONFIG_BUFFER_BYTES / 8];
    let mut needed = 0u32;
    if QueryServiceConfigW(
        service,
        buffer.as_mut_ptr().cast(),
        SERVICE_CONFIG_BUFFER_BYTES as u32,
        &mut needed,
    ) == 0
    {
        crate::diag!("[driver] WinDivert サービスの設定を取得できません: コード {}", GetLastError());
        return;
    }
    let raw = netstat::from_wide((*buffer.as_ptr().cast::<QUERY_SERVICE_CONFIGW>()).lpBinaryPathName);

    let Some(path) = resolve_image_path(&raw) else {
        crate::diag!("[driver] 登録先を解釈できないため WinDivert サービスを削除しません: {}", raw);
        return;
    };
    match std::fs::metadata(&path) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if DeleteService(service) != 0 {
                crate::diag!("[driver] 登録先にファイルがない WinDivert サービスを削除: {}", raw);
            } else {
                crate::diag!(
                    "[driver] WinDivert サービスの削除に失敗: コード {} 登録先: {}",
                    GetLastError(),
                    raw
                );
            }
        }
        Err(e) => crate::diag!(
            "[driver] 登録先を確認できないため WinDivert サービスを削除しません: {} ({})",
            raw,
            e
        ),
    }
}

/// サービスの登録先を絶対パスに変換する
fn resolve_image_path(raw: &str) -> Option<PathBuf> {
    const SYSTEM_ROOT_PREFIX: &str = r"\SystemRoot\";
    const SYSTEM32_PREFIX: &str = r"System32\";
    let path = if let Some(rest) = raw.strip_prefix(r"\??\") {
        PathBuf::from(rest)
    } else if starts_with_ignore_case(raw, SYSTEM_ROOT_PREFIX) {
        Path::new(&std::env::var_os("SystemRoot")?).join(&raw[SYSTEM_ROOT_PREFIX.len()..])
    } else if starts_with_ignore_case(raw, SYSTEM32_PREFIX) {
        Path::new(&std::env::var_os("SystemRoot")?).join(raw)
    } else {
        PathBuf::from(raw)
    };
    path.is_absolute().then_some(path)
}

fn starts_with_ignore_case(s: &str, prefix: &str) -> bool {
    s.get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

fn to_wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(Some(0)).collect()
}
