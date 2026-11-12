// 打开设置后，全量 dump body 树，定位「侧边栏条目」一节及其宿主。
// 用法：node probe-panel2.cjs <url>

const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9342
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

async function main() {
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--user-data-dir=${join(HERE, '.probe-chrome-profile10')}`,
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

    out.steps.open = await evalJs(`(async () => {
      const btn = document.querySelector('[data-slot="sidebar.settings"] button');
      if (!btn) return { ok: false, why: 'no-btn' };
      btn.click();
      let item = null;
      for (let i = 0; i < 20 && item === null; i++) {
        await new Promise((r) => setTimeout(r, 250));
        item = Array.from(document.querySelectorAll('[role="menuitem"]'))
          .find((e) => (e.textContent || '').trim().startsWith('设置')) || null;
      }
      if (!item) return { ok: false, why: 'no-item' };
      item.click();
      await new Promise((r) => setTimeout(r, 1500));
      return {
        ok: true,
        dialogs: document.querySelectorAll('[role="dialog"]').length,
        sectionSlots: document.querySelectorAll('[data-slot="settings.section"]').length,
        hasOurText: String(document.body.innerText || '').includes('侧边栏条目'),
        hasHost: document.querySelector('.dsr-settings-host') !== null,
      };
    })()`)
    await shot('shot-panel2-open.png')

    out.steps.outline = await evalJs(`(() => {
      const rows = [];
      const walk = (node, depth) => {
        if (rows.length > 200 || depth > 10) return;
        for (const c of Array.from(node.children)) {
          const r = c.getBoundingClientRect();
          const t = (c.textContent || '').trim().slice(0, 30);
          const slot = c.getAttribute('data-slot');
          const cls = String(c.className || '').slice(0, 60);
          if (r.width > 0 && r.height > 0 && (t.length > 0 || slot !== null)) {
            rows.push({ d: depth, tag: c.tagName.toLowerCase(), cls, slot, text: t, box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } });
          }
          walk(c, depth + 1);
        }
      };
      walk(document.body, 0);
      return { count: rows.length, rows };
    })()`)

    out.steps.ourSection = await evalJs(`(async () => {
      const hits = Array.from(document.querySelectorAll('*')).filter((e) => {
        const t = (e.textContent || '').trim();
        return t === '侧边栏条目';
      });
      if (hits.length === 0) return { found: false };
      const el = hits[hits.length - 1];
      const r = el.getBoundingClientRect();
      el.click();
      await new Promise((res) => setTimeout(res, 1000));
      const host = document.querySelector('.dsr-settings-host');
      return {
        found: true, tag: el.tagName.toLowerCase(), count: hits.length,
        box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        hasHost: host !== null,
        hostText: host ? String(host.innerText || '').slice(0, 260) : null,
        sectionSlots: document.querySelectorAll('[data-slot="settings.section"]').length,
      };
    })()`)
    await shot('shot-panel2-section.png')

    writeFileSync(join(HERE, 'panel2-result.json'), JSON.stringify(out, null, 2), 'utf8')
    console.log('open:', JSON.stringify(out.steps.open))
    console.log('outline rows:', out.steps.outline && out.steps.outline.count)
    console.log('ourSection:', JSON.stringify(out.steps.ourSection))
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
