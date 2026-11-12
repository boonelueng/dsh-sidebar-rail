// dsh-sidebar-rail — 宿主侧入口。
//
// 浏览器端（./client.js）负责把 DSH 左侧边栏改成「左窄条功能区 + 右侧会话区」并列；
// 宿主侧只做一件事：开一条本地回传通道，让浏览器端把运行时诊断写进
//   <本目录>/last-report.json
// 这样排查时不需要用户手动开控制台抄 __DSH_RAIL__。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-sidebar-rail'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPORT_FILE = join(HERE, 'last-report.json')

function writeReport(payload) {
  try {
    mkdirSync(HERE, { recursive: true })
    writeFileSync(REPORT_FILE, JSON.stringify(payload, null, 2), 'utf8')
    return true
  } catch (_) {
    return false
  }
}

function readReport() {
  try {
    return readFileSync(REPORT_FILE, 'utf8')
  } catch (_) {
    return '{"report":null}'
  }
}

export function apply(ctx) {
  if (!ctx || typeof ctx.inject !== 'function') return

  // 把带启动令牌的页面地址写到本目录，供本地无头浏览器直接打开做端到端验证。
  // 只落本地文件，不通过 HTTP 暴露，避免令牌外泄。
  ctx.inject(['connection'], (connCtx) => {
    try {
      const conn = connCtx.connection
      if (!conn || typeof conn.authenticatedUrl !== 'function') return
      const base = 'http://127.0.0.1:3080/'
      const url = conn.authenticatedUrl(base)
      try {
        mkdirSync(HERE, { recursive: true })
        writeFileSync(join(HERE, 'launch-url.txt'), url, 'utf8')
      } catch (_) {}
    } catch (_) {}
  })

  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.webServer
    if (!server || typeof server.register !== 'function') return

    webCtx.effect(
      () =>
        server.register({
          kind: 'exact',
          path: '/dsh-sidebar-rail/report',
          handler: async (req, res) => {
            if (req.method === 'GET' || req.method === 'HEAD') {
              const body = readReport()
              res.statusCode = 200
              res.setHeader('content-type', 'application/json; charset=utf-8')
              res.setHeader('cache-control', 'no-store')
              res.end(req.method === 'HEAD' ? '' : body)
              return
            }
            if (req.method !== 'POST') {
              res.statusCode = 405
              res.setHeader('allow', 'GET, HEAD, POST')
              res.end()
              return
            }
            const chunks = []
            let size = 0
            req.on('data', (chunk) => {
              size += chunk.length
              if (size <= 512 * 1024) chunks.push(chunk)
            })
            req.on('end', () => {
              let payload = null
              try {
                payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              } catch (_) {
                payload = { parseError: true }
              }
              payload.receivedAt = new Date().toISOString()
              payload.userAgent = String(req.headers['user-agent'] || '')
              writeReport(payload)
              res.statusCode = 204
              res.end()
            })
          },
        }),
      'dsh-sidebar-rail: runtime report route',
    )
  })
}
