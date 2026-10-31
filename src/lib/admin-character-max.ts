/**
 * 后台「存档内容管理器」的角色养成一键拉满。
 *
 * 只负责计算与落库，不碰任何请求/回复；路由在 src/routes/web_api/player.ts。
 *
 * 四个维度，可以单独选：
 *   level      —— exp 抬到当前稀有度+超限档的经验上限，over_limit_step 抬到上限
 *   board      —— 补齐所有玛纳板节点行，mana_board_index 推到板数
 *   awake      —— 板 1 全部节点（以及扩展角色的联动板节点）awake_level 提到上限，
 *                 并补 players_character_awake_unlocks 的授权行
 *   evolution  —— 按 deriveAwakeEvolutionLevel 推导（觉醒后为 2）
 *
 * 全部只抬不降，幂等：已经满的角色不会产生任何写入。
 */
import {
    getCharacterDataSync,
    getCharacterManaBoardCountSync,
    getCharacterManaNodesSync,
} from "./assets"
import { deriveAwakeEvolutionLevel } from "./character-awake-evolution"
import { collectLinkedManaNodeAwakeUpdates } from "./character-awake-extension"
import { getCharacterExpCap, getCharacterMaxOverLimit } from "./character-overlimit"
import { reconcilePlayerManaBoardCompletionSync } from "./character-helpers"
import {
    getPlayerCharactersManaNodeAwakeLevelsSync,
    getPlayerCharactersManaNodesSync,
    getPlayerCharactersSync,
    insertPlayerCharacterManaNodesSync,
    updatePlayerCharacterManaNodeAwakeLevelSync,
    updatePlayerCharacterSync,
} from "../data/domains/character"
import {
    getPlayerCharacterAwakeUnlocksSync,
    upsertPlayerCharacterAwakeUnlockSync,
} from "../data/domains/character_awake"
import { runPersistenceTransactionSync } from "./persistence-coordinator"


/**
 * 玛纳节点觉醒上限。
 *
 * 依据 assets/mana_node_awake.json：每个 (稀有度, 槽位, 台座) 组合只有一行，
 * 也就是说只存在一个觉醒台阶；扩展角色的 linked_mana_node_slots 用的也是 1。
 * 客户端那边 awake_level 同时决定进化等级（deriveAwakeEvolutionLevel = 1 + awake）。
 */
export const MAX_MANA_NODE_AWAKE_LEVEL = 1

export const CHARACTER_MAX_SCOPES = ["level", "board", "awake", "evolution"] as const
export type CharacterMaxScope = typeof CHARACTER_MAX_SCOPES[number]

export interface CharacterMaxChange {
    characterId: number
    rarity: number
    boardCount: number
    /** null 表示这一项不动 */
    exp: number | null
    overLimitStep: number | null
    manaBoardIndex: number | null
    evolutionLevel: number | null
    insertNodeIds: number[]
    awakeNodeIds: number[]
    awakeUnlock: boolean
}

export interface CharacterMaxTotals {
    characters: number
    levelChanges: number
    boardChanges: number
    nodeInserts: number
    awakeNodeChanges: number
    awakeUnlocks: number
    evolutionChanges: number
}

export function emptyCharacterMaxTotals(): CharacterMaxTotals {
    return {
        characters: 0, levelChanges: 0, boardChanges: 0, nodeInserts: 0,
        awakeNodeChanges: 0, awakeUnlocks: 0, evolutionChanges: 0,
    }
}

/** 解析并去重作用域；未知值返回错误信息由调用方转 400。 */
export function parseCharacterMaxScopes(raw: unknown): { scopes: Set<CharacterMaxScope> } | { error: string } {
    if (raw === undefined || raw === null) return { scopes: new Set(CHARACTER_MAX_SCOPES) }
    if (!Array.isArray(raw) || raw.length === 0) return { error: "scopes 必须是非空数组" }
    const scopes = new Set<CharacterMaxScope>()
    for (const item of raw) {
        if (typeof item !== "string" || !(CHARACTER_MAX_SCOPES as readonly string[]).includes(item))
            return { error: `不支持的 scope：${String(item)}，可选 ${CHARACTER_MAX_SCOPES.join(" / ")}` }
        scopes.add(item as CharacterMaxScope)
    }
    return { scopes }
}

function uniqueNodeIds(characterId: number, boardCount: number): { all: number[], board1: number[] } {
    const all = new Set<number>()
    for (let index = 1; index <= boardCount; index++) {
        const nodes = getCharacterManaNodesSync(characterId, index)
        if (nodes) for (const key of Object.keys(nodes)) all.add(Number(key))
    }
    const board1 = Object.keys(getCharacterManaNodesSync(characterId, 1) ?? {}).map(Number)
    return { all: [...all].sort((left, right) => left - right), board1 }
}

/**
 * 计算某个玩家的角色改造计划。
 *
 * 返回的 changes 只包含**确实会产生写入**的角色；totals 是它们的合计，
 * 方便后台在真正执行前先给用户看「会影响多少人、写多少行」。
 */
export function planPlayerCharacterMax(
    playerId: number,
    options: { scopes: Set<CharacterMaxScope>, characterIds?: readonly number[] | null },
): { changes: CharacterMaxChange[], totals: CharacterMaxTotals, skipped: number } {
    const { scopes } = options
    const characters = getPlayerCharactersSync(playerId)
    const learnedNodes = getPlayerCharactersManaNodesSync(playerId)
    const awakeLevels = getPlayerCharactersManaNodeAwakeLevelsSync(playerId)
    const awakeUnlocks = getPlayerCharacterAwakeUnlocksSync(playerId)
    const wanted = options.characterIds ? new Set(options.characterIds.map(Number)) : null

    const changes: CharacterMaxChange[] = []
    const totals = emptyCharacterMaxTotals()
    let skipped = 0

    for (const [idText, character] of Object.entries(characters)) {
        const characterId = Number(idText)
        if (wanted && !wanted.has(characterId)) continue
        const asset = getCharacterDataSync(characterId)
        if (!asset) { skipped++; continue }

        const rarity = asset.rarity
        const boardCount = getCharacterManaBoardCountSync(characterId)
        const { all: everyNodeId, board1 } = uniqueNodeIds(characterId, boardCount)
        const learned = new Set(learnedNodes[idText] ?? [])
        const awakeOf = awakeLevels[idText] ?? {}

        // --- level ---
        let exp: number | null = null
        let overLimitStep: number | null = null
        if (scopes.has("level")) {
            const maxOverLimit = getCharacterMaxOverLimit(characterId, rarity)
            const cap = maxOverLimit === undefined ? undefined : getCharacterExpCap(characterId, rarity, maxOverLimit)
            if (maxOverLimit !== undefined && character.overLimitStep < maxOverLimit) {
                overLimitStep = maxOverLimit
                if (cap !== undefined) exp = cap
            } else if (cap !== undefined && character.exp < cap) {
                exp = cap
            }
        }

        // --- board ---
        let manaBoardIndex: number | null = null
        const insertNodeIds: number[] = []
        if (scopes.has("board")) {
            if (boardCount > 0 && character.manaBoardIndex < boardCount) manaBoardIndex = boardCount
            for (const nodeId of everyNodeId) if (!learned.has(nodeId)) insertNodeIds.push(nodeId)
        }

        // --- awake ---
        // 觉醒板就是板 1（mana.ts 的 awake_mana_node 用 getCharacterManaNodesSync(id, 1) 当觉醒板）。
        // 觉醒是节点行上的 awake_level 字段：行不存在就无从觉醒，所以只勾「觉醒」时
        // 也必须把板 1 的节点补上（等价于顺带学会板 1），否则 UPDATE 会命中 0 行、
        // 接口报成功但玩家看不到任何变化。
        // 扩展角色（character_awake_extension.json 里配了 linked_mana_node_slots 的 9 个）
        // 的联动板另算：只有该板节点全部学会才会跟着免费觉醒，
        // 口径和 collectLinkedManaNodeAwakeUpdates 一致。
        const awakeNodeIds: number[] = []
        let awakeUnlock = false
        if (scopes.has("awake") && board1.length > 0) {
            for (const nodeId of board1) {
                if (!learned.has(nodeId) && !insertNodeIds.includes(nodeId)) insertNodeIds.push(nodeId)
            }
            const learnedAfter = new Set<number>(learned)
            for (const nodeId of insertNodeIds) learnedAfter.add(nodeId)
            for (const nodeId of board1) {
                if (learnedAfter.has(nodeId)
                    && (awakeOf[nodeId] ?? 0) < MAX_MANA_NODE_AWAKE_LEVEL) awakeNodeIds.push(nodeId)
            }
            const currentAwake = new Map<number, number>(
                Object.entries(awakeOf).map(([nodeId, level]) => [Number(nodeId), level]),
            )
            for (const update of collectLinkedManaNodeAwakeUpdates(
                characterId, learnedAfter, currentAwake, MAX_MANA_NODE_AWAKE_LEVEL,
            )) {
                if (!awakeNodeIds.includes(update.nodeId)) awakeNodeIds.push(update.nodeId)
            }
            awakeUnlock = (awakeUnlocks.get(idText)?.[1] ?? 0) < MAX_MANA_NODE_AWAKE_LEVEL
        }

        // --- evolution ---
        let evolutionLevel: number | null = null
        if (scopes.has("evolution")) {
            const board1Nodes = getCharacterManaNodesSync(characterId, 1) ?? {}
            const intendedAwake = new Map<number, number>()
            if (scopes.has("awake")) for (const nodeId of board1) intendedAwake.set(nodeId, MAX_MANA_NODE_AWAKE_LEVEL)
            const derived = deriveAwakeEvolutionLevel(character.evolutionLevel, board1Nodes, intendedAwake)
            const floor = boardCount > 0 && character.manaBoardIndex >= 1 ? 1 : character.evolutionLevel
            const target = Math.max(character.evolutionLevel, derived, floor)
            if (target > character.evolutionLevel) evolutionLevel = target
        }

        if (exp === null && overLimitStep === null && manaBoardIndex === null
            && evolutionLevel === null && insertNodeIds.length === 0
            && awakeNodeIds.length === 0 && !awakeUnlock) {
            skipped++
            continue
        }

        if (exp !== null || overLimitStep !== null) totals.levelChanges++
        if (manaBoardIndex !== null) totals.boardChanges++
        totals.nodeInserts += insertNodeIds.length
        totals.awakeNodeChanges += awakeNodeIds.length
        if (awakeUnlock) totals.awakeUnlocks++
        if (evolutionLevel !== null) totals.evolutionChanges++
        totals.characters++

        changes.push({
            characterId, rarity, boardCount,
            exp, overLimitStep, manaBoardIndex, evolutionLevel,
            insertNodeIds, awakeNodeIds, awakeUnlock,
        })
    }

    return { changes, totals, skipped }
}

/**
 * 执行计划。整个过程一个事务；最后用上游自带的
 * reconcilePlayerManaBoardCompletionSync 补齐羁绊可领取状态和首板进化标记。
 */
export function applyPlayerCharacterMax(
    playerId: number,
    changes: readonly CharacterMaxChange[],
): { totals: CharacterMaxTotals, bondRepaired: number, evolutionRepaired: number } {
    const totals = emptyCharacterMaxTotals()
    if (changes.length === 0) return { totals, bondRepaired: 0, evolutionRepaired: 0 }

    const repair = runPersistenceTransactionSync({
        domain: "admin", playerId, operation: "admin_character_max",
    }, () => {
        for (const change of changes) {
            if (change.insertNodeIds.length > 0) {
                insertPlayerCharacterManaNodesSync(playerId, change.characterId, change.insertNodeIds)
                totals.nodeInserts += change.insertNodeIds.length
            }
            // 觉醒必须在节点行写完之后，UPDATE 才命中
            for (const nodeId of change.awakeNodeIds) {
                updatePlayerCharacterManaNodeAwakeLevelSync(
                    playerId, change.characterId, nodeId, MAX_MANA_NODE_AWAKE_LEVEL,
                )
            }
            totals.awakeNodeChanges += change.awakeNodeIds.length
            if (change.awakeUnlock) {
                upsertPlayerCharacterAwakeUnlockSync(playerId, change.characterId, 1, MAX_MANA_NODE_AWAKE_LEVEL)
                totals.awakeUnlocks++
            }

            const patch: Record<string, number> = {}
            if (change.exp !== null) patch.exp = change.exp
            if (change.overLimitStep !== null) patch.overLimitStep = change.overLimitStep
            if (change.manaBoardIndex !== null) patch.manaBoardIndex = change.manaBoardIndex
            if (change.evolutionLevel !== null) patch.evolutionLevel = change.evolutionLevel
            if (Object.keys(patch).length > 0) updatePlayerCharacterSync(playerId, change.characterId, patch)

            if (change.exp !== null || change.overLimitStep !== null) totals.levelChanges++
            if (change.manaBoardIndex !== null) totals.boardChanges++
            if (change.evolutionLevel !== null) totals.evolutionChanges++
            totals.characters++
        }

        return reconcilePlayerManaBoardCompletionSync(playerId, changes.map(change => change.characterId))
    })

    return {
        totals,
        bondRepaired: repair.repairedCharacterIds.length,
        evolutionRepaired: repair.evolutionCharacterIds.length,
    }
}

/** 单个角色改造 + 落库，供行内按钮使用。 */
export function maxSingleCharacterSync(
    playerId: number,
    characterId: number,
    scopes: Set<CharacterMaxScope>,
): { applied: boolean, plan: CharacterMaxChange | null, totals: CharacterMaxTotals } {
    const { changes, totals } = planPlayerCharacterMax(playerId, { scopes, characterIds: [characterId] })
    if (changes.length === 0) return { applied: false, plan: null, totals }
    applyPlayerCharacterMax(playerId, changes)
    return { applied: true, plan: changes[0], totals }
}

export interface CharacterProgressView {
    rarity: number
    /** 该角色能达到的经验上限（含超限扩展） */
    expCap: number | null
    maxOverLimit: number | null
    boardCount: number
    nodeTotal: number
    nodeOwned: number
    awakeOwned: number
    /** 板满后应该达到的进化等级（觉醒 1 → 进化 2） */
    targetEvolution: number
}

/**
 * 后台角色表格用的进度视图。一次批量读节点，避免逐角色查询。
 */
export function describePlayerCharacterProgress(playerId: number): Record<number, CharacterProgressView> {
    const characters = getPlayerCharactersSync(playerId)
    const learnedNodes = getPlayerCharactersManaNodesSync(playerId)
    const awakeLevels = getPlayerCharactersManaNodeAwakeLevelsSync(playerId)
    const result: Record<number, CharacterProgressView> = {}

    for (const [idText, character] of Object.entries(characters)) {
        const characterId = Number(idText)
        const asset = getCharacterDataSync(characterId)
        const rarity = asset?.rarity ?? 0
        const boardCount = getCharacterManaBoardCountSync(characterId)
        const { all, board1 } = uniqueNodeIds(characterId, boardCount)
        const learned = new Set(learnedNodes[idText] ?? [])
        const awakeOf = awakeLevels[idText] ?? {}
        const maxOverLimit = getCharacterMaxOverLimit(characterId, rarity)
        const expCap = maxOverLimit === undefined ? null : (getCharacterExpCap(characterId, rarity, maxOverLimit) ?? null)

        result[characterId] = {
            rarity,
            expCap,
            maxOverLimit: maxOverLimit ?? null,
            boardCount,
            nodeTotal: all.length,
            nodeOwned: all.filter(nodeId => learned.has(nodeId)).length,
            awakeOwned: board1.filter(nodeId => (awakeOf[nodeId] ?? 0) >= MAX_MANA_NODE_AWAKE_LEVEL).length,
            targetEvolution: board1.length > 0 ? Math.max(character.evolutionLevel, MAX_MANA_NODE_AWAKE_LEVEL + 1) : character.evolutionLevel,
        }
    }
    return result
}
