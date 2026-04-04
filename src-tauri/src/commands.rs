use crate::modules_db::{ModuleEntry, ModulesDbState};
use crate::packets::capture::{run_capture, ModulePayload};
use crate::settings::{AppSettings, AppSettingsState};
use crate::BackgroundActive;
use serde::{Deserialize, Serialize};
use star_optimizer::{ModuleInput, OptimizeRequest, OptimizeResponse};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::sync::Mutex;
use tauri::{Manager, State};
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
/// required/desired/excluded は part_id の数値リスト（旧フォーマットの文字列もそのまま保持してマイグレーションはTS側で行う）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OptPattern {
    pub name: String,
    pub required: Vec<serde_json::Value>,
    pub desired: Vec<serde_json::Value>,
    pub excluded: Vec<serde_json::Value>,
    pub quality: u32,
    #[serde(default)]
    pub min_required: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    pub min_desired: Option<Vec<serde_json::Value>>,
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

/// カスタム言語ファイル (custom_lang.json) を取得する
#[tauri::command]
pub fn get_custom_language(app: tauri::AppHandle) -> Result<String, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("custom_lang.json");
    if !path.exists() {
        return Err("not_found".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// カスタム言語ファイル (custom_lang.json) を保存する
#[tauri::command]
pub fn save_custom_language(app: tauri::AppHandle, content: String) -> Result<(), String> {
    // JSON構文検証（任意文字列の無検証書込みを防止）
    serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|e| format!("Invalid JSON: {}", e))?;
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("custom_lang.json");
    std::fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())
}

/// アプリ設定を取得
#[tauri::command]
pub fn get_settings(state: State<AppSettingsState>) -> Result<AppSettings, String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

/// OSのシステムロケールを返す
#[tauri::command]
pub fn get_system_locale() -> String {
    sys_locale::get_locale().unwrap_or_else(|| "ja".to_string())
}

/// AppDataのデータファイルをすべて削除してアプリを終了する
#[tauri::command]
pub fn clear_app_data(app: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    for file in &["modules_db.json", "opt_patterns.json", "settings.json", "custom_lang.json"] {
        let path = app_data_dir.join(file);
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }

    app.exit(0);
    Ok(())
}

/// バックグラウンドモードに移行（ウィンドウを破棄してトレイ常駐）
#[tauri::command]
pub fn enter_background_mode(app: tauri::AppHandle, bg: State<BackgroundActive>) -> Result<(), String> {
    bg.0.store(true, Ordering::Relaxed);
    if let Some(window) = app.get_webview_window("main") {
        window.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// アプリ設定を更新して保存
#[tauri::command]
pub fn update_settings(
    state: State<AppSettingsState>,
    settings: AppSettings,
) -> Result<(), String> {
    {
        let mut current = state.settings.lock().map_err(|e| e.to_string())?;
        *current = settings;
    }
    state.save()
}
