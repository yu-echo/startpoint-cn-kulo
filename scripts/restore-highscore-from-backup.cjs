// 从备份把 high_score 还原（之前误把 Number 字段当 int 压平了），
// 并逐表校验玩家 1（默认存档）与备份完全一致。
const Database = require('better-sqlite3')

const LIVE = '.database/wdfp_data.db'
const BAK = '.database/admin-backups/manual-before-restore-20261023-143630/wdfp_data.db'

const live = new Database(LIVE)
live.pragma('busy_timeout = 8000')
const bak = new Database(BAK, { readonly: true })

// 1) 还原 high_score
const origin = bak.prepare(
    'SELECT player_id, section, quest_id, high_score FROM players_quest_progress WHERE high_score > 2147483647',
).all()

const restore = live.prepare(
    'UPDATE players_quest_progress SET high_score = ? WHERE player_id = ? AND section = ? AND quest_id = ?',
)
let changed = 0
for (const row of origin) {
    // 玩家 5 是从玩家 1 复制来的，同一批 quest_id 也还原成同值
    for (const pid of [1, 5]) {
        changed += restore.run(row.high_score, pid, row.section, row.quest_id).changes
    }
}
console.log(`high_score 已还原 ${changed} 行`)

// 2) 校验玩家 1 与备份一致
const tables = bak.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
    .map(t => t.name)

function rowsOf(db, table) {
    const cols = db.prepare(`PRAGMA table_info("${table}")`).all()
    if (!cols.some(c => c.name === 'player_id')) return null
    const rows = db.prepare(`SELECT * FROM "${table}" WHERE player_id = 1`).all()
    // WITHOUT ROWID 表没有 rowid，统一按序列化内容排序后比较
    return rows.map(r => JSON.stringify(r)).sort()
}

const diffs = []
for (const table of tables) {
    const a = rowsOf(bak, table)
    if (a === null) continue
    const b = rowsOf(live, table)
    if (JSON.stringify(a) !== JSON.stringify(b)) {
        diffs.push(`${table}: 备份 ${a.length} 行 / 现库 ${b.length} 行`)
    }
}
console.log(`\n玩家 1（艾利西弗）涉及 ${tables.length} 张表，差异 ${diffs.length} 处`)
diffs.forEach(d => console.log('  !', d))
if (!diffs.length) console.log('  ✓ 与备份逐表完全一致')

const p1 = live.prepare('SELECT id,name,rank_point,vmoney,free_vmoney,account_id FROM players WHERE id=1').get()
console.log('\n玩家 1 现状:', JSON.stringify(p1))

live.close(); bak.close()
