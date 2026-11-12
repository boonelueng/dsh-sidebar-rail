# dsh-sidebar-rail

把 DeepSeek Harness（DSH）的左侧边栏改成**两条并列的竖栏**：左边一条窄轨放功能区图标，右边放会话 / 工作区列表；窄轨底部还能挂你自己定义的按钮。

- 不改 DSH 安装包，只做 DOM 增强。
- **不注册** `sidebar` 槽（注册那里会整体替换整列导航），只依赖 DSH 槽渲染器输出的稳定锚点 `[data-slot="..."]`。
- 折叠态 / 窄屏抽屉态自动退出，完整退回原生布局。

## 效果

```
┌───────────────────────────────┐
│  Flag  DSH                    │  ← logo 行（跨两栏）
│  [＋ 新会话            ⌘N ]   │  ← 新会话按钮（跨两栏）
├────┬──────────────────────────┤
│ ●  │                          │
│ ◈  │   会话 / 工作区列表      │  ← 右栏：原生 ui-workspace，占满剩余宽度
│ ✦  │   （搜索、分组、拖拽）   │
│    │                          │
│ ✎  │                          │
│ ◈  │                          │
│ »  │                          │  ← 底部：自定义条目 + 展开/收起按钮
├────┴──────────────────────────┤
│  设置 · 底部动作              │  ← footArea（跨两栏）
└───────────────────────────────┘
```

左边的竖轨从上到下是：

1. 已装插件的全部面板图标（`sidebar.panellist` 的所有注册者，装新插件自动跟着变）
2. 一条细分隔线
3. 你自定义的条目
4. 展开 / 收起按钮

## 展开 / 收起功能区

竖轨最底部是 **»**（展开）/ **«**（收起）按钮：

- 收起 = 40px 纯图标条（默认）
- 展开 = 加宽，并让每个面板 / 条目显示**文字标签**，方便认图标
- 展开宽度按侧边栏实际宽度自适应（上限 180px，且始终给会话区留出至少 150px），不会把会话列表挤成一条缝
- 状态存在 `localStorage` 的 `dsh-sidebar-rail.railExpanded.v1`，刷新后保持

## 拖拽排序

左侧竖轨里的**面板图标**和**自定义条目**都可以用鼠标直接拖动调整顺序：

- 按住任意图标往上/下拖，超过 4px 才开始移动，所以普通点击（切面板、执行条目）不受影响
- 拖动时被拖起的图标半透明留在原位当占位，另外有一个跟随指针的浮层代表它；其他图标用 FLIP 动画（170ms，`cubic-bezier(.2,0,0,1)`）平滑让位
- 排列只改 CSS `order` + 合成层 `transform`，不重排 DOM，所以拖动过程中不抖动
- 松手后写盘，刷新后保持：
  - 面板图标 → `localStorage` 的 `dsh-sidebar-rail.navOrder.v1`（按 `aria-label` 记，DSH 没把 panel id 暴露到 DOM）
  - 自定义条目 → 直接重排 `dsh-sidebar-rail.custom.v1` 里的条目数组
- 「更多」菜单按钮固定在最后，不参与排序
- 展开态下拖拽同样可用，浮层会跟着轨道宽度变化并显示文字标签

## 自定义条目

**入口在 DSH 设置页**：点左下角头像 → 「设置」→ 左侧导航最后一段的 **侧边栏条目**。侧边栏上不再有齿轮按钮。

在设置页里：

- 列表里可以 **上移 / 下移 / 编辑 / 删除** 条目
- **添加条目**：图标（最多 2 个字符，建议 emoji）+ 名称 + 动作
- 动作四选一：

  | 类型 | 行为 |
  | --- | --- |
  | `prompt` 填入输入框 | 把预设提示词写进当前会话输入框（不自动发送） |
  | `session` 新会话发送 | 开一个新会话并把提示词发出去 |
  | `panel` 打开面板 | 切到某个全局面板（如 `plugins`） |
  | `url` 打开链接 | 新标签打开网址 |

- **导出 / 导入 JSON**，方便备份或换机迁移
- **恢复默认** 回到内置的两条示例

数据存在 `localStorage` 的 `dsh-sidebar-rail.custom.v1`，只在本地，不上传。

## 开关与诊断

临时关掉全部改动（只留诊断）：

```js
localStorage['dsh-sidebar-rail:off'] = '1'
```

恢复：

```js
localStorage.removeItem('dsh-sidebar-rail:off')
```

然后刷新页面。

诊断对象 —— 控制台执行 `__DSH_RAIL__`：

```js
{ loaded, version, tagged, disabled,
  anchors: { root, nav, region, logo, foot, newButton },
  custom, entries, hasInput, expanded, settingsSection, errors }
```

- `tagged: true` 表示已成功接管布局
- `disabled: 'collapsed' | 'switch' | null` 表示当前为什么没接管
- `anchors` 里哪一项是 `false`，就是那个锚点没找到
- `errors` 里是运行期异常

## 安装

在 DSH **0.2.1-rc.2**（`engines.dsh` 声明为 `>=0.2.1-rc.1 <0.3.0-0`）上开发与验证。

### 从 GitHub 装（推荐）

```bash
dsh plugin --profile web add github:boonelueng/dsh-sidebar-rail
```

装完浏览器 `Ctrl+Shift+R` 硬刷新。

### 手动装

1. 本目录放到 `~/.dsh/profiles/web/dsh-sidebar-rail/`
2. `~/.dsh/profiles/web/node_modules/dsh-sidebar-rail` 建一个 junction / symlink 指向本目录
3. `~/.dsh/profiles/web/cordis.patch.yml` 末尾加：
   ```yaml
   - insert:
       - id: dsh-sidebar-rail
         name: dsh-sidebar-rail
   ```
4. 浏览器 `Ctrl+Shift+R` 硬刷新

> 带 `@deepseek-ai/dsh-hmr` 的 DSH 会监听 `cordis.patch.yml`：改文件、或通过插件管理器禁用/启用，都会让宿主**实时重新 apply，无需重启进程**。宿主侧改动（`index.mjs`）需要这次重载；客户端改动（`client.js`）刷新页面即可。

## 卸载

1. 删掉 `cordis.patch.yml` 末尾那两行 insert
2. 浏览器硬刷新；确认恢复原生后，可再删 junction 与本目录

## 自动化回归

`probes/` 下的脚本用 Chrome DevTools Protocol 驱动无头浏览器，直接读真实运行状态，不依赖手工抄控制台：

| 脚本 | 验证内容 |
| --- | --- |
| `probes/probe.cjs` | 并列布局是否生效：`__DSH_RAIL__`、锚点、几何（nav / region / mount 的 box）、面板按钮尺寸 |
| `probes/probe-prompt.cjs` / `probes/probe-prompt-session.cjs` | `prompt` 类动作是否把文本填进输入框（空会话 / 有会话两种路径） |
| `probes/probe-persist.cjs` | 保存后落 `localStorage`、刷新后仍在、「更多」菜单可打开 |
| `probes/probe-panel2.cjs` | 设置页能否打开、「侧边栏条目」一节能否进入、`.dsr-settings-host` 是否有内容 |
| `probes/probe-final.cjs` | 端到端回归：齿轮已消失、展开/收起、设置页里增 / 删 / 保存写回轨道、刷新后保持 |

用法：`node probes/probe.cjs "<带令牌的页面地址>"`。

这些探针需要一个带启动令牌的地址。默认情况下宿主侧 `index.mjs` **什么都不做**；只有以 `DSH_SIDEBAR_RAIL_DEV=1` 启动 DSH 时，它才会：

1. 把 `connection.authenticatedUrl()` 算出的带令牌地址写到本目录的 `launch-url.txt`（探针直接用它）；
2. 注册 `GET/POST /dsh-sidebar-rail/report`，把浏览器端回传的诊断写到 `last-report.json`。

这两项都是本地调试脚手架，且第 1 项会把访问凭据落盘，所以默认关闭——正常使用时不需要它们。

## 实现原理

DSH 的槽渲染器给每个槽套一层 `<div data-slot="<槽名>" style="display:contents">`。`display:contents` 让这层包装盒不参与布局，因此它是**纯寻址面**——一个不依赖构建哈希类名的稳定钩子。

插件据此：

1. 找 `[data-slot="sidebar.panellist"]` 并上溯到它的 `<nav>`，再找 `[data-slot="sidebar.workspaces"]` 的父节点 —— 这两者就是两栏。
2. 给根节点和各部件打 `data-dsh-rail-*` 属性（只写自有属性，不碰 `data-slot`，也不碰别的插件的属性）。
3. 把面板 `<nav>` 绝对定位成竖轨，会话区按实测量出的边距让位。
4. 用 `MutationObserver` + `requestAnimationFrame` 持续重测，因为 React 会重挂载，且有若干条件渲染（`topStrip`、新会话按钮、面板列表、toast）会改变子元素顺序 —— 所以网格行号不能硬编码。

## 已知边界

- 侧边栏宽度仍受 DSH 自身 264–420px 限制（本插件不改这个上限）。窗口很窄时会比较挤，此时可以收起侧边栏用原生形态。
- 折叠态（56px）下不接管，保持原生图标条。
- 依赖 `[data-slot="sidebar.workspaces"]` 等锚点；DSH 若大改侧边栏结构，`__DSH_RAIL__.anchors` 会指出哪一项失效，此时插件自动退回原生布局而不会破坏界面。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
