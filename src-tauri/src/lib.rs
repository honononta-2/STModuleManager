mod commands;
mod modules_db;
mod packets;

use commands::MonitorState;
use packets::protobuf::{decode_protobuf_raw, extract_modules};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // アプリデータディレクトリにDB用パスを設定
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&app_data_dir).ok();

            let db_path = app_data_dir.join("modules_db.json");
            let db_state = modules_db::ModulesDbState::new(db_path);
            app.manage(db_state);

            let patterns_path = app_data_dir.join("opt_patterns.json");
            app.manage(commands::OptPatternsPath(patterns_path));

            // 監視ステート（キャプチャはトグルで手動開始）
            let server_found = Arc::new(AtomicBool::new(false));
            let (module_tx, module_rx) = std::sync::mpsc::channel();
            app.manage(MonitorState {
                server_found: server_found.clone(),
                capture_stop: std::sync::Mutex::new(None),
                module_tx: std::sync::Mutex::new(module_tx),
            });

            // モジュール処理スレッド: チャネルから受信→DB保存→フロントに通知
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                for msg in module_rx {
                    let decoded = decode_protobuf_raw(&msg.payload);
                    let modules = extract_modules(&decoded);
                    if modules.is_empty() {
                        continue;
                    }

                    let db = app_handle.state::<modules_db::ModulesDbState>();
                    match db.merge_modules(&modules) {
                        Ok(new_count) => {
                            eprintln!(
                                "[monitor] モジュール取得: {}件 (新規: {}件)",
                                modules.len(),
                                new_count
                            );
                            // フロントエンドに通知
                            let _ = app_handle.emit("modules-updated", new_count);
                        }
                        Err(e) => {
                            eprintln!("[monitor] DB保存エラー: {}", e);
                        }
                    }
                }
            });

            // サーバー検出通知スレッド
            let app_handle2 = app.handle().clone();
            let sf2 = server_found.clone();
            std::thread::spawn(move || {
                let mut was_found = false;
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let found = sf2.load(Ordering::Relaxed);
                    if found && !was_found {
                        let _ = app_handle2.emit("server-found", true);
                    }
                    was_found = found;
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_modules,
            commands::get_monitor_status,
            commands::optimize_modules,
            commands::export_to_file,
            commands::start_capture_cmd,
            commands::stop_capture_cmd,
            commands::get_opt_patterns,
            commands::save_opt_patterns,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
