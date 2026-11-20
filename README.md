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
- **窗口控制圆点**：住在官方标题栏那一行里，与左侧「设置」标题处在同一条水平线上。看起来是「绿 · 黄 · 红」三颗同款的 12px 圆点，但**只有绿、黄是我们画的**，最右边那颗红点其实是**官方 × 按钮换了皮**（详见下表）。不是飘在角落的绝对定位——那样会和标题栏里的「打开配置文件」和 × 叠在一起

  | 按钮 | 颜色 | 行为 |
  | --- | --- | --- |
  | 关闭 | 🔴 `#ff5f57` | **官方 × 换了外观**：还是官方那个 `<button>`、还是 React 自己挂的 `onClose`，键盘可达与 `aria-label` 一字未动，只把 28px 的方形图标压成 12px 红圆、藏掉里面的 × 图标，再用 `::after` 把点击热区撑回 28px。走官方关闭路径，天然不会残留遮罩层 |
  | 最小化 | 🟡 `#febc2e` | 收成一条 240px 的标题栏，再点一下还原 |
  | 最大化 | 🟢 `#28c840` | 在「铺满会话区」与「原尺寸」之间切换 |

  纵向对齐：官方 header 是 `align-items:flex-start`，官方 × 原生 28px 高、垂直中心落在 34px 处，正好等于左侧标题行（22px padding + 24px 行高）的中线；被我们画的圆点和被压小的 × 都只有 12px，贴顶会比那条线高出 8px，所以统一用 `margin-top:8px` 补回来，三颗才在同一条水平线上。

- **最大化 = 铺满会话区**：左边界取左侧栏右缘（也就是竖轨和会话区让位之后的位置），右、上、下各留 8px；不会盖住左侧竖轨
- 位置与状态存在 `localStorage` 的 `dsh-sidebar-rail.win.v1`
- 拖动只写合成层 `transform`（`translate3d`）+ `requestAnimationFrame` 合帧，不触发布局重排；松手才写 `left / top`
- **拖动期不卡，但材质一个像素都不动**：
  - **只加图层提示**：按下确认是拖动后给面板打 `data-dsh-rail-win-dragging="1"`，CSS 只加 `will-change:transform`。**刻意不摘 `backdrop-filter`、也不改背景色**——曾经为了省掉「模糊每帧重采样」的开销，在拖动中把模糊摘掉，代价是面板起手从磨砂变清晰（看起来就是**背景透明度变了**）、松手又变回磨砂（看起来就是**闪一下**）。宁可让合成器老老实实每帧重采样，也不让材质在拖动前后出现任何跳变
  - **拖动中冻结同步**：`tick()` 每轮都会跑 `applyWindow()`，里面有 `getBoundingClientRect()` + `getComputedStyle()`，属于**强制同步布局**。拖动期间位置完全由 `transform` 表达，不需要也不应该再量一次，所以 `tick()` 与 `onResize()` 直接在拖动中早退，松手后补一次落位
  - **只看自己那棵树**：`MutationObserver` 原来盯 `document.body` 的任意 `childList` 变化，而 DSH 会话流式输出一秒能改几十次 DOM，等于每秒几十次 `querySelector` + 全量同步。现在只在「面板本身被增删」「面板所在子树有变化」「新增/移除的节点里含有面板」时才调度，别处的一律忽略
  - 顺带：拖动中不再每帧改写 `diag.window`（否则每 1.5s 一次的诊断上报会白做序列化），`body` 的 `grabbing` 光标也不再靠 `*` 扫整棵文档树
  - **实测**：探针用真实鼠标（CDP `Input.dispatchMouseEvent`）拖 40 步，长任务 0 次；拖动期间 `requestAnimationFrame` 帧间隔 `max 16.8ms / p95 17ms / 超两帧 0 次`，与空闲基线完全一致——不降级材质并没有换掉流畅度
- **松手不闪、不跳**（收手瞬间的那一下）：
  - **所见即所得**：拖动期间画的是 `transform`，落位写的是 `left / top`，两套坐标必须严格对应。现在 `flushDrag()` 每帧就按松手时的同一套参数（`clampPos(x, y, 0, 0)`）把位移夹进边界并记下**这一帧真正画出去的位置**，`onDragPointerUp()` 直接照着它落位。以前是拖动不夹、松手才夹，拖到视口边缘收手就会往回弹一截——那就是「跳帧」。夹取参数两边必须完全一致，传真实宽高会得到另一组边界（`minX = 80 - w`），又会跳
  - **位置与图层提示分两帧**：`pointerup` 那一帧已经在做两件重活——写新的 `left/top`、清空 `transform`（图层失效）。若再同时撤 `will-change`，合成器还得把图层重新降级、重新光栅化，三件抢一帧照样掉帧。所以第一帧只把位置落定，下一帧（双 `requestAnimationFrame`）再撤 `will-change`，见 `settleDragging()`
  - **落位那一帧不量尺寸**：`applyWindow(skipMeasure)` 跳过 `getBoundingClientRect + getComputedStyle`，改用拖动开始时记下的自然尺寸（拖动过程不改面板尺寸，这个值是准的），落位少一次强制同步布局，不会晚一帧
  - 上一次松手的回调若还没跑就又按下，先 `cancelSettle()` 撤掉，否则它会在新一轮拖动中间动一次 `will-change`
- **玻璃高光必须给变量兜底值**：`box-shadow` 里的 `var(--dsw-elevation-prominent)` 在宿主没这个变量时，属于 CSS 的 *invalid at computed-value time*——整个属性退成 `none`，**不会**回退到同一条规则块里前面那条声明。所以两个 `var()` 都写成 `var(--dsw-elevation-prominent, 0 12px 40px rgba(0,0,0,.28))`，否则玻璃棱角那圈 `inset` 高光会跟着投影一起消失（探针里 `box-shadow` 读出 `none` 就是这个坑）
- **圆点的动作走 `pointerdown` 而不是 `click`**：官方弹窗用模态层在 document 上挂捕获阶段的指针监听（点面板外就关），挂进面板的外来按钮一旦被打断，`click` 可能走不完；按下即生效，不必等一次完整点击

与官方布局的关系：模块不依赖任何哈希类名，只按 `grid-area` 认出「标题栏」和「关闭按钮区」，改写内联样式且**只写自己的属性**（`data-dsh-rail-win*`），关窗时原样撤掉，官方弹窗组件本身不动。找不到标题栏就整体退出，保持官方原样。

grid-area 的识别方式是**按后缀**匹配：官方模板写作 `"VOzbGW_title VOzbGW_header"`，`VOzbGW_` 是构建哈希、每次发版都会变，所以只看每一格是否以 `title` / `header` 结尾。

### 四个功能各自可关

窗口化的四个行为拆成四个独立开关，放在**设置 → 侧边栏条目**这一节的最上面（条目列表之上），随时可以单独关掉：

| 开关 | 键 | 关掉之后 |
| --- | --- | --- |
| 窗口控制圆点 | `lights` | 绿点、黄点整组消失，官方 × 也**退回原生 × 图标**（不会留下「两个圆点没了、× 还红着」的半残状态） |
| 按住面板任意位置拖动 | `drag` | 面板不再能拖动，光标也不再是 `grab` |
| 点标题条还原 | `restore` | 黄点被禁用（提示「需先开启」），不会最小化 |
| 最大化铺满会话区 | `maximize` | 绿点被禁用，不会再铺满 |

三个设计要点：

- **保存即生效，不用刷新。** 点开关 → 写 `localStorage` 的 `dsh-sidebar-rail.features.v1` → 内核把新状态推给已加载的模块 → 模块就地收拾自己挂的 DOM（`client.window.js` 的 `onFeaturesChanged`）。圆点会当场拆掉或重建；拖动会解绑 / 重新绑定；如果关掉某个开关时窗口正处在它造成的位置上（最小化 / 最大化），会先把窗口复位再改。
- **还原关掉时直接禁用黄点，而不是「最小化后还原不了」。** 没有还原路径的最小化是单向门——窗口收成一条之后就再也点不回来，而「设置」本身就在这个窗口里。所以宁可不让最小化。
- **开关自己不能放在轨道上。** 这些开关管的就是设置窗口本身的行为；如果圆点关掉后入口在轨道上，用户反而更难找回来。放在设置页里，关掉什么都能自己打开。

默认四个全开，与此前的行为一致。存档里缺字段、或读到脏数据，都按「开」处理，不会因为一个坏字段把功能锁死。

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
  custom, entries, hasInput, expanded, floating, floatPos,
  settingsSection, features, errors }
```

- `tagged: true` 表示已成功接管布局
- `disabled: 'collapsed' | 'switch' | null` 表示当前为什么没接管
- `anchors` 里哪一项是 `false`，就是那个锚点没找到
- `floating` / `floatPos` 是当前悬浮态与落位坐标
- `features` 是四个功能开关的当前状态（`{ lights, drag, restore, maximize }`）
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
| `probes/window-probe.cjs` | 侧栏**「从左侧栏取消固定」已隐藏、更多菜单仍保留**；设置窗口化：控制圆点在 header 行内、左绿右黄两个、与官方 × 和左侧标题同一水平线、**官方 × 换皮成 12px 红圆点（无障碍名字与 28px 热区都还在）**、**从面板正文任意非交互位置起拖都能移动**、**按住标题照样能拖**、**按在按钮上拖不走窗口**、**按钮点击仍有效**、**越界拖会被夹在边界**、**拖动期模糊/背景色/描边投影与常驻态逐项完全相同（材质不降级）**、**拖动中确实用 transform 表达位移**、**松手落位与拖动中所见完全一致（不瞬移）**、**松手后无残留 transform**、拖动移动与落盘、最大化铺满会话区且不盖竖轨、最小化与点标题条还原、刷新后位置保持、点官方 × 关闭且不残留遮罩、**用真实鼠标拖 40 步无长任务**、**拖动期间帧间隔与空闲基线一致（不丢帧）** |
| `probes/features-probe.cjs` | 功能开关：四行渲染与默认全开、关圆点后整组消失且**官方 × 退回原生外观**、关还原后黄点被禁用且点不动、关最大化后绿点被禁用且点不动、关拖动后**从面板正文起拖也不动且光标退回常态**、**关掉再打开全部恢复（含光标恢复 grab）**、刷新后四项状态原样恢复、键盘 Enter 可切换、诊断无异常 |

`drag-probe.cjs`、`float-probe.cjs`、`window-probe.cjs` 与 `features-probe.cjs` 自带静态回归台（`probes/drag-harness.html` 复刻 DSH 侧边栏与设置弹窗的 DOM 骨架 + 加载真实 `client.js`；`probes/features-harness.html` 在此基础上加了 `react` 桩与 `slots.inject` 留档，好让设置页那一节真能被挂起来），**不需要 DSH 进程**，直接 `node probes/float-probe.cjs` 即可，会自己起一个 headless Chrome。

另有 `verify-drag.cjs`：在 Node `vm` 里用带布局模型的 DOM 桩加载 `client.js`，跑 24 项断言，纯逻辑层秒级回归，无需浏览器。

`verify-modules.cjs` 专门验证**模块隔离**：在同一个 DOM 桩里逐个制造七种故障（chunk 404、factory 抛错、导出缺 `install`、`install` 抛错、四个模块同时挂掉、装好后运行期抛错、window chunk 拿不到），断言并列布局仍成立、其余模块仍在位、`diag.errors` 里有可定位的一条。这是「某个模块坏了不影响整体」这条承诺的可执行证明，改模块边界后应当先跑它：

```bash
node verify-modules.cjs
```

用法：`node probes/probe.cjs "<带令牌的页面地址>"`。

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
| `client.window.js` | 设置弹窗窗口化：拖拽移动、窗口控制圆点（最小化 / 最大化自己画，关闭则把官方 × 换个外观），以及四个功能开关的就地启停 | 设置弹窗退回官方原样 |

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

## 已知边界

- 侧边栏宽度仍受 DSH 自身 264–420px 限制（本插件不改这个上限）。窗口很窄时会比较挤，此时可以收起侧边栏用原生形态。
- 折叠态（56px）下不接管，保持原生图标条。
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
