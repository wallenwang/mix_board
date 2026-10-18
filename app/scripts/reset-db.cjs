// Wipe all user data (projects/cascade + tags + settings except theme) so the
// app starts clean. Usage: node scripts/reset-db.cjs <path-to-kanban.db>
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[2]);
db.exec("PRAGMA foreign_keys = ON;");
const before = {
  projects: db.prepare("SELECT COUNT(*) n FROM projects").get().n,
  tasks: db.prepare("SELECT COUNT(*) n FROM tasks").get().n,
};
db.exec("DELETE FROM task_tags;");
db.exec("DELETE FROM tasks;");
db.exec("DELETE FROM tags;");
db.exec("DELETE FROM columns;");
db.exec("DELETE FROM projects;");
db.exec("DELETE FROM settings;");
const after = {
  projects: db.prepare("SELECT COUNT(*) n FROM projects").get().n,
  tasks: db.prepare("SELECT COUNT(*) n FROM tasks").get().n,
};
db.close();
console.log("cleared. before:", JSON.stringify(before), "after:", JSON.stringify(after));
