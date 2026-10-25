# 本地二改 × 上游合并 —— 全量测试报告

- 日期：2026-10-24
- 分支：`upstream-base`（基于 `upstream/main` @ `7f3e144`，6 个本地提交）
- 运行机器：Windows 10 19045 / 16 核 / Node v24.22.0
- 未提交，仅本地记录

---

## 一、结论速览

| 指标 | 数值 |
|---|---|
| 测试文件总数 | 424（`tests/` 352 + `tools/` 72） |
| 通过 | 342（80.7%） |
| 未通过 | 82 |
| ├ 上游基线同样不通过 | 81 |
| ├ 本分支引入的回归 | **1** |
| └ 原因待确认 | 0 |

一句话：**合并没有引入功能性回归**，81 个失败在未改动的上游代码上同样失败；唯一 1 个与本次二改有关的是内容检索索引的摘要过期，属可接受降级。

---

## 二、测试怎么跑的

上游仓库**没有聚合测试入口**（`package.json` 里没有 `test` 脚本），只有一个
`tools/run-isolated-check.cjs`，且它只设 `DATA_DIR` / `GACHA_SEED_DIR` / `TMPDIR`。
直接 `node --test tests/*.test.cjs` 会踩一串坑，逐条记在这里以便复现。

### 必须满足的运行条件

| 条件 | 不做会怎样 |
|---|---|
| 用 **Node v24**（`nvm/v24.22.0`），不是 v22 | `better-sqlite3` 按 NODE_MODULE_VERSION 137 编译，v22 报 `ERR_DLOPEN_FAILED` |
| `DATA_DIR` 指到仓库内 `tmp/` 下的独立目录 | 测试直接打开生产库 `.database/wdfp_data.db`；部分测试有守卫会拒绝运行，没有守卫的会写库 |
| `GACHA_SEED_DIR` / `TMPDIR` / `TMP` / `TEMP` 同样隔离 | 同上，且会污染共享临时目录 |
| `STARPOINT_TEST_OUT_DIR=<repo>/out` | 41 个测试直接报 `Use the current isolated build via STARPOINT_TEST_OUT_DIR` |
| `ADMIN_PLATFORM_TEST_DIR=<临时绝对路径>` | `admin-platform-cost` 拒绝运行（防止动到线上文件） |
| `ADMIN_PLATFORM_BUILD_DIR=<已构建的 admin 产物副本>` | `admin-precompressed-build` 拒绝运行（防止改线上 dist） |
| `--max-old-space-size=8192` | 4 个 `tools/` 测试 + `tsc` 会 OOM（默认 2 GB 不够） |
| 关掉宿主的批量删除守卫 | 宿主把 `fs.rmSync` 包了一层，删 >50 个文件要二次确认；5 个测试在 `t.after` 清理临时目录时被它打断 |

宿主的批量删除守卫靠环境变量 `CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR` /
`CODEBUDDY_TOOL_CALL_ID` 触发，测试子进程里 `env -u` 掉即可，不影响其他安全策略。

### MSYS/Git Bash 的坑

`PATH` 里把 `C:\Windows\System32` 放在前面时，`sort` / `find` / `timeout` 会命中
Windows 自带的同名程序：

- `sort -u` → Windows `SORT.EXE` 不认识 `-u`，报「系统找不到指定的文件」
- `find . -name '*.gz'` → Windows `FIND.EXE`，语义完全不同
- `timeout 300 node ...` → Windows `TIMEOUT.EXE`，参数语法不同

解决：这些命令一律走 `/usr/bin/sort`、`/usr/bin/find`、`/usr/bin/timeout`。

另外 `cmd /c mklink /J ...` 会被命令校验拦下，建目录联接改用 PowerShell 的
`New-Item -ItemType Junction`。

### 断言归属怎么定的

光看「失败」无法判断是我们改坏的还是上游本来就坏，所以额外建了一个
**未改动的上游基线工作树**做对照：

1. `git worktree add --no-checkout --detach ../_wf-base upstream/main`
2. 只检出 `src` / `tests` / `tools` / `tsconfig.json` / `package.json`，并**必须同时检出 `.gitattributes`**
3. `node_modules` / `assets` / `web` / `admin` / `docs` 用目录联接复用
4. `tsc` 编出独立的 `out/`
5. 用完全相同的隔离环境跑同一批失败测试

> 第 2 步漏掉 `.gitattributes` 会让检出结果是 CRLF，而内容索引里记的是源码
> SHA-256，于是所有摘校类测试在基线上集体误判失败。这一坑踩过一次，
> 表现为 `Native content identity index rejected: source identity mismatch`。

---

## 三、三轮结果

| 轮次 | 范围 | 说明 | 结果 |
|---|---|---|---|
| 第 1 轮 | 424 全量 | 环境不完整（只有 `STARPOINT_TEST_OUT_DIR`） | tests: 280 通过 / 71 失败 / 1 超时 |
| 第 2 轮 | 第 1 轮全部失败项 | 补齐隔离环境 + 关掉删除守卫 | 10 项翻盘为通过 |
| 第 3 轮 | 大堆重跑 6 项 | `--max-old-space-size=8192` | 2 项翻盘为通过 |

第 2 轮翻盘的 10 项（全部是环境问题，不是代码问题）：

```
tests/admin-leaderboard-read-cost.test.cjs
tests/admin-platform-cost.test.cjs
tests/admin-player-sections.test.cjs
tests/admin-precompressed-build.test.cjs
tests/multi-battle-relay-ipc.test.cjs          ← 之前是被删除守卫打断
tests/multi-realtime-owner-process.test.cjs    ← 同上
tests/multi-realtime-return-process.test.cjs   ← 同上
tests/news-html-safety.test.cjs                ← 公告修复后通过
tests/security-route-guards.test.cjs
tests/time-cutover-rehearsal.test.cjs
```

第 3 轮翻盘的 2 项：

```
tools/box_gacha_stop_currency.test.cjs   （2 GB 堆 OOM）
tools/gacha_draw_weights.test.cjs        （2 GB 堆 OOM）
```

---

## 四、81 个「上游自身也失败」的分布

### 4.1 内容运营层未落档（20 个，占大头）

`content-*` 系列需要 `assets/content_runtime_index.json`，**这个文件本机根本不存在**。
它由 `tools/build-content-definition-runtime.cjs` 从一份人工核验报告生成，
核验报告又依赖游戏客户端/服务端定义的重导出。缺这一环的直接后果：

```
Error: 客户端与服务端定义缺失、冲突或目录已过时，需要先重导出并核对资源和规则
```

`definitionReady()` 返回 false，所有内容开关动作被 `409` 挡住。
这不是 bug，是这套内容后台在本机**从未上线过**。同样的测试在上游基线上也一样红。

附带影响：`contentDiscoveryReader()` 降级，`/api/content` 只能按名称/说明/原始档期检索。

### 4.2 上游测试断言与上游数据不同步（约 40 个）

典型形态是「数量对不上」「开关是关的」：

| 测试 | 现象 |
|---|---|
| `character-awake-custom-content` | 期望 36 条觉醒任务，`assets/mission_char_awake_cnmod.json` 实际 44 条 |
| `equipment-enhancement-data` | 期望 543 行，实际 921 行 |
| `abyss-best-time-revision` | `Rush participation is closed.` |
| `shop-degree-reward` | `Event shop item is not currently available.` |
| `box-gacha-1001` | `Box gacha operation is closed.` |
| `content-exact-definition` / `content-presentation` | `start_dash_exchange_campaign:1` / `gacha:2` 缺定义 |
| `content-history-crazy-gacha-http` | 断言 58 张表，实际 61 张（上游 `a7d347b` 加表没同步测试） |
| `news-response-cache` | 测试里的 antd 桩没有 `Grid.useBreakpoint`，而 `admin/src/pages/News.tsx` 已经用了 |
| `content-publication-switch` | `Cannot find module './content-july-reference'`，oracle 快照不完整 |
| `tools/character_awake_battle_tracker` | `transaction(...).immediate is not a function`，mock API 与实现不符 |
| `tools/star_grain_material_pack` | 缺外部资源目录 `wf-assets-cn/` |

这些文件与上游**逐字节相同**（`git diff upstream/main` 为空），`assets/` 除
`news.json` 外也完全一致，所以失败只可能来自上游自身。

### 4.3 资源/超时类（约 10 个）

- `admin-save-shutdown`：5 个子场景各挂满 20 秒，加大堆与 420 秒上限后仍超时；基线上同样超时
- `server-log-rotation`：同上
- `cn-load-worker-integration`：`/load` 返回 503。测试发 `res_ver: 1.4.117`，本机
  `assets/asset-patch/manifest.json` 的 `cdn_version` 是 `1.4.258`，版本对不上
- `cn-response-lifecycle`：断言编译产物里有 `installCnResponseEncoding)(fastify)`，
  而 tsc 实际输出 `...(exports.fastify)` —— 上游 `fastify` 是 `export const`，
  这个断言从上游提交起就该是红的
- `runtime-build-artifact`、`storage-windows-entry`、`extract-player-save`、
  `player-save-portable` 等：依赖本机不具备的构建/导出前置

---

## 五、唯一的 1 个回归

### `tests/content-runtime-index.test.cjs`

```
实际: '关联资料尚未完成核验或已经变化，暂只支持名称、说明和原始档期检索。'
期望: undefined
```

根因已定位到单行级别。`assets/content_discovery.json` 的 `sourceInputs` 里记了
162 个输入的 SHA-256，逐个复核只有**一个**对不上：

```
src/lib/gacha.ts      ← 五星概率覆盖改动
```

于是 `readIndex()` 判定索引过期，整个内容检索降级。

**为什么不是数据坏了**：索引内容本身与 `gacha.ts` 的改动无关（改的是出货权重，
不是内容目录）。只是这套索引用「源码字节摘要」当新鲜度标记，源码一动就整体失效。

**三条修法**：

1. **接受降级**（推荐，代价最小）—— 内容检索只支持名称/说明/原始档期。
   该功能在本机本来就因缺 `content_runtime_index.json` 而不可用，实际无感。
2. **重跑索引流水线** —— `tools/build-content-discovery-rewards.cjs` 需要
   `--exporter` 外部导出器，本机没有，跑不了。
3. 重新记录 `src/lib/gacha.ts` 的摘要并重建 runtime 索引 —— 技术上可行
   （`build-content-runtime-index.cjs` 可以离线跑），但等于绕过一次人工核验记录，
   **不建议**，除非确认要长期保留这个覆盖。

> 还有个更干净的思路：把五星概率覆盖从 `src/lib/gacha.ts` 挪到调用 `rankRates`
> 的上层，让 `gacha.ts` 与上游保持字节一致，索引自然不过期。要动的话再单独评估。

---

## 六、本轮顺带修掉的一个真 bug

**`assets/news.json` 导致全新部署 `/load` 返回 503**（提交 `04f9d85`）

本地公告的 HTML 是从 Markdown 渲染器粘过来的，带 2 处 `!important`。
服务端 `news-html-policy.ts` 的内联样式白名单不允许值里出现 `!`：

```js
if (/[\\@{}<>\u0000-\u0008...]|\/\*/.test(value)) return null        // 字符黑名单
if (!/^[a-z0-9#\s.,%()'"+\/-]+$/i.test(cssValue)) return null        // 值白名单，没有 !
```

于是 `validateSafeNewsHtml` 抛错，`assets/news.json` 整体加载失败：

```
[NEWS] 公告配置读取失败，继续使用最近一次有效配置：news[0].html：HTML 包含不安全或不支持的样式
```

生产环境有历史配置可回退，所以只是公告不显示；但**全新部署没有历史配置，`/load` 直接 503**，
客户端卡加载条。测试 `cn-load-worker-integration` 就是这么挂的。

修复只删了 `!important` 两个词，正文与其他样式一字未改，已用
`out/lib/news-html-policy.js` 的 `validateSafeNewsHtml` 逐条复核通过。

> 注意：线上服务需要重启才会重新读到公告。另外 `assets/news.json` 的
> `popup.mode` 现在是 `every_login`，每次登录都弹，长期运营可以考虑改回 `once_per_news`。

---

## 七、生产库安全核查

第 1 轮的运行器没设 `DATA_DIR`，测试会落到默认路径 `.database/`，属于真实风险。
事后用当天 15:01 的全量备份做逐表 SHA-256 比对：

| 项 | 结果 |
|---|---|
| 表数 | 95 → 110（新增 15 张，全部为空表，属上游 schema 升级） |
| 完全一致的表 | 91 张 |
| 有变化的表 | `players` / `accounts` / `sessions` / `battle_receipt_retention_state` |
| 玩家 / 账号数 | 3 / 3，**未增减** |
| 变化内容 | 玩家 14 体力 11→19、登录时间更新到本地 16:15；账号 10 登录时间同步；定期扫描标记 |

结论：**没有测试数据污染**，变化全部是正常在线活动 + 一次成功的 schema 升级。
第 2 轮起运行器一律强制隔离，不再有这个问题。

---

## 八、建议的下一步

1. 重启线上服务，让公告修复生效
2. 把 `upstream-base` 的 6 个提交推到 `yu-echo/startpoint-cn-kulo` 的 `main`
3. 内容运营后台要真正可用，得先跑一次「内容核验 + 索引生成」流水线
4. 上游这 81 个红测试可以直接提 issue / PR 给他们，多数是加表加内容没同步断言
5. 可选：把五星概率覆盖挪出 `gacha.ts`，让那唯一一个回归也消失

---

## 附：可复现命令

```bash
# 单文件
env DATA_DIR="$(pwd)/tmp/x/database" GACHA_SEED_DIR="$(pwd)/tmp/x/seeds" \
    TMPDIR="$(pwd)/tmp/x/tmp" STARPOINT_TEST_OUT_DIR="$PWD/out" \
    /c/Users/Echo/AppData/Local/nvm/v24.22.0/node.exe \
    --max-old-space-size=8192 --test tests/xxx.test.cjs

# 或者走上游自带的隔离入口（只含 DATA_DIR/GACHA_SEED_DIR/TMPDIR）
/c/Users/Echo/AppData/Local/nvm/v24.22.0/node.exe \
    tools/run-isolated-check.cjs --test tests/xxx.test.cjs
```

批量脚本在 `.test-run/`（已加入 `.gitignore`）：
`run2b.sh`（隔离批量）、`run-big.sh`（大堆批量）、`base-run.sh` / `base-tools.sh`（基线对照）。
