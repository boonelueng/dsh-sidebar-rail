// dsh-sidebar-rail / 模块隔离回归
//
// 目的：证明「某一个模块出问题不影响整体工作」这条承诺是真的，而不是写在 README 里的愿望。
// 手法：在同一个 DOM 桩里分别制造四种故障，逐个断言内核与其余模块仍然正常。
//
//   1. chunk 加载失败（404 / 文件不存在）
//   2. chunk 的 factory 抛错（语法级灾难）
//   3. chunk 导出对象残缺（没有 install）
//   4. install() 在装配期抛错
//   5. 模块在运行期某个接口抛错（应当被摘掉并降级，不冒泡）
//
// 每种故障都要求：并列布局仍成立、其余模块仍在位、diag.errors 里有可定位的一条记录。

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = __dirname;
const KERNEL = fs.readFileSync(path.join(ROOT, "client.js"), "utf8");
const CHUNKS = {
  "client.drag.js": fs.readFileSync(path.join(ROOT, "client.drag.js"), "utf8"),
  "client.float.js": fs.readFileSync(path.join(ROOT, "client.float.js"), "utf8"),
  "client.settings.js": fs.readFileSync(path.join(ROOT, "client.settings.js"), "utf8"),
};

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log("PASS  " + name + (detail === undefined ? "" : "  " + JSON.stringify(detail)));
  } else {
    failures += 1;
    console.log("FAIL  " + name + (detail === undefined ? "" : "  " + JSON.stringify(detail)));
  }
}

// --------------------------------------------------------------- DOM 桩
// 只实现内核真正用到的面。布局按 CSS 里的规则近似：nav 竖排在左，region 在右。
const LAYOUT = { rootTop: 0, rootLeft: 0, rootW: 280, rootH: 900, navW: 40, navTop: 112, itemH: 36, gap: 2 };

class Stub {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.dataset = {};
    this.className = "";
    this.id = "";
    this._text = "";
    this._style = new Map();
    this.style = {
      setProperty: (k, v) => this._style.set(k, String(v)),
      getPropertyValue: (k) => (this._style.has(k) ? this._style.get(k) : ""),
      removeProperty: (k) => this._style.delete(k),
      get order() {
        return "";
      },
      set order(v) {
        this._order = String(v);
      },
    };
  }
  get order() {
    return this._order === undefined ? "" : this._order;
  }
  get textContent() {
    if (this._text) return this._text;
    return this.children.map((c) => c.textContent || "").join("");
  }
  set textContent(v) {
    this._text = String(v);
  }
  get classList() {
    const self = this;
    return {
      add(...names) {
        const set = new Set(self.className.split(/\s+/).filter(Boolean));
        names.forEach((n) => set.add(n));
        self.className = Array.from(set).join(" ");
      },
      remove(...names) {
        const set = new Set(self.className.split(/\s+/).filter(Boolean));
        names.forEach((n) => set.delete(n));
        self.className = Array.from(set).join(" ");
      },
      contains(n) {
        return self.className.split(/\s+/).includes(n);
      },
      toggle(n, on) {
        if (on === undefined ? !this.contains(n) : on) this.add(n);
        else this.remove(n);
      },
    };
  }
  setAttribute(k, v) {
    this.attributes.set(String(k), String(v));
    if (String(k).startsWith("data-")) {
      const key = String(k).slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(v);
    }
  }
  getAttribute(k) {
    return this.attributes.has(String(k)) ? this.attributes.get(String(k)) : null;
  }
  hasAttribute(k) {
    return this.attributes.has(String(k));
  }
  removeAttribute(k) {
    this.attributes.delete(String(k));
  }
  appendChild(node) {
    node.parentElement = this;
    this.children.push(node);
    return node;
  }
  append(node) {
    return this.appendChild(node);
  }
  prepend(node) {
    node.parentElement = this;
    this.children.unshift(node);
    return node;
  }
  removeChild(node) {
    if (!node) return node;
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    node.parentElement = null;
    return node;
  }
  get firstChild() {
    return this.children.length > 0 ? this.children[0] : null;
  }
  get lastChild() {
    return this.children.length > 0 ? this.children[this.children.length - 1] : null;
  }
  remove() {
    if (this.parentElement) this.parentElement.removeChild(this);
  }
  contains(node) {
    let n = node;
    while (n) {
      if (n === this) return true;
      n = n.parentElement;
    }
    return false;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (matches(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  closest(sel) {
    let n = this;
    while (n) {
      if (matches(n, sel)) return n;
      n = n.parentElement;
    }
    return null;
  }
  addEventListener(type, fn) {
    if (type === "click") this._onClick = fn;
  }
  removeEventListener(type) {
    if (type === "click") this._onClick = null;
  }
  getBoundingClientRect() {
    const rect = layoutOf(this);
    return {
      x: rect.left,
      y: rect.top,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
    };
  }
  getAnimations() {
    return [];
  }
  animate() {
    return { cancel() {}, finished: Promise.resolve() };
  }  dispatch() {}
  dispatchClick() {
    const handler = this._onClick;
    if (typeof handler === "function") handler({ type: "click", target: this, currentTarget: this });
  }
  focus() {}
  setPointerCapture() {}
  releasePointerCapture() {}
}

function layoutOf(node) {
  if (node.getAttribute && node.getAttribute("data-dsh-rail-part") === "nav") {
    const items = node.children.length;
    return { left: LAYOUT.rootLeft, top: LAYOUT.navTop, width: LAYOUT.navW, height: items * (LAYOUT.itemH + LAYOUT.gap) };
  }
  if (node.getAttribute && node.getAttribute("data-dsh-rail-part") === "region") {
    return {
      left: LAYOUT.rootLeft + LAYOUT.navW + 1,
      top: LAYOUT.navTop,
      width: LAYOUT.rootW - LAYOUT.navW - 1,
      height: LAYOUT.rootH - LAYOUT.navTop,
    };
  }
  return { left: 0, top: LAYOUT.rootH - 158, width: LAYOUT.navW, height: 158 };
}

function matches(node, sel) {
  if (!sel) return false;
  const parts = String(sel).split(",").map((s) => s.trim());
  return parts.some((part) => {
    let rest = part;
    if (rest.startsWith(":scope > ")) rest = rest.slice(9);
    const tagMatch = rest.match(/^[a-zA-Z]+/);
    const wantTag = tagMatch ? tagMatch[0].toUpperCase() : null;
    if (wantTag && node.tagName !== wantTag) return false;
    // 属性选择器：先校验，再把整段从 rest 里抠掉——
    // 否则 `[data-slot="sidebar.workspaces"]` 里的 `.workspaces` 会被下头的
    // 类选择器正则当成 className 去匹配，导致选择器永远不命中。
    const attrRe = /\[([^=\]]+)(?:="([^"]*)")?\]/g;
    let m;
    const attrSpans = [];
    while ((m = attrRe.exec(rest)) !== null) {
      const key = m[1];
      const want = m[2];
      if (!node.hasAttribute(key)) return false;
      if (want !== undefined && node.getAttribute(key) !== want) return false;
      attrSpans.push([m.index, m.index + m[0].length]);
    }
    let stripped = rest;
    for (let i = attrSpans.length - 1; i >= 0; i--) {
      const [a, b] = attrSpans[i];
      stripped = stripped.slice(0, a) + " ".repeat(b - a) + stripped.slice(b);
    }
    const clsRe = /\.([A-Za-z0-9_-]+)/g;
    while ((m = clsRe.exec(stripped)) !== null) {
      if (!node.className.split(/\s+/).includes(m[1])) return false;
    }
    return true;
  });
}

function makeDocument() {
  const html = new Stub("html");
  const head = new Stub("head");
  const body = new Stub("body");
  html.appendChild(head);
  html.appendChild(body);
  const doc = {
    documentElement: html,
    head,
    body,
    createElement: (tag) => new Stub(tag),
    querySelector: (sel) => (body.contains(html) ? html.querySelector(sel) : html.querySelector(sel)),
    querySelectorAll: (sel) => html.querySelectorAll(sel),
    addEventListener() {},
    removeEventListener() {},
    title: "",
  };
  return { doc, html, head, body };
}

// --------------------------------------------------------------- 沙箱
function makeSandbox() {
  const { doc, html, head, body } = makeDocument();
  const sandbox = {
    console,
    setTimeout: (fn) => {
      // 同步执行即可：桩里不需要真实延迟，且能保证断言前状态已稳定
      try {
        fn();
      } catch (e) {
        /* 忽略桩里的定时器异常 */
      }
      return 0;
    },
    clearTimeout() {},
    requestAnimationFrame: (fn) => {
      try {
        fn(0);
      } catch (e) {
        /* ignore */
      }
      return 1;
    },
    cancelAnimationFrame() {},
    Promise,
    JSON,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Error,
    Map,
    Set,
    RegExp,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.document = doc;
  sandbox.window.document = doc;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.window.addEventListener = sandbox.addEventListener;
  sandbox.window.removeEventListener = sandbox.removeEventListener;
  sandbox.window.innerWidth = 1440;
  sandbox.window.innerHeight = 900;
  sandbox.window.getComputedStyle = () => ({
    borderTopWidth: "0px",
    borderBottomWidth: "0px",
    paddingLeft: "0px",
    paddingTop: "0px",
    gridArea: "auto",
    width: "280px",
  });
  sandbox.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  sandbox.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  sandbox.localStorage = (() => {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(String(k), String(v)),
      removeItem: (k) => map.delete(k),
      clear: () => map.clear(),
    };
  })();
  sandbox.HTMLElement = Stub;
  sandbox.Element = Stub;
  sandbox.Node = Stub;

  let captured = null;
  const chunkRegistrations = new Map();
  sandbox.window.__ModuleLoader__ = {
    load(mod) {
      if (!mod) return;
      if (mod.chunk === undefined) captured = mod;
      else chunkRegistrations.set(mod.chunk, mod);
    },
  };

  return { sandbox, html, body, head, getCaptured: () => captured, chunkRegistrations };
}

function makeRequire(chunkRegistrations, overrides) {
  const opts = overrides || {};
  const require = function require(name) {
    if (name === "react") {
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
  const materialized = new Map();
  require.async = async function (spec) {
    const fileName = String(spec).replace(/^\.\//, "");
    if (materialized.has(fileName)) return materialized.get(fileName);
    // 故障注入点
    if (opts.failLoad && opts.failLoad.indexOf(fileName) >= 0) {
      throw new Error("simulated 404 for " + fileName);
    }
    if (opts.failFactory && opts.failFactory.indexOf(fileName) >= 0) {
      throw new Error("simulated factory crash in " + fileName);
    }
    const reg = chunkRegistrations.get(fileName);
    if (!reg) throw new Error("chunk not registered: " + fileName);
    let out = reg.factory(makeRequire(chunkRegistrations, opts));
    if (opts.stripInstall && opts.stripInstall.indexOf(fileName) >= 0) {
      out = Object.assign({}, out);
      delete out.install;
    }
    if (opts.failInstall && opts.failInstall.indexOf(fileName) >= 0) {
      out = Object.assign({}, out, {
        install() {
          throw new Error("simulated install crash in " + fileName);
        },
      });
    }
    materialized.set(fileName, out);
    return out;
  };
  return require;
}

// 搭一个足以让 sync() 通过早退检查的侧边栏骨架
function buildSidebar(body) {
  const col = new Stub("div");
  col.className = "sidebarCol";
  body.appendChild(col);

  const root = new Stub("div");
  col.appendChild(root);

  const logo = new Stub("div");
  root.appendChild(logo);
  const brand = new Stub("span");
  brand.setAttribute("data-slot", "sidebar.brand.mark");
  logo.appendChild(brand);

  const newBtn = new Stub("button");
  root.appendChild(newBtn);

  const nav = new Stub("nav");
  nav.setAttribute("data-dsh-rail-part-hint", "1");
  root.appendChild(nav);
  for (const label of ["插件", "自动化任务", "技能中心", "客服", "更多"]) {
    const btn = new Stub("button");
    btn.setAttribute("aria-label", label);
    if (label === "更多") btn.setAttribute("aria-haspopup", "menu");
    const glyph = new Stub("span");
    const slotSpan = new Stub("span");
    slotSpan.setAttribute("data-slot", "sidebar.panellist");
    glyph.appendChild(slotSpan);
    btn.appendChild(glyph);
    const title = new Stub("span");
    title.textContent = label;
    btn.appendChild(title);
    nav.appendChild(btn);
  }

  const region = new Stub("div");
  root.appendChild(region);
  const wsSlot = new Stub("div");
  wsSlot.setAttribute("data-slot", "sidebar.workspaces");
  region.appendChild(wsSlot);

  const footWrap = new Stub("div");
  root.appendChild(footWrap);
  const settingsSlot = new Stub("div");
  settingsSlot.setAttribute("data-slot", "sidebar.settings");
  footWrap.appendChild(settingsSlot);

  return { col, root, nav, region, wsSlot };
}

async function runCase(label, overrides, expect) {
  const { sandbox, body, getCaptured, chunkRegistrations } = makeSandbox();

  // 把 chunk 注册进沙箱
  for (const [file, src] of Object.entries(CHUNKS)) {
    if (overrides && overrides.skipRegister && overrides.skipRegister.indexOf(file) >= 0) continue;
    vm.runInContext(src, vm.createContext(sandbox), { filename: file });
  }
  const ctxObj = vm.createContext(sandbox);
  vm.runInContext(KERNEL, ctxObj, { filename: "client.js" });

  const captured = getCaptured();
  if (!captured) {
    check(label + " / 内核注册", false, "never called __ModuleLoader__.load");
    return;
  }

  const parts = buildSidebar(body);
  const exp = captured.factory(makeRequire(chunkRegistrations, overrides));
  const fakeCtx = {
    get: () => null,
    logger: { info() {}, warn() {}, error() {} },
    effect: () => () => {},
    slots: {
      inject: (key, cb) => {
        cb();
        return () => {};
      },
      register: () => () => {},
      subscribe: () => () => {},
      entriesOfSlot: () => [],
      getVersion: () => 0,
    },
  };
  exp.apply(fakeCtx);

  // 让 loadModules 的 Promise 链跑完（沙箱里的 setTimeout 是同步的，微任务还要放一轮）
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const diag = sandbox.window.__DSH_RAIL__;
  check(label + " / 并列布局仍然成立", parts.root.getAttribute("data-dsh-rail-root") === "1", {
    root: parts.root.getAttribute("data-dsh-rail-root"),
    nav: parts.nav.getAttribute("data-dsh-rail-part"),
    region: parts.region.getAttribute("data-dsh-rail-part"),
  });
  check(label + " / custom 挂载点已建立", parts.root.querySelectorAll('[data-dsh-rail-part="custom"]').length === 1);
  check(label + " / diag.tagged", diag && diag.tagged === true, diag && diag.tagged);

  const custom = parts.root.querySelector('[data-dsh-rail-part="custom"]');
  const entryCount = custom ? custom.querySelectorAll(".dsr-btn").length : 0;
  check(label + " / 自定义条目仍然渲染", entryCount >= 2, entryCount);

  // 悬浮按钮是「float 模块活着」的可见证据
  const floatBtn = custom ? custom.querySelector(".dsr-float-toggle") : null;
  const floatAlive = floatBtn !== null;
  check(
    label + " / float 模块状态符合预期",
    floatAlive === (expect.float !== false),
    { alive: floatAlive, expected: expect.float !== false }
  );

  // 拖拽是否真的绑上了，看 nav 容器有没有被标记
  const dragBound = parts.nav.dataset.dsrDragBound === "1";
  check(label + " / drag 模块状态符合预期", dragBound === (expect.drag !== false), {
    bound: dragBound,
    expected: expect.drag !== false,
  });

  const errors = (diag && diag.errors) || [];
  const faultCount = errors.filter((e) => String(e).indexOf("module ") === 0).length;
  if (expect.faulted > 0) {
    check(label + " / 故障被记录到 diag.errors", faultCount === expect.faulted, errors);
  } else {
    check(label + " / 无模块故障", faultCount === 0, errors);
  }
  return { sandbox, parts, exp, diag, custom };
}

/**
 * 运行期故障：模块装好了，但某个接口在被调用时抛错。
 * 要求：这一次调用不冒泡、模块被摘掉、下一次调用走兜底，其余模块照旧。
 */
async function runRuntimeFaultCase() {
  const label = "runtime-throw";
  const { sandbox, body, getCaptured, chunkRegistrations } = makeSandbox();
  for (const [file, src] of Object.entries(CHUNKS)) {
    vm.runInContext(src, vm.createContext(sandbox), { filename: file });
  }
  const ctxObj = vm.createContext(sandbox);
  vm.runInContext(KERNEL, ctxObj, { filename: "client.js" });
  const captured = getCaptured();
  const parts = buildSidebar(body);

  // 让 float 模块的 toggle 在运行期炸掉，其他接口正常
  const originalGet = chunkRegistrations.get.bind(chunkRegistrations);
  const floatReg = chunkRegistrations.get("client.float.js");
  chunkRegistrations.set("client.float.js", {
    chunk: "client.float.js",
    factory(req) {
      const out = floatReg.factory(req);
      const realToggle = out.toggle;
      out.toggle = function () {
        throw new Error("simulated runtime throw in float.toggle");
      };
      out.__realToggle = realToggle;
      return out;
    },
  });
  void originalGet;

  const exp = captured.factory(makeRequire(chunkRegistrations, {}));
  exp.apply({
    get: () => null,
    logger: { info() {}, warn() {}, error() {} },
    effect: () => () => {},
    slots: {
      inject: (key, cb) => {
        cb();
        return () => {};
      },
      register: () => () => {},
      subscribe: () => () => {},
      entriesOfSlot: () => [],
      getVersion: () => 0,
    },
  });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const diag = sandbox.window.__DSH_RAIL__;
  const custom = parts.root.querySelector('[data-dsh-rail-part="custom"]');
  const floatBtn = custom ? custom.querySelector(".dsr-float-toggle") : null;
  check(label + " / 模块装好时按钮存在", floatBtn !== null);

  // 模拟点击：这一步会调 float.toggle，应当被 callModule 拦下
  let threw = false;
  try {
    floatBtn.dispatchClick();
  } catch (err) {
    threw = true;
  }
  check(label + " / 模块抛错没有冒泡到点击处理", threw === false, threw);
  check(
    label + " / 故障已记录",
    (diag.errors || []).some((e) => String(e).indexOf("simulated runtime throw") >= 0),
    diag.errors
  );
  check(label + " / 并列布局不受影响", parts.root.getAttribute("data-dsh-rail-root") === "1");
  check(label + " / drag 模块仍在", parts.nav.dataset.dsrDragBound === "1", parts.nav.dataset.dsrDragBound);
}

(async () => {
  console.log("=== dsh-sidebar-rail 模块隔离回归 ===\n");

  console.log("-- 基线：三个模块全部正常 --");
  await runCase("baseline", {}, { float: true, drag: true, faulted: 0 });

  console.log("\n-- 故障 1：float chunk 拿不到（404） --");
  await runCase(
    "float-404",
    { failLoad: ["client.float.js"] },
    { float: false, drag: true, faulted: 1 }
  );

  console.log("\n-- 故障 2：drag chunk 的 factory 抛错 --");
  await runCase(
    "drag-crash",
    { failFactory: ["client.drag.js"] },
    { float: true, drag: false, faulted: 1 }
  );

  console.log("\n-- 故障 3：settings chunk 缺 install --");
  await runCase(
    "settings-no-install",
    { stripInstall: ["client.settings.js"] },
    { float: true, drag: true, faulted: 1 }
  );

  console.log("\n-- 故障 4：install 期抛错 --");
  await runCase(
    "install-crash",
    { failInstall: ["client.float.js"] },
    { float: false, drag: true, faulted: 1 }
  );

  console.log("\n-- 故障 5：三个模块同时挂掉（最坏情况） --");
  await runCase(
    "all-down",
    { failLoad: ["client.drag.js", "client.float.js", "client.settings.js"] },
    { float: false, drag: false, faulted: 3 }
  );

  console.log("\n-- 故障 6：模块装好后在运行期抛错 --");
  await runRuntimeFaultCase();

  console.log("");
  if (failures === 0) {
    console.log("ALL PASS");
    process.exit(0);
  } else {
    console.log(failures + " FAILED");
    process.exit(1);
  }
})().catch((err) => {
  console.error("crashed:", err && err.stack ? err.stack : err);
  process.exit(2);
});
