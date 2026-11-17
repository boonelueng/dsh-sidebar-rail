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

    /** 诊断对象，挂在 window.__DSH_RAIL__ 供控制台核对 */
    const diag = {
      loaded: true,
      version: "1.0.0",
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
      errors: [],
    };
    window.__DSH_RAIL__ = diag;

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
      // 悬浮态下变量是固定的参照系，宽度/位置要跟着一起刷新
      if (floating) applyFloat(root);
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
      "border-right:.5px solid var(--dsw-alias-border-l3);",
      "background:var(--dsw-specific-sidebar-fill);",
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

      /* 会话区接住剩余宽度；左边距由 measureRailBounds 逐次量算，保证紧贴轨道 */
      '[data-dsh-rail-root] > [data-dsh-rail-part="region"]{',
      "margin-left:var(--dsr-region-ml,42px)!important;padding-left:0!important;",
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
      "border-right:.5px solid var(--dsw-alias-border-l3);",
      "background:var(--dsw-specific-sidebar-fill);",
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
      "border-top:.5px solid var(--dsw-alias-border-l3);font-size:13px}",
      '[data-dsh-rail-root][data-dsh-rail-expanded="1"] .dsr-toggle{width:100%;padding:0 10px}',

      /* ---------------------------------------------------------------- 悬浮态
       * 整条轨道脱离侧边栏，固定在视口任意位置。
       * 注意选择器比基础 nav 规则多一个 [data-dsh-rail-float]，特异性更高，
       * 否则打不过前面那条带 !important 的绝对定位规则。
       */
      '[data-dsh-rail-root][data-dsh-rail-float="1"] > [data-dsh-rail-part="nav"]{',
      "position:fixed!important;left:var(--dsr-float-x,0px);",
      "top:calc(var(--dsr-float-y,0px) + 22px);bottom:auto!important;",
      "width:var(--dsr-float-w,40px)!important;height:auto!important;",
      "max-height:calc(100vh - var(--dsr-float-y,0px) - 22px - 96px);",
      "padding:4px 0!important;border:0!important;border-radius:0!important;",
      "box-shadow:0 6px 24px rgba(0,0,0,.14),0 1px 3px rgba(0,0,0,.08);",
      "z-index:2147482000;overflow-y:auto;will-change:transform;",
      "}",
      /* 自定义条目叠在面板图标下面；它自己的高度写完 --dsr-float-nav-h 后自动贴合 */
      '[data-dsh-rail-root][data-dsh-rail-float="1"] > [data-dsh-rail-part="custom"]{',
      "position:fixed!important;left:var(--dsr-float-x,0px);",
      "top:calc(var(--dsr-float-y,0px) + 22px + var(--dsr-float-nav-h,0px));",
      "bottom:auto!important;width:var(--dsr-float-w,40px)!important;max-height:none;",
      "border:0!important;border-radius:0 0 var(--dsr-radius,12px) var(--dsr-radius,12px);",
      "box-shadow:0 6px 24px rgba(0,0,0,.14);",
      "z-index:2147482000;will-change:transform;",
      "}",
      /* 顶部抓取条：悬浮态才存在，是唯一能拖动整条轨道的把手 */
      "[data-dsh-rail-grip]{",
      "position:fixed;left:var(--dsr-float-x,0px);top:var(--dsr-float-y,0px);",
      "width:var(--dsr-float-w,40px);height:22px;",
      "display:flex;align-items:center;justify-content:center;",
      "cursor:grab;touch-action:none;-webkit-user-drag:none;",
      "user-select:none;font-size:11px;line-height:1;",
      "color:var(--dsw-alias-label-secondary);",
      "background:var(--dsw-specific-sidebar-fill);",
      "border-radius:var(--dsr-radius,12px) var(--dsr-radius,12px) 0 0;",
      "box-shadow:0 -2px 10px rgba(0,0,0,.05);",
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
      ".dsr-settings .dsr-row{border:1px solid var(--dsw-alias-border-l3);background:transparent}",
      ".dsr-settings .dsr-ico{border:1px solid var(--dsw-alias-border-l3);background:transparent}",
      ".dsr-settings .dsr-name{color:var(--dsw-alias-label-primary)}",
      ".dsr-settings .dsr-desc{color:var(--dsw-alias-label-secondary)}",
      ".dsr-settings .dsr-mini{border:1px solid var(--dsw-alias-border-l3);background:transparent;",
      "color:var(--dsw-alias-label-primary)}",
      ".dsr-settings .dsr-mini:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3);",
      "color:var(--dsw-alias-label-primary)}",
      ".dsr-settings .dsr-mini:disabled{opacity:.35;background:transparent}",
      ".dsr-settings .dsr-input,.dsr-settings .dsr-area,.dsr-settings .dsr-select{",
      "background:transparent;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l3)}",
      ".dsr-settings .dsr-label{color:var(--dsw-alias-label-secondary)}",
      ".dsr-settings .dsr-hint,.dsr-settings .dsr-empty,.dsr-settings .dsr-sub{",
      "color:var(--dsw-alias-label-secondary)}",
      ".dsr-settings .dsr-body{padding:0;overflow:visible}",
      ".dsr-settings .dsr-foot{border-top:1px solid var(--dsw-alias-border-l3);padding-top:10px}",
      ".dsr-settings .dsr-primary{background:var(--dsw-alias-state-business-primary);",
      "border-color:var(--dsw-alias-state-business-primary)}",

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
      const sig = JSON.stringify([entries, railExpanded, floating]);
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
      const floatEl = mountEl.appendChild(
        el(
          "button",
          {
            type: "button",
            className: "dsr-btn dsr-float-toggle",
            title: floating ? "停靠回侧边栏" : "悬浮并拖到任意位置",
            "aria-label": floating ? "停靠回侧边栏" : "悬浮并拖到任意位置",
            "aria-pressed": floating ? "true" : "false",
            onClick: toggleFloat,
          },
          [
            el("span", { className: "dsr-btn-ico", text: floating ? "◱" : "⧉" }, null),
            el("span", { className: "dsr-btn-label", text: floating ? "停靠" : "悬浮" }, null),
          ]
        )
      );
      // 工具按钮不参与排序，但也必须有显式 order：
      // 条目写着 0/1/2…，而工具按钮若留空（默认 0）就会插到条目中间，
      // 拖拽时看着「顺序没变」。给它们一个远大于条目数的档位，永久钉在末尾。
      toggleEl.style.order = "9000";
      floatEl.style.order = "9001";
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
      if (floating) applyFloat(root);
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

      // 会话区左边距：让会话区紧贴轨道右边缘（轨道 40px 宽 + 边框，再留 1px 呼吸）
      const nav = root.querySelector('[' + ATTR_PART + '="nav"]');
      if (nav !== null) {
        const navW = Math.round(nav.getBoundingClientRect().width) || 40;
        const rootPadLeft = parseFloat(cs.paddingLeft) || 0;
        // region 的 margin-left 与 root 的 padding-left 共同决定它的左边界
        const ml = Math.max(0, navW + 1 - rootPadLeft);
        setVar(root, "--dsr-region-ml", ml + "px");
      }
    }

    function ensureMount(root) {
      if (mountEl !== null && mountEl.parentElement === root) return;
      if (mountEl !== null) mountEl.remove();
      railSig = "";
      mountEl = el("div", { "data-dsh-rail-part": "custom", "data-dsh-rail-mount": "true" }, null);
      root.appendChild(mountEl);
      attachDrag(mountEl);
      renderRail();
      diag.custom = true;
    }

    // ------------------------------------------------------------ drag reorder
    /**
     * 轨道图标拖拽排序。
     *
     * 分两个容器各自维护顺序：面板图标在 <nav> 里、自定义条目在挂载点里。
     * 用 CSS `order` 改变排列（不动 DOM 结构），配合 Web Animations 做 FLIP，
     * 这样拖拽过程中每一帧都是合成层变换，不会触发重排，滚动和拖拽都能保持流畅。
     *
     * 顺序：
     *  - 面板图标按 aria-label 记住（DSH 没有暴露 panel id 到 DOM，「更多」按钮固定最后）
     *  - 自定义条目按 entries 数组顺序
     */
    let navEl = null;
    let navOrder = [];
    let pendingDrag = null;
    let activeDrag = null;

    const DRAG_THRESHOLD = 4;

    function navKeyOf(btn) {
      return String(btn.getAttribute("aria-label") || "").trim();
    }

    /** 「更多」是菜单按钮，永远排在最后，不参与排序 */
    function isMoreButton(btn) {
      if (btn.getAttribute("aria-haspopup") === "menu") return true;
      return btn.getAttribute("aria-expanded") !== null;
    }

    function loadNavOrder() {
      try {
        const raw = window.localStorage.getItem(STORAGE_NAV_ORDER);
        const parsed = raw === null ? [] : JSON.parse(raw);
        navOrder = Array.isArray(parsed) ? parsed.map(String) : [];
      } catch (err) {
        navOrder = [];
      }
    }

    function saveNavOrder() {
      try {
        window.localStorage.setItem(STORAGE_NAV_ORDER, JSON.stringify(navOrder));
      } catch (err) {
        diag.errors.push("nav-order-save: " + String(err));
      }
    }

    /** 把记忆里的顺序落到 nav 的按钮上；没记录过的排在已记录项之后 */
    function applyNavOrder(nav) {
      if (nav === null) return;
      // 拖拽期间不能重放：ghost 挂到 body 会触发 observer → sync，
      // 此时若把 order 覆盖回已保存的顺序，拖动中的预览会被瞬间打回。
      if (activeDrag !== null) return;
      const rank = new Map();
      for (let i = 0; i < navOrder.length; i += 1) rank.set(navOrder[i], i);
      const buttons = Array.from(nav.querySelectorAll(":scope > button"));
      let tail = navOrder.length;
      for (const btn of buttons) {
        if (isMoreButton(btn)) {
          btn.style.order = "9999";
          continue;
        }
        const key = navKeyOf(btn);
        if (key.length === 0) continue;
        const idx = rank.has(key) ? rank.get(key) : tail++;
        btn.style.order = String(idx);
      }
    }

    function railItemsOf(container) {
      if (container === navEl) {
        return Array.from(container.querySelectorAll(":scope > button")).filter(function (btn) {
          return !isMoreButton(btn);
        });
      }
      return Array.from(container.querySelectorAll(".dsr-btn")).filter(function (btn) {
        return !btn.classList.contains("dsr-toggle") && !btn.classList.contains("dsr-float-toggle");
      });
    }

    /**
     * 记录「排序前」的位置。
     *
     * 必须先 cancel 掉还在跑的 FLIP：上一帧的动画会把 rect 顶偏，
     * 拿被顶偏的值当基准算出来的 dx/dy 是错的，连续快拖时画面会跳。
     */
    function capturePositions(nodes) {
      for (const node of nodes) node.getAnimations().forEach(function (a) {
        a.cancel();
      });
      const map = new Map();
      for (const node of nodes) map.set(node, node.getBoundingClientRect());
      return map;
    }

    /** FLIP：把「排序前 → 排序后」的位移用动画补回去，形成连续的滑动感 */
    function playFlip(nodes, before, duration) {
      const ms = duration || 170;
      for (const node of nodes) {
        const b = before.get(node);
        if (b === undefined) continue;
        const a = node.getBoundingClientRect();
        const dx = b.left - a.left;
        const dy = b.top - a.top;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
        if (typeof node.animate !== "function") continue;
        if (typeof node.getAnimations === "function") {
          node.getAnimations().forEach(function (anim) {
            anim.cancel();
          });
        }
        node.animate(
          [{ transform: "translate(" + dx + "px," + dy + "px)" }, { transform: "translate(0px,0px)" }],
          { duration: ms, easing: "cubic-bezier(.2,0,0,1)" }
        );
      }
    }

    function computeDropIndex(items, dragged, pointerY) {
      let idx = 0;
      for (const item of items) {
        if (item === dragged) continue;
        const r = item.getBoundingClientRect();
        if (pointerY > r.top + r.height / 2) idx += 1;
      }
      return idx;
    }

    /** 拖动时实时重排：先算插入位，再改 order，最后用 FLIP 把位移补成动画 */
    function reorderDuringDrag(state, pointerY) {
      const items = railItemsOf(state.container);
      const current = items.map(function (n) {
        return n;
      });
      const rest = current.filter(function (n) {
        return n !== state.item;
      });
      const idx = computeDropIndex(rest, state.item, pointerY);
      const next = rest.slice(0, idx).concat([state.item], rest.slice(idx));
      const before = capturePositions(current);
      for (let i = 0; i < next.length; i += 1) next[i].style.order = String(i);
      // 被拖起的那一项不参与 FLIP：它由跟随指针的 ghost 代表，原件只需留在原位当占位
      const animating = current.filter(function (n) {
        return n !== state.item;
      });
      playFlip(animating, before, 170);
      state.previewKeys = next.map(function (n) {
        return state.kind === "nav" ? navKeyOf(n) : n.getAttribute("data-dsr-entry-id") || "";
      });
    }

    function startDrag(state, pointerY) {
      state.item.classList.add("dsr-dragging");
      const r = state.item.getBoundingClientRect();
      const ghost = state.item.cloneNode(true);
      // cloneNode 会把原件刚加上的 .dsr-dragging 一起复制过来，
      // 导致跟随指针的 ghost 被压到 0.32 透明（看着像消失了），这里必须摘掉。
      ghost.classList.remove("dsr-dragging");
      ghost.classList.add("dsr-ghost");
      if (railExpanded) ghost.classList.add("dsr-ghost-wide");
      ghost.removeAttribute("data-dsr-entry-id");
      ghost.style.cssText =
        "position:fixed;left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height +
        "px;pointer-events:none;z-index:2147483000;margin:0;";
      document.body.appendChild(ghost);
      state.ghost = ghost;
      state.grabOffset = pointerY - r.top;
      state.active = true;
      if (document.body) document.body.classList.add("dsr-dragging-active");
      reorderDuringDrag(state, pointerY);
    }

    function moveDrag(state, pointerY) {
      if (state.ghost !== null) {
        const h = state.ghost.getBoundingClientRect().height;
        state.ghost.style.top = pointerY - (state.grabOffset || h / 2) + "px";
      }
      reorderDuringDrag(state, pointerY);
    }

    /** 拖拽结束后：面板图标写 navOrder，自定义条目重排 entries 并保存 */
    function endDrag(state, commit) {
      if (state.ghost !== null) {
        state.ghost.remove();
        state.ghost = null;
      }
      state.item.classList.remove("dsr-dragging");
      if (document.body) document.body.classList.remove("dsr-dragging-active");

      if (commit !== false) {
        const keys = state.previewKeys || [];
        if (state.kind === "nav") {
          if (keys.length > 0) {
            navOrder = keys;
            saveNavOrder();
          }
          if (navEl !== null) applyNavOrder(navEl);
        } else {
          const byId = new Map();
          for (const e of entries) byId.set(e.id, e);
          const next = [];
          for (const id of keys) {
            const found = byId.get(id);
            if (found !== undefined) {
              next.push(found);
              byId.delete(id);
            }
          }
          for (const leftover of byId.values()) next.push(leftover);
          if (next.length === entries.length) saveEntries(next);
        }
      }
      // 清掉拖拽期间的临时 order 之外的痕迹，并重新校准顺序
      if (state.kind === "nav" && navEl !== null) applyNavOrder(navEl);
    }

    function suppressNextClick() {
      const stop = function (event) {
        event.stopPropagation();
        event.preventDefault();
        window.removeEventListener("click", stop, true);
      };
      window.addEventListener("click", stop, true);
      window.setTimeout(function () {
        window.removeEventListener("click", stop, true);
      }, 400);
    }

    function onDragPointerMove(event) {
      if (pendingDrag === null) return;
      if (activeDrag === null) {
        const dy = Math.abs(event.clientY - pendingDrag.y0);
        const dx = Math.abs(event.clientX - pendingDrag.x0);
        if (dy < DRAG_THRESHOLD && dx < DRAG_THRESHOLD) return;
        activeDrag = pendingDrag;
        startDrag(activeDrag, event.clientY);
      }
      if (activeDrag !== null) {
        event.preventDefault();
        moveDrag(activeDrag, event.clientY);
      }
    }

    function onDragPointerUp() {
      window.removeEventListener("pointermove", onDragPointerMove, true);
      window.removeEventListener("pointerup", onDragPointerUp, true);
      window.removeEventListener("pointercancel", onDragPointerUp, true);
      const state = activeDrag;
      pendingDrag = null;
      activeDrag = null;
      if (state !== null) {
        endDrag(state, true);
        suppressNextClick();
      }
    }

    /** 插件卸载/退回原生布局时把拖拽残留全部清掉 */
    function cancelDrag() {
      window.removeEventListener("pointermove", onDragPointerMove, true);
      window.removeEventListener("pointerup", onDragPointerUp, true);
      window.removeEventListener("pointercancel", onDragPointerUp, true);
      if (activeDrag !== null) {
        endDrag(activeDrag, false);
      }
      pendingDrag = null;
      activeDrag = null;
      if (document.body) document.body.classList.remove("dsr-dragging-active");
      document.querySelectorAll(".dsr-ghost").forEach(function (node) {
        node.remove();
      });
      navEl = null;
    }

    function onRailPointerDown(event) {
      if (event.button !== 0) return;
      const container = event.currentTarget;
      const item = event.target.closest("button");
      if (item === null || !container.contains(item)) return;
      if (item.classList.contains("dsr-toggle")) return;
      if (item.classList.contains("dsr-float-toggle")) return;
      if (container === navEl && isMoreButton(item)) return;
      pendingDrag = {
        container: container,
        kind: container === navEl ? "nav" : "entry",
        item: item,
        x0: event.clientX,
        y0: event.clientY,
        ghost: null,
        previewKeys: null,
        active: false,
      };
      window.addEventListener("pointermove", onDragPointerMove, true);
      window.addEventListener("pointerup", onDragPointerUp, true);
      window.addEventListener("pointercancel", onDragPointerUp, true);
    }

    function attachDrag(container) {
      if (container === null || container === undefined) return;
      if (container.dataset.dsrDragBound === "1") return;
      container.dataset.dsrDragBound = "1";
      container.addEventListener("pointerdown", onRailPointerDown);
    }

    // ---------------------------------------------------------------- editor
    let editorHost = null;
    let editDraft = [];
    let editIndex = null;
    let editShowImport = false;
    let editImportText = "";
    let editNote = "";

    function openEditor() {
      if (editorHost !== null) return;
      editDraft = clone(entries);
      editIndex = null;
      editShowImport = false;
      editImportText = "";
      editNote = "";
      editorHost = el("div", { className: "dsr-mask" }, null);
      editorHost.addEventListener("mousedown", function (event) {
        if (event.target === editorHost) closeEditor();
      });
      document.body.appendChild(editorHost);
      document.addEventListener("keydown", onEditorKeydown, true);
      renderEditor();
    }

    function closeEditor() {
      document.removeEventListener("keydown", onEditorKeydown, true);
      if (editorHost !== null) {
        editorHost.remove();
        editorHost = null;
      }
    }

    function onEditorKeydown(event) {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeEditor();
      }
    }

    function commitEditor() {
      saveEntries(clone(editDraft));
      if (editorHost !== null) {
        closeEditor();
        return;
      }
      resetDraft();
      editNote = "已保存";
      renderSettingsPanel();
    }

    function renderEditor() {
      if (editorHost === null) {
        // 设置页内联编辑器接管渲染（齿轮已移出侧边栏，modal 仅作兜底）
        renderSettingsPanel();
        return;
      }
      const card = el("div", { className: "dsr-card", role: "dialog", "aria-label": "自定义侧边栏条目" }, null);

      card.appendChild(
        el("div", { className: "dsr-head" }, [
          el("span", { className: "dsr-title", text: editIndex === null ? "侧边栏条目" : "编辑条目" }, null),
          el(
            "span",
            {
              className: "dsr-sub",
              text: editIndex === null ? editDraft.length + " 条 · 保存后写入本机" : "图标决定它在轨道上的样子",
            },
            null
          ),
        ])
      );

      const body = el("div", { className: "dsr-body" }, null);
      if (editIndex === null) body.appendChild(listView());
      else body.appendChild(formView());
      card.appendChild(body);
      card.appendChild(footView());

      clear(editorHost);
      editorHost.appendChild(card);
    }

    // ------------------------------------------------- settings section (inline)
    /** DSH 设置页里的宿主节点（由 SettingsSection 的 ref 回调挂上） */
    let settingsHost = null;

    function resetDraft() {
      editDraft = clone(entries);
      editIndex = null;
      editShowImport = false;
      editImportText = "";
      editNote = "";
    }

    function cancelEdit() {
      if (editorHost !== null) {
        closeEditor();
        return;
      }
      if (settingsHost !== null) {
        resetDraft();
        editNote = "已放弃修改";
        renderSettingsPanel();
      }
    }

    function renderSettingsPanel() {
      if (settingsHost === null) return;
      clear(settingsHost);
      const wrap = el("div", { className: "dsr-settings" }, null);
      wrap.appendChild(
        el("div", { className: "dsr-field" }, [
          el("div", { className: "dsr-name", text: editIndex === null ? "侧边栏条目" : "编辑条目" }, null),
          el(
            "div",
            {
              className: "dsr-desc",
              text:
                editIndex === null
                  ? editDraft.length + " 条 · 显示在左侧功能区底部，保存在本机"
                  : "图标决定它在功能区上的样子",
            },
            null
          ),
        ])
      );
      const body = el("div", { className: "dsr-body" }, null);
      body.appendChild(editIndex === null ? listView() : formView());
      wrap.appendChild(body);
      wrap.appendChild(footView());
      settingsHost.appendChild(wrap);
    }

    // 交给 DSH 设置页渲染的一节；内容用原生 DOM 挂到 ref 节点里，避免依赖 react-dom 版本差异
    function SettingsSection() {
      const R = getReact();
      if (R === null) return null;
      return R.createElement("div", {
        className: "dsr-settings-host",
        ref: function (node) {
          if (node === null || node === undefined) {
            settingsHost = null;
            return;
          }
          settingsHost = node;
          resetDraft();
          renderSettingsPanel();
        },
      });
    }

    function listView() {
      const frag = document.createDocumentFragment();
      if (editDraft.length === 0) {
        frag.appendChild(el("div", { className: "dsr-empty", text: "还没有条目。点下面「添加条目」开始。" }, null));
      }
      editDraft.forEach(function (entry, index) {
        const row = el("div", { className: "dsr-row" }, [
          el("span", { className: "dsr-ico", text: entry.icon }, null),
          el("span", { className: "dsr-meta" }, [
            el("div", { className: "dsr-name", text: entry.label }, null),
            el("div", { className: "dsr-desc", text: actionSummary(entry.action) }, null),
          ]),
          el(
            "button",
            {
              type: "button",
              className: "dsr-mini",
              title: "上移",
              text: "↑",
              disabled: index === 0,
              onClick: function () {
                moveEntry(index, -1);
              },
            },
            null
          ),
          el(
            "button",
            {
              type: "button",
              className: "dsr-mini",
              title: "下移",
              text: "↓",
              disabled: index === editDraft.length - 1,
              onClick: function () {
                moveEntry(index, 1);
              },
            },
            null
          ),
          el(
            "button",
            {
              type: "button",
              className: "dsr-mini",
              text: "编辑",
              onClick: function () {
                editIndex = index;
                renderEditor();
              },
            },
            null
          ),
          el(
            "button",
            {
              type: "button",
              className: "dsr-mini",
              text: "删除",
              onClick: function () {
                editDraft.splice(index, 1);
                renderEditor();
              },
            },
            null
          ),
        ]);
        frag.appendChild(row);
      });

      if (editShowImport) {
        frag.appendChild(
          el("div", { className: "dsr-field" }, [
            el("span", { className: "dsr-label", text: "粘贴 JSON（数组，或 { entries: [...] }）" }, null),
            el("textarea", {
              className: "dsr-area",
              placeholder: '[{ "icon": "★", "label": "名称", "action": { "type": "prompt", "text": "…" } }]',
              value: editImportText,
              onInput: function (event) {
                editImportText = event.target.value;
              },
            }),
            el(
              "button",
              {
                type: "button",
                className: "dsr-mini",
                text: "导入",
                onClick: doImport,
              },
              null
            ),
          ])
        );
      }
      return frag;
    }

    function moveEntry(index, delta) {
      const target = index + delta;
      if (target < 0 || target >= editDraft.length) return;
      const tmp = editDraft[index];
      editDraft[index] = editDraft[target];
      editDraft[target] = tmp;
      renderEditor();
    }

    function doImport() {
      try {
        const parsed = JSON.parse(editImportText);
        const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.entries) ? parsed.entries : null;
        if (list === null) {
          editNote = "格式不对：需要数组或 { entries: [...] }";
          renderEditor();
          return;
        }
        editDraft = list.map(sanitizeEntry).filter(Boolean);
        editShowImport = false;
        editImportText = "";
        editNote = "已导入 " + editDraft.length + " 条，记得点保存";
      } catch (err) {
        editNote = "JSON 解析失败";
      }
      renderEditor();
    }

    function formView() {
      const entry = editDraft[editIndex];
      if (entry === undefined) {
        editIndex = null;
        return listView();
      }
      const frag = document.createDocumentFragment();

      frag.appendChild(
        el("div", { className: "dsr-field" }, [
          el("span", { className: "dsr-label", text: "图标（1–2 个字符，建议 emoji 或符号）" }, null),
          el("input", {
            className: "dsr-input",
            value: entry.icon,
            onInput: function (event) {
              entry.icon = Array.from(event.target.value).slice(0, 2).join("");
            },
          }),
        ])
      );

      frag.appendChild(
        el("div", { className: "dsr-field" }, [
          el("span", { className: "dsr-label", text: "名称（悬停提示）" }, null),
          el("input", {
            className: "dsr-input",
            value: entry.label,
            onInput: function (event) {
              entry.label = event.target.value;
            },
          }),
        ])
      );

      const typeSelect = el(
        "select",
        {
          className: "dsr-select",
          onChange: function (event) {
            entry.action = { type: event.target.value };
            renderEditor();
          },
        },
        ACTION_TYPES.map(function (option) {
          return el("option", { value: option.value, text: option.label }, null);
        })
      );
      typeSelect.value = entry.action.type;
      frag.appendChild(el("div", { className: "dsr-field" }, [el("span", { className: "dsr-label", text: "动作" }, null), typeSelect]));

      if (entry.action.type === "prompt" || entry.action.type === "session") {
        frag.appendChild(
          el("div", { className: "dsr-field" }, [
            el(
              "span",
              {
                className: "dsr-label",
                text: entry.action.type === "prompt" ? "提示词（填入当前输入框，不自动发送）" : "提示词（新会话发送）",
              },
              null
            ),
            el("textarea", {
              className: "dsr-area",
              value: entry.action.text || "",
              onInput: function (event) {
                entry.action.text = event.target.value;
              },
            }),
          ])
        );
      }

      if (entry.action.type === "panel") {
        frag.appendChild(
          el("div", { className: "dsr-field" }, [
            el("span", { className: "dsr-label", text: "面板 id（如 plugins、schedule）" }, null),
            el("input", {
              className: "dsr-input",
              value: entry.action.id || "",
              onInput: function (event) {
                entry.action.id = event.target.value;
              },
            }),
          ])
        );
      }

      if (entry.action.type === "url") {
        frag.appendChild(
          el("div", { className: "dsr-field" }, [
            el("span", { className: "dsr-label", text: "链接（https://…）" }, null),
            el("input", {
              className: "dsr-input",
              value: entry.action.url || "",
              onInput: function (event) {
                entry.action.url = event.target.value;
              },
            }),
          ])
        );
      }

      return frag;
    }

    function footView() {
      const foot = el("div", { className: "dsr-foot" }, null);

      if (editIndex === null) {
        foot.appendChild(
          el(
            "button",
            {
              type: "button",
              className: "dsr-mini",
              text: "添加条目",
              onClick: function () {
                editDraft.push({ id: "e-" + Math.random().toString(36).slice(2, 9), icon: "★", label: "新条目", action: { type: "prompt", text: "" } });
                editIndex = editDraft.length - 1;
                renderEditor();
              },
            },
            null
          )
        );
        foot.appendChild(el("button", { type: "button", className: "dsr-mini", text: "导出", onClick: doExport }, null));
        foot.appendChild(
          el(
            "button",
            {
              type: "button",
              className: "dsr-mini",
              text: "导入",
              onClick: function () {
                editShowImport = !editShowImport;
                renderEditor();
              },
            },
            null
          )
        );
        foot.appendChild(
          el(
            "button",
            {
              type: "button",
              className: "dsr-mini",
              text: "恢复默认",
              onClick: function () {
                editDraft = clone(DEFAULT_ENTRIES.map(sanitizeEntry).filter(Boolean));
                editNote = "已恢复默认，记得点保存";
                renderEditor();
              },
            },
            null
          )
        );
      } else {
        foot.appendChild(
          el(
            "button",
            {
              type: "button",
              className: "dsr-mini",
              text: "返回列表",
              onClick: function () {
                editIndex = null;
                renderEditor();
              },
            },
            null
          )
        );
        foot.appendChild(
          el(
            "button",
            {
              type: "button",
              className: "dsr-mini",
              text: "删除此条",
              onClick: function () {
                editDraft.splice(editIndex, 1);
                editIndex = null;
                renderEditor();
              },
            },
            null
          )
        );
      }

      foot.appendChild(el("span", { className: "dsr-spacer" }, null));
      foot.appendChild(el("button", { type: "button", className: "dsr-mini", text: "取消", onClick: cancelEdit }, null));
      foot.appendChild(el("button", { type: "button", className: "dsr-primary", text: "保存", onClick: commitEditor }, null));
      if (editNote) foot.appendChild(el("div", { className: "dsr-hint", text: editNote }, null));
      return foot;
    }

    function doExport() {
      const text = JSON.stringify(editDraft, null, 2);
      try {
        const blob = new Blob([text], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "dsh-sidebar-rail.json";
        link.click();
        window.setTimeout(function () {
          URL.revokeObjectURL(url);
        }, 1000);
        editNote = "已导出文件";
      } catch (err) {
        diag.errors.push("export: " + String(err));
        editNote = "导出失败，可改用导入框反向复制";
      }
      renderEditor();
    }

    // ------------------------------------------------------------ floating rail
    /**
     * 悬浮轨道：整条竖轨脱离侧边栏，固定在视口任意位置。
     *
     * 流畅性做法：
     *  - 拖动过程中**只写 transform: translate3d()**，不碰 left/top，
     *    全程合成层变换，不触发任何布局；指针事件用 rAF 合帧，一帧最多算一次。
     *  - 松手后才把位移折算进 --dsr-float-x/y 变量并落盘，此时才有一次布局。
     *  - 用 setPointerCapture 而不是 window 监听：指针移出视口也不会丢事件，
     *    且不会像 window 监听那样在每个 mousemove 上跑一遍冒泡。
     */
    let floating = false;
    let floatX = 12;
    let floatY = 120;
    let gripEl = null;
    let floatRoot = null;
    let floatDrag = null;
    let floatRaf = 0;
    let floatPending = null;
    /** 拖动期间要跟着位移的层（nav + 自定义条目），按下时缓存一次 */
    let floatLayers = null;
    /** 轨道宽度（px），由 applyRailState 维护，悬浮态直接复用 */
    let railWidthPx = RAIL_W;

    function loadFloat() {
      try {
        const raw = window.localStorage.getItem(STORAGE_FLOAT);
        const v = raw === null ? null : JSON.parse(raw);
        if (v !== null && typeof v === "object") {
          floating = v.on === true;
          if (Number.isFinite(v.x)) floatX = v.x;
          if (Number.isFinite(v.y)) floatY = v.y;
        }
      } catch (err) {
        floating = false;
      }
    }

    function saveFloat() {
      try {
        window.localStorage.setItem(STORAGE_FLOAT, JSON.stringify({ on: floating, x: Math.round(floatX), y: Math.round(floatY) }));
      } catch (err) {
        diag.errors.push("float-save: " + String(err));
      }
    }

    /** 悬浮总高度：抓取条 + 面板轨道 + 自定义条目 */
    function floatHeight() {
      if (floatRoot === null) return 0;
      let h = 22;
      const nav = floatRoot.querySelector('[' + ATTR_PART + '="nav"]');
      const custom = floatRoot.querySelector('[' + ATTR_PART + '="custom"]');
      if (nav !== null) h += Math.round(nav.getBoundingClientRect().height);
      if (custom !== null) h += Math.round(custom.getBoundingClientRect().height);
      return h;
    }

    /** 把坐标夹进视口，四周留 8px 呼吸，避免贴边后抓不住 */
    function clampFloat(x, y) {
      const w = railWidthPx;
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      const h = floatHeight() || 200;
      const maxX = Math.max(8, vw - w - 8);
      const maxY = Math.max(8, vh - h - 8);
      return { x: Math.min(Math.max(8, x), maxX), y: Math.min(Math.max(8, y), maxY) };
    }

    /** 只在该变量确实变化时才写：无谓的 setProperty 会让整棵子树重算样式 */
    function setVar(node, name, value) {
      if (node.style.getPropertyValue(name) === value) return false;
      node.style.setProperty(name, value);
      return true;
    }

    /** 把位置落到 root 上的 CSS 变量；这是唯一会触发布局的地方 */
    function applyFloat(root) {
      if (root === null || root === undefined) return;
      if (!floating) {
        if (root.hasAttribute(ATTR_FLOAT)) root.removeAttribute(ATTR_FLOAT);
        if (root.style.getPropertyValue("--dsr-float-x") !== "") {
          root.style.removeProperty("--dsr-float-x");
          root.style.removeProperty("--dsr-float-y");
          root.style.removeProperty("--dsr-float-w");
          root.style.removeProperty("--dsr-float-nav-h");
        }
        diag.floating = false;
        removeGrip();
        return;
      }
      // 拖动中位置由 transform 表达，这里再写一遍变量等于每帧强制同步布局：
      // clampFloat → floatHeight → getBoundingClientRect，正是闪烁与掉帧的来源。
      if (floatDrag !== null && floatDrag.active) return;
      // 属性选择器 [data-dsh-rail-float="1"] 命中整棵子树：
      // 值没变还反复 setAttribute 会白白让这些规则失效重算，拖动时尤其明显。
      if (root.getAttribute(ATTR_FLOAT) !== "1") root.setAttribute(ATTR_FLOAT, "1");
      floatRoot = root;
      const pos = clampFloat(floatX, floatY);
      floatX = pos.x;
      floatY = pos.y;
      setVar(root, "--dsr-float-x", Math.round(floatX) + "px");
      setVar(root, "--dsr-float-y", Math.round(floatY) + "px");
      setVar(root, "--dsr-float-w", railWidthPx + "px");
      const nav = root.querySelector('[' + ATTR_PART + '="nav"]');
      const navH = nav === null ? 0 : Math.round(nav.getBoundingClientRect().height);
      setVar(root, "--dsr-float-nav-h", navH + "px");
      ensureGrip(root);
      diag.floating = true;
      diag.floatPos = { x: Math.round(floatX), y: Math.round(floatY), w: railWidthPx, navH: navH };
    }

    /**
     * 进入 / 退出悬浮。
     *
     * 悬浮时轨道离开侧边栏的定高容器，40px 纯图标条在视口里太难点，
     * 所以进入悬浮就自动展开、停靠回来就自动收起——用户不必再单独点一次展开键。
     */
    function setFloating(on) {
      const next = on === true;
      const root = document.querySelector("[" + ATTR_ROOT + "]");
      if (floating === next) {
        applyFloat(root);
        renderRail();
        return;
      }
      // 首次悬浮要换默认落位；必须在 applyFloat 夹取之前判断，
      // 否则夹取会把 (12,120) 改掉，这次判断就永远为假了。
      const firstTime = next === true && floatX === 12 && floatY === 120;
      floating = next;
      railExpanded = next;
      saveFloat();
      saveRailExpanded();
      // 先把展开态落下来：railWidthPx 要反映展开后的真实宽度，
      // 否则默认落位按 40px 算，随后会被夹取往左推，右侧只剩贴边的 8px。
      if (root !== null) applyRailState(root);
      if (firstTime) {
        // 默认丢到视口右侧空白处。不能贴着侧边栏右侧放——悬浮后会话区的
        // 左边距被释放了，贴着放会正好压住会话标题，等于「浮起来反而更差」。
        const vw = window.innerWidth || 0;
        const vh = window.innerHeight || 0;
        floatX = Math.max(8, vw - railWidthPx - 24);
        floatY = Math.max(24, Math.round(vh * 0.18));
      }
      applyFloat(root);
      // 图标/文案/aria 随 floating 与 railExpanded 变，必须重渲染一次轨道
      renderRail();
      scheduleReport();
    }

    function toggleFloat() {
      setFloating(!floating);
    }

    // ------------------------------------------------------------- grip handle
    function ensureGrip(root) {
      if (gripEl !== null && gripEl.isConnected) {
        // 拖动中这几条变换由 paintFloatDelta 独占，别再插一手写变量，
        // 否则每帧都要重算一次样式，还会和位移打架。
        if (floatDrag === null) {
          setVar(gripEl, "--dsr-float-x", Math.round(floatX) + "px");
          setVar(gripEl, "--dsr-float-y", Math.round(floatY) + "px");
          setVar(gripEl, "--dsr-float-w", railWidthPx + "px");
        }
        return;
      }
      removeGrip();
      gripEl = el(
        "div",
        {
          "data-dsh-rail-grip": "1",
          title: "拖动可把功能条放到任意位置 · 双击停靠回侧边栏",
          role: "button",
          tabindex: "0",
          "aria-label": "拖动手柄：把功能条放到任意位置，双击停靠回侧边栏",
        },
        [el("span", { className: "dsr-grip-dots", text: "⋮⋮" }, null)]
      );
      gripEl.style.setProperty("--dsr-float-x", Math.round(floatX) + "px");
      gripEl.style.setProperty("--dsr-float-y", Math.round(floatY) + "px");
      gripEl.style.setProperty("--dsr-float-w", railWidthPx + "px");
      gripEl.addEventListener("pointerdown", onGripPointerDown);
      gripEl.addEventListener("dblclick", function () {
        setFloating(false);
      });
      gripEl.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setFloating(false);
        }
      });
      document.body.appendChild(gripEl);
      void root;
    }

    function removeGrip() {
      if (gripEl !== null) {
        gripEl.remove();
        gripEl = null;
      }
      floatRoot = null;
    }

    /**
     * 拖动中把位移写到三个悬浮层的 transform 上（不触发布局）。
     *
     * 三层元素在按下时缓存一次：拖动每帧都要用，反复 querySelector
     * 会在 DSH 这种深层 DOM 上白白烧掉主线程时间。
     */
    function paintFloatDelta(dx, dy) {
      const t = dx === 0 && dy === 0 ? "" : "translate3d(" + dx + "px," + dy + "px,0)";
      if (gripEl !== null) gripEl.style.transform = t;
      const layers = floatLayers;
      if (layers !== null) {
        for (const node of layers) {
          if (node !== null && node.isConnected) node.style.transform = t;
        }
      } else if (floatRoot !== null) {
        const nav = floatRoot.querySelector('[' + ATTR_PART + '="nav"]');
        const custom = floatRoot.querySelector('[' + ATTR_PART + '="custom"]');
        if (nav !== null) nav.style.transform = t;
        if (custom !== null) custom.style.transform = t;
      }
    }

    function flushFloatFrame() {
      floatRaf = 0;
      const pending = floatPending;
      if (pending === null || floatDrag === null) return;
      floatPending = null;
      paintFloatDelta(pending.dx, pending.dy);
    }

    function onGripPointerDown(event) {
      if (event.button !== 0) return;
      if (gripEl === null) return;
      event.preventDefault();
      const startX = floatX;
      const startY = floatY;
      floatDrag = { x0: event.clientX, y0: event.clientY, sx: startX, sy: startY, active: false, dx: 0, dy: 0 };
      // 缓存位移目标：拖动每帧都要写，别在 DSH 的深层 DOM 里反复 querySelector
      if (floatRoot !== null) {
        floatLayers = [
          floatRoot.querySelector('[' + ATTR_PART + '="nav"]'),
          floatRoot.querySelector('[' + ATTR_PART + '="custom"]'),
        ];
      } else {
        floatLayers = null;
      }
      try {
        gripEl.setPointerCapture(event.pointerId);
      } catch (err) {
        /* 某些环境不支持指针捕获，退回普通监听 */
      }
      gripEl.addEventListener("pointermove", onGripPointerMove);
      gripEl.addEventListener("pointerup", onGripPointerUp);
      gripEl.addEventListener("pointercancel", onGripPointerUp);
    }

    function onGripPointerMove(event) {
      if (floatDrag === null) return;
      const dx = event.clientX - floatDrag.x0;
      const dy = event.clientY - floatDrag.y0;
      if (!floatDrag.active) {
        if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
        floatDrag.active = true;
        if (document.body) document.body.classList.add("dsr-float-dragging");
      }
      event.preventDefault();
      floatDrag.dx = dx;
      floatDrag.dy = dy;
      floatPending = { dx: dx, dy: dy };
      if (floatRaf === 0) floatRaf = window.requestAnimationFrame(flushFloatFrame);
    }

    function onGripPointerUp(event) {
      if (gripEl !== null) {
        gripEl.removeEventListener("pointermove", onGripPointerMove);
        gripEl.removeEventListener("pointerup", onGripPointerUp);
        gripEl.removeEventListener("pointercancel", onGripPointerUp);
        try {
          gripEl.releasePointerCapture(event.pointerId);
        } catch (err) {
          /* 忽略 */
        }
      }
      if (floatRaf !== 0) {
        window.cancelAnimationFrame(floatRaf);
        floatRaf = 0;
      }
      floatPending = null;
      const d = floatDrag;
      floatDrag = null;
      floatLayers = null;
      if (d === null) return;
      paintFloatDelta(0, 0);
      if (!d.active) return;
      if (document.body) document.body.classList.remove("dsr-float-dragging");
      floatX = d.sx + d.dx;
      floatY = d.sy + d.dy;
      // 先落位（applyFloat 内部会把坐标夹进视口并写回 floatX/floatY），再存盘。
      // 反过来的话会把视口外的坐标写进 localStorage，下次刷新还原到一个抓不到的位置。
      applyFloat(floatRootGood());
      saveFloat();
      // 拖动期间 schedule 被冻结，松手后补一次同步把几何追平
      schedule();
      scheduleReport();
    }

    function floatRootGood() {
      if (floatRoot !== null && floatRoot.isConnected) return floatRoot;
      return document.querySelector("[" + ATTR_ROOT + "]");
    }

    /** 窗口尺寸变化后重新夹一次，避免悬浮条跑到屏幕外 */
    function reclampFloat() {
      if (!floating) return;
      const root = floatRootGood();
      if (root === null) return;
      applyFloat(root);
    }

    function cancelFloatDrag() {
      if (floatRaf !== 0) {
        window.cancelAnimationFrame(floatRaf);
        floatRaf = 0;
      }
      floatPending = null;
      if (gripEl !== null) {
        gripEl.removeEventListener("pointermove", onGripPointerMove);
        gripEl.removeEventListener("pointerup", onGripPointerUp);
        gripEl.removeEventListener("pointercancel", onGripPointerUp);
      }
      floatDrag = null;
      floatLayers = null;
      paintFloatDelta(0, 0);
      if (document.body) document.body.classList.remove("dsr-float-dragging");
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
      navEl = null;
      railSig = "";
      // 悬浮层的把手与拖拽残留一并撤掉（floating 这个偏好本身保留，下次锚点回来还能复现）
      cancelFloatDrag();
      removeGrip();
      if (floating) {
        document.querySelectorAll('[' + ATTR_FLOAT + ']').forEach(function (node) {
          node.removeAttribute(ATTR_FLOAT);
        });
      }
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
      if (document.querySelector("[data-sidebar-collapsed]") !== null) return true;
      if (document.querySelector("[data-sidebar-drawer]") !== null) return true;
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
          // React 重渲染会重建这些按钮，applyNavOrder 是幂等的，每次 sync 重放一遍即可。
          navEl = nav;
          attachDrag(navEl);
          applyNavOrder(navEl);
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
        applyFloat(root);
        diag.tagged = true;

        // 采集几何，供宿主侧 last-report.json 判断「是否真的并列」
        try {
          const wsCol = root.closest('[class*="sidebarCol"]') || root.parentElement;
          const colStyle = wsCol === null ? null : window.getComputedStyle(wsCol);
          const box = function (node) {
            if (node === null) return null;
            const r = node.getBoundingClientRect();
            return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
          };
          diag.viewport = { w: window.innerWidth, h: window.innerHeight };
          diag.geometry = {
            root: box(root),
            col: box(wsCol),
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
      if (floatDrag !== null && floatDrag.active) return;
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
      if (editorHost !== null && (node === editorHost || editorHost.contains(node))) return true;
      // 抓取条挂在 body 上，插入/移除会触发 observer；不认作自己的节点就会自激循环
      if (gripEl !== null && (node === gripEl || gripEl.contains(node))) return true;
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
        reclampFloat();
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
      cancelDrag();
      closeEditor();
      clearTags();
      settingsHost = null;
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

    // ------------------------------------------------------------------- apply
    function apply(ctx) {
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
      // 面板图标顺序必须在第一次 sync 之前读进来，否则刷新后 applyNavOrder
      // 拿到空数组，会按 DOM 原始顺序重排，看起来像「顺序没保存」。
      loadNavOrder();
      // 悬浮偏好同理：要先于首次 sync 载入，否则会先按停靠态渲染再跳一次
      loadFloat();
      resetDraft();
      stylesDispose = installStyles();

      if (ctx.slots !== undefined && typeof ctx.slots.inject === "function") {
        ctx.slots.inject(INPUT_SLOT, function () {
          return ctx.slots.register({ name: INPUT_SLOT, id: PLUGIN_ID, order: 900 }, CaptureInputActions);
        });

        // 设置页：条目编辑搬进 DSH 官方设置，侧边栏不再有齿轮入口。
        // 注册失败（例如 renderer 不接受）不能影响布局，因此整段包 try/catch。
        try {
          ctx.slots.inject(SETTINGS_SECTION, function () {
            return ctx.slots.register(
              { name: SETTINGS_SECTION, id: SETTINGS_SECTION_ID, order: 820, label: function () { return "侧边栏条目"; } },
              SettingsSection
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
