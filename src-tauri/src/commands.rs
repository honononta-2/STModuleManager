use crate::modules_db::{ModuleEntry, ModulesDbState};
use serde::Serialize;
use star_optimizer::{ModuleInput, OptimizeRequest, OptimizeResponse};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

/// 監視状態を管理するステート
pub struct MonitorState {
    pub server_found: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MonitorStatus {
    pub server_found: bool,
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
    MonitorStatus {
        server_found: monitor.server_found.load(Ordering::Relaxed),
    }
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
