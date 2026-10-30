'use strict'
// Exercise the real routes and queued transactions against disposable SQLite.
const compiled = process.env.STARPOINT_TEST_COMPILED === '1'
if (!compiled) require('ts-node/register/transpile-only')
const load = name => require(`../${compiled ? 'out' : 'src'}/${name}`)
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const root = path.resolve(os.tmpdir())
const directory = fs.mkdtempSync(path.join(root, 'mana-learn-concurrency-'))
Object.assign(process.env, { DATA_DIR: directory, GACHA_SEED_DIR: path.join(directory, 'seeds'),
    CN_WRITER_THREAD: '0', GAME_ROUTINE_LOGS: 'off', GAME_VERBOSE_LOGS: 'false' })
const players = load('data/domains/player'), chars = load('data/domains/character')
const items = load('data/domains/item'), assets = load('lib/assets')
let app, db, sequence = 0
before(async () => {
    load('data').initializeDatabase()
    db = load('data/db').getDb()
    assert.equal(path.dirname(fs.realpathSync(db.name)), fs.realpathSync(directory))
    app = require('fastify')({ logger: false })
    app.addHook('onSend', (_request, reply, payload, done) => done(null,
        String(reply.getHeader('content-type')).startsWith('application/x-msgpack') && typeof payload === 'object'
            ? JSON.stringify(payload) : payload))
    await app.register(load('routes/api/character/mana').default, { prefix: '/mana' })
    await app.ready()
})
after(async () => {
    await app?.close()
    await load('lib/seed-validator').default.close()
    if (db?.open) db.close()
    assert.equal(path.dirname(directory), root)
    fs.rmSync(directory, { recursive: true })
})
function fixture() {
    const account = load('data/domains/account').insertAccountSync({ appId: 'wf_cn', idpAlias: '',
        idpCode: 'mana-concurrency', idpId: `mana-${++sequence}`, status: 'normal' })
    const p = { id: players.insertDefaultPlayerSync(account.id).id, viewer: 879000000 + sequence }
    load('data/activeAccount').saveAccountDefaultPlayer(account.id, p.id)
    load('data/domains/session').insertSessionWithTokenSync({ token: String(p.viewer), accountId: account.id,
        type: 2, expires: new Date('2099-01-01T00:00:00Z') })
    players.updatePlayerSync({ id: p.id, freeMana: 100000, paidMana: 0 })
    return p
}
function learnNode(p, id = 243001, index = 0) {
    if (!chars.getPlayerCharacterSync(p.id, id)) chars.insertDefaultPlayerCharacterSync(p.id, id)
    const [nodeId, cost] = Object.entries(assets.getCharacterManaNodesSync(id, 1))
        .filter(([, node]) => node && node.manaCost > 0)[index]
    for (const item of Object.keys(cost.items)) items.setPlayerItemSync(p.id, Number(item), 10000)
    return { id, nodeId: Number(nodeId), mana: cost.manaCost, items: cost.items, endpoint: 'learn_mana_node' }
}
function awakeNode(p) {
    const id = 341005
    chars.insertDefaultPlayerCharacterSync(p.id, id)
    chars.updatePlayerCharacterSync(p.id, id, { evolutionLevel: 1, manaBoardIndex: 1 })
    const board = assets.getCharacterManaNodesSync(id, 1)
    chars.insertPlayerCharacterManaNodesSync(p.id, id, Object.keys(board).map(Number))
    load('data/domains/character_awake').upsertPlayerCharacterAwakeUnlockSync(p.id, id, 1, 1)
    const nodeId = Number(Object.entries(board).find(([, node]) => node?.field5 === '2' && node.field6 === '')[0])
    const cost = assets.getManaNodeAwakeCost(id, nodeId, assets.getCharacterDataSync(id).rarity)
    assert.ok(cost?.manaAmount > 0)
    for (const item of Object.keys(cost.items)) items.setPlayerItemSync(p.id, Number(item), 10000)
    return { id, nodeId, mana: cost.manaAmount, items: cost.items, endpoint: 'awake_mana_node' }
}
function post(p, node, ids = [node.nodeId]) {
    return app.inject({ method: 'POST', url: `/mana/${node.endpoint}`, payload: {
        viewer_id: p.viewer, character_id: node.id, api_count: 1,
        mana_node_multiplied_id_list: ids, ...(node.endpoint === 'awake_mana_node' ? { awake_level: 1 } : {}),
    } })
}
function ok(result) { assert.equal(result.statusCode, 200, result.body); return result.json().data }
const levels = (p, node) => chars.getPlayerCharacterManaNodeAwakeLevelsSync(p.id, node.id)
const funds = p => { const v = players.getPlayerSync(p.id); return [v.freeMana, v.paidMana] }
const balances = p => items.getPlayerItemsSync(p.id)
function expectedItems(before, nodes) {
    const result = { ...before }
    for (const node of nodes) for (const [id, amount] of Object.entries(node.items)) result[id] -= amount
    return result
}

test('overlapping different characters each pay their real 60-mana node cost', async () => {
    const p = fixture(), nodes = [learnNode(p), learnNode(p, 251001)]
    assert.deepEqual(nodes.map(n => n.mana), [60, 60])
    const beforeItems = balances(p)
    const results = await Promise.all(nodes.map(n => post(p, n)))
    results.forEach(ok)
    assert.deepEqual(funds(p), [99880, 0])
    assert.deepEqual(balances(p), expectedItems(beforeItems, nodes))
    nodes.forEach(n => assert.equal(levels(p, n)[n.nodeId], 0))
})

test('overlapping nodes of one character return a cumulative authoritative list', async () => {
    const p = fixture(), nodes = [learnNode(p), learnNode(p, 243001, 1)]
    const results = (await Promise.all(nodes.map(n => post(p, n)))).map(ok)
    assert.deepEqual(funds(p), [100000 - nodes.reduce((sum, n) => sum + n.mana, 0), 0])
    assert.equal(Object.keys(levels(p, nodes[0])).length, 2)
    assert.deepEqual(results.map(r => r.user_character_mana_node_list['243001'].length).sort(), [1, 2])
})

test('concurrent duplicate learning pays once and preserves the state-refresh response', async () => {
    const p = fixture(), node = learnNode(p), before = balances(p)
    const responses = (await Promise.all([post(p, node, [node.nodeId, node.nodeId]), post(p, node)])).map(ok)
    assert.deepEqual(funds(p), [100000 - node.mana, 0])
    assert.deepEqual(balances(p), expectedItems(before, [node]))
    assert.equal(Object.keys(levels(p, node)).length, 1)
    assert.equal(responses.filter(r => Object.keys(r.item_list).length === 0).length, 1)
    for (const response of responses) assert.deepEqual(response.user_character_mana_node_list[String(node.id)],
        [{ multiplied_id: node.nodeId, awake_level: 0 }])
})

test('the queued request rejects exhausted mana without learning or spending its materials', async () => {
    const p = fixture(), nodes = [learnNode(p), learnNode(p, 251001)]
    players.updatePlayerSync({ id: p.id, freeMana: 50, paidMana: 10 })
    const beforeItems = balances(p), results = await Promise.all(nodes.map(n => post(p, n)))
    assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 400])
    const winner = results.findIndex(r => r.statusCode === 200)
    assert.match(results[1 - winner].body, /Not enough mana/)
    assert.deepEqual(funds(p), [0, 0])
    assert.deepEqual(balances(p), expectedItems(beforeItems, [nodes[winner]]))
    assert.deepEqual(levels(p, nodes[1 - winner]), {})
})

test('the queued request rejects exhausted shared materials without a partial mana debit', async () => {
    const p = fixture(), nodes = [learnNode(p), learnNode(p, 243001, 1)]
    // Different nodes of the same board consume the same base material.
    const shared = Object.keys(nodes[0].items).find(id => nodes[1].items[id] > 0)
    assert.ok(shared)
    items.setPlayerItemSync(p.id, Number(shared), Math.max(nodes[0].items[shared], nodes[1].items[shared]))
    const beforeItems = balances(p), results = await Promise.all(nodes.map(n => post(p, n)))
    assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 400])
    const winner = results.findIndex(r => r.statusCode === 200)
    assert.match(results[1 - winner].body, /Not enough of item/)
    assert.deepEqual(funds(p), [100000 - nodes[winner].mana, 0])
    assert.deepEqual(balances(p), expectedItems(beforeItems, [nodes[winner]]))
    assert.equal(levels(p, nodes[0])[nodes[1 - winner].nodeId], undefined)
})

test('learning and awakening share the current wallet and keep old awake replay semantics', async () => {
    const p = fixture(), nodes = [learnNode(p), awakeNode(p)], before = balances(p)
    const responses = await Promise.all(nodes.map(n => post(p, n)))
    responses.forEach(ok)
    assert.deepEqual(funds(p), [100000 - nodes.reduce((sum, n) => sum + n.mana, 0), 0])
    assert.deepEqual(balances(p), expectedItems(before, nodes))
    assert.equal(levels(p, nodes[1])[nodes[1].nodeId], 1)
    assert.equal(chars.getPlayerCharacterSync(p.id, nodes[1].id).evolutionLevel, 2)
    const prior = { funds: funds(p), items: balances(p), levels: levels(p, nodes[1]) }
    const replay = ok(await post(p, nodes[1]))
    assert.deepEqual({ funds: funds(p), items: balances(p), levels: levels(p, nodes[1]) }, prior)
    assert.deepEqual(replay.item_list, {})
    assert.equal(replay.user_character_mana_node_list[String(nodes[1].id)].length, Object.keys(prior.levels).length)
})

test('a node insertion failure rolls back balances and materials before any success response', async () => {
    const p = fixture(), node = learnNode(p), before = { funds: funds(p), items: balances(p) }
    db.exec(`CREATE TRIGGER mana_learn_fault BEFORE INSERT ON players_characters_mana_nodes
        WHEN NEW.player_id=${p.id} BEGIN SELECT RAISE(ABORT, 'injected mana node fault'); END`)
    try {
        const response = await post(p, node)
        assert.equal(response.statusCode, 500)
        assert.match(response.body, /injected mana node fault/)
        assert.deepEqual({ funds: funds(p), items: balances(p) }, before)
        assert.deepEqual(levels(p, node), {})
    } finally { db.exec('DROP TRIGGER mana_learn_fault') }
    ok(await post(p, node))
    assert.deepEqual(funds(p), [100000 - node.mana, 0])
})

test('duplicate awakening pays once and replay repairs legacy evolution without charging again', async () => {
    const p = fixture(), node = awakeNode(p), before = balances(p)
    const responses = await Promise.all([post(p, node), post(p, node)])
    responses.forEach(ok)
    assert.deepEqual(funds(p), [100000 - node.mana, 0])
    assert.deepEqual(balances(p), expectedItems(before, [node]))
    assert.equal(levels(p, node)[node.nodeId], 1)
    chars.updatePlayerCharacterSync(p.id, node.id, { evolutionLevel: 1 })
    const prior = { funds: funds(p), items: balances(p), levels: levels(p, node) }
    const replay = ok(await post(p, node))
    assert.deepEqual({ funds: funds(p), items: balances(p), levels: levels(p, node) }, prior)
    assert.deepEqual(replay.item_list, {})
    assert.equal(chars.getPlayerCharacterSync(p.id, node.id).evolutionLevel, 2)
    assert.equal(replay.evolution.level, 2)
})
