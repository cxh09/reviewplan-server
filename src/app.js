import fs from 'node:fs'
import path from 'node:path'

import cors from 'cors'
import express from 'express'

import { APP_VERSION } from './config.js'

/** 请求体上限，整份快照不大，5mb 足够 */
const BODY_LIMIT = '5mb'

function createCorsOptions(corsOrigin) {
  if (!corsOrigin || corsOrigin === '*') return { origin: '*' }
  return {
    origin: corsOrigin
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  }
}

export function createApp({ config, repository }) {
  const app = express()
  app.disable('x-powered-by')

  app.use(cors(createCorsOptions(config.corsOrigin)))
  app.use(express.json({ limit: BODY_LIMIT }))

  /** 设置了访问令牌时，校验 Authorization: Bearer <token> */
  function requireToken(req, res, next) {
    if (!config.accessToken) return next()

    const header = req.get('authorization') || ''
    const token = header.toLowerCase().startsWith('bearer ')
      ? header.slice(7).trim()
      : (req.get('x-access-token') || '').trim()

    if (token && token === config.accessToken) return next()
    return res.status(401).json({ code: 'UNAUTHORIZED', error: '访问令牌无效' })
  }

  // ---------- 接口 ----------

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      name: 'reviewplan-server',
      version: APP_VERSION,
      auth: Boolean(config.accessToken),
      time: new Date().toISOString(),
    })
  })

  /** 拉取整份快照 */
  app.get('/api/data', requireToken, (req, res) => {
    res.json(repository.readSnapshot())
  })

  /** 只返回版本号：客户端轮询用，判断云端有没有被别的端改动，避免每次都传整份数据 */
  app.get('/api/rev', requireToken, (req, res) => {
    res.json(repository.readRev())
  })

  /** 上传整份快照；带 rev 时做乐观锁，版本对不上返回 409 与最新数据 */
  app.put('/api/data', requireToken, (req, res) => {
    const { data, rev } = req.body || {}
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return res.status(400).json({ code: 'BAD_REQUEST', error: 'data 必须是一个对象' })
    }

    const expectedRev = Number.isInteger(rev) ? rev : null
    const result = repository.writeSnapshot(data, expectedRev)
    if (result.conflict) {
      return res.status(409).json({
        code: 'CONFLICT',
        error: '服务端数据已被其它设备更新',
        ...result.current,
      })
    }

    res.json({ rev: result.rev, updatedAt: result.updatedAt })
  })

  app.use('/api', (req, res) => {
    res.status(404).json({ code: 'NOT_FOUND', error: '接口不存在' })
  })

  // ---------- 静态资源（可选）----------

  if (config.serveStatic && fs.existsSync(config.distDir)) {
    app.use(express.static(config.distDir))
    // history 模式路由回退：没匹配到的 GET 一律交给 index.html
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next()
      res.sendFile(path.join(config.distDir, 'index.html'))
    })
  }

  // ---------- 错误处理 ----------

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500
    if (status >= 500) console.error('[reviewplan-server] 请求处理失败:', err)
    res.status(status).json({
      code: err.code || 'INTERNAL_ERROR',
      error: status >= 500 ? '服务端内部错误' : err.message,
    })
  })

  return app
}
