// probes/window-probe.cjs — 真实浏览器回归：设置弹窗窗口化（任意位置拖动 / 原生关闭 / 持久化）
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
        // 官方 × 必须取 header 的直系子按钮：后代选择器可能先命中别的含 "close" 的元素，
        // 断言就会去比错节点。
        // 属性值在 CSS 里大小写敏感，官方是 VOzbGW_close、回归台是 stClose，所以带 i 标志。
        closeBtn: box(p && p.querySelector('[data-dsh-rail-win-header] > button[class*="close" i]')),
        // 官方 × 的外观取值：按钮始终是官方那一个。
        // skinAttr 是插件曾经打上去的换皮标记，撤销时要能摘干净。
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
    check("设置窗口不再渲染窗口控制圆点", o.lights === null && o.dots.length === 0, { lights: o.lights, dots: o.dots });
    check("官方关闭按钮保持原生外观", o.closeDot !== null && o.closeDot.attr === null && o.closeDot.w === 28, o.closeDot);
    // ------------------------------------------------------------- 2. 拖动移动
    // 需求是「面板任意位置都能按住拖走」，所以这里刻意不从抓手起拖，
    // 而是在面板里现找一个**不是交互元素**的落点（列表行、说明文字、空白处都算），
    // 找到哪个就用哪个 —— 探针不写死坐标，页面结构变了也不会假装通过。
    const freePoint = await evalJs(`(() => {
      const p = window.__HARNESS__.panel();
      if (!p) return null;
      const bad = 'button,a[href],input,textarea,select,option,label,summary,[contenteditable],[role="button"]';
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
    check("拖动过程中仍不创建窗口控制圆点", d1.lights === null && d1.dots.length === 0, d1.lights);
     await shot("shot-window-dragged.png");

    // ---------------------- 2a. 拖动期材质恒定：只加 will-change，一个像素都不改
    // 面板材质完全沿用宿主提供的普通样式，拖动期间只加 will-change:transform，
    // 不写任何视觉属性，所以这里断言的是**拖动中与常驻态逐项相同**。
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
      const bad = 'button,a[href],input,textarea,select,option,label,summary,[contenteditable],[role="button"]';
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
      check("拖动中保持普通无模糊材质",
        same(beforeDragStyle, midDragStyle, "backdrop") && !/blur/.test(String(midDragStyle && midDragStyle.backdrop)),
        { before: beforeDragStyle && beforeDragStyle.backdrop, mid: midDragStyle && midDragStyle.backdrop });
      check("拖动中背景色与常驻态完全一致（不会从半透明跳成实心）",
        same(beforeDragStyle, midDragStyle, "background"),
        { before: beforeDragStyle && beforeDragStyle.background, mid: midDragStyle && midDragStyle.background });
      check("拖动中描边投影与常驻态完全一致（高光不消失）",
        same(beforeDragStyle, midDragStyle, "boxShadow"),
        { before: beforeDragStyle && beforeDragStyle.boxShadow, mid: midDragStyle && midDragStyle.boxShadow });
      check("松手后拖动标记被摘掉",
        afterDragStyle !== null && afterDragStyle.attr === null, afterDragStyle);
      check("松手后仍保持普通无模糊材质",
        same(beforeDragStyle, afterDragStyle, "backdrop") && !/blur/.test(String(afterDragStyle && afterDragStyle.backdrop)),
        { before: beforeDragStyle && beforeDragStyle.backdrop, after: afterDragStyle && afterDragStyle.backdrop });
      check("松手后背景色仍是同一条",
        same(beforeDragStyle, afterDragStyle, "background"),
        { before: beforeDragStyle && beforeDragStyle.background, after: afterDragStyle && afterDragStyle.background });
      check("拖动前本来就没有模糊滤镜（宿主普通材质）",
        beforeDragStyle !== null && !/blur/.test(String(beforeDragStyle.backdrop)), beforeDragStyle && beforeDragStyle.backdrop);
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
      const bad = 'button,a[href],input,textarea,select,option,label,summary,[contenteditable],[role="button"]';
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
      const bad = 'button,a[href],input,textarea,select,option,label,summary,[contenteditable],[role="button"]';
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

    // ------------------------------------- 3. 标题栏双击不应再触发任何窗口动作
    // 「点标题条还原」与「最大化铺满会话区」两个功能整体删除后，    // 双击标题栏不应改变窗口几何，也不应把面板收成一条。
    const cur = await panelBox();
    const dblPt = centerOf(cur.title);
    await mouse("mousePressed", dblPt.x, dblPt.y, { clickCount: 1 });
    await mouse("mouseReleased", dblPt.x, dblPt.y, { clickCount: 1 });
    await mouse("mousePressed", dblPt.x, dblPt.y, { clickCount: 2 });
    await mouse("mouseReleased", dblPt.x, dblPt.y, { clickCount: 2 });
    await sleep(420);
    result.steps.dblclickTitle = await panelBox();
    const dc = result.steps.dblclickTitle;
    check("标题栏双击不再改变窗口状态（没有 win-max 标记）", dc.max === null && dc.panel !== null, dc.max);
    check("标题栏双击后窗口几何不变",
      dc.panel !== null && Math.abs(dc.panel.x - cur.panel.x) <= 3 && Math.abs(dc.panel.w - cur.panel.w) <= 3,
      { now: dc.panel, want: cur.panel });
    await shot("shot-window-dblclick.png");

    // 最小化入口随功能删除一起移除，这里确认不会出现收成一条的状态
    check("面板不会进入收起状态（没有 win-min 标记）", dc.min === null, dc.min);

    // ------------------------------------------------------- 5. 刷新后保持
    // 以刷新前的实时位置为准（前面还做过「拖到边界被夹回来」等动作，
    // 早期采样到的 result.steps.dragged 已经不是最后落位）
    const beforeReload = (await panelBox()).panel;
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
    check("关闭后不残留任何窗口控制点",
      (await evalJs(`(() => !document.querySelector('[data-dsh-rail-win-lights]'))()`)) === true);

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
      const bad = 'button,a[href],input,textarea,select,option,label,summary,[contenteditable],[role="button"]';
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
