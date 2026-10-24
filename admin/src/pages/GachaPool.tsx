import { useMemo, useState } from "react"
import {
    Alert, Button, Card, Col, Input, Row, Segmented, Select, Space, Statistic, Switch, Table, Tag, Tooltip, Typography, message,
} from "antd"
import { ReloadOutlined, SyncOutlined } from "@ant-design/icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiGet, apiPost } from "../api/client"
import { AdminPage, StateCard } from "../components/AdminPage"

const { Text } = Typography

interface GachaPoolEntry {
    id: number
    name: string
    type: number
    kind: "角色" | "装备" | "其它"
    enabled: boolean
    inWindow: boolean
    enforced: boolean
    startDate: string | null
    endDate: string | null
    fiveStarCount: number
    poolSize: number
    collab: boolean
}

interface GachaPoolResp {
    serverTime: string
    configPath: string
    persisted: boolean
    totalPlayers: number
    driftedPlayers: number
    total: number
    enabledCount: number
    windowedCount: number
    collabCount: number
    items: GachaPoolEntry[]
}

type EnabledFilter = "全部" | "已开启" | "未开启"
type KindFilter = "全部" | "角色" | "装备" | "其它"

function shortDate(value: string | null): string {
    if (!value) return "—"
    return value.slice(0, 10)
}

export default function GachaPool() {
    const qc = useQueryClient()
    const [keyword, setKeyword] = useState("")
    const [enabledFilter, setEnabledFilter] = useState<EnabledFilter>("全部")
    const [kindFilter, setKindFilter] = useState<KindFilter>("全部")
    const [onlyCollab, setOnlyCollab] = useState(false)

    const { data, isLoading, isError, refetch, isFetching } = useQuery({
        queryKey: ["gacha-pool"],
        queryFn: () => apiGet<GachaPoolResp>("/api/gacha-pool"),
    })

    const invalidate = () => qc.invalidateQueries({ queryKey: ["gacha-pool"] })

    const toggle = useMutation({
        mutationFn: (vars: { ids: number[]; enabled: boolean }) =>
            apiPost<{ players: number; added: number; removed: number }>("/api/gacha-pool/set", {
                gachaIds: vars.ids,
                enabled: vars.enabled,
            }),
        onSuccess: (res, vars) => {
            const changed = vars.enabled ? res.added : res.removed
            if (changed === 0) {
                message.info("状态没有变化")
            } else {
                message.success(
                    `${vars.enabled ? "已开启" : "已关闭"} ${vars.ids.length} 个卡池 · ${res.players} 位玩家已同步`,
                )
            }
            invalidate()
        },
        onError: (e: Error) => message.error(e.message),
    })

    const syncAll = useMutation({
        mutationFn: () => apiPost<{ players: number; added: number; removed: number }>("/api/gacha-pool/sync"),
        onSuccess: res => {
            message.success(`已对齐 ${res.players} 位玩家（+${res.added} / -${res.removed}）`)
            invalidate()
        },
        onError: (e: Error) => message.error(e.message),
    })

    const items = data?.items ?? []

    const filtered = useMemo(() => {
        const kw = keyword.trim().toLowerCase()
        return items.filter(item => {
            if (enabledFilter === "已开启" && !item.enabled) return false
            if (enabledFilter === "未开启" && item.enabled) return false
            if (kindFilter !== "全部" && item.kind !== kindFilter) return false
            if (onlyCollab && !item.collab) return false
            if (kw && !`${item.id} ${item.name}`.toLowerCase().includes(kw)) return false
            return true
        })
    }, [items, keyword, enabledFilter, kindFilter, onlyCollab])

    const toEnable = filtered.filter(i => !i.enabled).map(i => i.id)
    const toDisable = filtered.filter(i => i.enabled).map(i => i.id)

    if (isLoading) return <StateCard><Text type="secondary">加载中…</Text></StateCard>
    if (isError || !data) return <Card><Text type="danger">接口不可用</Text></Card>

    const columns = [
        {
            title: "启用", key: "enabled", width: 76, fixed: "left" as const,
            render: (_: unknown, r: GachaPoolEntry) => (
                <Switch
                    size="small"
                    checked={r.enabled}
                    loading={toggle.isPending && toggle.variables?.ids.includes(r.id)}
                    onChange={checked => toggle.mutate({ ids: [r.id], enabled: checked })}
                />
            ),
        },
        {
            title: "ID", key: "id", width: 88,
            render: (_: unknown, r: GachaPoolEntry) => <Text type="secondary">{r.id}</Text>,
        },
        {
            title: "卡池", key: "name", ellipsis: true,
            render: (_: unknown, r: GachaPoolEntry) => (
                <Space size={6}>
                    <span>{r.name}</span>
                    {r.collab && <Tag color="purple">联动</Tag>}
                </Space>
            ),
        },
        {
            title: "类型", key: "kind", width: 84,
            render: (_: unknown, r: GachaPoolEntry) => (
                <Tag color={r.kind === "角色" ? "blue" : r.kind === "装备" ? "gold" : "default"}>{r.kind}</Tag>
            ),
        },
        {
            title: "内容", key: "pool", width: 116, align: "right" as const,
            render: (_: unknown, r: GachaPoolEntry) => (
                <Text type="secondary" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                    {r.fiveStarCount > 0 ? `5★ ${r.fiveStarCount} / ` : ""}
                    {r.poolSize}
                </Text>
            ),
        },
        {
            title: "原始时间窗", key: "window", width: 252,
            render: (_: unknown, r: GachaPoolEntry) => (
                <Tooltip title={r.enforced ? "该池启用了时间窗校验，窗口外无法抽取" : "该池不校验时间窗，任何时间都能抽"}>
                    <Space size={6} style={{ whiteSpace: "nowrap" }}>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                            {shortDate(r.startDate)} ~ {shortDate(r.endDate)}
                        </Text>
                        {r.inWindow
                            ? <Tag color="green" style={{ marginInlineEnd: 0 }}>窗口内</Tag>
                            : <Tag style={{ marginInlineEnd: 0 }}>窗口外</Tag>}
                    </Space>
                </Tooltip>
            ),
        },
    ]

    return (
        <AdminPage
            eyebrow="GACHA POOLS"
            title="卡池开关"
            description="全局生效：改一次，所有玩家一起变。游戏里能看到的卡池就是这张表里的行，改完让客户端重新登录（或重新进大厅）即可。"
            actions={<Button icon={<ReloadOutlined />} loading={isFetching} onClick={() => refetch()}>刷新</Button>}
        >
            <Space direction="vertical" size="large" style={{ width: "100%" }}>
                <Card size="small">
                    <Row gutter={[16, 12]} align="middle">
                        <Col>
                            <Statistic title="卡池总数" value={items.length} />
                        </Col>
                        <Col>
                            <Statistic title="已开启" value={data.enabledCount} valueStyle={{ color: "#3fb950" }} />
                        </Col>
                        <Col>
                            <Statistic title="含联动" value={data.collabCount} />
                        </Col>
                        <Col>
                            <Statistic title="玩家数" value={data.totalPlayers} />
                        </Col>
                        <Col>
                            <Statistic
                                title="全服一致"
                                value={data.driftedPlayers === 0 ? "是" : `${data.driftedPlayers} 位未同步`}
                                valueStyle={{ fontSize: 18, color: data.driftedPlayers === 0 ? "#3fb950" : "#d29922" }}
                            />
                        </Col>
                        <Col flex="auto" style={{ textAlign: "right" }}>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                                服务器时间 {data.serverTime.slice(0, 10)}
                            </Text>
                        </Col>
                    </Row>
                </Card>

                {data.driftedPlayers > 0 && (
                    <Alert
                        type="warning"
                        showIcon
                        message={`有 ${data.driftedPlayers} 位玩家的卡池和全局设置不一致`}
                        description="通常是新玩家加入，或旧存档带了自己的卡池列表。点右侧按钮把它们拉到和全局一致。"
                        action={(
                            <Button size="small" icon={<SyncOutlined />} loading={syncAll.isPending} onClick={() => syncAll.mutate()}>
                                立即同步
                            </Button>
                        )}
                    />
                )}

                <Alert
                    type="info"
                    showIcon
                    message="改时间没用，只有这张表决定游戏里看得见哪些池"
                    description={
                        <span>
                            <b>列表显示</b> 完全由 <Text code>players_gacha_info</Text> 决定；
                            <b>能不能抽</b> 才和卡池的 <Text code>startDate ~ endDate</Text> 有关，而且只有池子显式打开
                            <Text code>enforceAvailabilityWindow</Text> 才会拦人 —— 现有 {items.length} 个池全都没开这个开关，
                            所以<b>任何时间都能抽</b>。想换池子，直接在这里拨开关就行，不用调服务器时间。
                        </span>
                    }
                />

                <Card
                    title="卡池列表（全服统一）"
                    size="small"
                    extra={(
                        <Space wrap size={8}>
                            <Input.Search
                                allowClear
                                placeholder="搜名称或 ID"
                                value={keyword}
                                onChange={e => setKeyword(e.target.value)}
                                style={{ width: 200 }}
                            />
                            <Segmented
                                size="small"
                                value={enabledFilter}
                                onChange={v => setEnabledFilter(v as EnabledFilter)}
                                options={["全部", "已开启", "未开启"]}
                            />
                            <Select
                                size="small"
                                style={{ width: 96 }}
                                value={kindFilter}
                                onChange={v => setKindFilter(v)}
                                options={["全部", "角色", "装备", "其它"].map(v => ({ value: v, label: v }))}
                            />
                            <Space size={4}>
                                <Switch size="small" checked={onlyCollab} onChange={setOnlyCollab} />
                                <Text style={{ fontSize: 12 }}>只看联动</Text>
                            </Space>
                        </Space>
                    )}
                >
                    <Space wrap size={8} style={{ marginBottom: 12 }}>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                            筛选出 {filtered.length} 个
                        </Text>
                        <Button
                            size="small"
                            type="primary"
                            disabled={toEnable.length === 0}
                            loading={toggle.isPending && toggle.variables?.enabled === true}
                            onClick={() => toggle.mutate({ ids: toEnable, enabled: true })}
                        >
                            开启筛选结果（{toEnable.length}）
                        </Button>
                        <Button
                            size="small"
                            disabled={toDisable.length === 0}
                            loading={toggle.isPending && toggle.variables?.enabled === false}
                            onClick={() => toggle.mutate({ ids: toDisable, enabled: false })}
                        >
                            关闭筛选结果（{toDisable.length}）
                        </Button>
                        <Button
                            size="small"
                            onClick={() => toggle.mutate({
                                ids: items.filter(i => i.collab && !i.enabled).map(i => i.id),
                                enabled: true,
                            })}
                        >
                            一键开启全部联动池
                        </Button>
                    </Space>

                    <Table
                        size="small"
                        rowKey="id"
                        scroll={{ x: "max-content" }}
                        pagination={{ pageSize: 20, hideOnSinglePage: true, size: "small", showSizeChanger: false }}
                        dataSource={filtered}
                        columns={columns}
                    />
                </Card>

                <Card title="注意事项" size="small">
                    <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
                        <li><b>开太多会让游戏里的卡池界面非常长</b>，客户端要一屏一屏翻。建议只留自己想抽的那几个。</li>
                        <li><b>关闭卡池会一并清掉该池已积累的兑换点</b>（客户端没有「隐藏」状态，只能删行）。</li>
                        <li>改动一次性写进所有玩家，不需要逐个账号操作。</li>
                        <li>客户端缓存了卡池列表，改完要<b>重新登录</b>（或重新进大厅）才会拉到新列表。</li>
                        <li>联动角色共 14 个，分布在 15 个池子里。带「联动」标签的就是其中包含联动角色的池。</li>
                        <li>全局设置存在 <Text code>{data.configPath}</Text>，手工改完点「刷新」也会生效。</li>
                    </ul>
                </Card>
            </Space>
        </AdminPage>
    )
}
