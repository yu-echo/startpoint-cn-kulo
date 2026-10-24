// 一次性脚本：扫描并夹紧所有可能回传给客户端的整型字段（上限 1 亿）。
// 用法：node scripts/clamp-client-ints.cjs [--apply]
const Database = require('better-sqlite3')

const DB = 'D:/wf-server/startpoint-cn-kulo/.database/wdfp_data.db'
const MAX = 100000000
const APPLY = process.argv.includes('--apply')
const db = new Database(DB)
db.pragma('busy_timeout = 8000')

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()

const CLAMP_TABLES = new Set([
    'players', 'players_mails', 'players_items', 'players_characters', 'players_equipments',
])
const SKIP_COLS = /(^|_)(time|date|at|created|updated|expires|receive|read|settled|started|ended)($|_)/i

let total = 0
for (const t of tables) {
    if (!CLAMP_TABLES.has(t.name)) continue
    const cols = db.prepare(`PRAGMA table_info("${t.name}")`).all()
    for (const c of cols) {
        if (!/INT/i.test(c.type)) continue
        if (SKIP_COLS.test(c.name)) continue
        let row
        try {
            row = db.prepare(`SELECT MAX("${c.name}") AS mx, COUNT(*) AS n FROM "${t.name}" WHERE "${c.name}" > ?`).get(MAX)
        } catch { continue }
        if (row && row.mx != null && row.n > 0) {
            console.log(`⚠ ${t.name}.${c.name}: max=${row.mx} 超限行数=${row.n}`)
            if (APPLY) {
                const r = db.prepare(`UPDATE "${t.name}" SET "${c.name}" = ? WHERE "${c.name}" > ?`).run(MAX, MAX)
                console.log(`  → 已压到 ${MAX}，影响 ${r.changes} 行`)
                total += r.changes
            }
        }
    }
}
db.close()
console.log(APPLY ? `\n完成，共修正 ${total} 行` : '\n（仅扫描，加 --apply 执行修正）')
