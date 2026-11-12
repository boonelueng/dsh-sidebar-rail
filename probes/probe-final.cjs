// 终局回归：设置页「侧边栏条目」一节内 增 / 改 / 删 / 保存 → 写回左侧轨道；并确认轨道无齿轮。
// 用法：node probe-final.cjs <url>

const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9343
const HERE = __dirname
const url = process.argv[2]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json()

async function waitDevtools(t) {
  const end = Date.now() + t
  while (Date.now() < end) {
    try {
      const v = await getJson('/json/version')
      if (v && v.webSocketDebuggerUrl) return v
    } catch (_) {}
    await sleep(300)
  }
  throw new Error('devtools timeout')
}

function cdp(ws) {
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    let m
    try {
      m = JSON.parse(ev.data)
    } catch (_) {
      return
    }
    if (m.id !== undefined && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      if (m.error) reject(new Error(JSON.stringify(m.error)))
      else resolve(m.result)
    }
  })
  return (method, params) =>
    new Promise((resolve, reject) => {
      const mid = ++id
      pending.set(mid, { resolve, reject })
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }))
      setTimeout(() => {
        if (pending.has(mid)) {
          pending.delete(mid)
          reject(new Error('cdp timeout ' + method))
        }
      }, 90000)
    })
}

// 打开设置面板并进入「侧边栏条目」一节；返回是否成功
const OPEN_SECTION = `(async () => {
  const btn = document.querySelector('[data-slot="sidebar.settings"] button');
  if (!btn) return { ok: false, why: 'no-account-btn' };
  btn.click();
  let item = null;
  for (let i = 0; i < 20 && item === null; i++) {
    await new Promise((r) => setTimeout(r, 250));
    item = Array.from(document.querySelectorAll('[role="menuitem"]'))
      .find((e) => (e.textContent || '').trim().startsWith('设置')) || null;
  }
  if (!item) return { ok: false, why: 'no-menu-item' };
  item.click();
  await new Promise((r) => setTimeout(r, 1500));
  const navRow = Array.from(document.querySelectorAll('*'))
    .filter((e) => (e.textContent || '').trim() === '侧边栏条目')
    .pop();
  if (!navRow) return { ok: false, why: 'no-nav-row' };
  navRow.click();
  for (let i = 0; i < 20 && document.querySelector('.dsr-settings-host') === null; i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  const host = document.querySelector('.dsr-settings-host');
  return { ok: host !== null, hasHost: host !== null, rows: host ? host.querySelectorAll('.dsr-row').length : 0 };
})()`

async function main() {
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--user-data-dir=${join(HERE, '.probe-chrome-profile11')}`,
      `--remote-debugging-port=${PORT}`,
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  const out = { url, at: new Date().toISOString(), steps: {} }
  try {
    await waitDevtools(30000)
    const list = await getJson('/json/list')
    const page = list.find((t) => t.type === 'page')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res)
      ws.addEventListener('error', () => rej(new Error('ws')))
    })
    const send = cdp(ws)
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url })
    const evalJs = async (e) => {
      const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
      return r && r.result ? r.result.value : null
    }
    const shot = async (n) => {
      try {
        const s = await send('Page.captureScreenshot', { format: 'png' })
        if (s && s.data) writeFileSync(join(HERE, n), Buffer.from(s.data, 'base64'))
      } catch (_) {}
    }

    const end = Date.now() + 40000
    while (Date.now() < end) {
      await sleep(1200)
      if (await evalJs('typeof window.__DSH_RAIL__ !== "undefined"')) break
    }
    await sleep(2500)

    // 0) 基线：轨道上是否还有齿轮
    out.steps.baseline = await evalJs(`(() => {
      const rail = document.querySelector('[data-dsh-rail-mount="true"]');
      return {
        gearCount: document.querySelectorAll('.dsr-gear').length,
        toggleCount: document.querySelectorAll('.dsr-toggle').length,
        railLabels: rail ? Array.from(rail.querySelectorAll('.dsr-btn')).map((b) => b.getAttribute('aria-label')) : [],
        diag: { tagged: window.__DSH_RAIL__.tagged, settingsSection: window.__DSH_RAIL__.settingsSection },
      };
    })()`)

    // 1) 打开设置页的「侧边栏条目」
    out.steps.openSection = await evalJs(OPEN_SECTION)
    await shot('shot-final-open.png')

    // 2) 添加一条
    out.steps.add = await evalJs(`(async () => {
      const host = document.querySelector('.dsr-settings-host');
      if (!host) return { ok: false, why: 'no-host' };
      const btn = (t) => Array.from(host.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === t);
      const add = btn('添加条目');
      if (!add) return { ok: false, why: 'no-add', text: String(host.innerText || '').slice(0, 200) };
      add.click();
      await new Promise((r) => setTimeout(r, 500));
      const inputs = host.querySelectorAll('input');
      if (inputs[1]) { inputs[1].value = '设置页测试'; inputs[1].dispatchEvent(new Event('input', { bubbles: true })); }
      if (inputs[0]) { inputs[0].value = '★'; inputs[0].dispatchEvent(new Event('input', { bubbles: true })); }
      await new Promise((r) => setTimeout(r, 300));
      const save = btn('保存');
      if (!save) return { ok: false, why: 'no-save' };
      save.click();
      await new Promise((r) => setTimeout(r, 900));
      const rail = document.querySelector('[data-dsh-rail-mount="true"]');
      return {
        ok: true,
        stored: localStorage.getItem('dsh-sidebar-rail.custom.v1'),
        railLabels: rail ? Array.from(rail.querySelectorAll('.dsr-btn')).map((b) => b.getAttribute('aria-label')) : [],
        rows: host.querySelectorAll('.dsr-row').length,
      };
    })()`)
    await shot('shot-final-added.png')

    // 3) 刷新后仍在（持久化）
    await send('Page.reload')
    await sleep(6000)
    const readyEnd = Date.now() + 30000
    while (Date.now() < readyEnd) {
      if (await evalJs('typeof window.__DSH_RAIL__ !== "undefined" && window.__DSH_RAIL__.tagged === true')) break
      await sleep(1000)
    }
    await sleep(1200)
    out.steps.afterReload = await evalJs(`(() => {
      const rail = document.querySelector('[data-dsh-rail-mount="true"]');
      return {
        railLabels: rail ? Array.from(rail.querySelectorAll('.dsr-btn')).map((b) => b.getAttribute('aria-label')) : [],
        stored: localStorage.getItem('dsh-sidebar-rail.custom.v1'),
        gearCount: document.querySelectorAll('.dsr-gear').length,
      };
    })()`)

    // 4) 再进设置页删除该条
    out.steps.deleteStep = await evalJs(`(async () => {
      const opened = await (async () => ${OPEN_SECTION})();
      if (!opened.ok) return { ok: false, why: 'no-host', opened };
      const host = document.querySelector('.dsr-settings-host');
      const rows = Array.from(host.querySelectorAll('.dsr-row'));
      const target = rows[rows.length - 1];
      const del = Array.from(target.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '删除');
      if (!del) return { ok: false, why: 'no-delete' };
      del.click();
      await new Promise((r) => setTimeout(r, 400));
      const save = Array.from(host.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '保存');
      if (save) save.click();
      await new Promise((r) => setTimeout(r, 900));
      const rail = document.querySelector('[data-dsh-rail-mount="true"]');
      return {
        ok: true,
        railLabels: rail ? Array.from(rail.querySelectorAll('.dsr-btn')).map((b) => b.getAttribute('aria-label')) : [],
        rowsAfter: host.querySelectorAll('.dsr-row').length,
      };
    })()`)
    await shot('shot-final-deleted.png')

    await evalJs(`(() => { localStorage.removeItem('dsh-sidebar-rail.custom.v1'); localStorage.removeItem('dsh-sidebar-rail.railExpanded.v1'); return true; })()`)

    writeFileSync(join(HERE, 'final-result.json'), JSON.stringify(out, null, 2), 'utf8')
    console.log(JSON.stringify(out.steps, null, 2))
    ws.close()
  } finally {
    try {
      child.kill()
    } catch (_) {}
  }
}

main().catch((e) => {
  console.error('FAILED:', e && e.message)
  process.exit(1)
})
