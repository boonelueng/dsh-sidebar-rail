/**
 * 可选模块：设置窗口化。
 *
 * 给 DSH 官方的设置弹窗补上桌面窗口的行为：
 *   - 按住面板任意位置都能拖动整个窗口（按钮、输入框等交互元素除外）；
 *   - 关闭 = 官方 header 的原生 × 按钮，行为与外观均由宿主提供。
 *
 * 设计上只用「官方设置弹窗本来就有的 DOM 契约」定位，并做两级特性探测：
 *   [data-shortcut-modal="settings"]  → 面板本身（role=dialog）
 *   它的父节点是 overlay，overlay 下的 [aria-hidden="true"] 是遮罩；
 *   ① 新版（0.2.2-alpha.2 起，CSS grid）：面板内侧 gridArea=title / header 的格子；
 *   ② 老版（0.2.1 及更早，flex）：官方 × 按钮所在的那一行当按钮行，
 *      data-modal-autofocus / aria-labelledby / navTitle 类名找标题文字。
 * 两级都选不到节点就整体静默退出，绝不去猜更多选择器。
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

    function pushError(message) {
      if (api !== null && typeof api.pushError === "function") api.pushError("window: " + message);
    }

    /**
     * 读一个功能开关。
     *
     * 功能开关（「按住任意位置拖动」）由内核管，条目在 DSH 设置页「侧边栏条目」里。
     * 拿不到内核状态时一律当「开」：内核没暴露开关（老版本内核）或读取抛错时，
     * 宁可保持旧行为，也不要突然少功能。
     */
    function featureOn(name) {
      if (api === null || typeof api.getFeature !== "function") return true;
      try {
        return api.getFeature(name) === true;
      } catch (err) {
        return true;
      }
    }

    // ------------------------------------------------------------------- 常量
    const ATTR_WIN = "data-dsh-rail-win";
    const ATTR_TITLE = "data-dsh-rail-win-title";
    const ATTR_HEADER = "data-dsh-rail-win-header";
    const ATTR_DRAG = "data-dsh-rail-win-drag";
    const ATTR_DRAGGING = "data-dsh-rail-win-dragging";
    const STORAGE_WIN = "dsh-sidebar-rail.win.v1";
    const PANEL_SEL = '[data-shortcut-modal="settings"]';
    const TITLE_SEL = '[data-dsh-rail-win-title="1"]';
    const CLEANUP_KEY = "__dshRailWindow";

    const DRAG_THRESHOLD = 3;

    /**
     * 按住这里面的东西不算「拖窗口」，要把事件让给它们自己：
     * 按钮、链接、表单控件、可编辑区、以及带 role=button 的自定义控件。
     * 少判一个就会出现「点不动按钮」「输入框里选不了字」这类回归。
     */
    const INTERACTIVE_SEL = [
      "button",
      "a[href]",
      "input",
      "textarea",
      "select",
      "option",
      "label",
      "summary",
      "[contenteditable]",
      "[contenteditable='true']",
      "[role='button']",
      "[role='link']",
      "[role='tab']",
      "[role='checkbox']",
      "[role='switch']",
    ].join(",");

    // 两条状态：
    //   normal  – 官方居中布局，未做任何位移
    //   dragged – 用户拖到过某处，按 left/top 摆放
    const MODE_NORMAL = "normal";
    const MODE_DRAGGED = "dragged";

    // ------------------------------------------------------------------- 状态
    let styleEl = null;
    let observer = null;
    let scheduleId = 0;
    let panelEl = null;
    let overlayEl = null;
    let titleEl = null;
    let headerEl = null;

    let mode = MODE_NORMAL;
    let posX = 0;
    let posY = 0;
    let drag = null;
    let dragRaf = 0;
    let dragPending = null;
    // 松手后延迟撤 will-change 的 rAF 句柄（见 settleDragging 的说明）
    let settleRaf = 0;
    // 上一次量到的面板自然尺寸。落位那一帧要用它跳过 getComputedStyle，
    // 少一次强制同步布局 —— 详见 applyWindow 的 skipMeasure 参数。
    let lastNatural = null;

    /**
     * 跨版本兼容诊断：记录这次接管是用哪条探测路径成功的。
     * 只要不是主路径（grid-area），就说明跑在老的 flex 布局宿主上，
     * 排查「某个版本上不工作」时一眼能看出落到了哪一级兜底。
     */
    const compat = {
      titleBy: null,
      headerBy: null,
      fallbacks: [],
    };

    // ---------------------------------------------------------------- 持久化
    function loadState() {
      try {
        const raw = window.localStorage.getItem(STORAGE_WIN);
        if (raw === null) return;
        const saved = JSON.parse(raw);
        if (saved === null || typeof saved !== "object") return;
        if (saved.mode === MODE_DRAGGED || saved.mode === MODE_NORMAL) mode = saved.mode;
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
          JSON.stringify({ mode: mode, x: posX, y: posY })
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

      /* 任意位置拖动开着时：整块面板给 grab 光标，按住任何非交互处都能拖走。
         关掉拖动就摘掉这个属性，光标立刻退回常态，不会「看起来能拖其实拖不动」。 */
      "[data-dsh-rail-win][data-dsh-rail-win-drag='1']{cursor:grab}",
      "[data-dsh-rail-win][data-dsh-rail-win-drag='1'] *{cursor:inherit}",
      /* 交互元素自己保留原本的光标，否则按钮、链接上也会显示抓手 */
      "[data-dsh-rail-win][data-dsh-rail-win-drag='1'] button{cursor:pointer}",
      "[data-dsh-rail-win][data-dsh-rail-win-drag='1'] a[href]{cursor:pointer}",
      "[data-dsh-rail-win][data-dsh-rail-win-drag='1'] input,"
        + "[data-dsh-rail-win][data-dsh-rail-win-drag='1'] textarea{cursor:text}",
      /* 拖动中：面板内所有子元素本来就 cursor:inherit（见上面那条），
         所以只要盯住面板本身与 body 就够，不必用 `*` 去扫整棵文档树——
         那种写法在 DSH 这种巨型 DOM 上，每次加/摘 class 都是一次全站样式重算。 */
      "body.dsr-win-dragging{cursor:grabbing!important;user-select:none!important}",
      "body.dsr-win-dragging [data-dsh-rail-win]{cursor:grabbing!important}",

      /* 官方 header 行：只做层级保护，保证按钮不被别的图层盖住。
         这里用后代选择器而不是 `>`：0.2.2 之前官方是 flex 布局，
         header 挂在 content 容器内部，不是面板的直系子节点；
         0.2.2 起改成 grid，header 才是直系子。后代选择器两代都命中。 */
      "[data-dsh-rail-win] [data-dsh-rail-win-header]{",
      "position:relative;z-index:2;",
      "}",

       /* ---- 拖动期：只做「图层提示」，不改任何像素 ----
         拖动只写 transform，本该由合成器直接搬运。这里在拖动过程中给面板加
         will-change:transform，让浏览器提前把它当成要动的图层。
         面板材质完全沿用宿主提供的普通样式，拖动前后不写任何视觉属性，
         拖动态与常驻态看起来一模一样，起手和落手才不会各闪一次。 */
      "[data-dsh-rail-win][data-dsh-rail-win-dragging=\"1\"]{",
      "will-change:transform!important;",
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

    /**
     * 面板级拖动入口。
     *
     * 挂在捕获阶段：面板里任何一处按下都会先到这里，判断该不该接管。
     * 交互元素（按钮 / 链接 / 输入框 / 可编辑区 …）直接放行，让它们自己处理点击；
     * 其余位置按下即记录起点，等移动超过阈值才真正开始拖 —— 所以
     * 「点一下」永远还是「点一下」，不会因为手抖变成拖窗口。
     */
    function ensurePanelDrag() {
      if (panelEl === null) return;
      if (featureOn("drag")) {
        if (panelEl.getAttribute(ATTR_DRAG) !== "1") panelEl.setAttribute(ATTR_DRAG, "1");
        if (panelEl.__dsrDragBound !== true) {
          panelEl.addEventListener("pointerdown", onDragPointerDown, true);
          panelEl.__dsrDragBound = true;
        }
        return;
      }
      releasePanelDrag();
    }

    function releasePanelDrag() {
      if (panelEl === null) return;
      if (panelEl.__dsrDragBound === true) {
        panelEl.removeEventListener("pointerdown", onDragPointerDown, true);
        panelEl.__dsrDragBound = false;
      }
      if (panelEl.getAttribute(ATTR_DRAG) === "1") panelEl.removeAttribute(ATTR_DRAG);
    }

    /** 按住这里面的东西不算「拖窗口」，要把事件让给它们自己。 */
    function isInteractive(node) {
      if (!(node instanceof Element)) return false;
      return node.closest(INTERACTIVE_SEL) !== null;
    }

    /**
     * 把当前状态完整落到 DOM 上。所有写入都先比对再写，避免无谓的样式重算。
     *
     * skipMeasure：跳过 getBoundingClientRect + getComputedStyle 那一步，改用上一次
     * 量到的自然尺寸。松手落位那一帧用得上 —— 那里位置刚要改，再插一次强制同步布局
     * 等于让浏览器把「还没画的上一帧」先算完，落位就会晚一帧、看着像掉帧。
     */
    function applyWindow(skipMeasure) {
      if (panelEl === null) return;
      let naturalWidth;
      let naturalHeight;
      if (skipMeasure === true && lastNatural !== null) {
        naturalWidth = lastNatural.w;
        naturalHeight = lastNatural.h;
      } else {
        const rect = panelEl.getBoundingClientRect();
        const computed = window.getComputedStyle(panelEl);
        naturalWidth = Math.round(parseFloat(computed.width) || rect.width) || rect.width;
        naturalHeight = Math.round(parseFloat(computed.height) || rect.height) || rect.height;
        lastNatural = { w: naturalWidth, h: naturalHeight };
      }

      // 接管标记：只要被接管就常驻（窗口规则的样式都挂在这个属性下，
      // 它不随「正常/拖动」的模式变化而摘除）。
      if (panelEl.getAttribute(ATTR_WIN) !== "1") panelEl.setAttribute(ATTR_WIN, "1");

      // ---- 位置与尺寸
      let box = null;
      if (mode === MODE_DRAGGED) {
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
        if (panelEl.style.position !== "fixed") panelEl.style.position = "fixed";
        if (panelEl.style.margin !== "0") panelEl.style.margin = "0";
        panelEl.style.left = box.x + "px";
        panelEl.style.top = box.y + "px";
        if (panelEl.style.width !== "") panelEl.style.width = "";
        if (panelEl.style.height !== "") panelEl.style.height = "";
        if (panelEl.style.maxWidth !== "") panelEl.style.maxWidth = "";
      }

      // ---- 诊断
      if (diag !== null) {
        diag.window = {
          mode: mode,
          x: box === null ? null : box.x,
          y: box === null ? null : box.y,
          w: box === null ? naturalWidth : box.w,
          h: box === null ? naturalHeight : box.h,
          open: true,
          // 接管成功时为空串；否则写清卡在哪一步（no-title / error:...）
          reason: lastAdoptNote,
          // 这次是用哪条路径定位的（grid-area 为主；close-row / modal-autofocus 为老版本兜底）
          compat: {
            titleBy: compat.titleBy,
            headerBy: compat.headerBy,
            fallbacks: compat.fallbacks.slice(),
          },
        };
      }
    }

    // ------------------------------------------------------------- 关闭
    /**
     * 关闭：完全交给官方 header 里那个 × 图标按钮。
     *
     * 这里留一段说明，记着为什么关闭必须复用官方按钮：
     * 官方设置弹窗的关闭处理器只挂在两处（见 dsh-client-ui-settings-general 的
     * SettingsPanel）——遮罩 div.mask[aria-hidden="true"] 的 onClick，以及 header 里
     * 那个 button.close。overlay 本身没有任何 React 处理器，往 overlay 上派发 click
     * 是打空的，这正是旧版「面板被藏掉、页面残留一层黑色遮罩」的原因。
     *
     * 关闭由用户直接点官方 ×，走宿主自己的路径，面板和遮罩会一起清理。
     */

    // ------------------------------------------------------------------ 拖动
    function flushDrag() {
      dragRaf = 0;
      if (drag === null || dragPending === null || panelEl === null) return;
      const dx = dragPending.dx;
      const dy = dragPending.dy;
      dragPending = null;
      // 拖动期间只写 transform：由合成器处理，不触发布局。
      // 子节点跟着面板一起移动，不需要额外修正位移。
      //
      // 这里要把位移**先夹进允许范围**，不能等到松手才夹：
      // 拖动过程只画 transform，而落位写的是 left/top。若拖过了边界，
      // 松手那一刻「transform 表达的越界位置」会被丢弃、换成夹过的 left/top，
      // 面板就在收手瞬间往回弹一段 —— 这就是停靠时的跳帧。
      // 提前夹好，拖到边界就停住，落位与拖动所见完全一致，收手不动。
      //
      // 夹取参数必须和松手时用的完全一致（见 onDragPointerUp 的兜底分支）：
      // 都传 0,0，语义是「面板左上角留在视口内」。传真实宽高会得到另一组边界
      // （minX = 80 - w），两边算出不同结果就又会跳。
      const clamped = clampPos(drag.sx + dx, drag.sy + dy, 0, 0);
      const cdx = clamped.x - drag.sx;
      const cdy = clamped.y - drag.sy;
      // 记下这一帧真正画出去的位置：松手时直接落它，保证「所见即所得」，
      // 不再拿原始 dx/dy 重算一次（那样会得到另一个夹取结果，收手就跳）。
      drag.lastX = clamped.x;
      drag.lastY = clamped.y;
      panelEl.style.transform = "translate3d(" + cdx + "px," + cdy + "px,0)";
      // 刻意不在这里写 diag：diag 每帧一变会让诊断上报每 1.5s 白报一次，
      // 而那些上报也要序列化 DOM 快照。拖动位移只在松手时记一次。
    }

    function clearDragTransform() {
      if (panelEl !== null && panelEl.style.transform !== "") panelEl.style.transform = "";
    }

    /** 摘掉拖动期间临时挂在 window 上的监听（松手、异常、面板重建时都要走这里）。 */
    function endDragListeners() {
      window.removeEventListener("pointermove", onDragPointerMove, true);
      window.removeEventListener("pointerup", onDragPointerUp, true);
      window.removeEventListener("pointercancel", onDragPointerUp, true);
      if (dragRaf !== 0) {
        window.cancelAnimationFrame(dragRaf);
        dragRaf = 0;
      }
      dragPending = null;
      drag = null;
      if (document.body.classList.contains("dsr-win-dragging")) document.body.classList.remove("dsr-win-dragging");
      // 注意：这里刻意**不**摘 ATTR_DRAGGING。松手那一刻面板还要换位置，
      // 摘标记必须挪到位置落定之后（见 settleDragging），否则会闪。
    }

    function cancelSettle() {
      if (settleRaf !== 0) {
        window.cancelAnimationFrame(settleRaf);
        settleRaf = 0;
      }
    }

    /**
     * 松手后回收拖动期的图层提示 —— 但**不是立刻**。
     *
     * 材质（模糊、背景色、描边、投影）在拖动全程与常驻态完全一致，所以这里
     * 这里要收的只有 will-change:transform 这一个提示。
     * 即便如此也不和落位挤同一帧：pointerup 那一帧已经在做
     *   1) applyWindow() 写 left/top（面板从 transform 表达换回布局位置）
     *   2) clearDragTransform() 清空 transform（图层又一次失效）
     * 两件重活。若再同时撤 will-change，合成器还得把图层重新降级、重新光栅化，
     * 三件事抢一帧仍会掉帧。第一帧只落位置，下一帧再撤提示。
     */
    function settleDragging() {
      cancelSettle();
      settleRaf = window.requestAnimationFrame(function () {
        settleRaf = window.requestAnimationFrame(function () {
          settleRaf = 0;
          clearDraggingAttr();
        });
      });
    }

    /**
     * 拖动期图层提示的开关。
     *
     * 只加 will-change:transform，**不改任何视觉属性**：
     * 面板材质完全沿用宿主提供的普通样式，拖动前后不会有任何视觉跳变。
     */

    /** 拖动期标记的开关：置上时只加 will-change:transform，不摘任何材质。 */
    function markDraggingAttr() {
      if (panelEl !== null && panelEl.getAttribute(ATTR_DRAGGING) !== "1") panelEl.setAttribute(ATTR_DRAGGING, "1");
    }

    function clearDraggingAttr() {
      if (panelEl !== null && panelEl.hasAttribute(ATTR_DRAGGING)) panelEl.removeAttribute(ATTR_DRAGGING);
    }

    function onDragPointerDown(event) {
      if (event.button !== 0) return;
      if (panelEl === null) return;
      // 任意位置拖动：按在交互元素上时不接管（否则点按钮会变成拖窗口）。
      if (event.target instanceof Element && isInteractive(event.target)) return;
      // 这里刻意不 preventDefault：面板里还有导航、输入框、可选中文字，
      // 在按下阶段就吞掉默认行为会连点击与选中一起废掉。
      // 真正开始拖（移动超过阈值）时才在 pointermove 里 preventDefault。
      //
      // 上一次松手排的「撤 will-change」回调还没跑就又按下：先撤掉。
      // 否则它会在这一轮拖动中间把图层提示撤掉、又立刻被重新置上，白折腾一次。
      cancelSettle();
      // 量一次面板当前位置：normal 态还没有 left/top，只能从 rect 取起点。
      const rect = roundRect(panelEl.getBoundingClientRect());
      // 顺手把这次量到的尺寸记成「自然尺寸」，松手落位那一帧直接用它，
      // 就不必再 getComputedStyle 一次（那是强制同步布局）。
      lastNatural = { w: rect.w, h: rect.h };
      const p = mode === MODE_DRAGGED ? { x: posX, y: posY } : rect;
      drag = {
        x0: event.clientX,
        y0: event.clientY,
        sx: p.x,
        sy: p.y,
        active: false,
        pointerId: event.pointerId,
      };
      dragPending = null;
      // 这里刻意不做 setPointerCapture：一旦捕获，后续 click 会被重定向到捕获元素，
      // 面板里那些「不是 button 但能点」的东西（列表行、label 之外的容器）会点不动。
      // 等移动真的超过阈值、确认这是拖而不是点，再在 pointermove 里捕获。
      window.addEventListener("pointermove", onDragPointerMove, true);
      window.addEventListener("pointerup", onDragPointerUp, true);
      window.addEventListener("pointercancel", onDragPointerUp, true);
    }

    function onDragPointerMove(event) {
      if (drag === null) return;
      const dx = event.clientX - drag.x0;
      const dy = event.clientY - drag.y0;
      if (drag.active !== true) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        drag.active = true;
        document.body.classList.add("dsr-win-dragging");
        // 拖动期间只加 will-change:transform 这个图层提示，材质一个像素都不动。
        // 松手后由 settleDragging() 在下一帧摘掉（不与落位抢同一帧）。
        markDraggingAttr();
        // 确认是拖动之后才捕获：鼠标滑出面板范围也继续跟手，
        // 而且此时点击已经不会被误伤（这次按下本来就不是点）。
        try {
          if (panelEl !== null) panelEl.setPointerCapture(drag.pointerId);
        } catch (err) {
          // 某些环境不支持指针捕获，退化成普通监听即可
        }
      }
      event.preventDefault();
      dragPending = { dx: dx, dy: dy };
      if (dragRaf === 0) dragRaf = window.requestAnimationFrame(flushDrag);
    }

    function onDragPointerUp(event) {
      // 先记下本次是否真的拖起来了，endDragListeners 会把 drag 清成 null
      const live = drag;
      const moved = live !== null && live.active === true;
      const startX = live !== null ? live.sx : 0;
      const startY = live !== null ? live.sy : 0;
      const fromX = live !== null ? live.x0 : 0;
      const fromY = live !== null ? live.y0 : 0;
      // 最后一帧真正画出去的位置（flushDrag 夹好边界后记下的）。
      // 有它就照着落位：拖动时看到的和松手后得到的完全一致，收手不跳。
      const paintedX = live !== null && typeof live.lastX === "number" ? live.lastX : null;
      const paintedY = live !== null && typeof live.lastY === "number" ? live.lastY : null;
      try {
        // 捕获挂在面板上：鼠标滑出面板范围甚至滑出窗口也继续跟手
        const target = panelEl;
        if (target !== null && target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      } catch (err) {
        // 忽略
      }
      endDragListeners();
      // 没超过阈值 = 只是点了一下，不算拖动，什么都不用落盘
      if (moved !== true) return;

      if (paintedX !== null && paintedY !== null) {
        posX = paintedX;
        posY = paintedY;
      } else {
        // 没有中间帧（按下后立刻松手、位移已过阈值但 rAF 还没跑）时兜底现算
        const dx = event.clientX - fromX;
        const dy = event.clientY - fromY;
        const clamped = clampPos(startX + dx, startY + dy, 0, 0);
        posX = clamped.x;
        posY = clamped.y;
      }
      // 顺序很关键：先把 transform 清掉再写 left/top 会闪一帧；
      // 这里反过来——先落 left/top，再在同一任务里清 transform。
      if (mode !== MODE_DRAGGED) mode = MODE_DRAGGED;
      // skipMeasure：位置马上要变成新的 left/top，这一帧别再插一次强制同步布局，
      // 用拖动开始时量到的尺寸（拖动过程不改面板尺寸，这个值是准的）。
      applyWindow(true);
      clearDragTransform();
      // 位置已经落定，下一帧再撤 will-change（跨两帧，别和这一帧的重排抢）。
      settleDragging();
      saveState();
    }

    // -------------------------------------------------------- 面板的发现与接管
    function cleanupPanel() {
      clearDragTransform();
      // 拖动中的话先把 window 上的临时监听摘掉，否则面板换了一个、旧监听还在跟手
      endDragListeners();
      // 上一轮松手排的「撤 will-change」回调要撤掉：面板已经是别人的了，
      // 它跑起来会去摘一个已不存在的标记。
      cancelSettle();
      releasePanelDrag();
      if (panelEl !== null) {
        panelEl.removeAttribute(ATTR_WIN);
        panelEl.removeAttribute(ATTR_DRAGGING);
        // 注意：不能摘 data-shortcut-modal —— 那是官方自己的标记，
        // 摘掉之后 tick() 里的 querySelector(PANEL_SEL) 就再也找不到这个面板，
        // 模块会误判成「面板已关闭」而永久退出接管。
        if (panelEl.style !== undefined) {
          for (const prop of ["position", "left", "top", "right", "bottom", "width", "height", "max-width", "margin", "transform"]) {
            panelEl.style.removeProperty(prop);
          }
          if ((panelEl.getAttribute("style") || "").trim().length === 0) panelEl.removeAttribute("style");
        }
      }
      if (document.body.classList.contains("dsr-win-dragging")) document.body.classList.remove("dsr-win-dragging");
      panelEl = null;
      overlayEl = null;
      titleEl = null;
      headerEl = null;
      drag = null;
      lastNatural = null;
      compat.titleBy = null;
      compat.headerBy = null;
      compat.fallbacks = [];
    }

    /**
     * 接管失败的现场快照，写进 diag.window.reason —— 用户一眼能看出卡在哪一步：
     *   no-panel        页面里根本没有 [data-shortcut-modal="settings"]
     *   no-title        有面板，但 grid-area 与结构特征两条路径都没找到标题区
     *   error:<detail>  上面某一步抛了异常（例如样式系统还没就绪）
     */
    let lastAdoptNote = "";

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

      const spot = locateTitleAndHeader(panel);
      titleEl = spot.title;
      headerEl = spot.header;
      compat.titleBy = spot.titleBy;
      compat.headerBy = spot.headerBy;
      if (titleEl === null) {
        // 两条路径都没找到标题区就放弃接管——没有标题栏的窗口拖不动，
        // 留着只会让用户困惑。原因写进 diag.window.reason 便于真机排查。
        lastAdoptNote = "no-title";
        cleanupPanel();
        return;
      }
      titleEl.setAttribute(ATTR_TITLE, "1");
      // 标题栏只需打标，样式表据此保持在拖动抓手之上
      if (headerEl !== null) headerEl.setAttribute(ATTR_HEADER, "1");

      ensurePanelDrag();
      applyWindow();
    }

    /**
     * 定位标题区与按钮行 —— 这是本插件唯一真正的跨版本破坏点，所以做两级探测。
     *
     * 一级：grid-area。0.2.2-alpha.2 起官方把设置面板改成 CSS grid，
     *   模板形如 "VOzbGW_title VOzbGW_header"，前缀是构建哈希、每次发版都会变，
     *   所以只按子串认：以 title / header 结尾的那一格就是我们要的。
     *
     * 二级：结构特征。0.2.1 及更早官方是 flex 布局，grid-area 全为空，
     *   一级必然落空。此时改用「官方 × 按钮所在的那一行」当按钮行，
     *   用官方自己挂的 data-modal-autofocus / aria-labelledby / navTitle 类名找标题文字。
     *   这套特征两代都成立（官方 × 一直是 button.close，标题一直是 navTitle）。
     */
    function locateTitleAndHeader(panel) {
      const found = { title: null, header: null, titleBy: null, headerBy: null };

      // ---- 一级：grid-area
      const descendants = panel.querySelectorAll("*");
      for (const node of descendants) {
        if (node.closest(TITLE_SEL) !== null) continue;
        const area = (window.getComputedStyle(node).gridArea || "").trim();
        const cells = area.length === 0 || area === "auto" ? [] : area.split(/\s+/);
        for (const cell of cells) {
          if (found.title === null && /title$/i.test(cell)) {
            found.title = node;
            found.titleBy = "grid-area";
          } else if (found.header === null && /header$/i.test(cell)) {
            found.header = node;
            found.headerBy = "grid-area";
          }
        }
        if (found.title !== null && found.header !== null) break;
      }

      // ---- 二级：结构特征（flex 布局的老版本）
      if (found.header === null) {
        const closeBtn = panel.querySelector('button[class*="close" i]');
        const row = closeBtn !== null ? closeBtn.parentElement : null;
        if (row !== null && row !== panel) {
          found.header = row;
          found.headerBy = "close-row";
          compat.fallbacks.push("header:close-row");
        }
      }
      if (found.title === null) {
        // ① 官方在标题文字上挂 data-modal-autofocus（导航栏当前项也挂，
        //    但标题永远是文档序第一个，所以取第一个即可）。
        let node = panel.querySelector("[data-modal-autofocus]");
        if (node !== null) {
          found.titleBy = "modal-autofocus";
        } else {
          // ② aria-labelledby 指向标题节点的 id
          const labelled = panel.getAttribute("aria-labelledby");
          if (labelled !== null && labelled.length > 0) {
            node = document.getElementById(labelled);
            if (node !== null && !panel.contains(node)) node = null;
            if (node !== null) found.titleBy = "aria-labelledby";
          }
        }
        if (node === null) {
          // ③ 最后兜底：官方类名里的 navTitle（哈希前缀，所以按子串）
          node = panel.querySelector('[class*="navTitle" i]');
          if (node !== null) found.titleBy = "navTitle-class";
        }
        if (node !== null) {
          found.title = node;
          compat.fallbacks.push("title:" + found.titleBy);
        }
      }
      return found;
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
        lastAdoptNote = "no-panel";
        if (diag !== null) diag.window = { mode: mode, open: false, reason: lastAdoptNote };
        return;
      }
      if (panel !== panelEl || !panel.isConnected) {
        try {
          adopt(panel);
        } catch (err) {
          // 任何异常都不能让模块整体哑掉：记进 diag，保持官方弹窗原样
          lastAdoptNote = "error:" + String(err && err.message ? err.message : err);
          if (api !== null && typeof api.pushError === "function") api.pushError("window: adopt 失败 " + String(err && err.message ? err.message : err));
        }
        if (panelEl === null) {
          if (diag !== null) diag.window = { mode: mode, open: true, reason: lastAdoptNote };
          return;
        }
        lastAdoptNote = "";
      }
      // 正在拖动时不做「重新对齐」：位置此刻由 transform 表达，
      // 而 applyWindow 里的 getBoundingClientRect + getComputedStyle 会强制同步布局，
      // 每帧一次就是拖动卡顿的第二大来源。松手后 applyWindow 会补上最终落位。
      if (drag !== null) return;
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
      startWatchFallback();
      if (typeof MutationObserver !== "function") return;
      observer = new MutationObserver(function (records) {
        // 只关心「和设置面板有关的结构变化」。
        //
        // 原来这里是「document.body 下任何一次 childList 变化都排一次 tick」，
        // 而 DSH 会话区是流式输出的：token 一多，每秒能产生几十次 childList，
        // 每次都换来一次 querySelector + applyWindow（后者带 getBoundingClientRect
        // 与 getComputedStyle，是强制同步布局）。设置窗口开着的时候拖动就卡在这里。
        //
        // 现在只在这三种情况下排 tick：
        //   1) 还没有接管任何面板 —— 需要靠观察器去发现新挂载的面板；
        //   2) 变化落在面板内部 —— 可能是官方重渲染把我们的子节点冲掉了；
        //   3) 增删的节点里有面板（含整棵子树被替换，即打开/关闭设置）。
        // 其余（会话区流式追加、侧边栏刷新…）一律忽略。
        for (const record of records) {
          if (record.type !== "childList") continue;
          if (panelEl === null) {
            schedule();
            return;
          }
          const target = record.target;
          if (target instanceof Node && (target === panelEl || panelEl.contains(target) || target.contains(panelEl))) {
            schedule();
            return;
          }
          for (const node of record.addedNodes) {
            if (node instanceof Element && (node === panelEl || panelEl.contains(node) || node.contains(panelEl) || node.querySelector(PANEL_SEL) !== null)) {
              schedule();
              return;
            }
          }
          for (const node of record.removedNodes) {
            if (node instanceof Element && (node === panelEl || node.contains(panelEl) || node.querySelector(PANEL_SEL) !== null)) {
              schedule();
              return;
            }
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }

    /**
     * 观察器之外的第二条发现路径：官方设置弹窗一挂载就派发 window 事件，
     * 我们顺带听着。观察器负责通用兜底，这里保证「打开设置」这个动作本身零延迟。
     */
    const MOUNT_EVENT = "dsh-settings-mount";

    function onMountEvent() {
      schedule();
    }

    function startWatchFallback() {
      window.addEventListener(MOUNT_EVENT, onMountEvent);
      window.addEventListener("resize", onResize);
      schedule();
    }

    function onResize() {
      // 拖动中改窗口大小没有意义，而且 applyWindow 会强制同步布局，直接跳过
      if (panelEl === null || drag !== null) return;
      applyWindow();
    }

    function stopWatch() {
      if (observer !== null) {
        observer.disconnect();
        observer = null;
      }
      window.removeEventListener(MOUNT_EVENT, onMountEvent);
      window.removeEventListener("resize", onResize);
      if (scheduleId !== 0) {
        window.cancelAnimationFrame(scheduleId);
        scheduleId = 0;
      }
    }

    // ---------------------------------------------------------------- 生命周期
    function dispose() {
      stopWatch();
      cancelSettle();
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
      loadState();
      installStyles();
      // 上一次挂载（宿主的 HMR 重新执行 bundle）留下的 DOM 由这里收走，
      // 否则会出现重复的标题栏控件。
      // 注意：这里不能 return —— 安装完必须 startWatch()，否则模块装载成功却永不接管。
      try {
        const previous = document[CLEANUP_KEY];
        document[CLEANUP_KEY] = dispose;
        if (typeof previous === "function" && previous !== dispose) previous();
        document[CLEANUP_KEY] = dispose;
      } catch (err) {
        pushError("接管旧实例失败：" + String(err));
      }
      startWatch();
    }

    /**
     * 开关变化时就地收敛，而不是等下一次重开设置窗口。
     *
     * 为什么必须现在做：开关都挂在「设置窗口本身」上，用户刚在窗口里
     * 开关保存后立即同步到已加载模块，避免用户误以为没有生效。
     * 每条都只做必要的复位，不重建整个面板。
     */
    function onFeaturesChanged(next) {
      if (panelEl === null) return;
      // 拖动：整块面板都能拖，开关只决定「绑不绑 pointerdown」，
      // DOM 不用重建；正在拖的时候关掉要顺手把这次拖动收干净。
      if (drag !== null) {
        try {
          if (panelEl.hasPointerCapture(drag.pointerId)) panelEl.releasePointerCapture(drag.pointerId);
        } catch (err) {
          // 忽略：没有捕获或已释放
        }
        endDragListeners();
        clearDragTransform();
      }
      ensurePanelDrag();
    }

    exports.install = install;
    exports.dispose = dispose;
    exports.onFeaturesChanged = onFeaturesChanged;
    /** 供内核诊断读：当前窗口状态快照 */
    exports.state = function () {
      return { mode: mode, x: posX, y: posY, attached: panelEl !== null };
    };
    return module.exports;
  },
});
