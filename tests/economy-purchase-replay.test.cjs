'use strict'
const compiled = process.env.STARPOINT_TEST_COMPILED === '1'
if (!compiled) require('ts-node/register/transpile-only')
const load = name => require(`../${compiled ? 'out' : 'src'}/${name}`)
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { execFileSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const replayChild = process.argv.includes('--replay')
const root = path.resolve(process.env.STARPOINT_TEST_TMP_ROOT || os.tmpdir())
fs.mkdirSync(root, { recursive: true })
const directory = replayChild ? process.env.DATA_DIR : fs.mkdtempSync(path.join(root, 'economy-purchase-replay-'))
Object.assign(process.env, { DATA_DIR: directory, TEMP: directory, TMP: directory, SQLITE_TMPDIR: directory,
    GACHA_SEED_DIR: path.join(directory, 'seeds'), CN_WRITER_THREAD: '0', GAME_VERBOSE_LOGS: 'false', GAME_ROUTINE_LOGS: 'off' })
const players = load('data/domains/player'), characters = load('data/domains/character'), items = load('data/domains/item')
const assets = load('lib/assets'), identities = load('lib/gameplay-request-identity')
let db, app
async function initialize() {
    load('data').initializeDatabase()
    db = load('data/db').getDb()
    assert.equal(path.dirname(fs.realpathSync(db.name)), fs.realpathSync(directory))
    identities.initializeGameplayRequestIdentitySchemaSync(db)
    app = require('fastify')({ logger: false })
    app.addHook('onSend', (_request, reply, body, done) => done(null,
        String(reply.getHeader('content-type')).startsWith('application/x-msgpack') && typeof body === 'object' ? JSON.stringify(body) : body))
    for (const route of ['shop', 'expod', 'boxGacha']) await app.register(load('routes/api/' + route).default, { prefix: '/' + route })
    await app.ready()
}
async function close() {
    if (app) await app.close()
    await load('lib/seed-validator').default.close()
    if (db?.open) db.close()
}
function fixture() {
    const account = load('data/domains/account').insertAccountSync({ appId: 'wf_cn', idpAlias: '', idpCode: 'purchase-replay', idpId: randomUUID(), status: 'normal' })
    const player = players.insertDefaultPlayerSync(account.id), viewer = 890000000 + player.id
    load('data/activeAccount').saveAccountDefaultPlayer(account.id, player.id)
    db.prepare('INSERT INTO sessions(token,account_id,expires,type) VALUES(?,?,?,2)').run(String(viewer), account.id, '2099-01-01T00:00:00Z')
    const token = db.transaction(() => identities.issueGameplayLoginTokenSync(db, {
        accountId: account.id, viewerId: viewer, udid: 'purchase-' + viewer, expiresAt: Date.now() + 86400000,
    }))()
    return { id: player.id, viewer, token }
}
const post = (p, url, body, count = 1) => app.inject({ method: 'POST', url,
    headers: { login_token: p.token }, payload: { viewer_id: p.viewer, api_count: count, ...body } })
function data(response) { assert.equal(response.statusCode, 200, response.body); return response.json().data }
function snapshot(p) {
    const result = { player: players.getPlayerSync(p.id) }
    for (const table of ['players_characters', 'players_items', 'players_equipment', 'players_receive_history',
        'players_shop_purchases', 'players_shop_quotas', 'players_box_gacha', 'players_box_gacha_drawn_rewards',
        'players_active_mission_counters', 'player_operation_receipts']) {
        result[table] = db.prepare(`SELECT * FROM ${table} WHERE player_id=? ORDER BY rowid`).all(p.id)
    }
    return result
}
function boxControl(enabled) {
    const store = load('lib/content-operations').contentOperations()
    for (const key of ['box_gacha:1001', 'world_story_event:200103']) store.update(key, {
        expectedRevision: store.revision(), catalogDigest: store.digest,
        reason: 'Prepare a disposable purchase replay fixture', readiness: 'verified', evidence: 'Synthetic test only',
        flags: key.startsWith('box_') ? { visible: enabled, enter: enabled, claim: enabled } : { visible: enabled, enter: enabled, exchange: enabled },
        endsAtMs: null,
    }, Date.now())
}
const cases = [
    { name: 'ordinary shop purchase', route: '/shop/buy', prepare(p) {
        players.updatePlayerSync({ id: p.id, freeMana: 1000, paidMana: 0 })
        return { shop_type: 2, shop_item_id: 200070, number: 1 }
    }, verify(p, count) { assert.equal(players.getPlayerSync(p.id).freeMana, 1000 - count * 100) } },
    { name: 'bead stamina recovery', route: '/shop/recover_stamina', prepare(p) {
        players.updatePlayerSync({ id: p.id, freeVmoney: 1000, vmoney: 0, stamina: 0, staminaHealTime: new Date() })
        return {}
    }, verify(p, count) { assert.equal(players.getPlayerSync(p.id).freeVmoney, 1000 - count * assets.getConfigSync().stamina_recovery_virtual_money) } },
    { name: 'experience injection', route: '/expod/inject_exp', prepare(p) {
        players.updatePlayerSync({ id: p.id, expPool: 10000, expPooledTime: new Date() })
        characters.insertDefaultPlayerCharacterSync(p.id, 243001)
        return { character_id: 243001, exp: 100 }
    }, verify(p, count) {
        assert.equal(players.getPlayerSync(p.id).expPool, 10000 - count * 100)
        assert.equal(characters.getPlayerCharacterSync(p.id, 243001).exp, count * 100)
    } },
    { name: 'box gacha draw', route: '/boxGacha/exec', prepare(p) {
        boxControl(true)
        items.setPlayerItemSync(p.id, assets.getBoxGachaSync(1001).redeemItemId, 1000000)
        return { box_gacha_id: 1001, box_id: 1, number: 1, stop_on_featured_rewards: false }
    }, verify(p, count) {
        assert.equal(load('data/domains/boxGacha').getPlayerBoxGachaDrawnRewardsSync(p.id, 1001, 1).reduce((n, r) => n + r.number, 0), count)
    } },
]

if (replayChild) {
    initialize().then(async () => {
        const input = JSON.parse(process.env.PURCHASE_REPLAY_INPUT)
        const result = data(await post(input.player, input.route, input.body, input.count))
        process.stdout.write('REPLAY_RESULT:' + JSON.stringify(result) + '\n')
    }).catch(error => { console.error(error); process.exitCode = 1 }).finally(close)
} else {
    const { test, before, after } = require('node:test')
    before(initialize)
    after(async () => {
        await close()
        assert.equal(path.dirname(directory), root)
        fs.rmSync(directory, { recursive: true })
    })
    for (const item of cases) {
        test(item.name + ': concurrent delivery, lost reply, and fresh process replay exactly one complete response', async () => {
            const p = fixture(), body = item.prepare(p)
            const pair = await Promise.all([post(p, item.route, body), post(p, item.route, body)])
            const first = data(pair[0])
            assert.deepEqual(data(pair[1]), first)
            item.verify(p, 1)
            const committed = snapshot(p)
            assert.deepEqual(data(await post(p, item.route, { ...body, retry_count: 1 })), first)
            assert.deepEqual(snapshot(p), committed)
            const receiptRows = db.prepare("SELECT response_json FROM player_operation_receipts WHERE player_id=? AND operation='gameplay_mutation.v1'").all(p.id)
            assert.equal(receiptRows.length, 1)
            assert.deepEqual(JSON.parse(receiptRows[0].response_json).response, first)
            const childOutput = execFileSync(process.execPath, [__filename, '--replay'], {
                cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 60000, windowsHide: true,
                env: { ...process.env, PURCHASE_REPLAY_INPUT: JSON.stringify({ player: p, route: item.route, body, count: 1 }) },
            })
            assert.deepEqual(JSON.parse(childOutput.split('\n').find(line => line.startsWith('REPLAY_RESULT:')).slice(14)), first)
            assert.deepEqual(snapshot(p), committed)
            data(await post(p, item.route, body, 2))
            item.verify(p, 2)
        })
        test(item.name + ': receipt failure rolls back all costs and rewards', async () => {
            const p = fixture(), body = item.prepare(p), original = snapshot(p)
            db.exec(`CREATE TRIGGER fail_purchase_receipt BEFORE INSERT ON player_operation_receipts
                WHEN NEW.player_id=${p.id} AND NEW.operation='gameplay_mutation.v1'
                BEGIN SELECT RAISE(ABORT,'synthetic purchase receipt failure'); END`)
            try {
                assert.equal((await post(p, item.route, body)).statusCode, 500)
                assert.deepEqual(snapshot(p), original)
            } finally { db.exec('DROP TRIGGER fail_purchase_receipt') }
            data(await post(p, item.route, body))
            item.verify(p, 1)
        })
    }
    test('one native identity cannot pay through another route or changed payload', async () => {
        const p = fixture()
        const bodies = cases.map(item => item.prepare(p))
        data(await post(p, cases[0].route, bodies[0]))
        const committed = snapshot(p)
        for (const [index, item] of cases.entries()) {
            const body = index === 0 ? { ...bodies[0], number: 2 } : bodies[index]
            assert.equal((await post(p, item.route, body)).statusCode, 400)
            assert.deepEqual(snapshot(p), committed)
        }
    })
    test('paid box response replays after both event gates close; new requests are still rejected', async () => {
        const item = cases[3], p = fixture(), body = item.prepare(p)
        const first = data(await post(p, item.route, body)), committed = snapshot(p)
        boxControl(false)
        assert.deepEqual(data(await post(p, item.route, body)), first)
        assert.equal((await post(p, item.route, body, 2)).statusCode, 400)
        assert.deepEqual(snapshot(p), committed)
    })
    test('negative EXP input and the last available balance retain native clamping and replay', async () => {
        const item = cases[2], p = fixture(), body = item.prepare(p)
        players.updatePlayerSync({ id: p.id, expPool: 50 })
        const first = data(await post(p, item.route, { ...body, exp: -100 }))
        assert.equal(first.user_info.exp_pool, 0)
        assert.equal(characters.getPlayerCharacterSync(p.id, 243001).exp, 50)
        assert.deepEqual(data(await post(p, item.route, { ...body, exp: -100 })), first)
        assert.equal(characters.getPlayerCharacterSync(p.id, 243001).exp, 50)
    })
    test('enhancement purchases replay the paid stage after it is no longer current', async () => {
        const p = fixture(), equipment = load('data/domains/equipment')
        equipment.insertPlayerEquipmentSync(p.id, 5010070, { level: 1, enhancementLevel: 0, protection: false, stack: 1 })
        items.setPlayerItemSync(p.id, 40313, 2)
        const body = { shop_type: 10, shop_item_id: 1001, number: 1 }
        const first = data(await post(p, '/shop/buy', body)), committed = snapshot(p)
        assert.equal(equipment.getPlayerEquipmentSync(p.id, 5010070).enhancementLevel, 1)
        assert.equal(items.getPlayerItemSync(p.id, 40313), 1)
        assert.deepEqual(data(await post(p, '/shop/buy', body)), first)
        assert.equal((await post(p, '/shop/buy', body, 2)).statusCode, 400)
        assert.deepEqual(snapshot(p), committed)
        data(await post(p, '/shop/buy', { shop_type: 10, shop_item_id: 1003, number: 11 }, 2))
        assert.equal(equipment.getPlayerEquipmentSync(p.id, 5010070).enhancementLevel, 12)
        assert.equal(items.getPlayerItemSync(p.id, 40313), 0)
    })
    test('the last shop and stamina payment replays with exhausted funds', async () => {
        for (const index of [0, 1]) {
            const item = cases[index], p = fixture(), body = item.prepare(p)
            players.updatePlayerSync(index === 0 ? { id: p.id, freeMana: 100 } : {
                id: p.id, freeVmoney: assets.getConfigSync().stamina_recovery_virtual_money,
            })
            const first = data(await post(p, item.route, body)), committed = snapshot(p)
            assert.deepEqual(data(await post(p, item.route, body)), first)
            assert.deepEqual(snapshot(p), committed)
            const next = await post(p, item.route, body, 2)
            if (index === 0) assert.equal(next.statusCode, 400)
            else assert.deepEqual(data(next), {}, 'retain the native insufficient-funds response')
            assert.deepEqual(snapshot(p), committed)
        }
    })
    test('missing or unrelated login identity cannot start these mutations', async () => {
        const other = fixture()
        for (const item of cases) {
            const p = fixture(), body = item.prepare(p), original = snapshot(p)
            for (const token of [undefined, other.token]) {
                const response = await app.inject({ method: 'POST', url: item.route,
                    headers: token ? { login_token: token } : {}, payload: { viewer_id: p.viewer, api_count: 1, ...body } })
                assert.equal(response.statusCode, 400)
                assert.deepEqual(snapshot(p), original)
            }
        }
    })
}
