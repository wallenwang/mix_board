/**
 * 把 Vditor 的运行时资源同步到 public/vditor/dist 下（离线可用，不走 CDN）。
 *
 * 为什么这么做：Vditor 4.0 的 npm 入口 `import "vditor"` 会 `import "./assets/less/index.less"`，
 * 需要额外装 less 才能构建。而我们的编辑器只需要「编辑器本体 + 图标 + md 解析引擎 + 代码高亮」，
 * 直接用它的 UMD 包（dist/index.min.js）+ 本地静态资源最省事，也不往构建链里加依赖。
 *
 * 用法：node scripts/sync-vditor-assets.mjs
 * （重装 node_modules 后需要再跑一次）
 */
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const src = join(appDir, "node_modules", "vditor", "dist");
const dst = join(appDir, "public", "vditor", "dist");

if (!existsSync(src)) {
  console.error("找不到 node_modules/vditor/dist，请先 npm install vditor");
  process.exit(1);
}

// 只同步运行时真正会用到的部分（数学公式 / 图表那些扩展不装，省 ~12MB）
const files = ["index.min.js", "index.css"];
const dirs = [
  join("js", "icons"), // 工具栏图标（必需）
  join("js", "i18n"), // 界面语言（zh_CN）
  join("js", "lute"), // Markdown 解析引擎（必需）
  join("js", "highlight.js"), // 代码块高亮
  "css", // 预览内容主题
  "images", // emoji / 加载图标
];

rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });

let bytes = 0;
const sizeOf = (p) => {
  const s = statSync(p);
  if (s.isFile()) return s.size;
  return 0;
};

for (const f of files) {
  const from = join(src, f);
  cpSync(from, join(dst, f));
  bytes += sizeOf(from);
}
for (const d of dirs) {
  const from = join(src, d);
  cpSync(from, join(dst, d), { recursive: true });
}

console.log(`已同步 Vditor 资源到 public/vditor/dist（入口文件 ${(bytes / 1024).toFixed(0)} KB）`);
