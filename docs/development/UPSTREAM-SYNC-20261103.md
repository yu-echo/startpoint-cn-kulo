# 上游同步记录 2026-11-03（测试服 1.4.271 → 1.4.351）

## 一、上游换了仓库

| 项 | 结论 |
| --- | --- |
| 原上游 `Ku1o/startpoint-cn-kulo` | **已删除**，GitHub 返回 404 |
| `Ku1o` 账号剩余公开仓库 | 只有 `StarPoint-Character-Studio` |
| 作者新的活跃仓库 | **`kuronzzhan-droid/startpoint-cn`**（`DontBeAlarmed/startpoint-cn` 的 fork） |
| 依据 | `Ku1o` 的公开活动记录里出现该仓库的 PR/创建事件（2026-10-20）；本地最老提交 `83f49b1f` 的 author 也是 `kuronzzhan-droid` |

已在本仓库添加远端：

```
git remote add upstream-cn https://github.com/kuronzzhan-droid/startpoint-cn.git
git fetch upstream-cn main
```

## 二、合并方式

两边历史没有共同祖先（本仓库是改写过的浅克隆，根提交 `83f49b1f` 的父对象不存在；
上游对应分支的 `fix/wiki-team-code-merged-roster` 只是同标题的另一次提交）。
所以用**显式三方合并**，把 `224aa2a6`（2026-10-15，本地存在且在上游历史里）当基线：

```
git merge-recursive 224aa2a6 -- HEAD upstream-cn/main
```

合并提交 `a03038f0` 带两个父（`900fdc43` + `75a3f099`），
**从这次起两边建立了真实祖先关系，下次直接 `git merge upstream-cn/main` 即可。**

合并前备份：标签 `pre-merge-20261103`、分支 `backup/main-before-upstream-sync`。
数据库在线备份：`.database/backups/pre-sync-20261103.db`。

## 三、拿到的更新

上游在本仓库分叉点之后共 24 个提交，其中 16 个是版本同步（1.4.271 → 1.4.351）。

**服务端代码（11 个文件，净增约 290 行，全部为新增能力）**

- `src/data/domains/finish-receipt.ts`：结算回执（写进已有的 `player_operation_receipts` 账本，不建新表）
- `src/lib/finish-response-cache.ts`：请求键归一化 + `buildFinishExecutionKey`
- `src/multi/settlement-snapshot.ts`：结算落定闩锁字段
- `src/lib/player-login.ts`：测试服共享密码开户通道（见「五」）
- `src/data/utils/player-data.ts`：`afterRepairs` 钩子
- 其它小改：`persistence/commands.ts`、`tcp/lobby.ts`、`client-admission.ts`、`character/bond.ts`

**资源数据（33 个文件）**

| 表 | 合并前 | 合并后 |
| --- | --- | --- |
| `character.json` 角色表 | 568 | **570** |
| `mana_board.json` | 589 | **612** |
| `item_ids.json` | 1476 | **1697** |
| `mission_char_awake_reward*.json` 觉醒角色 | 47 | 47（不变） |

**文档与 APK 补丁工程**：`apk-patches/**`（1500 个文件）、`docs/mod`（93 个文件）。
新增文件合计 17MB，最大单文件 4MB（补丁 zip），可正常推送到 GitHub。

## 四、刻意保留我方实现的文件

| 文件 | 原因 |
| --- | --- |
| `src/routes/cn/asset.ts` | 我方 `CDN_SPLIT` 多 Pages 分片方案；上游的 `LOCAL_PATCH_BASE_URL` 不适用 |
| `src/routes/api/exBoost.ts` | 我方 `ex-boost-pending` / `ex-boost-request` 回执链路 |
| `src/routes/api/expod.ts` | 我方 `gameplay-mutation-receipt` 幂等回执 + `Number.isSafeInteger` 校验 |
| `src/lib/mission/active-reconciliation.ts` | 我方 `contentMissionDecision` 运营开关 |
| `src/routes/api/character.ts`、`src/cn-server.ts` | 我方运营回执与 `CN_RUNTIME_IMPORT_ONLY` 调试模式 |
| `src/multi/party-snapshot.ts` | 我方三参数版本（支持指定队伍出战）；上游是两参数 |
| `assets/asset-patch/manifest.json` | 补丁清单与本机 CDN 分片绑定，保留我方 127 条 |
| `tests/cn-load-write-transactions.test.cjs` | 我方带 content-operations 的版本 |

数据表冲突的判定方法是「我方内容 ⊂ 上游内容」逐表比对，只有 3 个表存在我方独有条目，
按条补回：`character_text.json` 的 119998/119999、`equipment_awakening_material.json` 的
11 条 `rarityOverrides`、`asset-patch/manifest.json`（整表保留我方）。

## 五、需要知道的副作用

1. **单人 Boss 战记录分数默认打五折**：上游在 `single-finish-transaction.ts` 里加了
   `SINGLE_SCORE_SCALE`（默认 `0.5`），因为客户端单人 Boss 战时间倍率会 ×2。
   只影响最高分/分数奖励/排行，不影响结算画面显示。
   想关掉在 `.env` 里写 `SINGLE_SCORE_SCALE=1`。
2. **测试服共享密码开户通道**：`TEST_SERVER_SHARED_PASSWORD` + `TEST_SERVER_TEMPLATE_SAVE`
   两个变量同时设置才会生效，当前 `.env` 两者都没配 → 完全休眠。
3. **上游 3 个结算测试没有引入**：`finish-settlement-idempotency.test.cjs`、
   `single-finish-once.check.cjs`、`single-finish-replay-120s.check.cjs`。
   它们测的是「不调 `/start` 也能结算」的设计，我方现网是「必须先 `/start`」，
   引入会红。等哪天要支持 no-/start 结算再回上游取。

## 六、验证结果

| 项 | 结果 |
| --- | --- |
| `tsc --noEmit` | 0 错误 |
| `npm run build` | 通过 |
| `tests/admin-character-max.test.cjs` | 13/13 通过 |
| `tests/cn-load-write-transactions.test.cjs` | 8/8 通过 |
| `tests/character-overlimit.test.js` | 7/7 通过 |
| `tests/process-guards.test.cjs` | 6/6 通过 |
| 服务重启 | pid 16276，HTTP 8001 + TCP 8003 正常，DB v9 无需迁移 |
| 存档一致性 | 玩家拥有角色 354 个，角色表缺失 0；越权觉醒解锁/节点/进化 = 0/0/0 |
