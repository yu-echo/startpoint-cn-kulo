'use strict'

// 存档内容管理器（角色一键拉满）离线夹具。
// 全部数据库在 tmp/ 下的临时 DATA_DIR 里新合成，不接触任何真实存档。
// 运行：node tools/run-isolated-check.cjs --test tests/admin-character-max.test.cjs
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const sandbox = path.resolve(__dirname, "../tmp") + path.sep
for (const name of ["DATA_DIR", "GACHA_SEED_DIR"]) {
    assert.ok(process.env[name] && path.resolve(process.env[name]).startsWith(sandbox), `${name} must use the isolated check directory`)
}
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename)

const Fastify = require("fastify")
const { getDb } = require("../src/data/db.ts")
const { insertAccountSync } = require("../src/data/domains/account.ts")
const { insertDefaultPlayerSync } = require("../src/data/domains/player.ts")
const { insertPlayerCharacterSync } = require("../src/data/domains/character.ts")
const playerRoutes = require("../src/routes/web_api/player.ts").default
const maxModule = require("../src/lib/admin-character-max.ts")
const { getCharacterExpCap, getCharacterMaxOverLimit } = require("../src/lib/character-overlimit.ts")
const { getCharacterManaBoardCountSync, getCharacterManaNodesSync } = require("../src/lib/assets.ts")

const db = getDb()
const app = Fastify()
app.register(playerRoutes, { prefix: "/api/player" })
test.after(async () => { await app.close(); db.close() })

// 扩展角色：character_awake_extension.json 里配了 linked_mana_node_slots，
// 板 1 觉醒后板 2 会跟着免费觉醒（板 2 必须全部学会）。
const EXTENSION_ID = 111183
const PLAIN_ID = 1
// 没有觉醒任务（任务分类 9）的角色：玛纳板可以学满，但不能觉醒
const NO_AWAKE_ID = 111002

function player() {
    const account = insertAccountSync({ appId: "wf_cn", idpAlias: "", idpCode: "fixture", idpId: "", status: "normal" })
    return insertDefaultPlayerSync(account.id)
}

/** 新建一个完全没养过的角色：0 经验、板 1、零节点、零觉醒。 */
function addFreshCharacter(playerId, characterId) {
    const boardCount = getCharacterManaBoardCountSync(characterId)
    assert.ok(boardCount > 0, `角色 ${characterId} 必须有玛纳板`)
    insertPlayerCharacterSync(playerId, characterId, {
        entryCount: 1,
        evolutionLevel: 0,
        overLimitStep: 0,
        protection: false,
        joinTime: new Date(0),
        updateTime: new Date(0),
        exp: 0,
        stack: 0,
        manaBoardIndex: 1,
        bondTokenList: Array.from({ length: boardCount }, (_, index) => ({ manaBoardIndex: index + 1, status: 0 })),
    })
}

const nodeIdsOf = (characterId, boardIndex) => Object.keys(getCharacterManaNodesSync(characterId, boardIndex) ?? {}).map(Number)
const allNodeCount = characterId => {
    let total = 0
    for (let boardIndex = 1; boardIndex <= getCharacterManaBoardCountSync(characterId); boardIndex++) {
        total += nodeIdsOf(characterId, boardIndex).length
    }
    return total
}
const charRow = (playerId, characterId) => db.prepare(`
    SELECT exp, over_limit_step, mana_board_index, evolution_level
    FROM players_characters WHERE player_id = ? AND id = ?
`).get(playerId, characterId)
const nodeRows = (playerId, characterId) => db.prepare(`
    SELECT value, awake_level FROM players_characters_mana_nodes
    WHERE player_id = ? AND character_id = ? ORDER BY value
`).all(playerId, characterId)
const awakeUnlockOf = (playerId, characterId, boardIndex = 1) => db.prepare(`
    SELECT awake_level FROM players_character_awake_unlocks
    WHERE player_id = ? AND character_id = ? AND board_index = ?
`).get(playerId, characterId, boardIndex)

// ── 作用域解析 ──────────────────────────────────────────────
test("scopes 解析：缺省=全开，空/未知/非法类型一律报错", () => {
    assert.deepEqual([...maxModule.parseCharacterMaxScopes(undefined).scopes], ["level", "board", "awake", "evolution"])
    assert.deepEqual([...maxModule.parseCharacterMaxScopes(null).scopes], ["level", "board", "awake", "evolution"])

    assert.match(maxModule.parseCharacterMaxScopes([]).error, /非空数组/)
    assert.match(maxModule.parseCharacterMaxScopes("level").error, /非空数组/)
    assert.match(maxModule.parseCharacterMaxScopes(["level", "nope"]).error, /不支持的 scope/)
    assert.match(maxModule.parseCharacterMaxScopes([1]).error, /不支持的 scope/)

    const deduped = maxModule.parseCharacterMaxScopes(["board", "board", "awake"])
    assert.deepEqual([...deduped.scopes], ["board", "awake"])
})

// ── 四项全开：计划口径 ──────────────────────────────────────
test("四项全开：只计划需要改的角色，扩展角色的联动板节点一起觉醒", () => {
    const p = player()
    addFreshCharacter(p.id, EXTENSION_ID)
    const board1 = nodeIdsOf(EXTENSION_ID, 1)
    const board2 = nodeIdsOf(EXTENSION_ID, 2)

    const plan = maxModule.planPlayerCharacterMax(p.id, { scopes: new Set(maxModule.CHARACTER_MAX_SCOPES) })
    // 默认存档自带角色 1，加上新造的扩展角色
    assert.equal(plan.changes.length, 2)
    assert.equal(plan.skipped, 0)

    const ext = plan.changes.find(change => change.characterId === EXTENSION_ID)
    assert.ok(ext, "扩展角色必须在计划里")
    assert.equal(ext.boardCount, 2)
    assert.equal(ext.manaBoardIndex, 2, "板索引要推到最后一板")
    assert.equal(ext.insertNodeIds.length, allNodeCount(EXTENSION_ID), "两板节点都要补")
    assert.equal(ext.awakeNodeIds.length, board1.length + board2.length, "板 1 全部 + 联动板 2 全部")
    assert.equal(ext.awakeUnlock, true)
    assert.equal(ext.evolutionLevel, 2, "觉醒 1 级 → 进化 2")

    const rarity = 5
    const maxOverLimit = getCharacterMaxOverLimit(EXTENSION_ID, rarity)
    assert.equal(ext.overLimitStep, maxOverLimit)
    assert.equal(ext.exp, getCharacterExpCap(EXTENSION_ID, rarity, maxOverLimit))

    assert.equal(plan.totals.characters, 2)
    assert.equal(plan.totals.levelChanges, 2)
    assert.equal(plan.totals.awakeUnlocks, 2)
    assert.equal(plan.totals.evolutionChanges, 2)
    assert.equal(plan.totals.nodeInserts, allNodeCount(EXTENSION_ID) + allNodeCount(PLAIN_ID))
})

// ── 四项全开：落库结果 ──────────────────────────────────────
test("四项全开：落库后经验/超限/板/觉醒/进化全部到位且节点行不重复", () => {
    const p = player()
    addFreshCharacter(p.id, EXTENSION_ID)
    const plan = maxModule.planPlayerCharacterMax(p.id, { scopes: new Set(maxModule.CHARACTER_MAX_SCOPES) })
    const applied = maxModule.applyPlayerCharacterMax(p.id, plan.changes)

    assert.equal(applied.totals.characters, plan.totals.characters)
    assert.equal(applied.totals.nodeInserts, plan.totals.nodeInserts)
    assert.equal(applied.totals.awakeNodeChanges, plan.totals.awakeNodeChanges)
    assert.equal(applied.totals.awakeUnlocks, plan.totals.awakeUnlocks)
    assert.equal(applied.totals.evolutionChanges, plan.totals.evolutionChanges)

    const row = charRow(p.id, EXTENSION_ID)
    assert.equal(row.exp, getCharacterExpCap(EXTENSION_ID, 5, getCharacterMaxOverLimit(EXTENSION_ID, 5)))
    assert.equal(row.over_limit_step, getCharacterMaxOverLimit(EXTENSION_ID, 5))
    assert.equal(row.mana_board_index, 2)
    assert.equal(row.evolution_level, 2)

    const nodes = nodeRows(p.id, EXTENSION_ID)
    assert.equal(nodes.length, allNodeCount(EXTENSION_ID), "每板每节点恰一行")
    assert.equal(new Set(nodes.map(node => node.value)).size, nodes.length, "不允许重复节点行")
    assert.ok(nodes.every(node => node.awake_level === 1), "所有节点都该觉醒到 1")

    assert.equal(awakeUnlockOf(p.id, EXTENSION_ID).awake_level, 1)

    // 羁绊令牌：板满后应变成「可领取」（1），且两板都有行
    const bonds = db.prepare(`
        SELECT mana_board_index, status FROM players_characters_bond_tokens
        WHERE player_id = ? AND character_id = ? ORDER BY mana_board_index
    `).all(p.id, EXTENSION_ID)
    assert.equal(bonds.length, 2)
    assert.ok(bonds.every(bond => bond.status >= 1))
})

// ── 幂等 ────────────────────────────────────────────────────
test("幂等：已经拉满的角色再次计划不产生任何写入", () => {
    const p = player()
    addFreshCharacter(p.id, EXTENSION_ID)
    const scopes = new Set(maxModule.CHARACTER_MAX_SCOPES)
    maxModule.applyPlayerCharacterMax(p.id, maxModule.planPlayerCharacterMax(p.id, { scopes }).changes)

    const second = maxModule.planPlayerCharacterMax(p.id, { scopes })
    assert.equal(second.changes.length, 0)
    assert.equal(second.skipped, 2)
    assert.deepEqual(second.totals, maxModule.emptyCharacterMaxTotals())

    // 空计划不该开事务写库
    const noop = maxModule.applyPlayerCharacterMax(p.id, second.changes)
    assert.deepEqual(noop, { totals: maxModule.emptyCharacterMaxTotals(), bondRepaired: 0, evolutionRepaired: 0 })
})

// ── 单项作用域 ──────────────────────────────────────────────
test("只勾等级：不碰节点、板索引和进化", () => {
    const p = player()
    addFreshCharacter(p.id, EXTENSION_ID)
    const plan = maxModule.planPlayerCharacterMax(p.id, { scopes: new Set(["level"]) })
    const ext = plan.changes.find(change => change.characterId === EXTENSION_ID)
    assert.equal(ext.insertNodeIds.length, 0)
    assert.equal(ext.awakeNodeIds.length, 0)
    assert.equal(ext.awakeUnlock, false)
    assert.equal(ext.manaBoardIndex, null)
    assert.equal(ext.evolutionLevel, null)
    assert.equal(ext.overLimitStep, getCharacterMaxOverLimit(EXTENSION_ID, 5))
})

test("只勾觉醒：先补板 1 节点行再觉醒，不碰板索引/联动板/进化", () => {
    const p = player()
    addFreshCharacter(p.id, EXTENSION_ID)
    const board1 = nodeIdsOf(EXTENSION_ID, 1)
    const plan = maxModule.planPlayerCharacterMax(p.id, { scopes: new Set(["awake"]) })
    const ext = plan.changes.find(change => change.characterId === EXTENSION_ID)

    assert.equal(ext.insertNodeIds.length, board1.length, "觉醒必须有节点行，否则 UPDATE 命中 0 行")
    assert.equal(ext.awakeNodeIds.length, board1.length, "联动板 2 没学会就不该跟着觉醒")
    assert.equal(ext.manaBoardIndex, null)
    assert.equal(ext.evolutionLevel, null)

    maxModule.applyPlayerCharacterMax(p.id, plan.changes)
    const nodes = nodeRows(p.id, EXTENSION_ID)
    assert.equal(nodes.length, board1.length)
    assert.ok(nodes.every(node => node.awake_level === 1))
    assert.equal(charRow(p.id, EXTENSION_ID).mana_board_index, 1, "只觉醒不该推板索引")
})

test("单角色入口：只影响指定角色", () => {
    const p = player()
    addFreshCharacter(p.id, EXTENSION_ID)
    const scopes = new Set(maxModule.CHARACTER_MAX_SCOPES)
    const result = maxModule.maxSingleCharacterSync(p.id, EXTENSION_ID, scopes)
    assert.equal(result.applied, true)
    assert.equal(result.plan.characterId, EXTENSION_ID)

    // 默认存档的角色 1 完全没被动过
    assert.equal(nodeRows(p.id, PLAIN_ID).length, 0)
    assert.equal(charRow(p.id, PLAIN_ID).evolution_level, 0)
    assert.equal(charRow(p.id, PLAIN_ID).mana_board_index, 1)

    // 再跑一次就没有可改的了
    assert.equal(maxModule.maxSingleCharacterSync(p.id, EXTENSION_ID, scopes).applied, false)
})

// ── 觉醒门槛：只有配了觉醒任务的角色可以觉醒 ──────────────
test("没有觉醒内容的角色：不写 wake/解锁，进化封顶 1", () => {
    const p = player()
    addFreshCharacter(p.id, NO_AWAKE_ID)
    assert.ok(!maxModule.getAwakeCharacterIdSet().has(NO_AWAKE_ID), `${NO_AWAKE_ID} 不该有觉醒任务`)

    const plan = maxModule.planPlayerCharacterMax(p.id, { scopes: new Set(maxModule.CHARACTER_MAX_SCOPES) })
    const target = plan.changes.find(change => change.characterId === NO_AWAKE_ID)
    assert.ok(target, "等级/板这些还是该拉满的")
    assert.equal(target.awakeNodeIds.length, 0, "没有觉醒内容就不能觉醒节点")
    assert.equal(target.awakeUnlock, false, "也不能写觉醒解锁行")
    assert.equal(target.evolutionLevel, 1, "进化只能到板满的 1，不能到觉醒的 2")
    assert.equal(target.manaBoardIndex, 2, "板索引照常推满")

    maxModule.applyPlayerCharacterMax(p.id, plan.changes)
    assert.ok(nodeRows(p.id, NO_AWAKE_ID).every(node => node.awake_level === 0))
    assert.equal(awakeUnlockOf(p.id, NO_AWAKE_ID), undefined)
    assert.equal(charRow(p.id, NO_AWAKE_ID).evolution_level, 1)

    const progress = maxModule.describePlayerCharacterProgress(p.id)[NO_AWAKE_ID]
    assert.equal(progress.awakeOwned, 0)
    assert.equal(progress.targetEvolution, 1, "进度视图的进化目标也要跟着降")
})

test("撤回越权觉醒：节点归零、解锁删除、进化回 1，且有觉醒内容的角色不受影响", () => {
    const p = player()
    addFreshCharacter(p.id, NO_AWAKE_ID)
    addFreshCharacter(p.id, EXTENSION_ID)
    // 先按正常口径拉满（扩展角色是合法的觉醒，NO_AWAKE_ID 不是）
    const scopes = new Set(maxModule.CHARACTER_MAX_SCOPES)
    maxModule.applyPlayerCharacterMax(p.id, maxModule.planPlayerCharacterMax(p.id, { scopes }).changes)

    // 复现历史误写：给没有觉醒内容的角色也打上觉醒状态
    db.prepare("UPDATE players_characters_mana_nodes SET awake_level = 1 WHERE player_id = ? AND character_id = ?")
        .run(p.id, NO_AWAKE_ID)
    db.prepare("UPDATE players_characters SET evolution_level = 2 WHERE player_id = ? AND id = ?")
        .run(p.id, NO_AWAKE_ID)
    db.prepare("INSERT OR REPLACE INTO players_character_awake_unlocks (player_id, character_id, board_index, awake_level) VALUES (?, ?, 1, 1)")
        .run(p.id, NO_AWAKE_ID)
    const dirtyNodes = nodeRows(p.id, NO_AWAKE_ID).length
    assert.ok(dirtyNodes > 0)
    assert.ok(nodeRows(p.id, NO_AWAKE_ID).every(node => node.awake_level === 1))

    const repaired = maxModule.revokeUnauthorizedAwakeStateSync(p.id)
    assert.equal(repaired.characters, 1)
    assert.equal(repaired.nodes, dirtyNodes)
    assert.equal(repaired.unlocks, 1)
    assert.equal(repaired.evolutionLevels, 1)

    assert.ok(nodeRows(p.id, NO_AWAKE_ID).every(node => node.awake_level === 0))
    assert.equal(awakeUnlockOf(p.id, NO_AWAKE_ID), undefined)
    assert.equal(charRow(p.id, NO_AWAKE_ID).evolution_level, 1)
    assert.equal(charRow(p.id, NO_AWAKE_ID).mana_board_index, 2, "板本身照常是满的")

    // 合法觉醒的扩展角色一点没动
    assert.equal(awakeUnlockOf(p.id, EXTENSION_ID).awake_level, 1)
    assert.ok(nodeRows(p.id, EXTENSION_ID).every(node => node.awake_level === 1))
    assert.equal(charRow(p.id, EXTENSION_ID).evolution_level, 2)

    // 幂等：再撤一次没有可改的
    assert.deepEqual(maxModule.revokeUnauthorizedAwakeStateSync(p.id),
        { characters: 0, nodes: 0, unlocks: 0, evolutionLevels: 0 })
})

// ── 进度视图 ────────────────────────────────────────────────
test("进度视图：拉满前后 nodeOwned / awakeOwned / targetEvolution 对得上", () => {
    const p = player()
    addFreshCharacter(p.id, EXTENSION_ID)
    const before = maxModule.describePlayerCharacterProgress(p.id)[EXTENSION_ID]
    assert.equal(before.rarity, 5)
    assert.equal(before.boardCount, 2)
    assert.equal(before.nodeTotal, allNodeCount(EXTENSION_ID))
    assert.equal(before.nodeOwned, 0)
    assert.equal(before.awakeOwned, 0)
    assert.equal(before.targetEvolution, 2)
    assert.equal(before.maxOverLimit, getCharacterMaxOverLimit(EXTENSION_ID, 5))

    const scopes = new Set(maxModule.CHARACTER_MAX_SCOPES)
    maxModule.applyPlayerCharacterMax(p.id, maxModule.planPlayerCharacterMax(p.id, { scopes }).changes)

    const after = maxModule.describePlayerCharacterProgress(p.id)[EXTENSION_ID]
    assert.equal(after.nodeOwned, after.nodeTotal)
    assert.equal(after.awakeOwned, nodeIdsOf(EXTENSION_ID, 1).length, "觉醒列只看板 1")
    assert.equal(after.expCap, getCharacterExpCap(EXTENSION_ID, 5, getCharacterMaxOverLimit(EXTENSION_ID, 5)))
})

// ── HTTP 路由 ───────────────────────────────────────────────
test("路由：dryRun 只算不写，真执行后再次调用是空操作", async () => {
    const p = player()
    addFreshCharacter(p.id, EXTENSION_ID)
    const post = body => app.inject({ method: "POST", url: `/api/player/${p.id}/characters/max`, payload: body })

    const preview = await post({ dryRun: true })
    assert.equal(preview.statusCode, 200)
    const previewBody = preview.json()
    assert.equal(previewBody.ok, true)
    assert.equal(previewBody.dryRun, true)
    assert.equal(previewBody.affected, 2)
    assert.equal(previewBody.totals.nodeInserts, allNodeCount(EXTENSION_ID) + allNodeCount(PLAIN_ID))
    assert.equal(nodeRows(p.id, EXTENSION_ID).length, 0, "dryRun 不能写库")

    const real = await post({})
    assert.equal(real.statusCode, 200)
    const realBody = real.json()
    assert.equal(realBody.dryRun, false)
    assert.equal(realBody.affected, 2)
    assert.equal(realBody.totals.characters, 2)
    assert.equal(nodeRows(p.id, EXTENSION_ID).length, allNodeCount(EXTENSION_ID))

    const again = await post({})
    assert.equal(again.statusCode, 200)
    assert.equal(again.json().dryRun, true, "没改动时按 dryRun 回包")
    assert.equal(again.json().affected, 0)
})

test("路由：单角色入口 + 入参校验", async () => {
    const p = player()
    addFreshCharacter(p.id, EXTENSION_ID)
    const single = await app.inject({
        method: "POST", url: `/api/player/${p.id}/character/${EXTENSION_ID}/max`, payload: { scopes: ["board"] },
    })
    assert.equal(single.statusCode, 200)
    assert.equal(single.json().affected, 1)
    assert.equal(charRow(p.id, EXTENSION_ID).mana_board_index, 2)
    assert.equal(charRow(p.id, EXTENSION_ID).evolution_level, 1, "板满后上游 reconcile 会把进化推到 1")
    assert.equal(charRow(p.id, PLAIN_ID).mana_board_index, 1, "别动其他角色")

    const all = `/api/player/${p.id}/characters/max`
    assert.equal((await app.inject({ method: "POST", url: all, payload: { scopes: ["nope"] } })).statusCode, 400)
    assert.equal((await app.inject({ method: "POST", url: all, payload: { scopes: [] } })).statusCode, 400)
    assert.equal((await app.inject({ method: "POST", url: all, payload: { characterIds: ["x"] } })).statusCode, 400)
    assert.equal((await app.inject({ method: "POST", url: "/api/player/99999999/characters/max", payload: {} })).statusCode, 404)
})

test("路由：详情接口带上养成进度列", async () => {
    const p = player()
    addFreshCharacter(p.id, EXTENSION_ID)
    const scopes = new Set(maxModule.CHARACTER_MAX_SCOPES)
    maxModule.applyPlayerCharacterMax(p.id, maxModule.planPlayerCharacterMax(p.id, { scopes }).changes)

    const response = await app.inject(`/api/player/${p.id}/detail?section=characters`)
    assert.equal(response.statusCode, 200)
    const row = response.json().characters.find(character => character.code === EXTENSION_ID)
    assert.ok(row, "详情里必须出现扩展角色")
    assert.equal(row.rarity, 5)
    assert.equal(row.boardCount, 2)
    assert.equal(row.nodeTotal, row.nodeOwned)
    assert.equal(row.awakeOwned, nodeIdsOf(EXTENSION_ID, 1).length)
    assert.equal(row.targetEvolution, 2)
    assert.equal(row.expCap, getCharacterExpCap(EXTENSION_ID, 5, getCharacterMaxOverLimit(EXTENSION_ID, 5)))
})
