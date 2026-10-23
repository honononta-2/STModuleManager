use chrono::Local;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static LOG_FILE: OnceLock<Mutex<File>> = OnceLock::new();

pub fn log_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("logs")
}

pub fn init(app_data_dir: &Path) -> std::io::Result<()> {
    let dir = log_dir(app_data_dir);
    std::fs::create_dir_all(&dir)?;
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("debug.log"))?;
    let _ = LOG_FILE.set(Mutex::new(file));
    Ok(())
}

pub fn is_enabled() -> bool {
    LOG_FILE.get().is_some()
}

pub fn write(message: &str) {
    eprintln!("{}", message);
    if let Some(file) = LOG_FILE.get() {
        if let Ok(mut f) = file.lock() {
            let _ = writeln!(f, "{} {}", Local::now().format("%Y-%m-%d %H:%M:%S"), message);
        }
    }
}

/// 診断ログがオンのとき、メッセージを debug.log に書き込む
#[macro_export]
macro_rules! diag {
    ($($arg:tt)*) => {
        $crate::logger::write(&format!($($arg)*))
    };
}
