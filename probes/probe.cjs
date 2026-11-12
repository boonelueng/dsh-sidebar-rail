// 用 CDP 驱动本机 Chrome，真实打开 DSH GUI，读取侧边栏实际几何。
// 用法：node probe.cjs <url>
// 输出：JSON（写到本目录 probe-result.json 并打印摘要）

const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9333
const HERE = __dirname
const url = process.argv[2]

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function getJson(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`)
  return res.json()
}

async function waitForDevtools(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const v = await getJson('/json/version')
      if (v && v.webSocketDebuggerUrl) return v
    } catch (_) {}
    await sleep(300)
  }
  throw new Error('devtools endpoint did not come up')
}

function cdp(ws) {
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    let msg
    try {
      msg = JSON.parse(ev.data)
    } catch (_) {
      return
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  })
  return function send(method, params, sessionId) {
    const mid = ++id
    return new Promise((resolve, reject) => {
      pending.set(mid, { resolve, reject })
      ws.send(JSON.stringify({ id: mid, method, params: params || {}, sessionId }))
      setTimeout(() => {
        if (pending.has(mid)) {
          pending.delete(mid)
          reject(new Error('cdp timeout: ' + method))
        }
      }, 90000)
    })
  }
}

const EXPR = `(() => {
  const diag = window.__DSH_RAIL__ || null;
  const q = (s) => document.querySelector(s);
  const root = q('[data-dsh-rail-root]');
  const nav = q('[data-dsh-rail-part="nav"]');
  const region = q('[data-dsh-rail-part="region"]');
  const mount = q('[data-dsh-rail-part="custom"]');
  const wsSlot = q('[data-slot="sidebar.workspaces"]');
  const col = root ? (root.closest('[class*="sidebarCol"]') || root.parentElement) : null;
  const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  const outline = (n, depth, max) => {
    if (!n || depth > max) return [];
    const kids = Array.from(n.children || []);
    const self = [{ depth, tag: n.tagName ? n.tagName.toLowerCase() : String(n.nodeName), id: n.id || null, cls: String(n.className || '').slice(0, 70), slot: n.getAttribute ? n.getAttribute('data-slot') : null, box: box(n) }];
    for (const k of kids) self.push(...outline(k, depth + 1, max));
    return self;
  };
  const body = document.body;
  return JSON.stringify({
    ready: document.readyState,
    hasBoot: typeof window.__DSH_BOOT__ !== 'undefined',
    bodyChildCount: body ? body.children.length : -1,
    allSlots: Array.from(document.querySelectorAll('[data-slot]')).map((e) => e.getAttribute('data-slot')).slice(0, 60),
    diag: diag ? { loaded: diag.loaded, tagged: diag.tagged, disabled: diag.disabled, anchors: diag.anchors, custom: diag.custom, entries: diag.entries, errors: diag.errors.slice(-8) } : null,
    styleInjected: document.querySelector('style[data-plugin="dsh-sidebar-rail"]') !== null,
    boxes: { col: box(col), root: box(root), nav: box(nav), region: box(region), mount: box(mount), wsSlot: box(wsSlot) },
    navCount: nav ? nav.querySelectorAll('button').length : 0,
    navButtons: nav ? Array.from(nav.querySelectorAll('button')).map((b) => ({ label: b.getAttribute('aria-label'), current: b.getAttribute('aria-current'), expanded: b.getAttribute('aria-expanded'), hiddenKids: Array.from(b.children).filter((c) => c.hasAttribute('data-dsh-rail-hide')).length, box: box(b) })) : [],
    rootChildren: root ? Array.from(root.children).map((c) => ({ tag: c.tagName.toLowerCase(), part: c.getAttribute('data-dsh-rail-part'), cls: String(c.className || '').slice(0, 60), box: box(c) })) : [],
    sessionRows: document.querySelectorAll('[data-slot="sidebar.workspaces.session.row.action"]').length,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    bodyOutline: outline(body, 0, 6).slice(0, 90),
    textSample: body ? String(body.innerText || '').slice(0, 400) : '',
    style: (() => {
      const pick = (n, props) => {
        if (!n) return null;
        const cs = getComputedStyle(n);
        const o = {};
        for (const p of props) o[p] = cs.getPropertyValue(p);
        return o;
      };
      return {
        root: pick(root, ['position', 'padding-top', 'padding-left', 'padding-right', 'border-top-width', 'border-left-width', 'box-sizing', 'display']),
        nav: pick(nav, ['position', 'left', 'top', 'bottom', 'width', 'margin-left', 'padding-left', 'z-index', 'display']),
        region: pick(region, ['position', 'margin-left', 'padding-left', 'width', 'overflow']),
        custom: pick(mount, ['position', 'left', 'bottom', 'width', 'height']),
        railVars: root ? { top: root.style.getPropertyValue('--dsr-rail-top'), bottom: root.style.getPropertyValue('--dsr-rail-bottom'), customH: root.style.getPropertyValue('--dsr-custom-h') } : null,
      };
    })(),
  });
})()`

async function main() {
  const tmpProfile = join(HERE, '.probe-chrome-profile')
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--user-data-dir=${tmpProfile}`,
      `--remote-debugging-port=${PORT}`,
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  )

  try {
    await waitForDevtools(30000)
    const targets = await getJson('/json/list')
    const page = targets.find((t) => t.type === 'page')
    if (!page) throw new Error('no page target')

    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve)
      ws.addEventListener('error', () => reject(new Error('ws error')))
    })
    const send = cdp(ws)

    await send('Page.enable')
    await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url })

    // 等 DSH 前端挂载完成（最多 40s）
    const deadline = Date.now() + 40000
    let sawDiag = false
    while (Date.now() < deadline) {
      await sleep(1500)
      try {
        const r = await send('Runtime.evaluate', {
          expression: 'typeof window.__DSH_RAIL__ !== "undefined"',
          returnByValue: true,
        })
        if (r && r.result && r.result.value === true) {
          sawDiag = true
          break
        }
      } catch (_) {}
    }

    // 再等 3s 让 sync/几何稳定
    await sleep(3000)
    const out = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: false })
    const value = out && out.result ? out.result.value : null
    const parsed = value ? JSON.parse(value) : null

    const report = { sawDiag, url, at: new Date().toISOString(), probe: parsed }
    writeFileSync(join(HERE, 'probe-result.json'), JSON.stringify(report, null, 2), 'utf8')

    // 顺便截个图，便于判断视觉
    try {
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      if (shot && shot.data) {
        writeFileSync(join(HERE, 'probe-shot.png'), Buffer.from(shot.data, 'base64'))
      }
    } catch (_) {}

    console.log(JSON.stringify(report, null, 2))
    ws.close()
  } finally {
    try {
      child.kill()
    } catch (_) {}
  }
}

main().catch((err) => {
  console.error('PROBE FAILED:', err && err.message)
  process.exit(1)
})
