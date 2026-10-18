use std::path::PathBuf;

// Managed state holding where diagnostic logs should be written.
pub struct LogPath(pub PathBuf);

/// 进程启动时刻：用来量"从双击 exe 到窗口出现"到底花了多久。
/// 排查启动卡顿时，这个数比任何猜测都可靠。
pub static BOOT_T0: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// 距离进程启动过了多少毫秒（未初始化时返回 0）
pub fn since_boot_ms() -> u128 {
    BOOT_T0
        .get()
        .map(|t| t.elapsed().as_millis())
        .unwrap_or(0)
}

// Append one line to diag.log in the app data dir. Never fails the caller.
pub fn append(path: &std::path::Path, line: &str) {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

// Frontend calls this to report any caught error so we can read it from disk.
#[tauri::command]
pub fn diag_log(log: tauri::State<LogPath>, message: String) -> Result<(), String> {
    append(&log.0, &format!("[{} ] {message}", now()));
    Ok(())
}

// A Rust-side sanity check that the DB write/read path itself is healthy.
// (Does NOT exercise the JS→Rust boundary — the frontend self-test does that.)
#[tauri::command]
pub fn diag_db(log: tauri::State<LogPath>) -> Result<String, String> {
    let mut out = String::new();
    let conn = match rusqlite::Connection::open_in_memory() {
        Ok(c) => c,
        Err(e) => return Err(format!("in-memory open failed: {e}")),
    };
    if let Err(e) = crate::db::init_db(&conn) {
        return Err(format!("init_db failed: {e}"));
    }
    let r = conn.execute(
        "INSERT INTO projects(name,color,icon,sort_order) VALUES(?1,?2,?3,?4)",
        rusqlite::params!["diag", "#409EFF", "X", 1000.0f64],
    );
    match r {
        Ok(n) => {
            out.push_str(&format!("db insert OK rows={n}"));
            append(&log.0, &format!("[{}] DIAG_DB OK rows={n}", now()));
        }
        Err(e) => {
            out.push_str(&format!("db insert FAILED: {e}"));
            append(&log.0, &format!("[{}] DIAG_DB FAILED: {e}", now()));
            return Err(e.to_string());
        }
    }
    Ok(out)
}

fn now() -> String {
    // local time HH:MM:SS without extra deps
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let secs_of_day = t % 86400;
    format!(
        "{:02}:{:02}:{:02}",
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60
    )
}
