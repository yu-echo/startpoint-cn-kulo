'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const ts = require('typescript'), Sqlite = require('better-sqlite3'), Fastify = require('fastify')
const root = path.resolve(__dirname, '..')

function loadTs(relative, imports, globals = {}) {
    const filename = path.join(root, relative)
    const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        reportDiagnostics: true,
    })
    assert.equal(result.diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0)
    const module = { exports: {} }
    vm.runInNewContext(result.outputText, {
        module, exports: module.exports, process, Buffer, URL, setTimeout, clearTimeout,
        __dirname: path.dirname(filename), console,
        require(name) {
            if (Object.hasOwn(imports, name)) return imports[name]
            if (!name.startsWith('.')) return require(name)
            throw new Error(`Unexpected import: ${name}`)
        }, ...globals,
    }, { filename })
    return module.exports
}

async function fixture(t, options = {}) {
    const db = new Sqlite(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(`CREATE TABLE accounts(id INTEGER PRIMARY KEY);
        CREATE TABLE players(id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE);
        CREATE TABLE sessions(token TEXT PRIMARY KEY, account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE, type INTEGER);
        CREATE TABLE device_bindings(account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE);
        INSERT INTO accounts VALUES(1),(2);
        INSERT INTO players VALUES(11,1),(21,2);
        INSERT INTO sessions VALUES('701',1,2),('702',1,2),('0701',1,2),('invalid',1,2),('999',1,1),('801',2,2);
        INSERT INTO device_bindings VALUES(1),(2);`)
    if (options.extraSave) db.exec('INSERT INTO players VALUES(12,1)')
    if (options.rollback) db.exec(`CREATE TRIGGER reject_delete BEFORE DELETE ON accounts
        WHEN old.id=1 BEGIN SELECT RAISE(ABORT,'synthetic deletion failure'); END;`)
    const events = [], disconnected = []
    const imports = {}
    // Register the complete route module; unused endpoint dependencies stay inert.
    const source = ts.createSourceFile('server.ts', fs.readFileSync(path.join(root, 'src/routes/web_api/server.ts'), 'utf8'), ts.ScriptTarget.Latest)
    for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text.startsWith('.')) {
            imports[statement.moduleSpecifier.text] = {}
        }
    }
    Object.assign(imports, {
        '../../data/db': { getDb: () => db },
        '../../data/types': { SessionType: { VIEWER: 2 } },
        '../../data/domains/account': {
            getAllAccountsSync: () => db.prepare('SELECT id FROM accounts').all(),
            getAccountPlayersSync: id => db.prepare('SELECT id FROM players WHERE account_id=? ORDER BY id').all(id).map(row => row.id),
            deleteAccountSync: id => db.prepare('DELETE FROM accounts WHERE id=?').run(id),
        },
        '../../data/domains/player': { deletePlayerSync: id => db.prepare('DELETE FROM players WHERE id=?').run(id) },
        '../../lib/persistence-coordinator': {
            runPersistenceTransaction: async (_context, operation) => {
                const result = db.transaction(operation).immediate()
                events.push('committed')
                return result
            },
            runPersistenceTransactionSync: (_context, operation) => {
                const result = db.transaction(operation).immediate()
                events.push('committed')
                return result
            },
        },
        '../../lib/player-login': { disconnectDeletedPlayerLogin: viewer => {
            assert.equal(db.inTransaction, false, 'disconnect must follow COMMIT')
            assert.equal(db.prepare('SELECT id FROM accounts WHERE id=1').get(), undefined)
            events.push(`disconnect:${viewer}`); disconnected.push(viewer)
        } },
        '../../data/activeAccount': {
            removeDeletedAccountFromState: () => {
                events.push('sidecar')
                if (options.sidecarFailure) throw new Error('synthetic sidecar failure')
            },
            removeDeletedPlayerFromState: () => { events.push('save-sidecar') },
        },
        '../../multi/npc/player-party-pool': { removePlayerQuestNpcPartySnapshots: async () => {
            events.push('ai-cleanup')
            if (options.aiFailure) throw new Error('synthetic AI cleanup failure')
            return { removedRows: 0, affectedQuestCount: 0 }
        } },
        '../../lib/admin-static-cache': { createAdminStaticCache: () => ({}) },
        './http': { wantsJson: () => true },
    })
    const warnings = []
    const routes = loadTs('src/routes/web_api/server.ts', imports,
        { console: { ...console, warn: (...args) => warnings.push(args) } }).default
    const routePath = loadTs('src/lib/request-route-path.ts', {})
    const management = loadTs('src/lib/management-auth.ts', { './request-route-path': routePath })
    const app = Fastify({ logger: false })
    t.after(async () => { await app.close(); db.close() })
    const previousPassword = process.env.ADMIN_PANEL_PASSWORD
    process.env.ADMIN_PANEL_PASSWORD = 'synthetic-delete-disconnect'
    try { management.installManagementAuth(app) }
    finally {
        if (previousPassword === undefined) delete process.env.ADMIN_PANEL_PASSWORD
        else process.env.ADMIN_PANEL_PASSWORD = previousPassword
    }
    await app.register(routes, { prefix: '/api/server' })
    const login = await app.inject({ method: 'POST', url: '/admin-login', payload: { password: 'synthetic-delete-disconnect' } })
    assert.equal(login.statusCode, 200, login.body)
    const cookie = login.headers['set-cookie'].split(';')[0]
    const post = (route, authenticated = true) => app.inject({ method: 'POST',
        url: '/api/server/' + route + (route === 'deleteAccount' ? '?id=1' : '?playerId=11'),
        headers: authenticated ? { cookie, accept: 'application/json' } : { accept: 'application/json' } })
    return { db, events, disconnected, post, warnings }
}

for (const route of ['deleteAccount', 'deleteSave']) {
    test(`${route}: committed account deletion revokes every related viewer before cleanup`, async t => {
        const f = await fixture(t)
        const response = await f.post(route)
        assert.equal(response.statusCode, 200, response.body)
        assert.deepEqual(f.events, ['committed', 'disconnect:701', 'disconnect:702', 'sidecar', 'ai-cleanup'])
        assert.equal(f.db.prepare('SELECT count(*) AS n FROM sessions WHERE account_id=1').get().n, 0)
        assert.equal(f.db.prepare('SELECT account_id FROM sessions WHERE token=?').get('801').account_id, 2)
    })
    test(`${route}: rollback keeps account, saves and sessions without disconnecting`, async t => {
        const f = await fixture(t, { rollback: true })
        assert.equal((await f.post(route)).statusCode, 500)
        assert.deepEqual(f.events, [])
        assert.equal(f.db.prepare('SELECT account_id FROM players WHERE id=11').get().account_id, 1)
        assert.equal(f.db.prepare('SELECT count(*) AS n FROM sessions WHERE account_id=1').get().n, 5)
    })
    test(`${route}: failed selection sidecar cannot prevent post-commit disconnection`, async t => {
        const f = await fixture(t, { sidecarFailure: true })
        assert.equal((await f.post(route)).statusCode, 500)
        assert.deepEqual(f.events, ['committed', 'disconnect:701', 'disconnect:702', 'sidecar'])
    })
    test(`${route}: failed AI cleanup retains committed deletion and disconnection`, async t => {
        const f = await fixture(t, { aiFailure: true })
        assert.equal((await f.post(route)).statusCode, 200)
        assert.deepEqual(f.events, ['committed', 'disconnect:701', 'disconnect:702', 'sidecar', 'ai-cleanup'])
        assert.equal(f.warnings.length, 1)
    })
    test(`${route}: management authentication still rejects unauthorized deletion`, async t => {
        const f = await fixture(t)
        assert.equal((await f.post(route, false)).statusCode, 401)
        assert.deepEqual(f.events, [])
        assert.ok(f.db.prepare('SELECT id FROM accounts WHERE id=1').get())
    })
}

test('deleting a nonfinal save preserves the account and does not revoke its viewers', async t => {
    const f = await fixture(t, { extraSave: true })
    const response = await f.post('deleteSave')
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().accountAlsoDeleted, false)
    assert.deepEqual(f.disconnected, [])
    assert.deepEqual(f.events, ['committed', 'ai-cleanup', 'save-sidecar'])
    assert.equal(f.db.prepare('SELECT id FROM players WHERE id=11').get(), undefined)
    assert.ok(f.db.prepare('SELECT id FROM players WHERE id=12').get())
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM sessions WHERE account_id=1').get().n, 5)
})
