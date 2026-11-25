// dsh-sidebar-rail — 把 DSH 左侧边栏改成「左窄条功能区 + 右侧会话区」并列布局，
// 并在功能条底部加入可自定义的条目（本地存储，支持增删改/排序/导出导入）。
//
// 设计要点：
//  - 不改 DSH 安装包、不注册 'sidebar' 槽（那会整体替换导航列）。
//  - 只用 slot 渲染器固定的 [data-slot="..."] 锚点 + 自有 data-dsh-rail-* 属性做纯增强。
//  - 一旦找不到锚点、或侧边栏处于折叠/drawer 态，就移除全部标记，完整退回原生布局。
//  - 自定义条目与编辑器用原生 DOM 构建，不依赖 react-dom 的 createRoot/render 差异。

window.__ModuleLoader__.load({
  id: "dsh-sidebar-rail",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    /**
     * 只硬依赖 slots（注册槽位所必需）。
     * layout / uiWorkspace 用 ctx.get 惰性取，缺失时相应动作降级而不阻塞插件加载。
     */
    const inject = ["slots"];

    const PLUGIN_ID = "dsh-sidebar-rail";
    const ATTR_ROOT = "data-dsh-rail-root";
    const ATTR_NAV = "data-dsh-rail-nav";
    const ATTR_PART = "data-dsh-rail-part";
    const ATTR_HIDE = "data-dsh-rail-hide";
    const STORAGE_CUSTOM = "dsh-sidebar-rail.custom.v1";
    const STORAGE_OFF = "dsh-sidebar-rail:off";
    const STORAGE_EXPANDED = "dsh-sidebar-rail.railExpanded.v1";
    const STORAGE_NAV_ORDER = "dsh-sidebar-rail.navOrder.v1";
    const STORAGE_FLOAT = "dsh-sidebar-rail.float.v1";
    const STORAGE_FEATURES = "dsh-sidebar-rail.features.v1";
    const ATTR_FLOAT = "data-dsh-rail-float";
    const SETTINGS_SECTION = "settings.section";
    const SETTINGS_SECTION_ID = "dsh-sidebar-rail.settings";
    /** 轨道（功能区）宽度：收起为窄条，展开为带文字标签的宽条 */
    const RAIL_W = 40;
    const RAIL_W_EXPANDED = 180;

    const SEL_WORKSPACES = '[data-slot="sidebar.workspaces"]';
    const SEL_PANELLIST = '[data-slot="sidebar.panellist"]';
    const SEL_BRAND = '[data-slot="sidebar.brand.mark"]';
    const SEL_SETTINGS = '[data-slot="sidebar.settings"]';

    const INPUT_SLOT = "conversation.input.left";

    const DEFAULT_ENTRIES = [
      {
        id: "default-review",
        icon: "✎",
        label: "审查改动",
        action: { type: "prompt", text: "请审查当前工作区的改动，指出主要风险与改进点。" },
      },
      {
        id: "default-plugins",
        icon: "◈",
        label: "插件面板",
        action: { type: "panel", id: "plugins" },
      },
    ];

    const ACTION_TYPES = [
      { value: "prompt", label: "填入提示词（当前输入框）" },
      { value: "session", label: "开新会话并发送" },
      { value: "panel", label: "打开全局面板" },
      { value: "url", label: "打开链接" },
    ];

    // 注意：子 chunk（client.drag/float/settings/window.js）的缓存 rev 由「本文件」的
    // mtime/ctime/size 决定，而非各子 chunk 自身。改完任何一个子 chunk 后，必须让本文件
    // 也发生变化（bump 下方 version 或任何实质改动），否则子 chunk 的 URL rev 不变，
    // 浏览器按 immutable 缓存继续用旧子 chunk —— 这正是「改了窗口代码但重启后无变化」的根因。
    /** 诊断对象，挂在 window.__DSH_RAIL__ 供控制台核对 */
    const diag = {
      loaded: true,
      version: "1.0.13",
      tagged: false,
      disabled: null,
      anchors: { root: false, nav: false, region: false, logo: false, foot: false, newButton: false },
      custom: false,
      entries: 0,
      hasInput: false,
      expanded: false,
      floating: false,
      floatPos: null,
      settingsSection: false,
      // 跨版本兼容：本插件不按版本号分支，只按「宿主真的提供了什么」行事。
      // 这里记录这次探测到的能力面，出问题时一眼能看出是哪一层降级了。
      compat: {
        dshVersion: null,
        slots: false,
        slotInject: false,
        slotRegister: false,
        requireAsync: false,
        ctxGet: false,
        ctxEffect: false,
        sidebarCollapsed: null,
        railColumn: null,
        notes: [],
      },
      errors: [],
    };
    window.__DSH_RAIL__ = diag;

    // ------------------------------------------------------------- module host
    /**
     * 可选模块表。三个功能各自是一个独立 chunk：
     *   drag     —— 轨道图标拖拽排序
     *   float    —— 整条竖轨悬浮到视口任意位置
     *   settings —— 条目编辑（DSH 设置页 + 内联弹层）
     *
     * 设计原则：**内核不依赖任何模块**。模块加载失败、install 抛错、
     * 运行期出错，都只让那一项功能消失，并列布局与其余模块照常工作。
     * 每个模块在 install(api) 里拿到下面这个最小接口，不直接碰内核闭包。
     */
    const modules = { drag: null, float: null, settings: null, window: null };
    /** 模块级故障记录（去重后进 diag.errors，方便宿主侧报告里定位） */
    const moduleFaults = [];
    /** 轨道宽度（px）：内核维护，悬浮模块通过 api.railWidth() 只读 */
    let railWidthPx = RAIL_W;
    /** 悬浮态缓存：模块缺席时恒为 false，渲染层据此隐藏悬浮按钮 */
    let floatOn = false;

    function pushError(message) {
      diag.errors.push(String(message));
    }

    /** 只在该变量确实变化时才写：无谓的 setProperty 会让整棵子树重算样式 */
    function setVar(node, name, value) {
      if (node.style.getPropertyValue(name) === value) return false;
      node.style.setProperty(name, value);
      return true;
    }

    /** 记录一次模块故障；同一模块只记第一次，避免刷屏 */
    function faultModule(key, err) {
      const text = String(err && err.message !== undefined ? err.message : err);
      if (moduleFaults.indexOf(key + ": " + text) < 0) {
        moduleFaults.push(key + ": " + text);
        diag.errors.push("module " + key + ": " + text);
      }
    }

    /**
     * 调一个模块的导出函数。
     * 模块不在 → 静默返回兜底值；模块抛错 → 记一次故障并把它摘掉（之后都走兜底）。
     * 这样「某一模块坏掉」不会向上冒泡成整个 side rail 的故障。
     */
    function callModule(key, fnName, args, fallback) {
      const mod = modules[key];
      if (mod === null || typeof mod[fnName] !== "function") return fallback;
      try {
        return mod[fnName].apply(mod, args || []);
      } catch (err) {
        faultModule(key, err);
        modules[key] = null;
        return fallback;
      }
    }

    /** 悬浮态：模块在就问它，模块缺席一律视为停靠 */
    function floatState() {
      if (modules.float === null) return false;
      const on = callModule("float", "isOn", [], false);
      floatOn = on === true;
      return floatOn;
    }

    // --------------------------------------------------------- feature switches
    /**
     * 功能开关：每个可选功能一个条目，独立启停、独立持久化。
     *
     * 设计：开关状态归内核管（模块只读），这样任何一个模块缺席或抛错都不会让
     * 其他开关失效；关掉的功能在模块内部短路——不建 DOM、不绑事件、入口早退。
     * 默认全开：与本插件此前的行为一致，用户不动开关就什么都不会变。
     *
     * 生效方式：保存后立即写 localStorage 并就地应用（不需要刷新）。
     */
    const FEATURES = [
      {
        key: "drag",
        label: "按住任意位置拖动",
        desc: "按住设置窗口的任意位置（按钮、输入框等交互元素除外）把它拖走",
      },
    ];

    const FEATURE_KEYS = FEATURES.map(function (item) {
      return item.key;
    });

    /** 开关状态：缺省全开；读盘失败也当全开（宁可保持旧行为，不要突然少功能） */
    const featureState = {};
    FEATURE_KEYS.forEach(function (key) {
      featureState[key] = true;
    });

    function loadFeatures() {
      let saved = null;
      try {
        const raw = window.localStorage.getItem(STORAGE_FEATURES);
        if (raw !== null && raw !== "") saved = JSON.parse(raw);
      } catch (err) {
        saved = null;
      }
      if (saved !== null && typeof saved === "object") {
        FEATURE_KEYS.forEach(function (key) {
          if (typeof saved[key] === "boolean") featureState[key] = saved[key];
        });
      }
      // 即使没读过盘也要留一份快照：控制台核对与回归脚本都靠它看当前开关状态。
      diag.features = featureSnapshot();
    }

    function saveFeatures() {
      const out = {};
      FEATURE_KEYS.forEach(function (key) {
        out[key] = featureState[key] === true;
      });
      try {
        window.localStorage.setItem(STORAGE_FEATURES, JSON.stringify(out));
      } catch (err) {
        diag.errors.push("features-save: " + String(err));
      }
    }

    /** 读开关：未知名字一律返回 false（当作「没有这个功能」） */
    function getFeature(name) {
      if (typeof name !== "string") return false;
      if (FEATURE_KEYS.indexOf(name) < 0) return false;
      return featureState[name] === true;
    }

    /**
     * 写开关：状态变了才落盘，并把改动通知到模块。
     * 模块可以选择实现 onFeaturesChanged(next) 做就地应用；没实现就只更新状态，
     * 下次面板重建时自然按新开关工作。
     */
    function setFeature(name, on) {
      if (typeof name !== "string" || FEATURE_KEYS.indexOf(name) < 0) return false;
      const want = on === true;
      if (featureState[name] === want) return true;
      featureState[name] = want;
      saveFeatures();
      diag.features = featureSnapshot();
      // 通知各模块：模块可能正挂着不该挂的 DOM，让它们自己收尾。
      Object.keys(modules).forEach(function (key) {
        if (modules[key] === null) return;
        callModule(key, "onFeaturesChanged", [featureSnapshot()], undefined);
      });
      return true;
    }

    function featureSnapshot() {
      const out = {};
      FEATURE_KEYS.forEach(function (key) {
        out[key] = featureState[key] === true;
      });
      return out;
    }

    /** 内核给模块的最小接口（模块只认这份契约，不碰内核闭包） */
    const moduleApi = {
      diag: diag,
      ATTR_ROOT: ATTR_ROOT,
      ATTR_NAV: ATTR_NAV,
      ATTR_PART: ATTR_PART,
      ATTR_HIDE: ATTR_HIDE,
      ATTR_FLOAT: ATTR_FLOAT,
      STORAGE_CUSTOM: STORAGE_CUSTOM,
      STORAGE_EXPANDED: STORAGE_EXPANDED,
      STORAGE_NAV_ORDER: STORAGE_NAV_ORDER,
      STORAGE_FLOAT: STORAGE_FLOAT,
      ACTION_TYPES: ACTION_TYPES,
      DEFAULT_ENTRIES: DEFAULT_ENTRIES,
      RAIL_W: RAIL_W,
      RAIL_W_EXPANDED: RAIL_W_EXPANDED,
      el: el,
      clear: clear,
      clone: clone,
      sanitizeEntry: sanitizeEntry,
      actionSummary: actionSummary,
      getReact: getReact,
      saveEntries: saveEntries,
      getEntries: function () {
        return entries;
      },
      pushError: pushError,
      schedule: schedule,
      scheduleReport: scheduleReport,
      renderRail: renderRail,
      applyRailState: applyRailState,
      measureCustom: measureCustom,
      setRailExpanded: setRailExpanded,
      isRailExpanded: function () {
        return railExpanded === true;
      },
      railWidth: function () {
        return railWidthPx;
      },
      setVar: setVar,
      STORAGE_FEATURES: STORAGE_FEATURES,
      FEATURES: FEATURES,
      getFeature: getFeature,
      setFeature: setFeature,
      featureSnapshot: featureSnapshot,
    };

    /** 展开/收起：归内核管，模块只能通过这个口子请求（悬浮时自动展开就靠它） */
    function setRailExpanded(next) {
      const want = next === true;
      if (railExpanded === want) return;
      railExpanded = want;
      saveRailExpanded();
      const root = document.querySelector("[" + ATTR_ROOT + "]");
      if (root !== null) applyRailState(root);
      railSig = "";
      renderRail();
    }

    /**
     * 按需装配三个可选模块。
     *
     * 每个模块单独 try/catch：任一模块加载失败（404、语法错、install 抛错）
     * 都只是把 modules[key] 留空，其余模块与内核照常工作。
     * 模块自己通过 require.async 相对路径加载——DSH 的 client-modules
     * 会把 ./client.X.js 解析成同目录下的独立 chunk。
     */
    async function loadModules() {
      const specs = [
        { key: "drag", file: "./client.drag.js" },
        { key: "float", file: "./client.float.js" },
        { key: "settings", file: "./client.settings.js" },
        { key: "window", file: "./client.window.js" },
      ];
      for (const spec of specs) {
        try {
          if (typeof require.async !== "function") {
            throw new Error("require.async 不可用，本宿主不支持可选模块");
          }
          const mod = await require.async(spec.file);
          if (mod === null || typeof mod !== "object") throw new Error("模块没有导出对象");
          if (typeof mod.install !== "function") throw new Error("模块缺少 install()");
          mod.install(moduleApi);
          modules[spec.key] = mod;
        } catch (err) {
          modules[spec.key] = null;
          faultModule(spec.key, err);
        }
      }
      // 模块装好后重放一次：让悬浮按钮出现在轨道上、把记忆里的顺序/落位落下来
      railSig = "";
      renderRail();
      schedule();
    }

    /**
     * 把当前诊断回传给宿主（index.mjs 的 /dsh-sidebar-rail/report 路由），
     * 宿主写到本插件目录的 last-report.json —— 排查时不需要用户手动开控制台。
     * 节流：最多每 1500ms 发一次；内容没变不重发。
     * 关键：只有「服务端确认收到」才记住这份内容，否则定时重试——
     * 避免路由还没就绪时一次 404 就把这个状态永久锁死。
     */
    const REPORT_URL = "/dsh-sidebar-rail/report";
    let reportTimer = null;
    let reportPending = false;
    let reportSentKey = "";
    let reportFirst = true;
    let reportRetry = 0;
    let reportMisses = 0;
    let reportUnavailable = false;

    function reportKeyOf() {
      return JSON.stringify({
        t: diag.tagged,
        d: diag.disabled,
        a: diag.anchors,
        c: diag.custom,
        h: diag.hasInput,
        z: diag.expanded,
        s: diag.settingsSection,
        e: diag.entries,
        x: diag.errors.slice(-3),
        v: diag.viewport ? diag.viewport.w + "x" + diag.viewport.h : "",
        g: diag.geometry || null,
        n: diag.nodes || null,
        k: diag.compat || null,
      });
    }

    function retryReportLater() {
      if (reportRetry >= 8) return;
      reportRetry += 1;
      window.setTimeout(function () {
        sendReport();
      }, 4000);
    }

    function sendReport() {
      reportPending = false;
      if (reportUnavailable) return;
      let body = "";
      let key = "";
      try {
        key = reportKeyOf();
        if (key === reportSentKey) return;
        body = JSON.stringify({
          version: diag.version,
          href: String(window.location && window.location.href),
          tagged: diag.tagged,
          disabled: diag.disabled,
          anchors: diag.anchors,
          custom: diag.custom,
          entries: diag.entries,
          hasInput: diag.hasInput,
          expanded: diag.expanded,
          settingsSection: diag.settingsSection,
          errors: diag.errors.slice(-10),
          viewport: diag.viewport || null,
          geometry: diag.geometry || null,
          nodes: diag.nodes || null,
          compat: diag.compat || null,
          styleInjected: document.querySelector('style[data-plugin="' + PLUGIN_ID + '"]') !== null,
        });
      } catch (err) {
        return;
      }
      try {
        if (typeof fetch !== "function") return;
        fetch(REPORT_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body,
          keepalive: true,
        })
          .then(function (res) {
            if (res && res.ok) {
              reportSentKey = key;
              reportRetry = 0;
              reportMisses = 0;
            } else if (res && res.status === 404) {
              // 404 = 宿主没注册回传路由（正常安装形态：index.mjs 默认什么都不做）。
              // 给 2 次机会容忍「路由比页面晚一步就绪」的热重载时序，之后本次页面生命周期内不再回传，
              // 避免在控制台刷一串 404。
              reportMisses += 1;
              if (reportMisses >= 2) {
                reportUnavailable = true;
                reportRetry = 8;
              } else {
                retryReportLater();
              }
            } else {
              retryReportLater();
            }
          })
          .catch(function () {
            retryReportLater();
          });
      } catch (err) {
        retryReportLater();
      }
    }

    function scheduleReport() {
      if (reportPending) return;
      reportPending = true;
      if (reportFirst) {
        reportFirst = false;
        sendReport();
        return;
      }
      reportTimer = window.setTimeout(function () {
        reportTimer = null;
        sendReport();
      }, 1500);
    }

    // ---------------------------------------------------------------- services
    let layoutSvc = null;
    let uiWorkspaceSvc = null;
    /** 会话输入区 InputActions，由 conversation.input.left 槽捕获 */
    let inputActionsRef = null;

    /**
     * 只有设置页那一节需要返回 React 元素（DSH 的槽组件必须是 React 组件），
     * 其余部分仍是纯原生 DOM。取不到 react 就降级为不注册该节，绝不抛错。
     */
    let reactRef;
    function getReact() {
      if (reactRef !== undefined) return reactRef;
      try {
        reactRef = require("react") || null;
      } catch (err) {
        reactRef = null;
        diag.errors.push("react: " + String(err));
      }
      return reactRef;
    }

    // ------------------------------------------------------------------- store
    let entries = [];

    function sanitizeEntry(raw) {
      if (raw === null || typeof raw !== "object") return null;
      const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : "e-" + Math.random().toString(36).slice(2, 9);
      const icon = typeof raw.icon === "string" && raw.icon.length > 0 ? Array.from(raw.icon).slice(0, 2).join("") : "•";
      const rawLabel = typeof raw.label === "string" ? raw.label.trim().slice(0, 40) : "";
      const a = raw.action !== null && typeof raw.action === "object" ? raw.action : {};
      const type = ["prompt", "session", "panel", "url"].includes(a.type) ? a.type : "prompt";
      const action = { type: type };
      if (type === "prompt" || type === "session") action.text = typeof a.text === "string" ? a.text : "";
      if (type === "panel") action.id = typeof a.id === "string" ? a.id : "";
      if (type === "url") action.url = typeof a.url === "string" ? a.url : "";
      return { id: id, icon: icon, label: rawLabel || icon, action: action };
    }

    function clone(list) {
      return list.map(function (e) {
        return JSON.parse(JSON.stringify(e));
      });
    }

    function loadEntries() {
      try {
        const raw = window.localStorage.getItem(STORAGE_CUSTOM);
        if (raw === null) {
          entries = DEFAULT_ENTRIES.map(sanitizeEntry).filter(Boolean);
        } else {
          const parsed = JSON.parse(raw);
          const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
          entries = list.map(sanitizeEntry).filter(Boolean);
        }
      } catch (err) {
        diag.errors.push("load: " + String(err));
        entries = DEFAULT_ENTRIES.map(sanitizeEntry).filter(Boolean);
      }
      diag.entries = entries.length;
    }

    function saveEntries(next) {
      entries = next.map(sanitizeEntry).filter(Boolean);
      diag.entries = entries.length;
      try {
        window.localStorage.setItem(STORAGE_CUSTOM, JSON.stringify(entries));
      } catch (err) {
        diag.errors.push("save: " + String(err));
      }
      renderRail();
    }

    function isDisabledBySwitch() {
      try {
        return window.localStorage.getItem(STORAGE_OFF) === "1";
      } catch (err) {
        return false;
      }
    }

    // ------------------------------------------------------- rail expand state
    /** 功能区是否展开（显示面板名称）。持久化到本机；写盘失败则本次内存态生效。 */
    let railExpanded = false;

    function loadRailExpanded() {
      try {
        railExpanded = window.localStorage.getItem(STORAGE_EXPANDED) === "1";
      } catch (err) {
        railExpanded = false;
      }
    }

    function saveRailExpanded() {
      try {
        window.localStorage.setItem(STORAGE_EXPANDED, railExpanded ? "1" : "0");
      } catch (err) {
        diag.errors.push("expand-save: " + String(err));
      }
    }

    /** 把展开态落到 root 上：属性驱动 CSS，变量驱动宽度；随后重量几何让会话区跟着让位 */
    function applyRailState(root) {
      if (root === null || root === undefined) return;
      let width = RAIL_W;
      if (railExpanded) {
        // 侧边栏本身只有 264–420px，展开时给会话区留至少 150px，避免会话列表被挤成一条
        const rootW = Math.round(root.getBoundingClientRect().width) || 0;
        const budget = rootW > 0 ? rootW - 150 : RAIL_W_EXPANDED;
        width = Math.max(RAIL_W + 40, Math.min(RAIL_W_EXPANDED, budget));
        if (!Number.isFinite(width) || width < RAIL_W) width = RAIL_W;
      }
      const wantAttr = railExpanded ? "1" : "0";
      // 这两个写操作都会让 [data-dsh-rail-expanded] 下的整棵子树重算样式。
      // sync() 每帧都可能被 DSH 的 DOM 变动唤起，值没变就不要重写。
      if (root.getAttribute("data-dsh-rail-expanded") !== wantAttr) {
        root.setAttribute("data-dsh-rail-expanded", wantAttr);
      }
      setVar(root, "--dsr-rail-w", width + "px");
      const widthChanged = width !== railWidthPx;
      railWidthPx = width;
      diag.expanded = railExpanded;
      diag.railWidth = width;
      if (widthChanged) measureCustom();
      // 悬浮态下变量是固定的参照系，宽度/位置要跟着一起刷新。
      // refresh 在停靠态是空操作，模块缺席也安全。
      if (floatState()) callModule("float", "refresh", [root], null);
    }

    function toggleRail() {
      railExpanded = !railExpanded;
      saveRailExpanded();
      const root = document.querySelector("[" + ATTR_ROOT + "]");
      applyRailState(root);
      railSig = "";
      renderRail();
      scheduleReport();
    }

    // ------------------------------------------------------------------ actions
    function clip(text) {
      const s = String(text || "")
        .replace(/\s+/g, " ")
        .trim();
      return s.length > 26 ? s.slice(0, 26) + "…" : s || "（空）";
    }

    function actionSummary(action) {
      const a = action || {};
      if (a.type === "panel") return "打开面板 · " + (a.id || "—");
      if (a.type === "url") return "打开链接 · " + clip(a.url);
      if (a.type === "session") return "开新会话 · " + clip(a.text);
      return "填入提示词 · " + clip(a.text);
    }

    function runEntry(entry) {
      const a = (entry && entry.action) || {};
      try {
        if (a.type === "panel") {
          if (layoutSvc && typeof layoutSvc.selectPanel === "function") layoutSvc.selectPanel(a.id || null);
          return;
        }
        if (a.type === "url") {
          if (!a.url) return;
          window.open(a.url, "_blank", "noopener,noreferrer");
          return;
        }
        if (a.type === "prompt") {
          const ia = inputActionsRef;
          if (ia !== null && typeof ia.setDraft === "function") {
            ia.setDraft(a.text || "");
            if (typeof ia.persistDraft === "function") ia.persistDraft();
            return;
          }
          if (uiWorkspaceSvc && typeof uiWorkspaceSvc.startSession === "function") {
            uiWorkspaceSvc.startSession(undefined, { prompt: a.text || "" });
          }
          return;
        }
        if (a.type === "session") {
          if (uiWorkspaceSvc && typeof uiWorkspaceSvc.startSession === "function") {
            uiWorkspaceSvc.startSession(undefined, { prompt: a.text || "" });
          }
        }
      } catch (err) {
        diag.errors.push("run: " + String(err));
      }
    }

    // -------------------------------------------------------------------- css
    const CSS = [
      '[data-dsh-rail-root]{position:relative!important}',

      /* DSH 左栏的「从左侧栏取消固定」只会隐藏一行，不应移除 More 菜单。
         第一项锁当前编译 CSS-module 类；后缀项承接 DSH 升级后的 hash 变化。
         选择器必须比下面 nav button 的 display:flex 规则更具体，才能真正隐藏该按钮。 */
      '[data-dsh-rail-root] > [data-dsh-rail-part="nav"] button.hHd-Xa_panelUnpin,',
      '[data-dsh-rail-root] > [data-dsh-rail-part="nav"] button[class*="_panelUnpin"]{display:none!important}',

      /* 顶部与底部保持整行宽度（不在它们旁边留空槽） */
      '[data-dsh-rail-root] > [data-dsh-rail-part="logo"],',
      '[data-dsh-rail-root] > [data-dsh-rail-part="new"],',
      '[data-dsh-rail-root] > [data-dsh-rail-part="foot"]{margin-left:0!important}',

      /* 功能区：竖直图标轨道，纵向与会话区严格同高并列 */
      '[data-dsh-rail-root] > [data-dsh-rail-part="nav"]{',
      "position:absolute!important;left:0;",
      "top:var(--dsr-rail-top,0px);bottom:var(--dsr-rail-bottom,0px);",
      "width:var(--dsr-rail-w,40px);",
      "display:flex!important;flex-direction:column;align-items:center;",
      "gap:2px;margin:0!important;",
      "padding:0 0 calc(4px + var(--dsr-custom-h,0px))!important;",
      "box-sizing:border-box!important;",
      "overflow-y:auto;overflow-x:hidden;",
      "border-right:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));",
      "background:var(--dsw-specific-sidebar-fill,#fff);",
      "z-index:2;",
      "}",
      '[data-dsh-rail-root] > [data-dsh-rail-part="nav"] button{',
      "width:36px!important;min-width:36px!important;max-width:36px!important;",
      "height:36px!important;min-height:36px!important;max-height:36px!important;",
      "margin:0!important;padding:0!important;flex:none!important;",
      "box-sizing:border-box!important;border:0!important;",
      "display:flex!important;align-items:center!important;justify-content:center!important;",
      "border-radius:var(--dsw-radius-sm,8px);",
      "}",
      '[data-dsh-rail-root] > [data-dsh-rail-part="nav"] button svg{width:18px;height:18px}',
      '[data-dsh-rail-root] > [data-dsh-rail-part="nav"] button[aria-current="page"]{',
      "box-shadow:inset 2px 0 0 0 var(--dsw-alias-state-business-primary);",
      "}",
      "[data-dsh-rail-hide]{display:none!important}",

      /* 展开态：轨道加宽，面板名称与自定义条目名称显示出来 */
      '[data-dsh-rail-root][data-dsh-rail-expanded="1"] > [data-dsh-rail-part="nav"]{align-items:stretch}',
      '[data-dsh-rail-root][data-dsh-rail-expanded="1"] > [data-dsh-rail-part="nav"] button{',
      "width:100%!important;max-width:none!important;justify-content:flex-start!important;",
      "gap:8px!important;padding:0 10px!important;",
      "}",
      '[data-dsh-rail-root][data-dsh-rail-expanded="1"] [data-dsh-rail-hide]{',
      "display:inline!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
      "}",
      '[data-dsh-rail-root][data-dsh-rail-expanded="1"] [data-dsh-rail-part="custom"]{align-items:stretch}',
      ".dsr-btn-label{display:none;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      '[data-dsh-rail-root][data-dsh-rail-expanded="1"] .dsr-btn{',
      "width:100%;justify-content:flex-start;gap:8px;padding:0 10px;",
      "}",
      '[data-dsh-rail-root][data-dsh-rail-expanded="1"] .dsr-btn .dsr-btn-label{display:inline}',

      /* 会话区接住剩余宽度。
         左边距直接由「轨道宽度 − root 自身左内边距」算出来，不再依赖脚本写进来的快照值：
         --dsr-rail-w 是唯一权威来源，它一变左边距立刻跟着变，
         不会出现「轨道已收回 40px、会话区还按 130px 让位」这种过期状态。 */
      '[data-dsh-rail-root] > [data-dsh-rail-part="region"]{',
      "margin-left:calc(var(--dsr-rail-w,40px) + 1px - var(--dsr-pad-left,8px))!important;",
      "padding-left:0!important;",
      "}",

      /* 没有面板图标时退回原生内缩 */
      '[data-dsh-rail-root][data-dsh-rail-nav="0"] > [data-dsh-rail-part="region"],',
      '[data-dsh-rail-root][data-dsh-rail-nav="0"] > [data-dsh-rail-part="logo"],',
      '[data-dsh-rail-root][data-dsh-rail-nav="0"] > [data-dsh-rail-part="new"],',
      '[data-dsh-rail-root][data-dsh-rail-nav="0"] > [data-dsh-rail-part="foot"]{margin-left:0!important}',

      /* 自定义条目挂载点：贴在轨道底部，与会话区底边对齐 */
      '[data-dsh-rail-root] > [data-dsh-rail-part="custom"]{',
      "position:absolute;left:0;bottom:var(--dsr-rail-bottom,0px);width:var(--dsr-rail-w,40px);max-height:60%;z-index:3;",
      "display:flex;flex-direction:column;align-items:center;gap:2px;",
      "padding:4px 0 6px;overflow-y:auto;overflow-x:hidden;",
      "border-right:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));",
      "background:var(--dsw-specific-sidebar-fill,#fff);",
      "}",

      /* 轨道按钮 */
      ".dsr-btn{",
      "width:36px;height:36px;flex:none;display:flex;align-items:center;justify-content:center;",
      "border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;cursor:pointer;",
      "color:var(--dsw-alias-label-secondary);font-size:15px;line-height:1;padding:0;font-family:inherit;",
      "}",
      ".dsr-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".dsr-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color);outline-offset:1px}",
      ".dsr-btn-ico{display:block;line-height:1;flex:none}",
      /* 展开/收起按钮：贴在轨道最底部，与上面的条目之间留一条细线 */
      ".dsr-toggle{margin-top:4px;border-radius:0;width:36px;height:30px;",
      "border-top:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));font-size:13px}",
      '[data-dsh-rail-root][data-dsh-rail-expanded="1"] .dsr-toggle{width:100%;padding:0 10px}',

      /* ---------------------------------------------------------------- 悬浮态
       * 整条轨道脱离侧边栏，固定在视口任意位置。
       * 注意选择器比基础 nav 规则多一个 [data-dsh-rail-float]，特异性更高，
       * 否则打不过前面那条带 !important 的绝对定位规则。
       *
       * 悬浮时这条轨道被拆成「抓取条 / 面板图标 / 自定义条目」三个兄弟节点各自定位。
       * 它们要看起来像**一张**卡片，所以：外框线由三段各画左右两边拼成连续的一条，
       * 而投影只留在最下面那一段——中间那段如果自己带向下投影，
       * 正好会压在下一段的顶边上，变成一条横线，两块卡片就「接不上」了。
       */
      '[data-dsh-rail-root][data-dsh-rail-float="1"] > [data-dsh-rail-part="nav"]{',
      "position:fixed!important;left:var(--dsr-float-x,0px);",
      "top:calc(var(--dsr-float-y,0px) + 22px);bottom:auto!important;",
      "width:var(--dsr-float-w,40px)!important;height:auto!important;",
      "box-sizing:border-box!important;",
      "max-height:calc(100vh - var(--dsr-float-y,0px) - 22px - 96px);",
      "padding:4px 0!important;border:0!important;",
      "border-left:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))!important;",
      "border-right:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))!important;",
      "border-radius:0!important;box-shadow:none!important;",
      "z-index:2147482000;overflow-y:auto;will-change:transform;",
      "}",
      /* 自定义条目叠在面板图标下面；它自己的高度写完 --dsr-float-nav-h 后自动贴合 */
      '[data-dsh-rail-root][data-dsh-rail-float="1"] > [data-dsh-rail-part="custom"]{',
      "position:fixed!important;left:var(--dsr-float-x,0px);",
      "top:calc(var(--dsr-float-y,0px) + 22px + var(--dsr-float-nav-h,0px) - 1px);",
      "bottom:auto!important;width:var(--dsr-float-w,40px)!important;max-height:none;",
      // 与 nav / grip 同为 border-box，否则左右各多 .5px，三段的框线会错半像素对不齐
      "box-sizing:border-box!important;",
      "border:0!important;",
      "border-left:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))!important;",
      "border-right:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))!important;",
      "border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))!important;",
      "border-radius:0 0 var(--dsr-radius,12px) var(--dsr-radius,12px)!important;",
      "box-shadow:0 8px 20px rgba(0,0,0,.12)!important;",
      "z-index:2147482000;will-change:transform;",
      "}",
      /* 顶部抓取条：悬浮态才存在，是唯一能拖动整条轨道的把手 */
      "[data-dsh-rail-grip]{",
      "position:fixed;left:var(--dsr-float-x,0px);top:var(--dsr-float-y,0px);",
      "width:var(--dsr-float-w,40px);height:22px;box-sizing:border-box;",
      "display:flex;align-items:center;justify-content:center;",
      "cursor:grab;touch-action:none;-webkit-user-drag:none;",
      "user-select:none;font-size:11px;line-height:1;",
      "color:var(--dsw-alias-label-secondary);",
      "background:var(--dsw-specific-sidebar-fill,#fff);",
      "border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));border-bottom:0;",
      "border-radius:var(--dsr-radius,12px) var(--dsr-radius,12px) 0 0;",
      "box-shadow:none;",
      "z-index:2147482001;will-change:transform;",
      "}",
      "[data-dsh-rail-grip]:hover{color:var(--dsw-alias-label-primary)}",
      ".dsr-grip-dots{opacity:.55;letter-spacing:1px}",
      "body.dsr-float-dragging,[data-dsh-rail-grip]:active{cursor:grabbing}",
      "body.dsr-float-dragging{user-select:none}",
      /* 悬浮后轨道已脱离文档流，会话区不再需要为它让出左侧空间 */
      '[data-dsh-rail-root][data-dsh-rail-float="1"] > [data-dsh-rail-part="region"]{margin-left:0!important}',
      '[data-dsh-rail-root][data-dsh-rail-float="1"] > [data-dsh-rail-part="logo"],',
      '[data-dsh-rail-root][data-dsh-rail-float="1"] > [data-dsh-rail-part="new"],',
      '[data-dsh-rail-root][data-dsh-rail-float="1"] > [data-dsh-rail-part="foot"]{margin-left:0!important}',

      /* 拖拽排序：只动合成层，避免触发布局重排 */
      '[data-dsh-rail-part="nav"],[data-dsh-rail-part="custom"]{touch-action:pan-y}',
      /* 按钮自己接管指针：否则触控竖拖会被浏览器当成滚动，拖拽永远起不来 */
      '[data-dsh-rail-part="nav"] button,[data-dsh-rail-part="custom"] .dsr-btn{touch-action:none;cursor:grab;',
      "will-change:transform;-webkit-user-drag:none;user-select:none}",
      "body.dsr-dragging-active,[data-dsh-rail-part] button.dsr-dragging{cursor:grabbing;user-select:none}",
      /* 被拖起的原件留在原位当占位，半透明表示「它正在被移动」 */
      "[data-dsh-rail-part] button.dsr-dragging{opacity:.32}",
      ".dsr-ghost{opacity:.94;border-radius:var(--dsw-radius-sm,8px);",
      "background:var(--dsw-specific-sidebar-fill,#fff);box-shadow:0 4px 14px rgba(0,0,0,.16);",
      "display:flex;align-items:center;justify-content:center;font-size:15px;",
      "color:var(--dsw-alias-label-primary,#111);box-sizing:border-box;will-change:top;",
      "transform:translateZ(0)}",
      ".dsr-ghost .dsr-btn-label{display:none}",
      ".dsr-ghost.dsr-ghost-wide{justify-content:flex-start;padding:0 10px;gap:8px}",
      ".dsr-ghost.dsr-ghost-wide .dsr-btn-label{display:inline;font-size:12.5px;",
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "body.dsr-dragging-active{cursor:grabbing}",

      /* 设置页里的条目编辑器（跟随 DSH 主题色，不用写死的黑白） */
      ".dsr-settings-host{width:100%}",
      ".dsr-settings{display:flex;flex-direction:column;gap:8px;font-size:13px;line-height:1.5;",
      "color:var(--dsw-alias-label-primary);font-family:inherit}",
      ".dsr-settings .dsr-row{border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));background:transparent}",
      ".dsr-settings .dsr-ico{border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));background:transparent}",
      ".dsr-settings .dsr-name{color:var(--dsw-alias-label-primary)}",
      ".dsr-settings .dsr-desc{color:var(--dsw-alias-label-secondary)}",
      ".dsr-settings .dsr-mini{border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));background:transparent;",
      "color:var(--dsw-alias-label-primary)}",
      ".dsr-settings .dsr-mini:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3,rgba(0,0,0,.08));",
      "color:var(--dsw-alias-label-primary)}",
      ".dsr-settings .dsr-mini:disabled{opacity:.35;background:transparent}",
      ".dsr-settings .dsr-input,.dsr-settings .dsr-area,.dsr-settings .dsr-select{",
      "background:transparent;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))}",
      ".dsr-settings .dsr-label{color:var(--dsw-alias-label-secondary)}",
      ".dsr-settings .dsr-hint,.dsr-settings .dsr-empty,.dsr-settings .dsr-sub{",
      "color:var(--dsw-alias-label-secondary)}",
      ".dsr-settings .dsr-body{padding:0;overflow:visible}",
      ".dsr-settings .dsr-foot{border-top:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));padding-top:10px}",
      ".dsr-settings .dsr-primary{background:var(--dsw-alias-state-business-primary);",
      "border-color:var(--dsw-alias-state-business-primary)}",

      /* 设置页里的功能开关：一行一个，左边名称+说明，右边拨动开关 */
      ".dsr-settings .dsr-switches{display:flex;flex-direction:column;gap:2px;",
      "border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));border-radius:8px;",
      "padding:2px 10px;margin:2px 0 4px}",
      ".dsr-settings .dsr-switch{display:flex;align-items:center;gap:12px;padding:8px 0;",
      "cursor:pointer;user-select:none}",
      ".dsr-settings .dsr-switch + .dsr-switch{",
      "border-top:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))}",
      ".dsr-settings .dsr-switch-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
      ".dsr-settings .dsr-switch-label{color:var(--dsw-alias-label-primary);font-weight:500}",
      ".dsr-settings .dsr-switch-desc{color:var(--dsw-alias-label-secondary);font-size:11.5px}",
      /* 轨道与滑块都自己画，避免依赖 DSH 内部的 switch 实现 */
      ".dsr-settings .dsr-switch-track{flex:none;position:relative;width:34px;height:20px;",
      "border-radius:999px;background:var(--dsw-alias-fill-l3,rgba(0,0,0,.14));",
      "transition:background .16s ease}",
      ".dsr-settings .dsr-switch[data-on=\"1\"] .dsr-switch-track{",
      "background:var(--dsw-alias-state-business-primary,#1a4bd8)}",
      ".dsr-settings .dsr-switch-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;",
      "border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);",
      "transition:transform .16s ease}",
      ".dsr-settings .dsr-switch[data-on=\"1\"] .dsr-switch-knob{transform:translateX(14px)}",
      ".dsr-settings .dsr-switch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#1a4bd8);",
      "outline-offset:2px;border-radius:6px}",
      /* 功能被关掉时那一段说明降到次要色，一眼能看出「已停用」 */
      ".dsr-settings .dsr-switch[data-on=\"0\"] .dsr-switch-label{color:var(--dsw-alias-label-secondary)}",

      /* 编辑器 */
      ".dsr-mask{position:fixed;inset:0;z-index:2147483000;background:rgba(20,20,20,.28);",
      "display:flex;align-items:center;justify-content:center;padding:24px}",
      ".dsr-card{width:min(560px,100%);max-height:82vh;display:flex;flex-direction:column;",
      "background:#fff;color:#111;border:1px solid #e6e6e6;border-radius:10px;",
      'font-size:13px;line-height:1.5;overflow:hidden;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}',
      ".dsr-head{display:flex;align-items:baseline;gap:8px;padding:14px 16px;border-bottom:1px solid #eee}",
      ".dsr-title{font-size:14px;font-weight:600}",
      ".dsr-sub{color:#8a8a8a;font-size:12px}",
      ".dsr-body{padding:12px 16px;overflow-y:auto;flex:1;min-height:0}",
      ".dsr-row{display:flex;align-items:center;gap:8px;padding:8px;border:1px solid #eee;",
      "border-radius:8px;margin-bottom:8px;background:#fff}",
      ".dsr-ico{width:26px;height:26px;flex:none;display:flex;align-items:center;justify-content:center;",
      "border:1px solid #eee;border-radius:6px;font-size:14px;background:#fafafa}",
      ".dsr-meta{flex:1;min-width:0}",
      ".dsr-name{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dsr-desc{color:#8a8a8a;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dsr-mini{border:1px solid #e6e6e6;background:#fff;color:#333;border-radius:6px;",
      "padding:3px 7px;font-size:11.5px;cursor:pointer;font-family:inherit}",
      ".dsr-mini:hover{background:#f5f7ff;border-color:#c9d4ff;color:#1a4bd8}",
      ".dsr-mini:disabled{opacity:.35;cursor:default;background:#fff;border-color:#e6e6e6;color:#333}",
      ".dsr-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}",
      ".dsr-label{font-size:11.5px;color:#777}",
      ".dsr-input,.dsr-area,.dsr-select{border:1px solid #e0e0e0;border-radius:6px;padding:6px 8px;",
      "font-size:13px;font-family:inherit;color:#111;background:#fff;width:100%;box-sizing:border-box}",
      ".dsr-input:focus,.dsr-area:focus,.dsr-select:focus{outline:none;border-color:#1a4bd8}",
      ".dsr-area{min-height:72px;resize:vertical;line-height:1.5}",
      ".dsr-foot{display:flex;align-items:center;gap:8px;padding:12px 16px;border-top:1px solid #eee;flex-wrap:wrap}",
      ".dsr-spacer{flex:1}",
      ".dsr-primary{border:1px solid #1a4bd8;background:#1a4bd8;color:#fff;border-radius:6px;",
      "padding:5px 14px;font-size:12.5px;cursor:pointer;font-family:inherit}",
      ".dsr-primary:hover{background:#1a3fb0;border-color:#1a3fb0}",
      ".dsr-hint{color:#9a9a9a;font-size:11px;width:100%}",
      ".dsr-empty{color:#8a8a8a;font-size:12px;padding:6px 0}",
    ].join("\n");

    let stylesDispose = null;

    function installStyles() {
      const existing = document.querySelector('style[data-plugin="' + PLUGIN_ID + '"]');
      if (existing !== null) return function () {};
      const style = document.createElement("style");
      style.dataset.plugin = PLUGIN_ID;
      style.textContent = CSS;
      document.head.append(style);
      return function () {
        style.remove();
      };
    }

    // ------------------------------------------------------- small DOM helpers
    function el(tag, props, children) {
      const node = document.createElement(tag);
      if (props) {
        for (const key of Object.keys(props)) {
          const value = props[key];
          if (value === null || value === undefined) continue;
          if (key === "className") node.className = value;
          else if (key === "text") node.textContent = value;
          else if (key === "value") node.value = value;
          else if (key === "onClick") node.addEventListener("click", value);
          else if (key === "onInput") node.addEventListener("input", value);
          else if (key === "onChange") node.addEventListener("change", value);
          else if (key === "disabled") node.disabled = Boolean(value);
          else if (key === "placeholder") node.placeholder = value;
          else node.setAttribute(key, String(value));
        }
      }
      const list = children === undefined ? [] : Array.isArray(children) ? children : [children];
      for (const child of list) {
        if (child === null || child === undefined || child === false) continue;
        node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
      }
      return node;
    }

    function clear(node) {
      while (node.firstChild !== null) node.removeChild(node.firstChild);
    }

    // ---------------------------------------------------------- rail (自定义条目)
    let mountEl = null;
    let railSig = "";

    function renderRail() {
      if (mountEl === null) return;
      const isFloat = floatState();
      const sig = JSON.stringify([entries, railExpanded, isFloat]);

      if (sig === railSig) return;
      railSig = sig;
      clear(mountEl);
      for (const entry of entries) {
        mountEl.appendChild(
          el(
            "button",
            {
              type: "button",
              className: "dsr-btn",
              title: entry.label,
              "aria-label": entry.label,
              "data-dsr-entry-id": entry.id,
              onClick: function () {
                runEntry(entry);
              },
            },
            [
              el("span", { className: "dsr-btn-ico", text: entry.icon }, null),
              el("span", { className: "dsr-btn-label", text: entry.label }, null),
            ]
          )
        );
      }
      // 展开/收起：固定在最底部（设置入口已移到 DSH 设置页，这里不再有齿轮）
      const toggleEl = mountEl.appendChild(
        el(
          "button",
          {
            type: "button",
            className: "dsr-btn dsr-toggle",
            title: railExpanded ? "收起功能区" : "展开功能区",
            "aria-label": railExpanded ? "收起功能区" : "展开功能区",
            "aria-expanded": railExpanded ? "true" : "false",
            onClick: toggleRail,
          },
          [
            el("span", { className: "dsr-btn-ico", text: railExpanded ? "«" : "»" }, null),
            el("span", { className: "dsr-btn-label", text: "收起" }, null),
          ]
        )
      );
      // 悬浮开关：把整条轨道拎出侧边栏，放到视口任意位置（双击抓手可停靠回来）
      // 悬浮模块缺席时整颗按钮不渲染——模块坏掉不该留下一个点了没反应的按钮。
      let floatEl = null;
      if (modules.float !== null) {
        floatEl = mountEl.appendChild(
          el(
            "button",
            {
              type: "button",
              className: "dsr-btn dsr-float-toggle",
              title: isFloat ? "停靠回侧边栏" : "悬浮并拖到任意位置",
              "aria-label": isFloat ? "停靠回侧边栏" : "悬浮并拖到任意位置",
              "aria-pressed": isFloat ? "true" : "false",
              onClick: function () {
                callModule("float", "toggle", [], null);
                railSig = "";
                renderRail();
              },
            },
            [
              el("span", { className: "dsr-btn-ico", text: isFloat ? "◱" : "⧉" }, null),
              el("span", { className: "dsr-btn-label", text: isFloat ? "停靠" : "悬浮" }, null),
            ]
          )
        );
      }
      // 工具按钮不参与排序，但也必须有显式 order：
      // 条目写着 0/1/2…，而工具按钮若留空（默认 0）就会插到条目中间，
      // 拖拽时看着「顺序没变」。给它们一个远大于条目数的档位，永久钉在末尾。
      toggleEl.style.order = "9000";
      if (floatEl !== null) floatEl.style.order = "9001";
      measureCustom();
    }

    /** 把自定义条目的实际高度写回 --dsr-custom-h，并把会话区上下边界写回轨道变量 */
    function measureCustom() {
      if (mountEl === null) return;
      const root = mountEl.parentElement;
      if (root === null) return;
      const height = Math.ceil(mountEl.getBoundingClientRect().height);
      setVar(root, "--dsr-custom-h", (height + 4) + "px");
      measureRailBounds(root);
      // 悬浮态下自定义条目是独立固定层，高度变了要重新贴合
      if (floatState()) callModule("float", "refresh", [root], null);
    }

    /**
     * 让轨道纵向严格贴合会话区：量出 region 的上下边界相对 root 的偏移。
     * 绝对定位的参照系是 root 的 padding box（不是 border box），所以要扣掉 root 自身的上下 padding。
     */
    function measureRailBounds(root) {
      const region = root.querySelector('[' + ATTR_PART + '="region"]');
      if (region === null) return;
      const rootRect = root.getBoundingClientRect();
      const regionRect = region.getBoundingClientRect();
      const cs = window.getComputedStyle(root);
      // 绝对定位的参照系是 root 的 padding box，它的原点 = 边框盒左上角 + 边框宽度
      // （padding 不参与偏移，之前误减 padding 导致轨道上下各偏 6px）。
      const borderTop = parseFloat(cs.borderTopWidth) || 0;
      const borderBottom = parseFloat(cs.borderBottomWidth) || 0;
      const top = Math.max(0, Math.round(regionRect.top - rootRect.top - borderTop));
      const bottom = Math.max(0, Math.round(rootRect.bottom - regionRect.bottom - borderBottom));
      setVar(root, "--dsr-rail-top", top + "px");
      setVar(root, "--dsr-rail-bottom", bottom + "px");

      // 会话区左边距：CSS 用 calc(轨道宽度 + 1px - root 左内边距) 现场算，
      // 这里只负责把「root 左内边距」喂给它。轨道宽度本身交给 --dsr-rail-w，
      // 于是左边距在任何时刻都跟着轨道宽度走，不存在需要「记得重新量一次」的窗口期
      // （停靠那一瞬 nav 的渲染宽度还是展开值，按实测值算就会把 130px 写进左边距）。
      const nav = root.querySelector('[' + ATTR_PART + '="nav"]');
      if (nav !== null) {
        const rootPadLeft = parseFloat(cs.paddingLeft) || 0;
        setVar(root, "--dsr-pad-left", rootPadLeft + "px");
        // 同时留一份快照值：探针与诊断读它，避免它们改读 CSS 计算值。
        const ml = Math.max(0, railWidthPx + 1 - rootPadLeft);
        setVar(root, "--dsr-region-ml", ml + "px");
      }
    }

    function ensureMount(root) {
      if (mountEl !== null && mountEl.parentElement === root) return;
      if (mountEl !== null) mountEl.remove();
      railSig = "";
      mountEl = el("div", { "data-dsh-rail-part": "custom", "data-dsh-rail-mount": "true" }, null);
      root.appendChild(mountEl);
      // 自定义条目容器也支持拖拽排序；拖拽模块缺席时这一行就是空操作
      callModule("drag", "attachContainer", [mountEl], null);
      renderRail();
      diag.custom = true;
    }




    // ---------------------------------------------------------- anchor engine
    let observer = null;
    let rafId = 0;
    let retryTimer = null;

    function directChildOf(root, node) {
      let n = node;
      while (n !== null && n.parentElement !== root) n = n.parentElement;
      return n !== null && n.parentElement === root ? n : null;
    }

    function clearTags() {
      document.querySelectorAll("[" + ATTR_ROOT + "]").forEach(function (node) {
        node.removeAttribute(ATTR_ROOT);
        node.removeAttribute(ATTR_NAV);
      });
      document.querySelectorAll("[" + ATTR_PART + "]").forEach(function (node) {
        node.removeAttribute(ATTR_PART);
      });
      document.querySelectorAll("[" + ATTR_HIDE + "]").forEach(function (node) {
        node.removeAttribute(ATTR_HIDE);
      });
      if (mountEl !== null) mountEl.remove();
      mountEl = null;
      railSig = "";
      // 拖拽模块的 nav 引用与进行中的拖拽状态（模块缺席时是空操作）
      callModule("drag", "clearNav", [], null);
      // 悬浮层的把手与拖拽残留一并撤掉（悬浮这个偏好本身保留，下次锚点回来还能复现）
      callModule("float", "detach", [], null);
      diag.tagged = false;
      diag.floating = false;
    }

    function tagLabels(nav) {
      nav.querySelectorAll("button").forEach(function (btn) {
        if (!btn.title && btn.getAttribute("aria-label")) btn.title = btn.getAttribute("aria-label");
        Array.from(btn.children).forEach(function (child) {
          if (child.hasAttribute("data-slot")) return;
          const name = child.tagName.toLowerCase();
          if (name === "svg") return;
          // 只要这层里装着面板图标（[data-slot="sidebar.panellist"] 就在里面），
          // 它就是图标包装层，绝不能隐藏 —— 否则用 emoji/字符作图标的第三方
          // 面板会在轨道里整个消失（DSH 自己的图标是 SVG，textContent 为空，
          // 所以以前没暴露；换成文本图标立刻踩到）。
          if (child.querySelector('[data-slot="sidebar.panellist"]') !== null) return;
          if ((child.textContent || "").trim().length > 0) child.setAttribute(ATTR_HIDE, "1");
        });
      });
    }

    function isCollapsed() {
      // 折叠态在 0.1.7 → 0.2.3 都靠 [data-sidebar-collapsed] 表达，稳定。
      // [data-sidebar-drawer] 在已核对过的所有版本里都不存在（drawer 用别的属性表达），
      // 保留这行只是给未来版本留个便宜的探测点：真出现了就自动跟着降级。
      if (document.querySelector("[data-sidebar-collapsed]") !== null) {
        if (diag.compat.sidebarCollapsed !== "collapsed") {
          diag.compat.sidebarCollapsed = "collapsed";
        }
        return true;
      }
      if (document.querySelector("[data-sidebar-drawer]") !== null) {
        if (diag.compat.sidebarCollapsed !== "drawer") {
          diag.compat.sidebarCollapsed = "drawer";
        }
        return true;
      }
      if (diag.compat.sidebarCollapsed !== "expanded") diag.compat.sidebarCollapsed = "expanded";
      return false;
    }

    function sync() {
      try {
        if (isDisabledBySwitch()) {
          diag.disabled = "switch";
          clearTags();
          return;
        }
        if (isCollapsed()) {
          diag.disabled = "collapsed";
          clearTags();
          return;
        }
        diag.disabled = null;

        const wsSlot = document.querySelector(SEL_WORKSPACES);
        if (wsSlot === null) {
          diag.anchors.region = false;
          clearTags();
          return;
        }
        const region = wsSlot.parentElement;
        if (region === null) {
          clearTags();
          return;
        }
        diag.anchors.region = true;

        const panelSlot = document.querySelector(SEL_PANELLIST);
        const nav = panelSlot === null ? null : panelSlot.closest("nav");
        const root = nav !== null && nav.parentElement !== null ? nav.parentElement : region.parentElement;
        if (root === null) {
          clearTags();
          return;
        }
        diag.anchors.root = true;
        diag.anchors.nav = nav !== null;

        root.setAttribute(ATTR_ROOT, "1");
        root.setAttribute(ATTR_NAV, nav !== null ? "1" : "0");

        if (nav !== null) {
          nav.setAttribute(ATTR_PART, "nav");
          tagLabels(nav);
          // 面板图标也支持拖拽排序：先绑定，再把记忆中的顺序落上去。
          // React 重渲染会重建这些按钮，setNav 是幂等的，每次 sync 重放一遍即可。
          // 拖拽模块缺席/已坏时这两步直接跳过，面板图标退回原生顺序。
          callModule("drag", "setNav", [nav], null);
        }
        region.setAttribute(ATTR_PART, "region");

        const brand = root.querySelector(SEL_BRAND);
        const logo = brand === null ? null : directChildOf(root, brand);
        if (logo !== null) logo.setAttribute(ATTR_PART, "logo");
        diag.anchors.logo = logo !== null;

        const settingsSlot = root.querySelector(SEL_SETTINGS);
        const foot = settingsSlot === null ? null : directChildOf(root, settingsSlot);
        if (foot !== null && foot !== nav && foot !== region) foot.setAttribute(ATTR_PART, "foot");
        diag.anchors.foot = foot !== null;

        const newButton = Array.from(root.children).find(function (child) {
          if (child.tagName !== "BUTTON" || child === nav) return false;
          const part = child.getAttribute(ATTR_PART);
          // 首次是 null；已打过标的重入时保留，避免刷新后 anchors.newButton 变 false
          return part === null || part === "new";
        });
        if (newButton !== undefined) newButton.setAttribute(ATTR_PART, "new");
        diag.anchors.newButton = newButton !== undefined;

        ensureMount(root);
        applyRailState(root);
        measureCustom();
        // 悬浮态要在几何量完之后落位：轨道高度由上面两步才确定
        if (floatState()) callModule("float", "apply", [root], null);
        diag.tagged = true;

        // 采集几何，供宿主侧 last-report.json 判断「是否真的并列」
        try {
          // 历史遗留：曾经猜过宿主用 [class*="sidebarCol"] 包一列，实际 0.1.7 → 0.2.3
          // 全版本都没有这个类名，永远落空。保留探测（真出现就用它，量得更准），
          // 但把结果记进 diag.compat.railColumn，别再让它当一个谁也看不见的死分支。
          const wsCol = root.closest('[class*="sidebarCol"]');
          const railCol = wsCol !== null ? wsCol : root.parentElement;
          diag.compat.railColumn = wsCol !== null ? "sidebarCol-class" : "parentElement";
          const colStyle = railCol === null ? null : window.getComputedStyle(railCol);
          const box = function (node) {
            if (node === null) return null;
            const r = node.getBoundingClientRect();
            return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
          };
          diag.viewport = { w: window.innerWidth, h: window.innerHeight };
          diag.geometry = {
            root: box(root),
            col: box(railCol),
            nav: box(nav),
            region: box(region),
            mount: box(mountEl),
            colGridArea: colStyle === null ? null : colStyle.gridArea,
            colWidth: colStyle === null ? null : colStyle.width,
          };
          diag.nodes = {
            rootChildren: Array.from(root.children).map(function (child) {
              return {
                tag: child.tagName.toLowerCase(),
                part: child.getAttribute(ATTR_PART),
                cls: String(child.className || "").slice(0, 80),
              };
            }),
            navButtons: nav === null ? [] : Array.from(nav.querySelectorAll("button")).map(function (btn) {
              return {
                label: btn.getAttribute("aria-label"),
                title: btn.title || null,
                current: btn.getAttribute("aria-current"),
                expanded: btn.getAttribute("aria-expanded"),
                hiddenKids: Array.from(btn.children).filter(function (c) {
                  return c.hasAttribute(ATTR_HIDE);
                }).length,
                box: box(btn),
              };
            }),
          };
        } catch (err) {
          diag.errors.push("geometry: " + String(err));
        }
      } catch (err) {
        diag.errors.push("sync: " + String(err));
      } finally {
        // finally 保证早退分支（折叠/关闭开关/找不到锚点）也会上报当前状态
        scheduleReport();
      }
    }

    function schedule() {
      if (rafId !== 0) return;
      // 拖动悬浮条期间冻结同步：DSH 流式输出会不停改 DOM 触发 observer，
      // 每次 sync 都要量几何（强制同步布局），和拖拽抢主线程就是卡顿与闪烁的来源。
      // 拖动只改 transform，本来也不需要重量几何；松手后补一次即可。
      if (callModule("float", "isDragging", [], false) === true) return;
      const raf = window.requestAnimationFrame || function (fn) {
        return window.setTimeout(fn, 16);
      };
      rafId = raf(function () {
        rafId = 0;
        sync();
      });
    }

    function isOurNode(node) {
      if (node === null) return false;
      if (mountEl !== null && (node === mountEl || mountEl.contains(node))) return true;
      // 内联编辑弹层由设置模块管理，它自己认
      if (callModule("settings", "ownsNode", [node], false) === true) return true;
      // 抓取条挂在 body 上，插入/移除会触发 observer；不认作自己的节点就会自激循环
      if (callModule("float", "ownsNode", [node], false) === true) return true;
      return false;
    }

    let resizeHandler = null;

    function startWatch() {
      observer = new MutationObserver(function (records) {
        for (const record of records) {
          if (isOurNode(record.target)) continue;
          schedule();
          return;
        }
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-sidebar-collapsed", "data-sidebar-drawer"],
      });

      // 窗口尺寸或侧边栏宽度变化后重新量取几何
      resizeHandler = function () {
        // 悬浮条先夹一次：窗口缩小后它可能已跑到视口外，抓不住就再也拖不回来
        callModule("float", "reclamp", [], null);
        schedule();
      };
      window.addEventListener("resize", resizeHandler);

      let tries = 0;
      const tick = function () {
        sync();
        tries += 1;
        if (tries < 8 && !diag.tagged) retryTimer = window.setTimeout(tick, 350);
      };
      retryTimer = window.setTimeout(tick, 0);
    }

    function teardown() {
      if (observer !== null) {
        observer.disconnect();
        observer = null;
      }
      if (rafId !== 0) {
        (window.cancelAnimationFrame || window.clearTimeout)(rafId);
        rafId = 0;
      }
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (resizeHandler !== null) {
        window.removeEventListener("resize", resizeHandler);
        resizeHandler = null;
      }
      callModule("drag", "cancel", [], null);
      callModule("settings", "closeEditor", [], null);
      clearTags();
      callModule("settings", "clearHost", [], null);
      if (stylesDispose !== null) {
        stylesDispose();
        stylesDispose = null;
      }
      diag.tagged = false;
      diag.loaded = false;
    }

    // --------------------------------------------------- input actions capture
    /** 注册到会话输入区，只为拿到 inputActions（setDraft） */
    function CaptureInputActions(props) {
      inputActionsRef = (props && props.inputActions) || null;
      diag.hasInput = inputActionsRef !== null;
      return null;
    }

    /**
     * 注册给 slots 的包装组件：真正的面板由可选模块提供。
     * 模块没装好 / 渲染抛错时返回 null——设置页里只是这一块空着，
     * 不会把整个设置页或侧边栏带崩。
     */
    function SettingsSectionSlot(props) {
      return callModule("settings", "SettingsSection", [props], null);
    }

    // ------------------------------------------------------------------- apply
    /**
     * 跨版本兼容探测。
     *
     * 这个插件刻意**不看版本号分支**：DSH 的 DOM 锚点、槽位契约、chunk 加载方式
     * 在 0.1.7 → 0.2.3 之间大部分是稳定的，真出问题的地方往往是「某个能力在某个
     * 版本上还没长出来」。所以这里只问三件事：宿主给了什么、我们退到了哪一步。
     *
     * 结果全部落到 diag.compat，用户贴一份 window.__DSH_RAIL__ 就能定位降级层。
     */
    function probeCompat(ctx) {
      const c = diag.compat;
      try {
        const boot = window.__DSH_BOOT__;
        if (boot !== null && typeof boot === "object") {
          const release = boot.release;
          if (release !== null && typeof release === "object" && typeof release.version === "string") {
            c.dshVersion = release.version;
          } else if (typeof boot.version === "string") {
            // 0.2.0 及更早没有 release 字段，退回看看有没有别处的版本串
            c.dshVersion = boot.version;
          }
        }
        if (c.dshVersion === null) c.notes.push("boot: no release.version (host <= 0.2.0)");
      } catch (err) {
        c.notes.push("boot: " + String(err));
      }
      c.slots = ctx.slots !== undefined && ctx.slots !== null;
      c.slotInject = c.slots && typeof ctx.slots.inject === "function";
      c.slotRegister = c.slots && typeof ctx.slots.register === "function";
      c.ctxGet = typeof ctx.get === "function";
      c.ctxEffect = typeof ctx.effect === "function";
      try {
        c.requireAsync = typeof require !== "undefined" && require !== null && typeof require.async === "function";
      } catch (err) {
        c.requireAsync = false;
      }
      if (!c.slotInject || !c.slotRegister) c.notes.push("slots: inject/register 缺失，设置页入口不可用");
      if (!c.requireAsync) c.notes.push("require.async 缺失，四个可选模块全部降级");
      // 设置弹窗能不能接管要等它真的被打开才探得到，结论记在
      // __DSH_RAIL__.window.reason（no-title / no-panel）与 window.compat 里。
      if (!c.ctxGet) c.notes.push("ctx.get 缺失，layout / uiWorkspace 动作降级为无效");
      return c;
    }

    function apply(ctx) {
      // 先探一次宿主能力面：后面每一步降级都能在 diag.compat 里对上号
      probeCompat(ctx);
      const getService = function (name) {
        if (typeof ctx.get === "function") {
          try {
            return ctx.get(name) || null;
          } catch (err) {
            return null;
          }
        }
        return null;
      };
      // 注意：本插件只声明 inject ['slots']，直接读 ctx.layout / ctx.uiWorkspace
      // 会在服务未就绪时抛 ServiceNotFound，导致 apply 中断、整个前端启动失败。
      // 因此一律走 getService（内部 try/catch），取不到就降级。
      layoutSvc = getService("layout");
      uiWorkspaceSvc = getService("uiWorkspace");

      loadEntries();
      loadRailExpanded();
      loadFeatures();
      stylesDispose = installStyles();

      // 可选模块装配放在最前：拖拽顺序、悬浮偏好、设置页草稿都要在首次 sync 之前就绪，
      // 否则刷新后会先按原生顺序/停靠态渲染一次再跳。loadModules 内部逐模块 try/catch，
      // 任一模块失败都只影响那一个功能，不影响下面的锚点监听与布局。
      const modulesReady = loadModules();

      if (ctx.slots !== undefined && typeof ctx.slots.inject === "function") {
        ctx.slots.inject(INPUT_SLOT, function () {
          return ctx.slots.register({ name: INPUT_SLOT, id: PLUGIN_ID, order: 900 }, CaptureInputActions);
        });

        // 设置页：条目编辑搬进 DSH 官方设置，侧边栏不再有齿轮入口。
        // 槽位永远注册（DSH 侧不区分模块在不在），真正渲染时才问模块；
        // 模块缺席时返回 null，设置页里就是一块空白，不影响其他设置项。
        try {
          ctx.slots.inject(SETTINGS_SECTION, function () {
            return ctx.slots.register(
              { name: SETTINGS_SECTION, id: SETTINGS_SECTION_ID, order: 820, label: function () { return "侧边栏条目"; } },
              SettingsSectionSlot
            );
          });
          ctx.slots.inject("settings.section.icon", function () {
            const R = getReact();
            if (R === null) return function () {};
            return ctx.slots.register(
              { name: "settings.section.icon", id: SETTINGS_SECTION_ID, order: 820 },
              function (props) {
                const RR = getReact();
                if (RR === null) return null;
                const size = (props && props.size) || 16;
                return RR.createElement(
                  "span",
                  { style: { fontSize: Math.round(size * 0.9) + "px", lineHeight: 1 }, "aria-hidden": "true" },
                  "☰"
                );
              }
            );
          });
          diag.settingsSection = true;
        } catch (err) {
          diag.settingsSection = false;
          diag.errors.push("settings-section: " + String(err));
        }
      }

      startWatch();

      // 模块是异步拉的，装配完成后自己会重放一次渲染与调度；
      // 这里 await 一下只为让诊断报告在第一帧就带上「哪些模块活着」。
      modulesReady.then(function () {
        // 诊断里显式列出每个模块的装配结果：排查「装了但没生效」时
        // 一眼就能看出是模块没装上、还是装上了不工作。
        if (diag !== null && typeof diag === "object") {
          diag.modulesLoaded = {
            drag: modules.drag !== null,
            float: modules.float !== null,
            settings: modules.settings !== null,
            window: modules.window !== null,
          };
        }
        schedule();
        scheduleReport();
      });

      if (typeof ctx.effect === "function") {
        ctx.effect(function () {
          return teardown;
        }, "dsh-sidebar-rail: sidebar rail layout");
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
