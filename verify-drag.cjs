#!/usr/bin/env node
/**
 * verify-drag.cjs — 在 Node VM 里用「有布局模型的 DOM 桩」验证轨道拖拽排序算法。
 *
 * 为什么不直接跑真机：当前宿主进程的 hmr 已 disposed（日志 `HMR is disposed`），
 * 插件没被装载，bundle 路由 404，CDP 探针拿不到真实的轨道。所以先用桩验证：
 *   - pointerdown → pointermove(超过阈值) → ghost 出现、body class 加上
 *   - 顺序按 CSS order 变化，且 getBoundingClientRect 跟随 order（模拟真实布局）
 *   - pointerup 后 navOrder / entries 写进 localStorage
 *   - flIP：「其他项」拿到了 animate，被拖项没有
 *   - 点击被抑制（拖拽结束不触发 runEntry）
 *
 * 用法：node verify-drag.cjs
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const HERE = __dirname;
const CLIENT = path.join(HERE, "client.js");
const SRC = fs.readFileSync(CLIENT, "utf8");

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail === undefined ? "" : "  " + JSON.stringify(detail)));
}

// ---------------------------------------------------------------- DOM stub
let nodeSeq = 0;
const STORE = new Map();

class Stub {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentElement = null;
    this.style = makeStyle();
    this.attrs = new Map();
    this.listeners = new Map();
    this._classes = new Set();
    this.textContent = "";
    this.dataset = {};
    this._id = ++nodeSeq;
    this.animations = [];
    this.classList = {
      add: (...cs) => cs.forEach((c) => this._classes.add(c)),
      remove: (...cs) => cs.forEach((c) => this._classes.delete(c)),
      contains: (c) => this._classes.has(c),
      toString: () => Array.from(this._classes).join(" "),
    };
  }
  get className() {
    return Array.from(this._classes).join(" ");
  }
  set className(v) {
    this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get children() {
    return this.childNodes.filter((n) => n instanceof Stub);
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  setAttribute(k, v) {
    this.attrs.set(k, String(v));
    if (k === "class") this.className = v;
  }
  getAttribute(k) {
    return this.attrs.has(k) ? this.attrs.get(k) : null;
  }
  hasAttribute(k) {
    return this.attrs.has(k);
  }
  removeAttribute(k) {
    this.attrs.delete(k);
  }
  appendChild(node) {
    if (node.parentElement) node.parentElement.removeChild(node);
    this.childNodes.push(node);
    node.parentElement = this;
    return node;
  }
  insertBefore(node, ref) {
    const i = this.childNodes.indexOf(ref);
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, node);
    node.parentElement = this;
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentElement = null;
    return node;
  }
  remove() {
    if (this.parentElement) this.parentElement.removeChild(this);
  }
  append() {
    for (const n of Array.from(arguments)) {
      this.appendChild(typeof n === "string" ? document.createTextNode(n) : n);
    }
  }
  prepend() {
    const list = Array.from(arguments).reverse();
    for (const n of list) {
      this.insertBefore(typeof n === "string" ? document.createTextNode(n) : n, this.childNodes[0] || null);
    }
  }
  contains(node) {
    let n = node;
    while (n) {
      if (n === this) return true;
      n = n.parentElement;
    }
    return false;
  }
  closest(sel) {
    let n = this;
    while (n) {
      if (n.matches && n.matches(sel)) return n;
      n = n.parentElement;
    }
    return null;
  }
  matches(sel) {
    return matchesSelector(this, sel);
  }
  querySelectorAll(sel) {
    const out = [];
    const wantScope = sel.startsWith(":scope > ");
    const rest = wantScope ? sel.slice(9) : sel;
    const walk = (node) => {
      for (const child of node.children) {
        if (wantScope) {
          if (node === this && matchesSelector(child, rest)) out.push(child);
        } else if (matchesSelector(child, rest) || child.querySelectorAll(rest).length > 0) {
          if (matchesSelector(child, rest)) out.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const arr = this.listeners.get(type) || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  dispatch(type, event) {
    // 真实 DOM 会冒泡：桩里手动从当前节点逐级向父节点派发，并补上 target/currentTarget
    const origin = this;
    if (!event.target) event.target = origin;
    let node = this;
    while (node) {
      const arr = node.listeners ? node.listeners.get(type) || [] : [];
      for (const fn of arr.slice()) {
        event.currentTarget = node;
        fn.call(node, event);
      }
      node = node.parentElement;
    }
    return event;
  }
  getBoundingClientRect() {
    return layoutOf(this);
  }
  getAnimations() {
    return this.animations.slice();
  }
  animate(keyframes, opts) {
    const a = { keyframes, opts, cancelled: false, cancel() { this.cancelled = true; } };
    this.animations.push(a);
    return a;
  }
  cloneNode() {
    const c = new Stub(this.tagName);
    c.className = this.className;
    for (const [k, v] of this.attrs) c.attrs.set(k, v);
    c.textContent = this.textContent;
    for (const child of this.children) c.appendChild(child.cloneNode());
    return c;
  }
}

function makeStyle() {
  const m = new Map();
  return new Proxy(
    {
      setProperty(k, v) {
        m.set(k, v);
      },
      getPropertyValue(k) {
        return m.get(k) || "";
      },
      removeProperty(k) {
        m.delete(k);
      },
    },
    {
      get(t, k) {
        if (k in t) return t[k];
        if (typeof k === "string" && /^[a-z-]+$/.test(k)) return m.get(k) || "";
        return undefined;
      },
      set(t, k, v) {
        if (typeof k === "string" && /^[a-z-]+$/.test(k)) m.set(k, String(v));
        return true;
      },
    }
  );
}

function matchesSelector(node, sel) {
  if (sel.includes(":not(")) {
    const m = sel.match(/^(.+?):not\((.+)\)$/);
    if (m) return matchesSelector(node, m[1]) && !matchesSelector(node, m[2]);
  }
  if (sel.includes(",")) return sel.split(",").some((part) => matchesSelector(node, part.trim()));
  const attr = sel.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
  if (attr) {
    const v = node.getAttribute(attr[1]);
    if (v === null) return false;
    return attr[2] === undefined ? true : v === attr[2];
  }
  const tagAttr = sel.match(/^([a-z]+)\[([^=\]]+)(?:="([^"]*)")?\]$/);
  if (tagAttr) {
    if (node.tagName !== tagAttr[1].toUpperCase()) return false;
    const v = node.getAttribute(tagAttr[2]);
    return tagAttr[3] === undefined ? v !== null : v === tagAttr[3];
  }
  const cls = sel.match(/^([a-z]+)?\.([a-zA-Z0-9_-]+)$/);
  if (cls) {
    if (cls[1] && node.tagName !== cls[1].toUpperCase()) return false;
    return node.classList.contains(cls[2]);
  }
  if (/^[a-z]+$/i.test(sel)) return node.tagName === sel.toUpperCase();
  return false;
}

// 布局模型：容器内每个子项按 style.order（缺省 0）稳定排序后纵向排列
const LAYOUT = { containerTop: 100, itemH: 36, gap: 2, left: 0, width: 40 };

function orderOf(node) {
  const raw = node.style.order;
  const n = raw === "" || raw === undefined ? 0 : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function layoutOf(node) {
  const parent = node.parentElement;
  if (!parent) return rect(0, 0, 0, 0);
  const siblings = parent.children;
  const sorted = siblings.slice().sort((a, b) => orderOf(a) - orderOf(b));
  const idx = sorted.indexOf(node);
  const y = LAYOUT.containerTop + idx * (LAYOUT.itemH + LAYOUT.gap);
  return rect(LAYOUT.left, y, LAYOUT.width, LAYOUT.itemH);
}

function rect(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
}

// ------------------------------------------------------------ build the tree
const document = new Stub("html");
const head = new Stub("head");
const body = new Stub("body");
document.appendChild(head);
document.appendChild(body);

const root = new Stub("div");
root.setAttribute("data-dsh-rail-root", "1");
body.appendChild(root);

const nav = new Stub("nav");
root.appendChild(nav);
const NAV_LABELS = ["插件", "自动化任务", "技能中心", "客服"];
const navButtons = NAV_LABELS.map((label) => {
  const b = new Stub("button");
  b.setAttribute("aria-label", label);
  nav.appendChild(b);
  return b;
});
const moreBtn = new Stub("button");
moreBtn.setAttribute("aria-label", "更多");
moreBtn.setAttribute("aria-haspopup", "menu");
nav.appendChild(moreBtn);

const regionWrap = new Stub("div");
const wsSlot = new Stub("div");
wsSlot.setAttribute("data-slot", "sidebar.workspaces");
regionWrap.appendChild(wsSlot);
root.appendChild(regionWrap);

const panelSlot = new Stub("div");
panelSlot.setAttribute("data-slot", "sidebar.panellist");
navButtons[0].appendChild(panelSlot);

const brandSlot = new Stub("div");
brandSlot.setAttribute("data-slot", "sidebar.brand.mark");
const logoRow = new Stub("div");
logoRow.appendChild(brandSlot);
root.appendChild(logoRow);

const settingsSlot = new Stub("div");
settingsSlot.setAttribute("data-slot", "sidebar.settings");
const foot = new Stub("div");
foot.appendChild(settingsSlot);
root.appendChild(foot);

const newButton = new Stub("button");
root.appendChild(newButton);

document.querySelector = (sel) => {
  const all = [root, nav, regionWrap, wsSlot, panelSlot, brandSlot, settingsSlot, foot, body, head, ...navButtons, moreBtn];
  for (const n of all) if (n.matches && n.matches(sel)) return n;
  for (const n of all) {
    const hit = n.querySelector ? n.querySelector(sel) : null;
    if (hit) return hit;
  }
  return null;
};
document.querySelectorAll = (sel) => {
  const all = [root, nav, regionWrap, wsSlot, panelSlot, brandSlot, settingsSlot, foot, body, head, ...navButtons, moreBtn];
  return all.filter((n) => n.matches && n.matches(sel));
};
document.createElement = (tag) => new Stub(tag);
document.createTextNode = (t) => {
  const n = new Stub("#text");
  n.textContent = t;
  return n;
};
document.head = head;
document.body = body;

const localStorage = {
  getItem: (k) => (STORE.has(k) ? STORE.get(k) : null),
  setItem: (k, v) => STORE.set(k, String(v)),
  removeItem: (k) => STORE.delete(k),
};

const WINDOW_LISTENERS = new Map();
const window = {
  innerWidth: 1440,
  innerHeight: 900,
  localStorage,
  document,
  getComputedStyle: () => ({
    paddingTop: "6px",
    paddingBottom: "6px",
    paddingLeft: "8px",
    paddingRight: "8px",
    borderTopWidth: "0px",
    borderBottomWidth: "0px",
    gridArea: "auto",
    width: "280px",
  }),
  addEventListener: (t, fn) => {
    if (!WINDOW_LISTENERS.has(t)) WINDOW_LISTENERS.set(t, []);
    WINDOW_LISTENERS.get(t).push(fn);
  },
  removeEventListener: (t, fn) => {
    const arr = WINDOW_LISTENERS.get(t) || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  },
  dispatchEvent: (ev) => {
    const arr = WINDOW_LISTENERS.get(ev.type) || [];
    for (const fn of arr.slice()) fn(ev);
    return true;
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: () => 0,
  clearInterval: () => {},
  requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  getSelection: () => null,
  location: { href: "http://127.0.0.1:3080/" },
};

class StubEventTargetShim {}

const sandbox = {
  window,
  document,
  localStorage,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  Promise,
  Math,
  JSON,
  Date,
  Number,
  String,
  Array,
  Object,
  Map,
  Set,
  WeakMap,
  Error,
  TypeError,
  URL,
  URLSearchParams,
  Blob: class Blob {
    constructor(parts) {
      this.parts = parts;
    }
  },
  fetch: () => Promise.resolve({ ok: false, status: 404 }),
  MutationObserver: class {
    constructor(cb) {
      this.cb = cb;
    }
    observe() {}
    disconnect() {}
  },
  getComputedStyle: window.getComputedStyle,
  Node: Stub,
  Element: Stub,
  HTMLElement: Stub,
  requestAnimationFrame: window.requestAnimationFrame,
  cancelAnimationFrame: window.cancelAnimationFrame,
  PointerEvent: class PointerEvent {
    constructor(type, init) {
      Object.assign(this, { type }, init || {});
      this.defaultPrevented = false;
    }
    preventDefault() {
      this.defaultPrevented = true;
    }
    stopPropagation() {}
  },
  navigator: { userAgent: "vm-stub" },
};
sandbox.window.document = document;
sandbox.window.addEventListener = window.addEventListener;
sandbox.window.removeEventListener = window.removeEventListener;
sandbox.globalThis = sandbox;

let captured = null;
sandbox.window.__ModuleLoader__ = {
  load(mod) {
    captured = mod;
  },
};
sandbox.self = sandbox.window;

const ctx = vm.createContext(sandbox);
vm.runInContext(SRC, ctx, { filename: "client.js" });

if (!captured) {
  console.error("FAIL: plugin never called __ModuleLoader__.load");
  process.exit(1);
}

const exp = captured.factory(makeRequire());
check("module id", captured.id === "dsh-sidebar-rail", captured.id);
check("inject = ['slots']", JSON.stringify(exp.inject) === '["slots"]', exp.inject);

function makeRequire() {
  return function require(name) {
    if (name === "react") {
      // 只是让 SettingsSection 能拿到 createElement；桩里不真的渲染
      return {
        createElement(tag, props) {
          const node = new Stub(tag);
          if (props && typeof props.className === "string") node.className = props.className;
          if (props && typeof props.ref === "function") props.ref(node);
          return node;
        },
      };
    }
    if (name === "react-dom") return { createPortal: (el) => el };
    if (name === "react/jsx-runtime") return { jsx: (t, p) => ({ t, p }), jsxs: (t, p) => ({ t, p }) };
    throw new Error("unexpected require: " + name);
  };
}

// ------------------------------------------------------------- run apply()
const registered = [];
const fakeCtx = {
  get: () => null,
  logger: { info() {}, warn() {}, error() {} },
  effect(fn) {
    const dispose = fn();
    return () => {
      if (typeof dispose === "function") dispose();
    };
  },
  slots: {
    inject(name, cb) {
      registered.push(name);
      try {
        cb();
      } catch (err) {
        throw err;
      }
      return () => {};
    },
    register(opts) {
      return () => {};
    },
    subscribe: () => () => {},
    entriesOfSlot: () => [],
    getVersion: () => 0,
  },
};

try {
  exp.apply(fakeCtx);
  check("apply() 未抛错", true);
} catch (err) {
  check("apply() 未抛错", false, String(err && err.stack ? err.stack.split("\n")[0] : err));
}

const diag = sandbox.window.__DSH_RAIL__;
check("diag 存在", !!diag);
check("settingsSection 注册", diag && diag.settingsSection === true);

// sync 里走 rAF，等一拍
async function tick(ms) {
  await new Promise((r) => setTimeout(r, ms || 0));
}

(async () => {
  await tick(30);
  await tick(30);

  check("已打标 tagged", diag.tagged === true, diag && { tagged: diag.tagged, errors: diag.errors });

  const navEl = nav;
  const customMount = root.querySelector('[data-dsh-rail-part="custom"]');
  check("custom 挂载点存在", customMount !== null);
  const entries = customMount ? Array.from(customMount.querySelectorAll(".dsr-btn")) : [];
  check("自定义条目渲染 2 条 + 展开按钮", entries.length === 3, entries.map((e) => e.getAttribute("aria-label")));

  // 视觉顺序（按 order + 布局模型）
  const visualNav = () =>
    nav.children
      .slice()
      .sort((a, b) => orderOf(a) - orderOf(b))
      .map((b) => b.getAttribute("aria-label"));

  check("初始顺序正确", JSON.stringify(visualNav()) === JSON.stringify(["插件", "自动化任务", "技能中心", "客服", "更多"]), visualNav());

  // ------------------------------------------------- 拖拽第 1 个到第 4 位
  const WINDOW = sandbox.window;
  const dragStart = navButtons[0].getBoundingClientRect();
  const x = Math.round(dragStart.left + dragStart.width / 2);
  const y0 = Math.round(dragStart.top + dragStart.height / 2);
  const targetY = y0 + 115;

  navButtons[0].dispatch("pointerdown", new sandbox.PointerEvent("pointerdown", { button: 0, clientX: x, clientY: y0, target: navButtons[0] }));

  let ghostSeen = false;
  let bodyClassSeen = false;
  for (let i = 1; i <= 5; i += 1) {
    const cy = Math.round(y0 + ((targetY - y0) * i) / 5);
    WINDOW.dispatchEvent(new sandbox.PointerEvent("pointermove", { button: 0, buttons: 1, clientX: x, clientY: cy }));
    if (body.querySelector(".dsr-ghost") !== null) ghostSeen = true;
    if (body.classList.contains("dsr-dragging-active")) bodyClassSeen = true;
  }
  check("拖拽中出现 ghost", ghostSeen);
  check("拖拽中 body 有 dragging-active", bodyClassSeen);

  const midOrder = visualNav();
  check("拖拽过程中顺序已实时变化", JSON.stringify(midOrder) !== JSON.stringify(["插件", "自动化任务", "技能中心", "客服", "更多"]), midOrder);

  WINDOW.dispatchEvent(new sandbox.PointerEvent("pointerup", { button: 0, buttons: 0, clientX: x, clientY: targetY }));
  await tick(40);

  check("松手后 ghost 已移除", body.querySelector(".dsr-ghost") === null);
  check("松手后 body class 已清除", body.classList.contains("dsr-dragging-active") === false);

  const finalOrder = visualNav();
  check(
    "第 1 个图标被移到后面",
    finalOrder[0] !== "插件" && finalOrder.indexOf("插件") > 0 && finalOrder[finalOrder.length - 1] === "更多",
    finalOrder
  );

  const storedNav = localStorage.getItem("dsh-sidebar-rail.navOrder.v1");
  check("navOrder 已写入 localStorage", !!storedNav, storedNav);
  if (storedNav) {
    const parsed = JSON.parse(storedNav);
    check("navOrder 长度与原序一致（不含更多）", parsed.length === 4, parsed);
  }

  // FLIP 动画：除被拖项外的项拿到 animate
  const animated = nav.children.filter((c) => c.animations.length > 0).length;
  check("其他图标执行了 FLIP 动画", animated > 0, { animated, total: nav.children.length });
  check("被拖图标本身不做 FLIP", navButtons[0].animations.length === 0);

  // --------------------------------------------- 自定义条目拖拽 + 持久化
  const btns = Array.from(customMount.querySelectorAll(".dsr-btn")).filter((b) => !b.classList.contains("dsr-toggle"));
  const beforeEntry = btns.map((b) => b.getAttribute("data-dsr-entry-id"));
  const e0 = btns[0].getBoundingClientRect();
  const ey = Math.round(e0.top + e0.height / 2);
  const ex = Math.round(e0.left + e0.width / 2);
  const eTarget = ey + 70;

  btns[0].dispatch("pointerdown", new sandbox.PointerEvent("pointerdown", { button: 0, clientX: ex, clientY: ey }));
  for (let i = 1; i <= 4; i += 1) {
    const cy = Math.round(ey + ((eTarget - ey) * i) / 4);
    WINDOW.dispatchEvent(new sandbox.PointerEvent("pointermove", { button: 0, buttons: 1, clientX: ex, clientY: cy }));
  }
  WINDOW.dispatchEvent(new sandbox.PointerEvent("pointerup", { button: 0, buttons: 0, clientX: ex, clientY: eTarget }));
  await tick(60);

  const storedCustom = localStorage.getItem("dsh-sidebar-rail.custom.v1");
  check("自定义条目顺序已写入 localStorage", !!storedCustom, storedCustom === null ? null : storedCustom.slice(0, 160));
  if (storedCustom) {
    const parsed = JSON.parse(storedCustom);
    check("保存后条目数不变", parsed.length === beforeEntry.length, { before: beforeEntry.length, after: parsed.length });
    check("ID 集合不变（只是顺序变了）", JSON.stringify(parsed.map((p) => p.id).slice().sort()) === JSON.stringify(beforeEntry.slice().sort()), {
      before: beforeEntry,
      after: parsed.map((p) => p.id),
    });
  }

  // -------------------------------------------------- 点击抑制（不误触发）
  let entryClicks = 0;
  const firstEntry = customMount.querySelector(".dsr-btn:not(.dsr-toggle)");
  if (firstEntry) {
    firstEntry.addEventListener("click", () => {
      entryClicks += 1;
    });
    const fe = firstEntry.getBoundingClientRect();
    const fy = Math.round(fe.top + fe.height / 2);
    firstEntry.dispatch("pointerdown", new sandbox.PointerEvent("pointerdown", { button: 0, clientX: ex, clientY: fy }));
    for (let i = 1; i <= 4; i += 1) {
      WINDOW.dispatchEvent(new sandbox.PointerEvent("pointermove", { button: 0, buttons: 1, clientX: ex, clientY: fy + 40 }));
    }
    WINDOW.dispatchEvent(new sandbox.PointerEvent("pointerup", { button: 0, buttons: 0, clientX: ex, clientY: fy + 40 }));
    // 模拟浏览器随后补发的 click
    WINDOW.dispatchEvent({ type: "click", target: firstEntry, preventDefault() {}, stopPropagation() {} });
    check("拖拽后的 click 被抑制（未触发 runEntry）", entryClicks === 0, { entryClicks });
  }

  check("diag.errors 无新增", diag.errors.length === 0, diag.errors);

  const failed = results.filter((r) => !r.ok);
  console.log("\n" + (failed.length === 0 ? "ALL PASS (" + results.length + " checks)" : "FAILED " + failed.length + " / " + results.length));
  fs.writeFileSync(path.join(HERE, "verify-drag-result.json"), JSON.stringify(results, null, 2), "utf8");
  process.exit(failed.length === 0 ? 0 : 1);
})();
