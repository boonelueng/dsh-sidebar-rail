// probes/features-probe.cjs — 真实浏览器回归：设置页「功能开关」（渲染 / 独立启停 / 就地生效 / 持久化）
// 用法：node probes/features-probe.cjs
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9357;
const HERE = __dirname;
const PROFILE = path.join(HERE, ".probe-chrome-features");
const PAGE = "file:///" + path.join(HERE, "features-harness.html").replace(/\\/g, "/");
const OUT = path.join(HERE, "features-probe-result.json");

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
    // 设置页那一节由 slots.inject 的回调注册，回归台里必须手动挂一次
    const mountSection = async () => {
      const r = await evalJs("window.__HARNESS__.mountSection()");
      await sleep(180);
      return r;
    };
    const rows = () => evalJs("window.__HARNESS__.featureRows()");
    const clickFeature = async (key) => {
      const ok = await evalJs("window.__HARNESS__.clickFeature(" + JSON.stringify(key) + ")");
      await sleep(180);
      return ok;
    };
    const stored = () => evalJs("window.__HARNESS__.storedFeatures()");
    // 按一下红绿灯上的某个圆点：模块用 pointerdown 触发，这里照真实路径发同一个事件
    const pressDot = async (sel) => {
      const ok = await evalJs(`(() => {
        const l = window.__HARNESS__.lights();
        const d = l && l.querySelector(${JSON.stringify(sel)});
        if (!d) return false;
        d.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1 }));
        return true;
      })()`);
      await sleep(260);
      return ok;
    };
    const panelBox = () => evalJs(`(() => {
      const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect();
        return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; };
      const p = window.__HARNESS__.panel();
      const lights = window.__HARNESS__.lights();
      const dot = (sel) => { const d = lights ? lights.querySelector(sel) : null;
        if (!d) return null;
        return { disabled: d.hasAttribute('disabled'), ariaDisabled: d.getAttribute('aria-disabled'),
                 title: d.getAttribute('title') || '', label: d.getAttribute('aria-label') || '' }; };
      return {
        panel: box(p),
        hasLights: lights !== null && lights !== undefined,
        close: dot('.dsr-light-close'),
        min: dot('.dsr-light-min'),
        max: dot('.dsr-light-max'),
        attr: p && p.getAttribute('data-dsh-rail-win'),
        minAttr: p && p.getAttribute('data-dsh-rail-win-min'),
        maxAttr: p && p.getAttribute('data-dsh-rail-win-max'),
        grip: box(document.querySelector('[data-dsh-rail-win-grip]')),
        vw: window.innerWidth, vh: window.innerHeight,
        stored: localStorage.getItem('dsh-sidebar-rail.features.v1'),
      };
    })()`);

    await boot("first");
    await openSettings();

    // ------------------------------------------------- 1. 开关区块渲染
    const mount1 = await mountSection();
    check("设置页能挂上「侧边栏条目」这一节", mount1 && mount1.ok === true, mount1);

    const r1 = await rows();
    check("功能开关渲染出四行", Array.isArray(r1) && r1.length === 4, r1 && r1.length);
    const keys = Array.isArray(r1) ? r1.map((r) => r.key) : [];
    check("四行开关的 key 与预期一致",
      JSON.stringify(keys) === JSON.stringify(["lights", "drag", "restore", "maximize"]), keys);
    check("四行开关默认全开",
      Array.isArray(r1) && r1.length === 4 && r1.every((r) => r.on === true && r.checked === true),
      r1 && r1.map((r) => ({ key: r.key, on: r.on, checked: r.checked })));
    check("每行都有名称与说明",
      Array.isArray(r1) && r1.every((r) => String(r.label).length > 0 && String(r.desc).length > 0),
      r1 && r1.map((r) => ({ label: r.label, desc: String(r.desc).slice(0, 24) })));

    const sw = await evalJs(`(() => {
      const box = document.querySelector('.dsr-switches');
      if (!box) return null;
      const row = box.querySelector('.dsr-switch');
      return {
        rows: box.querySelectorAll('.dsr-switch').length,
        track: !!(row && row.querySelector('.dsr-switch-track')),
        knob: !!(row && row.querySelector('.dsr-switch-knob')),
        role: row && row.getAttribute('role'),
        tabindex: row && row.getAttribute('tabindex'),
        onAttr: row && row.getAttribute('data-on'),
      };
    })()`);
    check("开关有轨道与圆点，role=switch 且可聚焦",
      sw && sw.rows === 4 && sw.track && sw.knob && sw.role === "switch" && sw.tabindex === "0" && sw.onAttr === "1", sw);

    const order = await evalJs(`(() => {
      const wrap = document.querySelector('.dsr-settings');
      if (!wrap) return null;
      return Array.from(wrap.children).map((n) => n.className);
    })()`);
    check("开关区块位于标题与条目列表之间",
      Array.isArray(order) && order.indexOf("dsr-switches") > 0 &&
      order.indexOf("dsr-switches") < order.indexOf("dsr-body"), order);
    await shot("shot-features-open.png");

    // ------------------------------------------------- 2. 关掉红绿灯
    await clickFeature("lights");
    const p2 = await panelBox();
    check("关掉红绿灯后整组按钮消失", p2 && p2.hasLights === false, p2 && { hasLights: p2.hasLights });
    const s2 = await stored();
    check("红绿灯状态写进本机存储", s2 && s2.lights === false, s2);
    const r2 = await rows();
    const rowLights = Array.isArray(r2) ? r2.find((r) => r.key === "lights") : null;
    check("开关自身显示为关闭",
      rowLights && rowLights.on === false && rowLights.checked === false, rowLights);
    await shot("shot-features-lights-off.png");

    await clickFeature("lights");
    const p3 = await panelBox();
    check("重新打开红绿灯后按钮回来", p3 && p3.hasLights === true && p3.close !== null, p3 && { hasLights: p3.hasLights });

    // 键盘也能切：Enter 等价点一下
    const kb = await evalJs(`(() => {
      const row = document.querySelector('.dsr-switch[data-feature="lights"]');
      if (!row) return null;
      const before = row.getAttribute('data-on');
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const next = document.querySelector('.dsr-switch[data-feature="lights"]');
      return { before: before, after: next && next.getAttribute('data-on') };
    })()`);
    check("键盘 Enter 也能切换开关", kb && kb.before === "1" && kb.after === "0", kb);
    await clickFeature("lights");

    // ------------------------------------------------- 3. 关掉「点标题条还原」
    await clickFeature("restore");
    const p4 = await panelBox();
    check("关掉还原后黄点被禁用",
      p4 && p4.min && p4.min.disabled === true && p4.min.ariaDisabled === "true", p4 && p4.min);
    check("黄点提示写明需先开启还原",
      p4 && p4.min && String(p4.min.title).indexOf("需先开启") >= 0, p4 && p4.min && p4.min.title);

    const beforeMin = p4 && p4.minAttr;
    await pressDot(".dsr-light-min");
    const p4b = await panelBox();
    check("还原关着时点黄点不会最小化（避免单向门）",
      p4b && (p4b.minAttr === null || p4b.minAttr === beforeMin),
      { before: beforeMin, after: p4b && p4b.minAttr });

    await clickFeature("restore");
    const p5 = await panelBox();
    check("重新打开还原后黄点恢复可用",
      p5 && p5.min && p5.min.disabled === false && p5.min.ariaDisabled === null, p5 && p5.min);

    // ------------------------------------------------- 4. 关掉「最大化铺满会话区」
    await clickFeature("maximize");
    const p6 = await panelBox();
    check("关掉最大化后绿点被禁用",
      p6 && p6.max && p6.max.disabled === true && p6.max.ariaDisabled === "true", p6 && p6.max);
    check("绿点提示写明已在设置里关闭",
      p6 && p6.max && String(p6.max.title).indexOf("关闭") >= 0, p6 && p6.max && p6.max.title);

    await pressDot(".dsr-light-max");
    const p6b = await panelBox();
    check("关掉最大化后点绿点不会铺满",
      p6b && p6b.maxAttr !== "1", p6b && { maxAttr: p6b.maxAttr });

    await clickFeature("maximize");
    const p7 = await panelBox();
    check("重新打开最大化后绿点恢复可用",
      p7 && p7.max && p7.max.disabled === false && p7.max.ariaDisabled === null, p7 && p7.max);

    // ------------------------------------------------- 5. 关掉「按住标题栏拖动」
    await clickFeature("drag");
    const g1 = await panelBox();
    await dragBy({ x: g1.panel.x + 40, y: g1.grip.y + Math.round(g1.grip.h / 2) }, -160, 90);
    const g2 = await panelBox();
    check("关掉拖动后拖标题栏窗口不动",
      Math.abs(g2.panel.x - g1.panel.x) <= 2 && Math.abs(g2.panel.y - g1.panel.y) <= 2,
      { before: g1.panel, after: g2.panel });

    await clickFeature("drag");
    const g3 = await panelBox();
    await dragBy({ x: g3.panel.x + 40, y: g3.grip.y + Math.round(g3.grip.h / 2) }, -160, 90);
    const g4 = await panelBox();
    check("重新打开拖动后能拖动窗口",
      Math.abs(g4.panel.x - g3.panel.x) > 40 || Math.abs(g4.panel.y - g3.panel.y) > 20,
      { before: g3.panel, after: g4.panel });
    await shot("shot-features-dragged.png");

    // ------------------------------------------------- 6. 刷新后状态保持
    // 先把状态摆成「两开两关」，刷新后应当原样恢复
    await clickFeature("restore");
    await clickFeature("maximize");
    const mixed = await stored();
    check("四项状态都已写进本机存储",
      mixed && mixed.lights === true && mixed.drag === true &&
      mixed.restore === false && mixed.maximize === false, mixed);

    await boot("reload");
    await openSettings();
    const mount2 = await mountSection();
    check("刷新后设置节仍能挂上", mount2 && mount2.ok === true, mount2);

    const r3 = await rows();
    const byKey = {};
    (Array.isArray(r3) ? r3 : []).forEach((r) => { byKey[r.key] = r.on; });
    check("刷新后开关状态从本机恢复",
      Array.isArray(r3) && r3.length === 4 &&
      byKey.lights === true && byKey.drag === true &&
      byKey.restore === false && byKey.maximize === false, byKey);

    const p8 = await panelBox();
    check("刷新后红绿灯按开关状态重建",
      p8 && p8.hasLights === true && p8.min && p8.min.disabled === true && p8.max && p8.max.disabled === true,
      p8 && { hasLights: p8.hasLights, min: p8.min, max: p8.max });

    // ------------------------------------------------- 7. 诊断无异常
    const errs = await evalJs("(window.__DSH_RAIL__ && window.__DSH_RAIL__.errors) || []");
    const winErrs = Array.isArray(errs) ? errs.filter((e) => String(e).indexOf("window:") === 0) : [];
    check("全程没有 window 模块报错", winErrs.length === 0, winErrs);
    const feat = await evalJs("(window.__DSH_RAIL__ && window.__DSH_RAIL__.features) || null");
    check("诊断快照里有四项开关状态",
      feat && typeof feat === "object" && Object.keys(feat).length === 4, feat);
    await shot("shot-features-final.png");

    result.steps.done = true;
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
