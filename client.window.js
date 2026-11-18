/**
 * 可选模块：设置窗口化。
 *
 * 给 DSH 官方的设置弹窗补上桌面窗口的行为：
 *   - 按住顶部标题栏拖动整个窗口；
 *   - 右上角三个「红绿灯」按钮（关闭=红 / 最小化=黄 / 最大化=绿）；
 *   - 最大化 = 铺满侧边栏右侧的会话区，再点一次还原；
 *   - 最小化 = 收成一条停在弹出位置的标题栏，点它还原；
 *   - 关闭 = 调用官方自己的 close（与右上角 ×、遮罩点击、Esc 完全等价）。
 *
 * 设计上只用「官方设置弹窗本来就有的 DOM 契约」定位：
 *   [data-shortcut-modal="settings"]  → 面板本身（role=dialog）
 *   它的父节点是 overlay，overlay 下的 [aria-hidden="true"] 是遮罩；
 *   面板内的直系后代里带 gridArea=title 的节点是标题栏文字区，
 *   gridArea=header 的是官方放操作按钮的那一行。
 * 选不到任何节点就整体静默退出，绝不去猜别的选择器。
 *
 * 本模块缺席、加载失败或运行期抛错时，设置弹窗保持 DSH 原生样子——
 * 内核用 callModule 守卫，只会把这个功能摘掉，不影响侧边栏与其他模块。
 */
window.__ModuleLoader__.load({
  id: "dsh-sidebar-rail",
  chunk: "client.window.js",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // ---------------------------------------------------------------- 内核契约
    let api = null;
    let diag = null;
    let el = null;

    function pushError(message) {
      if (api !== null && typeof api.pushError === "function") api.pushError("window: " + message);
    }

    // ------------------------------------------------------------------- 常量
    const ATTR_WIN = "data-dsh-rail-win";
    const ATTR_GRIP = "data-dsh-rail-win-grip";
    const ATTR_LIGHTS = "data-dsh-rail-win-lights";
    const STORAGE_WIN = "dsh-sidebar-rail.win.v1";
    const PANEL_SEL = '[data-shortcut-modal="settings"]';
    const TITLE_SEL = '[data-dsh-rail-win-title="1"]';
    const CLEANUP_KEY = "__dshRailWindow";

    const DRAG_THRESHOLD = 3;
    const VIEWPORT_GAP = 8;

    // 三条状态：
    //   normal  – 官方居中布局，未做任何位移
    //   dragged – 用户拖到过某处，按 left/top 摆放
    //   max     – 铺满会话区
    // minimized 独立成布尔值，与上面三条正交。
    const MODE_NORMAL = "normal";
    const MODE_DRAGGED = "dragged";
    const MODE_MAX = "max";

    // ------------------------------------------------------------------- 状态
    let styleEl = null;
    let observer = null;
    let scheduleId = 0;
    let panelEl = null;
    let overlayEl = null;
    let gripEl = null;
    let lightsEl = null;
    let titleEl = null;
    let headerEl = null;
    let toggleEl = null;

    let mode = MODE_NORMAL;
    let minimized = false;
    let posX = 0;
    let posY = 0;
    let drag = null;
    let dragRaf = 0;
    let dragPending = null;
    let closeHandler = null;

    // ---------------------------------------------------------------- 持久化
    function loadState() {
      try {
        const raw = window.localStorage.getItem(STORAGE_WIN);
        if (raw === null) return;
        const saved = JSON.parse(raw);
        if (saved === null || typeof saved !== "object") return;
        if (saved.mode === MODE_DRAGGED || saved.mode === MODE_MAX || saved.mode === MODE_NORMAL) mode = saved.mode;
        if (saved.minimized === true) minimized = true;
        if (Number.isFinite(saved.x)) posX = Math.round(saved.x);
        if (Number.isFinite(saved.y)) posY = Math.round(saved.y);
      } catch (err) {
        // 读到脏数据就当没读过：用默认状态继续，不因此中断整个模块
      }
    }

    function saveState() {
      try {
        window.localStorage.setItem(
          STORAGE_WIN,
          JSON.stringify({ mode: mode, minimized: minimized === true, x: posX, y: posY })
        );
      } catch (err) {
        pushError("saveState 失败：" + String(err));
      }
    }

    // ------------------------------------------------------------------- 样式
    const CSS = [
      /* 标题栏：官方把「设置」两个字单独放在 grid area=title 里，
         这里把它连带同一行右侧的官方按钮行一起变成窗口标题栏。 */
      "[data-dsh-rail-win] [data-dsh-rail-win-title]{",
      "display:flex!important;align-items:center!important;gap:8px!important;",
      "-webkit-user-select:none!important;user-select:none!important;",
      "}",

      /* 抓手：占据标题栏右侧的剩余空间，按住即可拖动整个窗口。
         它自己不放任何文字，所以不会和官方的「设置」标题打架。 */
      "[data-dsh-rail-win] > [data-dsh-rail-win-grip]{",
      "position:absolute;left:0;right:0;top:0;height:54px;",
      "display:flex!important;align-items:center!important;justify-content:flex-end!important;",
      "padding-right:104px;box-sizing:border-box;",
      "cursor:grab;touch-action:none;-webkit-user-drag:none;user-select:none;",
      "z-index:0;",
      "}",
      "body.dsr-win-dragging{cursor:grabbing!important;user-select:none!important}",

      /* 红绿灯：固定在面板右上角，永远压在抓手之上。 */
      "[data-dsh-rail-win] > [data-dsh-rail-win-lights]{",
      "position:absolute;right:12px;",
      "display:flex!important;align-items:center!important;gap:8px!important;",
      "z-index:3;",
      "}",
      "[data-dsh-rail-win-lights] .dsr-light{",
      "width:12px;height:12px;border-radius:50%;border:none;padding:0;margin:0;",
      "cursor:pointer;flex:none;position:relative;",
      "box-shadow:inset 0 0 0 .5px rgba(0,0,0,.14);",
      "transition:filter .12s ease;",
      "}",
      "@media (hover:hover){[data-dsh-rail-win-lights] .dsr-light:hover{filter:brightness(1.12)}}",
      "[data-dsh-rail-win-lights] .dsr-light:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:2px}",
      "[data-dsh-rail-win-lights] .dsr-light-close{background:#ff5f57}",
      "[data-dsh-rail-win-lights] .dsr-light-min{background:#febc2e}",
      "[data-dsh-rail-win-lights] .dsr-light-max{background:#28c840}",

      /* 最小化：收成一条停在本位的标题栏，点击任意处还原。 */
      "[data-dsh-rail-win][data-dsh-rail-win-min=\"1\"]{",
      "width:var(--dsr-win-min-w,240px)!important;max-width:none!important;",
      "height:54px!important;min-height:0!important;",
      "grid-template:\"t h\"!important;grid-template-columns:minmax(0,1fr) auto!important;",
      "overflow:hidden!important;",
      "}",
      "[data-dsh-rail-win][data-dsh-rail-win-min=\"1\"] > :not([data-dsh-rail-win-title]):not([data-dsh-rail-win-grip]):not([data-dsh-rail-win-lights]){",
      "display:none!important;",
      "}",
      "[data-dsh-rail-win][data-dsh-rail-win-min=\"1\"] [data-dsh-rail-win-title]{cursor:pointer}",

      /* 最大化：铺满侧边栏右侧的会话区，用圆角做一点桌面窗口的观感。 */
      "[data-dsh-rail-win][data-dsh-rail-win-max=\"1\"]{",
      "position:fixed!important;",
      "border-radius:var(--dsw-radius-panel,12px)!important;",
      "}",
    ].join("\n");

    function installStyles() {
      if (styleEl !== null && styleEl.isConnected) return;
      styleEl = document.createElement("style");
      styleEl.setAttribute("data-plugin", "dsh-sidebar-rail");
      styleEl.setAttribute("data-dsh-rail-part", "window-style");
      styleEl.textContent = CSS;
      document.head.appendChild(styleEl);
    }

    function removeStyles() {
      if (styleEl !== null) styleEl.remove();
      styleEl = null;
    }

    // ------------------------------------------------------------ 几何小工具
    function roundRect(rect) {
      return {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      };
    }

    /** 最大化时铺满的矩形：侧边栏右侧到视口右缘，上下留一点边。 */
    function maxRect() {
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 800;
      let left = VIEWPORT_GAP;
      const root = document.querySelector("[data-dsh-rail-root]");
      if (root !== null) {
        const r = root.getBoundingClientRect();
        if (r.width > 0 && r.right > left) left = Math.round(r.right);
      }
      return {
        x: left,
        y: VIEWPORT_GAP,
        w: Math.max(320, vw - left - VIEWPORT_GAP),
        h: Math.max(240, vh - VIEWPORT_GAP * 2),
      };
    }

    function clampPos(x, y, w, h) {
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 800;
      // 至少留 80px 在可见区内，避免拖到完全点不到的位置
      const minX = 80 - w;
      const maxX = vw - 80;
      const minY = 0;
      const maxY = vh - 54;
      return {
        x: Math.round(Math.min(maxX, Math.max(minX, x))),
        y: Math.round(Math.min(maxY, Math.max(minY, y))),
      };
    }

    // ------------------------------------------------------------------ 渲染
    function ensureLights() {
      if (lightsEl !== null && lightsEl.isConnected) return;
      lightsEl = el("div", {
        "data-dsh-rail-win-lights": "1",
        role: "group",
        "aria-label": "窗口控制",
      }, [
        el("button", {
          type: "button",
          className: "dsr-light dsr-light-close",
          "aria-label": "关闭设置",
          title: "关闭",
          "data-dsr-light": "close",
          onClick: function (event) {
            event.preventDefault();
            event.stopPropagation();
            closeWindow();
          },
        }, null),
        el("button", {
          type: "button",
          className: "dsr-light dsr-light-min",
          "aria-label": "最小化设置",
          title: "最小化",
          "data-dsr-light": "min",
          onClick: function (event) {
            event.preventDefault();
            event.stopPropagation();
            setMinimized(!minimized);
          },
        }, null),
        el("button", {
          type: "button",
          className: "dsr-light dsr-light-max",
          "aria-label": "最大化设置",
          title: "最大化 / 还原",
          "data-dsr-light": "max",
          onClick: function (event) {
            event.preventDefault();
            event.stopPropagation();
            toggleMax();
          },
        }, null),
      ]);
      panelEl.appendChild(lightsEl);
    }

    function ensureGrip() {
      if (gripEl !== null && gripEl.isConnected) return;
      gripEl = el("div", { "data-dsh-rail-win-grip": "1", "aria-hidden": "true" }, null);
      gripEl.addEventListener("pointerdown", onGripPointerDown);
      gripEl.addEventListener("dblclick", function (event) {
        event.preventDefault();
        toggleMax();
      });
      panelEl.insertBefore(gripEl, panelEl.firstChild);
    }

    function computeTitleBarTop() {
      if (titleEl === null || headerEl === null) {
        // 找不到标题区或按钮行时，用一个稳定的经验值兜底（官方 panel 上内边距 6px + 标题行 22px）
        return 7;
      }
      const nr = titleEl.getBoundingClientRect();
      const hr = headerEl.getBoundingClientRect();
      // 红绿灯与标题行、按钮行在同一水平带上，取两者上沿的较小值再反推相对面板的偏移
      const pr = panelEl.getBoundingClientRect();
      const top = Math.min(nr.top, hr.top);
      return Math.max(4, Math.round(top - pr.top));
    }

    /** 把当前状态完整落到 DOM 上。所有写入都先比对再写，避免无谓的样式重算。 */
    function applyWindow() {
      if (panelEl === null) return;
      const rect = panelEl.getBoundingClientRect();
      const computed = window.getComputedStyle(panelEl);
      const naturalWidth = Math.round(parseFloat(computed.width) || rect.width) || rect.width;
      const naturalHeight = Math.round(parseFloat(computed.height) || rect.height) || rect.height;

      if (mode === MODE_MAX || minimized === true || mode === MODE_DRAGGED) {
        if (panelEl.getAttribute(ATTR_WIN) !== "1") panelEl.setAttribute(ATTR_WIN, "1");
      } else if (panelEl.hasAttribute(ATTR_WIN)) {
        panelEl.removeAttribute(ATTR_WIN);
      }

      // ---- 最小化：只保留标题条
      if (minimized === true) {
        if (panelEl.getAttribute("data-dsh-rail-win-min") !== "1") panelEl.setAttribute("data-dsh-rail-win-min", "1");
      } else if (panelEl.hasAttribute("data-dsh-rail-win-min")) {
        panelEl.removeAttribute("data-dsh-rail-win-min");
      }

      // ---- 最大化标记
      if (mode === MODE_MAX && minimized !== true) {
        if (panelEl.getAttribute("data-dsh-rail-win-max") !== "1") panelEl.setAttribute("data-dsh-rail-win-max", "1");
      } else if (panelEl.hasAttribute("data-dsh-rail-win-max")) {
        panelEl.removeAttribute("data-dsh-rail-win-max");
      }

      // ---- 位置与尺寸
      let box = null;
      if (minimized === true) {
        // 最小化时停在「当前应处的位置」，宽度收成一条
        const w = Math.min(320, Math.max(200, Math.round(naturalWidth)));
        const anchor = mode === MODE_MAX ? maxRect() : { x: posX, y: posY };
        box = { x: anchor.x, y: anchor.y, w: w, h: 54 };
      } else if (mode === MODE_MAX) {
        box = maxRect();
      } else if (mode === MODE_DRAGGED) {
        const clamped = clampPos(posX, posY, naturalWidth, naturalHeight);
        if (clamped.x !== posX || clamped.y !== posY) {
          posX = clamped.x;
          posY = clamped.y;
        }
        box = { x: posX, y: posY, w: naturalWidth, h: naturalHeight };
      }

      if (box === null) {
        // normal：交还给官方居中布局
        if (panelEl.style.position !== "") panelEl.style.position = "";
        if (panelEl.style.left !== "") panelEl.style.left = "";
        if (panelEl.style.top !== "") panelEl.style.top = "";
        if (panelEl.style.width !== "") panelEl.style.width = "";
        if (panelEl.style.height !== "") panelEl.style.height = "";
        if (panelEl.style.maxWidth !== "") panelEl.style.maxWidth = "";
        if (panelEl.style.margin !== "") panelEl.style.margin = "";
        if (panelEl.style.transform !== "") panelEl.style.transform = "";
      } else {
        const isMax = mode === MODE_MAX && minimized !== true;
        if (isMax) {
          if (panelEl.style.position !== "fixed") panelEl.style.position = "fixed";
          if (panelEl.style.margin !== "0") panelEl.style.margin = "0";
          panelEl.style.left = box.x + "px";
          panelEl.style.top = box.y + "px";
          panelEl.style.width = box.w + "px";
          panelEl.style.height = box.h + "px";
          panelEl.style.maxWidth = "none";
        } else if (minimized === true) {
          if (panelEl.style.position !== "fixed") panelEl.style.position = "fixed";
          if (panelEl.style.margin !== "0") panelEl.style.margin = "0";
          panelEl.style.left = box.x + "px";
          panelEl.style.top = box.y + "px";
          panelEl.style.width = box.w + "px";
          panelEl.style.height = "54px";
          panelEl.style.maxWidth = "none";
        } else {
          if (panelEl.style.position !== "fixed") panelEl.style.position = "fixed";
          if (panelEl.style.margin !== "0") panelEl.style.margin = "0";
          panelEl.style.left = box.x + "px";
          panelEl.style.top = box.y + "px";
          if (panelEl.style.width !== "") panelEl.style.width = "";
          if (panelEl.style.height !== "") panelEl.style.height = "";
          if (panelEl.style.maxWidth !== "") panelEl.style.maxWidth = "";
        }
      }

      // ---- 抓手与红绿灯的纵向位置跟着标题行走
      const barTop = computeTitleBarTop();
      if (gripEl !== null) {
        const wanted = barTop + "px";
        if (gripEl.style.height !== "54px") gripEl.style.height = "54px";
        if (gripEl.style.top !== "0px") gripEl.style.top = "0px";
        if (gripEl.dataset.barTop !== wanted) gripEl.dataset.barTop = wanted;
      }
      if (lightsEl !== null) {
        const wanted = Math.max(4, barTop + 6) + "px";
        if (lightsEl.style.top !== wanted) lightsEl.style.top = wanted;
      }

      // ---- 诊断
      if (diag !== null) {
        diag.window = {
          mode: mode,
          minimized: minimized === true,
          x: box === null ? null : box.x,
          y: box === null ? null : box.y,
          w: box === null ? naturalWidth : box.w,
          h: box === null ? naturalHeight : box.h,
        };
      }
    }

    // ------------------------------------------------------------- 三个动作
    function closeWindow() {
      if (typeof closeHandler === "function") {
        closeHandler();
        return;
      }
      // 官方在 overlay 上挂了点击关闭，退一步也能用同样的路径
      if (overlayEl !== null) overlayEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }

    function setMinimized(next) {
      const want = next === true;
      if (minimized === want) return;
      minimized = want;
      saveState();
      applyWindow();
      if (panelEl !== null && panelEl.getAttribute("data-shortcut-modal") === "settings") {
        // 最小化时把焦点还给页面，避免键盘事件继续打给「被藏起来」的面板
        if (want && panelEl.contains(document.activeElement)) {
          try {
            document.activeElement.blur();
          } catch (err) {
            // 忽略：焦点状态不影响功能
          }
        }
        // 还原后让面板重新拿到焦点，Esc 才能继续生效
        if (!want) {
          try {
            panelEl.focus({ preventScroll: true });
          } catch (err) {
            // 忽略
          }
        }
      }
    }

    function toggleMax() {
      if (minimized === true) {
        setMinimized(false);
        mode = MODE_MAX;
        saveState();
        applyWindow();
        return;
      }
      mode = mode === MODE_MAX ? (posX === 0 && posY === 0 ? MODE_NORMAL : MODE_DRAGGED) : MODE_MAX;
      saveState();
      applyWindow();
    }

    // ------------------------------------------------------------------ 拖动
    function flushDrag() {
      dragRaf = 0;
      if (drag === null || dragPending === null || panelEl === null) return;
      const dx = dragPending.dx;
      const dy = dragPending.dy;
      dragPending = null;
      // 拖动期间只写 transform：由合成器处理，不触发布局
      panelEl.style.transform = "translate3d(" + dx + "px," + dy + "px,0)";
      if (gripEl !== null) gripEl.style.transform = "translate3d(" + dx + "px," + dy + "px,0)";
      if (lightsEl !== null) lightsEl.style.transform = "translate3d(" + dx + "px," + dy + "px,0)";
      if (diag !== null && diag.window !== null && diag.window !== undefined) {
        diag.window.dragging = { dx: dx, dy: dy };
      }
    }

    function clearDragTransform() {
      if (panelEl !== null && panelEl.style.transform !== "") panelEl.style.transform = "";
      if (gripEl !== null && gripEl.style.transform !== "") gripEl.style.transform = "";
      if (lightsEl !== null && lightsEl.style.transform !== "") lightsEl.style.transform = "";
    }

    function onGripPointerDown(event) {
      if (event.button !== 0) return;
      if (panelEl === null) return;
      if (minimized === true) return;
      // 红绿灯自己会 stopPropagation，这里再兜一次
      if (event.target instanceof Element && event.target.closest("[data-dsh-rail-win-lights]") !== null) return;
      event.preventDefault();
      const p = mode === MODE_DRAGGED ? { x: posX, y: posY } : roundRect(panelEl.getBoundingClientRect());
      drag = {
        x0: event.clientX,
        y0: event.clientY,
        sx: p.x,
        sy: p.y,
        active: false,
      };
      dragPending = null;
      try {
        gripEl.setPointerCapture(event.pointerId);
      } catch (err) {
        // 某些环境不支持指针捕获，退化成普通监听即可
      }
      window.addEventListener("pointermove", onGripPointerMove, true);
      window.addEventListener("pointerup", onGripPointerUp, true);
      window.addEventListener("pointercancel", onGripPointerUp, true);
    }

    function onGripPointerMove(event) {
      if (drag === null) return;
      const dx = event.clientX - drag.x0;
      const dy = event.clientY - drag.y0;
      if (drag.active !== true) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        drag.active = true;
        document.body.classList.add("dsr-win-dragging");
      }
      event.preventDefault();
      dragPending = { dx: dx, dy: dy };
      if (dragRaf === 0) dragRaf = window.requestAnimationFrame(flushDrag);
    }

    function onGripPointerUp(event) {
      window.removeEventListener("pointermove", onGripPointerMove, true);
      window.removeEventListener("pointerup", onGripPointerUp, true);
      window.removeEventListener("pointercancel", onGripPointerUp, true);
      if (drag === null) return;
      const d = drag;
      drag = null;
      try {
        if (gripEl !== null && gripEl.hasPointerCapture(event.pointerId)) gripEl.releasePointerCapture(event.pointerId);
      } catch (err) {
        // 忽略
      }
      if (dragRaf !== 0) {
        window.cancelAnimationFrame(dragRaf);
        dragRaf = 0;
      }
      dragPending = null;
      document.body.classList.remove("dsr-win-dragging");
      if (d.active !== true) return;

      const dx = event.clientX - d.x0;
      const dy = event.clientY - d.y0;
      const clamped = clampPos(d.sx + dx, d.sy + dy, 0, 0);
      posX = clamped.x;
      posY = clamped.y;
      // 顺序很关键：先把 transform 清掉再写 left/top 会闪一帧；
      // 这里反过来——先落 left/top，再在同一任务里清 transform。
      if (mode !== MODE_MAX) mode = MODE_DRAGGED;
      applyWindow();
      clearDragTransform();
      saveState();
    }

    // -------------------------------------------------------- 面板的发现与接管
    function cleanupPanel() {
      clearDragTransform();
      if (gripEl !== null) {
        gripEl.removeEventListener("pointerdown", onGripPointerDown);
        gripEl.remove();
        gripEl = null;
      }
      if (lightsEl !== null) {
        lightsEl.remove();
        lightsEl = null;
      }
      if (panelEl !== null) {
        panelEl.removeAttribute(ATTR_WIN);
        panelEl.removeAttribute("data-dsh-rail-win-min");
        panelEl.removeAttribute("data-dsh-rail-win-max");
        panelEl.removeAttribute("data-shortcut-modal");
      }
      if (toggleEl !== null) {
        toggleEl.remove();
        toggleEl = null;
      }
      if (document.body.classList.contains("dsr-win-dragging")) document.body.classList.remove("dsr-win-dragging");
      panelEl = null;
      overlayEl = null;
      titleEl = null;
      headerEl = null;
      closeHandler = null;
      drag = null;
    }

    function findNativeCloseButton() {
      if (panelEl === null) return null;
      const buttons = panelEl.querySelectorAll("button");
      for (const btn of buttons) {
        // 官方关闭按钮：唯一一个「没有文字、但里面有 svg」且位于 header 区的按钮
        if (headerEl !== null && !headerEl.contains(btn)) continue;
        if ((btn.textContent || "").trim().length > 0) continue;
        if (btn.querySelector("svg") === null) continue;
        if (btn.getAttribute("aria-label") || btn.getAttribute("title")) {
          // 有明确无障碍名字的按钮多半是别的功能，跳过
          const name = (btn.getAttribute("aria-label") || btn.getAttribute("title") || "").toLowerCase();
          if (!/close|关闭/.test(name)) continue;
        }
        return btn;
      }
      return null;
    }

    /**
     * 真正的接管入口。先解掉上一轮（可能已被宿主重新挂载过），再重新定位。
     * 任何一步找不到就整体放弃，保持官方样子。
     */
    function adopt(preferred) {
      cleanupPanel();
      let panel = preferred !== null && preferred !== undefined ? preferred : document.querySelector(PANEL_SEL);
      if (panel === null && preferred && preferred.closest) panel = preferred.closest("[role='dialog']");
      if (panel === null || panel.parentElement === null) return;

      // 官方用 data-shortcut-modal="settings" 标记自己；若拿到的是同类别的面板但没有该属性，
      // 说明是宿主重新挂载后的新节点，给它补上以便下次还能按选择器找到它。
      panelEl = panel;
      overlayEl = panel.parentElement;
      if (panel.getAttribute("data-shortcut-modal") !== "settings") panel.setAttribute("data-shortcut-modal", "settings");

      // 找标题区与按钮行：靠 grid-area，而不是靠哈希类名
      const descendants = panel.querySelectorAll("*");
      for (const node of descendants) {
        if (node.closest(TITLE_SEL) !== null) continue;
        const area = window.getComputedStyle(node).gridArea || "";
        const first = area.split(" ")[0];
        if (titleEl === null && first === "title") titleEl = node;
        else if (headerEl === null && first === "header") headerEl = node;
        if (titleEl !== null && headerEl !== null) break;
      }
      if (titleEl === null) {
        // 找不到标题区就放弃接管——没有标题栏的窗口拖不动，留着只会让用户困惑
        cleanupPanel();
        return;
      }
      titleEl.setAttribute("data-dsh-rail-win-title", "1");

      const nativeClose = findNativeCloseButton();
      if (nativeClose !== null) {
        closeHandler = function () {
          nativeClose.click();
        };
      }

      ensureGrip();
      ensureLights();
      applyWindow();
    }

    /**
     * 官方在「设置」二字上挂了自动聚焦（data-modal-autofocus），按 Esc 会先失焦再关闭。
     * 把焦点挪到面板本身，让 Esc 一次就关。
     */
    function stealAutofocusFocus() {
      if (panelEl === null || titleEl === null) return;
      if (!titleEl.hasAttribute("data-modal-autofocus")) return;
      titleEl.removeAttribute("data-modal-autofocus");
      try {
        panelEl.focus({ preventScroll: true });
      } catch (err) {
        // 忽略
      }
    }

    // ---------------------------------------------------------------- 调度
    function tick() {
      scheduleId = 0;
      if (api === null) return;
      const panel = document.querySelector(PANEL_SEL);
      if (panel === null) {
        if (panelEl !== null) cleanupPanel();
        if (diag !== null) diag.window = { mode: mode, minimized: minimized === true, open: false };
        return;
      }
      if (panel !== panelEl || !panel.isConnected) {
        adopt(panel);
        if (panelEl === null) return;
      }
      stealAutofocusFocus();
      // 位置与尺寸可能被官方重新写回过（React 重渲染），这里对齐一次
      applyWindow();
    }

    function schedule() {
      if (scheduleId !== 0) return;
      scheduleId = window.requestAnimationFrame(tick);
    }

    function startWatch() {
      if (observer !== null) return;
      if (typeof MutationObserver !== "function") return;
      observer = new MutationObserver(function (records) {
        for (const record of records) {
          // 只关心「结构变化」：面板被挂载 / 卸载。样式属性变化由我们自己写，忽略掉，
          // 否则每写一次样式都会回头触发一轮 tick，形成自激。
          if (record.type === "childList") {
            schedule();
            return;
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      window.addEventListener("resize", onResize);
      schedule();
    }

    function onResize() {
      if (panelEl === null) return;
      applyWindow();
    }

    function stopWatch() {
      if (observer !== null) {
        observer.disconnect();
        observer = null;
      }
      window.removeEventListener("resize", onResize);
      if (scheduleId !== 0) {
        window.cancelAnimationFrame(scheduleId);
        scheduleId = 0;
      }
    }

    // ---------------------------------------------------------------- 生命周期
    function dispose() {
      stopWatch();
      cleanupPanel();
      removeStyles();
      if (diag !== null) diag.window = null;
      try {
        delete document[CLEANUP_KEY];
      } catch (err) {
        document[CLEANUP_KEY] = undefined;
      }
    }

    function install(next) {
      api = next;
      diag = api.diag;
      el = api.el;
      loadState();
      installStyles();
      // 上一次挂载（宿主的 HMR 重新执行 bundle）留下的 DOM 由这里收走，
      // 否则会出现两套红绿灯叠在一起。
      try {
        const previous = document[CLEANUP_KEY];
        document[CLEANUP_KEY] = dispose;
        if (previous === dispose) return;
        if (typeof previous === "function") previous();
        document[CLEANUP_KEY] = dispose;
      } catch (err) {
        pushError("接管旧实例失败：" + String(err));
      }
      startWatch();
    }

    exports.install = install;
    exports.dispose = dispose;
    /** 供内核诊断读：当前窗口状态快照 */
    exports.state = function () {
      return { mode: mode, minimized: minimized === true, x: posX, y: posY, attached: panelEl !== null };
    };
    return module.exports;
  },
});
