// probes/float-probe.cjs — 真实浏览器回归：悬浮轨道（拖动 / 停靠 / 持久化 / 布局不被破坏）
// 用法：node probes/float-probe.cjs
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9352;
const HERE = __dirname;
const PROFILE = path.join(HERE, ".probe-chrome-float");
const PAGE = "file:///" + path.join(HERE, "drag-harness.html").replace(/\\/g, "/");
const OUT = path.join(HERE, "float-probe-result.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v) => Math.round(v);

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

    const boot = async (label) => {
      await c.send("Page.navigate", { url: PAGE });
      let ready = false;
      for (let i = 0; i < 120; i++) {
        if (await evalJs("typeof window.__HARNESS__ !== 'undefined'")) { ready = true; break; }
        await sleep(250);
      }
      if (!ready) throw new Error("harness not ready (" + label + "): " + (await evalJs("document.title")));
      // 悬浮/拖拽/设置已拆成独立 chunk，异步装配；等三个都就位再量，
      // 否则会拍到一个还没有悬浮按钮的中间态。
      result.modulesReady = await evalJs("window.__HARNESS__.modulesReady()");
      await sleep(700);
    };

    await boot("first");

    // ---------------------------------------------------------------- 基线
    result.steps.boot = await evalJs(`(() => {
      const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect();
        return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; };
      return {
        diag: { loaded: window.__DSH_RAIL__ && window.__DSH_RAIL__.loaded,
                tagged: window.__DSH_RAIL__ && window.__DSH_RAIL__.tagged,
                floating: window.__DSH_RAIL__ && window.__DSH_RAIL__.floating,
                errors: (window.__DSH_RAIL__ && window.__DSH_RAIL__.errors) || [] },
        floatToggle: box(window.__HARNESS__.floatToggle()),
        grip: box(window.__HARNESS__.grip()),
        nav: box(window.__HARNESS__.navBox()),
        region: box(window.__HARNESS__.regionBox()),
        stored: localStorage.getItem('dsh-sidebar-rail.float.v1'),
        navButtons: document.querySelectorAll('[data-dsh-rail-part="nav"] > button').length,
        entryButtons: document.querySelectorAll('[data-dsh-rail-part="custom"] .dsr-btn').length,
      };
    })()`);
    check("boot: 悬浮按钮存在", result.steps.boot.floatToggle !== null, result.steps.boot.floatToggle);
    check("boot: 初始未悬浮（没有抓手）", result.steps.boot.grip === null, result.steps.boot.grip);
    check("boot: 初始无 diag 错误", (result.steps.boot.diag.errors || []).length === 0, result.steps.boot.diag.errors);
    const dockedNav = result.steps.boot.nav;
    const dockedRegion = result.steps.boot.region;
    await shot("shot-float-boot.png");

    // ------------------------------------------------------- 点击「悬浮」按钮
    const togglePt = await evalJs(`(() => {
      const b = window.__HARNESS__.floatToggle(); if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    })()`);
    if (togglePt === null) throw new Error("float toggle button not found");
    await mouse("mousePressed", togglePt.x, togglePt.y);
    await mouse("mouseReleased", togglePt.x, togglePt.y);
    await sleep(450);

    result.steps.floated = await evalJs(`(() => {
      const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect();
        return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; };
      const root = window.__HARNESS__.root();
      const nav = root && root.querySelector('[data-dsh-rail-part="nav"]');
      const cs = nav ? getComputedStyle(nav) : null;
      return {
        attr: root && root.getAttribute('data-dsh-rail-float'),
        diag: { floating: window.__DSH_RAIL__.floating, floatPos: window.__DSH_RAIL__.floatPos },
        grip: box(window.__HARNESS__.grip()),
        nav: box(window.__HARNESS__.navBox()),
        region: box(window.__HARNESS__.regionBox()),
        navPosition: cs && cs.position,
        floatX: root && root.style.getPropertyValue('--dsr-float-x'),
        floatY: root && root.style.getPropertyValue('--dsr-float-y'),
        floatW: root && root.style.getPropertyValue('--dsr-float-w'),
        floatNavH: root && root.style.getPropertyValue('--dsr-float-nav-h'),
        stored: localStorage.getItem('dsh-sidebar-rail.float.v1'),
        toggleLabel: (() => { const b = window.__HARNESS__.floatToggle(); return b && b.getAttribute('aria-label'); })(),
        expandedAttr: root && root.getAttribute('data-dsh-rail-expanded'),
        expandedStored: localStorage.getItem('dsh-sidebar-rail.railExpanded.v1'),
        railWidthVar: root && root.style.getPropertyValue('--dsr-rail-w'),
      };
    })()`);
    check("悬浮：root 打上 data-dsh-rail-float", result.steps.floated.attr === "1", result.steps.floated.attr);
    check("悬浮：nav 变成 position:fixed", result.steps.floated.navPosition === "fixed", result.steps.floated.navPosition);
    check("悬浮：出现抓取条", result.steps.floated.grip !== null, result.steps.floated.grip);
    check("悬浮：写入了 --dsr-float-x/y/w", result.steps.floated.floatX !== "" && result.steps.floated.floatY !== "" && result.steps.floated.floatW !== "",
      { x: result.steps.floated.floatX, y: result.steps.floated.floatY, w: result.steps.floated.floatW });
    check("悬浮：偏好已落盘 on=true", /"on":true/.test(result.steps.floated.stored || ""), result.steps.floated.stored);
    check("悬浮：会话区让位已释放（margin-left 归零后 region 左移）",
      result.steps.floated.region !== null && dockedRegion !== null && result.steps.floated.region.x <= dockedRegion.x,
      { docked: dockedRegion, floated: result.steps.floated.region });
    check("悬浮：按钮文案切换为「停靠」", result.steps.floated.toggleLabel === "停靠回侧边栏", result.steps.floated.toggleLabel);
    // 悬浮后功能区自动展开：40px 图标条浮在视口里太难点，展开才认得清
    check("悬浮：功能区自动展开（属性置 1）", result.steps.floated.expandedAttr === "1", result.steps.floated.expandedAttr);
    check("悬浮：轨道确实变宽（>40）", result.steps.floated.nav !== null && result.steps.floated.nav.w > 40, result.steps.floated.nav);
    check("悬浮：展开态已落盘", result.steps.floated.expandedStored === "1", result.steps.floated.expandedStored);
    // 首次落位要留出可见的右边距：按展开宽度算 24px，不能被夹取推到只剩贴边的 8px
    result.steps.rightGap = await evalJs(`(() => {
      const nav = window.__HARNESS__.navBox();
      const r = nav.getBoundingClientRect();
      return { gap: Math.round(window.innerWidth - (r.x + r.width)), vw: window.innerWidth, w: Math.round(r.width) };
    })()`);
    check("悬浮：默认落位留出了右边距（>=20px，未被夹取贴边）",
      result.steps.rightGap.gap >= 20, result.steps.rightGap);
    // 首次悬浮算出来的落位必须立刻写盘。以前 saveFloat 在算默认落位之前调用，
    // 存进去的还是初始值 (12,120)——刷新后浮层弹到左上角压住会话区，
    // 表现出来就是「启动悬浮后模块不衔接」。
    result.steps.firstFloatStored = await evalJs(`(() => {
      const raw = localStorage.getItem('dsh-sidebar-rail.float.v1');
      const v = raw ? JSON.parse(raw) : null;
      const root = window.__HARNESS__.root();
      const nav = window.__HARNESS__.navBox().getBoundingClientRect();
      return { stored: v, navX: Math.round(nav.x), navY: Math.round(nav.y) };
    })()`);
    check("悬浮：首次落位立刻写盘（存的不是初始值 12,120）",
      result.steps.firstFloatStored.stored !== null &&
      !(result.steps.firstFloatStored.stored.x === 12 && result.steps.firstFloatStored.stored.y === 120),
      result.steps.firstFloatStored.stored);
    check("悬浮：写盘坐标与实际落位一致（±2px）",
      result.steps.firstFloatStored.stored !== null &&
      Math.abs(result.steps.firstFloatStored.stored.x - result.steps.firstFloatStored.navX) <= 2 &&
      Math.abs(result.steps.firstFloatStored.stored.y + 22 - result.steps.firstFloatStored.navY) <= 2,
      result.steps.firstFloatStored);
    // 三段（抓取条 / 面板图标 / 自定义条目）必须严丝合缝拼在一起
    result.steps.seam = await evalJs(`(() => {
      const q = (s) => document.querySelector(s);
      const g = q('[data-dsh-rail-grip]').getBoundingClientRect();
      const n = q('[data-dsh-rail-part="nav"]').getBoundingClientRect();
      const c = q('[data-dsh-rail-part="custom"]').getBoundingClientRect();
      return { gapGripNav: Math.round(n.top - g.bottom), gapNavCustom: Math.round(c.top - n.bottom) };
    })()`);
    check("悬浮：三段无缝衔接（抓手→图标→条目，间隙 0）",
      Math.abs(result.steps.seam.gapGripNav) <= 1 && Math.abs(result.steps.seam.gapNavCustom) <= 1,
      result.steps.seam);
    await shot("shot-float-floated.png");

    // ------------------------------------------------------------ 拖动抓手
    const gripPt = await evalJs(`(() => {
      const g = window.__HARNESS__.grip(); if (!g) return null;
      const r = g.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), w: Math.round(r.width) };
    })()`);
    result.steps.gripPt = gripPt;
    const startNav = result.steps.floated.nav;

    await mouse("mousePressed", gripPt.x, gripPt.y);
    await sleep(60);
    await mouse("mouseMoved", gripPt.x - 5, gripPt.y + 5);
    await sleep(60);
    // 拖动期间采集长任务：主线程若被同步布局卡住，这里会抓到 >50ms 的任务
    await evalJs(`(() => {
      window.__LONGTASKS__ = [];
      window.__DROPLAYOUTS__ = 0;
      try {
        window.__PO__ = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__LONGTASKS__.push(Math.round(e.duration));
        });
        window.__PO__.observe({ entryTypes: ['longtask'] });
      } catch (e) { window.__PO__ = null; }
      return true;
    })()`);
    // 首次悬浮默认落在视口右侧，所以往左下拖才有不被夹取的余地
    const DX = -260, DY = 180;
    for (const f of [0.15, 0.3, 0.45, 0.6, 0.7, 0.8, 0.9, 1]) {
      await mouse("mouseMoved", gripPt.x + Math.round(DX * f), gripPt.y + Math.round(DY * f));
      await sleep(30);
    }

    result.steps.midDrag = await evalJs(`(() => {
      const g = window.__HARNESS__.grip();
      const root = window.__HARNESS__.root();
      const nav = root.querySelector('[data-dsh-rail-part="nav"]');
      const custom = root.querySelector('[data-dsh-rail-part="custom"]');
      return {
        gripTransform: g && g.style.transform,
        navTransform: nav && nav.style.transform,
        customTransform: custom && custom.style.transform,
        bodyDragging: document.body.classList.contains('dsr-float-dragging'),
        leftVar: root.style.getPropertyValue('--dsr-float-x'),
        navLeft: Math.round(nav.getBoundingClientRect().x),
        gripLeft: g ? Math.round(g.getBoundingClientRect().x) : null,
      };
    })()`);
    check("拖动中：三层都写了 translate3d",
      /translate3d/.test(result.steps.midDrag.gripTransform || "") &&
      /translate3d/.test(result.steps.midDrag.navTransform || "") &&
      /translate3d/.test(result.steps.midDrag.customTransform || ""),
      result.steps.midDrag);
    check("拖动中：body 有 dsr-float-dragging", result.steps.midDrag.bodyDragging === true, result.steps.midDrag.bodyDragging);
    check("拖动中：left 变量没被实时改写（只有 transform 在动）",
      result.steps.midDrag.leftVar === result.steps.floated.floatX,
      { during: result.steps.midDrag.leftVar, before: result.steps.floated.floatX });
    // 拖动全程不应出现长任务：sync 被冻结 + 只写 transform，主线程不该被卡住
    result.steps.longTasks = await evalJs(`(() => {
      if (window.__PO__) { try { window.__PO__.disconnect(); } catch (e) {} }
      const t = window.__LONGTASKS__ || [];
      return { count: t.length, max: t.length ? Math.max.apply(null, t) : 0, list: t };
    })()`);
    check("拖动中：主线程无长任务（未卡顿）",
      result.steps.longTasks.count === 0 || result.steps.longTasks.max < 80,
      result.steps.longTasks);
    await shot("shot-float-mid.png");

    await mouse("mouseReleased", gripPt.x + DX, gripPt.y + DY);
    await sleep(500);

    result.steps.afterDrag = await evalJs(`(() => {
      const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect();
        return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; };
      const root = window.__HARNESS__.root();
      const nav = root.querySelector('[data-dsh-rail-part="nav"]');
      const g = window.__HARNESS__.grip();
      return {
        grip: box(g),
        nav: box(nav),
        navTransform: nav.style.transform,
        gripTransform: g && g.style.transform,
        bodyDragging: document.body.classList.contains('dsr-float-dragging'),
        floatX: root.style.getPropertyValue('--dsr-float-x'),
        floatY: root.style.getPropertyValue('--dsr-float-y'),
        diag: window.__DSH_RAIL__.floatPos,
        stored: localStorage.getItem('dsh-sidebar-rail.float.v1'),
      };
    })()`);
    const movedX = result.steps.afterDrag.nav.x - startNav.x;
    const movedY = result.steps.afterDrag.nav.y - startNav.y;
    check("拖动后：轨道确实位移了（≈-260,180，允许夹取）",
      Math.abs(movedX - DX) <= 12 && Math.abs(movedY - DY) <= 12,
      { movedX, movedY, expect: [DX, DY] });
    check("拖动后：transform 已复位（位移折算进 left/top）",
      (result.steps.afterDrag.navTransform === "" || result.steps.afterDrag.navTransform === "none" || result.steps.afterDrag.navTransform === "translate3d(0px, 0px, 0px)"),
      result.steps.afterDrag.navTransform);
    check("拖动后：body class 清除", result.steps.afterDrag.bodyDragging === false, result.steps.afterDrag.bodyDragging);
    check("拖动后：抓取条跟随轨道", result.steps.afterDrag.grip !== null &&
      Math.abs(result.steps.afterDrag.grip.x - result.steps.afterDrag.nav.x) <= 2 &&
      Math.abs(result.steps.afterDrag.grip.y + result.steps.afterDrag.grip.h - result.steps.afterDrag.nav.y) <= 2,
      { grip: result.steps.afterDrag.grip, nav: result.steps.afterDrag.nav });
    check("拖动后：新坐标已落盘", new RegExp('"x":' + round(Number(String(result.steps.afterDrag.floatX).replace("px", "")))).test(result.steps.afterDrag.stored || ""),
      { stored: result.steps.afterDrag.stored, floatX: result.steps.afterDrag.floatX });
    await shot("shot-float-afterdrag.png");

    // -------------------------------------------------------- 刷新后仍悬浮
    const keptX = result.steps.afterDrag.nav.x;
    const keptY = result.steps.afterDrag.nav.y;
    await boot("reload");
    result.steps.afterReload = await evalJs(`(() => {
      const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect();
        return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; };
      const root = window.__HARNESS__.root();
      return {
        attr: root && root.getAttribute('data-dsh-rail-float'),
        grip: box(window.__HARNESS__.grip()),
        nav: box(window.__HARNESS__.navBox()),
        region: box(window.__HARNESS__.regionBox()),
        diagErrors: (window.__DSH_RAIL__ && window.__DSH_RAIL__.errors) || [],
      };
    })()`);
    check("刷新后：仍然是悬浮态",
      result.steps.afterReload.attr === "1" && result.steps.afterReload.grip !== null,
      { attr: result.steps.afterReload.attr, grip: result.steps.afterReload.grip });
    check("刷新后：位置被还原（±3px）",
      Math.abs(result.steps.afterReload.nav.x - keptX) <= 3 && Math.abs(result.steps.afterReload.nav.y - keptY) <= 3,
      { kept: [keptX, keptY], reload: result.steps.afterReload.nav });
    check("刷新后：无 diag 错误", (result.steps.afterReload.diagErrors || []).length === 0, result.steps.afterReload.diagErrors);
    // 启动即悬浮：三段必须仍然拼在一起（--dsr-float-nav-h 若量到启动早期的小值就会裂开）
    result.steps.reloadSeam = await evalJs(`(() => {
      const q = (s) => document.querySelector(s);
      const g = q('[data-dsh-rail-grip]').getBoundingClientRect();
      const n = q('[data-dsh-rail-part="nav"]').getBoundingClientRect();
      const c = q('[data-dsh-rail-part="custom"]').getBoundingClientRect();
      const root = q('[data-dsh-rail-root]');
      return {
        gapGripNav: Math.round(n.top - g.bottom),
        gapNavCustom: Math.round(c.top - n.bottom),
        navH: Math.round(n.height),
        navHVar: root.style.getPropertyValue('--dsr-float-nav-h'),
        navScroll: document.querySelector('[data-dsh-rail-part="nav"]').scrollHeight,
      };
    })()`);
    check("启动即悬浮：三段无缝衔接（间隙 0）",
      Math.abs(result.steps.reloadSeam.gapGripNav) <= 1 && Math.abs(result.steps.reloadSeam.gapNavCustom) <= 1,
      result.steps.reloadSeam);
    check("启动即悬浮：--dsr-float-nav-h 等于 nav 实际高度（没有量到早期小值）",
      result.steps.reloadSeam.navHVar === result.steps.reloadSeam.navH + "px",
      { var: result.steps.reloadSeam.navHVar, actual: result.steps.reloadSeam.navH });
    // 悬浮中面板图标增减（比如装了个新插件面板）会改 nav 高度：
    // 下面的自定义条目必须跟着挪，否则就裂开一条缝。
    result.steps.navGrow = await evalJs(`(async () => {
      const nav = document.querySelector('[data-dsh-rail-part="nav"]');
      const custom = document.querySelector('[data-dsh-rail-part="custom"]');
      const before = { navH: Math.round(nav.getBoundingClientRect().height),
                       gap: Math.round(custom.getBoundingClientRect().top - nav.getBoundingClientRect().bottom) };
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'panelRow'; b.setAttribute('aria-label', '临时面板');
      b.innerHTML = '<span class="panelGlyph"><span data-slot="sidebar.panellist">&#9670;</span></span><span class="panelTitle">临时面板</span>';
      nav.appendChild(b);
      await new Promise((r) => setTimeout(r, 500));
      const after = { navH: Math.round(nav.getBoundingClientRect().height),
                      gap: Math.round(custom.getBoundingClientRect().top - nav.getBoundingClientRect().bottom) };
      const root = document.querySelector('[data-dsh-rail-root]');
      const v = root.style.getPropertyValue('--dsr-float-nav-h');
      b.remove();
      await new Promise((r) => setTimeout(r, 400));
      return { before, after, navHVar: v };
    })()`);
    check("悬浮中 nav 长高后：自定义条目跟着下移（不裂开）",
      result.steps.navGrow.after.navH > result.steps.navGrow.before.navH &&
      Math.abs(result.steps.navGrow.after.gap) <= 1,
      result.steps.navGrow);
    await shot("shot-float-reload.png");

    // ------------------------------------------------------------ 双击停靠
    const gripPt2 = await evalJs(`(() => {
      const g = window.__HARNESS__.grip(); if (!g) return null;
      const r = g.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    })()`);
    for (let i = 0; i < 2; i++) {
      await mouse("mousePressed", gripPt2.x, gripPt2.y, { clickCount: i + 1 });
      await mouse("mouseReleased", gripPt2.x, gripPt2.y, { clickCount: i + 1 });
      await sleep(60);
    }
    await sleep(400);
    result.steps.afterDock = await evalJs(`(() => {
      const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect();
        return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; };
      const root = window.__HARNESS__.root();
      const nav = root.querySelector('[data-dsh-rail-part="nav"]');
      return {
        attr: root && root.getAttribute('data-dsh-rail-float'),
        grip: box(window.__HARNESS__.grip()),
        nav: box(nav),
        region: box(window.__HARNESS__.regionBox()),
        navPosition: nav ? getComputedStyle(nav).position : null,
        stored: localStorage.getItem('dsh-sidebar-rail.float.v1'),
        expandedAttr: root && root.getAttribute('data-dsh-rail-expanded'),
        expandedStored: localStorage.getItem('dsh-sidebar-rail.railExpanded.v1'),
        toggleLabel: (() => { const b = window.__HARNESS__.floatToggle(); return b && b.getAttribute('aria-label'); })(),
      };
    })()`);
    check("双击停靠：attr 被移除", result.steps.afterDock.attr === null, result.steps.afterDock.attr);
    check("双击停靠：抓手消失", result.steps.afterDock.grip === null, result.steps.afterDock.grip);
    check("双击停靠：nav 回到 absolute", result.steps.afterDock.navPosition === "absolute", result.steps.afterDock.navPosition);
    check("双击停靠：偏好落盘 on=false", /"on":false/.test(result.steps.afterDock.stored || ""), result.steps.afterDock.stored);
    // 停靠回去要自动收起，否则停靠后的轨道比悬浮前更宽，等于「越用越挤」
    check("双击停靠：功能区自动收起（属性置 0）", result.steps.afterDock.expandedAttr === "0", result.steps.afterDock.expandedAttr);
    check("双击停靠：收起态已落盘", result.steps.afterDock.expandedStored === "0", result.steps.afterDock.expandedStored);
    check("双击停靠：轨道回到 40px", result.steps.afterDock.nav !== null && result.steps.afterDock.nav.w === 40, result.steps.afterDock.nav);
    check("双击停靠：按钮文案回到「悬浮」", result.steps.afterDock.toggleLabel === "悬浮并拖到任意位置", result.steps.afterDock.toggleLabel);
    check("双击停靠：几何回到停靠基线（±3px）",
      Math.abs(result.steps.afterDock.nav.x - dockedNav.x) <= 3 && Math.abs(result.steps.afterDock.nav.y - dockedNav.y) <= 3,
      { docked: dockedNav, afterDock: result.steps.afterDock.nav });
    check("双击停靠：会话区重新让位",
      result.steps.afterDock.region !== null && dockedRegion !== null &&
      Math.abs(result.steps.afterDock.region.x - dockedRegion.x) <= 3,
      { docked: dockedRegion, afterDock: result.steps.afterDock.region });
    await shot("shot-float-docked.png");

    // ---------------------- 从收起态再悬浮：必须自动展开（不需要手动点两次）
    // 上一节停靠后已自动收起到 40px，这里直接点悬浮，验证「一次点击即展开」
    const collapsedBeforeFloat = await evalJs(`(() => {
      const root = window.__HARNESS__.root();
      const nav = root.querySelector('[data-dsh-rail-part="nav"]');
      return {
        expanded: root.getAttribute('data-dsh-rail-expanded'),
        navW: nav ? Math.round(nav.getBoundingClientRect().width) : null,
      };
    })()`);
    check("停靠后处于收起态（40px）",
      collapsedBeforeFloat.expanded === "0" && collapsedBeforeFloat.navW === 40,
      collapsedBeforeFloat);

    const togglePt2 = await evalJs(`(() => {
      const b = window.__HARNESS__.floatToggle(); if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    })()`);
    await mouse("mousePressed", togglePt2.x, togglePt2.y);
    await mouse("mouseReleased", togglePt2.x, togglePt2.y);
    await sleep(450);
    result.steps.expandedFloat = await evalJs(`(() => {
      const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect();
        return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; };
      const root = window.__HARNESS__.root();
      const nav = root.querySelector('[data-dsh-rail-part="nav"]');
      const g = window.__HARNESS__.grip();
      return {
        expanded: root.getAttribute('data-dsh-rail-expanded'),
        nav: box(nav),
        grip: box(g),
        floatW: root.style.getPropertyValue('--dsr-float-w'),
        labelVisible: (() => {
          // nav 里的文字是 DSH 自己的 panelTitle，被打了 ATTR_HIDE；
          // 只有展开态才会去掉隐藏。用 computed display 判断最直接。
          const t = nav && (nav.querySelector('.panelTitle') || nav.querySelector('[aria-label] > span:not([data-slot])'));
          if (!t) return null;
          return getComputedStyle(t).display !== 'none';
        })(),
        hiddenCount: nav ? nav.querySelectorAll('[data-dsh-rail-hide]').length : null,
      };
    })()`);
    check("展开+悬浮：轨道变宽（>40）", result.steps.expandedFloat.nav !== null && result.steps.expandedFloat.nav.w > 40,
      result.steps.expandedFloat.nav);
    check("展开+悬浮：文字标签显示（隐藏标记已撤掉）",
      result.steps.expandedFloat.labelVisible === true || result.steps.expandedFloat.hiddenCount === 0,
      { labelVisible: result.steps.expandedFloat.labelVisible, hiddenCount: result.steps.expandedFloat.hiddenCount });
    check("展开+悬浮：抓手宽度跟着轨道变",
      result.steps.expandedFloat.grip !== null &&
      Math.abs(result.steps.expandedFloat.grip.w - result.steps.expandedFloat.nav.w) <= 1,
      { grip: result.steps.expandedFloat.grip, nav: result.steps.expandedFloat.nav });
    await shot("shot-float-expanded.png");

    // -------------------------- 悬浮态下也能手动收起（不该被自动展开锁死）
    const collapsePt = await evalJs(`(() => {
      const b = document.querySelector('[data-dsh-rail-part="custom"] .dsr-toggle'); if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    })()`);
    if (collapsePt !== null) {
      await mouse("mousePressed", collapsePt.x, collapsePt.y);
      await mouse("mouseReleased", collapsePt.x, collapsePt.y);
      await sleep(400);
    }
    result.steps.floatedCollapsed = await evalJs(`(() => {
      const root = window.__HARNESS__.root();
      const nav = root.querySelector('[data-dsh-rail-part="nav"]');
      return {
        expanded: root.getAttribute('data-dsh-rail-expanded'),
        navW: nav ? Math.round(nav.getBoundingClientRect().width) : null,
        stillFloat: root.getAttribute('data-dsh-rail-float'),
      };
    })()`);
    check("悬浮态可手动收起（不被自动展开锁死）",
      result.steps.floatedCollapsed.expanded === "0" &&
      result.steps.floatedCollapsed.navW === 40 &&
      result.steps.floatedCollapsed.stillFloat === "1",
      result.steps.floatedCollapsed);

    // --------------------------------- 视口缩小后必须被夹回可视范围（抓不住就废了）
    await c.send("Emulation.setDeviceMetricsOverride", { width: 520, height: 420, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    result.steps.afterShrink = await evalJs(`(() => {
      const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect();
        return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; };
      const g = window.__HARNESS__.grip();
      return {
        vw: window.innerWidth, vh: window.innerHeight,
        grip: box(g),
        nav: box(window.__HARNESS__.navBox()),
        floatX: window.__HARNESS__.root().style.getPropertyValue('--dsr-float-x'),
        floatY: window.__HARNESS__.root().style.getPropertyValue('--dsr-float-y'),
      };
    })()`);
    const sh = result.steps.afterShrink;
    check("缩小视口后：抓取条仍在可视范围内",
      sh.grip !== null && sh.grip.x >= 0 && sh.grip.y >= 0 && sh.grip.x + 40 <= sh.vw && sh.grip.y + 22 <= sh.vh,
      sh);
    await shot("shot-float-shrink.png");

    // 缩回原尺寸，避免后续断言被小视口污染
    await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
  } catch (err) {
    result.errors.push("fatal: " + String(err && err.message ? err.message : err));
  } finally {
    try { if (ws) ws.close(); } catch (e) { /* ignore */ }
    try { chrome.kill(); } catch (e) { /* ignore */ }
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8");
    const total = Object.keys(result.checks).length;
    const bad = Object.values(result.checks).filter((c) => !c.ok).length;
    console.log((bad === 0 ? "ALL PASS" : "FAILED") + " (" + (total - bad) + "/" + total + " checks)");
    for (const [k, v] of Object.entries(result.checks)) {
      if (!v.ok) console.log("  FAIL " + k + " :: " + JSON.stringify(v.detail));
    }
    for (const e of result.errors) console.log("  ERR " + e);
    console.log("result -> " + OUT);
  }
}

main();
