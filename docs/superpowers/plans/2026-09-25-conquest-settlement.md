# 征服结算界面（Conquest Settlement）实施计划

**目标**：把"征服了 xx 并获得 xx 黄金"的即时结算，改为征服者视角的**结算界面**：目标濒临灭国时挂起征服，弹出处置选择（全部吞并 / 傀儡 / 赔款释放 / 无条件释放），单机局自动真暂停，多人局延迟结算（游戏照跑、被征服国冻结、超时自动吞并）。

**已确认决策**：
- 暂停：单机/本地局触发结算时真暂停；多人局不暂停，pending 挂起 + 超时自动吞并。
- 选项：全部吞并、傀儡（附庸）、赔款释放（金额可调）、无条件释放，四选一。
- 胜者单方面决定，被征服方无需确认；bot 征服者不走结算（直接按现有逻辑灭国）。

**架构原则**：所有端（多人各客户端 worker / 单机 LocalServer）跑确定性模拟，tick 内不能等人输入。因此结算选择走**普通 intent**，在后续 tick 由 Execution 结算（与 SubjectRequest/AllianceRequest 同款请求-回复模式）。`GameUpdates.ts:117-119` 预留的 `ProtectionCall/ProtectionCallReply` 枚举位正是这类机制的槽位——新增 update 类型**追加在枚举末尾**，不动预留位。

## 关键复用点

- 傀儡：`PlayerImpl.formPuppetFromPeace(overlord)`（PlayerImpl.ts:1149）+ `applySubjectRelation`（autonomy 40 / tribute 20%）——现成。
- 赔款/停战：参考 `WarDiplomacy.settleProposal`（WarDiplomacy.ts:1345-1406）的 reparations 扣款与 `war.status = "truce"; truceEndsAt = now + 600` 的写法。
- 灭国执行：`GameImpl.conquerPlayer`（GameImpl.ts:1413-1493）原样保留，作为"全部吞并"的结算动作。
- 触发点共两处：`AttackExecution.handleDeadDefender`（AttackExecution.ts:502-536，目标 <100 格）和 `PlayerExecution.removeCluster`（PlayerExecution.ts:461-504，整块被围）。
- 单机暂停：`toggle_pause` intent → `PauseExecution`（PauseExecution.ts:18-23，`isLobbyCreator() || Singleplayer` 可通过）；`LocalServer` 有 `paused` 标志（LocalServer.ts:184-204）。

## Phase 1：核心挂起与结算逻辑（src/core）

1. **新 update 类型**（`src/core/game/GameUpdates.ts`，追加枚举末尾 + zod/schema 如该文件要求）：
   - `ConquestPending { conquerorId, conqueredId, expiresAt }`——所有客户端收到，仅征服者弹窗。
   - `ConquestSettled { conquerorId, conqueredId, decision, gold }`——驱动事件日志/音效。
2. **新 intent**（`src/core/Schemas.ts` 的 intent schema）：`conquest_settle { targetId, decision: "annex"|"puppet"|"reparations"|"release", amount?: number }`（发送者即征服者，不加 conquerorId）。
3. **`GameImpl` 新增 pending 状态与方法**（`src/core/game/GameImpl.ts`，接口同步到 `src/core/game/Game.ts`）：
   - `pendingConquests: Map<conqueredId, { conquerorId, expiresAt }>`，纳入快照序列化（若有快照机制需同步）。
   - `startConquestSettle(conqueror, conquered)`：bot 征服者 → 直接 `conquerPlayer`（保持现状）；人类 → 写入 pending、发 `ConquestPending` update。同一目标已有 pending 则忽略。
   - `executeConquestSettle(conqueror, target, decision, amount)`：校验 pending 存在且未过期 → 按 decision 结算：
     - `annex`：调现有 `conquerPlayer(conqueror, target)`（黄金/领土/灭国全套不变）。
     - `puppet`：`target.formPuppetFromPeace(conqueror)`；征服者与目标间战争转 truce（参考 settleProposal 写法）。
     - `reparations`：`amount = clamp(amount, 0, target.gold())`，`target.removeGold / conqueror.addGold`；战争转 truce。
     - `release`：仅战争转 truce。
     - 统一删除 pending、发 `ConquestSettled` update 和对应 `DisplayEvent`（新 i18n key，见 Phase 3）。
   - 每 tick 检查超时：到期自动按 `annex` 结算（当前行为等价）。
4. **`ConquestSettlementExecution`**（新文件 `src/core/execution/ConquestSettlementExecution.ts`）：解析 intent、校验发送者是记录的征服者且目标仍 alive、调用 `executeConquestSettle`。
5. **接线**：
   - `ExecutionManager.ts`：注册 `conquest_settle` → 新 Execution。
   - `AttackExecution.handleDeadDefender`：`mg.conquerPlayer(...)` 改为 `mg.startConquestSettle(...)`；攻击循环内目标处于 pending 时停止继续占格（仿现有 truce/结盟 retreat 分支，AttackExecution.ts:315-325）。
   - `PlayerExecution.removeCluster`：同样改走 `startConquestSettle`。
   - `src/server/IntentAuthorization.ts`：为 `conquest_settle` 加基本授权（发送者 alive、in game），具体权属校验放模拟层。
6. **战争转停战辅助**：`WarDiplomacy.ts` 视需要加 `conquestTruce(a, b)`（找到双方同处的 active war → 复用 settleProposal 的 truce 逻辑；找不到则不动）。

## Phase 2：客户端结算界面（src/client）

7. **新 Lit 弹窗** `src/client/hud/layers/ConquestSettlementModal.ts`（结构参考 `WarDiplomacyPanel.ts` 的提案卡片与 `SendResourceModal.ts` 的弹窗模式）：
   - 显示：目标国名/旗帜、剩余领土、国库黄金、超时倒计时条（多人模式明显可见）。
   - 四个选项卡片，各带后果说明（复用 TooltipKey 模式）：全部吞并（+X 黄金、灭国）/ 傀儡（20% 黄金上缴、目标保留领土）/ 赔款释放（金额输入，默认=目标国库，clamp）/ 无条件释放（仅停战）。
   - 确认按钮 → emit `SendConquestSettleIntentEvent`（Transport.ts 新增）；emit 后关闭，等待 `ConquestSettled` 事件日志反馈。
8. **HUD 接线**：`GameRenderer.ts` 挂载弹窗；订阅 `ConquestPending`（`conquerorId === myID` 才打开）与 `ConquestSettled`（关闭弹窗）。
9. **单机自动暂停**：弹窗打开且 `game.isSinglePlayer()`（或等效判断）时 emit 现有 pause intent（SP 下权限通过）；弹窗关闭/超时结算后 emit 恢复。多人局不做任何暂停操作。
10. **兜底**：`myPlayer.isAlive() === false`、游戏结束、或收到 `ConquestSettled`/`ConquestPending` 过期时强制关闭弹窗，防残留。

## Phase 3：文案与测试

11. **i18n**（`resources/lang/en.json` + `zh-CN.json`）：弹窗标题/四选项/后果说明/倒计时提示，及三条新事件文案：`settled_conquest_annex`（≈征服并吞并）、`settled_conquest_puppet`（≈将 X 变为傀儡）、`settled_conquest_reparations`（≈接受 X 赔款 N 黄金）、`settled_conquest_release`（≈释放 X）。
12. **核心测试**（`tests/core/execution/`，vitest，仿现有 WarDiplomacy 执行测试）：
    - 人类征服者 → pending 创建 + update；bot 征服者 → 立即灭国（无 pending）。
    - 四种 decision 各自效果：吞并=现有 conquerPlayer 行为（黄金转移、灭国、战争结束）；傀儡=formPuppetFromPeace + truce；赔款=黄金转移 + truce + 金额 clamp；释放=仅 truce。
    - 超时自动吞并；pending 期间目标不再丢领土（攻击路径）。
    - 非征服者发送 intent 被拒绝；重复结算被拒。
13. **客户端测试**（`tests/client/ConquestSettlementModal.test.ts`，仿 `DiplomacyMenu.test.ts`）：收到 pending 弹窗、四选项渲染与 disabled 说明、金额 clamp、emit 的 intent 参数正确、收到 settled 关闭、SP 暂停 intent 发出。
14. **验证**：`npx tsc --noEmit`、`npm run lint`、受影响 vitest 全绿；`npm run dev` 起本地局实测（人类玩家打 bot 到 <100 格 → 弹窗 → 四种选项各试一次）。

## 边界与回归关注点

- pending 期间征服者自己被灭/断线：超时自动吞并兜底（`conquerPlayer` 的领土分配本就支持向邻国强分）。
- 多个攻击者同时打同一目标：先触发者获得处置权；pending 期间其他人停手（第 3/5 步的 immunity）。
- 被征服者是真人：同样弹窗给（仅）征服者，真人被征服者照常沦为待处置对象；pending 期间不被 `removeOnDeath`（领土未归零自然不会）。
- 回放：`conquest_settle` 是普通 intent，随 turn 进入历史，回放确定性天然成立（这正是选 intent 模式而非真暂停的原因）。
- 不改变现有 `conquerPlayer` 内部逻辑——吞并路径行为与线上完全一致。

## 交付

- 新 commit 于 `main`（沿用仓库提交风格：`feat: ...`），推送 `origin/main` 前经用户确认。
- 计划文档留存 `docs/superpowers/plans/2026-09-25-conquest-settlement.md`（仓库现有约定）。
