import { createApp } from './app.js'
import { config } from './config.js'
import { createRepository, openDatabase } from './db.js'

function main() {
  const db = openDatabase(config.dbPath)
  const repository = createRepository(db)
  const app = createApp({ config, repository })

  const server = app.listen(config.port, config.host, () => {
    const shownHost = config.host === '0.0.0.0' ? 'localhost' : config.host
    console.log(`[reviewplan-server] 已启动：http://${shownHost}:${config.port}`)
    console.log(`[reviewplan-server] 数据库：${config.dbPath}`)
    console.log(
      `[reviewplan-server] 访问令牌：${config.accessToken ? '已开启校验' : '未设置（任何人可访问）'}`,
    )
  })

  let shuttingDown = false

  function shutdown(signal) {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n[reviewplan-server] 收到 ${signal}，正在退出…`)

    server.close(() => {
      db.close()
      process.exit(0)
    })
    // 主动断开 keep-alive 连接：否则要等连接超时，systemctl restart 会多等好几秒
    server.closeAllConnections?.()
    // 兜底：3 秒还没退干净就强制退出
    setTimeout(() => process.exit(0), 3000).unref?.()
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main()
