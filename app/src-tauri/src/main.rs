#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod diag;

use db::Db;
use tauri::{LogicalSize, Manager};

/// 窗口尺寸的兜底上下限（逻辑像素，跟 DPI 缩放无关）
const DEF_W: f64 = 1440.0;
const DEF_H: f64 = 900.0;
const MIN_W: f64 = 860.0;
const MIN_H: f64 = 540.0;

/// 解析「数据到底放在哪个文件夹」。
///
/// 默认是系统的应用数据目录；用户可以在「数据存储」里换到 D 盘 / U 盘 / 网盘，
/// 换过之后本文件里的指针文件会记住新位置。
/// 如果记住的位置打不开了（U 盘拔了、文件夹被挪走），先退回默认目录保证能启动，
/// 并留一张字条，界面上会提示用户。
fn resolve_data_root(default_root: &std::path::Path) -> std::path::PathBuf {
    let pointer = default_root.join(commands::POINTER_FILE);
    let want = std::fs::read_to_string(&pointer)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let Some(want) = want else {
        return default_root.to_path_buf();
    };
    let p = commands::normalize_dir(&want);
    if p.is_dir() {
        return p;
    }
    let _ = std::fs::create_dir_all(default_root);
    let _ = std::fs::write(default_root.join(commands::POINTER_MISSING), &want);
    default_root.to_path_buf()
}

/// 数据库文件：新版叫「看板数据.db」。老版本叫 kanban.db，
/// 首次启动时先 checkpoint 把 WAL 落盘，再改名，避免丢最近的改动。
fn resolve_db_file(root: &std::path::Path) -> std::path::PathBuf {
    let new_db = root.join(commands::DB_NAME);
    if new_db.exists() {
        return new_db;
    }
    let old = root.join(commands::LEGACY_DB_NAME);
    if !old.exists() {
        return new_db;
    }
    if let Ok(c) = rusqlite::Connection::open(&old) {
        let _ = c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        drop(c);
    }
    if std::fs::rename(&old, &new_db).is_ok() {
        let _ = std::fs::remove_file(root.join(format!("{}-wal", commands::LEGACY_DB_NAME)));
        let _ = std::fs::remove_file(root.join(format!("{}-shm", commands::LEGACY_DB_NAME)));
        new_db
    } else {
        old
    }
}

fn main() {
    let _ = diag::BOOT_T0.set(std::time::Instant::now());
    tauri::Builder::default()
        .setup(|app| {
            let default_root = app.path().app_data_dir().expect("无法获取数据目录");
            std::fs::create_dir_all(&default_root).expect("无法创建数据目录");
            let root = resolve_data_root(&default_root);
            if std::fs::create_dir_all(&root).is_err() {
                // 记住的位置建不出来 → 退回默认目录，别让程序起不来
                let _ = std::fs::create_dir_all(&default_root);
                let _ = std::fs::write(default_root.join(commands::POINTER_MISSING), root.to_string_lossy().as_bytes());
                return Err(Box::<dyn std::error::Error>::from("数据文件夹不可用"));
            }
            let _ = resolve_db_file(&root); // 更老的 kanban.db 先统一成 看板数据.db
            // 老结构（一个库装所有项目）→ 新结构（每个项目一个文件夹一份库）
            if let Err(e) = commands::split_legacy_db(&root) {
                eprintln!("拆分旧数据失败：{e}");
            }

            // 全局库：只装项目清单和偏好设置
            let global_path = root.join(commands::GLOBAL_DB_NAME);
            let gconn =
                rusqlite::Connection::open(&global_path).expect("无法打开项目列表库");
            db::init_db(&gconn).expect("项目列表库初始化失败");

            // 上次开的哪个项目，就打开它的库
            let cur: Option<i64> = commands::get_setting(&gconn, "current_project_id")
                .ok()
                .flatten()
                .and_then(|v| v.parse().ok());
            let cur_row: Option<(i64, String, String)> = cur.and_then(|id| {
                gconn
                    .query_row(
                        "SELECT id, name, COALESCE(folder,'') FROM projects WHERE id=?1",
                        [id],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .ok()
            });
            // 打开上次那个项目的库；还没有项目 / 文件夹被挪走 → 用内存库兜底，界面照样能开
            let pconn = cur_row
                .filter(|(_, _, f)| !f.trim().is_empty())
                .and_then(|(id, name, folder)| {
                    commands::open_project_db_at(&root, id, &name, &folder).ok()
                })
                .unwrap_or_else(|| {
                    let c = rusqlite::Connection::open_in_memory().expect("内存库");
                    let _ = db::init_db(&c);
                    c
                });
            app.manage(Db(std::sync::Mutex::new(pconn)));
            app.manage(commands::GlobalDb(std::sync::Mutex::new(gconn)));
            app.manage(diag::LogPath(root.join("diag.log")));
            app.manage(commands::DataDir(std::sync::Mutex::new(root.clone())));

            // 老版本的附件是全项目混在 assets/ 里、按 id 命名的，
            // 启动时顺手搬回各自的「项目名/附件/」，让人打开文件夹能看明白；
            // 再把库里存的绝对路径统一成相对路径（整个文件夹才能随便拷/挪）。
            {
                let db = app.state::<Db>();
                let d = app.state::<commands::DataDir>();
                if let Ok(c) = db.0.lock() {
                    commands::organize_legacy_assets(&c, &d);
                    commands::normalize_asset_paths(&c, &d);
                };
            }

            // 自检用：KANBAN_DEBUG_FLOAT=1 时启动就开一个浮动网页，把结果写进 diag.log。
            // 平时不设这个变量，什么都不做（留着是为了以后排查"网页打不开"类问题）。
            if std::env::var("KANBAN_DEBUG_FLOAT").ok().as_deref() == Some("1") {
                let handle = app.handle().clone();
                let logp = app.state::<diag::LogPath>().0.clone();
                tauri::async_runtime::spawn(async move {
                    let r = commands::float_web_open(
                        handle,
                        "https://cn.bing.com/".into(),
                        40.0,
                        120.0,
                        520.0,
                        360.0,
                    )
                    .await;
                    diag::append(&logp, &format!("FLOATWEB selftest -> {:?}", r));
                });
            }

            // ---- 窗口尺寸自适应 ----
            // 之前尺寸写死在 tauri.conf.json（1440×900 / 最小 1024×640）：
            // 小屏（1366×768）或 Windows 贴靠半屏时窗口比屏幕还大，
            // 右边和下边直接跑到屏幕外，用户看到的就是"界面显示不全"。
            // 这里按**当前显示器的逻辑尺寸**夹一遍，并居中显示。
            if let Some(win) = app.get_webview_window("main") {
                // 标题栏 / 任务栏图标：**显式设一次**。
                // 光靠 exe 资源里的图标，Windows 有时会沿用旧缓存（同一个 exe 路径改了图标，
                // 资源管理器还显示老的）。运行时 set_icon 一次，窗口一出现就是新图标。
                // from_app_icon_resource 直接取打包进二进制的应用图标，不依赖文件路径。
                if let Ok(img) = tauri::image::Image::from_app_icon_resource(128) {
                    let _ = win.set_icon(img);
                }

                let monitor = win
                    .current_monitor()
                    .ok()
                    .flatten()
                    .or_else(|| win.primary_monitor().ok().flatten());

                // 屏幕能给出的上限：留一点边距，避开任务栏和窗口边框
                let (mut max_w, mut max_h) = (DEF_W, DEF_H);
                if let Some(m) = monitor {
                    let sf = m.scale_factor();
                    let lw = m.size().width as f64 / sf;
                    let lh = m.size().height as f64 / sf;
                    max_w = (lw * 0.94).floor();
                    max_h = (lh * 0.90).floor();
                }

                // 有记住的尺寸就用（用户上次调过的），否则用默认值
                let saved = {
                    let db = app.state::<Db>();
                    db.0.lock()
                        .ok()
                        .and_then(|c| commands::get_setting(&c, "window_size").ok().flatten())
                };
                let (mut w, mut h) = (DEF_W, DEF_H);
                let mut saved_pair: Option<(f64, f64)> = None;
                if let Some(s) = saved {
                    if let Some((sw, sh)) = s.split_once(',') {
                        if let (Ok(sw), Ok(sh)) =
                            (sw.trim().parse::<f64>(), sh.trim().parse::<f64>())
                        {
                            if sw.is_finite() && sh.is_finite() && sw > 400.0 && sh > 300.0 {
                                w = sw;
                                h = sh;
                                saved_pair = Some((sw, sh));
                            }
                        }
                    }
                }

                // 上次是"最大化"状态（保存的尺寸已经顶到屏幕上限）→ 这次直接最大化。
                // 否则用户每次开都要手动最大化一次，很烦。
                let want_max = matches!(
                    saved_pair,
                    Some((sw, sh)) if sw >= max_w + 24.0 || sh >= max_h + 24.0
                );

                if want_max {
                    let _ = win.maximize();
                } else {
                    // 夹进屏幕；即使屏幕特别小也不低于 MIN 与屏幕上限里的较小者
                    w = w.min(max_w).max(MIN_W.min(max_w));
                    h = h.min(max_h).max(MIN_H.min(max_h));
                    let _ = win.set_size(LogicalSize::new(w, h));
                    let _ = win.center();
                }
            }

            Ok(())
        })
        // 关窗时把当前尺寸记下来，下次按上次的大小开（仍会被屏幕上限夹住）
        .on_window_event(|win, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let Ok(sz) = win.inner_size() else { return };
                let sf = win.scale_factor().unwrap_or(1.0);
                let lw = (sz.width as f64 / sf).round();
                let lh = (sz.height as f64 / sf).round();
                if lw < 400.0 || lh < 300.0 {
                    return; // 最小化/异常状态不记
                }
                let app = win.app_handle().clone();
                if let Some(db) = app.try_state::<Db>() {
                    if let Ok(conn) = db.0.lock() {
                        let _ = commands::set_setting(
                            &conn,
                            "window_size",
                            &format!("{},{}", lw as i64, lh as i64),
                        );
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_projects, commands::create_project, commands::update_project,
            commands::delete_project, commands::reorder_projects,
            commands::list_columns, commands::create_column, commands::update_column,
            commands::delete_column, commands::reorder_columns,
            commands::list_tasks, commands::create_task, commands::update_task,
            commands::move_task, commands::delete_task, commands::restore_task,
            commands::purge_task,
            commands::list_trash, commands::empty_trash,
            commands::list_tags, commands::create_tag, commands::delete_tag,
            commands::get_settings, commands::set_setting_kv, commands::bootstrap,
            commands::set_task_pos,
            commands::list_notes, commands::create_note, commands::update_note,
            commands::delete_note,
            commands::list_edges, commands::create_edge, commands::delete_edge,
            commands::update_edge,
            commands::list_task_refs, commands::set_task_ref, commands::delete_task_ref,
            commands::import_asset, commands::list_assets, commands::delete_asset,
            commands::open_asset, commands::reveal_asset, commands::read_asset_data_url,
            commands::find_asset_by_hash,
            commands::list_docs, commands::create_doc, commands::update_doc, commands::delete_doc,
            commands::get_data_dir, commands::open_data_dir,
            commands::show_main_window, commands::perf_probe,
            commands::float_web_open, commands::float_web_bounds,
            commands::float_web_navigate, commands::float_web_visible,
            commands::float_web_close, commands::float_web_set_zoom,
            commands::data_overview, commands::pick_folder, commands::change_data_dir,
            commands::open_project_dir, commands::open_project_db,
            diag::diag_log, diag::diag_db,
        ])
        .run(tauri::generate_context!())
        .expect("应用启动失败");
}
