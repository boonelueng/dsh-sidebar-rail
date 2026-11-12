// 验证在有会话的页面里点「提示词条目」是否填入当前输入框（而不是开新会话）。
// 判据：URL 的 session 不变 + 编辑器内容被替换。
// 用法：node probe-prompt-session.cjs <url>
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9336
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
      '--user-data-dir=' + join(HERE, '.probe-chrome-profile4'),
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
    if (!page) throw new Error('no page target')

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

    const end = Date.now() + 40000
    while (Date.now() < end) {
      const ok = await evalJs('typeof window.__DSH_RAIL__ !== "undefined"')
      if (ok === true) break
      await sleep(400)
    }
    await sleep(3500)

    const out = {}

    // 1) 点侧边栏里第一个历史会话行，进入有会话的页面
    out.openSession = await evalJs(`(() => {
      const rows = Array.from(document.querySelectorAll('[data-slot="sidebar.session.row.leading"], [data-slot="sidebar.session.row.trailing"]'));
      const row = rows.length ? rows[0].closest('button, a, [role="button"]') || rows[0].parentElement : null;
      if (!row) {
        // 退化：按会话标题文字找
        const cand = Array.from(document.querySelectorAll('button')).find(b => /Deep ?Seek|Obsidian|理解|侧栏/.test(b.textContent || '') && b.getBoundingClientRect().width > 120);
        if (!cand) return 'no-session-row';
        cand.click();
        return 'clicked-fallback:' + (cand.textContent || '').trim().slice(0, 20);
      }
      row.click();
      return 'clicked-row';
    })()`)
    await sleep(3000)

    out.urlBefore = await evalJs('location.href')
    out.hasInput = await evalJs('(window.__DSH_RAIL__||{}).hasInput')
    out.editorBefore = await evalJs(`(() => {
      const ed = document.querySelector('[data-lexical-editor="true"]');
      return ed ? String(ed.innerText || '').trim().slice(0, 80) : '(no-editor)';
    })()`)

    // 2) 点第一个自定义提示词条目
    out.click = await evalJs(`(() => {
      const btns = Array.from(document.querySelectorAll('[data-dsh-rail-part="custom"] .dsr-btn'));
      const b = btns.find(x => !x.classList.contains('dsr-gear'));
      if (!b) return 'no-entry-btn';
      b.click();
      return 'clicked:' + (b.getAttribute('aria-label') || '');
    })()`)
    await sleep(1800)

    out.urlAfter = await evalJs('location.href')
    out.editorAfter = await evalJs(`(() => {
      const ed = document.querySelector('[data-lexical-editor="true"]');
      return ed ? String(ed.innerText || '').trim().slice(0, 80) : '(no-editor)';
    })()`)
    out.diag = await evalJs(`(() => {
      const d = window.__DSH_RAIL__ || {};
      return { tagged: d.tagged, hasInput: d.hasInput, errors: d.errors.slice(-4) };
    })()`)

    const shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(HERE, 'shot-prompt-session.png'), Buffer.from(shot.data, 'base64'))

    writeFileSync(join(HERE, 'probe-prompt-session-result.json'), JSON.stringify(out, null, 2), 'utf8')
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
