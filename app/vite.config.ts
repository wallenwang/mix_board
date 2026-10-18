import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve, join } from "path";
import { readdirSync, statSync } from "fs";

/**
 * src 目录里最新的文件修改时间。
 * 用来判断"浏览器里打开的这一页代码是不是最新的" —— 见下面的 freshness 插件。
 */
function srcStamp(): string {
  let latest = 0;
  const walk = (dir: string) => {
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of items) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else {
        try {
          const m = statSync(p).mtimeMs;
          if (m > latest) latest = m;
        } catch {
          /* 忽略单个文件读不到的情况 */
        }
      }
    }
  };
  walk(resolve(__dirname, "src"));
  try {
    const m = statSync(resolve(__dirname, "index.html")).mtimeMs;
    if (m > latest) latest = m;
  } catch {
    /* ignore */
  }
  return String(latest);
}

/** 暴露 /__stamp，页面据此判断自己是不是旧代码 */
function freshnessPlugin() {
  const serve = (req: any, res: any, next: any) => {
    if (!req.url || !req.url.startsWith("/__stamp")) return next?.();
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(srcStamp());
  };
  return {
    name: "wb-page-freshness",
    configureServer(server: any) {
      server.middlewares.use(serve);
    },
    configurePreviewServer(server: any) {
      server.middlewares.use(serve);
    },
  };
}

export default defineConfig({
  plugins: [vue(), freshnessPlugin()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  clearScreen: false,
  server: {
    // 显式绑定 IPv4：Windows 上 Node 解析 localhost 时优先返回 ::1，
    // 而 WebView2/Chromium 访问 localhost 时优先走 127.0.0.1，两边会对不上导致白屏。
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "es2021",
    chunkSizeWarningLimit: 2200,
  },
});
