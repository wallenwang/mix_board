use crate::db::Db;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    webview::{NewWindowResponse, WebviewBuilder},
    AppHandle, LogicalPosition, LogicalSize, Manager, State, WebviewUrl,
};

fn map_err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn next_order(
    conn: &Connection,
    table: &str,
    col: &str,
    extra: Option<(&str, i64)>,
) -> Result<f64, String> {
    // MAX() over an empty set returns one row containing NULL, so read it as
    // Option<f64> (NULL -> None), not f64. MAX() always returns exactly one
    // row, so no .optional() needed.
    let max: Option<f64> = if let Some((fk, pid)) = extra {
        conn.query_row(
            &format!("SELECT MAX({col}) FROM {table} WHERE {fk} = ?1"),
            params![pid],
            |r| r.get(0),
        )
        .map_err(map_err)?
    } else {
        conn.query_row(&format!("SELECT MAX({col}) FROM {table}"), [], |r| r.get(0))
            .map_err(map_err)?
    };
    Ok(max.unwrap_or(0.0) + 1000.0)
}

pub(crate) fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
        .optional()
        .map_err(map_err)
}

pub(crate) fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings(key,value) VALUES(?1,?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(map_err)?;
    Ok(())
}

// ---------- 全局库 / 项目库 ----------
//
// 磁盘结构（打开文件夹就看得懂）：
//   <数据目录>/项目列表.db                ← 只有项目清单和偏好设置（很小）
//   <数据目录>/<项目名>/看板与白板.db      ← 这个项目的任务、白板节点/连线、文档索引
//   <数据目录>/<项目名>/附件/              ← 本项目上传的资料原件
//   <数据目录>/<项目名>/文档/              ← 写作正文（.md 真文件，别的软件也能直接打开）
//
// 每个项目一份库：拷走一个项目文件夹，就拷走了它全部内容（含写作正文）。
// ⚠️ 加锁顺序永远是 GlobalDb → Db → DataDir，反向会死锁。

pub const GLOBAL_DB_NAME: &str = "项目列表.db";
pub const PROJECT_DB_NAME: &str = "看板与白板.db";
pub const ATTACH_DIR: &str = "附件";
pub const DOC_DIR: &str = "文档";

pub struct GlobalDb(pub std::sync::Mutex<Connection>);

/// 打开（需要时新建）某个项目的文件夹与库。
///
/// ⚠️ 项目库里有一行 `projects` 镜像记录 —— 因为 columns/tasks/board_notes/wb_files
/// 的 `project_id` 都带外键指向 projects(id)，库里没有这一行的话**所有插入都会失败**。
/// 另外 `project_folder_name()` 也直接读它。
/// 给还没有编号的任务补上项目内序号（T1、T2…）。
///
/// 只处理 seq 为 0 的行，新号从已有的最大值往后接着排，所以反复打开库不会重号；
/// 删掉的任务号也不回收 —— 否则三个月前跟 AI 说的"任务 2"会指向另一个任务。
/// 顺序按看板列顺序、列内卡片顺序，跟眼睛看到的一致。
fn backfill_task_seq(c: &Connection) -> Result<(), String> {
    let max_seq: i64 = c
        .query_row("SELECT COALESCE(MAX(seq), 0) FROM tasks", [], |r| r.get(0))
        .map_err(map_err)?;
    let ids: Vec<i64> = {
        let mut stmt = c
            .prepare(
                "SELECT t.id FROM tasks t
                 LEFT JOIN columns c ON c.id = t.column_id
                 WHERE t.seq IS NULL OR t.seq <= 0
                 ORDER BY COALESCE(c.sort_order, 0) ASC,
                          COALESCE(t.sort_order, 0) ASC,
                          t.id ASC",
            )
            .map_err(map_err)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, i64>(0))
            .map_err(map_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(map_err)?
    };
    if ids.is_empty() {
        return Ok(());
    }
    let mut next = max_seq + 1;
    for id in ids {
        c.execute(
            "UPDATE tasks SET seq = ?1 WHERE id = ?2",
            params![next, id],
        )
        .map_err(map_err)?;
        next += 1;
    }
    Ok(())
}

pub fn open_project_db_at(
    root: &std::path::Path,
    id: i64,
    name: &str,
    folder: &str,
) -> Result<Connection, String> {
    let pdir = root.join(folder);
    std::fs::create_dir_all(pdir.join(ATTACH_DIR)).map_err(map_err)?;
    std::fs::create_dir_all(pdir.join(DOC_DIR)).map_err(map_err)?;
    let c = Connection::open(pdir.join(PROJECT_DB_NAME))
        .map_err(|e| format!("打不开项目库：{e}"))?;
    crate::db::init_db(&c).map_err(map_err)?;
    // ⚠️ 这里绝不能用 `INSERT OR REPLACE`：REPLACE = 先 DELETE 再 INSERT，
    // 而 columns/tasks/board_notes/wb_files/docs 的 project_id 都带
    // `ON DELETE CASCADE` —— 每开一次库就会把该项目的数据整份删光。
    // （切项目、启动都会走这里，用 REPLACE 等于天天清库。）
    let exists: bool = c
        .query_row("SELECT 1 FROM projects WHERE id=?1", params![id], |r| r.get::<_, i64>(0))
        .optional()
        .map_err(map_err)?
        .is_some();
    if exists {
        c.execute(
            "UPDATE projects SET name=?1, folder=?2 WHERE id=?3",
            params![name, folder, id],
        )
        .map_err(map_err)?;
    } else {
        c.execute(
            "INSERT INTO projects(id,name,color,icon,sort_order,folder)
             VALUES(?1,?2,'#409EFF','📁',1000,?3)",
            params![id, name, folder],
        )
        .map_err(map_err)?;
    }
    let _ = set_setting(&c, "folder", folder);
    let _ = set_setting(&c, "project_name", name);
    // 老项目第一次打开时补齐任务编号；之后 seq 已经齐全，这一步等于空跑。
    let _ = backfill_task_seq(&c);
    Ok(c)
}

/// 在全局库里挑一个不撞名的文件夹名
pub fn unique_folder_name(conn: &Connection, name: &str, exclude: Option<i64>) -> String {
    let base = clean_path_name(name);
    let mut used: Vec<String> = Vec::new();
    if let Ok(mut stmt) = conn.prepare("SELECT id, COALESCE(folder,'') FROM projects") {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        }) {
            for (id, f) in rows.flatten() {
                if exclude == Some(id) || f.is_empty() {
                    continue;
                }
                used.push(f);
            }
        }
    }
    if !used.iter().any(|f| f == &base) {
        return base;
    }
    for i in 2..1000 {
        let cand = format!("{base}~{i}");
        if !used.iter().any(|f| f == &cand) {
            return cand;
        }
    }
    base
}

// ---------- Projects ----------

#[derive(Serialize)]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub icon: String,
    pub sort_order: f64,
}

fn row_to_project(r: &Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: r.get(0)?,
        name: r.get(1)?,
        color: r.get(2)?,
        icon: r.get(3)?,
        sort_order: r.get(4)?,
    })
}

#[tauri::command]
pub fn list_projects(global: State<GlobalDb>) -> Result<Vec<Project>, String> {
    let conn = global.0.lock().map_err(map_err)?;
    let mut stmt = conn
        .prepare("SELECT id,name,color,icon,sort_order FROM projects ORDER BY sort_order, id")
        .map_err(map_err)?;
    let rows = stmt.query_map([], row_to_project).map_err(map_err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(map_err)
}

#[tauri::command]
pub fn create_project(
    global: State<GlobalDb>,
    dir: State<DataDir>,
    name: String,
    color: Option<String>,
    icon: Option<String>,
) -> Result<i64, String> {
    let conn = global.0.lock().map_err(map_err)?;
    let so = next_order(&conn, "projects", "sort_order", None)?;
    let folder = unique_folder_name(&conn, &name, None);
    conn.execute(
        "INSERT INTO projects(name,color,icon,sort_order,folder) VALUES(?1,?2,?3,?4,?5)",
        params![
            name,
            color.unwrap_or_else(|| "#409EFF".into()),
            icon.unwrap_or_else(|| "📁".into()),
            so,
            folder
        ],
    )
    .map_err(map_err)?;
    let id = conn.last_insert_rowid();

    // 立刻把这个项目的文件夹和库建出来（空的也算"有",用户打开目录就能看到）
    let root = dir.root();
    let pc = open_project_db_at(&root, id, &name, &folder)?;
    // default columns for a new project
    let defaults: [(&str, &str); 4] = [
        ("待办", "#909399"),
        ("进行中", "#409EFF"),
        ("待评审", "#E6A23C"),
        ("已完成", "#67C23A"),
    ];
    for (i, (n, c)) in defaults.iter().enumerate() {
        pc.execute(
            "INSERT INTO columns(project_id,name,color,sort_order) VALUES(?1,?2,?3,?4)",
            params![id, n, c, (i + 1) as f64 * 1000.0],
        )
        .map_err(map_err)?;
    }
    Ok(id)
}

#[tauri::command]
pub fn update_project(
    global: State<GlobalDb>,
    dir: State<DataDir>,
    id: i64,
    name: Option<String>,
    color: Option<String>,
    icon: Option<String>,
) -> Result<(), String> {
    let conn = global.0.lock().map_err(map_err)?;
    if let Some(n) = name {
        let old_folder: String = conn
            .query_row("SELECT COALESCE(folder,'') FROM projects WHERE id=?1", params![id], |r| r.get(0))
            .unwrap_or_default();
        let new_folder = unique_folder_name(&conn, &n, Some(id));
        conn.execute(
            "UPDATE projects SET name=?1, folder=?2 WHERE id=?3",
            params![n, new_folder, id],
        )
        .map_err(map_err)?;
        // 改了名，磁盘上的文件夹也跟着改 —— 否则用户按新名字根本找不到。
        let root = dir.root();
        let (from, to) = (root.join(&old_folder), root.join(&new_folder));
        if !old_folder.is_empty() && old_folder != new_folder && from.exists() && !to.exists() {
            let _ = std::fs::rename(&from, &to);
        }
        if let Ok(pc) = Connection::open(to.join(PROJECT_DB_NAME)) {
            let _ = set_setting(&pc, "folder", &new_folder);
            let _ = set_setting(&pc, "project_name", &n);
            // 附件存的是绝对路径，文件夹一改就得整批改前缀
            let old_p = from.to_string_lossy().to_string();
            let new_p = to.to_string_lossy().to_string();
            let _ = pc.execute(
                "UPDATE wb_files SET path = ?2 || substr(path, length(?1)+1)
                 WHERE ?1 <> '' AND substr(path,1,length(?1)) = ?1",
                params![old_p, new_p],
            );
        }
    }
    if let Some(c) = color {
        conn.execute("UPDATE projects SET color=?1 WHERE id=?2", params![c, id]).map_err(map_err)?;
    }
    if let Some(i) = icon {
        conn.execute("UPDATE projects SET icon=?1 WHERE id=?2", params![i, id]).map_err(map_err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn delete_project(
    global: State<GlobalDb>,
    db: State<Db>,
    dir: State<DataDir>,
    id: i64,
) -> Result<(), String> {
    let conn = global.0.lock().map_err(map_err)?;
    let folder: String = conn
        .query_row("SELECT COALESCE(folder,'') FROM projects WHERE id=?1", params![id], |r| r.get(0))
        .unwrap_or_default();
    conn.execute("DELETE FROM projects WHERE id=?1", params![id]).map_err(map_err)?;
    // 正在用的就是这个项目 → 先把连接挪到内存库，否则文件被占用删不掉
    let cur_folder = {
        let d = db.0.lock().map_err(map_err)?;
        get_setting(&d, "folder").ok().flatten()
    };
    if !folder.is_empty() && cur_folder.as_deref() == Some(folder.as_str()) {
        if let Ok(mut g) = db.0.lock() {
            if let Ok(mem) = Connection::open_in_memory() {
                let _ = crate::db::init_db(&mem);
                *g = mem;
            }
        }
    }
    // 一个项目 = 一个文件夹：删项目就把这份文件夹整份删掉（库 + 附件 + 文档）
    if !folder.is_empty() {
        let p = dir.root().join(&folder);
        if p.exists() {
            let _ = std::fs::remove_dir_all(&p);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn reorder_projects(global: State<GlobalDb>, ordered_ids: Vec<i64>) -> Result<(), String> {
    let conn = global.0.lock().map_err(map_err)?;
    for (i, id) in ordered_ids.iter().enumerate() {
        conn.execute(
            "UPDATE projects SET sort_order=?1 WHERE id=?2",
            params![(i as f64 + 1.0) * 1000.0, id],
        )
        .map_err(map_err)?;
    }
    Ok(())
}

// ---------- Columns ----------

#[derive(Serialize)]
pub struct ColumnOut {
    pub id: i64,
    pub project_id: i64,
    pub name: String,
    pub color: String,
    pub wip_limit: Option<i64>,
    pub sort_order: f64,
    pub collapsed: bool,
}

#[tauri::command]
pub fn list_columns(db: State<Db>, project_id: i64) -> Result<Vec<ColumnOut>, String> {
    let conn = db.0.lock().map_err(map_err)?;
    let mut stmt = conn
        .prepare(
            "SELECT id,project_id,name,color,wip_limit,sort_order,collapsed
             FROM columns WHERE project_id=?1 ORDER BY sort_order, id",
        )
        .map_err(map_err)?;
    let rows = stmt
        .query_map(params![project_id], |r| {
            Ok(ColumnOut {
                id: r.get(0)?,
                project_id: r.get(1)?,
                name: r.get(2)?,
                color: r.get(3)?,
                wip_limit: r.get(4)?,
                sort_order: r.get(5)?,
                collapsed: r.get::<_, i64>(6)? != 0,
            })
        })
        .map_err(map_err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(map_err)
}

#[tauri::command]
pub fn create_column(
    db: State<Db>,
    project_id: i64,
    name: String,
    color: Option<String>,
) -> Result<i64, String> {
    let conn = db.0.lock().map_err(map_err)?;
    let so = next_order(&conn, "columns", "sort_order", Some(("project_id", project_id)))?;
    conn.execute(
        "INSERT INTO columns(project_id,name,color,sort_order) VALUES(?1,?2,?3,?4)",
        params![project_id, name, color.unwrap_or_else(|| "#909399".into()), so],
    )
    .map_err(map_err)?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn update_column(
    db: State<Db>,
    id: i64,
    name: Option<String>,
    color: Option<String>,
    wip_limit: Option<i64>,
    collapsed: Option<bool>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(map_err)?;
    if let Some(n) = name {
        conn.execute("UPDATE columns SET name=?1 WHERE id=?2", params![n, id]).map_err(map_err)?;
    }
    if let Some(c) = color {
        conn.execute("UPDATE columns SET color=?1 WHERE id=?2", params![c, id]).map_err(map_err)?;
    }
    if let Some(w) = wip_limit {
        conn.execute("UPDATE columns SET wip_limit=?1 WHERE id=?2", params![w, id]).map_err(map_err)?;
    }
    if let Some(c) = collapsed {
        conn.execute("UPDATE columns SET collapsed=?1 WHERE id=?2", params![c as i64, id])
            .map_err(map_err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn delete_column(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(map_err)?;
    conn.execute("DELETE FROM columns WHERE id=?1", params![id]).map_err(map_err)?;
    // column deletion cascades to its tasks; drop now-orphaned whiteboard edges
    prune_orphan_edges(&conn).map_err(map_err)?;
    Ok(())
}

#[tauri::command]
pub fn reorder_columns(db: State<Db>, project_id: i64, ordered_ids: Vec<i64>) -> Result<(), String> {
    let conn = db.0.lock().map_err(map_err)?;
    for (i, id) in ordered_ids.iter().enumerate() {
        conn.execute(
            "UPDATE columns SET sort_order=?1 WHERE id=?2 AND project_id=?3",
            params![(i as f64 + 1.0) * 1000.0, id, project_id],
        )
        .map_err(map_err)?;
    }
    Ok(())
}

// ---------- Tasks ----------

#[derive(Serialize)]
pub struct TaskOut {
    pub id: i64,
    pub project_id: i64,
    pub column_id: i64,
    pub title: String,
    pub description: String,
    pub priority: i64,
    pub due_date: Option<String>,
    pub sort_order: f64,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    pub tags: Vec<i64>,
    pub wx: Option<f64>,
    pub wy: Option<f64>,
    pub start_date: Option<String>,
    pub progress: Option<i64>,
    /// 甘特条手动配色；空 = 按紧迫度自动配色
    pub bar_color: Option<String>,
    /// 项目内编号（T1、T2…）。删除后不回收，0 表示尚未编号
    pub seq: i64,
}

#[tauri::command]
pub fn list_tasks(db: State<Db>, project_id: i64) -> Result<Vec<TaskOut>, String> {
    let conn = db.0.lock().map_err(map_err)?;
    let mut stmt = conn
        .prepare(
            "SELECT id,project_id,column_id,title,description,priority,due_date,
                    sort_order,created_at,updated_at,completed_at,wx,wy,start_date,progress,bar_color,seq
             FROM tasks WHERE project_id=?1 AND deleted_at IS NULL
             ORDER BY sort_order, id",
        )
        .map_err(map_err)?;
    let mut tasks: Vec<TaskOut> = stmt
        .query_map(params![project_id], |r| {
            Ok(TaskOut {
                id: r.get(0)?,
                project_id: r.get(1)?,
                column_id: r.get(2)?,
                title: r.get(3)?,
                description: r.get(4)?,
                priority: r.get(5)?,
                due_date: r.get(6)?,
                sort_order: r.get(7)?,
                created_at: r.get(8)?,
                updated_at: r.get(9)?,
                completed_at: r.get(10)?,
                tags: Vec::new(),
                wx: r.get(11)?,
                wy: r.get(12)?,
                start_date: r.get(13)?,
                progress: r.get(14)?,
                bar_color: r.get(15)?,
                seq: r.get(16)?,
            })
        })
        .map_err(map_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(map_err)?;

    let mut tag_stmt = conn.prepare("SELECT tag_id FROM task_tags WHERE task_id=?1").map_err(map_err)?;
    for t in tasks.iter_mut() {
        let ids: Vec<i64> = tag_stmt
            .query_map(params![t.id], |r| r.get(0))
            .map_err(map_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(map_err)?;
        t.tags = ids;
    }
    Ok(tasks)
}

#[derive(Deserialize)]
pub struct NewTask {
    pub project_id: i64,
    pub column_id: i64,
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<i64>,
    pub due_date: Option<String>,
    pub start_date: Option<String>,
    pub tags: Option<Vec<i64>>,
}

#[tauri::command]
pub fn create_task(db: State<Db>, task: NewTask) -> Result<i64, String> {
    let conn = db.0.lock().map_err(map_err)?;
    let so = next_order(&conn, "tasks", "sort_order", Some(("column_id", task.column_id)))?;
    // 新任务当场编号，界面上立刻能显示；号不回收，删掉的不会再给别人
    let seq: i64 = conn
        .query_row("SELECT COALESCE(MAX(seq), 0) + 1 FROM tasks", [], |r| r.get(0))
        .map_err(map_err)?;
    conn.execute(
        "INSERT INTO tasks(project_id,column_id,title,description,priority,due_date,start_date,sort_order,seq)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            task.project_id,
            task.column_id,
            task.title,
            task.description.unwrap_or_default(),
            task.priority.unwrap_or(2),
            task.due_date,
            task.start_date,
            so,
            seq
        ],
    )
    .map_err(map_err)?;
    let id = conn.last_insert_rowid();
    if let Some(tags) = task.tags {
        for tag in tags {
            conn.execute(
                "INSERT OR IGNORE INTO task_tags(task_id,tag_id) VALUES(?1,?2)",
                params![id, tag],
            )
            .map_err(map_err)?;
        }
    }
    Ok(id)
}

#[derive(Deserialize)]
pub struct TaskPatch {
    pub title: Option<String>,
    pub description: Option<String>,
    pub priority: Option<i64>,
    pub due_date: Option<String>,
    pub start_date: Option<String>,
    pub progress: Option<i64>,
    pub completed: Option<bool>,
    pub tags: Option<Vec<i64>>,
    /// 甘特条手动配色：Some(None) = 恢复自动配色，Some(Some(hex)) = 指定颜色
    pub bar_color: Option<Option<String>>,
}

#[tauri::command]
pub fn update_task(db: State<Db>, id: i64, patch: TaskPatch) -> Result<(), String> {
    let conn = db.0.lock().map_err(map_err)?;
    if let Some(t) = patch.title {
        conn.execute(
            "UPDATE tasks SET title=?1,updated_at=datetime('now','localtime') WHERE id=?2",
            params![t, id],
        )
        .map_err(map_err)?;
    }
    if let Some(d) = patch.description {
        conn.execute(
            "UPDATE tasks SET description=?1,updated_at=datetime('now','localtime') WHERE id=?2",
            params![d, id],
        )
        .map_err(map_err)?;
    }
    if let Some(p) = patch.priority {
        conn.execute(
            "UPDATE tasks SET priority=?1,updated_at=datetime('now','localtime') WHERE id=?2",
            params![p, id],
        )
        .map_err(map_err)?;
    }
    if let Some(d) = patch.due_date {
        conn.execute(
            "UPDATE tasks SET due_date=?1,updated_at=datetime('now','localtime') WHERE id=?2",
            params![d, id],
        )
        .map_err(map_err)?;
    }
    if let Some(d) = patch.start_date {
        conn.execute(
            "UPDATE tasks SET start_date=?1,updated_at=datetime('now','localtime') WHERE id=?2",
            params![d, id],
        )
        .map_err(map_err)?;
    }
    if let Some(p) = patch.progress {
        conn.execute(
            "UPDATE tasks SET progress=?1,updated_at=datetime('now','localtime') WHERE id=?2",
            params![p, id],
        )
        .map_err(map_err)?;
    }
    if let Some(c) = patch.bar_color {
        // Some(None) = 用户点了「跟随状态」，把手动颜色清掉
        let v: Option<&str> = c.as_deref();
        conn.execute(
            "UPDATE tasks SET bar_color=?1,updated_at=datetime('now','localtime') WHERE id=?2",
            params![v, id],
        )
        .map_err(map_err)?;
    }
    if let Some(c) = patch.completed {
        if c {
            conn.execute(
                "UPDATE tasks SET completed_at=datetime('now','localtime'),updated_at=datetime('now','localtime') WHERE id=?1",
                params![id],
            )
            .map_err(map_err)?;
        } else {
            conn.execute(
                "UPDATE tasks SET completed_at=NULL,updated_at=datetime('now','localtime') WHERE id=?1",
                params![id],
            )
            .map_err(map_err)?;
        }
    }
    if let Some(tags) = patch.tags {
        conn.execute("DELETE FROM task_tags WHERE task_id=?1", params![id]).map_err(map_err)?;
        for tag in tags {
            conn.execute(
                "INSERT OR IGNORE INTO task_tags(task_id,tag_id) VALUES(?1,?2)",
                params![id, tag],
            )
            .map_err(map_err)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn move_task(db: State<Db>, id: i64, column_id: i64, sort_order: f64) -> Result<(), String> {
    let conn = db.0.lock().map_err(map_err)?;
    conn.execute(
        "UPDATE tasks SET column_id=?1,sort_order=?2,updated_at=datetime('now','localtime') WHERE id=?3",
        params![column_id, sort_order, id],
    )
    .map_err(map_err)?;
    Ok(())
}

#[tauri::command]
pub fn delete_task(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(map_err)?;
    conn.execute("UPDATE tasks SET deleted_at=datetime('now','localtime') WHERE id=?1", params![id])
        .map_err(map_err)?;
    Ok(())
}

#[tauri::command]
pub fn restore_task(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(map_err)?;
    conn.execute("UPDATE tasks SET deleted_at=NULL WHERE id=?1", params![id]).map_err(map_err)?;
    Ok(())
}

#[tauri::command]
pub fn purge_task(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(map_err)?;
    conn.execute("DELETE FROM tasks WHERE id=?1", params![id]).map_err(map_err)?;
    prune_orphan_edges(&conn).map_err(map_err)?;
    Ok(())
}

#[derive(Serialize)]
pub struct TrashItem {
    pub id: i64,
    pub title: String,
    pub column_name: Option<String>,
    pub project_name: Option<String>,
    pub deleted_at: Option<String>,
}

#[tauri::command]
pub fn list_trash(db: State<Db>) -> Result<Vec<TrashItem>, String> {
    let conn = db.0.lock().map_err(map_err)?;
    // 现在一个项目一份库，项目名直接读本库的 settings，不再 JOIN projects
    let pname: Option<String> = get_setting(&conn, "project_name").map_err(map_err)?;
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.title, c.name, t.deleted_at
             FROM tasks t
             LEFT JOIN columns c ON c.id = t.column_id
             WHERE t.deleted_at IS NOT NULL
             ORDER BY t.deleted_at DESC",
        )
        .map_err(map_err)?;
    let rows = stmt
        .query_map([], move |r| {
            Ok(TrashItem {
                id: r.get(0)?,
                title: r.get(1)?,
                column_name: r.get(2)?,
                project_name: pname.clone(),
                deleted_at: r.get(3)?,
            })
        })
        .map_err(map_err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(map_err)
}

#[tauri::command]
pub fn empty_trash(db: State<Db>) -> Result<(), String> {
    let conn = db.0.lock().map_err(map_err)?;
    conn.execute("DELETE FROM tasks WHERE deleted_at IS NOT NULL", []).map_err(map_err)?;
    prune_orphan_edges(&conn).map_err(map_err)?;
    Ok(())
}

// ---------- Tags ----------

#[derive(Serialize)]
pub struct TagOut {
    pub id: i64,
    pub project_id: i64,
    pub name: String,
    pub color: String,
}

#[tauri::command]
pub fn list_tags(db: State<Db>, project_id: i64) -> Result<Vec<TagOut>, String> {
    let conn = db.0.lock().map_err(map_err)?;
    let mut stmt = conn
        .prepare("SELECT id,project_id,name,color FROM tags WHERE project_id=?1 ORDER BY id")
        .map_err(map_err)?;
    let rows = stmt
        .query_map(params![project_id], |r| {
            Ok(TagOut {
                id: r.get(0)?,
                project_id: r.get(1)?,
                name: r.get(2)?,
                color: r.get(3)?,
            })
        })
        .map_err(map_err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(map_err)
}

#[tauri::command]
pub fn create_tag(
    db: State<Db>,
    project_id: i64,
    name: String,
    color: Option<String>,
) -> Result<i64, String> {
    let conn = db.0.lock().map_err(map_err)?;
    conn.execute(
        "INSERT INTO tags(project_id,name,color) VALUES(?1,?2,?3)",
        params![project_id, name, color.unwrap_or_else(|| "#409EFF".into())],
    )
    .map_err(map_err)?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn delete_tag(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(map_err)?;
    conn.execute("DELETE FROM tags WHERE id=?1", params![id]).map_err(map_err)?;
    Ok(())
}

// ---------- Settings / bootstrap ----------

#[tauri::command]
pub fn get_settings(global: State<GlobalDb>) -> Result<Value, String> {
    let conn = global.0.lock().map_err(map_err)?;
    let theme = get_setting(&conn, "theme").map_err(map_err)?;
    Ok(serde_json::json!({ "theme": theme.unwrap_or_else(|| "light".into()) }))
}

#[tauri::command]
pub fn set_setting_kv(global: State<GlobalDb>, key: String, value: String) -> Result<(), String> {
    let conn = global.0.lock().map_err(map_err)?;
    set_setting(&conn, &key, &value)
}

#[derive(Serialize)]
pub struct Bootstrap {
    pub projects: Vec<Project>,
    pub settings: Value,
    pub current_project_id: Option<i64>,
}

#[tauri::command]
pub fn bootstrap(global: State<GlobalDb>) -> Result<Bootstrap, String> {
    let conn = global.0.lock().map_err(map_err)?;
    let mut stmt = conn
        .prepare("SELECT id,name,color,icon,sort_order FROM projects ORDER BY sort_order, id")
        .map_err(map_err)?;
    let projects: Vec<Project> = stmt
        .query_map([], row_to_project)
        .map_err(map_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(map_err)?;
    let theme = get_setting(&conn, "theme").map_err(map_err)?;
    let cur = get_setting(&conn, "current_project_id").map_err(map_err)?;
    let current_project_id = cur.and_then(|v| v.parse::<i64>().ok());
    Ok(Bootstrap {
        projects,
        settings: serde_json::json!({ "theme": theme.unwrap_or_else(|| "light".into()) }),
        current_project_id,
    })
}

// ---------- Whiteboard ----------

// Delete edges whose endpoints no longer exist (after hard task/note removal).
// Soft-deleted (trashed) tasks keep their edges so a restore brings them back.
fn prune_orphan_edges(conn: &Connection) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "DELETE FROM board_edges WHERE
           (from_kind='task' AND NOT EXISTS (SELECT 1 FROM tasks WHERE id=from_id))
        OR (to_kind='task'    AND NOT EXISTS (SELECT 1 FROM tasks WHERE id=to_id))
        OR (from_kind='note'  AND NOT EXISTS (SELECT 1 FROM board_notes WHERE id=from_id))
        OR (to_kind='note'    AND NOT EXISTS (SELECT 1 FROM board_notes WHERE id=to_id))",
        [],
    )
}

// Persist a task's whiteboard position.
#[tauri::command]
pub fn set_task_pos(db: State<Db>, id: i64, wx: f64, wy: f64) -> Result<(), String> {
    let conn = db.0.lock().map_err(map_err)?;
    conn.execute("UPDATE tasks SET wx=?1, wy=?2 WHERE id=?3", params![wx, wy, id])
        .map_err(map_err)?;
    Ok(())
}

// A whiteboard node. `kind` decides how it renders:
//   note  = 便签（黄色小纸条）
//   text  = 纯文本标签
//   mind  = 思维导图节点
//   file  = 上传的资料 / 图片（file_id 指向 wb_files）
//   box   = 分组框（半透明底 + 标题）
#[derive(Serialize)]
pub struct NoteOut {
    pub id: i64,
    pub project_id: i64,
    pub x: f64,
    pub y: f64,
    pub text: String,
    pub color: String,
    pub kind: String,
    pub w: Option<f64>,
    pub h: Option<f64>,
    pub file_id: Option<i64>,
    pub meta: String,
    /// 分区的用途：goal / input / constraint / work / output / defer，空 = 未标注
    pub role: String,
    /// 特殊分组类型：candidates 候选组 / versions 版本组，空 = 普通分组
    pub group_kind: String,
}

const NOTE_SELECT: &str =
    "SELECT id,project_id,x,y,text,color,kind,w,h,file_id,meta,role,group_kind FROM board_notes";

fn row_to_note(r: &Row) -> rusqlite::Result<NoteOut> {
    Ok(NoteOut {
        id: r.get(0)?,
        project_id: r.get(1)?,
        x: r.get(2)?,
        y: r.get(3)?,
        text: r.get(4)?,
        color: r.get(5)?,
        kind: r.get::<_, Option<String>>(6)?.unwrap_or_else(|| "note".into()),
        w: r.get(7)?,
        h: r.get(8)?,
        file_id: r.get(9)?,
        meta: r.get::<_, Option<String>>(10)?.unwrap_or_default(),
        role: r.get::<_, Option<String>>(11)?.unwrap_or_default(),
        group_kind: r.get::<_, Option<String>>(12)?.unwrap_or_default(),
    })
}

#[tauri::command]
pub fn list_notes(db: State<Db>, project_id: i64) -> Result<Vec<NoteOut>, String> {
    let conn = db.0.lock().map_err(map_err)?;
    let mut stmt = conn
        .prepare(&format!("{NOTE_SELECT} WHERE project_id=?1 ORDER BY id"))
        .map_err(map_err)?;
    let rows = stmt.query_map(params![project_id], row_to_note).map_err(map_err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(map_err)
}

#[tauri::command]
pub fn create_note(
    db: State<Db>,
    project_id: i64,
    x: f64,
    y: f64,
    text: String,
    color: Option<String>,
    kind: Option<String>,
    w: Option<f64>,
    h: Option<f64>,
    file_id: Option<i64>,
    meta: Option<String>,
) -> Result<i64, String> {
    let conn = db.0.lock().map_err(map_err)?;
    conn.execute(
        "INSERT INTO board_notes(project_id,x,y,text,color,kind,w,h,file_id,meta)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![
            project_id,
            x,
            y,
            text,
            color.unwrap_or_else(|| "#FFF9C4".into()),
            kind.unwrap_or_else(|| "note".into()),
            w,
            h,
            file_id,
            meta.unwrap_or_default()
        ],
    )
    .map_err(map_err)?;
    Ok(conn.last_insert_rowid())
}

#[derive(Deserialize)]
pub struct NotePatch {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub text: Option<String>,
    pub color: Option<String>,
    pub kind: Option<String>,
    pub w: Option<f64>,
    pub h: Option<f64>,
    pub file_id: Option<i64>,
    pub meta: Option<String>,
    pub role: Option<String>,
    pub group_kind: Option<String>,
}

#[tauri::command]
pub fn update_note(db: State<Db>, id: i64, patch: NotePatch) -> Result<(), String> {
    let conn = db.0.lock().map_err(map_err)?;
    let mut sql = String::from("UPDATE board_notes SET ");
    let mut sets: Vec<String> = Vec::new();
    let mut vals: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    macro_rules! push {
        ($field:expr, $col:expr) => {
            if let Some(v) = $field {
                sets.push(format!("{} = ?{}", $col, sets.len() + 1));
                vals.push(Box::new(v));
            }
        };
    }
    push!(patch.x, "x");
    push!(patch.y, "y");
    push!(patch.text, "text");
    push!(patch.color, "color");
    push!(patch.kind, "kind");
    push!(patch.w, "w");
    push!(patch.h, "h");
    push!(patch.file_id, "file_id");
    push!(patch.meta, "meta");
    push!(patch.role, "role");
    push!(patch.group_kind, "group_kind");

    if sets.is_empty() {
        return Ok(());
    }
    sql.push_str(&sets.join(", "));
    sql.push_str(&format!(" WHERE id = ?{}", sets.len() + 1));
    vals.push(Box::new(id));

    let refs: Vec<&dyn rusqlite::ToSql> = vals.iter().map(|b| b.as_ref()).collect();
    conn.execute(&sql, refs.as_slice()).map_err(map_err)?;
    Ok(())
}

// Delete a node. If it was an uploaded file the file is dropped from disk too.
#[tauri::command]
pub fn delete_note(db: State<Db>, dir: State<DataDir>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(map_err)?;
    // 注意：file_id 对便签/导图/文字等节点是 NULL，必须按 Option<i64> 读，
    // 直接 r.get(0) 会在 NULL 上报 "Invalid column type Null"，
    // 结果是**任何非资料卡片都删不掉**。.optional() 只处理"没有这一行"，管不了 NULL。
    let file_id: Option<i64> = conn
        .query_row("SELECT file_id FROM board_notes WHERE id=?1", params![id], |r| {
            r.get::<_, Option<i64>>(0)
        })
        .optional()
        .map_err(map_err)?
        .flatten();
    conn.execute("DELETE FROM board_notes WHERE id=?1", params![id]).map_err(map_err)?;
    prune_orphan_edges(&conn).map_err(map_err)?;
    if let Some(fid) = file_id {
        drop_file(&conn, &dir, fid)?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct EdgeOut {
    pub id: i64,
    pub project_id: i64,
    pub from_kind: String,
    pub from_id: i64,
    pub to_kind: String,
    pub to_id: i64,
    /// 关系类型：decompose 分解 / precede 先后 / evidence 依据 / produce 产出
    pub kind: String,
    /// 只对依据类有意义：0 必须遵守 / 1 可以参考 / 2 仅作背景
    pub strength: i64,
}

#[tauri::command]
pub fn list_edges(db: State<Db>, project_id: i64) -> Result<Vec<EdgeOut>, String> {
    let conn = db.0.lock().map_err(map_err)?;
    let mut stmt = conn
        .prepare(
            "SELECT id,project_id,from_kind,from_id,to_kind,to_id,kind,strength
             FROM board_edges WHERE project_id=?1 ORDER BY id",
        )
        .map_err(map_err)?;
    let rows = stmt
        .query_map(params![project_id], |r| {
            Ok(EdgeOut {
                id: r.get(0)?,
                project_id: r.get(1)?,
                from_kind: r.get(2)?,
                from_id: r.get(3)?,
                to_kind: r.get(4)?,
                to_id: r.get(5)?,
                kind: r.get::<_, Option<String>>(6)?.unwrap_or_else(|| "decompose".into()),
                strength: r.get::<_, Option<i64>>(7)?.unwrap_or(0),
            })
        })
        .map_err(map_err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(map_err)
}

#[tauri::command]
pub fn create_edge(
    db: State<Db>,
    project_id: i64,
    from_kind: String,
    from_id: i64,
    to_kind: String,
    to_id: i64,
    kind: Option<String>,
) -> Result<i64, String> {
    if from_kind == to_kind && from_id == to_id {
        return Err("不能连接到自身".into());
    }
    if (from_kind != "task" && from_kind != "note") || (to_kind != "task" && to_kind != "note") {
        return Err("未知的节点类型".into());
    }
    let conn = db.0.lock().map_err(map_err)?;
    // skip duplicates
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM board_edges
             WHERE project_id=?1 AND from_kind=?2 AND from_id=?3 AND to_kind=?4 AND to_id=?5",
            params![project_id, from_kind, from_id, to_kind, to_id],
            |r| r.get(0),
        )
        .map_err(map_err)?;
    if exists > 0 {
        let id: i64 = conn
            .query_row(
                "SELECT id FROM board_edges
                 WHERE project_id=?1 AND from_kind=?2 AND from_id=?3 AND to_kind=?4 AND to_id=?5",
                params![project_id, from_kind, from_id, to_kind, to_id],
                |r| r.get(0),
            )
            .map_err(map_err)?;
        return Ok(id);
    }
    let kind = normalize_edge_kind(kind.as_deref());
    conn.execute(
        "INSERT INTO board_edges(project_id,from_kind,from_id,to_kind,to_id,kind,strength)
         VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![project_id, from_kind, from_id, to_kind, to_id, kind, default_strength(&kind)],
    )
    .map_err(map_err)?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn delete_edge(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(map_err)?;
    conn.execute("DELETE FROM board_edges WHERE id=?1", params![id]).map_err(map_err)?;
    Ok(())
}

// ---------- 白板资料 / 附件 ----------

/// 数据库文件名。老版本叫 kanban.db（看不出是什么），新版直接用中文名。
pub const DB_NAME: &str = "看板数据.db";
pub const LEGACY_DB_NAME: &str = "kanban.db";

/// 应用数据根目录（用户可以在「数据存储」里换到别的文件夹，所以是可变的）
pub struct DataDir(pub std::sync::Mutex<std::path::PathBuf>);

impl DataDir {
    pub fn root(&self) -> std::path::PathBuf {
        self.0.lock().map(|p| p.clone()).unwrap_or_default()
    }
}

/// 老版本的资料目录：所有项目的附件混在一起、按 `<id>.<ext>` 命名
/// —— 只在「整理旧附件」和「删文件兜底」时还会用到。
pub fn assets_root(dir: &DataDir) -> std::path::PathBuf {
    dir.root().join("assets")
}

/// Windows 下把正斜杠统一成反斜杠 —— 用户手填或指针文件里可能是 `D:/看板`，
/// 不统一的话会拼出 `D:/看板\项目` 这种混合路径，前缀替换也容易对不上。
pub fn normalize_dir(p: &str) -> std::path::PathBuf {
    let t = p.trim();
    #[cfg(target_os = "windows")]
    {
        return std::path::PathBuf::from(t.replace('/', "\\"));
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::path::PathBuf::from(t)
    }
}

/// 去掉文件名里不能用的字符，并限制长度
pub fn clean_path_name(s: &str) -> String {    let bad = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
    let filtered: String = s
        .chars()
        .filter(|c| !bad.contains(c) && *c >= ' ' && *c != '\u{7f}')
        .collect();
    let mut out: String = filtered.trim().chars().take(60).collect();
    while out.ends_with('.') || out.ends_with(' ') {
        out.pop();
    }
    if out.trim().is_empty() {
        "未命名".to_string()
    } else {
        out
    }
}

/// 当前项目的文件夹名 —— 建库/改名时由全局库算好存在 `settings.folder`，
/// 这里直接读，不再查 projects 表（项目库里没有那张表了）。
pub fn project_folder_name(conn: &Connection, _project_id: i64) -> String {
    if let Ok(Some(f)) = get_setting(conn, "folder") {
        if !f.trim().is_empty() {
            return f;
        }
    }
    let name = get_setting(conn, "project_name").ok().flatten().unwrap_or_default();
    clean_path_name(&name)
}

/// 项目文件夹：<根目录>/<项目名>/
pub fn project_dir(conn: &Connection, dir: &DataDir, project_id: i64) -> std::path::PathBuf {
    dir.root().join(project_folder_name(conn, project_id))
}

/// 项目附件目录：<根目录>/<项目名>/附件/
pub fn project_asset_dir(conn: &Connection, dir: &DataDir, project_id: i64) -> std::path::PathBuf {
    project_dir(conn, dir, project_id).join(ATTACH_DIR)
}

/// 存库用的路径：**相对数据根目录**。
/// ⚠️ 一定不能存绝对路径 —— 存了的话，整个数据文件夹一挪位置 / 拷给别人，
/// 图片和文稿就全"丢"了（库还指着老地方）。
pub fn rel_to_root(dir: &DataDir, abs: &std::path::Path) -> String {
    match abs.strip_prefix(dir.root()) {
        Ok(r) => r.to_string_lossy().to_string(),
        Err(_) => abs.to_string_lossy().to_string(),
    }
}

/// 把库里存的路径还原成绝对路径（老数据存的是绝对路径，原样返回）
pub fn abs_of(dir: &DataDir, p: &str) -> std::path::PathBuf {
    if p.trim().is_empty() {
        return std::path::PathBuf::new();
    }
    let pb = std::path::PathBuf::from(p);
    if pb.is_absolute() {
        pb
    } else {
        dir.root().join(pb)
    }
}

/// 把老数据里的绝对路径统一改成相对路径（启动时跑一次，幂等）。
/// 改完整个数据文件夹就可以随便拷、随便挪。
pub fn normalize_asset_paths(conn: &Connection, dir: &DataDir) {
    let pref = dir.root().to_string_lossy().to_string().replace('/', "\\");
    for (table, col) in [("wb_files", "path"), ("docs", "path")] {
        let sql = format!("SELECT id, COALESCE({col},'') FROM {table} WHERE COALESCE({col},'') <> ''");
        let list: Vec<(i64, String)> = {
            let Ok(mut stmt) = conn.prepare(&sql) else { continue };
            let Ok(rows) = stmt.query_map([], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            }) else {
                continue;
            };
            rows.flatten().collect()
        };
        for (id, p) in list {
            if !std::path::Path::new(&p).is_absolute() {
                continue;
            }
            let norm = p.replace('/', "\\");
            if let Some(rest) = norm.strip_prefix(&pref) {
                let rel = rest.trim_start_matches('\\').to_string();
                let _ = conn.execute(
                    &format!("UPDATE {table} SET {col}=?1 WHERE id=?2"),
                    params![rel, id],
                );
            }
        }
    }
}

/// 同一目录下不撞名：`方案.pdf` → `方案 (2).pdf`
fn unique_file_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let path = std::path::Path::new(name);
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = path.extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    for i in 2..2000 {
        let cand = if ext.is_empty() {
            dir.join(format!("{stem} ({i})"))
        } else {
            dir.join(format!("{stem} ({i}).{ext}"))
        };
        if !cand.exists() {
            return cand;
        }
    }
    dir.join(name)
}

#[derive(Serialize)]
pub struct WbFileOut {
    pub id: i64,
    pub project_id: i64,
    pub name: String,
    pub ext: String,
    pub mime: String,
    pub size: i64,
    pub path: String,
    pub created_at: String,
}

const FILE_SELECT: &str =
    "SELECT id,project_id,name,ext,mime,size,path,created_at FROM wb_files";

fn row_to_file(r: &Row) -> rusqlite::Result<WbFileOut> {
    Ok(WbFileOut {
        id: r.get(0)?,
        project_id: r.get(1)?,
        name: r.get(2)?,
        ext: r.get(3)?,
        mime: r.get(4)?,
        size: r.get(5)?,
        path: r.get(6)?,
        created_at: r.get(7)?,
    })
}

fn ext_of(name: &str) -> String {
    std::path::Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn sanitize_ext(ext: &str) -> String {
    ext.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(10)
        .collect::<String>()
        .to_lowercase()
}

fn guess_mime(ext: &str) -> String {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "txt" | "md" | "log" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "zip" => "application/zip",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        _ => "application/octet-stream",
    }
    .to_string()
}

const B64_CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_CHARS[((n >> 18) & 63) as usize] as char);
        out.push(B64_CHARS[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(B64_CHARS[((n >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(B64_CHARS[(n & 63) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn b64_val(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some((c - b'A') as u32),
        b'a'..=b'z' => Some((c - b'a') as u32 + 26),
        b'0'..=b'9' => Some((c - b'0') as u32 + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    let symbols: Vec<u32> = s.bytes().filter_map(b64_val).collect();
    let mut out = Vec::with_capacity(symbols.len() / 4 * 3 + 3);
    for chunk in symbols.chunks(4) {
        match chunk.len() {
            4 => {
                let n = (chunk[0] << 18) | (chunk[1] << 12) | (chunk[2] << 6) | chunk[3];
                out.push(((n >> 16) & 255) as u8);
                out.push(((n >> 8) & 255) as u8);
                out.push((n & 255) as u8);
            }
            3 => {
                let n = (chunk[0] << 18) | (chunk[1] << 12) | (chunk[2] << 6);
                out.push(((n >> 16) & 255) as u8);
                out.push(((n >> 8) & 255) as u8);
            }
            2 => {
                let n = (chunk[0] << 18) | (chunk[1] << 12);
                out.push(((n >> 16) & 255) as u8);
            }
            _ => break,
        }
    }
    Ok(out)
}

/// 删掉一条 wb_files 记录及其磁盘文件（路径丢了就按 id 前缀扫目录兜底）。
fn drop_file(conn: &Connection, dir: &DataDir, file_id: i64) -> Result<(), String> {
    let path: Option<String> = conn
        .query_row("SELECT path FROM wb_files WHERE id=?1", params![file_id], |r| r.get(0))
        .optional()
        .map_err(map_err)?;
    conn.execute("DELETE FROM wb_files WHERE id=?1", params![file_id]).map_err(map_err)?;

    let mut removed = false;
    if let Some(p) = path.as_deref() {
        let abs = abs_of(dir, p);
        if !p.is_empty() && std::fs::remove_file(abs).is_ok() {
            removed = true;
        }
    }
    if !removed {
        if let Ok(rd) = std::fs::read_dir(assets_root(dir)) {
            let prefix = format!("{file_id}.");
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if n.starts_with(&prefix) || n == file_id.to_string() {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
    Ok(())
}

fn open_with_system(path: &str) -> Result<(), String> {
    if !std::path::Path::new(path).exists() {
        return Err("文件不存在（可能已被移动或删除）".into());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", path])
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(map_err)?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(path).spawn().map_err(map_err)?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(path).spawn().map_err(map_err)?;
    }
    Ok(())
}

/// 把一段 base64 内容落盘成项目资料，返回记录。
/// `sha256` 是前端算好的内容指纹，用来做"同一份文件不重复存"。
#[tauri::command]
pub fn import_asset(
    db: State<Db>,
    dir: State<DataDir>,
    project_id: i64,
    name: String,
    mime: Option<String>,
    data_b64: String,
    sha256: Option<String>,
) -> Result<WbFileOut, String> {
    // 兼容前端可能直接丢过来 "data:xxx;base64,yyy" 的整串
    let payload = data_b64.rsplit(',').next().unwrap_or("").trim();
    let bytes = b64_decode(payload)?;
    if bytes.is_empty() {
        return Err("文件内容为空".into());
    }
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("文件超过 64MB，暂不支持上传".into());
    }

    let conn = db.0.lock().map_err(map_err)?;
    let ext = sanitize_ext(&ext_of(&name));
    let mime = mime
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| guess_mime(&ext));
    let hash = sha256.unwrap_or_default();

    conn.execute(
        "INSERT INTO wb_files(project_id,name,ext,mime,size,path,sha256)
         VALUES(?1,?2,?3,?4,?5,'',?6)",
        params![project_id, name, ext, mime, bytes.len() as i64, hash],
    )
    .map_err(map_err)?;
    let id = conn.last_insert_rowid();

    // 资料按项目名归到自己的文件夹：<根目录>/<项目名>/附件/<原文件名>.ext
    // —— 上一版是所有项目混在 assets/ 里、按 <id>.<ext> 命名，
    //    打开文件夹看到一堆 1.png / 2.pdf，根本不知道是哪个项目的。
    let root = project_asset_dir(&conn, &dir, project_id);
    std::fs::create_dir_all(&root).map_err(|e| format!("创建项目文件夹失败：{e}"))?;
    let raw_stem = std::path::Path::new(&name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "文件".to_string());
    let mut file_name = clean_path_name(&raw_stem);
    if file_name.starts_with('.') {
        file_name.insert(0, '_');
    }
    if !ext.is_empty() {
        file_name.push('.');
        file_name.push_str(&ext);
    }
    let path = unique_file_path(&root, &file_name);
    std::fs::write(&path, &bytes).map_err(|e| format!("写入文件失败：{e}"))?;
    let path_s = rel_to_root(&dir, &path);
    conn.execute("UPDATE wb_files SET path=?1 WHERE id=?2", params![path_s, id]).map_err(map_err)?;

    conn.query_row(&format!("{FILE_SELECT} WHERE id=?1"), params![id], row_to_file)
        .map_err(map_err)
}

#[tauri::command]
pub fn list_assets(db: State<Db>, project_id: i64) -> Result<Vec<WbFileOut>, String> {
    let conn = db.0.lock().map_err(map_err)?;
    let mut stmt = conn
        .prepare(&format!("{FILE_SELECT} WHERE project_id=?1 ORDER BY id"))
        .map_err(map_err)?;
    let rows = stmt.query_map(params![project_id], row_to_file).map_err(map_err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(map_err)
}

/// 删除资料：同时清掉白板上引用它的卡片，再删磁盘文件。
#[tauri::command]
pub fn delete_asset(db: State<Db>, dir: State<DataDir>, id: i64) -> Result<(), String> {
    {
        let conn = db.0.lock().map_err(map_err)?;
        conn.execute("DELETE FROM board_notes WHERE file_id=?1", params![id]).map_err(map_err)?;
        prune_orphan_edges(&conn).map_err(map_err)?;
        drop_file(&conn, &dir, id)?;
    }
    Ok(())
}

/// 用系统默认程序打开资料（PDF / Word / 视频都能开）。
#[tauri::command]
pub fn open_asset(db: State<Db>, dir: State<DataDir>, id: i64) -> Result<(), String> {
    let path: String = {
        let conn = db.0.lock().map_err(map_err)?;
        conn.query_row("SELECT path FROM wb_files WHERE id=?1", params![id], |r| r.get(0))
            .map_err(map_err)?
    };
    open_with_system(&abs_of(&dir, &path).to_string_lossy())
}

/// 老结构（一个库装所有项目 + assets/ 混放）→ 新结构（每项目一个文件夹一份库）。
///
/// 只在首次启动新版本时跑一次，幂等：`项目列表.db` 已存在就直接返回。
/// **旧库不删**，改名成「看板数据-拆分前备份.db」留在原处，万一有问题还能捞回来。
pub fn split_legacy_db(root: &std::path::Path) -> Result<(), String> {
    let old = root.join("看板数据.db");
    let global_path = root.join(GLOBAL_DB_NAME);
    if global_path.exists() || !old.exists() {
        return Ok(());
    }
    // 先把 WAL 落进主库，否则拆出来的数据会缺最近几次改动
    if let Ok(c) = Connection::open(&old) {
        let _ = c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }
    let mut split_errs: Vec<String> = Vec::new();
    let mut split_log: Vec<String> = Vec::new();
    let projs: Vec<(i64, String)> = {
        let c = Connection::open(&old).map_err(map_err)?;
        let mut stmt = c
            .prepare("SELECT id, name FROM projects ORDER BY sort_order, id")
            .map_err(map_err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .map_err(map_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(map_err)?
    };

    // 1) 全局库：只装项目清单和偏好
    {
        let g = Connection::open(&global_path).map_err(map_err)?;
        crate::db::init_db(&g).map_err(map_err)?;
        g.execute("ATTACH ?1 AS old", params![old.to_string_lossy().to_string()])
            .map_err(map_err)?;
        g.execute(
            "INSERT OR REPLACE INTO projects(id,name,color,icon,sort_order,created_at)
             SELECT id,name,color,icon,sort_order,created_at FROM old.projects",
            [],
        )
        .map_err(map_err)?;
        g.execute(
            "INSERT OR REPLACE INTO settings(key,value) SELECT key,value FROM old.settings",
            [],
        )
        .map_err(map_err)?;
        let _ = g.execute("DETACH old", []);
    }

    // 2) 逐个项目：建文件夹、建库、搬数据、搬附件、把文档写成 .md
    let mut used: Vec<String> = Vec::new();
    for (id, name) in &projs {
        let base = clean_path_name(name);
        let mut folder = base.clone();
        let mut n = 2;
        while used.iter().any(|f| f == &folder) {
            folder = format!("{base}~{n}");
            n += 1;
        }
        used.push(folder.clone());

        if let Ok(g) = Connection::open(&global_path) {
            let _ = g.execute(
                "UPDATE projects SET folder=?1 WHERE id=?2",
                params![folder, id],
            );
        }

        let pdir = root.join(&folder);
        let pc = open_project_db_at(root, *id, name, &folder)?;
        pc.execute("ATTACH ?1 AS old", params![old.to_string_lossy().to_string()])
            .map_err(map_err)?;
        for sql in [
            "INSERT INTO columns(id,project_id,name,color,wip_limit,sort_order,collapsed)
             SELECT id,project_id,name,color,wip_limit,sort_order,collapsed FROM old.columns WHERE project_id=?1",
            "INSERT INTO tasks(id,project_id,column_id,title,description,priority,due_date,sort_order,created_at,updated_at,completed_at,deleted_at,wx,wy,start_date,progress)
             SELECT id,project_id,column_id,title,description,priority,due_date,sort_order,created_at,updated_at,completed_at,deleted_at,wx,wy,start_date,progress FROM old.tasks WHERE project_id=?1",
            "INSERT INTO tags(id,project_id,name,color) SELECT id,project_id,name,color FROM old.tags WHERE project_id=?1",
            "INSERT INTO task_tags(task_id,tag_id) SELECT tt.task_id,tt.tag_id FROM old.task_tags tt JOIN old.tasks t ON t.id=tt.task_id WHERE t.project_id=?1",
            "INSERT INTO board_notes(id,project_id,x,y,text,color,kind,w,h,file_id,meta)
             SELECT id,project_id,x,y,text,color,kind,w,h,file_id,meta FROM old.board_notes WHERE project_id=?1",
            "INSERT INTO board_edges(id,project_id,from_kind,from_id,to_kind,to_id)
             SELECT id,project_id,from_kind,from_id,to_kind,to_id FROM old.board_edges WHERE project_id=?1",
            "INSERT INTO wb_files(id,project_id,name,ext,mime,size,path,created_at,sha256)
             SELECT id,project_id,name,ext,mime,size,path,created_at,sha256 FROM old.wb_files WHERE project_id=?1",
            "INSERT INTO docs(id,project_id,title,body,sort_order,created_at,updated_at)
             SELECT id,project_id,title,body,sort_order,created_at,updated_at FROM old.docs WHERE project_id=?1",
        ] {
            // ⚠️ 不要静默吞错：某张表搬失败会让这个项目变成空壳，必须留痕
            match pc.execute(sql, params![id]) {
                Ok(n) => {
                    let tag: String = sql.chars().take(28).collect();
                    split_log.push(format!("id={id} {tag} → {n} 行"));
                }
                Err(e) => {
                    split_errs.push(format!("项目 {id} 搬数据失败：{e}"));
                    split_log.push(format!("id={id} ERROR {e}"));
                }
            }
        }
        let _ = pc.execute("DETACH old", []);

        // 附件搬进 <项目>/附件/，文件名还原成上传时的原名
        let files: Vec<(i64, String, String)> = {
            let mut stmt = pc
                .prepare("SELECT id, name, path FROM wb_files")
                .map_err(map_err)?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
                })
                .map_err(map_err)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(map_err)?
        };
        let tmp_dir = DataDir(std::sync::Mutex::new(root.to_path_buf()));
        for (fid, fname, fpath) in files {
            let src = std::path::PathBuf::from(&fpath);
            if !src.exists() {
                continue;
            }
            let dst_dir = pdir.join(ATTACH_DIR);
            // 上个版本已经把它放进 <项目>/附件/ 了 —— 原地不动，
            // 否则会再复制出一份「xxx (2).png」，白占一倍空间。
            if src.parent().map(|p| p == dst_dir.as_path()).unwrap_or(false) {
                let _ = pc.execute(
                    "UPDATE wb_files SET path=?1 WHERE id=?2",
                    params![rel_to_root(&tmp_dir, &src), fid],
                );
                continue;
            }
            let dst = unique_file_path(&dst_dir, &safe_file_name(&fname));
            let ok = std::fs::rename(&src, &dst).is_ok()
                || (std::fs::copy(&src, &dst).is_ok() && std::fs::remove_file(&src).is_ok());
            if ok {
                let _ = pc.execute(
                    "UPDATE wb_files SET path=?1 WHERE id=?2",
                    params![rel_to_root(&tmp_dir, &dst), fid],
                );
            }
        }

        // 文档正文落成 .md 文件
        let docs: Vec<(i64, String, String)> = {
            let mut stmt = pc
                .prepare("SELECT id, title, body FROM docs")
                .map_err(map_err)?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
                })
                .map_err(map_err)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(map_err)?
        };
        let tmp_dir = DataDir(std::sync::Mutex::new(root.to_path_buf()));
        for (did, title, body) in docs {
            if let Ok(p) = sync_doc_file(&pc, &tmp_dir, &title, &body, "") {
                let _ = pc.execute(
                    "UPDATE docs SET path=?1 WHERE id=?2",
                    params![p, did],
                );
            }
        }
    }

    // 3) 旧库改名留档（不删），空的 assets 目录收掉
    let _ = std::fs::write(root.join("拆分日志.txt"), split_log.join("\r\n"));
    if !split_errs.is_empty() {
        let _ = std::fs::write(root.join("拆分错误.txt"), split_errs.join("\r\n"));
    }
    let _ = std::fs::rename(&old, root.join("看板数据-拆分前备份.db"));
    let _ = std::fs::remove_file(root.join("kanban.db"));
    let _ = std::fs::remove_file(root.join("kanban.db-wal"));
    let _ = std::fs::remove_file(root.join("kanban.db-shm"));
    let assets = root.join("assets");
    if std::fs::read_dir(&assets).map(|mut it| it.next().is_none()).unwrap_or(false) {
        let _ = std::fs::remove_dir(&assets);
    }
    Ok(())
}

/// 切到某个项目：打开 `<根>/<项目名>/看板与白板.db` 并替换当前连接。
/// 前端每次 loadProject 之前都会调一次（幂等，重复调用无害）。
#[tauri::command]
pub fn open_project_db(
    global: State<GlobalDb>,
    db: State<Db>,
    dir: State<DataDir>,
    project_id: i64,
) -> Result<(), String> {
    let (raw_folder, name) = {
        let g = global.0.lock().map_err(map_err)?;
        let row = g
            .query_row(
                "SELECT COALESCE(folder,''), name FROM projects WHERE id=?1",
                params![project_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(map_err)?;
        match row {
            Some(x) => x,
            None => return Err("这个项目已经不在了".into()),
        }
    };
    let folder = if raw_folder.trim().is_empty() {
        let f = clean_path_name(&name);
        if let Ok(g) = global.0.lock() {
            let _ = g.execute("UPDATE projects SET folder=?1 WHERE id=?2", params![f, project_id]);
        }
        f
    } else {
        raw_folder
    };
    let pc = open_project_db_at(&dir.root(), project_id, &name, &folder)?;
    // 老数据可能存着绝对路径，切进来时顺手统一成相对
    normalize_asset_paths(&pc, &dir);
    {
        let mut g = db.0.lock().map_err(map_err)?;
        *g = pc;
    }
    // 记住上次打开的项目，下次启动直接回到这里
    if let Ok(g) = global.0.lock() {
        let _ = set_setting(&g, "current_project_id", &project_id.to_string());
    }
    Ok(())
}

/// 数据目录（数据库、上传的资料、日志都放这儿）。
#[tauri::command]
pub fn get_data_dir(dir: State<DataDir>) -> Result<String, String> {
    Ok(dir.root().to_string_lossy().to_string())
}

/// 性能探针：把前端测到的启动耗时/长任务写进 `<数据目录>/perf.log`。
/// 单独开一条命令是因为 `diag_log` 在打包版里写不进 diag.log（原因未明），
/// 排查启动卡顿必须有可靠的落盘通道。
#[tauri::command]
pub fn perf_probe(dir: State<DataDir>, line: String) -> Result<(), String> {
    let p = dir.root().join("perf.log");
    crate::diag::append(&p, &line);
    Ok(())
}

// ---------------- 浮动网页（子 webview，不是 iframe） ----------------
//
// 为什么不用 iframe：豆包、Bing 结果页这类站点会用 CSP `frame-ancestors` /
// `X-Frame-Options` 禁止被第三方嵌入；而且 iframe 里 `target=_blank` 的链接
// 会被拦下后**没有任何反应**——用户看到的就是"点了进不去网站"。
// 子 webview 是独立的内核视图，这两条限制都不存在；`on_new_window` 里再把
// 新窗口请求改成"在当前浮动网页里打开"，点搜索结果就能正常跳转。

fn parse_url(u: &str) -> Result<tauri::Url, String> {
    u.parse::<tauri::Url>().map_err(|_| format!("网址不对：{u}"))
}

/// 打开（或复用）浮动网页视图，并把它摆到 x,y,w,h（CSS 像素 = 逻辑像素）
#[tauri::command]
pub async fn float_web_open(
    app: AppHandle,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let target = parse_url(&url)?;

    if let Some(wv) = app.get_webview("float") {
        // set_bounds 一次把位置和尺寸都设掉：拖动时每秒可能调 60 次，
        // 分两次 set_position + set_size 会明显发沉
        wv.set_bounds(tauri::Rect {
            position: tauri::Position::Logical(LogicalPosition::new(x, y)),
            size: tauri::Size::Logical(LogicalSize::new(w, h)),
        })
        .map_err(map_err)?;
        wv.navigate(target).map_err(map_err)?;
        let _ = wv.show();
        return Ok(());
    }

    let win = app.get_window("main").ok_or("主窗口不存在")?;
    let handle = app.clone();
    let builder = WebviewBuilder::new("float", WebviewUrl::External(target)).on_new_window(
        move |u, _features| {
            // 新窗口请求（target=_blank / window.open）→ 就在当前浮动网页里打开
            if let Some(wv) = handle.get_webview("float") {
                let _ = wv.navigate(u);
            }
            NewWindowResponse::Deny
        },
    );

    win.add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h))
        .map_err(|e| format!("打开浮动网页失败：{e}"))?;
    Ok(())
}

/// 跟随浮动窗拖动/缩放更新位置尺寸（拖动时每帧都会调，务必一次到位）
#[tauri::command]
pub fn float_web_bounds(
    app: AppHandle,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    if let Some(wv) = app.get_webview("float") {
        wv.set_bounds(tauri::Rect {
            position: tauri::Position::Logical(LogicalPosition::new(x, y)),
            size: tauri::Size::Logical(LogicalSize::new(w, h)),
        })
        .map_err(map_err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn float_web_navigate(app: AppHandle, url: String) -> Result<(), String> {
    let target = parse_url(&url)?;
    if let Some(wv) = app.get_webview("float") {
        wv.navigate(target).map_err(map_err)?;
    }
    Ok(())
}

/// 收起浮动窗时子 webview 不会跟着 v-show 消失，必须显式隐藏
#[tauri::command]
pub fn float_web_visible(app: AppHandle, on: bool) -> Result<(), String> {
    if let Some(wv) = app.get_webview("float") {
        let r = if on { wv.show() } else { wv.hide() };
        r.map_err(map_err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn float_web_close(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview("float") {
        let _ = wv.close();
    }
    Ok(())
}

#[tauri::command]
pub fn float_web_set_zoom(app: AppHandle, zoom: f64) -> Result<(), String> {
    if let Some(wv) = app.get_webview("float") {
        wv.set_zoom(zoom).map_err(map_err)?;
    }
    Ok(())
}

/// 前端首帧画好之后把主窗口亮出来（配合 tauri.conf.json 的 visible:false）。
/// 之前窗口一创建就显示，而 JS 还在解析打包产物，用户看到的是
/// 白屏卡一两秒才蹦出内容 —— 现在改成"就绪了再开门"，观感上快很多。
#[tauri::command]
pub fn show_main_window(app: tauri::AppHandle) {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
    if let Some(log) = app.try_state::<crate::diag::LogPath>() {
        crate::diag::append(
            &log.0,
            &format!(
                "[{}] BOOTPERF rust-shown={}ms",
                "boot",
                crate::diag::since_boot_ms()
            ),
        );
    }
}

// ---------- 数据存储：位置、迁移、总览 ----------

/// 记住「数据放在哪里」的指针文件（放在应用默认目录里，跟数据本身分开）
pub const POINTER_FILE: &str = "数据位置.txt";
/// 上次指定的位置打不开时留个记号，下次启动在界面上告诉用户
pub const POINTER_MISSING: &str = "数据位置.失效.txt";

fn dir_size(p: &std::path::Path) -> u64 {
    let mut total = 0u64;
    let Ok(rd) = std::fs::read_dir(p) else { return 0 };
    for e in rd.flatten() {
        let path = e.path();
        match std::fs::metadata(&path) {
            Ok(m) if m.is_dir() => total += dir_size(&path),
            Ok(m) => total += m.len(),
            Err(_) => {}
        }
    }
    total
}

fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for e in std::fs::read_dir(src)? {
        let e = e?;
        let ty = e.file_type()?;
        let to = dst.join(e.file_name());
        if ty.is_dir() {
            copy_dir_all(&e.path(), &to)?;
        } else if ty.is_file() {
            std::fs::copy(e.path(), &to)?;
        }
    }
    Ok(())
}

/// 文件名的安全版：保留扩展名，只清理主干
pub fn safe_file_name(name: &str) -> String {
    let p = std::path::Path::new(name);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "文件".to_string());
    let ext = p.extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let mut out = clean_path_name(&stem);
    if out.starts_with('.') {
        out.insert(0, '_');
    }
    if !ext.is_empty() {
        out.push('.');
        out.push_str(&clean_path_name(&ext));
    }
    out
}

/// 把老版本 `assets/1.png` 这种混在一起的附件，搬回各自的
/// `<项目名>/附件/<原文件名>`。启动时跑一次，幂等。
pub fn organize_legacy_assets(conn: &Connection, dir: &DataDir) {
    let legacy = assets_root(dir);
    if !legacy.exists() {
        return;
    }
    let legacy_s = legacy.to_string_lossy().to_string();
    // 路径分隔符可能一个正斜杠一个反斜杠（用户手填过目录），比较前统一
    let legacy_norm = legacy_s.replace('\\', "/");
    let rows: Vec<(i64, i64, String, String)> = {
        let Ok(mut stmt) = conn.prepare("SELECT id, project_id, name, path FROM wb_files") else {
            return;
        };
        let collected = match stmt.query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))
        }) {
            Ok(it) => it.flatten().collect::<Vec<_>>(),
            Err(_) => return,
        };
        collected
    };
    for (_id, pid, name, path) in rows {
        if path.is_empty() || !path.replace('\\', "/").starts_with(&legacy_norm) {
            continue;
        }
        let src = std::path::PathBuf::from(&path);
        if !src.exists() {
            continue;
        }
        let dst_dir = project_asset_dir(conn, dir, pid);
        if std::fs::create_dir_all(&dst_dir).is_err() {
            continue;
        }
        let dst = unique_file_path(&dst_dir, &safe_file_name(&name));
        let ok = std::fs::rename(&src, &dst).is_ok()
            || (std::fs::copy(&src, &dst).is_ok() && std::fs::remove_file(&src).is_ok());
        if !ok {
            continue;
        }
        let _ = conn.execute(
            "UPDATE wb_files SET path=?1 WHERE id=?2",
            params![dst.to_string_lossy().to_string(), _id],
        );
    }
    // assets 空了就顺手删掉，别在那儿留个空文件夹让人误会
    if std::fs::read_dir(&legacy).map(|mut it| it.next().is_none()).unwrap_or(false) {
        let _ = std::fs::remove_dir(&legacy);
    }
}

#[derive(Serialize)]
pub struct ProjectStat {
    pub id: i64,
    pub name: String,
    pub folder: String,
    pub tasks: i64,
    pub done: i64,
    pub notes: i64,
    pub docs: i64,
    pub files: i64,
    pub bytes: u64,
}

#[derive(Serialize)]
pub struct DataOverview {
    pub path: String,
    pub db_file: String,
    pub db_bytes: u64,
    pub is_default: bool,
    pub default_path: String,
    pub pending: Option<String>,
    pub projects: Vec<ProjectStat>,
    pub total_bytes: u64,
}

fn app_default_root(app: &tauri::AppHandle) -> std::path::PathBuf {
    use tauri::Manager;
    app.path().app_data_dir().unwrap_or_default()
}

/// 数据存储总览：位置、数据库大小、每个项目占了多少、有哪些附件。
#[tauri::command]
pub fn data_overview(
    app: tauri::AppHandle,
    global: State<GlobalDb>,
    dir: State<DataDir>,
) -> Result<DataOverview, String> {
    let root = dir.root();
    let default_root = app_default_root(&app);
    let pending = {
        let f = default_root.join(POINTER_MISSING);
        std::fs::read_to_string(&f)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let projs: Vec<(i64, String, String)> = {
        let g = global.0.lock().map_err(map_err)?;
        let mut stmt = g
            .prepare("SELECT id, name, COALESCE(folder,'') FROM projects ORDER BY sort_order, id")
            .map_err(map_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
            })
            .map_err(map_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(map_err)?
    };

    let mut projects = Vec::new();
    let mut total_bytes = 0u64;
    for (id, name, folder) in projs {
        let f = if folder.trim().is_empty() { clean_path_name(&name) } else { folder };
        let pdir = root.join(&f);
        // 每个项目库单独打开只读统计（项目数不多，代价很小）
        let (mut tasks, mut done, mut notes, mut docs, mut files) = (0i64, 0i64, 0i64, 0i64, 0i64);
        if let Ok(c) = Connection::open(pdir.join(PROJECT_DB_NAME)) {
            let count = |sql: &str| -> i64 { c.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0) };
            tasks = count("SELECT COUNT(*) FROM tasks WHERE deleted_at IS NULL");
            done = count(
                "SELECT COUNT(*) FROM tasks WHERE deleted_at IS NULL AND completed_at IS NOT NULL",
            );
            notes = count("SELECT COUNT(*) FROM board_notes");
            docs = count("SELECT COUNT(*) FROM docs");
            files = count("SELECT COUNT(*) FROM wb_files");
        }
        let bytes = dir_size(&pdir);
        total_bytes += bytes;
        projects.push(ProjectStat {
            id,
            name,
            folder: pdir.to_string_lossy().to_string(),
            tasks,
            done,
            notes,
            docs,
            files,
            bytes,
        });
    }
    let db_file = root.join(GLOBAL_DB_NAME);
    let db_size = std::fs::metadata(&db_file).map(|m| m.len()).unwrap_or(0);
    total_bytes += db_size;

    Ok(DataOverview {
        path: root.to_string_lossy().to_string(),
        db_file: db_file.to_string_lossy().to_string(),
        db_bytes: db_size,
        is_default: root == default_root,
        default_path: default_root.to_string_lossy().to_string(),
        pending,
        projects,
        total_bytes,
    })
}

/// 打开某个项目自己的数据文件夹（库、附件、文档都在这儿）
#[tauri::command]
pub fn open_project_dir(
    global: State<GlobalDb>,
    dir: State<DataDir>,
    project_id: i64,
) -> Result<(), String> {
    let path = {
        let g = global.0.lock().map_err(map_err)?;
        let (name, folder) = g
            .query_row(
                "SELECT name, COALESCE(folder,'') FROM projects WHERE id=?1",
                params![project_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(map_err)?
            .ok_or_else(|| "项目不存在".to_string())?;
        let f = if folder.trim().is_empty() { clean_path_name(&name) } else { folder };
        dir.root().join(f)
    };
    std::fs::create_dir_all(&path).map_err(map_err)?;
    open_with_system(&path.to_string_lossy().to_string())
}

/// 弹出系统的「选择文件夹」对话框（Windows 用 PowerShell 调系统控件，
/// 不额外引依赖/不增加安装包体积）。取消时返回 None。
#[tauri::command]
pub fn pick_folder() -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let script = r#"Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '选择一个文件夹，用来保存看板数据（项目、任务、白板、附件）'; $d.ShowNewFolderButton = $true; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }"#;
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-STA", "-Command", script])
            .creation_flags(0x0800_0000)
            .output()
            .map_err(|e| format!("打不开文件夹选择框：{e}"))?;
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() {
            return Ok(None);
        }
        return Ok(Some(s));
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("当前系统暂不支持图形选择，请手动填写完整路径".into())
    }
}

#[derive(Serialize)]
pub struct MigrateReport {
    pub from: String,
    pub to: String,
    pub db_bytes: u64,
    pub folder_bytes: u64,
    pub folders: i64,
    pub leftover: String,
}

pub struct MigrateStat {
    pub db_bytes: u64,
    pub folder_bytes: u64,
    pub folders: i64,
}

/// 把一个数据目录里的全部内容搬到另一个目录：
/// ① 项目文件夹整体复制 ② 数据库用 `VACUUM INTO` 取一份一致的快照
/// （WAL 里还没落盘的改动也会进去）③ 在新库里把附件的绝对路径改到新位置。
///
/// 全程**不改源目录、不改当前连接**，所以中途失败重来就行。
pub fn migrate_to(
    conn: &Connection,
    from: &std::path::Path,
    to: &std::path::Path,
) -> Result<MigrateStat, String> {
    let mut folders = 0i64;
    let mut folder_bytes = 0u64;
    // 1) 搬项目文件夹（每个项目的附件）
    if let Ok(rd) = std::fs::read_dir(from) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if name == "assets" {
                continue; // 旧附件目录，启动时已经整理过；剩下的不是数据
            }
            let dst = to.join(&name);
            if dst.exists() {
                continue;
            }
            if copy_dir_all(&p, &dst).is_ok() {
                folders += 1;
                folder_bytes += dir_size(&dst);
            }
        }
    }
    // 2) 全局库（项目清单 + 偏好）取一份一致的快照
    let target_db = to.join(GLOBAL_DB_NAME);
    if target_db.exists() {
        let _ = std::fs::remove_file(&target_db);
    }
    conn.execute("VACUUM INTO ?1", params![target_db.to_string_lossy().to_string()])
        .map_err(|e| format!("复制数据库失败：{e}"))?;
    let db_bytes = std::fs::metadata(&target_db).map(|m| m.len()).unwrap_or(0);
    // 3) 项目库里如果还有老的绝对路径，统一转成相对路径
    //    （相对路径天然可移植，搬完之后不用改任何东西）
    let src_dir = DataDir(std::sync::Mutex::new(from.to_path_buf()));
    if let Ok(rd) = std::fs::read_dir(to) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let pdb = p.join(PROJECT_DB_NAME);
            if !pdb.exists() {
                continue;
            }
            if let Ok(c) = Connection::open(&pdb) {
                normalize_asset_paths(&c, &src_dir);
            }
        }
    }
    Ok(MigrateStat { db_bytes, folder_bytes, folders })
}

/// 换一个文件夹保存数据：把现有数据**整体搬过去**再切过去用。
/// 旧位置的东西不删（用户确认没问题了自己删），避免"搬一半出错全没了"。
#[tauri::command]
pub fn change_data_dir(
    app: tauri::AppHandle,
    global: State<GlobalDb>,
    db: State<Db>,
    dir: State<DataDir>,
    new_root: String,
) -> Result<MigrateReport, String> {
    let from = dir.root();
    let to = normalize_dir(&new_root);
    if to.as_os_str().is_empty() {
        return Err("没有选择文件夹".into());
    }
    if !to.is_absolute() {
        return Err("请填完整路径，比如 D:\\看板数据".into());
    }
    let from_s = from.to_string_lossy().to_lowercase();
    let to_s = to.to_string_lossy().to_lowercase();
    if from_s == to_s {
        return Err("这就是当前的位置，不用换".into());
    }
    if to.starts_with(&from) {
        return Err("不能选当前数据文件夹里面的子文件夹，换一个地方".into());
    }
    if from.starts_with(&to) {
        return Err("别选当前数据文件夹的上一层，数据会和别的文件混在一起；新建一个专门放数据的文件夹".into());
    }
    std::fs::create_dir_all(&to).map_err(|e| format!("这个文件夹打不开：{e}"))?;
    let probe = to.join(".kanban-write-test");
    std::fs::write(&probe, b"ok").map_err(|e| format!("这个文件夹没有写入权限：{e}"))?;
    let _ = std::fs::remove_file(&probe);
    if to.join(GLOBAL_DB_NAME).exists() || to.join(DB_NAME).exists() {
        return Err("这个文件夹里已经有一份看板数据了，换个空文件夹，免得覆盖".into());
    }

    // 记下当前项目（id / 名字 / 文件夹），搬完要重新打开它
    let cur: Option<(i64, String, String)> = {
        let d = db.0.lock().map_err(map_err)?;
        let folder = get_setting(&d, "folder").ok().flatten();
        let name = get_setting(&d, "project_name").ok().flatten();
        let id: Option<i64> = d
            .query_row("SELECT id FROM projects LIMIT 1", [], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        match (id, name, folder) {
            (Some(i), Some(n), Some(f)) if !f.trim().is_empty() => Some((i, n, f)),
            _ => None,
        }
    };
    let stat = {
        let g = global.0.lock().map_err(map_err)?;
        migrate_to(&g, &from, &to)?
    };
    // 4) 切到新位置
    let new_global = Connection::open(to.join(GLOBAL_DB_NAME))
        .map_err(|e| format!("切换到新位置失败：{e}"))?;
    crate::db::init_db(&new_global).map_err(map_err)?;
    {
        let mut g = global.0.lock().map_err(map_err)?;
        *g = new_global;
    }
    {
        let mut g = dir.0.lock().map_err(map_err)?;
        *g = to.clone();
    }
    if let Some((pid, pname, folder)) = cur {
        if let Ok(pc) = open_project_db_at(&to, pid, &pname, &folder) {
            let mut d = db.0.lock().map_err(map_err)?;
            *d = pc;
        }
    }
    // 5) 记下新位置，下次启动直接用它
    let default_root = app_default_root(&app);
    let _ = std::fs::create_dir_all(&default_root);
    let _ = std::fs::write(default_root.join(POINTER_FILE), to.to_string_lossy().as_bytes());
    let _ = std::fs::remove_file(default_root.join(POINTER_MISSING));

    Ok(MigrateReport {
        from: from.to_string_lossy().to_string(),
        to: to.to_string_lossy().to_string(),
        db_bytes: stat.db_bytes,
        folder_bytes: stat.folder_bytes,
        folders: stat.folders,
        leftover: from.to_string_lossy().to_string(),
    })
}

/// 在文件资源管理器里打开数据目录，方便用户自己备份。
#[tauri::command]
pub fn open_data_dir(dir: State<DataDir>) -> Result<(), String> {
    let root = dir.root();
    std::fs::create_dir_all(&root).map_err(map_err)?;
    let path = root.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .arg(&path)
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(map_err)?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        open_with_system(&path)?;
    }
    Ok(())
}

/// 在资源管理器中定位该资料。
#[tauri::command]
pub fn reveal_asset(db: State<Db>, dir: State<DataDir>, id: i64) -> Result<(), String> {
    let path: String = {
        let conn = db.0.lock().map_err(map_err)?;
        conn.query_row("SELECT path FROM wb_files WHERE id=?1", params![id], |r| r.get(0))
            .map_err(map_err)?
    };
    let path = abs_of(&dir, &path).to_string_lossy().to_string();
    if !std::path::Path::new(&path).exists() {
        return Err("文件不存在（可能已被移动或删除）".into());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .arg(format!("/select,{path}"))
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(map_err)?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        open_with_system(&parent)?;
    }
    Ok(())
}

/// 读成 data URL，供白板直接预览图片 / PDF。
#[tauri::command]
pub fn read_asset_data_url(db: State<Db>, dir: State<DataDir>, id: i64) -> Result<String, String> {
    let (path, mime): (String, String) = {
        let conn = db.0.lock().map_err(map_err)?;
        conn.query_row("SELECT path,mime FROM wb_files WHERE id=?1", params![id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map_err(map_err)?
    };
    let bytes =
        std::fs::read(abs_of(&dir, &path)).map_err(|e| format!("读取文件失败：{e}"))?;
    let mime = if mime.trim().is_empty() { "application/octet-stream".to_string() } else { mime };
    Ok(format!("data:{mime};base64,{}", b64_encode(&bytes)))
}

// ---------- 写作模块：Markdown 文档 ----------

#[derive(Serialize)]
pub struct DocOut {
    pub id: i64,
    pub project_id: i64,
    pub title: String,
    pub body: String,
    pub sort_order: f64,
    pub created_at: String,
    pub updated_at: String,
}

const DOC_SELECT: &str =
    "SELECT id,project_id,title,body,sort_order,created_at,updated_at FROM docs";

fn row_to_doc(r: &Row) -> rusqlite::Result<DocOut> {
    Ok(DocOut {
        id: r.get(0)?,
        project_id: r.get(1)?,
        title: r.get(2)?,
        body: r.get(3)?,
        sort_order: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
    })
}

/// 文档正文落在项目文件夹的「文档」子目录里，是**真正的 .md 文件**：
/// 想用 Typora / VS Code 打开、想直接发给同事、想进 Git 都行。
fn doc_dir(conn: &Connection, dir: &DataDir) -> std::path::PathBuf {
    project_dir(conn, dir, 0).join(DOC_DIR)
}

fn doc_path_of(conn: &Connection, id: i64) -> String {
    conn.query_row("SELECT COALESCE(path,'') FROM docs WHERE id=?1", params![id], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// 把正文写进 .md 文件并返回路径。改了标题就顺手换文件名（旧文件删掉）。
fn sync_doc_file(
    conn: &Connection,
    dir: &DataDir,
    title: &str,
    body: &str,
    old_path: &str,
) -> Result<String, String> {
    let base = doc_dir(conn, dir);
    std::fs::create_dir_all(&base).map_err(|e| format!("建「文档」文件夹失败：{e}"))?;
    let fname = format!("{}.md", clean_path_name(title));
    // 注意：库里存的是相对路径，比较/删除前都要先还原成绝对路径
    let old_abs = if old_path.trim().is_empty() {
        None
    } else {
        Some(abs_of(dir, old_path))
    };
    let mut target = base.join(&fname);
    if target.exists() {
        let same = old_abs.as_ref().map(|o| o == &target).unwrap_or(false);
        if !same {
            target = unique_file_path(&base, &fname);
        }
    }
    std::fs::write(&target, body).map_err(|e| format!("写文档失败：{e}"))?;
    if let Some(old) = old_abs {
        if old != target && old.exists() {
            let _ = std::fs::remove_file(&old);
        }
    }
    // 库里存相对路径，整个数据文件夹才能随便挪
    Ok(rel_to_root(dir, &target))
}

#[tauri::command]
pub fn list_docs(
    db: State<Db>,
    dir: State<DataDir>,
    project_id: i64,
) -> Result<Vec<DocOut>, String> {
    let conn = db.0.lock().map_err(map_err)?;
    let mut docs: Vec<DocOut> = {
        let mut stmt = conn
            .prepare(&format!("{DOC_SELECT} WHERE project_id=?1 ORDER BY sort_order, id"))
            .map_err(map_err)?;
        let rows = stmt.query_map(params![project_id], row_to_doc).map_err(map_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(map_err)?
    };
    // 正文以 .md 文件为准；还没有文件的（老数据）顺手补一份出来
    for d in docs.iter_mut() {
        let p = doc_path_of(&conn, d.id);
        if !p.is_empty() {
            if let Ok(s) = std::fs::read_to_string(abs_of(&dir, &p)) {
                d.body = s;
                continue;
            }
        }
        if let Ok(np) = sync_doc_file(&conn, &dir, &d.title, &d.body, &p) {
            let _ = conn.execute("UPDATE docs SET path=?1 WHERE id=?2", params![np, d.id]);
        }
    }
    Ok(docs)
}

#[tauri::command]
pub fn create_doc(
    db: State<Db>,
    dir: State<DataDir>,
    project_id: i64,
    title: Option<String>,
    body: Option<String>,
) -> Result<i64, String> {
    let conn = db.0.lock().map_err(map_err)?;
    let order = next_order(&conn, "docs", "sort_order", Some(("project_id", project_id)))?;
    let t = title.unwrap_or_else(|| "未命名文档".into());
    let b = body.unwrap_or_default();
    conn.execute(
        "INSERT INTO docs(project_id,title,body,sort_order) VALUES(?1,?2,?3,?4)",
        params![project_id, t, b, order],
    )
    .map_err(map_err)?;
    let id = conn.last_insert_rowid();
    if let Ok(p) = sync_doc_file(&conn, &dir, &t, &b, "") {
        let _ = conn.execute("UPDATE docs SET path=?1 WHERE id=?2", params![p, id]);
    }
    Ok(id)
}

#[derive(Deserialize)]
pub struct DocPatch {
    pub title: Option<String>,
    pub body: Option<String>,
    pub sort_order: Option<f64>,
}

#[tauri::command]
pub fn update_doc(
    db: State<Db>,
    dir: State<DataDir>,
    id: i64,
    patch: DocPatch,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(map_err)?;
    let old_path = doc_path_of(&conn, id);
    let mut title: String =
        conn.query_row("SELECT title FROM docs WHERE id=?1", params![id], |r| r.get(0))
            .unwrap_or_default();
    // 正文优先从文件读（用户可能在别处改过），没有文件再回落到库里的缓存
    let mut body: String = if !old_path.is_empty() {
        std::fs::read_to_string(abs_of(&dir, &old_path)).unwrap_or_else(|_| {
            conn.query_row("SELECT body FROM docs WHERE id=?1", params![id], |r| r.get(0))
                .unwrap_or_default()
        })
    } else {
        conn.query_row("SELECT body FROM docs WHERE id=?1", params![id], |r| r.get(0))
            .unwrap_or_default()
    };
    if let Some(t) = patch.title.clone() {
        title = t;
    }
    if let Some(b) = patch.body.clone() {
        body = b;
    }
    if patch.title.is_some() || patch.body.is_some() {
        let np = sync_doc_file(&conn, &dir, &title, &body, &old_path)?;
        conn.execute(
            "UPDATE docs SET title=?1, body=?2, path=?3 WHERE id=?4",
            params![title, body, np, id],
        )
        .map_err(map_err)?;
    }
    if let Some(s) = patch.sort_order {
        conn.execute("UPDATE docs SET sort_order=?1 WHERE id=?2", params![s, id])
            .map_err(map_err)?;
    }
    conn.execute(
        "UPDATE docs SET updated_at=datetime('now','localtime') WHERE id=?1",
        params![id],
    )
    .map_err(map_err)?;
    Ok(())
}

#[tauri::command]
pub fn delete_doc(db: State<Db>, dir: State<DataDir>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(map_err)?;
    let p = doc_path_of(&conn, id);
    conn.execute("DELETE FROM docs WHERE id=?1", params![id])
        .map_err(map_err)?;
    if !p.is_empty() {
        let _ = std::fs::remove_file(abs_of(&dir, &p));
    }
    Ok(())
}

/// 按内容指纹找同一份资料 —— 用来避免"同一个文件传两次占两份空间"。
#[tauri::command]
pub fn find_asset_by_hash(
    db: State<Db>,
    project_id: i64,
    sha256: String,
) -> Result<Option<WbFileOut>, String> {
    if sha256.trim().is_empty() {
        return Ok(None);
    }
    let conn = db.0.lock().map_err(map_err)?;
    conn.query_row(
        &format!("{FILE_SELECT} WHERE project_id=?1 AND sha256=?2 LIMIT 1"),
        params![project_id, sha256],
        row_to_file,
    )
    .optional()
    .map_err(map_err)
}

// ============================================================================
// 数据存储：单元测试
// 拆分 / 迁移是"动用户全部数据"的操作，必须能验证，不能只靠手点。
// ============================================================================
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_dir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("kb-test-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// 造一份"老结构"的数据：一个库装项目 + 附件散在 assets/
    fn make_legacy(root: &std::path::Path) -> Connection {
        let old = root.join("看板数据.db");
        let c = Connection::open(&old).unwrap();
        crate::db::init_db(&c).unwrap();
        c.execute(
            "INSERT INTO projects(name,color,icon,sort_order) VALUES('室内2404 毕业设计','#409EFF','F',1000)",
            [],
        )
        .unwrap();
        let pid = c.last_insert_rowid();
        c.execute("INSERT INTO columns(project_id,name) VALUES(?1,'待办')", params![pid])
            .unwrap();
        let cid = c.last_insert_rowid();
        c.execute(
            "INSERT INTO tasks(project_id,column_id,title) VALUES(?1,?2,'出图')",
            params![pid, cid],
        )
        .unwrap();
        c.execute(
            "INSERT INTO board_notes(project_id,x,y,text) VALUES(?1,10,20,'便签')",
            params![pid],
        )
        .unwrap();
        c.execute(
            "INSERT INTO docs(project_id,title,body) VALUES(?1,'设计说明','# 标题\n正文')",
            params![pid],
        )
        .unwrap();
        std::fs::create_dir_all(root.join("assets")).unwrap();
        let f = root.join("assets").join("7.png");
        std::fs::write(&f, b"png").unwrap();
        c.execute(
            "INSERT INTO wb_files(project_id,name,ext,path) VALUES(?1,'客厅效果图.png','png',?2)",
            params![pid, f.to_string_lossy().to_string()],
        )
        .unwrap();
        // 第二个项目：只有列和一个便签（验证"多项目"都能拆出来，不会只拆第一个）
        c.execute(
            "INSERT INTO projects(name,color,icon,sort_order) VALUES('第二个项目','#67C23A','F',2000)",
            [],
        )
        .unwrap();
        let pid2 = c.last_insert_rowid();
        c.execute("INSERT INTO columns(project_id,name) VALUES(?1,'待办')", params![pid2])
            .unwrap();
        c.execute(
            "INSERT INTO board_notes(project_id,x,y,text) VALUES(?1,1,2,'第二')",
            params![pid2],
        )
        .unwrap();
        c
    }

    #[test]
    fn split_legacy_db_creates_one_folder_per_project() {
        let root = tmp_dir("split");
        drop(make_legacy(&root)); // 关掉连接，WAL 才会正常落盘

        split_legacy_db(&root).unwrap();

        // 全局库：项目清单
        assert!(root.join(GLOBAL_DB_NAME).exists(), "应该有项目列表.db");
        let g = Connection::open(root.join(GLOBAL_DB_NAME)).unwrap();
        let (name, folder): (String, String) = g
            .query_row("SELECT name, COALESCE(folder,'') FROM projects", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(name, "室内2404 毕业设计");
        assert_eq!(folder, "室内2404 毕业设计", "文件夹名就是项目名");

        // 项目文件夹 + 它自己的库
        let pdir = root.join(&folder);
        assert!(pdir.join(PROJECT_DB_NAME).exists(), "应该有 看板与白板.db");
        let pc = Connection::open(pdir.join(PROJECT_DB_NAME)).unwrap();
        let tasks: i64 = pc.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0)).unwrap();
        let notes: i64 = pc.query_row("SELECT COUNT(*) FROM board_notes", [], |r| r.get(0)).unwrap();
        assert_eq!((tasks, notes), (1, 1), "看板和白板数据都要搬过来");

        // 附件：原名 + 落在「附件」目录
        let (fname, fpath): (String, String) = pc
            .query_row("SELECT name, path FROM wb_files", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(fname, "客厅效果图.png");
        assert!(fpath.ends_with("客厅效果图.png"), "文件名要还原成原名：{fpath}");
        assert!(!std::path::Path::new(&fpath).is_absolute(), "库里要存相对路径：{fpath}");
        assert!(root.join(&fpath).exists(), "附件要真的搬过去：{fpath}");
        assert!(fpath.contains(ATTACH_DIR), "要落在「附件」目录里：{fpath}");

        // 文档：正文变成 .md 真文件
        let (dpath, body): (String, String) = pc
            .query_row("SELECT COALESCE(path,''), body FROM docs", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert!(dpath.ends_with("设计说明.md"), "文档要落成 md：{dpath}");
        assert!(!std::path::Path::new(&dpath).is_absolute(), "文档路径也要相对");
        assert_eq!(std::fs::read_to_string(root.join(&dpath)).unwrap(), body, "文件内容要和库里一致");

        // 旧库改名留档，空 assets 收掉
        assert!(root.join("看板数据-拆分前备份.db").exists(), "旧库要留一份");
        assert!(!root.join("assets").exists(), "搬空的 assets 应该删掉");

        // 第二个项目也要有自己完整的库（不是空壳）
        let p2 = Connection::open(root.join("第二个项目").join(PROJECT_DB_NAME)).unwrap();
        let n2: i64 = p2.query_row("SELECT COUNT(*) FROM board_notes", [], |r| r.get(0)).unwrap();
        let c2: i64 = p2.query_row("SELECT COUNT(*) FROM columns", [], |r| r.get(0)).unwrap();
        assert_eq!((n2, c2), (1, 1), "第二个项目的数据也要搬过来");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migrate_to_copies_project_folders_and_rewrites_paths() {
        let root = tmp_dir("migrate2");
        let from = root.join("源");
        let to = root.join("目标");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::create_dir_all(&to).unwrap();

        // 新结构的源：项目列表.db + 一个项目文件夹
        let g = Connection::open(from.join(GLOBAL_DB_NAME)).unwrap();
        crate::db::init_db(&g).unwrap();
        g.execute("INSERT INTO projects(name,folder) VALUES('甲项目','甲项目')", [])
            .unwrap();
        let pdir = from.join("甲项目");
        std::fs::create_dir_all(pdir.join(ATTACH_DIR)).unwrap();
        let pc = Connection::open(pdir.join(PROJECT_DB_NAME)).unwrap();
        crate::db::init_db(&pc).unwrap();
        pc.execute("INSERT INTO projects(id,name,folder) VALUES(1,'甲项目','甲项目')", [])
            .unwrap();
        let f = pdir.join(ATTACH_DIR).join("平面.png");
        std::fs::write(&f, b"x").unwrap();
        pc.execute(
            "INSERT INTO wb_files(project_id,name,ext,path) VALUES(1,'平面.png','png',?1)",
            params![f.to_string_lossy().to_string()],
        )
        .unwrap();
        drop(pc);

        let stat = migrate_to(&g, &from, &to).unwrap();
        assert_eq!(stat.folders, 1, "应该搬走一个项目文件夹");
        assert!(to.join(GLOBAL_DB_NAME).exists());
        assert!(to.join("甲项目").join(PROJECT_DB_NAME).exists());
        assert!(to.join("甲项目").join(ATTACH_DIR).join("平面.png").exists());

        let nc = Connection::open(to.join("甲项目").join(PROJECT_DB_NAME)).unwrap();
        let p: String = nc.query_row("SELECT path FROM wb_files", [], |r| r.get(0)).unwrap();
        assert!(!std::path::Path::new(&p).is_absolute(), "相对路径不用改，文件夹挪到哪都能用：{p}");
        assert!(to.join(&p).exists(), "新位置要有这个文件：{p}");
        // 源目录原封不动
        assert!(from.join("甲项目").join(ATTACH_DIR).join("平面.png").exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn doc_file_is_renamed_with_title() {
        let root = tmp_dir("doc");
        let dir = DataDir(std::sync::Mutex::new(root.clone()));
        let conn = Connection::open(root.join(GLOBAL_DB_NAME)).unwrap();
        crate::db::init_db(&conn).unwrap();
        set_setting(&conn, "folder", "甲项目").unwrap();
        let p1 = sync_doc_file(&conn, &dir, "初稿", "hello", "").unwrap();
        assert!(p1.ends_with("初稿.md"), "{p1}");
        let p2 = sync_doc_file(&conn, &dir, "终稿", "hello2", &p1).unwrap();
        assert!(p2.ends_with("终稿.md"), "{p2}");
        assert!(!root.join(&p1).exists(), "改名后旧文件要收掉");
        assert_eq!(std::fs::read_to_string(root.join(&p2)).unwrap(), "hello2");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn folder_name_is_safe_and_comes_from_settings() {
        let root = tmp_dir("folder");
        let conn = Connection::open(root.join(GLOBAL_DB_NAME)).unwrap();
        crate::db::init_db(&conn).unwrap();
        set_setting(&conn, "project_name", "a/b:c*? 项目").unwrap();
        let f = project_folder_name(&conn, 1);
        assert!(!f.contains('/') && !f.contains(':') && !f.contains('*'), "不能带非法字符：{f}");
        set_setting(&conn, "folder", "已经算好的名字").unwrap();
        assert_eq!(project_folder_name(&conn, 1), "已经算好的名字");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn project_library_has_its_own_mirror_row() {
        // 项目库里必须有 projects 那一行，否则带外键的 insert 全都会失败
        let root = tmp_dir("mirror");
        let c = open_project_db_at(&root, 42, "乙项目", "乙项目").unwrap();
        let id: i64 = c.query_row("SELECT id FROM projects", [], |r| r.get(0)).unwrap();
        assert_eq!(id, 42);
        c.execute(
            "INSERT INTO columns(project_id,name) VALUES(42,'待办')",
            [],
        )
        .expect("有镜像行之后插列才不违反外键");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reopening_a_project_keeps_its_data() {
        // 回归：曾经用 INSERT OR REPLACE 写镜像行 → REPLACE 先 DELETE，
        // 外键 ON DELETE CASCADE 会把刚搬进去的数据整份删光（切项目就清库）。
        let root = tmp_dir("reopen");
        {
            let c = open_project_db_at(&root, 7, "丙项目", "丙项目").unwrap();
            c.execute("INSERT INTO columns(project_id,name) VALUES(7,'待办')", []).unwrap();
            c.execute("INSERT INTO board_notes(project_id,x,y,text) VALUES(7,0,0,'便签')", [])
                .unwrap();
        }
        // 再开一次（切项目、重启都会走这里）
        let c = open_project_db_at(&root, 7, "丙项目", "丙项目").unwrap();
        let cols: i64 = c.query_row("SELECT COUNT(*) FROM columns", [], |r| r.get(0)).unwrap();
        let notes: i64 = c.query_row("SELECT COUNT(*) FROM board_notes", [], |r| r.get(0)).unwrap();
        assert_eq!((cols, notes), (1, 1), "重复打开项目库不能把数据删掉");
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---------- P0 数据层 ----------

    fn cols_of(conn: &Connection, table: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap();
        rows.collect::<Result<Vec<_>, _>>().unwrap()
    }

    fn task_seqs(conn: &Connection) -> Vec<i64> {
        let mut stmt = conn
            .prepare("SELECT seq FROM tasks ORDER BY seq")
            .unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, i64>(0)).unwrap();
        rows.collect::<Result<Vec<_>, _>>().unwrap()
    }

    /// 迁移可以在同一个库上反复跑，且新表新列都在。
    #[test]
    fn migration_is_idempotent_and_adds_columns() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_db(&conn).unwrap();
        crate::db::init_db(&conn).unwrap();

        let tcols = cols_of(&conn, "tasks");
        assert!(tcols.iter().any(|c| c == "seq"), "tasks 缺 seq");

        let ncols = cols_of(&conn, "board_notes");
        assert!(ncols.iter().any(|c| c == "role"), "board_notes 缺 role");
        assert!(
            ncols.iter().any(|c| c == "group_kind"),
            "board_notes 缺 group_kind"
        );

        let ecols = cols_of(&conn, "board_edges");
        assert!(ecols.iter().any(|c| c == "kind"), "board_edges 缺 kind");
        assert!(
            ecols.iter().any(|c| c == "strength"),
            "board_edges 缺 strength"
        );

        // 老数据（没写 kind）读出来应落到 decompose
        conn.execute("INSERT INTO projects(name) VALUES('p')", []).unwrap();
        let pid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO board_edges(project_id,from_kind,from_id,to_kind,to_id)
             VALUES(?1,'task',1,'note',2)",
            params![pid],
        )
        .unwrap();
        let kind: String = conn
            .query_row("SELECT kind FROM board_edges LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kind, "decompose");
    }

    /// 补号只补没号的，从已有最大值往后接；反复调用不变。
    #[test]
    fn task_seq_backfill_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_db(&conn).unwrap();
        conn.execute("INSERT INTO projects(name) VALUES('p')", []).unwrap();
        let pid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO columns(project_id,name,sort_order) VALUES(?1,'待办',0)",
            params![pid],
        )
        .unwrap();
        let cid = conn.last_insert_rowid();
        for t in ["甲", "乙", "丙"] {
            conn.execute(
                "INSERT INTO tasks(project_id,column_id,title) VALUES(?1,?2,?3)",
                params![pid, cid, t],
            )
            .unwrap();
        }

        backfill_task_seq(&conn).unwrap();
        assert_eq!(task_seqs(&conn), vec![1, 2, 3]);

        // 再跑一次：没有待补的行，结果不变
        backfill_task_seq(&conn).unwrap();
        assert_eq!(task_seqs(&conn), vec![1, 2, 3]);

        // 后来又多了一条没号的（老客户端写入），新号接在 4
        conn.execute(
            "INSERT INTO tasks(project_id,column_id,title) VALUES(?1,?2,'丁')",
            params![pid, cid],
        )
        .unwrap();
        backfill_task_seq(&conn).unwrap();
        assert_eq!(task_seqs(&conn), vec![1, 2, 3, 4]);
    }

    /// 等级挂在关系上：同一份资料对两个任务可以是不同档，互不影响。
    #[test]
    fn task_ref_level_is_per_task() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_db(&conn).unwrap();
        conn.execute("INSERT INTO projects(name) VALUES('p')", []).unwrap();
        let pid = conn.last_insert_rowid();
        conn.execute("INSERT INTO columns(project_id,name) VALUES(?1,'待办')", params![pid])
            .unwrap();
        let cid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO tasks(project_id,column_id,title) VALUES(?1,?2,'A')",
            params![pid, cid],
        )
        .unwrap();
        let ta = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO tasks(project_id,column_id,title) VALUES(?1,?2,'B')",
            params![pid, cid],
        )
        .unwrap();
        let tb = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO board_notes(project_id,x,y,text) VALUES(?1,0,0,'资料')",
            params![pid],
        )
        .unwrap();
        let note = conn.last_insert_rowid();

        let upsert = |task: i64, level: i64| {
            conn.execute(
                "INSERT INTO task_refs(project_id,task_id,note_id,level,ord)
                 VALUES(?1,?2,?3,?4,0)
                 ON CONFLICT(task_id,note_id) DO UPDATE SET level=excluded.level",
                params![pid, task, note, level],
            )
            .unwrap();
        };
        // 对 A 是必须遵守，对 B 只是背景
        upsert(ta, 0);
        upsert(tb, 2);

        let la: i64 = conn
            .query_row(
                "SELECT level FROM task_refs WHERE task_id=?1 AND note_id=?2",
                params![ta, note],
                |r| r.get(0),
            )
            .unwrap();
        let lb: i64 = conn
            .query_row(
                "SELECT level FROM task_refs WHERE task_id=?1 AND note_id=?2",
                params![tb, note],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!((la, lb), (0, 2));

        // 改 A 的档位不能动到 B
        upsert(ta, 1);
        let la2: i64 = conn
            .query_row(
                "SELECT level FROM task_refs WHERE task_id=?1 AND note_id=?2",
                params![ta, note],
                |r| r.get(0),
            )
            .unwrap();
        let lb2: i64 = conn
            .query_row(
                "SELECT level FROM task_refs WHERE task_id=?1 AND note_id=?2",
                params![tb, note],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!((la2, lb2), (1, 2));

        // 同一 (task,note) 只会有一行
        let cnt: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_refs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cnt, 2);

        // 删任务时依据跟着走（外键 CASCADE）
        conn.execute("DELETE FROM tasks WHERE id=?1", params![ta]).unwrap();
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_refs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 1);
    }

    /// 要点是「换档不清空、显式传空才清空」。
    ///
    /// 点标签改档位是最常见的操作；如果换档顺手把要点清了，
    /// 用户写过的内容会莫名其妙消失，而且看不出来是什么时候丢的。
    #[test]
    fn task_ref_point_survives_level_change() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_db(&conn).unwrap();
        conn.execute("INSERT INTO projects(name) VALUES('p')", []).unwrap();
        let pid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO board_notes(project_id,x,y,text) VALUES(?1,0,0,'资料')",
            params![pid],
        )
        .unwrap();
        let note = conn.last_insert_rowid();
        // task_refs 对 tasks 有外键，先建一个真任务
        conn.execute("INSERT INTO columns(project_id,name) VALUES(?1,'待办')", params![pid])
            .unwrap();
        let cid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO tasks(project_id,column_id,title) VALUES(?1,?2,'A')",
            params![pid, cid],
        )
        .unwrap();
        let task = conn.last_insert_rowid();

        // 写要点
        conn.execute(
            "INSERT INTO task_refs(project_id,task_id,note_id,level,ord,point)
             VALUES(?1,?2,?3,1,0,'主色限墨绿')
             ON CONFLICT(task_id,note_id)
             DO UPDATE SET level=excluded.level, point=excluded.point",
            params![pid, task, note],
        )
        .unwrap();

        // 只换档（模拟 set_task_ref 传 point=None 的那条 SQL）
        conn.execute(
            "INSERT INTO task_refs(project_id,task_id,note_id,level,ord,point)
             VALUES(?1,?2,?3,0,0,'')
             ON CONFLICT(task_id,note_id) DO UPDATE SET level=excluded.level",
            params![pid, task, note],
        )
        .unwrap();
        let (lv, pt): (i64, String) = conn
            .query_row(
                "SELECT level, point FROM task_refs WHERE task_id=?1 AND note_id=?2",
                params![task, note],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(lv, 0, "档位应当已改成必须遵守");
        assert_eq!(pt, "主色限墨绿", "换档不该清掉要点");

        // 显式传空串：这是主动清空
        conn.execute(
            "INSERT INTO task_refs(project_id,task_id,note_id,level,ord,point)
             VALUES(?1,?2,?3,0,0,'')
             ON CONFLICT(task_id,note_id)
             DO UPDATE SET level=excluded.level, point=excluded.point",
            params![pid, task, note],
        )
        .unwrap();
        let pt2: String = conn
            .query_row(
                "SELECT point FROM task_refs WHERE task_id=?1 AND note_id=?2",
                params![task, note],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pt2, "", "显式传空应当清空");
    }
}


// ---------- 连线语义 ----------

const EDGE_KINDS: [&str; 4] = ["decompose", "precede", "evidence", "produce"];

fn normalize_edge_kind(kind: Option<&str>) -> String {
    match kind {
        Some(k) if EDGE_KINDS.contains(&k) => k.to_string(),
        _ => "decompose".to_string(),
    }
}

/// 依据类默认“可以参考”（1）；其余类型不用这个值。
fn default_strength(kind: &str) -> i64 {
    if kind == "evidence" {
        1
    } else {
        0
    }
}

/// 改一条连线的关系类型与等级。
#[tauri::command]
pub fn update_edge(
    db: State<Db>,
    id: i64,
    kind: Option<String>,
    strength: Option<i64>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(map_err)?;
    if let Some(k) = kind.as_deref() {
        if !EDGE_KINDS.contains(&k) {
            return Err(format!("未知的关系类型：{k}"));
        }
        conn.execute("UPDATE board_edges SET kind=?1 WHERE id=?2", params![k, id])
            .map_err(map_err)?;
    }
    if let Some(v) = strength {
        if !(0..=2).contains(&v) {
            return Err("等级只能是 0、1、2".into());
        }
        conn.execute(
            "UPDATE board_edges SET strength=?1 WHERE id=?2",
            params![v, id],
        )
        .map_err(map_err)?;
    }
    Ok(())
}

// ---------- 任务用到的资料与等级 ----------

#[derive(Serialize)]
pub struct TaskRefOut {
    pub id: i64,
    pub task_id: i64,
    pub note_id: i64,
    /// 0 必须遵守 / 1 可以参考 / 2 仅作背景
    pub level: i64,
    pub ord: i64,
    /// 这条依据对这个任务的要点（一句话，可为空）
    pub point: String,
}

#[tauri::command]
pub fn list_task_refs(db: State<Db>, project_id: i64) -> Result<Vec<TaskRefOut>, String> {
    let conn = db.0.lock().map_err(map_err)?;
    let mut stmt = conn
        .prepare(
            "SELECT id,task_id,note_id,level,ord,point FROM task_refs
             WHERE project_id=?1 ORDER BY task_id, ord, id",
        )
        .map_err(map_err)?;
    let rows = stmt
        .query_map(params![project_id], |r| {
            Ok(TaskRefOut {
                id: r.get(0)?,
                task_id: r.get(1)?,
                note_id: r.get(2)?,
                level: r.get(3)?,
                ord: r.get(4)?,
                point: r.get(5)?,
            })
        })
        .map_err(map_err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(map_err)
}

/// 给任务挂一份资料，或改它在这条关系上的等级 / 要点。
///
/// point 为 None 表示"这次不动要点"：改档位时不会顺手把已写的要点清空。
#[tauri::command]
pub fn set_task_ref(
    db: State<Db>,
    project_id: i64,
    task_id: i64,
    note_id: i64,
    level: Option<i64>,
    ord: Option<i64>,
    point: Option<String>,
) -> Result<i64, String> {
    let lv = level.unwrap_or(1);
    if !(0..=2).contains(&lv) {
        return Err("等级只能是 0、1、2".into());
    }
    // 要点是给 AI 读的一句话，太长反而会被截断忽略，这里兜个上限
    let pt: String = point
        .as_deref()
        .map(|v| v.trim().chars().take(2000).collect())
        .unwrap_or_default();
    let conn = db.0.lock().map_err(map_err)?;
    let next_ord: i64 = match ord {
        Some(v) => v,
        None => conn
            .query_row(
                "SELECT COALESCE(MAX(ord), -1) + 1 FROM task_refs WHERE task_id=?1",
                params![task_id],
                |r| r.get(0),
            )
            .map_err(map_err)?,
    };
    // 传了 point 才覆盖；没传就保留原来的（换档不该顺手清掉要点）
    let sql = if point.is_some() {
        "INSERT INTO task_refs(project_id,task_id,note_id,level,ord,point)
         VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(task_id,note_id)
         DO UPDATE SET level=excluded.level, ord=excluded.ord, point=excluded.point"
    } else {
        "INSERT INTO task_refs(project_id,task_id,note_id,level,ord,point)
         VALUES(?1,?2,?3,?4,?5,'')
         ON CONFLICT(task_id,note_id)
         DO UPDATE SET level=excluded.level, ord=excluded.ord"
    };
    conn.execute(sql, params![project_id, task_id, note_id, lv, next_ord, pt])
        .map_err(map_err)?;
    let id: i64 = conn
        .query_row(
            "SELECT id FROM task_refs WHERE task_id=?1 AND note_id=?2",
            params![task_id, note_id],
            |r| r.get(0),
        )
        .map_err(map_err)?;
    Ok(id)
}

#[tauri::command]
pub fn delete_task_ref(db: State<Db>, task_id: i64, note_id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(map_err)?;
    conn.execute(
        "DELETE FROM task_refs WHERE task_id=?1 AND note_id=?2",
        params![task_id, note_id],
    )
    .map_err(map_err)?;
    Ok(())
}
