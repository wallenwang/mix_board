// Read-only inspector for the kanban SQLite DB.
const { DatabaseSync } = require("node:sqlite");
const path = process.argv[2];

let db;
try {
  db = new DatabaseSync(path, { readOnly: true });
} catch (e) {
  console.log("OPEN_ERROR:", e.message);
  process.exit(0);
}

function q(sql) {
  try {
    return db.prepare(sql).all();
  } catch (e) {
    return [{ error: e.message }];
  }
}

console.log("TABLES:", JSON.stringify(q("SELECT name FROM sqlite_master WHERE type='table'")));
for (const t of ["projects", "columns", "tasks", "tags", "task_tags", "settings"]) {
  const cols = q(`PRAGMA table_info(${t})`);
  const count = q(`SELECT COUNT(*) AS n FROM ${t}`);
  console.log(`\n== ${t} == count=${JSON.stringify(count)}`);
  console.log("   cols:", cols.map((c) => c.name).join(","));
  const rows = q(`SELECT * FROM ${t} LIMIT 10`);
  console.log("   rows:", JSON.stringify(rows, null, 1));
}
db.close();
