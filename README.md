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
│ »  │                          │  ← 底部：自定义条目 + 展开/收起 + 悬浮/停靠
├────┴──────────────────────────┤
│  设置 · 底部动作              │  ← footArea（跨两栏）
└───────────────────────────────┘
```

左边的竖轨从上到下是：

1. 已装插件的全部面板图标（`sidebar.panellist` 的所有注册者，装新插件自动跟着变）
2. 一条细分隔线
3. 你自定义的条目
4. 展开 / 收起按钮
5. 悬浮 / 停靠按钮

## 取消固定

DSH 原生侧栏在鼠标悬停面板行时会出现「从左侧栏取消固定」按钮。本插件会把这个按钮隐藏，防止面板从轨道消失；**「更多」菜单及其余操作仍完整保留**，因此仍可正常打开、管理和使用面板。

## 一键展开 / 收起工作区

工作区那一行的标题（「工作区」三个字旁边、搜索图标左侧）多了一颗小按钮：展开着的时候显示 **« 收起**，点一下把整块左侧栏收起；收起后再点它（或宿主自己的侧边栏按钮）就展开回来。同一个入口两个方向，不用记「现在该点哪个」。

- **位置**：长在工作区的**标题行**里、紧挨搜索格左侧——和「工作区」分组标题、搜索图标、视图选项按钮同一行，不另占高度
- **图标与文案**：图标是两条朝左的双尖折线，收起时整体翻面朝右表示「往外展开」；文案只有「收起」/「展开」两字，无障碍名才是完整的「收起工作区」/「展开工作区」。侧栏被压窄到放不下两个字时，文案自动隐藏、只留图标
- **两套「展开」别混**：竖轨底部那个 **» / «**（见上一节）只管 40px 窄条要不要显示文字标签，是本插件自己的形态；这一颗管的是宿主整个左侧栏在不在屏幕上
- **状态判定只读 DOM**：`[data-sidebar-collapsed]` 在就是收起、不在就是展开。不自己维护一份状态，所以不管你从哪条路径（这行按钮、宿主按钮、快捷键、窗口变窄）改的，显示都对
- **驱动宿主三级兜底**，逐级降级，绝不假装成功：
  1. `layout.toggleSidebar()` —— 0.1.7 → 0.2.3 全版本都有的服务方法，最干净
  2. 点宿主自己的折叠按钮 —— `[data-sidebar-opener]`（0.2.2+ 侧栏外，收起态也点得到）→ `[data-sidebar-toggle]`（0.2.2+ 侧栏内）→ 按无障碍名认「侧边栏 + 开合」（老版本没有这两个属性时）
  3. 都没有 → 按钮把自己**禁用**并把 `compat.wsToggle` 标成 `unsupported`，鼠标悬停给出说明。一个点了没反应的按钮比没有按钮更糟
- **退场**：工作区锚点整个消失、或插件被 `dsh-sidebar-rail:off` 关掉时，这个入口跟着摘掉；只是折叠的话它留着（那正是点回来的路）
- **诊断**：`__DSH_RAIL__.compat.wsToggle` = `ready` / `service` / `button` / `unsupported`，一眼看出这个宿主走的是哪条路

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

## 悬浮到任意位置

竖轨最底部的 **⧉（悬浮）/ ◱（停靠）** 按钮可以把整条轨道从侧边栏里拎出来，变成一块**浮在页面上的面板**，随便拖到 DSH 里任何位置：

- 点 **⧉ 悬浮**：轨道脱离侧边栏，浮到视口右侧的空白处，会话列表立刻收回被占用的宽度（不再给轨道让位）
- **悬浮会自动展开、停靠会自动收起**：40px 纯图标条浮在视口里认不清也难点，所以悬浮时直接把功能区的文字标签一起带出来（展开宽度约 130px，按侧边栏宽度自适应）；停靠回去则恢复 40px，不会越用越挤。悬浮态下仍可手动点 `«` 收起
- 拖动轨道顶部的**抓手**（`⋮⋮` 那一条）就能移动，松手位置会记住
- 拖到边缘会自动夹在视口内，缩窗口也不会跑丢
- 双击抓手、或按 Enter / Space，等于再点一次 **◱ 停靠**，回到侧边栏原位
- 状态存在 `localStorage` 的 `dsh-sidebar-rail.float.v1`（记 `{on, x, y}`），刷新后保持

**三段拼接**：浮层不是一整块，而是「抓手 / 面板图标 / 自定义条目」三个独立定位的段拼起来的（这样面板图标那层才能继续滚动、仍能拖拽排序）。要让它们看起来是**一张**卡片，做了三件事：

- 三段共用一条 `.5px` 外框线：每段只画左右两边，最下面那段才画底边；相邻两段的 `top` 特意重叠 `1px`，否则两条边会并排成双线
- **投影只留在最底部一段**：中间那段若自带向下投影，会正好压在下一段的顶边上，看起来像两块卡片「接不上」
- custom 段的 `top` 由 `--dsr-float-nav-h`（面板图标层的真实高度）推算；启动时面板列表往往晚一拍才长到最终高度，所以用 `ResizeObserver` 盯住高度并即时改写变量，避免刚打开时上下错位

**启动即悬浮时也成立**：首次悬浮的落位算好之后才写盘（早先写盘在算落位之前，刷新读回来永远是初始的左上角 `(12,120)`，这就是「启动后模块不衔接」的根因）。

流畅性做法：

- 拖动过程中**只写 `translate3d`**（抓手 + 图标层 + 自定义条目层），绝不改 `left` / `top`，因此不触发布局重排
- 指针事件用 `setPointerCapture` + `requestAnimationFrame` 合帧，一帧最多算一次位置，掉帧时不会堆积
- **拖动期间冻结布局同步**：DSH 流式输出会不停改 DOM 触发我们的 `MutationObserver`，而每次同步都要量几何（强制同步布局）。拖动只改 `transform`，本来也不重量，所以拖动时直接跳过同步，松手后补一次
- **CSS 变量与属性只在真变化时才写**：以前每帧无条件 `setProperty` / `setAttribute`，会让 `[data-dsh-rail-float]`、`[data-dsh-rail-expanded]` 下的整棵侧边栏子树反复重算样式——这是「拖起来 DSH 区域闪一下」的根因
- 位移目标层在按下时缓存一次，不在每帧里 `querySelector`
- **拖动过程里就夹在视口内**：按下时先算一次允许的位移区间（`floatDragBounds()`），移动时把 `dx/dy` 夹进这个区间。以前只在松手时夹取，结果是拖到边上松手会「往回跳」（实测跳了 44px）
- **松手时先落位、再清 `transform`**：`transform` 由合成器线程处理，一清掉就能把轨道画回 CSS 变量指的旧位置；而 `left` / `top` 要等主线程这一轮任务结束才提交。旧顺序（先清 `transform` 再写变量）于是先闪回原位、再跳到新位，看起来就是「放开鼠标闪一下」。反序之后指针抬起的前后帧完全一致（回归里逐 `requestAnimationFrame` 比对 24 帧，0 帧偏差）
- 落盘放在夹取之后，避免把视口外的坐标存进去

回归里有专门的防回归断言：拖动全程用 `PerformanceObserver` 采集长任务，要求**没有超过 80ms 的主线程卡顿**（当前实测 0 个）。

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

## 设置窗口化

DSH 自带的设置弹窗是一块居中的固定面板，盖在遮罩上，只能点遮罩或按 Esc 关掉。这个模块把它变成**可自由摆放的窗口**：

- **拖动**：按住面板**任意位置**都能拖走（标题栏、内容区、导航、说明文字都行），移到任意位置；松手落盘，下次打开还在原位
  - 面板里能点的东西不吃这个手势：`button`、`a[href]`、`input` / `textarea` / `select`、`label`、`[contenteditable]`、`[role=button]` 等（见 `INTERACTIVE_SEL`）按下去仍是它自己的动作，窗口不会跟着跑
  - 按下时**不捕获指针、不 `preventDefault`**：面板里有输入框和可选中文字，按下阶段就吞事件会把点击和选中一起废掉。等移动超过 3px、确认这是拖而不是点，才开始捕获并接管
  - 光标随开关走：`drag` 打开时整块面板 `cursor:grab`（按钮仍是 `pointer`、输入框仍是 `text`），拖动中统一 `grabbing`，关掉开关立刻退回常态
- **窗口外观**：保持宿主提供的普通设置窗口样式，不再注入液态玻璃模糊、透明背景或高光阴影，也不再添加红黄绿控制圆点。
- **官方关闭**：保留宿主原生 × 按钮、无障碍名称、热区与关闭路径。

- 位置存在 `localStorage` 的 `dsh-sidebar-rail.win.v1`
- 拖动只写合成层 `transform`（`translate3d`）+ `requestAnimationFrame` 合帧，不触发布局重排；松手才写 `left / top`
- **拖动期不卡，但材质一个像素都不动**：
  - **只加图层提示**：确认拖动后给面板打 `data-dsh-rail-win-dragging="1"`，CSS 只加 `will-change:transform`，不改变宿主提供的普通材质。
  - **拖动中冻结同步**：`tick()` 每轮都会跑 `applyWindow()`，里面有 `getBoundingClientRect()` + `getComputedStyle()`，属于**强制同步布局**。拖动期间位置完全由 `transform` 表达，不需要也不应该再量一次，所以 `tick()` 与 `onResize()` 直接在拖动中早退，松手后补一次落位
  - **只看自己那棵树**：`MutationObserver` 原来盯 `document.body` 的任意 `childList` 变化，而 DSH 会话流式输出一秒能改几十次 DOM，等于每秒几十次 `querySelector` + 全量同步。现在只在「面板本身被增删」「面板所在子树有变化」「新增/移除的节点里含有面板」时才调度，别处的一律忽略
  - 顺带：拖动中不再每帧改写 `diag.window`（否则每 1.5s 一次的诊断上报会白做序列化），`body` 的 `grabbing` 光标也不再靠 `*` 扫整棵文档树
  - **实测**：探针用真实鼠标（CDP `Input.dispatchMouseEvent`）拖 40 步，长任务 0 次；拖动期间帧间隔 `max 16.8ms / p95 17ms / 超两帧 0 次`。
- **松手不闪、不跳**（收手瞬间的那一下）：
  - **所见即所得**：拖动期间画的是 `transform`，落位写的是 `left / top`，两套坐标必须严格对应。现在 `flushDrag()` 每帧就按松手时的同一套参数（`clampPos(x, y, 0, 0)`）把位移夹进边界并记下**这一帧真正画出去的位置**，`onDragPointerUp()` 直接照着它落位。以前是拖动不夹、松手才夹，拖到视口边缘收手就会往回弹一截——那就是「跳帧」。夹取参数两边必须完全一致，传真实宽高会得到另一组边界（`minX = 80 - w`），又会跳
  - **位置与图层提示分两帧**：`pointerup` 那一帧已经在做两件重活——写新的 `left/top`、清空 `transform`（图层失效）。若再同时撤 `will-change`，合成器还得把图层重新降级、重新光栅化，三件抢一帧照样掉帧。所以第一帧只把位置落定，下一帧（双 `requestAnimationFrame`）再撤 `will-change`，见 `settleDragging()`
  - **落位那一帧不量尺寸**：`applyWindow(skipMeasure)` 跳过 `getBoundingClientRect + getComputedStyle`，改用拖动开始时记下的自然尺寸（拖动过程不改面板尺寸，这个值是准的），落位少一次强制同步布局，不会晚一帧
  - 上一次松手的回调若还没跑就又按下，先 `cancelSettle()` 撤掉，否则它会在新一轮拖动中间动一次 `will-change`

与官方布局的关系：模块不依赖任何哈希类名，只按 `grid-area` 认出「标题栏」和「关闭按钮区」，改写内联样式且**只写自己的属性**（`data-dsh-rail-win*`），关窗时原样撤掉，官方弹窗组件本身不动。找不到标题栏就整体退出，保持官方原样。

grid-area 的识别方式是**按后缀**匹配：官方模板写作 `"VOzbGW_title VOzbGW_header"`，`VOzbGW_` 是构建哈希、每次发版都会变，所以只看每一格是否以 `title` / `header` 结尾。

### 一个功能可关

窗口化行为只剩一个独立开关，放在**设置 → 侧边栏条目**这一节的最上面：

| 开关 | 键 | 关掉之后 |
| --- | --- | --- |
| 按住面板任意位置拖动 | `drag` | 面板不再能拖动，光标退回常态 |

开关保存后立即生效并写入 `localStorage` 的 `dsh-sidebar-rail.features.v1`；刷新后按原状态恢复。默认开启，缺字段或脏数据按开启处理。

恢复：

```js
localStorage.removeItem('dsh-sidebar-rail.features.v1')
```

然后刷新页面。

诊断对象 —— 控制台执行 `__DSH_RAIL__`：

```js
{ loaded, version, tagged, disabled,
  anchors: { root, nav, region, logo, foot, newButton },
  custom, entries, hasInput, expanded, floating, floatPos,
  settingsSection, features, errors }
```

- `tagged: true` 表示已成功接管布局
- `disabled: 'collapsed' | 'switch' | null` 表示当前为什么没接管
- `anchors` 里哪一项是 `false`，就是那个锚点没找到
- `floating` / `floatPos` 是当前悬浮态与落位坐标
- `features` 是功能开关的当前状态（`{ drag }`）
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
| `probes/drag-probe.cjs` | 拖拽排序：ghost / 半透明占位 / FLIP / `order` 变更 / 落盘 / 刷新还原 / 自定义条目重排 / 点击抑制 |
| `probes/float-probe.cjs` | 悬浮：进出悬浮态、自动展开/停靠自动收起、抓手出现、`translate3d` 拖动、坐标夹取与落盘、**首次落位即写盘**、**三段无缝衔接（含刷新后与 nav 长高后）**、刷新还原、双击停靠、缩窗口不跑丢、**拖动无长任务** |
| `probes/window-probe.cjs` | 侧栏「从左侧栏取消固定」已隐藏、更多菜单仍保留；设置窗口普通无模糊材质、官方关闭按钮、任意非交互区域拖动、越界夹紧、标题栏双击不再最大化、关闭清理、真实鼠标拖动性能与帧间隔回归 |
| `probes/features-probe.cjs` | 单一功能开关（拖动）渲染、持久化、刷新恢复、开关即时生效、无红绿灯与原生关闭按钮、诊断无异常 |
| `probes/ws-toggle-probe.cjs` | 工作区一键展开/收起：入口长在标题行里且紧挨搜索框左侧、带图标、展开/收起文案互换、点一下真的折叠与展开、老版本没有 `[data-sidebar-workspace-header]` 时按结构兜底仍能落回原处、无重复堆积、宿主不支持时自我禁用、锚点消失后退场 |
| `verify-compat.cjs` | 跨版本契约：把插件依赖的 24 条 DSH 契约（槽位锚点 / 折叠属性 / 设置面板属性 / grid-area / flex 兜底 / chunk 加载 / `__DSH_BOOT__.release` / `layout.toggleSidebar` / 侧栏开合按钮 / 工作区标题行与搜索框）逐条拿到多个 DSH 版本的真实产物上核对 |

`drag-probe.cjs`、`float-probe.cjs`、`window-probe.cjs` 与 `features-probe.cjs` 自带静态回归台（`probes/drag-harness.html` 复刻 DSH 侧边栏与设置弹窗的 DOM 骨架 + 加载真实 `client.js`；`probes/features-harness.html` 在此基础上加了 `react` 桩与 `slots.inject` 留档，好让设置页那一节真能被挂起来），**不需要 DSH 进程**，直接 `node probes/float-probe.cjs` 即可，会自己起一个 headless Chrome。

另有 `verify-drag.cjs`：在 Node `vm` 里用带布局模型的 DOM 桩加载 `client.js`，跑 24 项断言，纯逻辑层秒级回归，无需浏览器。

`verify-modules.cjs` 专门验证**模块隔离**：在同一个 DOM 桩里逐个制造七种故障（chunk 404、factory 抛错、导出缺 `install`、`install` 抛错、四个模块同时挂掉、装好后运行期抛错、window chunk 拿不到），断言并列布局仍成立、其余模块仍在位、`diag.errors` 里有可定位的一条。这是「某个模块坏了不影响整体」这条承诺的可执行证明，改模块边界后应当先跑它：

```bash
node verify-modules.cjs
```

用法：`node probes/probe.cjs "<带令牌的页面地址>"`。

### 跨版本兼容回归

插件不按版本号分支，只按「宿主真的提供了什么」行事，所以版本兼容性必须**横着摆一排版本**才看得出来。`verify-compat.cjs` 就是这件事的可执行版本：

```bash
# 准备解包目录（每个版本一个子目录，含 lib/client.js）
npm pack @deepseek-ai/dsh-client-ui-sidebar@0.2.1-rc.1
tar -xzf deepseek-ai-dsh-client-ui-sidebar-0.2.1-rc.1.tgz
# …同理准备 settings-general / renderer / client-modules / conversation

node verify-compat.cjs --root D:\Obsidian\dsh-compat-tmp
```

每条契约输出一行版本矩阵（`✓` 成立 / `✗` 不成立 / `·` 未解包跳过），并按性质分三档：

- **OK**：全版本成立，改动插件时不该被打破；
- **DEGRADE-OK**：某些版本没有，但插件已自动降级（`data-sidebar-drawer`、`grid-area`、`settings.section.icon`、`__DSH_BOOT__.release`）；
- **BREAK**：非可选契约在某个版本上不成立 —— 退出码 1，表示这里需要新增兜底分支。

判断标准上，`layout.grid-area` 在 `0.2.1` 系列上 `✗` 是**预期**的：那时设置面板还是 flex 布局，插件靠「官方 × 所在那一行」这层结构兜底接住它。这条正是 `window-probe.cjs` 的 `legacy` 变体在浏览器里实测的那条路径。

这些探针需要一个带启动令牌的地址。默认情况下宿主侧 `index.mjs` **什么都不做**；只有以 `DSH_SIDEBAR_RAIL_DEV=1` 启动 DSH 时，它才会：

1. 把 `connection.authenticatedUrl()` 算出的带令牌地址写到本目录的 `launch-url.txt`（探针直接用它）；
2. 注册 `GET/POST /dsh-sidebar-rail/report`，把浏览器端回传的诊断写到 `last-report.json`。

这两项都是本地调试脚手架，且第 1 项会把访问凭据落盘，所以默认关闭——正常使用时不需要它们。

## 实现原理

### 模块结构：内核 + 四个可选模块

插件拆成一个内核和四个独立 chunk，靠 DSH 的 `client-modules` 按需加载：

| 文件 | 职责 | 缺席时的表现 |
| --- | --- | --- |
| `client.js` | 内核：锚点识别、并列布局、条目渲染、诊断回传、错误边界 | —（它必须活着，否则插件不启动） |
| `client.drag.js` | 轨道图标与自定义条目的鼠标拖拽排序（FLIP） | 面板图标退回原生顺序，仍可点击 |
| `client.float.js` | 竖轨整体悬浮、拖动、双击停靠、自动展开/收起 | 轨道上不出现「悬浮」按钮，其余照常 |
| `client.settings.js` | 条目编辑（DSH 设置页一节 + 内联弹层 + 导入导出） | 设置页里那一节空白，条目仍按默认两条渲染 |
| `client.window.js` | 设置弹窗窗口化：按住任意位置拖动，以及拖动开关的就地启停；保持官方关闭按钮和普通材质 | 设置弹窗退回官方原样 |

功能开关本身住在内核（`client.js` 的 `FEATURES` / `featureState` / `getFeature` / `setFeature`），不由模块持有：状态要能跨模块共享，也要能在模块缺席时照样读得到。`client.settings.js` 只负责把它们画成开关，`client.window.js` 只负责按状态干活。

模块之间**不互相 import**，只认内核给的一份最小接口（`moduleApi`）。内核装配模块时逐个 `try/catch`：某个 chunk 404、factory 抛错、`install()` 抛错，都只把该模块置空并往 `diag.errors` 写一条 `module <key>: <reason>`，其余模块与布局完全不受影响。

运行期同理：所有跨模块调用都走 `callModule(key, fnName, args, fallback)`——模块缺席返回兜底值，抛错则记一次故障并**把该模块永久摘掉**，之后都走兜底。这样「某一个模块出问题」不会冒泡成整个侧边栏的故障。要单独修某个功能，只需改对应的那一个 chunk；要加功能，就再加一个 chunk 并在 `loadModules()` 的 `specs` 里登记。

### 布局

DSH 的槽渲染器给每个槽套一层 `<div data-slot="<槽名>" style="display:contents">`。`display:contents` 让这层包装盒不参与布局，因此它是**纯寻址面**——一个不依赖构建哈希类名的稳定钩子。

插件据此：

1. 找 `[data-slot="sidebar.panellist"]` 并上溯到它的 `<nav>`，再找 `[data-slot="sidebar.workspaces"]` 的父节点 —— 这两者就是两栏。
2. 给根节点和各部件打 `data-dsh-rail-*` 属性（只写自有属性，不碰 `data-slot`，也不碰别的插件的属性）。
3. 把面板 `<nav>` 绝对定位成竖轨，会话区按实测量出的边距让位。
4. 用 `MutationObserver` + `requestAnimationFrame` 持续重测，因为 React 会重挂载，且有若干条件渲染（`topStrip`、新会话按钮、面板列表、toast）会改变子元素顺序 —— 所以网格行号不能硬编码。

## 跨版本兼容

插件最初是对着一个 DSH 版本写的，现在支持 **0.2.0-rc.2 及以上**（`package.json` 的 `engines.dsh` 说了算：`>=0.2.0-rc.2 <0.3.0-0`）。0.2.0 这一档的取舍见下面「各版本上的功能可用面」。

做法是**特性探测，不是版本号分支**。DSH 的版本号在浏览器里未必拿得到（`__DSH_BOOT__.release` 要到 0.2.1 才有），而版本号一旦写进 `if`，下一个小版本就会骗过它。所以插件只问「宿主现在长什么样」。

### 依赖点与各版本的差异

| 依赖点 | 用在 | 0.1.7 | 0.2.0 | 0.2.1 | 0.2.2+ |
| --- | --- | --- | --- | --- | --- |
| 四个 `[data-slot="sidebar.*"]` 锚点 | 并列布局的全部定位 | ✓ | ✓ | ✓ | ✓ |
| `[data-sidebar-collapsed]` | 折叠态判定 | ✓ | ✓ | ✓ | ✓ |
| `[data-shortcut-modal="settings"]` | 找到设置弹窗面板 | ✗ | ✗ | ✓ | ✓ |
| `grid-area` 命名（标题栏/按钮行） | 窗口拖动一级探测 | — | — | ✗ | ✓ |
| flex 布局（header 在 content 内） | 窗口拖动二级兜底 | — | — | ✓ | ✗ |
| `settings.section` 槽 | 设置页里的「侧边栏条目」 | ✗ | ✗ | ✓ | ✓ |
| `settings.section.icon` 槽 | 设置项图标 | ✗ | ✗ | ✗ | ✓ |
| `__DSH_BOOT__.release.version` | 只进诊断，不作分支 | ✗ | ✗ | ✓ | ✓ |
| `layout.toggleSidebar()` | 工作区一键展开/收起的主路径 | ✓ | ✓ | ✓ | ✓ |
| `[data-sidebar-opener]` / `[data-sidebar-toggle]` | 收起/展开的按钮兜底路径 | ✗ | ✗ | ✗ | ✓ |
| `[data-sidebar-workspace-header]` | 一键展开/收起入口找到工作区标题行 | ✗ | ✗ | ✗ | ✓ |
| 标题行内有 `input`（搜索框） | 上一项缺失时按结构反推标题行 | ✓ | ✓ | ✓ | ✓ |

**0.2.2-alpha.2 是分界线**：在那之前设置面板是 flex 布局（没有任何 `grid-area`），之后改成 CSS grid 命名区。插件原来只认 `grid-area`，所以在 0.2.1 及更早的版本上会直接放弃接管——窗口拖动完全失效，而且是静默的。

### 二级探测怎么工作

`client.window.js` 的 `locateTitleAndHeader(panel)` 按顺序试：

1. **一级**：遍历面板后代读 `getComputedStyle(node).gridArea`，匹配 `/title$/i`、`/header$/i`。这是 0.2.2+ 的路径，最准。
2. **二级**（一级没命中才走）：
   - header = `panel.querySelector('button[class*="close" i]').parentElement` —— 「官方 × 所在的那一行」。这个判据从 0.2.1 到 0.2.3 都成立，因为关闭按钮始终在标题栏里。
   - title 依次试 `[data-modal-autofocus]` → `aria-labelledby` 指向的节点 → `[class*="navTitle" i]`。
3. 两级都拿不到才记 `no-title` 放弃，面板退回官方原样。

注意 `title` 与 `header` **允许是不同节点**：0.2.1 的标题文字（`div.navTitle`）在左侧导航列里，而按钮行在内容区顶部。插件只把 `header` 用来抬高层级（让按钮点得到），把 `title` 用作拖动抓手与自动聚焦目标，两者分开正好对上两种布局。

走二级时会把路径记进 `__DSH_RAIL__.window.compat`：`{ titleBy: "modal-autofocus", headerBy: "close-row", fallbacks: [...] }`。排查「这个版本上拖动怎么怪怪的」时，先看这三个字段。

### 各版本上的功能可用面

| DSH 版本 | 并列布局 / 条目 / 拖拽 / 悬浮 | 设置页里的条目编辑 | 设置窗口拖动 | 工作区一键展开/收起 |
| --- | --- | --- | --- | --- |
| 0.2.0 及更早 | ✓ | ✗（没有 `settings.section` 槽） | ✗（没有 `data-shortcut-modal` 面板） | ✓（走 `layout.toggleSidebar()`） |
| 0.2.1 系列 | ✓ | ✓ | ✓（走二级兜底） | ✓（走 `layout.toggleSidebar()`） |
| 0.2.2+ | ✓ | ✓ | ✓（走一级 grid-area） | ✓（服务优先，按钮兜底） |

0.2.0 及更早那两列为 ✗ 不是 bug：那些版本压根没有官方设置弹窗，插件探不到面板就静默退回，不报错也不留痕。工作区一键展开/收起反而全版本可用 —— 它靠的是 `layout.toggleSidebar()`，这个方法从 0.1.7 到 0.2.3 一直存在。

### 诊断

`window.__DSH_RAIL__.compat` 记录这次探测到的能力面，贴一份出来就能定位降级层：

```js
JSON.stringify(window.__DSH_RAIL__.compat)
// { dshVersion: "0.2.2-rc.5", slots: true, slotInject: true, slotRegister: true,
//   requireAsync: true, ctxGet: true, ctxEffect: true,
//   sidebarCollapsed: "expanded", railColumn: "parentElement", wsToggle: "ready", notes: [] }
```

`notes` 里是「哪一层没长出来」的白话说明；`sidebarCollapsed` 是折叠态实测值（顺带证明那条探测点真的在跑）；`railColumn` 说明几何是量在哪个父节点上的。

## 已知边界

- 侧边栏宽度仍受 DSH 自身 264–420px 限制（本插件不改这个上限）。窗口很窄时会比较挤，此时可以收起侧边栏用原生形态。
- 折叠态（56px）下不接管，保持原生图标条。此时工作区标题行里那颗「展开」按钮仍在（宿主只是把整列压窄、没有隐藏它），点它就能展开回来；如果你用的宿主版本在折叠态把整个 region 都藏了，那就用宿主自己的侧边栏按钮。
- 悬浮态是**浮层**，不参与 DSH 布局：它会盖在页面内容上面。默认落在视口右侧空白处，若你想让它出现在别处，拖过去即可。
- 悬浮会顺带把展开态打开（停靠时关回去）。如果你更想保持 40px 纯图标条漂浮，进去后手动点一下 `«` 收起即可，位置不会丢。
- 依赖 `[data-slot="sidebar.workspaces"]` 等锚点；DSH 若大改侧边栏结构，`__DSH_RAIL__.anchors` 会指出哪一项失效，此时插件自动退回原生布局而不会破坏界面。

## 关于 AI 参与

这个插件是**人机协作**的产物，说清楚分工：

- **人类维护者**（[boonelueng](https://github.com/boonelueng)）提出需求、做技术选型与方案决策、在真实的 DSH 实例上复现问题并验收结果，并为本仓库的全部内容负责。需求判断、边界取舍、最终是否合入由人决定。
- **AI 编程助手**（DeepSeek Harness 中的编码 agent）承担了大部分实现工作：阅读 DSH 源码定位可用接口、写 `client.js` 与探针脚本、跑回归、修 bug、写文档。代码里凡是「为什么这么写」的注释，多数是它在排查过程中记下的结论。
- **验收手段不靠 AI 自述**：每个功能都配有能在无头 Chrome 里跑的回归脚本（`probes/` 与 `verify-drag.cjs`），断言的是真实 DOM 几何、`localStorage` 内容、`performance` 长任务与逐帧对比结果。人机都可能看错，所以结论尽量落在可重跑的证据上。

也就是说：代码主要由 AI 编写，**责任、方向与最终验收在人**。如果你在别处引用或二次开发，按 MIT 正常使用即可，不需要额外标注；上面这段只是为了不让人误以为它出自某个团队之手。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
