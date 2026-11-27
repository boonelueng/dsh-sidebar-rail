#!/usr/bin/env node
/**
 * 跨版本契约回归 —— 把「插件依赖了 DSH 的哪些东西」逐条拿到多个 DSH 版本的
 * 真实产物上核对，而不是靠记忆或版本号猜。
 *
 * 为什么需要它：插件是纯 DOM/槽位增强，依赖点散在几个官方包里
 * （sidebar / settings-general / renderer / client-modules / ui-slots /
 * conversation）。官方改一次类名或换一次布局，插件就会静默降级，
 * 而这种降级在单一版本上手测不出来——只有横着摆一排版本才看得见。
 *
 * 用法：
 *   node verify-compat.cjs [--root <解包目录>]
 *
 * 解包目录的准备（每个版本一个子目录，里面是 npm 包解包后的 package/）：
 *   npm pack @deepseek-ai/dsh-client-ui-sidebar@0.2.1-rc.1
 *   tar -xzf deepseek-ai-dsh-client-ui-sidebar-0.2.1-rc.1.tgz
 * 本仓库的探针默认读 D:\Obsidian\dsh-compat-tmp，可用 --root 覆盖。
 *
 * 设计原则：**只报事实，不报结论**。每条契约输出「在哪些版本上成立」，
 * 由人判断这算不算破坏性差异。缺目录/缺文件的版本记为 SKIP，不记为 FAIL
 * ——否则拿不到 tarball 就等于「兼容性坏了」，那是假信号。
 */

const fs = require("node:fs");
const path = require("node:path");

const argRoot = (() => {
  const i = process.argv.indexOf("--root");
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : "D:\\Obsidian\\dsh-compat-tmp";
})();

/** 版本 → 各类包的解包子目录前缀。插件只关心这几个包。 */
const VERSIONS = [
  "0.1.7-rc.2",
  "0.2.0-rc.2",
  "0.2.1-rc.1",
  "0.2.2-rc.5",
  "0.2.3-alpha.2",
];

/**
 * 每个包的类型前缀（与解包脚本保持一致）：
 *   v  = dsh-client-ui-sidebar
 *   sg = dsh-client-ui-settings-general
 *   set= dsh-client-ui-settings（0.2.1 之前的单体设置）
 *   rd = dsh-client-ui-renderer（产出 [data-slot] 锚点）
 *   cm = dsh-client-modules（chunk 加载 / __DSH_BOOT__）
 *   sl = dsh-client-ui-slots（inject/register 契约，随 runner 提供）
 *   conv= dsh-client-ui-conversation（conversation.input.left 槽）
 *   lay = dsh-client-ui-layout（AppFrame / [data-sidebar-collapsed] / layout 服务）
 *   ws  = dsh-client-ui-workspace（工作区标题行与搜索框）
 */
const PACKAGES = {
  sidebar: "v",
  settingsGeneral: "sg",
  settingsLegacy: "set",
  renderer: "rd",
  clientModules: "cm",
  slots: "sl",
  conversation: "conv",
  layout: "lay",
  workspace: "ws",
};

/** 各包可能的主源码文件名（编译产物不统一，有的叫 client.js，有的叫 index.js） */
const ENTRY_FILES = [
  path.join("lib", "client.js"),
  path.join("lib", "index.js"),
  path.join("package", "lib", "client.js"),
  path.join("package", "lib", "index.js"),
];

function pkgDir(kind, version) {
  const prefix = PACKAGES[kind];
  const candidates = [`${prefix}${version}`];
  for (const name of candidates) {
    const dir = path.join(argRoot, name);
    if (!fs.existsSync(dir)) continue;
    for (const rel of ENTRY_FILES) {
      const file = path.join(dir, rel);
      if (fs.existsSync(file)) return file;
    }
    // 没命中已知入口就递归找一个 .js 交差（只在前两层找，避免扫 src 树）
    const libDir = path.join(dir, "lib");
    if (fs.existsSync(libDir)) {
      const js = fs.readdirSync(libDir).find((f) => f.endsWith(".js"));
      if (js !== undefined) return path.join(libDir, js);
    }
  }
  return null;
}

function read(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    return null;
  }
}

/**
 * 契约表。每条 = 插件里真实存在的一句依赖，配一个「在源码里怎么算成立」的判据。
 * where 指向插件中用到它的位置，方便改判据时回查。
 */
const CONTRACTS = [
  {
    id: "slot.sidebar.workspaces",
    pkg: "sidebar",
    what: '侧边栏锚点 [data-slot="sidebar.workspaces"]',
    where: "client.js:40 SEL_WORKSPACES",
    // renderer 负责把锚点渲出来，所以真身看 renderer；sidebar 里只应出现 renderSlot 调用
    probe: (src) => /sidebar\.workspaces/.test(src),
  },
  {
    id: "slot.sidebar.panellist",
    pkg: "sidebar",
    what: '侧边栏锚点 [data-slot="sidebar.panellist"]',
    where: "client.js:41 SEL_PANELLIST",
    probe: (src) => /sidebar\.panellist/.test(src),
  },
  {
    id: "slot.sidebar.brand.mark",
    pkg: "sidebar",
    what: '侧边栏锚点 [data-slot="sidebar.brand.mark"]',
    where: "client.js:42 SEL_BRAND",
    probe: (src) => /sidebar\.brand\.mark/.test(src),
  },
  {
    id: "slot.sidebar.settings",
    pkg: "sidebar",
    what: '侧边栏锚点 [data-slot="sidebar.settings"]',
    where: "client.js:43 SEL_SETTINGS",
    probe: (src) => /sidebar\.settings/.test(src),
  },
  {
    id: "dom.data-slot.emitter",
    pkg: "renderer",
    what: "插槽锚点由 renderer 统一写成 data-slot 属性",
    where: "全插槽定位的地基",
    probe: (src) => /"data-slot"/.test(src) || /data-slot/.test(src),
  },
  {
    id: "dom.data-sidebar-collapsed",
    pkg: "sidebar",
    what: "折叠态靠 [data-sidebar-collapsed] 表达",
    where: "client.js:isCollapsed()",
    probe: (src) => /data-sidebar-collapsed/.test(src),
  },
  {
    id: "dom.data-sidebar-drawer",
    pkg: "sidebar",
    what: "[data-sidebar-drawer]（插件里的便宜探测点，缺了也能活）",
    where: "client.js:isCollapsed() 第二判据",
    optional: true,
    probe: (src) => /data-sidebar-drawer/.test(src),
  },
  {
    id: "dom.panel.shortcut-modal",
    pkg: "settingsGeneral",
    what: '设置弹窗面板 [data-shortcut-modal="settings"]',
    where: "client.window.js PANEL_SEL",
    probe: (src) => /data-shortcut-modal/.test(src),
  },
  {
    id: "dom.panel.close-button",
    pkg: "settingsGeneral",
    what: '官方关闭按钮 button[class*="close"]（大小写不敏感匹配）',
    where: "client.window.js 二级探测 header 定位",
    probe: (src) => /close/.test(src),
  },
  {
    id: "layout.grid-area",
    pkg: "settingsGeneral",
    what: "标题栏/按钮行用 grid-area 命名（一级探测）",
    where: "client.window.js locateTitleAndHeader 一级",
    // 这条是「有更好、没有也行」：没有时走二级结构兜底
    optional: true,
    probe: (src) => /grid-area/.test(src),
  },
  {
    id: "layout.flex-header",
    pkg: "settingsGeneral",
    what: "旧版 flex 布局（无 grid-area，靠 close 所在行兜底）",
    where: "client.window.js locateTitleAndHeader 二级",
    optional: true,
    probe: (src) => /display:\s*flex/.test(src) || /flex-direction/.test(src),
  },
  {
    id: "slot.settings.section",
    pkg: "settingsGeneral",
    what: 'settings.section 槽（设置页里塞「侧边栏条目」）',
    where: "client.js:34 SETTINGS_SECTION",
    probe: (src) => /settings\.section/.test(src),
  },
  {
    id: "slot.settings.section.icon",
    pkg: "settingsGeneral",
    what: "settings.section.icon 槽（可选：设置项图标）",
    where: "client.js:apply() settings.section.icon 注册（已 try/catch）",
    optional: true,
    probe: (src) => /settings\.section\.icon/.test(src),
  },
  {
    id: "slot.conversation.input.left",
    pkg: "conversation",
    what: "conversation.input.left 槽（输入框左侧动作区）",
    where: "client.js:45 INPUT_SLOT",
    probe: (src) => /conversation\.input\.left/.test(src),
  },
  {
    id: "host.module-loader",
    pkg: "clientModules",
    what: "window.__ModuleLoader__.load({id, factory}) 入口",
    where: "client.js:10 模块入口",
    probe: (src) => /__ModuleLoader__/.test(src),
  },
  {
    id: "host.chunk-pattern",
    pkg: "clientModules",
    what: "client.*.js 子 chunk 加载（require.async）",
    where: "client.js:loadModules()",
    probe: (src) => /require\.(async|resolve)/.test(src) || /CLIENT_CHUNK/.test(src),
  },
  {
    id: "host.boot-release",
    pkg: "clientModules",
    what: "__DSH_BOOT__.release.version（仅用于诊断，不作分支依据）",
    where: "client.js:probeCompat()",
    optional: true,
    probe: (src) => /release/.test(src),
  },
  {
    id: "host.slots-inject-register",
    pkg: "slots",
    what: "slots.inject / slots.register 契约",
    where: "client.js:apply() 槽位注册",
    probe: (src) => /inject/.test(src) && /register/.test(src),
  },
  {
    id: "host.layout.toggleSidebar",
    pkg: "layout",
    what: "layout 服务的 toggleSidebar()（工作区一键展开/收起的主路径）",
    where: "client.js:toggleWorkspace() ① 服务优先",
    probe: (src) => /toggleSidebar/.test(src),
  },
  {
    id: "dom.data-sidebar-opener",
    pkg: "sidebar",
    what: "[data-sidebar-opener]（0.2.2+ 侧栏外的打开按钮，折叠态也能点）",
    where: "client.js:findSidebarToggleButton() ①",
    optional: true,
    probe: (src) => /data-sidebar-opener/.test(src),
  },
  {
    id: "dom.data-sidebar-toggle",
    pkg: "sidebar",
    what: "[data-sidebar-toggle]（0.2.2+ 侧栏内的收起按钮）",
    where: "client.js:findSidebarToggleButton() ②",
    optional: true,
    probe: (src) => /data-sidebar-toggle/.test(src),
  },
  {
    id: "i18n.toggle-labels",
    pkg: "sidebar",
    what: "官方折叠按钮的 aria-label 文案（toggle.open / toggle.collapse）",
    where: "client.js:findSidebarToggleButton() ③ 无障碍名兜底",
    optional: true,
    probe: (src) => /toggle\.open|toggle\.collapse/.test(src),
  },
  {
    id: "dom.data-sidebar-workspace-header",
    pkg: "workspace",
    what: "[data-sidebar-workspace-header]（0.2.2+ 工作区标题行，一键展开/收起入口的落脚点）",
    where: "client.js:findWorkspaceHeader() ① 直接命中",
    optional: true,
    probe: (src) => /data-sidebar-workspace-header/.test(src),
  },
  {
    id: "dom.workspace-search-input",
    pkg: "workspace",
    what: "标题行里的搜索框（上面那个属性缺失时，靠 input 反推标题行与插入位）",
    where: "client.js:findWorkspaceHeader() ② / findSearchSlot()",
    optional: true,
    probe: (src) => /searchInput/.test(src),
  },
];

function main() {
  console.log("跨版本契约回归 (verify-compat)");
  console.log("解包目录: " + argRoot);
  console.log("");
  if (!fs.existsSync(argRoot)) {
    console.log("找不到解包目录。先按文件头说明 npm pack + 解包，或用 --root 指定。");
    process.exitCode = 1;
    return;
  }

  // 先建立「版本 → 各包源码」的索引，后面每条契约都复用它
  const sources = new Map();
  for (const version of VERSIONS) {
    const entry = {};
    for (const kind of Object.keys(PACKAGES)) {
      const file = pkgDir(kind, version);
      entry[kind] = file === null ? null : read(file);
    }
    sources.set(version, entry);
  }

  const pad = (s, n) => String(s).padEnd(n, " ");
  const short = (v) => v.replace(/^0\./, "");

  let failed = 0;
  let checked = 0;

  for (const contract of CONTRACTS) {
    const cells = [];
    let okCount = 0;
    let availCount = 0;
    for (const version of VERSIONS) {
      const src = sources.get(version)[contract.pkg];
      if (src === null) {
        cells.push({ version, state: "skip" });
        continue;
      }
      availCount += 1;
      const ok = contract.probe(src);
      if (ok) okCount += 1;
      cells.push({ version, state: ok ? "ok" : "miss" });
    }

    const optional = contract.optional === true;
    const bad = cells.some((c) => c.state === "miss");
    const verdict = availCount === 0
      ? "SKIP"
      : bad
        ? (optional ? "DEGRADE-OK" : "BREAK")
        : "OK";

    if (verdict === "BREAK") failed += 1;
    if (availCount > 0) checked += 1;

    console.log(`[${verdict}] ${contract.id}`);
    console.log(`        ${contract.what}`);
    console.log(`        用在: ${contract.where}`);
    if (optional) console.log("        性质: 可选（缺失时插件自动降级，不算破坏）");
    const line = cells.map((c) => {
      const mark = c.state === "ok" ? "✓" : c.state === "miss" ? "✗" : "·";
      return `${short(c.version)}${mark}`;
    }).join("  ");
    console.log("        " + line);
    console.log("");
  }

  console.log("说明: ✓ 成立 / ✗ 不成立 / · 该版本包未解包（跳过）");
  console.log('');
  if (failed === 0) {
    console.log(`ALL PASS (${checked} contracts)`);
  } else {
    console.log(`FAIL (${failed}/${checked} contracts 不成立)`);
    process.exitCode = 1;
  }
}

main();
