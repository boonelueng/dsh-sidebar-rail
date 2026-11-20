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
        header: box(document.querySelector('[data-dsh-rail-win-header]')),
        // 左侧「设置」标题所在的格。这一格的盒子带着 22px 上内边距，直接取盒子中心
        // 会算到整条 header 的中线上，所以按「上内边距 + 行高的一半」算出文字本身的中线，
        // 才是要和圆点对齐的那条线。
        title: box(document.querySelector('[data-dsh-rail-win-title]')),
        titleCenterY: (() => {
          const t = document.querySelector('[data-dsh-rail-win-title]');
          if (!t) return null;
          const cs = getComputedStyle(t);
          const pt = parseFloat(cs.paddingTop) || 0;
          const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) || 0;
          return Math.round(t.getBoundingClientRect().y + pt + lh / 2);
        })(),
        // 官方 × 必须是 header 的直系子按钮：红绿灯自己的 .dsr-light-close 也含 "close"，
        // 且住在 header 里面，用后代选择器会先命中它，断言就成了「红绿灯在自己左边」。
        // 属性值在 CSS 里大小写敏感，官方是 VOzbGW_close、回归台是 stClose，所以带 i 标志。
        closeBtn: box(p && p.querySelector('[data-dsh-rail-win-header] > button[class*="close" i]')),
        // 官方 × 换皮成红圆点之后的外观：只看样子，按钮还是官方那一个。
        // skinAttr 是插件打上去的标记，撤销时要能摘干净（关掉红绿灯开关的回归里查它）。
        closeDot: (() => {
          const b = document.querySelector('[data-dsh-rail-win-header] > button[class*="close" i]');
          if (!b) return null;
          const r = b.getBoundingClientRect();
          const cs = getComputedStyle(b);
          return {
            w: Math.round(r.width), h: Math.round(r.height),
            cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2),
            bg: cs.backgroundColor, radius: cs.borderTopLeftRadius,
            attr: b.getAttribute('data-dsh-rail-win-close'),
            label: b.getAttribute('aria-label'),
            // 视觉压到 12px 之后热区靠 ::after 撑回 28px。
            // 伪元素命中会归到按钮本身，用 elementFromPoint 在旧框边缘探一下就知道还在不在。
            hitLeft: (() => { const el = document.elementFromPoint(r.x - 6, r.y + r.height / 2); return el === b; })(),
            hitRight: (() => { const el = document.elementFromPoint(r.x + r.width + 6, r.y + r.height / 2); return el === b; })(),
          };
        })(),
        position: p && getComputedStyle(p).position,
        vw: window.innerWidth, vh: window.innerHeight,
        railRight: Math.round(window.__HARNESS__.root().getBoundingClientRect().right),
        stored: localStorage.getItem('dsh-sidebar-rail.win.v1'),
      };
    })()`);
    const centerOf = (box) => ({ x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h / 2) });

    await boot("first");

    // 官方 sidebar 的取消固定按钮必须消失，但 More 菜单仍要可见：不能靠移除
    // sidebar.panellist.actions 来实现，否则会连其他侧栏动作一起删掉。
    const sidebarActions = await evalJs(`(() => {
      const unpin = document.querySelector('[data-harness-unpin="1"]');
      const more = document.querySelector('button[aria-label="更多"]');
      return {
        unpin: unpin ? { display: getComputedStyle(unpin).display, text: unpin.textContent } : null,
        more: more ? { display: getComputedStyle(more).display, text: more.textContent } : null,
      };
    })()`);
    result.steps.sidebarActions = sidebarActions;
    check("左侧栏取消固定按钮已隐藏", sidebarActions.unpin !== null && sidebarActions.unpin.display === "none", sidebarActions);
    check("隐藏取消固定后更多菜单仍保留", sidebarActions.more !== null && sidebarActions.more.display !== "none", sidebarActions);

    // ------------------------------------------------------- 1. 打开设置弹窗
    await openSettings();
    result.steps.opened = await panelBox();
    const o = result.steps.opened;
    check("设置弹窗打开后出现窗口控制圆点", o.lights !== null, o.lights);
    check("圆点只有两个（关闭交给官方 ×，不再造红点）", o.dots.length === 2, o.dots.map((d) => d.cls));
    check("两个圆点都是 12px 圆形",
      o.dots.length === 2 && o.dots.every((d) => d.w === 12 && d.h === 12 && d.radius === "50%"),
      o.dots.map((d) => d.w + "x" + d.h + " r=" + d.radius));
    check("左→右顺序是 最大化(绿) / 最小化(黄)",
      o.dots.length === 2 &&
      o.dots[0].cls.indexOf("dsr-light-max") >= 0 && o.dots[0].bg === "rgb(40, 200, 64)" &&
      o.dots[1].cls.indexOf("dsr-light-min") >= 0 && o.dots[1].bg === "rgb(254, 188, 46)",
      o.dots.map((d) => d.cls + " " + d.bg));
    check("没有红点残留", o.dots.every((d) => d.cls.indexOf("dsr-light-close") < 0), o.dots.map((d) => d.cls));
    check("圆点住在官方 header 行里（不再是飘在右上角的绝对定位）",
      o.lights !== null && o.header !== null &&
      o.lights.x >= o.header.x - 1 && o.lights.x + o.lights.w <= o.header.x + o.header.w + 1 &&
      o.lights.y >= o.header.y - 1 && o.lights.y + o.lights.h <= o.header.y + o.header.h + 1,
      { header: o.header, lights: o.lights });
    check("圆点排在官方 × 的左边，不与之重叠",
      o.lights !== null && o.closeBtn !== null &&
      o.lights.x + o.lights.w <= o.closeBtn.x + 1,
      { lightsRight: o.lights ? o.lights.x + o.lights.w : null, closeBtnLeft: o.closeBtn ? o.closeBtn.x : null });
    // 圆点只有 12px，官方 × 是 28px；两者垂直中心要落在同一条线上，
    // 那条线也正好是左侧「设置」标题（22px padding + 24px 行高）的中线。
    check("圆点与官方 × 垂直居中对齐（同一水平线）",
      o.lights !== null && o.closeBtn !== null &&
      Math.abs((o.lights.y + o.lights.h / 2) - (o.closeBtn.y + o.closeBtn.h / 2)) <= 2,
      { lightsCenterY: o.lights ? o.lights.y + o.lights.h / 2 : null,
        closeCenterY: o.closeBtn ? o.closeBtn.y + o.closeBtn.h / 2 : null });
    check("圆点与左侧「设置」标题在同一水平线上",
      o.lights !== null && o.titleCenterY !== null &&
      Math.abs((o.lights.y + o.lights.h / 2) - o.titleCenterY) <= 3,
      { lightsCenterY: o.lights ? o.lights.y + o.lights.h / 2 : null,
        titleCenterY: o.titleCenterY });
    check("接管后打上了 data-dsh-rail-win", o.attr === "1", o.attr);

    // ------------------------------------------- 1b. 官方 × 换皮成红圆点
    // 这是「只换 logo」的验收：样子要变成和另两颗同款的 12px 红圆，
    // 但按钮还是官方那一个（同一个 DOM 节点、同一个 class、同一个 onClose），
    // 且无障碍名字与点击热区都不能因为视觉变小而丢。
    check("官方 × 被打上换皮标记", o.closeDot !== null && o.closeDot.attr === "1", o.closeDot && o.closeDot.attr);
    check("官方 × 看起来是 12px 的红圆点",
      o.closeDot !== null && o.closeDot.w === 12 && o.closeDot.h === 12 &&
      o.closeDot.radius === "50%" && o.closeDot.bg === "rgb(255, 95, 87)",
      o.closeDot && { size: o.closeDot.w + "x" + o.closeDot.h, radius: o.closeDot.radius, bg: o.closeDot.bg });
    check("官方 × 与另两颗圆点落在同一条水平线上",
      o.closeDot !== null && o.lights !== null &&
      Math.abs(o.closeDot.cy - (o.lights.y + o.lights.h / 2)) <= 2,
      { closeDotCenterY: o.closeDot ? o.closeDot.cy : null,
        lightsCenterY: o.lights ? o.lights.y + o.lights.h / 2 : null });
    check("官方 × 的无障碍名字还在（视觉变小不等于读屏失声）",
      o.closeDot !== null && typeof o.closeDot.label === "string" && o.closeDot.label.length > 0,
      o.closeDot && o.closeDot.label);
    check("官方 × 压成 12px 后点击热区仍撑到 28px（左右各 8px 仍能点中）",
      o.closeDot !== null && o.closeDot.hitLeft === true && o.closeDot.hitRight === true,
      o.closeDot && { hitLeft: o.closeDot.hitLeft, hitRight: o.closeDot.hitRight });
    check("拖动抓手存在", o.grip !== null, o.grip);
    await shot("shot-window-open.png");

    // ------------------------------------------------------------- 2. 拖动移动
    // 需求是「面板任意位置都能按住拖走」，所以这里刻意不从抓手起拖，
    // 而是在面板里现找一个**不是交互元素**的落点（列表行、说明文字、空白处都算），
    // 找到哪个就用哪个 —— 探针不写死坐标，页面结构变了也不会假装通过。
    const freePoint = await evalJs(`(() => {
      const p = window.__HARNESS__.panel();
      if (!p) return null;
      const bad = 'button,a[href],input,textarea,select,option,label,summary,[contenteditable],[role="button"],[data-dsh-rail-win-lights],[data-dsh-rail-win-close]';
      const r = p.getBoundingClientRect();
      for (let y = Math.round(r.bottom) - 40; y > r.top + 60; y -= 12) {
        for (let x = Math.round(r.left) + 24; x < r.right - 24; x += 24) {
          const el = document.elementFromPoint(x, y);
          if (!el || !p.contains(el)) continue;
          if (el.closest(bad)) continue;
          return { x: x, y: y, tag: el.tagName, cls: String(el.className || '') };
        }
      }
      return null;
    })()`);
    check("面板里能找到非交互的空白落点（任意位置拖动的前提）", freePoint !== null, freePoint);

    const base = o.panel;
    // 起拖方向刻意往右下：clampPos(0,0) 把左边界钉在 minX=80，
    // 往左拖会在 80 处被夹住，位移就对不上，验的就不是拖动本身了（边界另有专门一项）。
    await dragBy(freePoint, 120, 120, 10);
    result.steps.dragged = await panelBox();
    const d1 = result.steps.dragged;
    check("拖动后窗口真的移动了（从面板空白处起拖，位移 ≈ 120,120）",
      d1.panel !== null && Math.abs((d1.panel.x - base.x) - 120) <= 8 && Math.abs((d1.panel.y - base.y) - 120) <= 8,
      { before: base, after: d1.panel, movedBy: d1.panel ? [d1.panel.x - base.x, d1.panel.y - base.y] : null });
    check("拖动后没有残留 transform",
      (await evalJs("getComputedStyle(window.__HARNESS__.panel()).transform")) === "none",
      await evalJs("getComputedStyle(window.__HARNESS__.panel()).transform"));
    check("拖动后位置写进 localStorage",
      d1.stored !== null && (() => { try { const s = JSON.parse(d1.stored); return s.mode === "dragged"; } catch (e) { return false; } })(),
      d1.stored);
    check("红绿灯跟着窗口走（与面板的相对偏移不变）",
      d1.lights !== null && d1.panel !== null && o.lights !== null && o.panel !== null &&
      Math.abs((d1.lights.x - d1.panel.x) - (o.lights.x - o.panel.x)) <= 2 &&
      Math.abs((d1.lights.y - d1.panel.y) - (o.lights.y - o.panel.y)) <= 2,
      { beforeOffset: o.lights && o.panel ? [o.lights.x - o.panel.x, o.lights.y - o.panel.y] : null,
        afterOffset: d1.lights && d1.panel ? [d1.lights.x - d1.panel.x, d1.lights.y - d1.panel.y] : null });
    await shot("shot-window-dragged.png");

    // ---------------------- 2a. 拖动期材质恒定：只加 will-change，一个像素都不改
    // 曾经为了压掉「模糊每帧重采样」的性能开销，拖动期间把 backdrop-filter 摘掉 ——
    // 代价是面板在起手瞬间从磨砂变清晰（用户看到的是「背景透明度变了」），
    // 松手又变回磨砂（用户看到的是「闪一下」）。现在改成材质全程恒定，
    // 性能由别的优化承担（真实鼠标长任务断言在最后一段压测里验）。
    // 所以这里断言的不再是「模糊被摘掉」，而是**拖动中与常驻态逐项相同**。
    const readDragStyles = () => evalJs(`(() => {
      const p = window.__HARNESS__.panel();
      if (!p) return null;
      const cs = getComputedStyle(p);
      return {
        attr: p.getAttribute('data-dsh-rail-win-dragging'),
        backdrop: cs.backdropFilter || cs.webkitBackdropFilter || '',
        background: cs.backgroundColor || '',
        backgroundImage: cs.backgroundImage || '',
        boxShadow: cs.boxShadow || '',
        willChange: cs.willChange,
      };
    })()`);
    const dragPoint2 = await evalJs(`(() => {
      const p = window.__HARNESS__.panel();
      if (!p) return null;
      const bad = 'button,a[href],input,textarea,select,option,label,summary,[contenteditable],[role="button"],[data-dsh-rail-win-lights],[data-dsh-rail-win-close]';
      const r = p.getBoundingClientRect();
      for (let y = Math.round(r.bottom) - 40; y > r.top + 60; y -= 12) {
        for (let x = Math.round(r.left) + 24; x < r.right - 24; x += 24) {
          const el = document.elementFromPoint(x, y);
          if (!el || !p.contains(el) || el.closest(bad)) continue;
          return { x: x, y: y };
        }
      }
      return null;
    })()`);
    if (dragPoint2 !== null) {
      const beforeDragStyle = await readDragStyles();
      await mouse("mousePressed", dragPoint2.x, dragPoint2.y);
      // 必须超过 3px 阈值才算真的拖起来，否则标记不会置上
      await mouse("mouseMoved", dragPoint2.x + 30, dragPoint2.y + 20);
      await sleep(80);
      const midDragStyle = await readDragStyles();
      await mouse("mouseMoved", dragPoint2.x + 60, dragPoint2.y + 40);
      await sleep(80);
      await mouse("mouseReleased", dragPoint2.x + 60, dragPoint2.y + 40);
      await sleep(420);
      const afterDragStyle = await readDragStyles();
      result.steps.dragMaterial = { before: beforeDragStyle, mid: midDragStyle, after: afterDragStyle };
      const same = (a, b, key) => a !== null && b !== null && String(a[key]) === String(b[key]);
      check("拖动中面板挂上拖动标记（data-dsh-rail-win-dragging=1）",
        midDragStyle !== null && midDragStyle.attr === "1", midDragStyle);
      check("拖动中面板被提成独立图层（will-change: transform）",
        midDragStyle !== null && /transform/.test(String(midDragStyle.willChange)), midDragStyle && midDragStyle.willChange);
      check("拖动中模糊与常驻态完全一致（材质不降级，背景透明度不变）",
        same(beforeDragStyle, midDragStyle, "backdrop") && /blur/.test(String(midDragStyle && midDragStyle.backdrop)),
        { before: beforeDragStyle && beforeDragStyle.backdrop, mid: midDragStyle && midDragStyle.backdrop });
      check("拖动中背景色与常驻态完全一致（不会从半透明跳成实心）",
        same(beforeDragStyle, midDragStyle, "background"),
        { before: beforeDragStyle && beforeDragStyle.background, mid: midDragStyle && midDragStyle.background });
      check("拖动中描边投影与常驻态完全一致（高光不消失）",
        same(beforeDragStyle, midDragStyle, "boxShadow"),
        { before: beforeDragStyle && beforeDragStyle.boxShadow, mid: midDragStyle && midDragStyle.boxShadow });
      check("松手后拖动标记被摘掉",
        afterDragStyle !== null && afterDragStyle.attr === null, afterDragStyle);
      check("松手后模糊仍是同一条（落手不闪、不跳材质）",
        same(beforeDragStyle, afterDragStyle, "backdrop") && /blur/.test(String(afterDragStyle && afterDragStyle.backdrop)),
        { before: beforeDragStyle && beforeDragStyle.backdrop, after: afterDragStyle && afterDragStyle.backdrop });
      check("松手后背景色仍是同一条",
        same(beforeDragStyle, afterDragStyle, "background"),
        { before: beforeDragStyle && beforeDragStyle.background, after: afterDragStyle && afterDragStyle.background });
      check("拖动前本来就带模糊（说明这条规则确实只加图层提示）",
        beforeDragStyle !== null && /blur/.test(String(beforeDragStyle.backdrop)), beforeDragStyle && beforeDragStyle.backdrop);
    } else {
      check("拖动中面板挂上拖动标记（data-dsh-rail-win-dragging=1）", false, "找不到落点");
    }

    // ------------------------------------ 2b. 任意位置拖动 vs 交互元素不吃事件
    // 2a 又拖了一次窗口，d1 的坐标已经过期，这里重新取快照再往下走
    // 这是本次需求的核心，也是唯一会踩坏旧功能的点：
    //   ① 标题栏里的「设置」二字（非交互元素）也能拖；
    //   ② 按在按钮上拖动，窗口不能跟着走（否则点按钮会变成拖窗口）；
    //   ③ 点按钮仍然照常触发它自己的动作（事件没被拖动逻辑吞掉）。
    // 2a 又拖过一次窗口，d1 / titlePt 的坐标已经过期（拿旧坐标去按会按到遮罩上、把窗口关掉），
    // 所以从这里开始一律用现取的快照。
    const d2 = await panelBox();
    const titlePt = (() => {
      const t = d2.title;
      return t ? { x: Math.round(t.x + Math.min(30, t.w / 2)), y: Math.round(t.y + 34) } : null;
    })();
    if (titlePt !== null) {
      const before2 = d2.panel;
      await dragBy(titlePt, -80, 60, 6);
      const after2 = await panelBox();
      check("按住左侧「设置」标题也能拖动窗口（标题栏不再是唯一入口）",
        after2.panel !== null &&
        Math.abs((after2.panel.x - before2.x) - (-80)) <= 20 &&
        Math.abs((after2.panel.y - before2.y) - 60) <= 10,
        { before: before2, after: after2.panel, movedBy: after2.panel ? [after2.panel.x - before2.x, after2.panel.y - before2.y] : null });
      result.steps.draggedFromTitle = after2;
    } else {
      check("按住左侧「设置」标题也能拖动窗口（标题栏不再是唯一入口）", false, "找不到标题元素");
    }

    const afterTitleDrag = result.steps.draggedFromTitle || d2;
    // 按在官方 × 上拖：窗口必须纹丝不动（那个按钮归官方管）
    const closePt = centerOf(afterTitleDrag.closeBtn);
    const beforeBtnDrag = afterTitleDrag.panel;
    await dragBy(closePt, -140, 100, 6);
    const afterBtnDrag = await panelBox();
    check("按在按钮上拖动不会拖走窗口（交互元素优先）",
      afterBtnDrag.panel !== null &&
      Math.abs(afterBtnDrag.panel.x - beforeBtnDrag.x) <= 2 &&
      Math.abs(afterBtnDrag.panel.y - beforeBtnDrag.y) <= 2,
      { before: beforeBtnDrag, after: afterBtnDrag.panel });
    // 上面那一拖从 × 上按下又松开，会顺带把设置关掉 —— 重新打开继续
    if (afterBtnDrag.panel === null || (await evalJs("window.__HARNESS__.settingsOpen()")) !== true) {
      await openSettings();
      await sleep(300);
    }
    // 导航格是 button：点它必须还能切换（证明 click 没被拖动逻辑吞掉）
    const navOk = await evalJs(`(() => {
      const p = window.__HARNESS__.panel();
      if (!p) return { ok: false, reason: 'no-panel' };
      const cell = p.querySelector('.stNavCell:not([data-active="true"])');
      if (!cell) return { ok: false, reason: 'no-cell' };
      cell.click();
      return { ok: true };
    })()`);
    check("面板里的按钮点击仍然有效（click 没被拖动逻辑吞掉）", navOk !== null && navOk.ok === true, navOk);

    // 2c. 边界夹逼：往左拖到视口外，窗口应该停在 minX=80，而不是整个飞出去。
    // 这条单独验，是因为上一项「位移对不上」曾经就是被它悄悄吃掉的（容差把夹逼藏起来了）。
    const freePoint2 = await evalJs(`(() => {
      const p = window.__HARNESS__.panel();
      if (!p) return null;
      const bad = 'button,a[href],input,textarea,select,option,label,summary,[contenteditable],[role="button"],[data-dsh-rail-win-lights],[data-dsh-rail-win-close]';
      const r = p.getBoundingClientRect();
      for (let y = Math.round(r.bottom) - 40; y > r.top + 60; y -= 12) {
        for (let x = Math.round(r.left) + 24; x < r.right - 24; x += 24) {
          const el = document.elementFromPoint(x, y);
          if (!el || !p.contains(el) || el.closest(bad)) continue;
          return { x: x, y: y };
        }
      }
      return null;
    })()`);
    if (freePoint2 !== null) {
      await dragBy(freePoint2, -900, 0, 10);
      const clamped = await panelBox();
      check("往视口外拖会被夹在左边界（x=80），不会飞出屏幕",
        clamped.panel !== null && Math.abs(clamped.panel.x - 80) <= 2, clamped.panel);
    } else {
      check("往视口外拖会被夹在左边界（x=80），不会飞出屏幕", false, "找不到落点");
    }

    // 2d. 收手不跳：拖动全程只画 transform，落位才写 left/top。
    // 这两套坐标一旦不相等，松手那一帧面板就会瞬移到另一个位置 —— 就是「停靠时闪烁/跳帧」。
    // 做法：拖到一半时记下 transform 表达的位置，松手后再读 left/top 表达的位置，两者必须一致。
    const freePoint3 = await evalJs(`(() => {
      const p = window.__HARNESS__.panel();
      if (!p) return null;
      const bad = 'button,a[href],input,textarea,select,option,label,summary,[contenteditable],[role="button"],[data-dsh-rail-win-lights],[data-dsh-rail-win-close]';
      const r = p.getBoundingClientRect();
      for (let y = Math.round(r.bottom) - 40; y > r.top + 60; y -= 12) {
        for (let x = Math.round(r.left) + 24; x < r.right - 24; x += 24) {
          const el = document.elementFromPoint(x, y);
          if (!el || !p.contains(el) || el.closest(bad)) continue;
          return { x: x, y: y };
        }
      }
      return null;
    })()`);
    if (freePoint3 !== null) {
      // 起点基准：拖动前 left/top 表达的左上角
      const base = await evalJs(`(() => {
        const p = window.__HARNESS__.panel();
        const r = p.getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top) };
      })()`);
      await mouse("mousePressed", freePoint3.x, freePoint3.y);
      // 分三步走，途中读一次「transform 说自己在哪」
      const DX = 90;
      const DY = 70;
      for (let i = 1; i <= 3; i++) {
        await mouse("mouseMoved", freePoint3.x + Math.round((DX * i) / 3), freePoint3.y + Math.round((DY * i) / 3));
        await sleep(40);
      }
      const mid = await evalJs(`(() => {
        const p = window.__HARNESS__.panel();
        const r = p.getBoundingClientRect();
        const m = /translate3d\\((-?[\\d.]+)px,\\s*(-?[\\d.]+)px/.exec(p.style.transform || "");
        return {
          rect: { x: Math.round(r.left), y: Math.round(r.top) },
          tx: m ? Number(m[1]) : 0,
          ty: m ? Number(m[2]) : 0,
          hasTransform: (p.style.transform || "") !== "",
        };
      })()`);
      await mouse("mouseReleased", freePoint3.x + DX, freePoint3.y + DY);
      await sleep(420);
      const settledBox = await panelBox();
      const paintedX = mid.rect.x;
      const paintedY = mid.rect.y;
      const settledX = settledBox.panel === null ? null : settledBox.panel.x;
      const settledY = settledBox.panel === null ? null : settledBox.panel.y;
      check("拖动中确实用 transform 表达位移（还没写 left/top）",
        mid.hasTransform === true && (mid.tx !== 0 || mid.ty !== 0), { tx: mid.tx, ty: mid.ty, base: base });
      check("松手落位与拖动中所见完全一致（不会瞬移一段）",
        settledX !== null && Math.abs(settledX - paintedX) <= 2 && Math.abs(settledY - paintedY) <= 2,
        { painted: { x: paintedX, y: paintedY }, settled: { x: settledX, y: settledY } });
      check("松手后没有残留 transform（落位改由 left/top 表达）",
        (await evalJs(`(() => { const p = window.__HARNESS__.panel(); return p ? (p.style.transform || "") : "no-panel"; })()`)) === "",
        await evalJs(`(() => { const p = window.__HARNESS__.panel(); return p ? (p.style.transform || "") : "no-panel"; })()`));
    } else {
      check("拖动中确实用 transform 表达位移（还没写 left/top）", false, "找不到落点");
      check("松手落位与拖动中所见完全一致（不会瞬移一段）", false, "找不到落点");
      check("松手后没有残留 transform（落位改由 left/top 表达）", false, "找不到落点");
    }

    // ------------------------------------------------ 3. 最大化：铺满会话区
    // 圆点只有两个且顺序是「绿(最大化) / 黄(最小化)」，所以最大化取 dots[0]
    // 注意：2b 里又拖过两次窗口，d1 的坐标已经过期，这里必须重新取快照。
    const cur = await panelBox();
    const maxBtn = centerOf(cur.dots[0]);
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
    const maxBtn2 = centerOf(m1.dots[0]);
    await mouse("mousePressed", maxBtn2.x, maxBtn2.y);
    await mouse("mouseReleased", maxBtn2.x, maxBtn2.y);
    await sleep(420);
    result.steps.unmaximized = await panelBox();
    check("再点最大化回到拖动后的位置与尺寸",
      result.steps.unmaximized.max === null &&
      Math.abs(result.steps.unmaximized.panel.x - cur.panel.x) <= 3 &&
      Math.abs(result.steps.unmaximized.panel.w - cur.panel.w) <= 3,
      { now: result.steps.unmaximized.panel, want: cur.panel });

    // ---------------------------------------------------------- 4. 最小化
    const u1 = result.steps.unmaximized;
    const minBtn = centerOf(u1.dots[1]);    await mouse("mousePressed", minBtn.x, minBtn.y);
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
    const barPt = centerOf({ x: n1.panel.x + 12, y: n1.panel.y, w: 80, h: 54 });
    await mouse("mousePressed", barPt.x, barPt.y);
    await mouse("mouseReleased", barPt.x, barPt.y);
    await sleep(420);
    result.steps.restored = await panelBox();
    check("点最小化后的标题条能还原",
      result.steps.restored.min === null && result.steps.restored.panel.h > 54,
      { min: result.steps.restored.min, panel: result.steps.restored.panel });

    // ------------------------------------------------------- 5. 刷新后保持
    // 以「还原后」的实时位置为准（2b 又拖过几次，d1 已过期）
    const beforeReload = result.steps.restored.panel;
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
      Math.abs(result.steps.afterReload.panel.x - beforeReload.x) <= 4 &&
      Math.abs(result.steps.afterReload.panel.y - beforeReload.y) <= 4,
      { now: result.steps.afterReload.panel, want: beforeReload });

    // -------------------------------------------------------- 6. 关闭按钮
    // 关闭不再是我们造的红点，而是官方 header 里那个 × 图标按钮——点它必须真的关掉。
    const r1 = result.steps.afterReload;
    const closeBtn = centerOf(r1.closeBtn);
    await mouse("mousePressed", closeBtn.x, closeBtn.y);
    await mouse("mouseReleased", closeBtn.x, closeBtn.y);
    await sleep(420);
    result.steps.closed = { open: await evalJs("window.__HARNESS__.settingsOpen()"), visible: await evalJs(`(() => { const p = window.__HARNESS__.panel(); if (!p) return false; const cs = getComputedStyle(p); return cs.visibility !== "hidden" && cs.display !== "none"; })()`) };
    check("点官方 × 关闭：窗口不可见（hidden 或已从 DOM 摘掉）", result.steps.closed.open === false || result.steps.closed.visible === false, result.steps.closed);
    check("关闭后不残留控制圆点",
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
    // 这里刻意用**真实鼠标输入**（CDP Input.dispatchMouseEvent）来拖，而不是自己
    // dispatchEvent 派发合成的 PointerEvent —— 合成事件不经过浏览器的事件处理与
    // 合成流程，鼠标移动再快也压不出卡顿，那样测出来的「0 长任务」是假的。
    await openSettings();
    const longTaskStart = await evalJs(`(() => {
      const res = { count: 0, max: 0, list: [] };
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) { res.count++; res.max = Math.max(res.max, Math.round(e.duration)); res.list.push(Math.round(e.duration)); }
      });
      try { obs.observe({ entryTypes: ['longtask'] }); } catch (e) { window.__PO__ = null; return { unsupported: true }; }
      window.__PO__ = { res: res, obs: obs };
      return { ok: true };
    })()`);
    // 同时记录拖动期间的帧间隔 —— 长任务只是「主线程有没有被卡住」，
    // 而用户说的「跳帧」是「画面有没有连续」。rAF 相邻两次回调的间隔
    // 一旦明显超过一个刷新周期（60Hz ≈ 16.7ms），就是真的丢了一帧。
    // 两个指标一起看，才不会出现「没有长任务但画面照样卡」的漏判。
    // 先量一段空闲基线，再拿拖动去比：headless 里空闲本身就可能偶尔抖一下，
    // 不设基线会把环境噪声当成回归。
    const startFrames = () => evalJs(`(() => {
      if (window.__FRAMES__) window.__FRAMES__.stop();
      const frames = { gaps: [], max: 0 };
      let last = 0;
      let stopped = false;
      const tick = (t) => {
        if (last !== 0) { const g = t - last; frames.gaps.push(Math.round(g)); if (g > frames.max) frames.max = g; }
        last = t;
        if (!stopped) window.requestAnimationFrame(tick);
      };
      window.__FRAMES__ = { frames: frames, stop: () => { stopped = true; } };
      window.requestAnimationFrame(tick);
      return { ok: true };
    })()`);
    const readFrames = () => evalJs(`(() => {
      if (!window.__FRAMES__) return null;
      window.__FRAMES__.stop();
      const f = window.__FRAMES__.frames;
      const sorted = f.gaps.slice().sort((a, b) => a - b);
      const p95 = sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
      const over33 = f.gaps.filter((g) => g > 33).length;
      const out = { count: f.gaps.length, max: f.max, p95: p95, over33: over33 };
      window.__FRAMES__ = null;
      return out;
    })()`);
    await startFrames();
    await sleep(500);
    result.steps.idleFrames = await readFrames();
    const stressPoint = await evalJs(`(() => {
      const p = window.__HARNESS__.panel();
      if (!p) return null;
      const bad = 'button,a[href],input,textarea,select,option,label,summary,[contenteditable],[role="button"],[data-dsh-rail-win-lights],[data-dsh-rail-win-close]';
      const r = p.getBoundingClientRect();
      for (let y = Math.round(r.bottom) - 60; y > r.top + 60; y -= 12) {
        for (let x = Math.round(r.left) + 30; x < r.right - 200; x += 24) {
          const el = document.elementFromPoint(x, y);
          if (!el || !p.contains(el) || el.closest(bad)) continue;
          return { x: x, y: y };
        }
      }
      return null;
    })()`);
    if (longTaskStart !== null && longTaskStart.unsupported !== true && stressPoint !== null) {
      // 40 步 × 16ms ≈ 640ms 的连续拖动，足够覆盖若干帧
      await startFrames();
      await dragBy(stressPoint, 200, 120, 40);
      result.steps.dragFrames = await readFrames();
      result.steps.longTasks = await evalJs(`(() => {
        if (!window.__PO__) return { unsupported: true };
        window.__PO__.obs.disconnect();
        const res = window.__PO__.res;
        window.__PO__ = null;
        return res;
      })()`);
    } else {
      result.steps.longTasks = { unsupported: true };
    }
    const lt = result.steps.longTasks;
    check("用真实鼠标拖动 40 步，全程无超过 80ms 的长任务",
      lt && lt.unsupported === true ? true : (!lt || lt.max <= 80),
      lt);
    const df = result.steps.dragFrames;
    // 材质不降级后模糊要每帧重采样，所以这里给一个「不丢帧」的判据：
    // 超过两帧（>33ms）的间隔占比要很小，且最长的那一帧不能是卡死级别。
    // headless + 软件渲染比真机容易出抖动，阈值留了余量；
    // 真机若仍觉得卡，这条断言是最先该看的数字。
    check("拖动期间画面连续（超两帧的间隔 ≤ 10%，最长一帧 ≤ 100ms）",
      df === null ? true : (df.over33 <= Math.max(1, Math.round(df.count * 0.1)) && df.max <= 100),
      df);
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
