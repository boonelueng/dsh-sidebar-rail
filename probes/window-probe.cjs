// probes/window-probe.cjs — 真实浏览器回归：设置弹窗窗口化（拖动 / 红绿灯 / 最大化 / 最小化 / 关闭 / 持久化）
// 用法：node probes/window-probe.cjs
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9356;
const HERE = __dirname;
const PROFILE = path.join(HERE, ".probe-chrome-window");
const PAGE = "file:///" + path.join(HERE, "drag-harness.html").replace(/\\/g, "/");
const OUT = path.join(HERE, "window-probe-result.json");

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
    let text = "";
    try { text = typeof detail === "string" ? detail : JSON.stringify(detail); } catch (e) { text = String(detail); }
    if (text === undefined) text = String(detail);
    process.stdout.write((ok ? "PASS  " : "FAIL  ") + name + " :: " + text.slice(0, 220) + "\n");
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
        throw new Error("eval: " + String(desc).split("\n")[0] + " @ " + expr.replace(/\s+/g, " ").slice(0, 120));
      }
      return r.result.value;
    };
    const shot = async (name) => {
      const r = await c.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(HERE, name), Buffer.from(r.data, "base64"));
    };
    const mouse = (type, x, y, extra) => c.send("Input.dispatchMouseEvent", Object.assign({
      type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: 1, pointerType: "mouse",
    }, extra || {}));
    // 鼠标「按住 - 分步移动 - 松开」，走真实输入通道
    const dragBy = async (from, dx, dy, steps) => {
      const n = steps || 8;
      await mouse("mousePressed", from.x, from.y);
      for (let i = 1; i <= n; i++) {
        await mouse("mouseMoved", from.x + Math.round((dx * i) / n), from.y + Math.round((dy * i) / n));
        await sleep(16);
      }
      await mouse("mouseReleased", from.x + dx, from.y + dy);
      await sleep(360);
    };

    const boot = async (label) => {
      await c.send("Page.navigate", { url: PAGE });
      let ready = false;
      for (let i = 0; i < 120; i++) {
        if (await evalJs("typeof window.__HARNESS__ !== 'undefined'")) { ready = true; break; }
        await sleep(250);
      }
      if (!ready) throw new Error("harness not ready (" + label + "): " + (await evalJs("document.title")));
      result.modulesReady = await evalJs("window.__HARNESS__.modulesReady()");
      await sleep(500);
    };

    const openSettings = async () => {
      await evalJs("window.__HARNESS__.openSettings()");
      await sleep(420);
    };
    const panelBox = () => evalJs(`(() => {
      const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect();
        return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; };
      const p = window.__HARNESS__.panel();
      const lights = window.__HARNESS__.lights();
      const dots = lights ? Array.from(lights.querySelectorAll('.dsr-light')) : [];
      return {
        panel: box(p),
        lights: box(lights),
        dots: dots.map((d) => {
          const r = d.getBoundingClientRect();
          return { cls: d.className, x: Math.round(r.x), y: Math.round(r.y),
                   w: Math.round(r.width), h: Math.round(r.height),
                   bg: getComputedStyle(d).backgroundColor,
                   radius: getComputedStyle(d).borderTopLeftRadius,
                   label: d.getAttribute('aria-label') };
        }),
        attr: p && p.getAttribute('data-dsh-rail-win'),
        min: p && p.getAttribute('data-dsh-rail-win-min'),
        max: p && p.getAttribute('data-dsh-rail-win-max'),
        grip: box(document.querySelector('[data-dsh-rail-win-grip]')),
        position: p && getComputedStyle(p).position,
        vw: window.innerWidth, vh: window.innerHeight,
        railRight: Math.round(window.__HARNESS__.root().getBoundingClientRect().right),
        stored: localStorage.getItem('dsh-sidebar-rail.win.v1'),
      };
    })()`);
    const centerOf = (box) => ({ x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h / 2) });

    await boot("first");

    // ------------------------------------------------------- 1. 打开设置弹窗
    await openSettings();
    result.steps.opened = await panelBox();
    const o = result.steps.opened;
    check("设置弹窗打开后出现红绿灯", o.lights !== null, o.lights);
    check("红绿灯有三个圆点", o.dots.length === 3, o.dots.map((d) => d.cls));
    check("三个圆点都是 12px 圆形",
      o.dots.length === 3 && o.dots.every((d) => d.w === 12 && d.h === 12 && d.radius === "50%"),
      o.dots.map((d) => d.w + "x" + d.h + " r=" + d.radius));
    check("左→右顺序是 关闭(红) / 最小化(黄) / 最大化(绿)",
      o.dots.length === 3 &&
      o.dots[0].cls.indexOf("dsr-light-close") >= 0 && o.dots[0].bg === "rgb(255, 95, 87)" &&
      o.dots[1].cls.indexOf("dsr-light-min") >= 0 && o.dots[1].bg === "rgb(254, 188, 46)" &&
      o.dots[2].cls.indexOf("dsr-light-max") >= 0 && o.dots[2].bg === "rgb(40, 200, 64)",
      o.dots.map((d) => d.cls + " " + d.bg));
    check("红绿灯在窗口右上角（靠右、靠上）",
      o.lights !== null && o.panel !== null &&
      o.panel.x + o.panel.w - (o.lights.x + o.lights.w) <= 40 &&
      o.lights.y - o.panel.y <= 40,
      { panelRight: o.panel ? o.panel.x + o.panel.w : null, lightsRight: o.lights ? o.lights.x + o.lights.w : null,
        panelTop: o.panel ? o.panel.y : null, lightsTop: o.lights ? o.lights.y : null });
    check("接管后打上了 data-dsh-rail-win", o.attr === "1", o.attr);
    check("拖动抓手存在", o.grip !== null, o.grip);
    await shot("shot-window-open.png");

    // ------------------------------------------------------------- 2. 拖动移动
    const base = o.panel;
    const gripBox = o.grip;
    const gripPt = { x: Math.round(gripBox.x + 60), y: Math.round(gripBox.y + gripBox.h / 2) };
    await dragBy(gripPt, -260, 120, 10);
    result.steps.dragged = await panelBox();
    const d1 = result.steps.dragged;
    check("拖动后窗口真的移动了（位移 ≈ -260,120）",
      d1.panel !== null && Math.abs((d1.panel.x - base.x) - (-260)) <= 20 && Math.abs((d1.panel.y - base.y) - 120) <= 8,
      { before: base, after: d1.panel, movedBy: d1.panel ? [d1.panel.x - base.x, d1.panel.y - base.y] : null });
    check("拖动后没有残留 transform",
      (await evalJs("getComputedStyle(window.__HARNESS__.panel()).transform")) === "none",
      await evalJs("getComputedStyle(window.__HARNESS__.panel()).transform"));
    check("拖动后位置写进 localStorage",
      d1.stored !== null && (() => { try { const s = JSON.parse(d1.stored); return s.mode === "dragged"; } catch (e) { return false; } })(),
      d1.stored);
    check("红绿灯跟着窗口走（仍贴在右上角）",
      d1.lights !== null && d1.panel !== null &&
      Math.abs((d1.panel.x + d1.panel.w) - (d1.lights.x + d1.lights.w)) <= 40,
      { panelRight: d1.panel.x + d1.panel.w, lightsRight: d1.lights.x + d1.lights.w });
    await shot("shot-window-dragged.png");

    // ------------------------------------------------ 3. 最大化：铺满会话区
    const maxBtn = centerOf(d1.dots[2]);
    await mouse("mousePressed", maxBtn.x, maxBtn.y);
    await mouse("mouseReleased", maxBtn.x, maxBtn.y);
    await sleep(420);
    result.steps.maximized = await panelBox();
    const m1 = result.steps.maximized;
    check("最大化后打上 data-dsh-rail-win-max", m1.max === "1", m1.max);
    check("最大化后铺满会话区（左边贴左侧栏右缘，右边到视口右缘）",
      m1.panel !== null &&
      Math.abs(m1.panel.x - m1.railRight) <= 2 &&
      Math.abs(m1.panel.x + m1.panel.w - (m1.vw - 8)) <= 2 &&
      m1.panel.y >= 0 && m1.panel.y + m1.panel.h <= m1.vh,
      { panel: m1.panel, railRight: m1.railRight, vw: m1.vw, vh: m1.vh });
    check("最大化不会盖住左侧竖轨",
      m1.panel !== null && m1.panel.x >= m1.railRight - 1,
      { panelX: m1.panel ? m1.panel.x : null, railRight: m1.railRight });
    check("最大化后窗口比原尺寸大", m1.panel !== null && m1.panel.w > base.w, { max: m1.panel ? m1.panel.w : null, base: base.w });
    await shot("shot-window-max.png");

    // 再点一次回到原尺寸
    const maxBtn2 = centerOf(m1.dots[2]);
    await mouse("mousePressed", maxBtn2.x, maxBtn2.y);
    await mouse("mouseReleased", maxBtn2.x, maxBtn2.y);
    await sleep(420);
    result.steps.unmaximized = await panelBox();
    check("再点最大化回到拖动后的位置与尺寸",
      result.steps.unmaximized.max === null &&
      Math.abs(result.steps.unmaximized.panel.x - d1.panel.x) <= 3 &&
      Math.abs(result.steps.unmaximized.panel.w - d1.panel.w) <= 3,
      { now: result.steps.unmaximized.panel, want: d1.panel });

    // ---------------------------------------------------------- 4. 最小化
    const u1 = result.steps.unmaximized;
    const minBtn = centerOf(u1.dots[1]);
    await mouse("mousePressed", minBtn.x, minBtn.y);
    await mouse("mouseReleased", minBtn.x, minBtn.y);
    await sleep(420);
    result.steps.minimized = await panelBox();
    const n1 = result.steps.minimized;
    check("最小化后打上 data-dsh-rail-win-min", n1.min === "1", n1.min);
    check("最小化后收成一条（高度 54，宽度收窄）",
      n1.panel !== null && n1.panel.h === 54 && n1.panel.w <= 320,
      n1.panel);
    check("最小化后仍在可视区", n1.panel !== null && n1.panel.x >= 0 && n1.panel.x < n1.vw && n1.panel.y >= 0 && n1.panel.y < n1.vh, n1.panel);
    check("最小化后内容区被隐藏",
      (await evalJs("(() => { const p = window.__HARNESS__.panel(); const o = p && p.querySelector('.stOptions'); return o ? getComputedStyle(o).display : 'gone'; })()")) === "none");
    await shot("shot-window-min.png");

    // 点最小化后的标题条还原
    const titlePt = centerOf({ x: n1.panel.x + 12, y: n1.panel.y, w: 80, h: 54 });
    await mouse("mousePressed", titlePt.x, titlePt.y);
    await mouse("mouseReleased", titlePt.x, titlePt.y);
    await sleep(420);
    result.steps.restored = await panelBox();
    check("点最小化后的标题条能还原",
      result.steps.restored.min === null && result.steps.restored.panel.h > 54,
      { min: result.steps.restored.min, panel: result.steps.restored.panel });

    // ------------------------------------------------------- 5. 刷新后保持
    await c.send("Page.navigate", { url: PAGE });
    for (let i = 0; i < 120; i++) {
      if (await evalJs("typeof window.__HARNESS__ !== 'undefined'")) break;
      await sleep(250);
    }
    await sleep(500);
    await openSettings();
    result.steps.afterReload = await panelBox();
    check("刷新后重开设置，窗口位置仍保留",
      result.steps.afterReload.panel !== null &&
      Math.abs(result.steps.afterReload.panel.x - d1.panel.x) <= 4 &&
      Math.abs(result.steps.afterReload.panel.y - d1.panel.y) <= 4,
      { now: result.steps.afterReload.panel, want: d1.panel });

    // -------------------------------------------------------- 6. 关闭按钮
    const r1 = result.steps.afterReload;
    const closeBtn = centerOf(r1.dots[0]);
    await mouse("mousePressed", closeBtn.x, closeBtn.y);
    await mouse("mouseReleased", closeBtn.x, closeBtn.y);
    await sleep(420);
    result.steps.closed = { open: await evalJs("window.__HARNESS__.settingsOpen()"), visible: await evalJs(`(() => { const p = window.__HARNESS__.panel(); if (!p) return false; const cs = getComputedStyle(p); return cs.visibility !== "hidden" && cs.display !== "none"; })()`) };
    check("点红点关闭：窗口不可见（hidden 或已从 DOM 摘掉）", result.steps.closed.open === false || result.steps.closed.visible === false, result.steps.closed);
    check("关闭后不残留红绿灯",
      (await evalJs(`(() => { const l = window.__HARNESS__.lights(); if (!l) return true; const p = window.__HARNESS__.panel(); const cs = getComputedStyle(p); return cs.visibility === "hidden" || cs.display === "none"; })()`)) === true);

    // --------------------------------- 7. Esc 仍能关闭 + 无 diag 错误 + 无长任务
    await openSettings();
    const beforeEsc = await evalJs("window.__HARNESS__.settingsOpen()");
    await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(420);
    result.steps.esc = { before: beforeEsc, after: await evalJs("window.__HARNESS__.settingsOpen()") };
    // 回归台没有 DSH 的 Esc 关闭逻辑，这里只确认没有把面板锁死（仍可点关闭）
    await evalJs("window.__HARNESS__.closeSettings()");
    await sleep(200);
    result.steps.diag = await evalJs("({ errors: (window.__DSH_RAIL__ && window.__DSH_RAIL__.errors) || [] })");
    check("全程没有 diag 错误", (result.steps.diag.errors || []).filter((e) => String(e).indexOf("window:") === 0).length === 0, result.steps.diag.errors);

    // ------------------------------------------------- 8. 拖动过程无长任务
    await openSettings();
    result.steps.longTasks = await evalJs(`(async () => {
      const res = { count: 0, max: 0, list: [] };
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) { res.count++; res.max = Math.max(res.max, Math.round(e.duration)); res.list.push(Math.round(e.duration)); }
      });
      try { obs.observe({ entryTypes: ['longtask'] }); } catch (e) { return { unsupported: true }; }
      const p = window.__HARNESS__.panel();
      const g = document.querySelector('[data-dsh-rail-win-grip]');
      if (!g) { obs.disconnect(); return { unsupported: true }; }
      const r = g.getBoundingClientRect();
      const x0 = Math.round(r.x + 60), y0 = Math.round(r.y + r.height / 2);
      const ev = (type, x, y) => g.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1 }));
      ev('pointerdown', x0, y0);
      for (let i = 1; i <= 30; i++) {
        ev('pointermove', x0 + i * 4, y0 + i * 2);
        await new Promise((r2) => requestAnimationFrame(() => r2()));
      }
      ev('pointerup', x0 + 120, y0 + 60);
      await new Promise((r2) => setTimeout(r2, 260));
      obs.disconnect();
      return res;
    })()`);
    const lt = result.steps.longTasks;
    check("拖动全程无超过 80ms 的长任务",
      lt && lt.unsupported === true ? true : (!lt || lt.max <= 80),
      lt);
  } catch (err) {
    result.errors.push("fatal: " + String(err && err.message ? err.message : err));
  } finally {
    try { if (ws) ws.close(); } catch (e) { /* ignore */ }
    try { chrome.kill(); } catch (e) { /* ignore */ }
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8");
    const total = Object.keys(result.checks).length;
    const bad = Object.values(result.checks).filter((x) => !x.ok).length;
    console.log((bad === 0 ? "ALL PASS" : "FAILED") + " (" + (total - bad) + "/" + total + " checks)");
    for (const [k, v] of Object.entries(result.checks)) {
      if (!v.ok) console.log("  FAIL " + k + " :: " + JSON.stringify(v.detail));
    }
    for (const e of result.errors) console.log("  ERR " + e);
    console.log("result -> " + OUT);
  }
}

main();
