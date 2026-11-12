// 验证：编辑器保存后落 localStorage 且刷新后仍在；「更多」菜单仍可打开。
// 用法：node probe-persist.cjs <url>
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9337
const HERE = __dirname
const url = process.argv[2]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(p) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`)
  return r.json()
}

async function waitDevtools() {
  const end = Date.now() + 30000
  while (Date.now() < end) {
    try {
      const v = await getJson('/json/version')
      if (v && v.webSocketDebuggerUrl) return
    } catch (_) {}
    await sleep(300)
  }
  throw new Error('devtools not up')
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
  return (method, params) => {
    const mid = ++id
    return new Promise((resolve, reject) => {
      pending.set(mid, { resolve, reject })
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }))
      setTimeout(() => {
        if (pending.has(mid)) {
          pending.delete(mid)
          reject(new Error('timeout ' + method))
        }
      }, 60000)
    })
  }
}

async function main() {
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--user-data-dir=' + join(HERE, '.probe-chrome-profile5'),
      '--remote-debugging-port=' + PORT,
      '--window-size=1440,900',
      'about:blank',
    ],
    { detached: false, stdio: 'ignore' }
  )

  try {
    await waitDevtools()
    const list = await getJson('/json/list')
    const page = list.find((t) => t.type === 'page')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res)
      ws.addEventListener('error', rej)
    })
    const send = cdp(ws)

    await send('Page.enable')
    await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url })

    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) return { __error: JSON.stringify(r.exceptionDetails).slice(0, 300) }
      return r.result.value
    }

    const waitDiag = async () => {
      const end = Date.now() + 40000
      while (Date.now() < end) {
        if ((await evalJs('typeof window.__DSH_RAIL__ !== "undefined"')) === true) return true
        await sleep(400)
      }
      return false
    }

    const out = {}
    await waitDiag()
    await sleep(3000)

    // 清掉可能残留的旧数据，回到默认两条
    await evalJs(`localStorage.removeItem('dsh-sidebar-rail.custom.v1')`)
    await send('Page.reload', {})
    await sleep(1000)
    await waitDiag()
    await sleep(3500)

    out.baseline = await evalJs(`(() => {
      const b = Array.from(document.querySelectorAll('[data-dsh-rail-part="custom"] .dsr-btn')).map(x => x.getAttribute('aria-label'));
      return { buttons: b, stored: localStorage.getItem('dsh-sidebar-rail.custom.v1') };
    })()`)

    // 打开编辑器 → 新增一条 → 填名 → 保存
    out.addEntry = await evalJs(`(() => {
      document.querySelector('.dsr-gear').click();
      const add = Array.from(document.querySelectorAll('.dsr-foot button')).find(b => b.textContent.trim() === '添加条目');
      if (!add) return 'no-add';
      add.click();
      return 'form-open';
    })()`)
    await sleep(400)

    out.fill = await evalJs(`(() => {
      const fields = Array.from(document.querySelectorAll('.dsr-field'));
      const labelInput = fields.map(f => f.querySelector('input')).find(Boolean);
      const iconInput = fields.filter(f => f.querySelector('input')).map(f => f.querySelector('input'))[1];
      if (!labelInput) return 'no-label-input';
      labelInput.value = '测试条目';
      labelInput.dispatchEvent(new Event('input', { bubbles: true }));
      if (iconInput) {
        iconInput.value = '★';
        iconInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return 'filled';
    })()`)
    await sleep(300)

    out.save = await evalJs(`(() => {
      const save = Array.from(document.querySelectorAll('.dsr-foot button')).find(b => b.textContent.trim() === '保存');
      if (!save) return 'no-save';
      save.click();
      return document.querySelector('.dsr-card') ? 'still-open' : 'closed';
    })()`)
    await sleep(800)

    out.afterSave = await evalJs(`(() => {
      const b = Array.from(document.querySelectorAll('[data-dsh-rail-part="custom"] .dsr-btn')).map(x => x.getAttribute('aria-label'));
      const raw = localStorage.getItem('dsh-sidebar-rail.custom.v1');
      let parsed = null;
      try { parsed = JSON.parse(raw || 'null'); } catch (_) {}
      return { buttons: b, count: Array.isArray(parsed) ? parsed.length : -1, labels: Array.isArray(parsed) ? parsed.map(e => e.label) : [] };
    })()`)

    // 刷新验证持久化
    await send('Page.reload', {})
    await sleep(1500)
    await waitDiag()
    await sleep(4000)
    out.afterReload = await evalJs(`(() => {
      const b = Array.from(document.querySelectorAll('[data-dsh-rail-part="custom"] .dsr-btn')).map(x => x.getAttribute('aria-label'));
      return { buttons: b };
    })()`)

    // 「更多」菜单
    out.moreMenu = await evalJs(`(() => {
      const nav = document.querySelector('[data-dsh-rail-root] > [data-dsh-rail-part="nav"]');
      if (!nav) return 'no-nav';
      const more = Array.from(nav.querySelectorAll('button')).find(b => b.getAttribute('aria-haspopup') === 'menu');
      if (!more) return 'no-more-btn';
      more.click();
      return 'clicked-more';
    })()`)
    await sleep(900)
    out.moreMenuOpen = await evalJs(`(() => {
      const menu = document.querySelector('[role="menu"]');
      return menu ? { open: true, items: menu.querySelectorAll('[role="menuitem"], button').length } : { open: false };
    })()`)
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(HERE, 'shot-more-menu.png'), Buffer.from(shot.data, 'base64'))

    // 收尾：清掉测试条目，恢复默认
    await evalJs(`localStorage.removeItem('dsh-sidebar-rail.custom.v1')`)

    writeFileSync(join(HERE, 'probe-persist-result.json'), JSON.stringify(out, null, 2), 'utf8')
    console.log(JSON.stringify(out, null, 2))
    ws.close()
  } finally {
    try {
      child.kill()
    } catch (_) {}
  }
}

main().catch((e) => {
  console.error('PROBE FAILED:', e && e.message)
  process.exit(1)
})
