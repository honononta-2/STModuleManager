mod commands;
mod modules_db;
mod packets;
mod settings;

use commands::MonitorState;
use packets::protobuf::{decode_protobuf_raw, extract_dirty_changes, extract_modules, DirtyModuleChange};
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

            let settings_path = app_data_dir.join("settings.json");
            let settings_state = settings::AppSettingsState::new(settings_path);
            let auto_monitor = settings_state
                .settings
                .lock()
                .map(|s| s.auto_monitor)
                .unwrap_or(false);
            app.manage(settings_state);

            // 監視ステート（キャプチャはトグルで手動開始）
            let server_found = Arc::new(AtomicBool::new(false));
            let (module_tx, module_rx) = std::sync::mpsc::channel();
            app.manage(MonitorState {
                server_found: server_found.clone(),
                capture_stop: std::sync::Mutex::new(None),
                module_tx: std::sync::Mutex::new(module_tx),
            });

            // 起動時に自動監視が有効なら即キャプチャ開始
            if auto_monitor {
                let monitor = app.state::<MonitorState>();
                let flag = Arc::new(AtomicBool::new(false));
                let sf = monitor.server_found.clone();
                let tx = monitor.module_tx.lock().unwrap().clone();
                let f = flag.clone();
                std::thread::spawn(move || {
                    packets::capture::run_capture(f, sf, tx);
                });
                *monitor.capture_stop.lock().unwrap() = Some(flag);
            }

            // モジュール処理スレッド: チャネルから受信→DB保存→フロントに通知
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                for msg in module_rx {
                    let decoded = decode_protobuf_raw(&msg.payload);
                    let db = app_handle.state::<modules_db::ModulesDbState>();

                    match msg.opcode {
                        0x15 => {
                            // 全量同期（既存処理）
                            let modules = extract_modules(&decoded);
                            if modules.is_empty() {
                                continue;
                            }
                            match db.merge_modules(&modules) {
                                Ok(new_count) => {
                                    eprintln!(
                                        "[monitor] モジュール全量同期: {}件 (新規: {}件)",
                                        modules.len(),
                                        new_count
                                    );
                                    let _ = app_handle.emit("modules-updated", new_count);
                                }
                                Err(e) => eprintln!("[monitor] DB保存エラー: {}", e),
                            }
                        }
                        0x16 => {
                            // 差分更新
                            let changes = extract_dirty_changes(&decoded);
                            if changes.is_empty() {
                                continue;
                            }
                            let mut changed = false;
                            for change in &changes {
                                match change {
                                    DirtyModuleChange::Added {
                                        uuid,
                                        config_id,
                                        quality,
                                    } => match db.add_module(*uuid, *config_id, *quality) {
                                        Ok(is_new) => {
                                            let label = if is_new { "新規" } else { "更新" };
                                            eprintln!(
                                                "[monitor] モジュール{}: uuid={}, config_id={}",
                                                label, uuid, config_id
                                            );
                                            changed = true;
                                        }
                                        Err(e) => eprintln!("[monitor] DB保存エラー: {}", e),
                                    },
                                    DirtyModuleChange::Removed { uuid } => {
                                        match db.remove_module(*uuid) {
                                            Ok(true) => {
                                                eprintln!(
                                                    "[monitor] モジュール削除: uuid={}",
                                                    uuid
                                                );
                                                changed = true;
                                            }
                                            Ok(false) => {}
                                            Err(e) => eprintln!("[monitor] DB保存エラー: {}", e),
                                        }
                                    }
                                    DirtyModuleChange::StatsUpdated {
                                        uuid,
                                        stats,
                                        success_rate,
                                    } => {
                                        if let Err(e) =
                                            db.update_stats(*uuid, stats, *success_rate)
                                        {
                                            eprintln!("[monitor] ステータス更新エラー: {}", e);
                                        } else {
                                            changed = true;
                                        }
                                    }
                                }
                            }
                            if changed {
                                let _ = app_handle.emit("modules-updated", 0);
                            }
                        }
                        _ => {}
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
            commands::get_settings,
            commands::update_settings,
            commands::get_custom_language,
            commands::save_custom_language,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
