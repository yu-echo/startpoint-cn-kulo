// 把玩家 1（艾利西弗，默认存档）灌进玩家 5（煜晓晓），保留角色名与账号绑定。
// 用法：node --env-file=.env scripts/restore-default-into-player5.cjs
const path = require('node:path')
const { getDb } = require('../out/data/db')
const {
    createPlayerSaveSnapshotV2Sync,
    restorePlayerSaveSnapshotV2Sync,
} = require('../out/data/snapshots/player-snapshot')

const SOURCE = 1
const TARGET = 5
const KEEP_NAME = '煜晓晓'

const db = getDb()

const before = db.prepare('SELECT id,name,account_id,rank_point FROM players WHERE id IN (?,?)').all(SOURCE, TARGET)
console.log('=== 操作前 ===')
console.table(before)

console.log(`\n导出玩家 ${SOURCE} 的快照…`)
const snapshot = createPlayerSaveSnapshotV2Sync(SOURCE)
console.log('  表数', Object.keys(snapshot.data.tables).length, '行数', snapshot.summary.rowCount)

console.log(`\n写入玩家 ${TARGET}…`)
const result = restorePlayerSaveSnapshotV2Sync(snapshot, TARGET, { includeArchiveHistory: true })
console.log('  恢复表', result.restoredTables, '行', result.restoredRows)

db.prepare('UPDATE players SET name = ? WHERE id = ?').run(KEEP_NAME, TARGET)
console.log(`\n角色名已保留为「${KEEP_NAME}」`)

const after = db.prepare('SELECT id,name,account_id,rank_point FROM players WHERE id IN (?,?)').all(SOURCE, TARGET)
console.log('\n=== 操作后 ===')
console.table(after)

const count = t => db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE player_id = ?`).get(TARGET).n
console.log(`\n玩家 ${TARGET} 现有：角色 ${count('players_characters')}，装备 ${count('players_equipment')}，`
    + `道具 ${count('players_items')}，通关记录 ${count('players_quest_progress')}`)

// 回传给客户端的所有整型必须 < 2^31，否则 C8700
const p = db.prepare('SELECT * FROM players WHERE id = ?').get(TARGET)
const big = Object.entries(p).filter(([k, v]) => typeof v === 'number' && Math.abs(v) > 100000000
    && !/time/i.test(k))
console.log(`\nplayers 中 > 1 亿 的非时间字段：${big.length ? JSON.stringify(big) : '无 ✓'}`)
