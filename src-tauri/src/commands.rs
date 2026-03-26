use crate::modules_db::{ModuleEntry, ModulesDbState};
use crate::packets::capture::{run_capture, ModulePayload};
use serde::{Deserialize, Serialize};
use star_optimizer::{ModuleInput, OptimizeRequest, OptimizeResponse};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::sync::Mutex;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

pub struct OptPatternsPath(pub PathBuf);

/// 監視状態を管理するステート
pub struct MonitorState {
    pub server_found: Arc<AtomicBool>,
    pub capture_stop: Mutex<Option<Arc<AtomicBool>>>,
    pub module_tx: Mutex<Sender<ModulePayload>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MonitorStatus {
    pub server_found: bool,
    pub capturing: bool,
}

/// 保存済みモジュール一覧を返す
#[tauri::command]
pub fn get_modules(db: State<ModulesDbState>) -> Result<Vec<ModuleEntry>, String> {
    let db = db.db.lock().map_err(|e| e.to_string())?;
    let mut modules: Vec<ModuleEntry> = db.modules.values().cloned().collect();
    modules.sort_by(|a, b| b.acquired_date.cmp(&a.acquired_date));
    Ok(modules)
}

/// 監視状態を返す
#[tauri::command]
pub fn get_monitor_status(monitor: State<MonitorState>) -> MonitorStatus {
    let capturing = monitor
        .capture_stop
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false);
    MonitorStatus {
        server_found: monitor.server_found.load(Ordering::Relaxed),
        capturing,
    }
}

/// キャプチャを開始する
#[tauri::command]
pub fn start_capture_cmd(monitor: State<MonitorState>) -> Result<(), String> {
    let mut stop_guard = monitor.capture_stop.lock().map_err(|e| e.to_string())?;
    if stop_guard.is_some() {
        return Ok(()); // already running
    }
    let flag = Arc::new(AtomicBool::new(false));
    let sf = monitor.server_found.clone();
    let tx = monitor
        .module_tx
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let f = flag.clone();
    std::thread::spawn(move || {
        run_capture(f, sf, tx);
    });
    *stop_guard = Some(flag);
    Ok(())
}

/// キャプチャを停止する
#[tauri::command]
pub fn stop_capture_cmd(monitor: State<MonitorState>) -> Result<(), String> {
    let mut stop_guard = monitor.capture_stop.lock().map_err(|e| e.to_string())?;
    if let Some(flag) = stop_guard.take() {
        flag.store(true, Ordering::Relaxed);
        monitor.server_found.store(false, Ordering::Relaxed);
    }
    Ok(())
}

/// モジュール最適化を実行し上位10件を返す
#[tauri::command]
pub async fn optimize_modules(
    db: State<'_, ModulesDbState>,
    req: OptimizeRequest,
) -> Result<OptimizeResponse, String> {
    let modules = {
        let db = db.db.lock().map_err(|e| e.to_string())?;
        db.modules.values().cloned().collect::<Vec<ModuleEntry>>()
    };
    let inputs: Vec<ModuleInput> = modules
        .iter()
        .map(|m| ModuleInput {
            uuid: m.uuid,
            quality: m.quality,
            stats: m.stats.clone(),
        })
        .collect();
    Ok(tauri::async_runtime::spawn_blocking(move || star_optimizer::optimize(&inputs, &req))
        .await
        .map_err(|e| e.to_string())?)
}

/// 最適化パターン1件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OptPattern {
    pub name: String,
    pub required: Vec<String>,
    pub desired: Vec<String>,
    pub excluded: Vec<String>,
    pub quality: u32,
}

/// 保存済みの最適化パターン一覧を返す
#[tauri::command]
pub fn get_opt_patterns(path: State<OptPatternsPath>) -> Result<Vec<OptPattern>, String> {
    if !path.0.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(&path.0).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

/// 最適化パターン一覧を保存する
#[tauri::command]
pub fn save_opt_patterns(
    path: State<OptPatternsPath>,
    patterns: Vec<OptPattern>,
) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&patterns).map_err(|e| e.to_string())?;
    std::fs::write(&path.0, json).map_err(|e| e.to_string())?;
    Ok(())
}

/// ファイルにエクスポート（保存ダイアログ→書き込み）
#[tauri::command]
pub fn export_to_file(
    app: tauri::AppHandle,
    format: String,
    content: String,
) -> Result<bool, String> {
    let (filter_name, filter_ext, default_name): (&str, &[&str], &str) = match format.as_str() {
        "json" => ("JSON", &["json"], "modules.json"),
        "csv" => ("CSV", &["csv"], "modules.csv"),
        _ => return Err("unsupported format".into()),
    };

    let file_path = app
        .dialog()
        .file()
        .add_filter(filter_name, filter_ext)
        .set_file_name(default_name)
        .blocking_save_file();

    match file_path {
        Some(path) => {
            std::fs::write(path.as_path().ok_or("invalid file path")?, content.as_bytes())
                .map_err(|e| e.to_string())?;
            Ok(true)
        }
        None => Ok(false),
    }
}
