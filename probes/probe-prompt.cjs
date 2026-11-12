// 专门验证「提示词类自定义条目」是否真的把文字填进输入框。
// 输入框是 Lexical 的 contenteditable（[data-lexical-editor="true"]），不是 textarea，
// 所以上一版探针读 textarea.value 得到空串属于测法错误，不能据此判定功能失效。
// 用法：node probe-prompt.cjs <url>
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9335
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
      '--user-data-dir=' + join(HERE, '.probe-chrome-profile3'),
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

    // 等插件加载完
    const end = Date.now() + 40000
    let ready = false
    while (Date.now() < end) {
      const ok = await evalJs('typeof window.__DSH_RAIL__ !== "undefined"')
      if (ok === true) {
        ready = true
        break
      }
      await sleep(400)
    }
    if (!ready) throw new Error('plugin diag never appeared')
    await sleep(3500)

    const out = {}
    out.diag0 = await evalJs(`(() => {
      const d = window.__DSH_RAIL__ || {};
      return { tagged: d.tagged, hasInput: d.hasInput, entries: d.entries, errors: d.errors.slice(-3) };
    })()`)

    // 编辑器内容的统一读法：Lexical contenteditable
    const READ_EDITOR = `(() => {
      const ed = document.querySelector('[data-lexical-editor="true"]');
      if (!ed) return { found: false };
      return { found: true, text: String(ed.innerText || ed.textContent || '').trim() };
    })()`

    out.editorBefore = await evalJs(READ_EDITOR)

    // 点第一个自定义条目（✎ 审查改动）
    out.click = await evalJs(`(() => {
      const btns = Array.from(document.querySelectorAll('[data-dsh-rail-part="custom"] .dsr-btn'));
      const b = btns.find(x => !x.classList.contains('dsr-gear'));
      if (!b) return 'no-entry-btn';
      b.click();
      return 'clicked:' + (b.getAttribute('aria-label') || '');
    })()`)
    await sleep(1500)
    out.editorAfter = await evalJs(READ_EDITOR)

    const shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(HERE, 'shot-prompt2.png'), Buffer.from(shot.data, 'base64'))

    out.diag1 = await evalJs(`(() => {
      const d = window.__DSH_RAIL__ || {};
      return { tagged: d.tagged, hasInput: d.hasInput, errors: d.errors.slice(-5) };
    })()`)

    writeFileSync(join(HERE, 'probe-prompt-result.json'), JSON.stringify(out, null, 2), 'utf8')
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
