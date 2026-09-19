import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** server/ 目录 */
export const SERVER_ROOT = path.resolve(__dirname, '..')
/** 仓库根目录（server 的上一级） */
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..')

const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf8'))

export const APP_VERSION = pkg.version || '0.0.0'

function toPort(value, fallback) {
  const num = Number.parseInt(value ?? '', 10)
  return Number.isFinite(num) && num > 0 && num < 65536 ? num : fallback
}

/**
 * 默认访问令牌（已硬编码）：前端「设置 → 服务端同步」里预填了同一个值，
 * 因此不用额外配置环境变量就能用。
 * 想临时关闭校验，把环境变量 ACCESS_TOKEN 设为 none / off / - 即可。
 */
const DEFAULT_ACCESS_TOKEN =
  'XbleCYYPUduiiUfR8MxqHgsvQV1tX9zcQ6jBYV3BFmZsxIifKUL588pkXaLGU0fY'

const DISABLED_TOKEN_VALUES = new Set(['none', 'off', '-'])

function resolveAccessToken() {
  const raw = `${process.env.ACCESS_TOKEN ?? ''}`.trim()
  if (!raw) return DEFAULT_ACCESS_TOKEN
  if (DISABLED_TOKEN_VALUES.has(raw.toLowerCase())) return ''
  return raw
}

/**
 * 全部配置都可以通过环境变量覆盖，方便部署时调整；
 * 不配置时按本地开发的默认值运行。
 */
export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: toPort(process.env.PORT, 3000),
  /** SQLite 文件位置，默认 server/data/reviewplan.db */
  dbPath: process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(SERVER_ROOT, 'data', 'reviewplan.db'),
  /** 访问令牌：数据接口都要求 Authorization: Bearer <token>，默认用硬编码的那一份 */
  accessToken: resolveAccessToken(),
  /** 允许的跨域来源，逗号分隔；默认 * （适合本地 / 局域网使用） */
  corsOrigin: process.env.CORS_ORIGIN || '*',
  /** 是否顺便托管前端构建产物 dist/（SERVE_STATIC=0 可关闭） */
  serveStatic: process.env.SERVE_STATIC !== '0',
  distDir: process.env.DIST_DIR
    ? path.resolve(process.env.DIST_DIR)
    : path.join(PROJECT_ROOT, 'dist'),
}
