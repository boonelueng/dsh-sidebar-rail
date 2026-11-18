// dsh-sidebar-rail / 悬浮模块（可选模块，独立 chunk）
//
// 职责：让整条竖轨脱离侧边栏、浮到视口任意位置并可拖动。
// 边界：不碰并列布局、不碰拖拽排序、不碰设置页。
//
// 故障隔离：
//  - 加载失败 / install 失败 → 内核把这个模块当作「不存在」，轨道少一个悬浮按钮，
//    布局与其它模块照常工作（内核里每一处调用都在 try/catch 内）。
//  - 运行期抛错 → 内核捕获后整体摘掉本模块（detach 清掉抓手与浮层标记），
//    同样只是少一个功能，不会让侧边栏停摆。

window.__ModuleLoader__.load({
  id: "dsh-sidebar-rail",
  chunk: "client.float.js",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    /** 由内核 install() 注入；未注入前所有对外函数安全早退 */
    let api = null;

    // ---- 内核符号的本地绑定（install 之后才有值，避免模块加载期触碰内核状态）
    let diag = null;
    let ATTR_ROOT = "";
    let ATTR_PART = "";
    let ATTR_FLOAT = "";
    let STORAGE_FLOAT = "";

    function el() {
      return api.el.apply(null, arguments);
    }

    /** 只在该变量确实变化时才写：无谓的 setProperty 会让整棵子树重算样式 */
    function setVar(node, name, value) {
      if (node.style.getPropertyValue(name) === value) return false;
      node.style.setProperty(name, value);
      return true;
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
    // 轨道宽度（px）由内核维护，这里只读：applyFloat 夹取与 ghost 定位都要用
    // railWidthPx 通过 api.railWidth() 读取，模块内不持有状态
    /** 悬浮时盯住 nav 高度：面板图标增删会改高度，下面的自定义条目要跟着挪 */
    let floatRO = null;
    let floatROTarget = null;

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
      const w = api.railWidth();
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      const h = floatHeight() || 200;
      const maxX = Math.max(8, vw - w - 8);
      const maxY = Math.max(8, vh - h - 8);
      return { x: Math.min(Math.max(8, x), maxX), y: Math.min(Math.max(8, y), maxY) };
    }

    /**
     * 按下时把「允许的位移范围」算一次。
     *
     * 拖动中 applyFloat 是早退的（位置由 transform 独占，不能每帧重量几何），
     * 所以拖动过程不做夹取；如果只在松手那一刻才夹，用户会看到轨道先跟手
     * 到视口边缘、松手又突然被推回来——这就是「放开鼠标闪一下」的来源。
     * 把夹取提前摊到拖动过程中，松手时坐标已经合法，clampFloat 不再改动它，
     * 视觉上就完全连续。
     */
    function floatDragBounds() {
      const pos = clampFloat(floatX, floatY);
      const w = api.railWidth();
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      const h = floatHeight() || 200;
      const minX = 8;
      const minY = 8;
      const maxX = Math.max(8, vw - w - 8);
      const maxY = Math.max(8, vh - h - 8);
      return {
        minDx: minX - pos.x,
        maxDx: maxX - pos.x,
        minDy: minY - pos.y,
        maxDy: maxY - pos.y,
      };
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
      setVar(root, "--dsr-float-w", api.railWidth() + "px");
      const nav = root.querySelector('[' + ATTR_PART + '="nav"]');
      const navH = nav === null ? 0 : Math.round(nav.getBoundingClientRect().height);
      setVar(root, "--dsr-float-nav-h", navH + "px");
      ensureGrip(root);
      // nav 的高度是自定义条目定位的参照，启动那几拍可能还没长到最终值
      watchFloatNav(root);
      diag.floating = true;
      diag.floatPos = { x: Math.round(floatX), y: Math.round(floatY), w: api.railWidth(), navH: navH };
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
        api.renderRail();
        return;
      }
      // 首次悬浮要换默认落位；必须在 applyFloat 夹取之前判断，
      // 否则夹取会把 (12,120) 改掉，这次判断就永远为假了。
      const firstTime = next === true && floatX === 12 && floatY === 120;
      floating = next;
      // 展开态归内核管：悬浮自动展开、停靠自动收起，setRailExpanded 内部会落盘
      api.setRailExpanded(next);
      // 先把展开态落下来：railWidthPx 要反映展开后的真实宽度，
      // 否则默认落位按 40px 算，随后会被夹取往左推，右侧只剩贴边的 8px。
      if (root !== null) api.applyRailState(root);
      if (firstTime) {
        // 默认丢到视口右侧空白处。不能贴着侧边栏右侧放——悬浮后会话区的
        // 左边距被释放了，贴着放会正好压住会话标题，等于「浮起来反而更差」。
        const vw = window.innerWidth || 0;
        const vh = window.innerHeight || 0;
        floatX = Math.max(8, vw - api.railWidth() - 24);
        floatY = Math.max(24, Math.round(vh * 0.18));
      }
      applyFloat(root);
      // 落位之后再存盘：saveFloat 必须在 applyFloat 夹取、并把默认落位写回
      // floatX/floatY 之后调用，否则存进去的还是 (12,120) 这种初始值，
      // 刷新后浮层停在左上角压着会话区，看起来就是「启动后模块不衔接」。
      saveFloat();
      // 图标/文案/aria 随 floating 与 railExpanded 变，必须重渲染一次轨道
      api.renderRail();
      api.scheduleReport();
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
          setVar(gripEl, "--dsr-float-w", api.railWidth() + "px");
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
      gripEl.style.setProperty("--dsr-float-w", api.railWidth() + "px");
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

    /**
     * 盯住 nav 的高度。
     *
     * 悬浮时整条轨道被拆成「抓取条 / 面板图标 / 自定义条目」三段独立定位，
     * 自定义条目的 top 是靠 --dsr-float-nav-h 算出来的。启动那一刻 nav 往往还没
     * 长到最终高度（DSH 的面板列表是之后才渲染进来的、字体也可能晚一拍），
     * 于是这个变量量到的是偏小的旧值——下面的自定义条目就停在错误的位置，
     * 跟上面的图标段之间裂开一条缝或者压在一起，也就是「模块不衔接」。
     * 所以这里持续观察，高度一变就补写。
     */
    function watchFloatNav(root) {
      if (floatRO !== null && floatROTarget === root) return;
      unwatchFloatNav();
      if (typeof ResizeObserver !== "function") return;
      const nav = root.querySelector('[' + ATTR_PART + '="nav"]');
      if (nav === null) return;
      floatROTarget = root;
      floatRO = new ResizeObserver(function () {
        if (!floating || root.getAttribute(ATTR_FLOAT) !== "1") return;
        // 拖动中位置由 transform 独占，别再插一手让布局跟着跳
        if (floatDrag !== null) return;
        const h = Math.round(nav.getBoundingClientRect().height);
        if (h <= 0) return;
        setVar(root, "--dsr-float-nav-h", h + "px");
        if (diag.floatPos !== null) diag.floatPos.navH = h;
      });
      floatRO.observe(nav);
    }

    function unwatchFloatNav() {
      if (floatRO !== null) {
        try {
          floatRO.disconnect();
        } catch (err) {
          /* 忽略 */
        }
        floatRO = null;
      }
      floatROTarget = null;
    }

    function removeGrip() {
      if (gripEl !== null) {
        gripEl.remove();
        gripEl = null;
      }
      unwatchFloatNav();
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
      floatDrag = { x0: event.clientX, y0: event.clientY, sx: startX, sy: startY, active: false, dx: 0, dy: 0, bounds: null };
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
        // 夹取范围只算一次：拖动过程中视口与轨道尺寸不会变
        floatDrag.bounds = floatDragBounds();
        if (document.body) document.body.classList.add("dsr-float-dragging");
      }
      event.preventDefault();
      const b = floatDrag.bounds;
      const cdx = b === null ? dx : Math.min(Math.max(dx, b.minDx), b.maxDx);
      const cdy = b === null ? dy : Math.min(Math.max(dy, b.minDy), b.maxDy);
      floatDrag.dx = cdx;
      floatDrag.dy = cdy;
      floatPending = { dx: cdx, dy: cdy };
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
      if (!d.active) {
        paintFloatDelta(0, 0);
        return;
      }
      if (document.body) document.body.classList.remove("dsr-float-dragging");
      floatX = d.sx + d.dx;
      floatY = d.sy + d.dy;
      /**
       * 顺序很关键：**先落位、再清 transform**。
       *
       * transform 与 will-change 都由合成器线程处理，一清掉合成器马上就能把
       * 轨道画回 CSS 变量所指的旧位置；而 left/top 这类布局属性必须等主线程
       * 这一轮任务结束才提交。所以旧顺序（先 paintFloatDelta(0,0) 再 applyFloat）
       * 会先闪回原位、再跳到新位——就是「放开鼠标闪一下」。
       * 反过来先写变量，主线程在同一次样式重算里把位置更新掉，合成器拿到的
       * 已经是终点坐标，没有中间态可显示。
       *
       * applyFloat 内部会把坐标夹进视口并回写 floatX/floatY，
       * 所以必须落在 saveFloat 之前，否则会把视口外的坐标存进去。
       */
      applyFloat(floatRootGood());
      paintFloatDelta(0, 0);
      saveFloat();
      // 拖动期间 schedule 被冻结，松手后补一次同步把几何追平
      api.schedule();
      api.scheduleReport();
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


    // ------------------------------------------------------------------ 导出

    function install(next) {
      api = next;
      diag = next.diag;
      ATTR_ROOT = next.ATTR_ROOT;
      ATTR_PART = next.ATTR_PART;
      ATTR_FLOAT = next.ATTR_FLOAT;
      STORAGE_FLOAT = next.STORAGE_FLOAT;
      loadFloat();
      return exports;
    }

    exports.install = install;
    exports.load = function () {
      return loadFloat();
    };
    exports.isOn = function () {
      return floating === true;
    };
    /** 完整落位；退到停靠态时内部会清掉浮层标记与抓手 */
    exports.apply = function (root) {
      return applyFloat(root);
    };
    /** 只在悬浮态落位：给内核的量算流程用，停靠态不做任何事 */
    exports.refresh = function (root) {
      if (!floating) return;
      applyFloat(root);
    };
    exports.toggle = function () {
      return toggleFloat();
    };
    exports.set = function (on) {
      return setFloating(on);
    };
    /** 退回原生布局：撤掉抓手、清掉所有悬浮标记与拖拽残留（偏好本身保留） */
    exports.detach = function () {
      cancelFloatDrag();
      removeGrip();
      if (floating) {
        document.querySelectorAll("[" + ATTR_FLOAT + "]").forEach(function (node) {
          node.removeAttribute(ATTR_FLOAT);
        });
      }
      diag.floating = false;
    };
    /** 抓手挂在 body 上，内核的 observer 需要认它，否则会自激循环 */
    exports.ownsNode = function (node) {
      if (node === null || node === undefined) return false;
      return gripEl !== null && (node === gripEl || gripEl.contains(node));
    };
    exports.reclamp = function () {
      return reclampFloat();
    };
    /** 正在拖悬浮条吗？内核据此冻结同步（拖拽期间重量几何会抢主线程） */
    exports.isDragging = function () {
      return floatDrag !== null && floatDrag.active === true;
    };
    return module.exports;
  },
});
