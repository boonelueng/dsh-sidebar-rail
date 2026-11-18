// dsh-sidebar-rail / 设置页模块（可选模块，独立 chunk）
//
// 职责：条目编辑。两个入口共用同一套表单与导入导出：
//   1) DSH 官方设置页里的「侧边栏条目」一节（由 registerSettings 注册）
//   2) 从轨道上打开的内联编辑弹层
//
// 边界：不碰并列布局、不碰悬浮、不碰拖拽排序。
//
// 故障隔离：
//  - install 失败 → 内核不注册设置节，DSH 设置页里只是看不到这一节。
//  - render 抛错 → 组件返回 null（内核的 SettingsSectionLazy 兜住），
//    设置页其余部分正常显示，侧边栏完全不受影响。

window.__ModuleLoader__.load({
  id: "dsh-sidebar-rail",
  chunk: "client.settings.js",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    /** 由内核 install() 注入；未注入前所有对外函数安全早退 */
    let api = null;

    // ---- 内核符号的本地绑定（install 之后才有值）
    let diag = null;
    let ACTION_TYPES = null;
    let DEFAULT_ENTRIES = null;

    function el() {
      return api.el.apply(null, arguments);
    }

    function clear(node) {
      return api.clear(node);
    }

    function clone(list) {
      return api.clone(list);
    }

    function sanitizeEntry(raw) {
      return api.sanitizeEntry(raw);
    }

    function saveEntries(next) {
      return api.saveEntries(next);
    }

    function actionSummary(action) {
      return api.actionSummary(action);
    }

    function getReact() {
      return api.getReact();
    }

    function schedule() {
      return api.schedule();
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
      editDraft = clone(api.getEntries());
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
      api.saveEntries(clone(editDraft));
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
      editDraft = clone(api.getEntries());
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

    // ------------------------------------------------------------------ 导出

    function install(next) {
      api = next;
      diag = next.diag;
      ACTION_TYPES = next.ACTION_TYPES;
      DEFAULT_ENTRIES = next.DEFAULT_ENTRIES;
      resetDraft();
      return exports;
    }

    /** 注册给 slots 的组件：模块缺失或渲染抛错时安静地返回 null */
    function SettingsSectionSafe(props) {
      if (api === null) return null;
      try {
        return SettingsSection(props);
      } catch (err) {
        diag.errors.push("settings-render: " + String(err));
        return null;
      }
    }

    exports.install = install;
    exports.SettingsSection = SettingsSectionSafe;
    exports.resetDraft = function () {
      return resetDraft();
    };
    exports.closeEditor = function () {
      return closeEditor();
    };
    exports.openEditor = function () {
      return openEditor();
    };
    exports.clearHost = function () {
      settingsHost = null;
    };
    exports.ownsNode = function (node) {
      if (node === null || node === undefined) return false;
      return editorHost !== null && (node === editorHost || editorHost.contains(node));
    };
    return module.exports;
  },
});
