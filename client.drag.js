// dsh-sidebar-rail / 拖拽排序模块（可选模块，独立 chunk）
//
// 这个模块只负责「把轨道上的图标拖动换位置」，不碰布局、不碰悬浮、不碰设置页。
// 它通过 install(api) 拿到内核提供的最小接口，自己坏掉时内核只是少一个功能，
// 并列布局与其它模块照常工作。
//
// 为什么单独成一个文件：拖拽引擎是纯交互逻辑，改动频率高、出错也不影响布局，
// 出问题时可以只审这一个文件，不必在同一份两千行的内核里翻找。

window.__ModuleLoader__.load({
  id: "dsh-sidebar-rail",
  chunk: "client.drag.js",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    /** 由内核 install() 注入；未安装前所有导出函数都安全早退 */
    let api = null;

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
        const raw = window.localStorage.getItem(api.STORAGE_NAV_ORDER);
        const parsed = raw === null ? [] : JSON.parse(raw);
        navOrder = Array.isArray(parsed) ? parsed.map(String) : [];
      } catch (err) {
        navOrder = [];
      }
    }

    function saveNavOrder() {
      try {
        window.localStorage.setItem(api.STORAGE_NAV_ORDER, JSON.stringify(navOrder));
      } catch (err) {
        api.pushError("nav-order-save: " + String(err));
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
      if (api.isRailExpanded()) ghost.classList.add("dsr-ghost-wide");
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
          const entries = api.getEntries();
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
          if (next.length === entries.length) api.saveEntries(next);
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

    // ------------------------------------------------------------------ 导出

    function install(next) {
      api = next;
      // 记忆顺序必须在首次 sync 之前读进来：sync 里 setNav 会立即重放一遍，
      // 若此时 navOrder 还是空数组，就会按 DOM 原始顺序排，看起来像「没保存」。
      loadNavOrder();
      return exports;
    }

    /** 内核每次 sync 认出 nav 后调用：绑定事件 + 重放记忆顺序 */
    function setNav(nav) {
      navEl = nav === undefined ? null : nav;
      if (navEl === null) return;
      attachDrag(navEl);
      applyNavOrder(navEl);
    }

    /** 内核退回原生布局时调用：nav 引用失效，顺序仍留在 localStorage */
    function clearNav() {
      navEl = null;
    }

    /** 挂自定义条目的容器（内核创建挂载点时调用一次） */
    function attachContainer(container) {
      attachDrag(container);
    }

    exports.install = install;
    exports.setNav = setNav;
    exports.clearNav = clearNav;
    exports.attachContainer = attachContainer;
    exports.loadOrder = loadNavOrder;
    exports.applyOrder = applyNavOrder;
    exports.cancel = cancelDrag;
    exports.isDragging = function () {
      return activeDrag !== null;
    };
    return module.exports;
  },
});
