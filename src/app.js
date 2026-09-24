import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import cors from 'cors'
import express from 'express'

import { APP_VERSION } from './config.js'

/** 请求体上限，整份快照不大，5mb 足够 */
const BODY_LIMIT = '5mb'

/** 分享链接 code 的字符集（base62）与长度 */
const SHARE_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const SHARE_CODE_LENGTH = 10
/** 单次分享的日期跨度上限（天） */
const SHARE_MAX_SPAN_DAYS = 92

function randomShareCode() {
  const bytes = crypto.randomBytes(SHARE_CODE_LENGTH)
  let code = ''
  for (let i = 0; i < SHARE_CODE_LENGTH; i += 1) {
    code += SHARE_CODE_ALPHABET[bytes[i] % SHARE_CODE_ALPHABET.length]
  }
  return code
}

/** 形如 YYYY-MM-DD 且能原样解析回同一天的真实日期 */
function isDateKey(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return false
  const date = new Date(`${key}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === key
}

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

  /** 创建分享链接：只登记日期范围，访问时再实时裁剪当前日程 */
  app.post('/api/shares', requireToken, (req, res) => {
    const { dateStart, dateEnd } = req.body || {}
    if (!isDateKey(dateStart) || !isDateKey(dateEnd)) {
      return res
        .status(400)
        .json({ code: 'BAD_REQUEST', error: '日期范围不合法' })
    }
    if (dateStart > dateEnd) {
      return res
        .status(400)
        .json({ code: 'BAD_REQUEST', error: '开始日期不能晚于结束日期' })
    }
    const spanDays =
      (Date.parse(`${dateEnd}T00:00:00Z`) - Date.parse(`${dateStart}T00:00:00Z`)) / 86400000
    if (spanDays > SHARE_MAX_SPAN_DAYS) {
      return res
        .status(400)
        .json({ code: 'BAD_REQUEST', error: `分享日期跨度最多 ${SHARE_MAX_SPAN_DAYS} 天` })
    }

    // 随机 code 冲突概率极低，撞上了重试几次
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = randomShareCode()
      if (repository.getShare(code)) continue
      try {
        repository.createShare({ code, dateStart, dateEnd })
        return res.json({ code })
      } catch {
        continue
      }
    }
    return res
      .status(500)
      .json({ code: 'SHARE_CREATE_FAILED', error: '生成分享链接失败，请重试' })
  })

  /** 公开读取分享：不带令牌；实时从当前快照取该日期范围内的日程 */
  app.get('/api/share/:code', (req, res) => {
    const share = repository.getShare(req.params.code)
    if (!share) {
      return res
        .status(404)
        .json({ code: 'SHARE_NOT_FOUND', error: '分享链接不存在或已失效' })
    }

    const snapshot = repository.readSnapshot()
    const plans = Array.isArray(snapshot.data?.plans) ? snapshot.data.plans : []
    const viewPlans = plans
      .filter((plan) => plan && plan.date >= share.dateStart && plan.date <= share.dateEnd)
      .map((plan) => ({
        title: plan.title || '未命名日程',
        category: plan.category || '通用',
        level: plan.level || '基础',
        duration: Number(plan.duration) || 0,
        date: plan.date,
        startHour: Number(plan.startHour) || 0,
        done: Boolean(plan.done),
      }))

    // 分享署名：把作者资料随快照实时透出，旧快照没有 profile 时返回 null
    const rawProfile = snapshot.data?.profile
    const profile =
      rawProfile && typeof rawProfile === 'object'
        ? { name: `${rawProfile.name || ''}`, avatar: `${rawProfile.avatar || ''}` }
        : null

    res.json({ dateStart: share.dateStart, dateEnd: share.dateEnd, profile, plans: viewPlans })
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
