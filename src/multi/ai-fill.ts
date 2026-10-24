import { getRoom } from "./room/manager"
import { embeddedMultiCoordinator } from "./coordinator/embedded"
import { createRealtimeMaintenanceTimer } from "./coordinator/business-rpc"
import { hasOtherOnlinePlayers } from "../lib/online-presence"

/**
 * Shared random-recruitment fallback for every multiplayer mode.
 *
 * The client keeps random recruitment enabled once the host turns it on and
 * has no separate "disable" action, so the fallback is intentionally sticky:
 * it is scheduled when recruitment is first published and only cancelled by
 * battle start, room disband, or the fallback itself.
 */
const aiFallbackTimers = new Map<string, NodeJS.Timeout>()

/** 服务器上还有其他真人时的等待时长。默认 10 秒。 */
export function aiFillTimeoutMs(): number {
    const parsed = Number.parseInt(process.env.MULTI_AI_FILL_TIMEOUT_MS || "10000", 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10_000
}

/**
 * 全服只有房主一人时的等待时长。默认 3 秒。
 *
 * 没别人在线就没有“再等一会儿会有人进来”的可能，早补早开局。
 * 未配置时回落到 MULTI_AI_FILL_TIMEOUT_MS —— 即“只配一个值 = 不分档”，
 * 这样既有部署和测试只设一个变量也能照常工作。
 */
export function aiFillAloneTimeoutMs(): number {
    const raw = process.env.MULTI_AI_FILL_ALONE_TIMEOUT_MS
    if (raw === undefined || raw.trim() === "") return aiFillTimeoutMs()
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : aiFillTimeoutMs()
}

/**
 * 等待时长按“此刻服务器上除房主外还有没有活跃玩家”决定。
 *
 * 在线判定复用管理页的 5 分钟活跃窗口（HTTP + 联机 TCP 都会刷新），
 * 所以刚退出游戏的玩家仍会被算作在线 —— 这里宁可多等，也不要在有人
 * 正准备进来的时候抢先塞满机器人。
 */
export function resolveAiFillTimeoutMs(hostViewerId: number): number {
    return hasOtherOnlinePlayers(hostViewerId) ? aiFillTimeoutMs() : aiFillAloneTimeoutMs()
}

/**
 * 人少服开着的自动补位开关。
 *
 * 默认关闭：房间只在房主主动打开「随机招募」后、等满 MULTI_AI_FILL_TIMEOUT_MS
 * 才补 AI，这是原版客户端的行为。
 *
 * 打开后房主一建房就进入 AI 补位模式，不再需要玩家手动找招募开关 ——
 * 代价是 NPC 会立刻占住三个席位（getRoomAcceptedSeatCount 把 npc_count 计入），
 * 其他真人再也进不来。人少时正是想要的，人多时应关掉。
 */
export function autoAiFillEnabled(): boolean {
    const raw = (process.env.MULTI_AUTO_AI_FILL || "").trim().toLowerCase()
    return raw === "1" || raw === "true" || raw === "on" || raw === "yes"
}

/** 建房后等多久才补 AI。0（默认）= 房主进入大厅即补。 */
export function autoAiFillDelayMs(): number {
    const parsed = Number.parseInt(process.env.MULTI_AUTO_AI_FILL_DELAY_MS || "0", 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

const autoAiFillTimers = new Map<string, NodeJS.Timeout>()

/**
 * 建房后调用。延迟为 0 时只标记 is_npc_mode，实际的 COM 入场交给
 * lobby 的房主进入钩子（handleEnter → recruitNpcMatesForRoom），
 * 那里已经有 500ms 的稳定延迟，不会和 TCP 建连抢时序。
 */
export function scheduleAutoAiFill(roomNumber: string): void {
    if (!autoAiFillEnabled()) return
    if (autoAiFillTimers.has(roomNumber)) return
    const room = getRoom(roomNumber)
    if (!room) return
    const scheduledInstanceId = room.lifecycle.instanceId
    const delayMs = autoAiFillDelayMs()
    if (delayMs <= 0) {
        room.is_npc_mode = true
        return
    }
    const timer = createRealtimeMaintenanceTimer(() => setTimeout(() => {
        autoAiFillTimers.delete(roomNumber)
        void embeddedMultiCoordinator.enqueueRoomCommand(roomNumber, () => {
            const current = getRoom(roomNumber)
            if (!current
                || current.lifecycle.instanceId !== scheduledInstanceId
                || current.lifecycle.phase !== "LOBBY") return
            const { recruitNpcMatesForRoom } = require("./tcp/lobby") as typeof import("./tcp/lobby")
            current.is_npc_mode = true
            recruitNpcMatesForRoom(roomNumber)
            console.log(`[MULTI-AI] auto fill triggered room=${roomNumber} delayMs=${delayMs}`)
        }).catch(error => console.error(`[MULTI-AI] auto fill failed room=${roomNumber}`, error))
    }, delayMs))
    timer.unref()
    autoAiFillTimers.set(roomNumber, timer)
}

export function scheduleAiFallback(roomNumber: string): void {
    if (aiFallbackTimers.has(roomNumber)) return
    const scheduledRoom = getRoom(roomNumber)
    if (!scheduledRoom) return
    // A lone host gets the short timeout; a populated server keeps the longer
    // window so a real player still has time to walk into the room.
    const hostViewerId = scheduledRoom.host_viewer_id
    const waitingForOthers = hasOtherOnlinePlayers(hostViewerId)
    const timeoutMs = waitingForOthers ? aiFillTimeoutMs() : aiFillAloneTimeoutMs()
    armAiFallback(roomNumber, scheduledRoom.lifecycle.instanceId, hostViewerId, timeoutMs,
        // Only the short timeout is allowed to extend, and only once.
        !waitingForOthers && aiFillTimeoutMs() > timeoutMs)
}

function armAiFallback(
    roomNumber: string,
    scheduledInstanceId: string,
    hostViewerId: number,
    timeoutMs: number,
    extendOnActivity: boolean,
): void {
    const timer = createRealtimeMaintenanceTimer(() => setTimeout(() => {
        aiFallbackTimers.delete(roomNumber)
        // Someone may have come online during the short window. Give the room
        // the normal wait instead of locking the seats with AI immediately.
        if (extendOnActivity && hasOtherOnlinePlayers(hostViewerId)) {
            const room = getRoom(roomNumber)
            if (room
                && room.lifecycle.instanceId === scheduledInstanceId
                && room.lifecycle.phase === "LOBBY"
                && room.lobby_generation === 0) {
                const extendedMs = aiFillTimeoutMs()
                console.log(`[MULTI-AI] extended wait for online players room=${roomNumber} fromMs=${timeoutMs} toMs=${extendedMs}`)
                armAiFallback(roomNumber, scheduledInstanceId, hostViewerId, extendedMs, false)
                return
            }
        }
        void embeddedMultiCoordinator.enqueueRoomCommand(roomNumber, () => {
            const room = getRoom(roomNumber)
            // The fallback belongs to the first lobby only. Rematch lobbies
            // restore the previous AI count and add the extra AI after the
            // real-player reconnect grace instead of waiting another timeout.
            if (!room
                || room.lifecycle.instanceId !== scheduledInstanceId
                || room.lifecycle.phase !== "LOBBY"
                || room.lobby_generation !== 0) return

            // Lazy requires keep this module free of a load-time cycle with
            // the recruitment and TCP lobby modules.
            const { stopRandomRecruitment } = require("./recruitment") as typeof import("./recruitment")
            const { recruitNpcMatesForRoom } = require("./tcp/lobby") as typeof import("./tcp/lobby")
            room.is_npc_mode = true
            stopRandomRecruitment(roomNumber)
            recruitNpcMatesForRoom(roomNumber)
            console.log(`[MULTI-AI] fallback triggered room=${roomNumber} timeoutMs=${timeoutMs}`)
        }).catch(error => console.error(`[MULTI-AI] fallback failed room=${roomNumber}`, error))
    }, timeoutMs))
    timer.unref()
    aiFallbackTimers.set(roomNumber, timer)
}

export function cancelAiFallback(roomNumber: string): void {
    const timer = aiFallbackTimers.get(roomNumber)
    if (timer) clearTimeout(timer)
    aiFallbackTimers.delete(roomNumber)
}

export function hasAiFallback(roomNumber: string): boolean {
    return aiFallbackTimers.has(roomNumber)
}
