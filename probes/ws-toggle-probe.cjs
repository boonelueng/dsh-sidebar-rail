// probes/ws-toggle-probe.cjs — 真实浏览器回归：工作区一键展开 / 收起
// 用法：node probes/ws-toggle-probe.cjs
//
// 验的是「一次性把整块工作区开/关」这条路径在真实 DOM 里跑得通：
//   ① 入口长在 [data-slot="sidebar.workspaces"] 的容器里，不是飘在别处
//   ② 展开态文案是「收起工作区」，点一下宿主进入折叠态
//   ③ 折叠态文案翻成「展开工作区」，再点一下回到展开态
//   ④ 宿主既没有服务、也没有可点按钮时，入口把自己禁用而不是假装成功
//   ⑤ 锚点整块消失时入口跟着退场，不留一个孤儿按钮
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9357;
const HERE = __dirname;
const PROFILE = path.join(HERE, ".probe-chrome-ws-toggle");
const PAGE = "file:///" + path.join(HERE, "drag-harness.html").replace(/\\/g, "/");
const OUT = path.join(HERE, "ws-toggle-probe-result.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  return {
    send(method, params, timeout = 45000) {
      const myId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(myId);
          reject(new Error("CDP timeout: " + method));
        }, timeout);
        pending.set(myId, { resolve, reject, timer });
        ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
      });
    },
  };
}

async function waitDevtools() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch("http://127.0.0.1:" + PORT + "/json/version");
      if (res.ok) return await res.json();
    } catch (e) { /* not up */ }
    await sleep(250);
  }
  throw new Error("devtools did not come up");
}

async function pageTarget() {
  for (let i = 0; i < 40; i++) {
    const res = await fetch("http://127.0.0.1:" + PORT + "/json/list");
    const list = await res.json();
    const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (page) return page;
    await sleep(250);
  }
  throw new Error("no page target");
}

async function main() {
  const result = { page: PAGE, startedAt: new Date().toISOString(), steps: {}, checks: {}, errors: [] };
  const check = (name, ok, detail) => {
    result.checks[name] = { ok: Boolean(ok), detail: detail === undefined ? null : detail };
    if (!ok) result.errors.push(name + (detail === undefined ? "" : ": " + JSON.stringify(detail)));
  };

  fs.rmSync(PROFILE, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--allow-file-access-from-files",
    "--user-data-dir=" + PROFILE,
    "--remote-debugging-port=" + PORT,
    "--window-size=1440,900",
    "about:blank",
  ], { stdio: "ignore", detached: false });

  let ws = null;
  try {
    await waitDevtools();
    const t = await pageTarget();
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", rej, { once: true });
    });
    const c = cdp(ws);
    await c.send("Page.enable");
    await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    const evalJs = async (expr) => {
      const r = await c.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        const ex = r.exceptionDetails;
        const desc = (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text || "unknown";
        throw new Error("eval: " + String(desc).split("\n")[0]);
      }
      return r.result.value;
    };
    const shot = async (name) => {
      const r = await c.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(HERE, name), Buffer.from(r.data, "base64"));
    };

    await c.send("Page.navigate", { url: PAGE });
    for (let i = 0; i < 120; i++) {
      if (await evalJs("typeof window.__HARNESS__ !== 'undefined'")) break;
      await sleep(250);
    }
    await evalJs("window.__HARNESS__.modulesReady()");
    await sleep(500);

    // 读入口的当前状态：位置、文案、禁用、折叠态、诊断里的路径
    const probe = () => evalJs(`(() => {
      const btn = document.querySelector('[data-dsh-rail-ws-toggle]');
      const region = document.querySelector('[data-dsh-rail-part="region"]');
      const wsSlot = document.querySelector('[data-slot="sidebar.workspaces"]');
      const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect();
        return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; };
      const d = window.__DSH_RAIL__ || {};
      return {
        exists: btn !== null,
        box: box(btn),
        regionBox: box(region),
        wsSlotBox: box(wsSlot),
        // 入口必须真的长在工作区那个容器里，不是被挂到别的地方
        inRegion: btn !== null && region !== null && region.contains(btn),
        // 并且是容器的第一个交互元素（视觉上属于「这一块的头」）
        isFirstChild: btn !== null && btn.parentElement !== null && btn.parentElement.firstElementChild === btn,
        label: btn ? btn.getAttribute('aria-label') : null,
        title: btn ? btn.title : null,
        text: btn ? btn.textContent : null,
        disabled: btn ? btn.disabled : null,
        pressed: btn ? btn.getAttribute('aria-pressed') : null,
        collapsed: window.__HARNESS__.sidebarCollapsed(),
        compat: (d.compat || {}).wsToggle || null,
        colWidth: Math.round(document.getElementById('col').getBoundingClientRect().width),
      };
    })()`);

    // ------------------------------------------------ 1. 入口就该在这儿
    result.steps.initial = await probe();
    check("工作区顶部出现一键展开/收起入口", result.steps.initial.exists, result.steps.initial.box);
    check("入口长在工作区容器里（不是飘在别处）", result.steps.initial.inRegion, {
      inRegion: result.steps.initial.inRegion,
      regionBox: result.steps.initial.regionBox,
    });
    check("入口是工作区容器的第一个元素（视觉上属于这一块的头）",
      result.steps.initial.isFirstChild, result.steps.initial.label);
    check("展开态文案是「收起工作区」", result.steps.initial.label === "收起工作区",
      { label: result.steps.initial.label, title: result.steps.initial.title });
    check("展开态 aria-pressed=true", result.steps.initial.pressed === "true", result.steps.initial.pressed);
    check("入口没有被禁用（宿主提供了切换路径）", result.steps.initial.disabled === false,
      { disabled: result.steps.initial.disabled, compat: result.steps.initial.compat });
    check("诊断里记下了切换路径", result.steps.initial.compat !== null && result.steps.initial.compat !== "unsupported",
      result.steps.initial.compat);
    await shot("shot-ws-toggle-expanded.png");

    // ------------------------------------------------ 2. 点一下 → 收起
    await evalJs("document.querySelector('[data-dsh-rail-ws-toggle]').click()");
    await sleep(600);
    result.steps.collapsed = await probe();
    check("点一下就收起了整块工作区（宿主进入折叠态）",
      result.steps.collapsed.collapsed === true, {
        collapsed: result.steps.collapsed.collapsed,
        colWidth: result.steps.collapsed.colWidth,
      });
    check("收起后侧栏明显变窄", result.steps.collapsed.colWidth < 100, result.steps.collapsed.colWidth);
    check("收起后文案翻成「展开工作区」", result.steps.collapsed.label === "展开工作区",
      result.steps.collapsed.label);
    check("收起后 aria-pressed=false", result.steps.collapsed.pressed === "false", result.steps.collapsed.pressed);
    await shot("shot-ws-toggle-collapsed.png");

    // ------------------------------------------------ 3. 再点一下 → 展开
    await evalJs("document.querySelector('[data-dsh-rail-ws-toggle]').click()");
    await sleep(600);
    result.steps.reexpanded = await probe();
    check("再点一下就展开回来（折叠态已解除）",
      result.steps.reexpanded.collapsed === false, result.steps.reexpanded.collapsed);
    check("展开后侧栏恢复原宽", result.steps.reexpanded.colWidth > 200, result.steps.reexpanded.colWidth);
    check("展开后文案回到「收起工作区」", result.steps.reexpanded.label === "收起工作区",
      result.steps.reexpanded.label);
    check("来回切换没有重复堆积入口（DOM 里只有一个）",
      (await evalJs("document.querySelectorAll('[data-dsh-rail-ws-toggle]').length")) === 1,
      await evalJs("document.querySelectorAll('[data-dsh-rail-ws-toggle]').length"));

    // ------------------------------------------------ 4. 宿主完全不支持时
    // 把服务与宿主按钮都摘掉：插件必须自己禁用入口，而不是留一个点了没反应的按钮
    await evalJs(`(() => {
      document.querySelectorAll('[data-sidebar-toggle]').forEach((b) => b.remove());
      document.querySelectorAll('[data-sidebar-opener]').forEach((b) => b.remove());
      // 按无障碍名兜底也一并废掉：把所有可能被认成折叠按钮的 aria-label 抹掉
      document.querySelectorAll('button[aria-label]').forEach((b) => {
        if (/侧边栏|侧边|sidebar/i.test(b.getAttribute('aria-label') || '')) b.remove();
      });
      window.__HARNESS__.notifyMount();
      return true;
    })()`);
    await sleep(700);
    result.steps.noHost = await probe();
    check("宿主没有切换路径时入口被禁用（不假装成功）", result.steps.noHost.disabled === true,
      { disabled: result.steps.noHost.disabled, compat: result.steps.noHost.compat });
    check("诊断里标出 unsupported", result.steps.noHost.compat === "unsupported", result.steps.noHost.compat);

    // ------------------------------------------------ 5. 锚点消失 → 入口退场
    await evalJs(`(() => {
      const ws = document.querySelector('[data-slot="sidebar.workspaces"]');
      if (ws && ws.parentElement) ws.parentElement.remove();
      window.__HARNESS__.notifyMount();
      return true;
    })()`);
    await sleep(700);
    const gone = await evalJs("document.querySelector('[data-dsh-rail-ws-toggle]') !== null");
    check("工作区锚点消失后入口跟着退场（不留孤儿按钮）", gone === false, gone);

    result.steps.diag = await evalJs("(() => { const d = window.__DSH_RAIL__ || {}; return { errors: d.errors || [], compat: d.compat || null }; })()");
    check("全程没有报错", (result.steps.diag.errors || []).length === 0, result.steps.diag.errors);
  } catch (err) {
    check("probe crashed", false, String(err && err.message ? err.message : err));
  } finally {
    try { if (ws) ws.close(); } catch (e) { /* ignore */ }
    chrome.kill();
  }

  const total = Object.keys(result.checks).length;
  const failed = Object.keys(result.checks).filter((k) => !result.checks[k].ok);
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  for (const name of Object.keys(result.checks)) {
    const c = result.checks[name];
    console.log((c.ok ? "PASS  " : "FAIL  ") + name + " :: " + JSON.stringify(c.detail));
  }
  console.log("");
  if (failed.length === 0) console.log("ALL PASS (" + total + "/" + total + " checks)");
  else console.log(failed.length + " FAILED / " + total);
  console.log("result -> " + OUT);
  if (failed.length !== 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
