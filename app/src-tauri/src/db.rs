use rusqlite::Connection;
use std::sync::Mutex;

pub struct Db(pub Mutex<Connection>);

pub fn init_db(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS projects (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            color      TEXT NOT NULL DEFAULT '#409EFF',
            icon       TEXT NOT NULL DEFAULT '📁',
            sort_order REAL NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS columns (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name       TEXT NOT NULL,
            color      TEXT NOT NULL DEFAULT '#909399',
            wip_limit  INTEGER,
            sort_order REAL NOT NULL DEFAULT 0,
            collapsed  INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_columns_project ON columns(project_id);

        CREATE TABLE IF NOT EXISTS tasks (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            column_id    INTEGER NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
            title        TEXT NOT NULL,
            description  TEXT NOT NULL DEFAULT '',
            priority     INTEGER NOT NULL DEFAULT 2,
            due_date     TEXT,
            sort_order   REAL NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            updated_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            completed_at TEXT,
            deleted_at   TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_column ON tasks(column_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);

        CREATE TABLE IF NOT EXISTS tags (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name       TEXT NOT NULL,
            color      TEXT NOT NULL DEFAULT '#409EFF'
        );

        CREATE INDEX IF NOT EXISTS idx_tags_project ON tags(project_id);

        CREATE TABLE IF NOT EXISTS task_tags (
            task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (task_id, tag_id)
        );

        CREATE TABLE IF NOT EXISTS board_notes (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            x          REAL NOT NULL DEFAULT 0,
            y          REAL NOT NULL DEFAULT 0,
            text       TEXT NOT NULL DEFAULT '',
            color      TEXT NOT NULL DEFAULT '#FFF9C4'
        );

        CREATE INDEX IF NOT EXISTS idx_notes_project ON board_notes(project_id);

        CREATE TABLE IF NOT EXISTS board_edges (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            from_kind  TEXT NOT NULL,
            from_id    INTEGER NOT NULL,
            to_kind    TEXT NOT NULL,
            to_id      INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_edges_project ON board_edges(project_id);

        -- 任务 → 资料的依据关系。等级记在每条关系上，不记在资料上：
        -- 同一份资料对任务 A 可以是必须遵守，对任务 B 只是背景。
        CREATE TABLE IF NOT EXISTS task_refs (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            note_id    INTEGER NOT NULL REFERENCES board_notes(id) ON DELETE CASCADE,
            level      INTEGER NOT NULL DEFAULT 1,
            ord        INTEGER NOT NULL DEFAULT 0,
            -- 这条依据对这个任务的要点（AI 读不到本地文件，只能靠这句）
            point      TEXT NOT NULL DEFAULT '',
            UNIQUE(task_id, note_id)
        );

        CREATE INDEX IF NOT EXISTS idx_taskrefs_task ON task_refs(task_id);
        CREATE INDEX IF NOT EXISTS idx_taskrefs_note ON task_refs(note_id);

        -- 白板上传的资料 / 图片：文件本体落在 <app_data>/assets/，库里只存元信息 + 路径
        CREATE TABLE IF NOT EXISTS wb_files (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name       TEXT NOT NULL,
            ext        TEXT NOT NULL DEFAULT '',
            mime       TEXT NOT NULL DEFAULT '',
            size       INTEGER NOT NULL DEFAULT 0,
            path       TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE INDEX IF NOT EXISTS idx_wbfiles_project ON wb_files(project_id);

        -- 写作模块：在应用里直接写 Markdown 的文档（正文就是 Markdown 源文）
        CREATE TABLE IF NOT EXISTS docs (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            title      TEXT NOT NULL DEFAULT '未命名文档',
            body       TEXT NOT NULL DEFAULT '',
            sort_order REAL NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE INDEX IF NOT EXISTS idx_docs_project ON docs(project_id);
        ",
    )?;

    // Migration: whiteboard position columns on tasks (older DBs won't have them).
    let task_cols: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(tasks)")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    if !task_cols.iter().any(|c| c == "wx") {
        conn.execute("ALTER TABLE tasks ADD COLUMN wx REAL", [])?;
    }
    if !task_cols.iter().any(|c| c == "wy") {
        conn.execute("ALTER TABLE tasks ADD COLUMN wy REAL", [])?;
    }
    // Migration: 计划开始日期（甘特图的左端）。截止日期 due_date 本来就有。
    if !task_cols.iter().any(|c| c == "start_date") {
        conn.execute("ALTER TABLE tasks ADD COLUMN start_date TEXT", [])?;
    }
    // Migration: 甘特图进度条上的百分比（0~100，可为空表示按日期自动推算）
    if !task_cols.iter().any(|c| c == "progress") {
        conn.execute("ALTER TABLE tasks ADD COLUMN progress INTEGER", [])?;
    }
    // Migration: 甘特条手动配色（空 = 按截止日期紧迫度自动配色）
    if !task_cols.iter().any(|c| c == "bar_color") {
        conn.execute("ALTER TABLE tasks ADD COLUMN bar_color TEXT", [])?;
    }
    // Migration: 项目内任务编号（T1、T2…）。删掉的编号不回收，
    // 否则三个月前跟 AI 说的"任务 2"会指向另一个任务。0 表示尚未编号。
    if !task_cols.iter().any(|c| c == "seq") {
        conn.execute(
            "ALTER TABLE tasks ADD COLUMN seq INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    // Migration: 交付格式（word/pdf/ppt/md/html），空 = 未指定。
    // 只影响「给 AI 的指令」里的输出要求，不影响任务本身。
    if !task_cols.iter().any(|c| c == "deliver_fmt") {
        conn.execute(
            "ALTER TABLE tasks ADD COLUMN deliver_fmt TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }

    // Migration: whiteboard notes grow from "just a sticky note" into a generic
    // node (sticky / text / mind-map / uploaded file / group box).
    let note_cols: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(board_notes)")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let add_note_col = |name: &str, ddl: &str| -> Result<(), rusqlite::Error> {
        if !note_cols.iter().any(|c| c == name) {
            conn.execute(&format!("ALTER TABLE board_notes ADD COLUMN {ddl}"), [])?;
        }
        Ok(())
    };
    add_note_col("kind", "kind TEXT NOT NULL DEFAULT 'note'")?;
    add_note_col("w", "w REAL")?;
    add_note_col("h", "h REAL")?;
    add_note_col("file_id", "file_id INTEGER")?;
    add_note_col("meta", "meta TEXT NOT NULL DEFAULT ''")?;
    // Migration: 分区的用途角色（goal / input / constraint / work / output / defer）
    // 与特殊分组的类型（candidates 候选组 / versions 版本组）。留空即普通分组。
    add_note_col("role", "role TEXT NOT NULL DEFAULT ''")?;
    add_note_col("group_kind", "group_kind TEXT NOT NULL DEFAULT ''")?;

    // Migration: 连线的语义类型。老数据全部落在 decompose（分解）上，
    // 也就是升级前后的观感一致，不会突然冒出一堆看不懂的线型。
    let edge_cols: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(board_edges)")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let add_edge_col = |name: &str, ddl: &str| -> Result<(), rusqlite::Error> {
        if !edge_cols.iter().any(|c| c == name) {
            conn.execute(&format!("ALTER TABLE board_edges ADD COLUMN {ddl}"), [])?;
        }
        Ok(())
    };
    add_edge_col("kind", "kind TEXT NOT NULL DEFAULT 'decompose'")?;
    // strength 只给"依据"用：0=必须遵守 1=可以参考 2=仅作背景。
    // 不存权重数值 —— 没人说得清该给 70 还是 75。
    add_edge_col("strength", "strength INTEGER NOT NULL DEFAULT 0")?;

    // Migration: 这条依据对「这个任务」的要点。
    // 为什么需要：AI 打不开本地文件，光给文件名它不知道里面写了什么。
    // 一句话摘出「这份材料对这个任务的关键约束」，AI 才真正拿到了内容。
    // 要点挂在关系上（同一份资料对不同任务可以摘不同的话），不挂在资料上。
    let ref_cols: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(task_refs)")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    if !ref_cols.iter().any(|c| c == "point") {
        conn.execute(
            "ALTER TABLE task_refs ADD COLUMN point TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }

    // Migration: 资料内容指纹 —— 同一份文件重复上传时直接复用，不占两份空间。
    let file_cols: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(wb_files)")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    if !file_cols.iter().any(|c| c == "sha256") {
        conn.execute("ALTER TABLE wb_files ADD COLUMN sha256 TEXT NOT NULL DEFAULT ''", [])?;
    }
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_wbfiles_sha ON wb_files(project_id, sha256)",
        [],
    )?;

    // Migration: 每个项目在数据目录下的文件夹名（= 看板上的项目名）
    let proj_cols: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(projects)")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    if !proj_cols.iter().any(|c| c == "folder") {
        conn.execute("ALTER TABLE projects ADD COLUMN folder TEXT NOT NULL DEFAULT ''", [])?;
    }

    // Migration: 文档正文的 .md 文件路径（正文以文件为准，库里留一份缓存）
    let doc_cols: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(docs)")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    if !doc_cols.iter().any(|c| c == "path") {
        conn.execute("ALTER TABLE docs ADD COLUMN path TEXT NOT NULL DEFAULT ''", [])?;
    }

    Ok(())
}
