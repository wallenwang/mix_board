//! 给 AI 的通道：一个极简的 ACP（Agent Client Protocol）客户端。
//!
//! 为什么走 ACP 而不是各家自己的命令行：
//! · opencode / Trae CLI / DeepSeek Harness / Gemini CLI 都原生支持 ACP，
//!   claude / codex 也有官方适配器 —— 实现一次就能接上好几家，不用一家一套参数；
//! · ACP 走 **stdin/stdout 的 nd-JSON**，规范强制 UTF-8，完全不经过 shell，
//!   所以中文提示词不会被 cmd.exe 的代码页吃掉、也不用操心引号转义；
//! · 它是长连接，能拿到流式文字、工具调用、权限请求，也能续会话。
//!
//! ⚠️ 实测：opencode 的 `run` 子命令（一次性）在部分机器上会挂住不返回，
//!    但 `acp` 完全正常 —— 所以这里只走 ACP，不走一次性命令。
//!
//! ⚠️ 进度是「双通道」的：正常走 ai-event 事件；如果事件订阅失败（Tauri 2 的
//!    core:event 权限没配好时 listen 会直接报错），前端会退化成轮询 ai_status。
//!    两条路读的是同一张状态表，所以谁都能拿到完整文字和结束状态。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows 下不弹黑色控制台窗口
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ---------------------------------------------------------------- 数据结构

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Backend {
    pub id: String,
    pub name: String,
    pub exe: String,
    /// 进入 ACP 模式的参数（opencode 是 `acp`，dsh 是 `--profile acp`）
    pub args: Vec<String>,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiEvent {
    pub run_id: String,
    /// log=过程日志 / chunk=AI 文字流 / done=完成 / error=出错
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AiRunReq {
    /// 由前端先生成好再传进来：这样前端在 listen 时就已经知道自己的 run_id，
    /// 不会漏掉「刚起跑那几十毫秒」里发出的事件。
    #[serde(default)]
    pub run_id: String,
    pub exe: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub prompt: String,
    pub model: String,
    pub title: String,
}

/// 一次运行的可查询状态（事件通道的备份）
#[derive(Debug, Clone, Serialize)]
pub struct AiStatus {
    /// running / done / error
    pub phase: String,
    pub text: String,
    pub error: String,
}

#[derive(Debug, Clone)]
struct RunState {
    text: String,
    phase: String,
    error: String,
}

fn runs() -> &'static Mutex<HashMap<String, Child>> {
    static R: OnceLock<Mutex<HashMap<String, Child>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

fn states() -> &'static Mutex<HashMap<String, RunState>> {
    static S: OnceLock<Mutex<HashMap<String, RunState>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn emit(app: &AppHandle, run_id: &str, kind: &str, text: &str) {
    // 先记账，再推送：事件丢了也还有 ai_status 能查到
    if let Ok(mut m) = states().lock() {
        let s = m
            .entry(run_id.to_string())
            .or_insert_with(|| RunState {
                text: String::new(),
                phase: "running".into(),
                error: String::new(),
            });
        match kind {
            "chunk" => s.text.push_str(text),
            "done" => {
                s.phase = "done".into();
                // done 带的是完整正文（Link 里累积的那份），比逐块拼更可靠
                if !text.trim().is_empty() {
                    s.text = text.to_string();
                }
            }
            "error" => {
                s.phase = "error".into();
                s.error = text.to_string();
            }
            _ => {}
        }
    }
    let _ = app.emit(
        "ai-event",
        AiEvent {
            run_id: run_id.to_string(),
            kind: kind.to_string(),
            text: text.to_string(),
        },
    );
}

/// 查一次运行到哪一步了。事件订阅不上时前端靠它轮询。
#[tauri::command]
pub fn ai_status(run_id: String) -> AiStatus {
    let m = match states().lock() {
        Ok(m) => m,
        Err(_) => {
            return AiStatus {
                phase: "error".into(),
                text: String::new(),
                error: "状态表被锁坏了".into(),
            }
        }
    };
    match m.get(&run_id) {
        Some(s) => AiStatus {
            phase: s.phase.clone(),
            text: s.text.clone(),
            error: s.error.clone(),
        },
        // 还没登记 = 刚起跑
        None => AiStatus {
            phase: "running".into(),
            text: String::new(),
            error: String::new(),
        },
    }
}

// ---------------------------------------------------------------- 后端探测

/// 已知的 agent CLI。第一个是 opencode 桌面版自带的 CLI —— 装了桌面版就有了，
/// 不用再单独 npm install，这也是绝大多数用户「其实已经装了」的那一个。
fn candidates() -> Vec<(String, String, Vec<String>, Vec<String>)> {
    // (id, 显示名, 可执行文件候选路径, ACP 参数)
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    vec![
        (
            "opencode".into(),
            "OpenCode".into(),
            vec![format!(
                r"{}\Programs\@opencodedesktop\resources\opencode-cli.exe",
                local
            )],
            vec!["acp".into()],
        ),
        (
            "opencode-path".into(),
            "OpenCode（PATH）".into(),
            vec!["opencode".into()],
            vec!["acp".into()],
        ),
        (
            "dsh".into(),
            "DeepSeek Harness".into(),
            vec![format!(r"{}\npm\dsh.cmd", appdata), "dsh".into()],
            vec!["--profile".into(), "acp".into()],
        ),
        (
            "gemini".into(),
            "Gemini CLI".into(),
            vec!["gemini".into()],
            vec!["--acp".into()],
        ),
        (
            "claude".into(),
            "Claude Code（适配器）".into(),
            vec!["claude".into()],
            vec!["acp".into()],
        ),
        (
            "codex".into(),
            "Codex CLI（适配器）".into(),
            vec!["codex".into()],
            vec!["acp".into()],
        ),
    ]
}

/// 探测本机装了哪些 agent CLI。
/// ⚠️ 必须 async：探测要真的去跑几个进程问版本号（冷的机器上每个几百毫秒），
///    同步命令跑在 UI 线程上，弹窗那一下会整页卡住。
#[tauri::command]
pub async fn ai_detect_backends() -> Vec<Backend> {
    tauri::async_runtime::spawn_blocking(detect_backends_blocking)
        .await
        .unwrap_or_default()
}

fn detect_backends_blocking() -> Vec<Backend> {
    let mut out: Vec<Backend> = Vec::new();
    for (id, name, paths, args) in candidates() {
        for p in paths {
            if p.is_empty() {
                continue;
            }
            let is_abs = p.contains('\\') || p.contains('/');
            if is_abs && !Path::new(&p).exists() {
                continue;
            }
            let version = probe_version(&p);
            if version.is_empty() {
                // 绝对路径跑不出版本号 = 坏文件；不带路径的 = PATH 里没有
                continue;
            }
            out.push(Backend {
                id: id.clone(),
                name: name.clone(),
                exe: p.clone(),
                args: args.clone(),
                version,
            });
            break;
        }
    }
    out
}

fn probe_version(exe: &str) -> String {
    let mut c = Command::new(exe);
    c.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    let out = match c.output() {
        Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
        Err(_) => String::new(),
    };
    if out.trim().is_empty() {
        // 有些 CLI 只在 -v 上有反应
        let mut c2 = Command::new(exe);
        c2.arg("-v")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        c2.creation_flags(CREATE_NO_WINDOW);
        match c2.output() {
            Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
            Err(_) => String::new(),
        }
    } else {
        out
    }
    .lines()
    .next()
    .unwrap_or("")
    .trim()
    .chars()
    .take(40)
    .collect()
}

// ---------------------------------------------------------------- 一次运行

fn build_cmd(exe: &str, args: &[String]) -> Command {
    // Windows 的 npm shim 是 .cmd/.bat，不能直接 spawn，得挂到 cmd /C 后面
    let lower = exe.to_lowercase();
    let mut c = if lower.ends_with(".cmd") || lower.ends_with(".bat") {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(exe);
        c
    } else {
        Command::new(exe)
    };
    for a in args {
        c.arg(a);
    }
    c.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

// ---------------------------------------------------------------- 模型候选

/// agent 会话里可选的一个模型
#[derive(Debug, Clone, Serialize)]
pub struct AiModelOpt {
    /// 传给 session/set_config_option 的值，如 `deepseek/deepseek-flash`
    pub value: String,
    /// 界面上显示的名字
    pub name: String,
    /// 免费额度 / 官方托管：额度用完会直接报 "Free usage limit reached"
    pub free: bool,
}

fn is_free_model(v: &str) -> bool {
    v.ends_with("-free") || v.contains("-free-") || v.starts_with("opencode/")
}

/// 从 session/new 的 configOptions 里取模型候选。
/// opencode 把完整列表放在这里（`id == "model"` 的那一项的 options）；
/// 别的 agent 没有就是空，空的时候沿用用户填的值。
fn model_options(ns: &Value) -> Vec<AiModelOpt> {
    let Some(opts) = ns.get("configOptions").and_then(|x| x.as_array()) else {
        return Vec::new();
    };
    for o in opts {
        if o.get("id").and_then(|x| x.as_str()) != Some("model") {
            continue;
        }
        let Some(items) = o.get("options").and_then(|x| x.as_array()) else {
            return Vec::new();
        };
        return items
            .iter()
            .filter_map(|it| {
                let value = it.get("value").and_then(|x| x.as_str())?.to_string();
                let name = it
                    .get("name")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| value.clone());
                Some(AiModelOpt {
                    free: is_free_model(&value),
                    value,
                    name,
                })
            })
            .collect();
    }
    Vec::new()
}

/// 没指定模型时挑一个。
/// ⚠️ 千万别沿用 agent 默认：opencode 的默认是免费额度模型，额度一满整轮直接失败，
///    用户看到的是「发送到 AI 报错」，很难想到是模型没选。
fn auto_pick_model(list: &[AiModelOpt]) -> Option<AiModelOpt> {
    let paid: Vec<&AiModelOpt> = list.iter().filter(|m| !m.free).collect();
    for pref in ["deepseek/", "xiaomi/", "anthropic/", "openai/", "google/"] {
        if let Some(m) = paid.iter().find(|m| m.value.starts_with(pref)) {
            return Some((*m).clone());
        }
    }
    paid.first().map(|m| (*m).clone()).or_else(|| list.first().cloned())
}

fn models_cache() -> &'static Mutex<HashMap<String, Vec<AiModelOpt>>> {
    static C: OnceLock<Mutex<HashMap<String, Vec<AiModelOpt>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_put_models(exe: &str, list: &[AiModelOpt]) {
    if list.is_empty() {
        return;
    }
    if let Ok(mut m) = models_cache().lock() {
        m.insert(exe.to_string(), list.to_vec());
    }
}

/// 列出某家 agent 当前能选的模型（按 exe 缓存，一次进程只探一次）
#[tauri::command]
pub async fn ai_list_models(
    app: AppHandle,
    exe: String,
    args: Vec<String>,
) -> Result<Vec<AiModelOpt>, String> {
    if let Ok(m) = models_cache().lock() {
        if let Some(hit) = m.get(&exe) {
            return Ok(hit.clone());
        }
    }
    let ex = exe.clone();
    let list = tauri::async_runtime::spawn_blocking(move || probe_models(&app, &ex, &args))
        .await
        .map_err(|e| format!("探测模型失败：{e}"))??;
    cache_put_models(&exe, &list);
    Ok(list)
}

fn probe_models(app: &AppHandle, exe: &str, args: &[String]) -> Result<Vec<AiModelOpt>, String> {
    let mut child = build_cmd(exe, args)
        .current_dir(std::env::temp_dir())
        .spawn()
        .map_err(|e| format!("启动 {exe} 失败：{e}"))?;
    let (si, so) = match (child.stdin.take(), child.stdout.take()) {
        (Some(a), Some(b)) => (a, b),
        _ => {
            let _ = child.kill();
            return Err("拿不到 agent 的输入输出管道".into());
        }
    };
    // stderr 一定要读，不然 agent 日志写满管道会把它自己卡住
    if let Some(se) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut rd = BufReader::new(se);
            let mut l = String::new();
            while let Ok(n) = rd.read_line(&mut l) {
                if n == 0 {
                    break;
                }
                l.clear();
            }
        });
    }
    let mut link = Link {
        stdin: si,
        reader: BufReader::new(so),
        next: 1,
        app: app.clone(),
        run_id: "probe-models".into(),
        text: String::new(),
    };
    let out = (|| -> Result<Vec<AiModelOpt>, String> {
        link.call(
            "initialize",
            json!({"protocolVersion":1,"clientCapabilities":{}}),
        )?;
        let ns = link.call(
            "session/new",
            json!({"cwd": std::env::temp_dir().to_string_lossy(), "mcpServers": []}),
        )?;
        Ok(model_options(&ns))
    })();
    let _ = child.kill();
    let _ = child.wait();
    out
}

struct Link {
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
    next: u64,
    app: AppHandle,
    run_id: String,
    text: String,
}

impl Link {
    fn send(&mut self, msg: &Value) -> Result<(), String> {
        let mut s = msg.to_string();
        s.push('\n');
        self.stdin
            .write_all(s.as_bytes())
            .map_err(|e| format!("写不进 agent：{e}"))?;
        self.stdin.flush().map_err(|e| format!("刷新失败：{e}"))
    }

    /// 读一条消息。返回 Some = 这是一条响应；返回 None = 通知/请求，已就地处理。
    fn pump(&mut self) -> Result<Option<Value>, String> {
        let mut line = String::new();
        let n = self
            .reader
            .read_line(&mut line)
            .map_err(|e| format!("读 agent 输出失败：{e}"))?;
        if n == 0 {
            return Err("agent 已断开".into());
        }
        let v: Value = match serde_json::from_str(line.trim()) {
            Ok(v) => v,
            Err(_) => return Ok(None), // 不是 JSON（比如启动横幅），跳过
        };

        // 权限请求：无人值守，一律批准第一项（通常是 allow）
        if let Some(m) = v.get("method").and_then(|x| x.as_str()) {
            if m.ends_with("request_permission") {
                let opts = v
                    .pointer("/params/options")
                    .and_then(|x| x.as_array())
                    .cloned()
                    .unwrap_or_default();
                let pick = opts
                    .iter()
                    .find(|o| {
                        o.get("optionId")
                            .and_then(|s| s.as_str())
                            .map(|s| s.to_lowercase().contains("allow"))
                            .unwrap_or(false)
                    })
                    .or_else(|| opts.first())
                    .and_then(|o| o.get("optionId").cloned())
                    .unwrap_or(json!("allow-once"));
                let rid = v.get("id").cloned().unwrap_or(json!(0));
                let _ = self.send(&json!({
                    "jsonrpc":"2.0","id":rid,
                    "result":{"outcome":{"outcome":"selected","optionId":pick}}
                }));
                return Ok(None);
            }
        }

        // 过程更新：文字流 / 工具调用
        if let Some(u) = v.pointer("/params/update") {
            let kind = u.get("sessionUpdate").and_then(|x| x.as_str()).unwrap_or("");
            match kind {
                "agent_message_chunk" => {
                    if let Some(t) = u.pointer("/content/text").and_then(|x| x.as_str()) {
                        self.text.push_str(t);
                        emit(&self.app, &self.run_id, "chunk", t);
                    }
                }
                "tool_call" | "tool_call_update" => {
                    let title = u
                        .pointer("/toolCall/title")
                        .or_else(|| u.pointer("/title"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("调用工具");
                    emit(&self.app, &self.run_id, "log", title);
                }
                _ => {}
            }
            return Ok(None);
        }

        if v.get("result").is_some() || v.get("error").is_some() {
            return Ok(Some(v));
        }
        Ok(None)
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next;
        self.next += 1;
        self.send(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        loop {
            match self.pump()? {
                Some(v) => {
                    if v.get("id").and_then(|x| x.as_u64()) == Some(id) {
                        if let Some(e) = v.get("error") {
                            let msg = e
                                .get("message")
                                .and_then(|x| x.as_str())
                                .unwrap_or("agent 返回错误");
                            return Err(msg.to_string());
                        }
                        return Ok(v.get("result").cloned().unwrap_or(Value::Null));
                    }
                }
                None => continue,
            }
        }
    }
}

/// 发起一次运行。立刻返回 run_id，过程通过 ai-event + ai_status 两条路都能拿到。
#[tauri::command]
pub fn ai_start(app: AppHandle, req: AiRunReq) -> Result<String, String> {
    let run_id = if req.run_id.trim().is_empty() {
        format!("ai{}", now_ms())
    } else {
        req.run_id.trim().to_string()
    };
    // 先登记，前端轮询时立刻能查到"running"，不会读到"没这个 run"
    if let Ok(mut m) = states().lock() {
        m.insert(
            run_id.clone(),
            RunState {
                text: String::new(),
                phase: "running".into(),
                error: String::new(),
            },
        );
    }

    let mut child = build_cmd(&req.exe, &req.args)
        .current_dir(if req.cwd.is_empty() {
            std::env::temp_dir()
        } else {
            PathBuf::from(&req.cwd)
        })
        .spawn()
        .map_err(|e| format!("启动 agent 失败：{e}"))?;

    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    if let Ok(mut m) = runs().lock() {
        m.insert(run_id.clone(), child);
    }

    // agent 的日志走 stderr，单独读，别混进协议流
    if let Some(se) = stderr {
        let a = app.clone();
        let r = run_id.clone();
        std::thread::spawn(move || {
            let mut rd = BufReader::new(se);
            let mut l = String::new();
            while let Ok(n) = rd.read_line(&mut l) {
                if n == 0 {
                    break;
                }
                let t = l.trim();
                if !t.is_empty() {
                    emit(&a, &r, "log", t);
                }
                l.clear();
            }
        });
    }

    let a = app.clone();
    let r = run_id.clone();
    std::thread::spawn(move || {
        run_body(a, r, req, stdin, stdout);
    });

    Ok(run_id)
}

fn run_body(
    app: AppHandle,
    run_id: String,
    req: AiRunReq,
    stdin: Option<ChildStdin>,
    stdout: Option<ChildStdout>,
) {
    let (si, so) = match (stdin, stdout) {
        (Some(a), Some(b)) => (a, b),
        _ => {
            emit(&app, &run_id, "error", "拿不到 agent 的输入输出管道");
            return;
        }
    };
    let mut link = Link {
        stdin: si,
        reader: BufReader::new(so),
        next: 1,
        app: app.clone(),
        run_id: run_id.clone(),
        text: String::new(),
    };

    let result = (|| -> Result<(), String> {
        let init = link.call("initialize", json!({"protocolVersion":1,"clientCapabilities":{}}))?;
        let who = init
            .pointer("/agentInfo/name")
            .and_then(|x| x.as_str())
            .unwrap_or("agent");
        let ver = init
            .pointer("/agentInfo/version")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        emit(&app, &run_id, "log", &format!("已连上 {who} {ver}"));
        if !req.title.trim().is_empty() {
            emit(&app, &run_id, "log", &format!("任务：{}", req.title));
        }

        let ns = link.call(
            "session/new",
            json!({"cwd": req.cwd, "mcpServers": []}),
        )?;
        let sid = ns
            .get("sessionId")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        if sid.is_empty() {
            return Err("agent 没给会话 ID".into());
        }
        emit(&app, &run_id, "log", "会话已建好，正在下发任务");

        // 换模型：候选在 session/new 的 configOptions 里。
        // ⚠️ 不填不能沿用 agent 默认 —— opencode 默认就是「免费额度」模型，
        //    额度一用完整轮直接报 "Free usage limit reached"，用户看到的是
        //    「发送到 AI 报错」，根本想不到是模型没选。所以「没填」和「填了
        //    列表里没有的」都自动挑一个用户自己配了 key 的。
        let list = model_options(&ns);
        cache_put_models(&req.exe, &list);
        let want = req.model.trim().to_string();
        let chosen = match auto_pick_model(&list) {
            Some(auto) if want.is_empty() => {
                emit(
                    &app,
                    &run_id,
                    "log",
                    &format!("没指定模型，自动选 {}", auto.name),
                );
                auto.value
            }
            Some(auto) if !list.iter().any(|m| m.value == want) => {
                emit(
                    &app,
                    &run_id,
                    "log",
                    &format!("列表里没有 {}，改用 {}", want, auto.name),
                );
                auto.value
            }
            _ => want,
        };
        if !chosen.is_empty() {
            let r = link.call(
                "session/set_config_option",
                json!({"sessionId": sid, "configId": "model", "value": chosen}),
            );
            match r {
                Ok(_) => emit(&app, &run_id, "log", &format!("模型：{}", chosen)),
                Err(_) => emit(
                    &app,
                    &run_id,
                    "log",
                    &format!("模型 {} 没切成功，沿用默认", chosen),
                ),
            }
        }

        link.call(
            "session/prompt",
            json!({"sessionId": sid, "prompt": [{"type":"text","text": req.prompt}]}),
        )?;
        Ok(())
    })();

    let text = link.text.clone();
    match result {
        Ok(()) => {
            if text.trim().is_empty() {
                emit(
                    &app,
                    &run_id,
                    "done",
                    "跑完了，但没返回文字。产物可能已经写进输出目录，直接收一下看看。",
                );
            } else {
                emit(&app, &run_id, "done", &text);
            }
        }
        Err(e) => emit(&app, &run_id, "error", &e),
    }

    // 收工，别把 agent 进程留在后台吃内存
    if let Ok(mut m) = runs().lock() {
        if let Some(mut c) = m.remove(&run_id) {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// 中止一次运行
#[tauri::command]
pub fn ai_cancel(run_id: String) -> Result<(), String> {
    let mut m = runs().lock().map_err(|e| format!("{e}"))?;
    if let Some(mut c) = m.remove(&run_id) {
        let _ = c.kill();
    }
    if let Ok(mut s) = states().lock() {
        if let Some(v) = s.get_mut(&run_id) {
            v.phase = "error".into();
            v.error = "已中止".into();
        }
    }
    Ok(())
}

/// 把 AI 的回复正文存成 out/AI 回复.md。
/// 兜底用：有些模型只回文字不肯写文件，这样组里至少有一张能看的卡片。
#[tauri::command]
pub fn ai_save_reply(work_dir: String, text: String) -> Result<String, String> {
    if work_dir.trim().is_empty() || text.trim().is_empty() {
        return Ok(String::new());
    }
    let base = Path::new(&work_dir);
    let out = base.join("out");
    std::fs::create_dir_all(&out).map_err(|e| format!("建输出目录失败：{e}"))?;
    let p = unique_name(&out, "AI 回复", "md");
    std::fs::write(&p, text.as_bytes()).map_err(|e| format!("写回复失败：{e}"))?;
    Ok(p.to_string_lossy().to_string())
}

fn unique_name(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut p = dir.join(format!("{stem}.{ext}"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{stem}-{n}.{ext}"));
        n += 1;
    }
    p
}

/// 列出输出目录里的产物（out/ 下递归）
#[tauri::command]
pub fn ai_collect_outputs(dir: String) -> Vec<Value> {
    let base = Path::new(&dir).join("out");
    let mut out: Vec<Value> = Vec::new();
    if !base.exists() {
        return out;
    }
    let mut stack: Vec<PathBuf> = vec![base];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                    continue;
                }
                let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                out.push(json!({
                    "name": name,
                    "path": p.to_string_lossy(),
                    "size": size,
                }));
            }
        }
    }
    out.sort_by(|a, b| {
        a.get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .cmp(b.get("name").and_then(|x| x.as_str()).unwrap_or(""))
    });
    out
}
