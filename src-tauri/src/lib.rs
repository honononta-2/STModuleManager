mod commands;
mod modules_db;
mod packets;
mod settings;

use commands::MonitorState;
use packets::protobuf::{decode_protobuf_raw, extract_dirty_changes, extract_modules, DirtyModuleChange};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

/// バックグラウンドモードが有効（ウィンドウ破棄済み）かどうか
pub struct BackgroundActive(pub AtomicBool);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            restore_window(app);
        }))
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

            // バックグラウンドモード管理
            app.manage(BackgroundActive(AtomicBool::new(false)));

            // システムトレイアイコン
            let show_i = MenuItem::with_id(app, "show", "表示", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("STModuleManager")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => restore_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        restore_window(tray.app_handle());
                    }
                })
                .build(app)?;

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
            // 同一イベントの複数パケットをまとめて処理してからUIに1回だけ通知する
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    // ブロッキングで最初の1件を待つ
                    let first = match module_rx.recv() {
                        Ok(msg) => msg,
                        Err(_) => break, // チャネル切断
                    };

                    // チャネルに溜まっている残りのパケットも一括取得
                    let mut batch = vec![first];
                    while let Ok(msg) = module_rx.try_recv() {
                        batch.push(msg);
                    }

                    let db = app_handle.state::<modules_db::ModulesDbState>();
                    let mut changed = false;
                    let mut new_count = 0i32;

                    for msg in &batch {
                        let decoded = decode_protobuf_raw(&msg.payload);

                        match msg.opcode {
                            0x15 => {
                                // 全量同期
                                let modules = extract_modules(&decoded);
                                if modules.is_empty() {
                                    continue;
                                }
                                match db.merge_modules(&modules) {
                                    Ok((nc, c)) => {
                                        eprintln!(
                                            "[monitor] モジュール全量同期: {}件 (新規: {}件, 変化: {})",
                                            modules.len(), nc, c
                                        );
                                        if c {
                                            new_count = nc as i32;
                                            changed = true;
                                        }
                                    }
                                    Err(e) => eprintln!("[monitor] DB保存エラー: {}", e),
                                }
                            }
                            0x16 => {
                                // 差分更新
                                let changes = extract_dirty_changes(&decoded);
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
                                                Err(e) => {
                                                    eprintln!("[monitor] DB保存エラー: {}", e)
                                                }
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
                                                eprintln!(
                                                    "[monitor] ステータス更新エラー: {}", e
                                                );
                                            } else {
                                                changed = true;
                                            }
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                    }

                    if changed {
                        let _ = app_handle.emit("modules-updated", new_count);
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
            commands::get_system_locale,
            commands::clear_app_data,
            commands::enter_background_mode,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let bg = app.state::<BackgroundActive>();
                if bg.0.load(Ordering::Relaxed) {
                    api.prevent_exit();
                }
            }
        });
}

/// ウィンドウを復元（存在しなければ新規作成）
fn restore_window(app: &tauri::AppHandle) {
    let bg = app.state::<BackgroundActive>();
    bg.0.store(false, Ordering::Relaxed);

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    } else {
        let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
            .title("STModuleManager")
            .inner_size(1100.0, 720.0)
            .resizable(false)
            .decorations(false)
            .build();
    }
}
