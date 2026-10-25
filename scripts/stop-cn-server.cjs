// 通过 run-cn-logged.cjs 的本地命名管道优雅停服。
//
// 用法（在仓库根目录）：
//   node scripts/stop-cn-server.cjs
//
// 停掉后启动器会在 5 秒内巡检发现 8001 不通，自动重新拉起整条链
// （wrapper → out/cn-server.js），所以这条命令等价于「重启服务端」。
// 想真正停服不重启，先按启动器面板的「2 全部停止」。
//
// 为什么不用 Stop-Process：硬杀会让 wrapper 走异常退出路径，日志里留一堆
// 断线噪声，而且服务端来不及 checkpoint WAL。
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')

const RECEIPT = path.join(__dirname, '..', '.logs', 'cn-server-current.json')
const receipt = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'))

if (!receipt.stopPipe || !receipt.stopToken) {
    console.error('receipt 里没有 stopPipe / stopToken，这个实例没启用优雅停止通道；只能重启启动器。')
    process.exit(2)
}

const request = {
    version: 1,
    pid: receipt.pid,
    loggerPid: receipt.loggerPid,
    startedAt: receipt.startedAt,
    stopToken: receipt.stopToken,
    requestedAt: new Date().toISOString(),
}

const socket = net.connect(receipt.stopPipe)
let buffer = ''
socket.setEncoding('utf8')
socket.on('connect', () => {
    console.log(`已连接停止管道，目标 server pid=${receipt.pid} logger pid=${receipt.loggerPid}`)
    socket.write(JSON.stringify(request) + '\n')
})
socket.on('data', chunk => {
    buffer += chunk
    const newline = buffer.indexOf('\n')
    if (newline < 0) return
    console.log('响应:', buffer.slice(0, newline))
    socket.end()
})
socket.on('error', error => { console.error('管道错误:', error.message); process.exit(1) })
socket.on('close', () => process.exit(0))
