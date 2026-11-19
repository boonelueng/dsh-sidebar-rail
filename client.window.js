/**
 * 可选模块：设置窗口化。
 *
 * 给 DSH 官方的设置弹窗补上桌面窗口的行为：
 *   - 按住面板任意位置都能拖动整个窗口（按钮、输入框等交互元素除外）；
 *   - 右上角两个圆点：绿=最大化、黄=最小化；
 *   - 最大化 = 铺满侧边栏右侧的会话区，再点一次还原；
 *   - 最小化 = 收成一条停在弹出位置的标题栏，点它还原；
 *   - 关闭 = 官方 header 那个 × 按钮（只把外观换成红圆点，行为完全不动）。
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

    /**
     * 读一个功能开关。
     *
     * 四个功能（红绿灯 / 标题栏拖动 / 点标题条还原 / 最大化铺满）各自独立开关，
     * 都在 DSH 设置页「侧边栏条目」里。拿不到内核状态时一律当「开」：
     * 内核没暴露开关（老版本内核）或读取抛错时，宁可保持旧行为，也不要突然少功能。
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
    const ATTR_GRIP = "data-dsh-rail-win-grip";
    const ATTR_LIGHTS = "data-dsh-rail-win-lights";
    const ATTR_HEADER = "data-dsh-rail-win-header";
    /**
     * 打在官方 header 那个 × 按钮上的标记。
     * 有了它，样式表把官方 × 的图标换成一颗红圆点——按钮本身、它的事件、
     * 它走的关闭路径全部不动，只换「看起来是什么」。
     */
    const ATTR_CLOSE = "data-dsh-rail-win-close";
    /**
     * 拖动开关的 DOM 投影。开着时面板任意位置都能按住拖走，
     * 所以整块面板的 cursor 要变成 grab；关掉时摘掉这个属性，
     * 光标立刻退回常态，不会出现「看起来能拖其实拖不动」。
     */
    const ATTR_DRAG = "data-dsh-rail-win-drag";
    /** 拖动进行中的标记。挂上时样式表会摘掉面板的 backdrop-filter：
        拖着 translate3d 跑的时候，模糊层每一帧都要按新的位置重算背后内容，
        这是拖起来发涩、掉帧的主因。松手立刻摘掉，玻璃质感原样回来。 */
    const ATTR_DRAGGING = "data-dsh-rail-win-dragging";
    const STORAGE_WIN = "dsh-sidebar-rail.win.v1";
    const PANEL_SEL = '[data-shortcut-modal="settings"]';
    const TITLE_SEL = '[data-dsh-rail-win-title="1"]';
    const CLEANUP_KEY = "__dshRailWindow";

    const DRAG_THRESHOLD = 3;
    const VIEWPORT_GAP = 8;

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
      "[data-dsh-rail-win-lights]",
      "[data-dsh-rail-win-close]",
    ].join(",");

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
    let closeDotEl = null;
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
    // 松手后延迟恢复玻璃质感的 rAF 句柄（见 settleDragging 的说明）
    let settleRaf = 0;
    // 上一次量到的面板自然尺寸。落位那一帧要用它跳过 getComputedStyle，
    // 少一次强制同步布局 —— 详见 applyWindow 的 skipMeasure 参数。
    let lastNatural = null;

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

      /* 标题栏覆盖层：最小化后整块面板只剩一条，点这条（不拖动）就还原。
         它自己不放任何文字，所以不会和官方的「设置」标题打架；
         拖动已经提升到整块面板（见 [data-dsh-rail-win-drag]），不再依赖这一层。 */
      "[data-dsh-rail-win] > [data-dsh-rail-win-grip]{",
      "position:absolute;left:0;right:0;top:0;height:54px;",
      "display:flex!important;align-items:center!important;justify-content:flex-end!important;",
      "padding-right:104px;box-sizing:border-box;",
      "touch-action:none;-webkit-user-drag:none;user-select:none;",
      "z-index:0;",
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

      /* 官方 header 行抬到抓手之上：抓手是覆盖整条标题栏的绝对定位层（z-index:0），
         红绿灯现在住在 header 里，若不抬高就会被抓手盖住、点不到。 */
      "[data-dsh-rail-win] > [data-dsh-rail-win-header]{",
      "position:relative;z-index:2;",
      "}",

      /* 窗口控制圆点：住在官方 header 行里、官方 × 的左边，由 header 的 flex 排版，
         所以这里只留静态流内样式——不绝对定位到面板右上角，
         否则会和官方那行「打开配置文件」+ × 叠在一起。
         只有两个点：最小化（黄）在最右、最大化（绿）在左；关闭交给官方自己的 × 按钮，
         所以不再造第三个红点。
         纵向对齐：header 是 display:flex + align-items:flex-start，官方 × 有 28px 高，
         它的垂直中心落在 20px(padding-top) + 14px 处，正好等于标题行
         （22px padding-top + 24px 行高）的垂直中线。我们只有 12px 的圆点，
         贴 flex-start 会比这条中线高出 8px，所以用 margin-top 补回来，
         才能和左侧「设置」二字处在同一条水平线上。 */
      "[data-dsh-rail-win-lights]{",
      "position:static;margin-left:auto;margin-top:8px;align-self:flex-start;",
      "display:flex!important;align-items:center!important;gap:8px!important;",
      "z-index:auto;",
      "}",
      "[data-dsh-rail-win-lights] .dsr-light{",
      "width:12px;height:12px;border-radius:50%;border:none;padding:0;margin:0;",
      "cursor:pointer;flex:none;position:relative;",
      "box-shadow:inset 0 0 0 .5px rgba(0,0,0,.14);",
      "transition:filter .12s ease;",
      "}",
      "@media (hover:hover){[data-dsh-rail-win-lights] .dsr-light:hover{filter:brightness(1.12)}}",
      "[data-dsh-rail-win-lights] .dsr-light:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:2px}",
      "[data-dsh-rail-win-lights] .dsr-light-min{background:#febc2e}",
      "[data-dsh-rail-win-lights] .dsr-light-max{background:#28c840}",

      /* 官方 × 按钮换皮成红圆点：**只换 logo，功能一点不动**。
         按钮还是官方那个 <button>，onClose 还是 React 自己挂的处理器，
         点击路径、键盘可达、aria 名字全部原样保留。
         这里只做三件事：
           1) 把 28px 的方形按钮压成 12px 的圆、填成和另两颗同一档的红；
           2) 藏掉里面的 × 图标（和可能的隐藏文字），露出纯色圆；
           3) 用 ::after 撑回 28px 的点击热区——视觉变小不等于点不着。
         纵向同样要 margin-top:8px：原生 28px 时中心落在 20+14=34px，
         压成 12px 后中心是 20+6=26px，差 8px，补回来才和另两颗圆点、
         以及左侧「设置」二字落在同一条水平线上。 */
      "[data-dsh-rail-win-close]{",
      "width:12px!important;height:12px!important;min-width:0!important;",
      "border-radius:50%!important;background:#ff5f57!important;",
      "box-shadow:inset 0 0 0 .5px rgba(0,0,0,.14)!important;",
      "margin-top:8px!important;margin-left:0!important;margin-right:0!important;",
      "position:relative;align-self:flex-start;padding:0!important;",
      "flex:none!important;",
      "}",
      "[data-dsh-rail-win-close] > *{display:none!important}",
      /* 12px 的圆点对鼠标来说太小了：用一个不可见的伪元素把热区撑到 28px。
         伪元素是按钮自己的子级，点击仍然命中按钮本身。 */
      "[data-dsh-rail-win-close]::after{",
      "content:\"\";position:absolute;inset:-8px;border-radius:50%;",
      "}",
      "[data-dsh-rail-win-close]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:2px}",

      /* 最小化：收成一条停在本位的标题栏，点击任意处还原。 */
      "[data-dsh-rail-win][data-dsh-rail-win-min=\"1\"]{",
      "width:var(--dsr-win-min-w,240px)!important;max-width:none!important;",
      "height:54px!important;min-height:0!important;",
      "grid-template:\"t h\"!important;grid-template-columns:minmax(0,1fr) auto!important;",
      "overflow:hidden!important;",
      "}",
      "[data-dsh-rail-win][data-dsh-rail-win-min=\"1\"] > :not([data-dsh-rail-win-title]):not([data-dsh-rail-win-grip]):not([data-dsh-rail-win-lights]):not([data-dsh-rail-win-header]){",
      "display:none!important;",
      "}",
      /* 最小化时红绿灯住在 header 里，header 必须留着；但 header 自己那几个官方按钮
         （「打开配置文件」+ ×）在收成一条的状态下没有意义，只留红绿灯。 */
      "[data-dsh-rail-win][data-dsh-rail-win-min=\"1\"] > [data-dsh-rail-win-header]{",
      "display:flex!important;align-items:center!important;height:100%!important;padding:0 10px 0 0!important;",
      "}",
      "[data-dsh-rail-win][data-dsh-rail-win-min=\"1\"] > [data-dsh-rail-win-header] > :not([data-dsh-rail-win-lights]){",
      "display:none!important;",
      "}",
      "[data-dsh-rail-win][data-dsh-rail-win-min=\"1\"] [data-dsh-rail-win-title]{cursor:pointer}",

      /* 最大化：铺满侧边栏右侧的会话区，用圆角做一点桌面窗口的观感。 */
      "[data-dsh-rail-win][data-dsh-rail-win-max=\"1\"]{",
      "position:fixed!important;",
      "border-radius:var(--dsw-radius-panel,12px)!important;",
      "}",

      /* ---- 液态玻璃：把设置面板改成毛玻璃质感 ----
         面板背景从官方的不透明 layer-2 改成半透明（约 66% 不透明），
         再叠 backdrop-filter 的 blur + saturate：blur 把背后主界面揉成雾面、
         saturate 提升透出颜色的饱和度，这是液态玻璃区别于普通毛玻璃的关键。
         顶部一条白色高光 + 一圈 1px 内描边模拟玻璃棱角的反光；
         保留官方 elevation 投影，让面板仍「浮」在遮罩之上。
         半透明比例取偏保守的 66%，保证文字对比度不因透色而跌穿 4.5:1。 */
      "[data-dsh-rail-win]{",
      "backdrop-filter:blur(22px) saturate(170%)!important;",
      "-webkit-backdrop-filter:blur(22px) saturate(170%)!important;",
      "background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#1b1b20) 66%, transparent)!important;",
      "box-shadow:inset 0 1px 0 rgba(255,255,255,.16),inset 0 0 0 1px rgba(255,255,255,.10),var(--dsw-elevation-prominent)!important;",
      "}",
      /* 尊重系统「减少透明」偏好：回退为不透明背景，避免文字糊在透出的内容上 */
      "@media (prefers-reduced-transparency: reduce){",
      "[data-dsh-rail-win]{",
      "backdrop-filter:none!important;-webkit-backdrop-filter:none!important;",
      "background:var(--dsw-alias-bg-layer-2)!important;",
      "box-shadow:var(--dsw-elevation-prominent)!important;",
      "}",
      "}",

      /* ---- 拖动期降级（关键性能修复）----
         拖动只写 transform，本该由合成器直接搬运；但面板开着 backdrop-filter 时，
         合成器必须按「新的位置」重新采样背后内容再做模糊，等于每帧一次全屏重算，
         真实机器上表现为明显卡顿。这里在拖动的整个过程中把模糊摘掉，
         松手之后再把玻璃质感还回来。
         **只摘 blur，不改 background**：背景色保持和常驻态一模一样（同一条
         color-mix 半透明），这样松手恢复时只有「模糊」这一件事在变，
         不会再多出一次「底色从实心跳回半透明」的闪烁。 */
      "[data-dsh-rail-win][data-dsh-rail-win-dragging=\"1\"]{",
      "backdrop-filter:none!important;-webkit-backdrop-filter:none!important;",
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

    /*
     * 三个动作（关闭 / 最小化 / 最大化）直接用 pointerdown 触发。
     *
     * 为什么不用 click：官方弹窗会用 useModalLayer 在 document 上挂捕获阶段的指针监听
     * （点面板外就关闭），我们这批按钮是挂进官方面板的外来节点，pointerdown 阶段
     * 一旦被它判定成「从外面开始按」，click 可能根本走不完。
     * 自己认 pointerdown，再用一次性的 pointerup/pointercancel 兜底，就不用依赖 click 的存活。
     */
    function bindLightAction(node, run) {
      const onDown = function (event) {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        // 按下即生效：这些动作都是幂等的界面操作，重复点一次也只是再多切一次
        run();
        node.removeEventListener("pointerup", onUp);
        node.removeEventListener("pointercancel", onUp);
      };
      const onUp = function () { /* 兜底占位：动作已在 pointerdown 完成 */ };
      node.addEventListener("pointerdown", onDown);
      node.addEventListener("pointerup", onUp);
      node.addEventListener("pointercancel", onUp);
      // 键盘可达性：Enter/Space 也要能触发
      node.addEventListener("keydown", function (event) {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        run();
      });
    }

    // ------------------------------------------------------------------ 渲染

    /**
     * 圆点的可用性跟着对应的功能开关走。
     *
     * 黄点没有还原路径时是个单向门：窗口收成一条之后就再也点不开了
     * （设置页本身就在这个窗口里，用户没法进来把开关改回去）。
     * 所以还原关掉时干脆不让最小化，而不是留一个进去出不来的坑。
     * 绿点同理：最大化关掉时把它标成禁用，比留一个点了没反应的按钮诚实。
     */
    function syncDots() {
      if (lightsEl === null) return;
      const minDot = lightsEl.querySelector(".dsr-light-min");
      if (minDot !== null) {
        if (featureOn("restore")) {
          minDot.removeAttribute("aria-disabled");
          minDot.removeAttribute("disabled");
          minDot.setAttribute("title", "最小化");
        } else {
          minDot.setAttribute("aria-disabled", "true");
          minDot.setAttribute("disabled", "disabled");
          minDot.setAttribute("title", "最小化（需先开启「点标题条还原」）");
        }
      }
      const maxDot = lightsEl.querySelector(".dsr-light-max");
      if (maxDot !== null) {
        if (featureOn("maximize")) {
          maxDot.removeAttribute("aria-disabled");
          maxDot.removeAttribute("disabled");
          maxDot.setAttribute("title", "最大化 / 还原");
        } else {
          maxDot.setAttribute("aria-disabled", "true");
          maxDot.setAttribute("disabled", "disabled");
          maxDot.setAttribute("title", "最大化（已在设置里关闭）");
        }
      }
    }

    function ensureLights() {
      // 「窗口红绿灯」关掉时这组按钮根本不存在；已经建好的由 onFeaturesChanged 摘掉。
      // 官方 × 那颗红点也属于这一组：关掉就把标记摘掉，让它退回原生外观，
      // 否则会出现「两个圆点没了、× 却还红着」的半残状态。
      if (!featureOn("lights")) {
        if (lightsEl !== null) {
          lightsEl.remove();
          lightsEl = null;
        }
        releaseCloseDot();
        return;
      }
      // 已连在面板上就什么都不用做；脱离（面板被宿主重挂载）就整组重建，
      // 重建后下面会重新挂一遍动作处理。
      if (lightsEl !== null && lightsEl.isConnected) return;
      if (lightsEl === null) lightsEl = el("div", {
        "data-dsh-rail-win-lights": "1",
        role: "group",
        "aria-label": "窗口控制",
      }, [
        // 左→右 = 绿（最大化）/ 黄（最小化）/ 红（关闭）。
        // 关闭不再造自己的红点：直接复排官方 header 里那个 × 图标按钮，
        // 位置天然就在这两个圆点的右边，视觉上正好凑成「绿 黄 红」。
        el("button", {
          type: "button",
          className: "dsr-light dsr-light-max",
          "aria-label": "最大化设置",
          title: "最大化 / 还原",
          "data-dsr-light": "max",
        }, null),
        el("button", {
          type: "button",
          className: "dsr-light dsr-light-min",
          "aria-label": "最小化设置",
          title: "最小化",
          "data-dsr-light": "min",
        }, null),
      ]);
      // 圆点统一走 bindLightAction：指针按下即生效，不依赖 click 是否走完
      const dots = lightsEl.querySelectorAll(".dsr-light");
      if (dots.length === 2) {
        bindLightAction(dots[0], toggleMax);
        bindLightAction(dots[1], function () { setMinimized(!minimized); });
      }
      // 挂进官方 header 行，排在官方 × 的左边——由 header 自己的 flex 排版，
      // 不再绝对定位，所以不会和「打开配置文件」+ × 叠在一起。
      //
      // 注意别挂进 header 里那个 actions 容器：它自己带 margin-left:auto，
      // 会把整组顶到最右，而官方 × 在 actions 外面，挂进去反而排到 × 的右边。
      // 官方 × 的 class 带构建哈希（VOzbGW_close），回归台是 stClose，
      // 所以按子串 + 忽略大小写认；认不出就退到 header 里最后一个按钮
      // （× 总是最后一个）。必须排掉圆点自己，别把自己当成官方 ×。
      if (headerEl !== null) {
        let closeBtn = null;
        const buttons = headerEl.querySelectorAll("button");
        for (let i = buttons.length - 1; i >= 0; i -= 1) {
          const btn = buttons[i];
          if (btn.closest("[data-dsh-rail-win-lights]") !== null) continue;
          if (btn.className && /close/i.test(String(btn.className))) {
            closeBtn = btn;
            break;
          }
          if (closeBtn === null) closeBtn = btn;
        }
        if (closeBtn !== null && closeBtn.parentElement !== null) {
          closeBtn.parentElement.insertBefore(lightsEl, closeBtn);
        } else {
          headerEl.appendChild(lightsEl);
        }
        // 找到官方 × 之后顺手给它换皮（只加标记，不碰事件与结构）。
        // 放在这里而不是 adopt() 里：这是唯一既拿到 headerEl 又拿到 closeBtn 的地方。
        markCloseDot(closeBtn);
      } else {
        panelEl.appendChild(lightsEl);
      }
      syncDots();
    }

    /**
     * 给官方 × 按钮打上「这颗现在是红圆点」的标记。
     * 只是加一个属性——按钮还是那个按钮，React 的 onClose、键盘 Enter/Space、
     * aria-label 一字未动，样式表负责把它压成 12px 的红圆。
     */
    function markCloseDot(btn) {
      if (btn === null || btn === undefined) return;
      if (!featureOn("lights")) return;
      closeDotEl = btn;
      if (btn.getAttribute(ATTR_CLOSE) !== "1") btn.setAttribute(ATTR_CLOSE, "1");
      // 视觉换成纯色圆之后，原来的「关闭」文字/图标都藏了，
      // 无障碍名字必须留着，否则读屏只剩一个没有名字的圆点。
      // 只在自己补的时候记一笔，卸载时才知道该不该摘掉（官方本来有名字就不动它）。
      if (!btn.getAttribute("aria-label") && !btn.getAttribute("title")) {
        if (btn.getAttribute("data-dsr-close-label") !== "1") {
          btn.setAttribute("aria-label", "关闭设置");
          btn.setAttribute("data-dsr-close-label", "1");
        }
      }
    }

    /** 把官方 × 恢复原生外观（关掉 lights 开关、或插件卸载时都要走一遍）。 */
    function releaseCloseDot() {
      if (closeDotEl === null) return;
      const btn = closeDotEl;
      closeDotEl = null;
      if (btn.getAttribute(ATTR_CLOSE) === "1") btn.removeAttribute(ATTR_CLOSE);
      if (btn.getAttribute("data-dsr-close-label") === "1") {
        btn.removeAttribute("data-dsr-close-label");
        btn.removeAttribute("aria-label");
      }
    }

    function ensureGrip() {
      if (gripEl !== null && gripEl.isConnected) return;
      gripEl = el("div", { "data-dsh-rail-win-grip": "1", "aria-hidden": "true" }, null);
      // 抓手只负责两件事：最小化后点它还原、双击切换最大化。
      // 拖动本身不挂在这里了 —— 整块面板任意位置都能拖（见 ensurePanelDrag）。
      gripEl.addEventListener("pointerup", onGripPointerUpRestore);
      gripEl.addEventListener("dblclick", onGripDblClick);
      panelEl.insertBefore(gripEl, panelEl.firstChild);
    }

    /** 最小化后只剩一条标题栏，点它（不拖动）就还原。 */
    function onGripPointerUpRestore(event) {
      if (event.button !== undefined && event.button !== 0) return;
      if (drag !== null && drag.active === true) return;
      if (!featureOn("restore")) return;
      if (minimized === true) setMinimized(false);
    }

    /** 双击标题条：最小化时还原，其余情况切换最大化。 */
    function onGripDblClick(event) {
      event.preventDefault();
      if (!featureOn("restore") && minimized === true) return;
      if (minimized === true) {
        setMinimized(false);
        return;
      }
      toggleMax();
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

      // 接管标记：只要被接管就常驻（红绿灯、抓手、最小化规则的样式都挂在这个属性下，
      // 它不随「正常/拖动/最大化」的模式变化而摘除）。
      if (panelEl.getAttribute(ATTR_WIN) !== "1") panelEl.setAttribute(ATTR_WIN, "1");

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

      // ---- 抓手的纵向位置跟着标题行走
      // 红绿灯已经住进官方 header 行，纵向由那行的 flex 排版决定，不再需要这里写 top。
      // computeTitleBarTop 里要取三次 getBoundingClientRect（又是一次强制同步布局），
      // 落位那一帧跳过它：抓手的高度与 top 早就是 54px / 0，没必要每帧重算。
      if (gripEl !== null) {
        if (skipMeasure !== true) {
          const barTop = computeTitleBarTop();
          const wanted = barTop + "px";
          if (gripEl.dataset.barTop !== wanted) gripEl.dataset.barTop = wanted;
        }
        if (gripEl.style.height !== "54px") gripEl.style.height = "54px";
        if (gripEl.style.top !== "0px") gripEl.style.top = "0px";
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
          open: true,
          // 接管成功时为空串；否则写清卡在哪一步（no-grid / error:...）
          reason: lastAdoptNote,
        };
      }
    }

    // ------------------------------------------------------------- 三个动作
    /**
     * 关闭：现在完全交给官方 header 里那个 × 图标按钮。
     *
     * 这里留一段说明，记着为什么不再自己造一个红点去「点一下关闭」：
     * 官方设置弹窗的关闭处理器只挂在两处（见 dsh-client-ui-settings-general 的
     * SettingsPanel）——遮罩 div.mask[aria-hidden="true"] 的 onClick，以及 header 里
     * 那个 button.close。overlay 本身没有任何 React 处理器，往 overlay 上派发 click
     * 是打空的，这正是旧版「点红灯后页面残留一层黑色遮罩」的原因：面板被
     * visibility:hidden 藏掉了，但 overlay + mask 还在，于是整页被蒙上一层黑。
     *
     * 我们的圆点只负责最大化（绿）与最小化（黄）；关闭由用户直接点官方 ×，
     * 走的是 React 自己的路径，天然不会留下黑层。
     */

    function setMinimized(next) {
      const want = next === true;
      // 「点标题条还原」关掉时不允许最小化：见 syncDots 的说明，那是单向门。
      if (want && !featureOn("restore")) return;
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
      // 「最大化铺满会话区」关掉时绿点整体失效（见 syncDots）
      if (!featureOn("maximize")) return;
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
      // 拖动期间只写 transform：由合成器处理，不触发布局。
      // 抓手与圆点都是面板的子节点，跟着面板一起动，不能再单独写一遍（会位移翻倍）。
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
     * 松手后把玻璃质感还回来 —— 但**不是立刻**。
     *
     * 之前是在 pointerup 里直接摘掉 ATTR_DRAGGING，于是同一帧做了三件互相打架的事：
     *   1) 摘掉标记 → backdrop-filter 恢复、will-change 撤掉 → 合成器要把图层重新光栅化；
     *   2) applyWindow() 写 left/top → 面板换到新位置（从 transform 表达改回布局位置）；
     *   3) clearDragTransform() 清空 transform → 图层又一次失效。
     * 三件事挤在一帧里，浏览器只能拿「新的位置 + 还没算好的背景」先画一帧，
     * 看起来就是落位瞬间闪一下 / 掉一帧。
     *
     * 改成两帧分离：第一帧只负责把位置落定（仍是降级态，没有模糊，合成成本最低），
     * 下一帧再恢复模糊与 will-change。位置动与重光栅化不再抢同一帧。
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

    /** 拖动降级属性的开关：置上时摘掉 backdrop-filter，让合成器能直接搬图层。 */
    function markDraggingAttr() {
      if (panelEl !== null && panelEl.getAttribute(ATTR_DRAGGING) !== "1") panelEl.setAttribute(ATTR_DRAGGING, "1");
    }

    function clearDraggingAttr() {
      if (panelEl !== null && panelEl.hasAttribute(ATTR_DRAGGING)) panelEl.removeAttribute(ATTR_DRAGGING);
    }

    function onDragPointerDown(event) {
      if (event.button !== 0) return;
      if (panelEl === null) return;
      if (minimized === true) return;
      // 圆点自己会 stopPropagation，这里再兜一次
      if (event.target instanceof Element && event.target.closest("[data-dsh-rail-win-lights]") !== null) return;
      // 任意位置拖动：按在交互元素上时不接管（否则点按钮会变成拖窗口）。
      // 圆点组与官方 × 都在下面的选择器里，这里是第二道保险。
      if (event.target instanceof Element && isInteractive(event.target)) return;
      // 这里刻意不 preventDefault：面板里还有导航、输入框、可选中文字，
      // 在按下阶段就吞掉默认行为会连点击与选中一起废掉。
      // 真正开始拖（移动超过阈值）时才在 pointermove 里 preventDefault。
      //
      // 上一次松手排的「恢复玻璃」回调还没跑就又按下：先撤掉。
      // 否则它会在这一轮拖动中间把降级标记摘掉，模糊一回来就得重算，白卡一下。
      cancelSettle();
      // 量一次面板当前位置：normal 态还没有 left/top，只能从 rect 取起点。
      const rect = roundRect(panelEl.getBoundingClientRect());
      // 顺手把这次量到的尺寸记成「自然尺寸」，松手落位那一帧直接用它，
      // 就不必再 getComputedStyle 一次（那是强制同步布局）。
      // 只在 normal/dragged 下记：最大化与最小化量到的不是自然尺寸，记了会污染后续落位。
      if (mode !== MODE_MAX && minimized !== true) lastNatural = { w: rect.w, h: rect.h };
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
        // 拖动期间摘掉面板的 backdrop-filter：模糊层跟着 translate3d 每帧重算背后内容，
        // 是拖起来发涩的主因。松手（endDragListeners）立刻摘掉标记，玻璃质感回来。
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
        const target = panelEl !== null ? panelEl : gripEl;
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
      if (mode !== MODE_MAX) mode = MODE_DRAGGED;
      // skipMeasure：位置马上要变成新的 left/top，这一帧别再插一次强制同步布局，
      // 用拖动开始时量到的尺寸（拖动过程不改面板尺寸，这个值是准的）。
      applyWindow(true);
      clearDragTransform();
      // 位置已经落定，再让玻璃质感回来（跨两帧，别和这一帧的重排抢）。
      settleDragging();
      saveState();
    }

    // -------------------------------------------------------- 面板的发现与接管
    function cleanupPanel() {
      clearDragTransform();
      // 拖动中的话先把 window 上的临时监听摘掉，否则面板换了一个、旧监听还在跟手
      endDragListeners();
      // 上一轮松手排的「恢复玻璃」回调要撤掉：面板已经是别人的了，
      // 它跑起来会去摘一个已不存在的标记。
      cancelSettle();
      releasePanelDrag();
      if (gripEl !== null) {
        gripEl.removeEventListener("pointerup", onGripPointerUpRestore);
        gripEl.removeEventListener("dblclick", onGripDblClick);
        gripEl.remove();
        gripEl = null;
      }
      if (lightsEl !== null) {
        lightsEl.remove();
        lightsEl = null;
      }
      // 官方 × 的换皮也要撤销：面板可能被官方整个销毁重建，
      // 那个按钮已随旧面板消失，这里是最后能清干净的地方。
      releaseCloseDot();
      if (panelEl !== null) {
        panelEl.removeAttribute(ATTR_WIN);
        panelEl.removeAttribute(ATTR_DRAGGING);
        panelEl.removeAttribute("data-dsh-rail-win-min");
        panelEl.removeAttribute("data-dsh-rail-win-max");
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
      if (toggleEl !== null) {
        toggleEl.remove();
        toggleEl = null;
      }
      if (document.body.classList.contains("dsr-win-dragging")) document.body.classList.remove("dsr-win-dragging");
      panelEl = null;
      overlayEl = null;
      titleEl = null;
      headerEl = null;
      drag = null;
      lastNatural = null;
    }

    /**
     * 接管失败的现场快照，写进 diag.window.reason —— 用户一眼能看出卡在哪一步：
     *   no-panel        页面里根本没有 [data-shortcut-modal="settings"]
     *   no-grid         有面板，但没找到 grid-area 以 title 结尾的标题区
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

      // 找标题区与按钮行：靠 grid-area，而不是靠哈希类名
      // 官方模板形如 "VOzbGW_title VOzbGW_header"，前缀是构建哈希、每次发版都会变，
      // 所以按子串认 cell：以 title / header 结尾的那一格就是我们要的。
      const descendants = panel.querySelectorAll("*");
      for (const node of descendants) {
        if (node.closest(TITLE_SEL) !== null) continue;
        const area = (window.getComputedStyle(node).gridArea || "").trim();
        const cells = area.length === 0 || area === "auto" ? [] : area.split(/\s+/);
        for (const cell of cells) {
          if (titleEl === null && /title$/i.test(cell)) titleEl = node;
          else if (headerEl === null && /header$/i.test(cell)) headerEl = node;
        }
        if (titleEl !== null && headerEl !== null) break;
      }
      if (titleEl === null) {
        // 找不到标题区就放弃接管——没有标题栏的窗口拖不动，留着只会让用户困惑
        lastAdoptNote = "no-grid";
        cleanupPanel();
        return;
      }
      titleEl.setAttribute("data-dsh-rail-win-title", "1");
      // 圆点要住进 header 行：先给它打上标记，样式表按这个属性把 header 抬到抓手之上
      if (headerEl !== null) headerEl.setAttribute(ATTR_HEADER, "1");

      ensureGrip();
      ensureLights();
      ensurePanelDrag();
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
        lastAdoptNote = "no-panel";
        if (diag !== null) diag.window = { mode: mode, minimized: minimized === true, open: false, reason: lastAdoptNote };
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
          if (diag !== null) diag.window = { mode: mode, minimized: minimized === true, open: true, reason: lastAdoptNote };
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
      el = api.el;
      loadState();
      installStyles();
      // 上一次挂载（宿主的 HMR 重新执行 bundle）留下的 DOM 由这里收走，
      // 否则会出现两套红绿灯叠在一起。
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
     * 为什么必须现在做：这几个开关都挂在「设置窗口本身」上，用户刚在窗口里
     * 关掉红绿灯，如果还要重开窗口才生效，他会以为没生效而反复点。
     * 每条都只做必要的复位，不重建整个面板。
     */
    function onFeaturesChanged(next) {
      if (panelEl === null) return;
      // 红绿灯：关掉就整组摘掉（连官方 × 那颗红点一起退回原样），开回来就补建
      // （ensureLights 自己会判断，标记也在它里面打）
      if (!featureOn("lights")) {
        if (lightsEl !== null) {
          lightsEl.remove();
          lightsEl = null;
        }
        releaseCloseDot();
      } else {
        ensureLights();
      }
      // 拖动：整块面板都能拖，开关只决定「绑不绑 pointerdown」，
      // DOM 不用重建；正在拖的时候关掉要顺手把这次拖动收干净。
      if (drag !== null) {
        try {
          const target = panelEl !== null ? panelEl : gripEl;
          if (target !== null) target.releasePointerCapture(drag.pointerId);
        } catch (err) {
          // 忽略：没有捕获或已释放
        }
        endDragListeners();
        clearDragTransform();
      }
      ensurePanelDrag();
      // 还原：关掉时不能停在最小化状态，否则窗口就卡在一条里出不来了
      if (!featureOn("restore") && minimized === true) {
        setMinimized(false);
      }
      // 最大化：关掉时若正铺满，退回原来的摆放
      if (!featureOn("maximize") && mode === MODE_MAX) {
        mode = posX === 0 && posY === 0 ? MODE_NORMAL : MODE_DRAGGED;
        saveState();
        applyWindow();
      }
      syncDots();
    }

    exports.install = install;
    exports.dispose = dispose;
    exports.onFeaturesChanged = onFeaturesChanged;
    /** 供内核诊断读：当前窗口状态快照 */
    exports.state = function () {
      return { mode: mode, minimized: minimized === true, x: posX, y: posY, attached: panelEl !== null };
    };
    return module.exports;
  },
});
