# AI 接入说明（v0.6）

这一版把「给 AI 的指令」从**手动复制粘贴**升级成**点一下就发出去**：
本机装的 AI 命令行在后台把活干完，产物自动回收到白板上，打成一个组。

> 这份文档记录了取舍过程与实现细节，方便以后接着改。

---

## 一、为什么不再让用户复制提示词

原来的流程是：点 AI → 看指令 → 复制 → 打开 AI 对话框 → 粘贴 → 再把资料文件一个个拖过去。
这四步里每一步都会丢信息，而且资料一多根本拖不完。

现在的流程是：点 AI → 看指令 → **发送到 AI** → 进度条跑完 → **把产物打成组放到白板**。

---

## 二、三种集成路线，我们选了哪条

| 路线 | 谁主导会话 | 能不能全自动 | 结论 |
|---|---|---|---|
| CLI 一次性命令（`claude -p`、`opencode run`） | 我们开的，一一对应任务 | 能 | 各家参数不同，且实测 opencode 的 `run` 会挂住 → **只作兜底** |
| **ACP 长连接** | 我们开的 | 能，还能拿流式输出、工具调用、权限请求 | **采用** |
| MCP server（我们被连） | AI 客户端 | 不能推送 | 留给「让别的 AI 读到我的项目」，后续再做 |

**ACP（Agent Client Protocol）**是编辑器驱动 agent 的统一协议。
opencode、Trae CLI、DeepSeek Harness、Gemini CLI 原生支持，Claude Code 和 Codex 有官方适配器。
它走 stdin/stdout 的 nd-JSON，规范强制 UTF-8，**完全不经过 shell**——
这正是"中文提示词会不会被吞"这个问题的答案：不会。

---

## 三、传送方式：给 AI 一个文件夹，而不是一句话

命令行上只出现路径，中文正文一个字都不经过 shell：

```
<项目目录>/AI产出/<任务>/
  brief.md   指令全文（就是预览里看到的那份）
  refs/      参考材料原件，AI 自己读（PDF / 图片都能看）
  out/       AI 往这里写产物
```

跑完扫 `out/` 回收，比从 stdout 里抠 Markdown 稳得多。

---

## 四、实测记录（本机，2026-10-24）

**环境探测结果**

| 工具 | 状态 |
|---|---|
| OpenCode 桌面版 | 已装，**自带 CLI**：`%LOCALAPPDATA%\Programs\@opencodedesktop\resources\opencode-cli.exe`，v2.1.2 |
| 已配好的 key | DeepSeek、Xiaomi（`opencode auth list` 显示 stored，**用户不用再配**） |
| 可用模型 | `deepseek/deepseek-flash`、`deepseek/deepseek-v4-pro`、`xiaomi/mimo-v2.6-pro` 等 |
| DeepSeek Harness | `dsh 0.1.1-rc.2` 已全局安装，可用 `dsh --profile headless` / `acp` |
| Trae | 只装了 IDE（Trae CN），**没有 traecli** |
| claude / codex / gemini | 不在 PATH |

**端到端实测**

1. `initialize` → 返回 `OpenCode 2.1.2`，能力含 loadSession / resume / fork / close、
   `promptCapabilities.image`、`embeddedContext`（资料图可以直接喂）
2. `session/new` → 拿到 `ses_xxx`
3. 发中文「请只回复这六个字，不要加标点：链路通的」→ 回复 `链路通的`，**中文一个字没丢**
4. 让它把结果写进 `out/` → **真的写出了 91 字节的 `介绍.txt`**

**踩到的坑（都写进代码了）**

- ⚠️ `opencode run`（一次性命令）在这台机器上**挂住不返回**，plain 和 `--standalone` 都卡住。
  → 代码里只走 `acp`，不用 `run`。
- ⚠️ 模型用 shell 重定向写中文文件会**乱码/写空**（第一次实测 `out/` 就是空的）。
  → 指令里明确写"用写文件工具，不要用 `echo >`"；同时加了兜底：
  模型只回文字时，把回复存成 `out/AI 回复.md`，保证组里至少有一张卡。
- ⚠️ spawn 出来的 `opencode-cli.exe` 会残留（约 320MB/个），跑完要收掉。

**v0.6 首个桌面版「点发送没反应」的真凶（2026-10-24 补记）**

- 症状：桌面版点「发送到 AI」，弹窗停在"正在准备工作目录"，或者直接弹一条警告就没了。
- 原因：整个项目**没有任何 `src-tauri/capabilities/` 配置**（`gen/schemas/capabilities.json` 是 `{}`）。
  自家命令（`invoke("ai_start")`）不受 ACL 限制照样能用，但前端订阅进度用的是
  `@tauri-apps/api/event` 的 `listen()`，它走的是 **`plugin:event|listen`** —— 属于 core 插件命令，
  Tauri 2 里没在 capability 里授权就一律拒绝。于是 `await listen(...)` 直接 reject，
  整个发送流程在"起跑"之前就断了。
- 修法：新增 `src-tauri/capabilities/default.json`，给主窗口（label 必须是 `main`）授 `core:default`。
- 双保险：即使以后再出现权限问题，进度也不再只靠事件——Rust 端把每次运行的状态和正文记在
  `states()` 表里，前端同时按 1.5 秒轮询 `ai_status`。事件是"立刻知道"的快路，轮询是"一定知道"的保险。
- 顺带修掉的四个坑：① 前端 `run_id` 改由自己生成再传给后端（原来 invoke 返回前发出的事件会被丢掉）；
  ② 产物打组改成逐张 `await`（原来 `void` 并发，`refreshBoard` 跑在前面，白板上经常只剩半个组）；
  ③ 组放好后用 `uiBus.focusOnBoard` 把视口挪过去（不然卡放在内容右侧、用户看不见，以为没反应）；
  ④ `ai_detect_backends` 改成 `async` + `spawn_blocking`（它要真去跑几个进程问版本号，
  同步命令跑在 UI 线程上，弹窗会整页顿一下）。

---

## 五、代码在哪

| 文件 | 作用 |
|---|---|
| `app/src-tauri/src/agent.rs` | ACP 客户端：后端探测、起跑、流式事件、中止、扫产物、存回复 |
| `app/src-tauri/src/commands.rs` | `ai_prepare` 建工作目录并拷资料；`ai_import_outputs` 收产物进资料库 |
| `app/src/aiAgent.ts` | 前端编排：准备 → 发送 → 进度 → 收产物 → 打组上白板 |
| `app/src/components/AiPromptDialog.vue` | 后端选择、模型、发送按钮、进度面板、产物清单 |

**事件协议**：Rust 通过 `ai-event` 推 `{run_id, kind, text}`，
kind 有 `log`（过程日志）/ `chunk`（AI 文字流）/ `done` / `error`。
同一份状态也能用 `ai_status(run_id)` 查（返回 `{phase, text, error}`）——事件被 ACL 挡住时靠它。

**排查入口**：每一步都会往 `%APPDATA%\com.kanban.desk\diag.log` 写一行 `AI ...`
（开始 → 工作目录 → 事件通道 → 已下发 → 结束 → 产物数 → 组位置）。
"点了没反应"时先看这个文件，一行就能看出断在哪。

### 模型：agent 的默认值是坑（2026-10-24 实测撞到）

opencode `session/new` 返回的 `currentValue` 是本机 **`opencode/flint-40b-free`** ——
免费额度模型，有次数上限。用户不填模型时，整轮跑完最后报：

> Internal error: Free usage limit reached. Connect a provider or subscribe to OpenCode Go...

这不是我们的 bug，但表现一模一样：点发送 → 红色报错 → 0 产物。

现在的处理：

1. `session/new` 的 `configOptions` 里就有完整模型列表（本机 14 个，含
   `deepseek/deepseek-v4-pro`、`deepseek/deepseek-flash`、`xiaomi/mimo-v2.6-*`），
   后端 `model_options()` 解出来，新命令 `ai_list_models` 供前端做下拉（按 exe 缓存）。
2. **没填 / 填了列表里没有的** → `auto_pick_model()` 自动挑一个非免费模型
   （优先级 `deepseek/` > `xiaomi/` > 其它非 `opencode/` 前缀），日志里写「自动选 xxx」。
3. 免费模型在下拉里单独归到「免费额度（有次数上限）」组，不做默认。
4. 报错做翻译：`Free usage limit` → 直接告诉用户去换模型或连 provider。

**实测**（`scripts/acp-e2e.mjs`）：切到 `deepseek/deepseek-flash` 后 2.5 秒完成，
`out/测试.md` 内容「通了。」，usage 11969 tokens。同一台机器、同一条指令，
只换模型就从报错变成功 → 问题 100% 在模型，不在协议。

> 顺带：opencode 桌面版会自己升级，探测时版本已从 2.1.2 变成 2.1.4，协议没变。

---

## 六、产物怎么上白板

两种用法，对应两种真实需求：

**① 整轮打包**：点「把产物打成组放到白板」→ 一个分组框装起来，框名
`AI 产物 · T2.3 视觉设计 · 10-24 01:52`，里面按 3 张一行摆卡片（图片按真实比例给高度）。

这个框不是普通的资料框：`meta.role = "output"`，所以**框头的强度标签换成一个绿色「产物」标**，
并且自动拉一条**绿色产物线**（`kind=produce`，长边在产物组、箭头指向任务）。
产物既不是"依据"也不是"前置"，它是这次交出来的东西——所以单独一种关系，别再混进另外两种。

⚠️ **产物线不写 `task_refs`**：`task_refs` 是 AI 参考材料的唯一来源，产物只画一条 `produce` 边。
所以下一轮跑同一个任务时，这条线**不会被当成参考依据**，只在指令的「交付物」一节列个名字，
避免重复做同样的东西。把一条「依据」线改成「产物」时，代码会顺手把那条 `task_refs` 删掉，
不然线已经变成产物了、指令里还把它当依据，语义就自相矛盾。

自己框出来的一块也能手动标成产物组：选中框 → 工具条 **◈**（只写 `meta.role`，不新增 `NodeKind`）。

**② 只要其中几张**：在产物列表里**按住文件名拖到白板**，落在哪就在哪生成一张资料卡。
拖拽只带 `workDir + 文件名`（自定义 MIME `application/x-ai-output`），白板那边调
`ai_import_output` 只导入这一份，不连线、不成组——挂给谁由你自己决定。

**③ 关掉再打开**：同一个任务再点 AI，会直接恢复上一轮的产物列表（标题下写「上次跑于 …」），
不用重跑一遍。快照按 `项目:任务` 存在 localStorage（`ai.lastRun`，最多 30 条），
只存索引不存文件；恢复时会重扫一遍工作目录，目录没了就如实说没有。

顶部「过程日志」是个定高折叠区（132px 内部滚动），弹窗主体也有 66vh 上限——
日志再长也不会把弹窗顶出屏幕。

---

## 七、后面还能做

- [ ] 流式显示工具调用卡片（现在只打日志）
- [ ] 续会话：记住 `sessionId`，"再改一版"直接接着聊
- [ ] 资料用 ACP 的 `image` 能力直接喂图，不用让 AI 自己读文件
- [ ] MCP server：让 Cursor / Trae IDE 这类 GUI 客户端也能读到项目
