// probes/drag-probe.cjs — 真实浏览器回归：静态回归台 + 真实鼠标事件（不开宿主）
// 用法：node probes/drag-probe.cjs
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9351;
const HERE = __dirname;
const PROFILE = path.join(HERE, ".probe-chrome-dragv");
const PAGE = "file:///" + path.join(HERE, "drag-harness.html").replace(/\\/g, "/");
const OUT = path.join(HERE, "drag-probe-result.json");

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
    } catch (e) { /* not up yet */ }
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
  const result = { page: PAGE, startedAt: new Date().toISOString(), steps: {}, errors: [] };
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
      if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails.text || r.exceptionDetails));
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

    await c.send("Page.navigate", { url: PAGE });
    // 等 harness 就绪
    let ready = false;
    for (let i = 0; i < 120; i++) {
      if (await evalJs("typeof window.__HARNESS__ !== 'undefined'")) { ready = true; break; }
      await sleep(250);
    }
    result.harnessReady = ready;
    if (!ready) {
      result.errors.push("harness not ready: " + (await evalJs("document.title")));
      throw new Error("harness not ready");
    }
    await sleep(600);

    result.steps.boot = await evalJs(`(() => ({
      injected: window.__HARNESS__.injected,
      registered: window.__HARNESS__.registered,
      diag: {
        loaded: window.__DSH_RAIL__ && window.__DSH_RAIL__.loaded,
        tagged: window.__DSH_RAIL__ && window.__DSH_RAIL__.tagged,
        errors: (window.__DSH_RAIL__ && window.__DSH_RAIL__.errors) || [],
        anchors: window.__DSH_RAIL__ && window.__DSH_RAIL__.anchors,
      },
      navLabels: window.__HARNESS__.labelsInDomOrder(),
      visualNav: window.__HARNESS__.visualNavOrder(),
      visualEntries: window.__HARNESS__.visualEntryOrder(),
      railWidthVar: getComputedStyle(document.querySelector('[data-dsh-rail-root]')).getPropertyValue('--dsr-rail-w'),
      navBox: (() => { const b = document.querySelector('[data-dsh-rail-part="nav"]').getBoundingClientRect(); return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)}; })(),
      regionBox: (() => { const b = document.querySelector('[data-dsh-rail-part="region"]').getBoundingClientRect(); return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)}; })(),
    }))()`);
    await shot("shot-dragv-boot.png");

    // 记录初始顺序，用于后续对比
    const navBefore = result.steps.boot.visualNav;

    // 取第一个 nav 按钮的中心点（按视觉顺序）
    const firstBtn = await evalJs(`(() => {
      const btns = Array.from(document.querySelectorAll('[data-dsh-rail-part="nav"] > button'))
        .filter(b => !(b.getAttribute("aria-haspopup") === "menu" || b.hasAttribute("aria-expanded")))
        .sort((a,b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      const b = btns[0], r = b.getBoundingClientRect();
      return { label: b.getAttribute("aria-label"), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    })()`);
    result.steps.grab = firstBtn;

    // 真实鼠标：按下 → 小步移动（越过 4px 阈值）→ 继续下移
    await mouse("mousePressed", firstBtn.x, firstBtn.y);
    await sleep(60);
    await mouse("mouseMoved", firstBtn.x, firstBtn.y + 6);
    await sleep(60);
    for (const dy of [24, 60, 100, 140]) {
      await mouse("mouseMoved", firstBtn.x, firstBtn.y + dy);
      await sleep(70);
    }

    // 拖拽中：ghost、body class、是否出现运行中的 FLIP 动画、预览顺序有没有被 sync 打回
    result.steps.midDrag = await evalJs(`(() => {
      const nav = document.querySelector('[data-dsh-rail-part="nav"]');
      const btns = Array.from(nav.querySelectorAll(':scope > button'));
      const anims = [];
      btns.forEach(b => b.getAnimations().forEach(a => anims.push({
        label: b.getAttribute("aria-label"),
        state: a.playState,
        currentTime: Math.round(a.currentTime || 0),
      })));
      return {
        ghostCount: document.querySelectorAll('.dsr-ghost').length,
        ghostBox: (() => { const g = document.querySelector('.dsr-ghost'); if (!g) return null; const r = g.getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; })(),
        bodyDragging: document.body.classList.contains('dsr-dragging-active'),
        ghostOpacity: (() => { const g = document.querySelector('.dsr-ghost'); return g ? getComputedStyle(g).opacity : null; })(),
        draggingCount: document.querySelectorAll('.dsr-dragging').length,
        draggingOpacity: (() => { const d = document.querySelector('.dsr-dragging'); return d ? getComputedStyle(d).opacity : null; })(),
        visualNav: window.__HARNESS__.visualNavOrder(),
        orders: btns.map(b => ({ label: b.getAttribute("aria-label"), order: b.style.order })),
        animations: anims,
        stored: localStorage.getItem('dsh-sidebar-rail.navOrder.v1'),
      };
    })()`);
    await shot("shot-dragv-mid.png");

    // 松手
    await mouse("mouseReleased", firstBtn.x, firstBtn.y + 140);
    await sleep(500);

    result.steps.afterDrop = await evalJs(`(() => ({
      ghostCount: document.querySelectorAll('.dsr-ghost').length,
      bodyDragging: document.body.classList.contains('dsr-dragging-active'),
      draggingCount: document.querySelectorAll('.dsr-dragging').length,
      visualNav: window.__HARNESS__.visualNavOrder(),
      stored: localStorage.getItem('dsh-sidebar-rail.navOrder.v1'),
      orders: Array.from(document.querySelectorAll('[data-dsh-rail-part="nav"] > button')).map(b => ({ label: b.getAttribute("aria-label"), order: b.style.order })),
    }))()`);
    await shot("shot-dragv-after.png");
    result.navBefore = navBefore;
    result.navChanged = JSON.stringify(navBefore) !== JSON.stringify(result.steps.afterDrop.visualNav);

    // 刷新验证持久化
    await c.send("Page.reload", { ignoreCache: true });
    for (let i = 0; i < 120; i++) {
      if (await evalJs("typeof window.__HARNESS__ !== 'undefined'")) break;
      await sleep(250);
    }
    await sleep(700);
    result.steps.afterReload = await evalJs(`(() => ({
      visualNav: window.__HARNESS__.visualNavOrder(),
      visualEntries: window.__HARNESS__.visualEntryOrder(),
      stored: localStorage.getItem('dsh-sidebar-rail.navOrder.v1'),
    }))()`);

    // 拖拽自定义条目（custom 轨道）：把第一个条目往下拖
    const entryGrab = await evalJs(`(() => {
      const btns = Array.from(document.querySelectorAll('[data-dsh-rail-part="custom"] .dsr-btn'))
        .filter(b => !b.classList.contains('dsr-toggle'))
        .sort((a,b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      if (!btns.length) return null;
      const b = btns[0], r = b.getBoundingClientRect();
      return { label: b.getAttribute("aria-label"), id: b.getAttribute("data-dsr-entry-id"), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), count: btns.length };
    })()`);
    result.steps.entryGrab = entryGrab;
    if (entryGrab && entryGrab.count > 1) {
      await mouse("mousePressed", entryGrab.x, entryGrab.y);
      await sleep(60);
      await mouse("mouseMoved", entryGrab.x, entryGrab.y + 6);
      await sleep(60);
      // 条目间距是 36+2=38，要跨过第二项中点需要 > 38；给足 2 项的距离
      for (const dy of [20, 44, 70, 82]) {
        await mouse("mouseMoved", entryGrab.x, entryGrab.y + dy);
        await sleep(70);
      }
      result.steps.entryMidDrag = await evalJs(`(() => ({
        ghostCount: document.querySelectorAll('.dsr-ghost').length,
        ghostOpacity: (() => { const g = document.querySelector('.dsr-ghost'); return g ? getComputedStyle(g).opacity : null; })(),
        visualEntries: window.__HARNESS__.visualEntryOrder(),
      }))()`);
      await mouse("mouseReleased", entryGrab.x, entryGrab.y + 82);
      await sleep(400);
      result.steps.entryAfterDrop = await evalJs(`(() => ({
        ghostCount: document.querySelectorAll('.dsr-ghost').length,
        visualEntries: window.__HARNESS__.visualEntryOrder(),
        stored: localStorage.getItem('dsh-sidebar-rail.custom.v1'),
      }))()`);
      await shot("shot-dragv-entry.png");
    }

    // 展开态下的拖拽：轨道 180px、标签可见，ghost 应带 dsr-ghost-wide 且宽度跟随轨道
    await evalJs("localStorage.setItem('dsh-sidebar-rail.railExpanded.v1','1')");
    await c.send("Page.reload", { ignoreCache: true });
    for (let i = 0; i < 120; i++) {
      if (await evalJs("typeof window.__HARNESS__ !== 'undefined'")) break;
      await sleep(250);
    }
    await sleep(700);
    result.steps.expandedBoot = await evalJs(`(() => {
      const nav = document.querySelector('[data-dsh-rail-part="nav"]');
      const r = nav.getBoundingClientRect();
      const label = document.querySelector('[data-dsh-rail-part="nav"] button .panelTitle');
      return {
        expanded: window.__DSH_RAIL__ && window.__DSH_RAIL__.expanded,
        railWidth: window.__DSH_RAIL__ && window.__DSH_RAIL__.railWidth,
        navW: Math.round(r.width),
        labelVisible: label ? getComputedStyle(label).display !== 'none' : null,
        visualNav: window.__HARNESS__.visualNavOrder(),
      };
    })()`);
    const expGrab = await evalJs(`(() => {
      const btns = Array.from(document.querySelectorAll('[data-dsh-rail-part="nav"] > button'))
        .filter(b => !(b.getAttribute("aria-haspopup") === "menu" || b.hasAttribute("aria-expanded")))
        .sort((a,b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      const b = btns[btns.length - 1], r = b.getBoundingClientRect();
      return { label: b.getAttribute("aria-label"), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    })()`);
    await mouse("mousePressed", expGrab.x, expGrab.y);
    await sleep(60);
    await mouse("mouseMoved", expGrab.x, expGrab.y - 6);
    await sleep(60);
    for (const dy of [-30, -70, -110, -150]) {
      await mouse("mouseMoved", expGrab.x, expGrab.y + dy);
      await sleep(70);
    }
    result.steps.expandedMidDrag = await evalJs(`(() => {
      const g = document.querySelector('.dsr-ghost');
      const gr = g ? g.getBoundingClientRect() : null;
      return {
        ghostCount: document.querySelectorAll('.dsr-ghost').length,
        ghostWide: g ? g.classList.contains('dsr-ghost-wide') : null,
        ghostBox: gr ? {x:Math.round(gr.x),y:Math.round(gr.y),w:Math.round(gr.width),h:Math.round(gr.height)} : null,
        ghostOpacity: g ? getComputedStyle(g).opacity : null,
        visualNav: window.__HARNESS__.visualNavOrder(),
      };
    })()`);
    await mouse("mouseReleased", expGrab.x, expGrab.y - 150);
    await sleep(400);
    result.steps.expandedAfterDrop = await evalJs(`(() => ({
      ghostCount: document.querySelectorAll('.dsr-ghost').length,
      visualNav: window.__HARNESS__.visualNavOrder(),
      stored: localStorage.getItem('dsh-sidebar-rail.navOrder.v1'),
      railW: Math.round(document.querySelector('[data-dsh-rail-part="nav"]').getBoundingClientRect().width),
      regionMl: getComputedStyle(document.querySelector('[data-dsh-rail-part="region"]')).marginLeft,
    }))()`);
    await shot("shot-dragv-expanded.png");
    await evalJs("localStorage.clear()");

    // 布局没被拖拽破坏的最终确认
    result.steps.finalBoxes = await evalJs(`(() => {
      const pick = (sel) => { const n = document.querySelector(sel); if (!n) return null;
        const r = n.getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; };
      return {
        root: pick('[data-dsh-rail-root]'),
        nav: pick('[data-dsh-rail-part="nav"]'),
        region: pick('[data-dsh-rail-part="region"]'),
        custom: pick('[data-dsh-rail-part="custom"]'),
        regionMl: getComputedStyle(document.querySelector('[data-dsh-rail-part="region"]')).marginLeft,
        sessionRows: document.querySelectorAll('[data-slot="sidebar.workspaces"] .sessionRow').length,
        diagErrors: (window.__DSH_RAIL__ && window.__DSH_RAIL__.errors) || [],
      };
    })()`);
  } catch (err) {
    result.errors.push(String(err && err.stack || err));
  } finally {
    try { if (ws) ws.close(); } catch (e) {}
    try { chrome.kill(); } catch (e) {}
    await sleep(400);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  }
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
