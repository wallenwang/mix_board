/**
 * 使用指南配图生成器。
 *
 * 真实界面截图（2 倍高清）+ 页面内注入的红框编号标注。
 * 图上只画框和编号，①②③ 的文字说明写在 Markdown 图片下方 —— 图干净，
 * 说明不会因为界面文案变化而对不上。
 *
 * 跑法：node scripts/shot-guide.mjs [场景...]   不传就跑全部
 * 输出：../docs/img/guide-*.png
 */
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "../../docs/img");
const URL = "http://127.0.0.1:1421/";

/** 页面内注入：给带 data-ann 的元素套红框 + 圆形编号 */
const ANN = `
  window.__ann = function (list) {
    document.getElementById("__ann")?.remove();
    const layer = document.createElement("div");
    layer.id = "__ann";
    layer.style.cssText = "position:fixed;inset:0;z-index:2147483600;pointer-events:none";
    document.body.appendChild(layer);
    const miss = [];
    for (const it of list) {
      const el = document.querySelector('[data-ann="' + it.tag + '"]');
      if (!el) { miss.push(it.tag); continue; }
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) { miss.push(it.tag + "(0尺寸)"); continue; }
      const pad = it.pad ?? 5;
      const color = it.color || "#d84338";
      const box = document.createElement("div");
      box.style.cssText =
        "position:absolute;left:" + (r.x - pad) + "px;top:" + (r.y - pad) + "px;" +
        "width:" + (r.width + pad * 2) + "px;height:" + (r.height + pad * 2) + "px;" +
        "border:2.5px solid " + color + ";border-radius:" + (pad + 4) + "px;" +
        "box-shadow:0 0 0 3px " + color + "26;";
      layer.appendChild(box);
      if (it.n != null) {
        const dx = it.nudge ? it.nudge[0] : 0;
        const dy = it.nudge ? it.nudge[1] : 0;
        const bx = Math.min(Math.max(r.x - pad - 11 + dx, 2), innerWidth - 26);
        const by = Math.min(Math.max(r.y - pad - 11 + dy, 2), innerHeight - 26);
        const badge = document.createElement("div");
        badge.textContent = String(it.n);
        badge.style.cssText =
          "position:absolute;left:" + bx + "px;top:" + by + "px;width:22px;height:22px;" +
          "border-radius:50%;background:" + color + ";color:#fff;" +
          'font:700 13px/22px "Segoe UI",-apple-system,sans-serif;text-align:center;' +
          "box-shadow:0 2px 6px rgba(0,0,0,.35);";
        layer.appendChild(badge);
      }
    }
    return miss;
  };
`;

async function fresh(b, panes, { width = 1707, height = 960, wait = 3600 } = {}) {
  const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(URL, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2400);
  await p.evaluate((ps) => localStorage.setItem("kanban.panes", JSON.stringify(ps)), panes);
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForTimeout(wait);
  return { ctx, p };
}

/** 在页面里挑元素打标记。finder 是一段返回元素的 JS 表达式字符串 */
async function tag(p, name, finder) {
  const ok = await p.evaluate(
    ([n, code]) => {
      let el = null;
      try {
        el = new Function("return (" + code + ")")();
      } catch (e) {
        el = null;
      }
      if (!el) return false;
      el.setAttribute("data-ann", n);
      return true;
    },
    [name, finder]
  );
  if (!ok) console.log(`   ⚠️ tag ${name} 没找到`);
  return ok;
}

async function mark(p, list) {
  await p.evaluate(ANN);
  const miss = await p.evaluate((l) => window.__ann(l), list);
  if (miss.length) console.log("   ⚠️ 标注没找到：", miss.join(", "));
  await p.waitForTimeout(220);
}

async function shot(p, name, clip) {
  const file = path.join(OUT, `guide-${name}.png`);
  await p.screenshot(clip ? { path: file, clip } : { path: file });
  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(`   ✅ guide-${name}.png  ${kb} KB`);
}

/** 常用取元素表达式 */
const VISIBLE = (sel) => `[...document.querySelectorAll('${sel}')].find(e=>{const b=e.getBoundingClientRect();return b.width>20&&b.height>10&&b.x>250&&b.right<1680&&b.y>110&&b.bottom<920})`;
const BIGGEST = (sel) => `[...document.querySelectorAll('${sel}')].sort((a,b)=>{const A=a.getBoundingClientRect(),B=b.getBoundingClientRect();return A.width>300?B.width-A.width:0})[0]`;

/* ------------------------------------------------------------------ 场景 */
const scenes = {};

/** 1. 界面总览：三栏全开 */
scenes["01-overview"] = async (b) => {
  const { ctx, p } = await fresh(b, ["kanban", "whiteboard", "write"], { wait: 4600 });
  const panes = await p.evaluate(() => {
    const all = [...document.querySelectorAll(".pane")];
    const pick = (sel, name) => {
      const el = all.find((e) => e.querySelector(sel));
      if (el) el.setAttribute("data-ann", name);
      return el ? Math.round(el.getBoundingClientRect().width) : 0;
    };
    return [
      pick(".column", "paneK"),
      pick(".wb-canvas", "paneW"),
      pick(".vditor", "paneD"),
    ];
  });
  console.log("   栏宽（看板/白板/文档）:", panes.join(" / "));
  await tag(p, "title", `document.querySelector('.main-title')`);
  await tag(p, "switch", `document.querySelector('.view-switch')`);
  await tag(p, "export", `document.querySelector('.export-btn')`);
  await mark(p, [
    { tag: "title", n: 1 },
    { tag: "switch", n: 2, pad: 6 },
    { tag: "export", n: 3 },
    { tag: "paneK", n: 4, pad: 2 },
    { tag: "paneW", n: 5, pad: 2 },
    { tag: "paneD", n: 6, pad: 2 },
  ]);
  await shot(p, "01-overview");
  await ctx.close();
};

/** 2. 看板：4 列 + 卡片 + 工具条 */
scenes["02-kanban"] = async (b) => {
  const { ctx, p } = await fresh(b, ["kanban"]);
  const g = p.locator(".gantt-chip.on").first();
  if (await g.count()) await g.click();
  await p.waitForTimeout(1000);
  await tag(p, "new", `document.querySelector('.newtask-btn')`);
  await tag(p, "filter", `document.querySelector('.filter-bar')`);
  await tag(p, "gantt", `document.querySelector('.gantt-chip')`);
  await tag(p, "colhead", `document.querySelector('.column-header')`);
  await tag(p, "card", `document.querySelector('.task-card')`);
  await mark(p, [
    { tag: "new", n: 1 },
    { tag: "filter", n: 2, pad: 4 },
    { tag: "gantt", n: 3 },
    { tag: "colhead", n: 4, pad: 3 },
    { tag: "card", n: 5 },
  ]);
  await shot(p, "02-kanban");
  await ctx.close();
};

/** 3. 甘特图 */
scenes["03-gantt"] = async (b) => {
  const { ctx, p } = await fresh(b, ["kanban"], { wait: 4000 });
  if (!(await p.locator(".gantt-chip.on").count())) {
    await p.locator(".gantt-chip").click();
    await p.waitForTimeout(1200);
  }
  // 展开所有可展开的父任务，让甘特显示出层级
  for (let round = 0; round < 3; round++) {
    const twists = p.locator(".g-twist");
    const n = await twists.count();
    let clicked = false;
    for (let i = 0; i < n; i++) {
      const t = twists.nth(i);
      const cls = (await t.getAttribute("class")) || "";
      if (!cls.includes("open")) {
        await t.click({ force: true }).catch(() => {});
        clicked = true;
      }
    }
    if (!clicked) break;
    await p.waitForTimeout(700);
  }
  await p.waitForTimeout(500);
  await tag(p, "head", `document.querySelector('.g-timeline')`);
  await tag(p, "row", `document.querySelector('.g-name')`);
  await tag(p, "bar", `document.querySelector('.g-bar')`);
  await tag(p, "zoom", `document.querySelector('.g-zoom')`);
  await mark(p, [
    { tag: "head", n: 1, pad: 4 },
    { tag: "row", n: 2, pad: 4 },
    { tag: "bar", n: 3, pad: 6 },
    { tag: "zoom", n: 4, pad: 4 },
  ]);
  const g = await p.locator(".gantt").first().boundingBox();
  await shot(p, "03-gantt", {
    x: 256,
    y: Math.max(0, g.y - 6),
    width: 1450,
    height: Math.min(960 - Math.max(0, g.y - 6), Math.max(g.height, 260)),
  });
  await ctx.close();
};

/** 4. 白板全景 */
scenes["04-whiteboard"] = async (b) => {
  const { ctx, p } = await fresh(b, ["whiteboard"], { wait: 4400 });
  await tag(p, "tb", `document.querySelector('.wb-toolbar')`);
  await tag(p, "task", VISIBLE('.wb-node[data-node-kind="task"]'));
  await tag(
    p,
    "port",
    `[...document.querySelectorAll('.node-port.out')].find(e=>{const b=e.getBoundingClientRect();return b.x>500&&b.x<1100&&b.y>250&&b.y<750})`
  );
  await mark(p, [
    { tag: "tb", n: 1, pad: 4 },
    { tag: "task", n: 2 },
    { tag: "port", n: 3, pad: 9, color: "#2f8f5b", nudge: [-26, 20] },
  ]);
  await shot(p, "04-whiteboard");
  await ctx.close();
};

/** 5. 点连线：四档菜单 */
scenes["05-edge-menu"] = async (b) => {
  const { ctx, p } = await fresh(b, ["whiteboard"], { wait: 4400 });
  // 找一条位于画面中部的线去点
  const idx = await p.evaluate(() => {
    const hits = [...document.querySelectorAll(".edge-hit")];
    for (let i = 0; i < hits.length; i++) {
      const b = hits[i].getBoundingClientRect();
      const cx = b.x + b.width / 2,
        cy = b.y + b.height / 2;
      if (cx > 520 && cx < 1150 && cy > 220 && cy < 720 && b.width * b.height > 40) return i;
    }
    return 2;
  });
  const hit = p.locator(".edge-hit").nth(idx);
  const hb = await hit.boundingBox();
  await hit.click({ force: true });
  await p.waitForTimeout(700);
  const has = await p.locator(".edge-menu").count();
  console.log("   菜单出现:", has);
  await tag(p, "k", `document.querySelector('.edge-menu .em-grid')`);
  await tag(p, "del", `document.querySelector('.edge-menu .em-del, .edge-menu .danger')`);
  await mark(p, [
    { tag: "k", n: 1, pad: 8 },
    { tag: "del", n: 2, pad: 8, nudge: [-14, 4] },
  ]);
  const cx = hb.x + hb.width / 2,
    cy = hb.y + hb.height / 2;
  await shot(p, "05-edge-menu", {
    x: Math.max(0, cx - 330),
    y: Math.max(0, cy - 230),
    width: 760,
    height: 470,
  });
  await ctx.close();
};

/** 6. 端口：左出右进 */
scenes["06-ports"] = async (b) => {
  const { ctx, p } = await fresh(b, ["whiteboard"], { wait: 4400 });
  const box = await p.evaluate(() => {
    const card = [...document.querySelectorAll('.wb-node[data-node-kind="task"]')]
      .map((e) => e.getBoundingClientRect())
      .filter((b) => b.x > 420 && b.right < 1250 && b.y > 200 && b.bottom < 760)
      .sort((a, b) => b.width - a.width)[0];
    if (!card) return null;
    return { x: Math.round(card.x), y: Math.round(card.y), w: Math.round(card.width), h: Math.round(card.height) };
  });
  if (!box) {
    console.log("   ⚠️ 没找到合适的卡片");
    await ctx.close();
    return;
  }
  await tag(
    p,
    "out",
    `[...document.querySelectorAll('.node-port.out')].find(e=>{const b=e.getBoundingClientRect();return Math.abs(b.x-${box.x})<12&&Math.abs(b.y-(${box.y}+${box.h}/2))<16})`
  );
  await tag(
    p,
    "in",
    `[...document.querySelectorAll('.node-port.in')].find(e=>{const b=e.getBoundingClientRect();return Math.abs(b.x-(${box.x}+${box.w}))<12&&Math.abs(b.y-(${box.y}+${box.h}/2))<16})`
  );
  await mark(p, [
    { tag: "out", n: 1, pad: 10, color: "#2f8f5b" },
    { tag: "in", n: 2, pad: 10, color: "#2f6fd0" },
  ]);
  const left = Math.max(266, box.x - 175);
  await shot(p, "06-ports", {
    x: left,
    y: Math.max(0, box.y - 80),
    width: Math.min(box.w + 350, 1700 - left),
    height: box.h + 160,
  });
  await ctx.close();
};

/** 中键拖动画布（白板平移） */
async function pan(p, dx, dy) {
  const c = await p.locator(".wb-canvas").boundingBox();
  const cx = c.x + c.width * 0.5,
    cy = c.y + c.height * 0.5;
  await p.mouse.move(cx, cy);
  await p.mouse.down({ button: "middle" });
  await p.mouse.move(cx + dx, cy + dy, { steps: 10 });
  await p.mouse.up({ button: "middle" });
  await p.waitForTimeout(450);
}

/** 把画布平移到右侧资料区（资料/文档/导图/分组框都在那边） */
async function panToNotes(p) {
  for (let i = 0; i < 10; i++) {
    const ok = await p.evaluate(() =>
      [...document.querySelectorAll('.wb-node[data-node-kind="note"]')].some((e) => {
        const b = e.getBoundingClientRect();
        return b.width > 200 && b.height > 120 && b.x > 340 && b.right < 1620 && b.y > 130 && b.bottom < 880;
      })
    );
    if (ok) return true;
    await pan(p, -380, 0);
  }
  return false;
}

/** 7. 分组框 */
scenes["07-box"] = async (b) => {
  const { ctx, p } = await fresh(b, ["whiteboard"], { wait: 4400 });
  const moved = await panToNotes(p);
  console.log("   平移到资料区:", moved);
  const box = await p.evaluate(() => {
    const boxes = [...document.querySelectorAll('.wb-node[data-node-kind="note"]')]
      .map((e) => ({ e, b: e.getBoundingClientRect() }))
      .filter((x) => x.b.width > 200 && x.b.height > 120 && x.b.x > 330 && x.b.right < 1630 && x.b.y > 120 && x.b.bottom < 890)
      .sort((a, z) => z.b.width * z.b.height - a.b.width * a.b.height);
    if (!boxes.length) return null;
    boxes[0].e.setAttribute("data-ann", "box");
    const b = boxes[0].b;
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
  });
  if (!box) {
    console.log("   ⚠️ 没找到分组框");
    await ctx.close();
    return;
  }
  console.log("   框:", JSON.stringify(box));
  await tag(p, "label", `document.querySelector('[data-ann="box"] [class*=cluster], [data-ann="box"] [class*=role]')`);
  await mark(p, [
    { tag: "box", n: 1, pad: 4 },
    { tag: "label", n: 2, pad: 6 },
  ]);
  await shot(p, "07-box");
  await ctx.close();
};

/** 8. 文档栏 */
scenes["08-doc"] = async (b) => {
  const { ctx, p } = await fresh(b, ["write"], { wait: 4800 });
  await tag(p, "list", `document.querySelector('.doc-list')`);
  await tag(p, "tools", `document.querySelector('.vditor-toolbar, .ed-tools')`);
  await tag(
    p,
    "acts",
    `[...document.querySelectorAll('button')].find(e=>/插入图片/.test(e.textContent))?.parentElement`
  );
  await mark(p, [
    { tag: "list", n: 1, pad: 3 },
    { tag: "tools", n: 2, pad: 4 },
    { tag: "acts", n: 3, pad: 6 },
  ]);
  await shot(p, "08-doc");
  await ctx.close();
};

/** 9. AI 指令弹窗 */
scenes["10-ai-dialog"] = async (b) => {
  const { ctx, p } = await fresh(b, ["whiteboard"], { wait: 4400 });
  // 取一张完整落在视口里的任务卡（第一张常常在视口外，点不到）
  const id = await p.evaluate(() => {
    const el = [...document.querySelectorAll('.wb-node[data-node-kind="task"]')].find((e) => {
      const b = e.getBoundingClientRect();
      return b.x > 320 && b.right < 1600 && b.y > 150 && b.bottom < 860;
    });
    return el ? el.getAttribute("data-node-id") : null;
  });
  if (!id) {
    console.log("   ⚠️ 没有可见任务卡");
    await ctx.close();
    return;
  }
  const card = p.locator(`.wb-node[data-node-id="${id}"]`).first();
  const cb = await card.boundingBox();
  await p.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await p.waitForTimeout(500);
  await card.locator(".tb-ai").click({ force: true });
  await p.waitForTimeout(1800);
  const has = await p.locator(".ai-dialog").count();
  console.log("   弹窗出现:", has);
  await tag(p, "fmt", `document.querySelector('.ai-fmt')`);
  await tag(p, "backend", `document.querySelector('.ai-backend')`);
  await tag(p, "text", `document.querySelector('textarea.ai-text')`);
  await tag(p, "send", `[...document.querySelectorAll('.el-dialog__footer button')].find(e=>/发送到 AI/.test(e.textContent))`);
  await mark(p, [
    { tag: "fmt", n: 1, pad: 5 },
    { tag: "backend", n: 2, pad: 5 },
    { tag: "text", n: 3, pad: 4 },
    { tag: "send", n: 4, pad: 5 },
  ]);
  await shot(p, "10-ai-dialog");
  await ctx.close();
};

/** 10. 导出面板 */
scenes["11-export"] = async (b) => {
  const { ctx, p } = await fresh(b, ["kanban"]);
  const btn = p.locator(".export-btn").first();
  await btn.click({ force: true });
  await p.waitForTimeout(900);
  const box = await p.evaluate(() => {
    const el = [...document.querySelectorAll('.el-dropdown-menu, .export-menu, [class*=export-pop], .el-popover')].find((e) => e.getBoundingClientRect().width > 60);
    return el ? { x: Math.round(el.getBoundingClientRect().x), y: Math.round(el.getBoundingClientRect().y), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null;
  });
  console.log("   导出面板:", box);
  await shot(p, "11-export", box ? { x: Math.max(0, box.x - 80), y: Math.max(0, box.y - 120), width: box.w + 200, height: box.h + 220 } : undefined);
  await ctx.close();
};

/* ------------------------------------------------------------------ 主流程 */
const want = process.argv.slice(2);
const list = want.length ? want : Object.keys(scenes);
const b = await chromium.launch({ channel: "msedge", headless: true });
for (const key of list) {
  const fn = scenes[key];
  if (!fn) {
    console.log(`跳过未知场景 ${key}`);
    continue;
  }
  console.log(`▶ ${key}`);
  try {
    await fn(b);
  } catch (e) {
    console.log(`   ❌ ${key} 失败：${String(e).slice(0, 220)}`);
  }
}
await b.close();
console.log("完成");
