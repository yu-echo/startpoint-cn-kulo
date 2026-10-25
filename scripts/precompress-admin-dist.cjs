// 给后台 SPA 的静态产物补 .br / .gz 预压缩副本。
//
// 为什么需要：`src/lib/admin-spa-static.ts` 里 `@fastify/static` 开了
// `preCompressed: true`，只会去找现成的 `.br` / `.gz`，不会即时压缩。
// 这个后台是走樱花隧道给外网看的，2.9 MB 的 JS 压完大约 800 KB，
// 少这一半以上流量。vite 不管这一步，所以单独放一个脚本。
//
// 用法（仓库根目录，先 build 再跑）：
//   node scripts/precompress-admin-dist.cjs
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const root = path.resolve(__dirname, '..', 'web', 'dist')
const EXTS = new Set(['.js', '.css', '.html', '.json', '.svg', '.map'])
// 小于这个体积压了没意义，反而多一次磁盘查找
const MIN_BYTES = 1024

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(file, out)
        else if (EXTS.has(path.extname(entry.name))) out.push(file)
    }
    return out
}

if (!fs.existsSync(root)) {
    console.error(`找不到 ${root}，先跑 npm run build:admin`)
    process.exit(1)
}

let written = 0, skipped = 0, raw = 0, brotli = 0, gzip = 0
for (const file of walk(root)) {
    // 已经压缩过的产物自身不再压缩
    if (/\.(?:br|gz)$/.test(file)) continue
    const body = fs.readFileSync(file)
    if (body.byteLength < MIN_BYTES) { skipped++; continue }
    const br = zlib.brotliCompressSync(body, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.byteLength },
    })
    const gz = zlib.gzipSync(body, { level: 9 })
    fs.writeFileSync(`${file}.br`, br)
    fs.writeFileSync(`${file}.gz`, gz)
    raw += body.byteLength; brotli += br.byteLength; gzip += gz.byteLength
    written++
}

const mb = bytes => `${(bytes / 1024 / 1024).toFixed(2)} MB`
console.log(`预压缩完成：${written} 个文件（跳过 ${skipped} 个小文件）`)
console.log(`  原始 ${mb(raw)} → br ${mb(brotli)} / gz ${mb(gzip)}`)
