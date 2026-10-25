const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { EventEmitter } = require('node:events')

// 自动补位（MULTI_AUTO_AI_FILL）验收：建房后不经过「随机招募」也要能补机器人，
// 等待时长按在线人数走 10s / 3s 两档，且不会和随机招募兜底各排一次定时器。
//
// 沿用 tests/multi-ai-fallback-roster.test.cjs 的夹具：只替换传输身份与在线人数，
// 房间成员、命令串行化、Enter/Welcome、招募广播仍走真实编译产物。

const root = path.resolve(__dirname, '..')
const temporaryRoot = path.join(root, 'tmp')
let ownedDataDirectory
if (!process.env.DATA_DIR) {
    fs.mkdirSync(temporaryRoot, { recursive: true })
    ownedDataDirectory = fs.mkdtempSync(path.join(temporaryRoot, 'multi-ai-auto-fill-'))
    process.env.DATA_DIR = ownedDataDirectory
}
process.env.MULTI_AI_FILL_TIMEOUT_MS = '35'
process.env.MULTI_AI_FILL_ALONE_TIMEOUT_MS = '12'
process.env.NPC_JOIN_DELAY_MS = '150'
process.env.NPC_READY_DELAY_MS = '10000'

/** 由每个用例设置；补位逻辑在调用时才读这个 stub，所以可以逐例切换。 */
const presence = { othersOnline: false }

const stubs = new Map([
    [path.join(root, 'out/lib/online-presence.js'), {
        markPlayerOnlineFromTcp() {},
        getOnlinePlayerCountExcluding: () => (presence.othersOnline ? 1 : 0),
        hasOtherOnlinePlayers: () => presence.othersOnline,
    }],
    [path.join(root, 'out/data/domains/player.js'), {
        getPlayerSync: () => ({ partySlot: 1 }),
        updatePlayerPartySlotAsync: async () => {},
    }],
    [path.join(root, 'out/multi/npc/player-party-pool.js'), {
        getNpcPartySelectionOptions: () => ({}),
        getRandomPlayerNpcPartiesSync: (_playerId, count) => Array.from(
            { length: count }, () => ({ party: { characters: [], equipments: [] } }),
        ),
    }],
])
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent)
    if (stubs.has(resolved)) return stubs.get(resolved)
    return originalLoad.call(this, request, parent, isMain)
}
const intervals = []
const originalInterval = global.setInterval
global.setInterval = (...args) => {
    const timer = originalInterval(...args)
    timer.unref()
    intervals.push(timer)
    return timer
}
const rooms = require('../out/multi/room/manager')
const manager = require('../out/multi/state/SessionManager').sessionManager
const coordinator = require('../out/multi/coordinator/embedded').embeddedMultiCoordinator
const lobby = require('../out/multi/tcp/lobby')
const aiFill = require('../out/multi/ai-fill')
global.setInterval = originalInterval

after(() => {
    Module._load = originalLoad
    for (const timer of intervals) clearInterval(timer)
    if (ownedDataDirectory) {
        const resolvedRoot = fs.realpathSync(temporaryRoot)
        const resolvedDirectory = fs.realpathSync(ownedDataDirectory)
        const relative = path.relative(resolvedRoot, resolvedDirectory)
        assert.ok(relative && !path.isAbsolute(relative)
            && relative !== '..' && !relative.startsWith(`..${path.sep}`),
        'owned temporary data directory must resolve inside repository tmp before cleanup')
        fs.rmSync(resolvedDirectory, { recursive: true })
    }
})

class Socket extends EventEmitter {
    destroyed = false
    readable = true
    writable = true
    frames = []
    endCalls = 0
    destroyCalls = 0
    write(frame) {
        this.frames.push(JSON.parse(frame.replace(/\0$/, '')))
        return true
    }
    end() { this.endCalls++; this.writable = false }
    destroy() { this.destroyCalls++; this.destroyed = true; this.emit('close') }
}

function setup(t) {
    const timers = []
    const nativeClearTimeout = global.clearTimeout
    t.mock.method(global, 'setTimeout', (callback, delay, ...args) => {
        const timer = { callback: () => callback(...args), delay, cancelled: false,
            fired: false, unref() { return this }, ref() { return this } }
        timers.push(timer)
        return timer
    })
    t.mock.method(global, 'clearTimeout', timer => {
        if (timers.includes(timer)) timer.cancelled = true
        else nativeClearTimeout(timer)
    })
    const room = rooms.createRoom(101, 101, 1, 2, 1001, 0, 1)
    const clients = []
    function connect(viewerId) {
        const client = manager.createClient(new Socket(), viewerId, room.room_number,
            `${room.room_number}-connection-${clients.length}`, viewerId)
        client.roomGeneration = room.lobby_generation
        client.yourself = { viewerId, playerId: viewerId,
            connectionId: client.connectionId, comId: 0, state: [0], rank: 1,
            currentPartyId: 1, autoStart: false,
            party: { characters: [], equipments: [] } }
        manager.addClientToRoom(client)
        clients.push(client)
        return client
    }
    async function drain() {
        for (let i = 0; i < 3; i++) await coordinator.enqueueRoomCommand(room.room_number, () => {})
    }
    async function enter(client) {
        lobby.handleMessage(client.socket, [0, [0, { party: client.yourself.party }, 1]])
        await drain()
        assert.ok(client.socket.frames.some(frame => frame[0] === 1 && frame[1]?.[0] === 0),
            'the connection must receive actual Welcome before checking later Mates')
    }
    /** 尚未触发的定时器（按延迟筛选）。 */
    function pending(delay) {
        return timers.find(timer => timer.delay === delay && !timer.cancelled && !timer.fired)
    }
    async function fire(timer) {
        assert.equal(timer.cancelled, false)
        timer.fired = true
        timer.callback()
        await drain()
    }
    t.after(() => {
        aiFill.cancelAiFallback(room.room_number)
        manager.commitRoomDisband(room.room_number, 'test_cleanup')
        for (const client of clients) client.socket.destroy()
    })
    return { room, connect, enter, pending, fire, timers }
}

/** 每个用例都要把开关恢复成「未配置」，避免相互污染。 */
function setAutoFill(on, delay) {
    if (on) process.env.MULTI_AUTO_AI_FILL = '1'
    else delete process.env.MULTI_AUTO_AI_FILL
    if (delay === undefined) delete process.env.MULTI_AUTO_AI_FILL_DELAY_MS
    else process.env.MULTI_AUTO_AI_FILL_DELAY_MS = String(delay)
}

test('只有房主在线时，建房后 3 秒档（此处 12ms）自动补齐 2 个机器人', async t => {
    setAutoFill(true)
    presence.othersOnline = false
    const x = setup(t)
    const host = x.connect(101)
    await x.enter(host)

    aiFill.scheduleAutoAiFill(x.room.room_number)
    // 到点前不能提前锁席位
    assert.equal(x.room.is_npc_mode, false)
    assert.equal(host.mates.filter(mate => mate.comId).length, 0)

    const timer = x.pending(12)
    assert.ok(timer, '全服只有房主时必须排 12ms（短档）的补位定时器')
    await x.fire(timer)

    assert.equal(x.room.is_npc_mode, true)
    assert.equal(host.mates.filter(mate => mate.comId).length, 2)
    assert.equal(x.room.lifecycle.phase, 'LOBBY')
})

test('有别人在线时走 10 秒档（此处 35ms），给真人留加入窗口', async t => {
    setAutoFill(true)
    presence.othersOnline = true
    const x = setup(t)
    const host = x.connect(101)
    await x.enter(host)

    aiFill.scheduleAutoAiFill(x.room.room_number)
    assert.equal(x.pending(12), undefined, '有人在线的档位不能是 12ms')
    const timer = x.pending(35)
    assert.ok(timer, '有其他玩家在线时必须排 35ms（长档）的补位定时器')
    await x.fire(timer)

    assert.equal(x.room.is_npc_mode, true)
    assert.equal(host.mates.filter(mate => mate.comId).length, 2)
})

test('自动补位已排程时，随后发布随机招募不会再排一次兜底定时器', async t => {
    setAutoFill(true)
    presence.othersOnline = false
    const x = setup(t)
    const host = x.connect(101)
    await x.enter(host)

    aiFill.scheduleAutoAiFill(x.room.room_number)
    aiFill.scheduleAiFallback(x.room.room_number)
    assert.equal(aiFill.hasAiFallback(x.room.room_number), true)
    const armed = x.timers.filter(timer => !timer.cancelled && !timer.fired && [12, 35].includes(timer.delay))
    assert.equal(armed.length, 1, '同一个房间只能有一个补位定时器')
    await x.fire(armed[0])
    assert.equal(x.room.is_npc_mode, true)
    assert.equal(host.mates.filter(mate => mate.comId).length, 2)
})

test('开关关闭时保持原版行为：不排程、不进 NPC 模式', async t => {
    setAutoFill(false)
    presence.othersOnline = false
    const x = setup(t)
    const host = x.connect(101)
    await x.enter(host)

    aiFill.scheduleAutoAiFill(x.room.room_number)
    assert.equal(aiFill.hasAiFallback(x.room.room_number), false)
    assert.equal(x.room.is_npc_mode, false)
    assert.equal(host.mates.filter(mate => mate.comId).length, 0)
})

test('显式配置 DELAY=0 时建房即进 NPC 模式，不排定时器', async t => {
    setAutoFill(true, 0)
    presence.othersOnline = false
    const x = setup(t)
    const host = x.connect(101)
    await x.enter(host)

    aiFill.scheduleAutoAiFill(x.room.room_number)
    assert.equal(x.room.is_npc_mode, true)
    assert.equal(aiFill.hasAiFallback(x.room.room_number), false)
})
