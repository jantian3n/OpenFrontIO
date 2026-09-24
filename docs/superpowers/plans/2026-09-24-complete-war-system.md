# Complete War and Diplomacy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved war, peace, and puppet system across deterministic simulation, combat, AI, replay, and the in-game diplomacy UI.

**Architecture:** Add a deterministic war-diplomacy model to `src/core/game`, expose immutable war snapshots through `GameUpdates`, and process player decisions as normal turn intents. Existing clients run the same core simulation and the server continues ordering and relaying turns; this plan does not introduce a server-hosted simulation. Combat entry points ask the shared core model for permission and an active `WarId`.

**Tech Stack:** TypeScript 5.7, Zod intent schemas, deterministic core simulation, Vitest, Lit, Tailwind CSS 4, `translateText()` localization.

**Spec:** `docs/superpowers/specs/2026-09-24-war-system-design.md`

## Global Constraints

- Core code stays dependency-free, deterministic, and uses integer arithmetic for war scores and timers.
- Game-state changes happen from ordered turn intents or deterministic tick processing, not wall-clock callbacks.
- All clients reconstruct the same wars, terms, votes, and scores from the same intents.
- A regular war starts on the first effective hostile action; team and puppet members join automatically; formal allies only join a named war after accepting a call and ending any pact with its opposing side.
- An effective truce blocks new attacks; launched shells and nukes finish, while unfinished ground advances and landings retreat.
- Score components total 10,000 points: territory 5,000, military losses 3,000, key structures 2,000; reparations require 2,000 score advantage and puppetization 7,500.
- A peace deal needs every living human participant's acceptance; bot decisions are deterministic; an unaffordable reparations term invalidates the whole deal.
- Only the puppet relation remains: initial autonomy 40, tribute 20%, independence request at 80, peaceful independence at 100, with one subject tier.
- Do not rebalance global income, unit costs, or defensive structure values in this feature.
- Add English strings to `resources/lang/en.json` and Chinese strings to `resources/lang/zh-CN.json`; route all UI copy through `translateText()`.
- Use the existing game dependencies and Vitest setup; add no third-party packages.

## Review Focus

- A war must not partially form if an automatically joined team/puppet member has a truce or alliance with the opposing side; test the full group and verify no `WarId` was created.
- A player may participate in separate conflicts, but the same player cannot occupy both sides of one war; test both invariants.
- A proposal must be atomic when a signer is eliminated or the payer spends gold before the final signature; test no partial relation or gold changes.
- A truce cannot be bypassed by a queued land attack, transport landing, or new warship shot; test each path while allowing already launched shells and nukes to finish.
- A late join and replay must reconstruct the same active war snapshot and hash as continuous simulation; test from the same turn history.

## Architecture Ruling

The approved design described server authority, but `CLAUDE.md` and the running code show that the simulation executes on every client and the server only orders and relays turn intents. Preserve that architecture: the core simulation is the single rules authority replicated deterministically on each client. This keeps the accepted gameplay semantics and replay behavior without a network/server rewrite; it does not add server-side anti-cheat validation.

---

### Task 1: Add deterministic war state and snapshots

**Files:**
- Create: `src/core/game/WarDiplomacy.ts`
- Modify: `src/core/game/Game.ts`
- Modify: `src/core/game/GameImpl.ts`
- Modify: `src/core/game/GameUpdates.ts`
- Modify: `src/client/view/GameView.ts`
- Test: `tests/core/WarDiplomacy.test.ts`

**Interfaces:**
- `Game.warDiplomacy(): WarDiplomacy`
- `WarDiplomacy.canAttack(attacker: Player, target: Player): boolean`
- `WarDiplomacy.beginHostileAction(attacker: Player, target: Player): number | null`
- `WarDiplomacy.getWar(id: number): WarSnapshot | undefined`
- `WarDiplomacy.warsFor(player: Player): WarSnapshot[]`
- `WarDiplomacy.tick(): void` and `WarDiplomacy.hash(): number`
- `WarSnapshot` contains `id`, `createdAt`, `status`, two ordered sides, participants with join reason/alive state, two score breakdowns, optional proposal, truce expiry, and the latest 20 event summaries.
- `GameUpdateType.War` carries a complete `WarSnapshot`; `WarDiplomacy` emits it after every observable state change.

- [ ] **Step 1: Add failing core tests** for one new war on first hostile action, idempotent reuse when the same side already fights the target, team/puppet expansion, rejection across an existing truce/alliance, deterministic participant ordering, and stable hash ordering.
- [ ] **Step 2: Run the new test file and confirm each failure names the missing war behavior.**

  Run: `npx vitest tests/core/WarDiplomacy.test.ts --run`

- [ ] **Step 3: Implement `WarDiplomacy` and connect it to `GameImpl`.** Store side membership and event order by stable player IDs, emit complete snapshots through `GameUpdates`, call `tick()` once per simulation tick, and include the normalized active/truce state in `GameImpl.hash()`.
- [ ] **Step 4: Apply `GameUpdateType.War` snapshots to `GameView` and expose `wars()` / `war(id)` read methods.** The view stores the latest snapshot by numeric war ID and drops no active/truce record.
- [ ] **Step 5: Run the focused tests and the existing `GameRunner` / `GameView` tests.**

  Run: `npx vitest tests/core/WarDiplomacy.test.ts tests/core/GameRunner.test.ts tests/client/view/GameView.test.ts --run`

- [ ] **Step 6: Commit the core model and snapshot contract.**

### Task 2: Enforce war permission in every combat path and track score

**Files:**
- Modify: `src/core/game/PlayerImpl.ts`
- Modify: `src/core/game/GameImpl.ts`
- Modify: `src/core/game/WarDiplomacy.ts`
- Modify: `src/core/execution/AttackExecution.ts`
- Modify: `src/core/execution/TransportShipExecution.ts`
- Modify: `src/core/execution/WarshipExecution.ts`
- Modify: `src/core/execution/ShellExecution.ts`
- Modify: `src/core/execution/NukeExecution.ts`
- Modify: `src/core/execution/MIRVExecution.ts`
- Modify: `src/core/game/UnitImpl.ts`
- Test: `tests/WarDiplomacyCombat.test.ts`
- Test: `tests/Attack.test.ts`, `tests/Warship.test.ts`, `tests/core/executions/NukeExecution.test.ts`

**Interfaces:**
- `PlayerImpl.canAttackPlayer()` denies team/puppet/truce attacks, allows enemies already on opposing sides, and does not let a formal ally attack until both players are opposing participants in a war.
- Every successful hostile execution calls `beginHostileAction()` once, after its own route, immunity, resource, and target checks pass.
- `WarDiplomacy.recordTerritoryChange(warId, tile, oldOwner, newOwner)`, `recordTroopLoss(warId, attacker, defender, amount)`, and `recordStructureLoss(warId, attacker, defender, type, level)` update capped integer score components for the originating `WarId`.

- [ ] **Step 1: Add failing tests** for attack-created wars, same-team denial, accepted-war-allies being able to fight the opposite side, effective truce denial, net territory score with recapture, army-loss score caps, and one-time key-structure score.
- [ ] **Step 2: Run the focused combat tests and confirm failures are behavioral.**

  Run: `npx vitest tests/WarDiplomacyCombat.test.ts --run`

- [ ] **Step 3: Gate land attacks, boat launches/landings, warship shots, and nuke/MIRV launch with the common war permission.** Recheck a warship target before each shot. Abort/retreat unfinished land attacks and transports as soon as a deal enters truce; keep already launched shells and nuclear weapons moving.
- [ ] **Step 4: Record the launch `WarId` on shell/nuke execution state.** Continue their impact after peace without reopening the old conflict or changing its settled score; create a separate defensive war before applying collateral nuclear damage to a neutral player.
- [ ] **Step 5: Record capped integer score deltas at territory ownership changes, attack attrition, and destruction/downgrading of baseline key structures.** Capture only original participant territory and baseline assets; recaptures/restoration reverse net score; never credit post-war-created assets.
- [ ] **Step 6: Run the focused combat files plus existing attack, warship, and nuke tests.**

  Run: `npx vitest tests/WarDiplomacyCombat.test.ts tests/Attack.test.ts tests/Warship.test.ts tests/core/executions/NukeExecution.test.ts --run`

- [ ] **Step 7: Commit combat admission and scoring.**

### Task 3: Add calls to arms, peace proposals, and settlement intents

**Files:**
- Modify: `src/core/Schemas.ts`
- Modify: `src/core/execution/ExecutionManager.ts`
- Create: `src/core/execution/WarDiplomacyExecution.ts`
- Modify: `src/core/game/WarDiplomacy.ts`
- Modify: `src/core/game/Game.ts`
- Modify: `src/core/game/GameUpdates.ts`
- Test: `tests/WarDiplomacy.test.ts`

**Interfaces:**
- Add a Zod `WarDiplomacyIntentSchema` with four explicit actions: `callToArms(warId, recipient)`, `answerCall(warId, accepted)`, `proposePeace(warId, clause)`, and `answerPeace(warId, proposalId, accepted)`.
- `WarClause` is a discriminated union: `{kind: "whitePeace"}`, `{kind: "reparations", payerId, receiverId, amount}`, `{kind: "puppet", targetId, overlordId}`, or `{kind: "independence", subjectId}`. Intent `amount` is a nonnegative safe integer converted to core `Gold` (`bigint`) before comparison/payment.
- `WarDiplomacyExecution` validates the player, current war, expiry, score, subject relation, and balance inside the deterministic core before calling the model.
- The model uses tick deadlines: proposal 300 ticks, call-to-arms 300 ticks, rejection/expiry cooldown 300 ticks, and truce 600 ticks; expose these as named constants in `WarDiplomacy.ts`.

- [ ] **Step 1: Add failing tests** for accepted/rejected call-to-arms, blocking an invitee who still has an alliance/truce with the opposite side, no alliance-chain invitations, all-human signatures, bot auto-votes, white peace, affordable/unaffordable reparations, puppetization eligibility, proposal expiry/cooldown, truce expiry, and duplicate response idempotence.
- [ ] **Step 2: Run `tests/WarDiplomacy.test.ts` and verify each test fails for its intended missing rule.**
- [ ] **Step 3: Add the intent union to `Schemas.ts` and route it through `Executor.createExec()`.** Keep the four actions schema-distinct so missing IDs or malformed clauses fail Zod validation.
- [ ] **Step 4: Implement one pending proposal per war and one pending call per recipient/war.** All living human participants on both sides sign; any rejection ends the offer; bot decisions use only deterministic state and scores. On the last signature, revalidate and apply all terms atomically.
- [ ] **Step 5: Implement peace thresholds, `gold()` bounds, puppet relationship mutation, independence-only clause checks, and exact tick expiry/cooldowns.** Enter truce on success; end the old `WarId` when truce expires so the next attack creates a new one.
- [ ] **Step 6: Run focused schema, execution, and war tests.**

  Run: `npx vitest tests/WarDiplomacy.test.ts tests/core/GameRunner.test.ts --run`

- [ ] **Step 7: Commit diplomacy intents and settlements.**

### Task 4: Keep puppets and remove protectorate/protection mechanics

**Files:**
- Modify: `src/core/game/Game.ts`
- Modify: `src/core/game/PlayerImpl.ts`
- Modify: `src/core/execution/SubjectExecution.ts`
- Modify: `src/core/execution/nation/NationAllianceBehavior.ts`
- Modify: `src/core/execution/utils/AiAttackBehavior.ts`
- Modify: `src/core/GameRunner.ts`
- Modify: `src/client/view/PlayerView.ts`
- Modify: `src/client/render/types/Renderer.ts`
- Modify: `src/core/game/GameUpdates.ts`
- Modify: `resources/lang/en.json`
- Modify: `resources/lang/zh-CN.json`
- Test: `tests/SubjectRelations.test.ts`, `tests/NationAllianceBehavior.test.ts`, `tests/client/view/PlayerView.test.ts`

**Interfaces:**
- `SubjectRelationKind` contains only `Puppet`; `SubjectFormationType` contains only `subjugation`; protection request/call types and methods disappear from the active API. Legacy `request_protection`, `intervene`, and `decline_protection_call` intent literals remain decodable for old turn histories; replay maps `request_protection` and legacy acceptance to a puppet and ignores obsolete protection-call responses.
- Puppet creation retains autonomy `40` and tribute `20`; accepted/100-autonomy independence ends the subject relation; rejected/expired independence request enables a separate independence war.
- A protectorate-shaped legacy record, if encountered in replay input, normalizes to `Puppet` before any side or UI decision.

- [ ] **Step 1: Add failing tests** proving a new protection request/call cannot be created or answered, subjugation still creates only a puppet, 80/100 autonomy paths remain valid, and Nation AI never seeks protection.
- [ ] **Step 2: Run the focused subject and AI tests and verify the missing protection removal is the failure.**
- [ ] **Step 3: Remove protectorate and protection state/methods, protection calls/events, Nation decisions, and outgoing/incoming request rendering.** Keep legacy intent literals decode-only; map old protection-formation intents to puppet formation and ignore old call replies. Keep current demand-subjugation and independence behavior, routing peace puppetization through the same puppet relation creation method.
- [ ] **Step 4: Normalize legacy relation kinds on replay/load boundaries and add English/Chinese copy for only the surviving puppet flow.**
- [ ] **Step 5: Run subject, Nation diplomacy, and PlayerView tests.**

  Run: `npx vitest tests/SubjectRelations.test.ts tests/NationAllianceBehavior.test.ts tests/client/view/PlayerView.test.ts --run`

- [ ] **Step 6: Commit the puppet-only diplomacy cleanup.**

### Task 5: Build the diplomacy panel and visible war feedback

**Files:**
- Create: `src/client/hud/layers/WarDiplomacyPanel.ts`
- Modify: `src/client/hud/GameRenderer.ts`
- Modify: `src/client/hud/layers/PlayerPanel.ts`
- Modify: `src/client/hud/layers/ActionableEvents.ts`
- Modify: `src/client/hud/layers/EventsDisplay.ts`
- Modify: `src/client/Transport.ts`
- Modify: `index.html`
- Modify: `resources/lang/en.json`
- Modify: `resources/lang/zh-CN.json`
- Test: `tests/client/WarDiplomacyPanel.test.ts`

**Interfaces:**
- `WarDiplomacyPanel` receives `GameView` and `EventBus`, shows active wars, sides/reasons, score breakdown, recent events, truce timer, CTA invitations, proposals/signatures, and economic context.
- The panel dispatches typed `WarDiplomacyIntentEvent`s through `Transport` and never mutates `GameView` directly.
- PlayerPanel shows active-war/truce state and reuses the current attack-disabled reason; incoming-threat summaries expose only attacks visible under current visibility rules.

- [ ] **Step 1: Add failing DOM tests** for empty/active war lists, score breakdown, CTA accept/reject, proposal form constraints, pending signers, truce state, and narrow viewport layout.
- [ ] **Step 2: Run the panel test file and verify expected UI is missing.**
- [ ] **Step 3: Implement the Lit panel and mount it through `GameRenderer`/`index.html`.** Use existing semantic color utilities, button styles, focus states, text hierarchy, and responsive modal patterns; no emoji icons or hard-coded English strings.
- [ ] **Step 4: Wire typed intent events to Transport; make submit controls disable during duplicate pending actions and show translated validation errors beside the affected clause.**
- [ ] **Step 5: Remove protection actions from PlayerPanel/ActionableEvents/EventsDisplay; add bilingual war, score, proposal, truce, error, and visible-threat text.**
- [ ] **Step 6: Run the panel, player-panel, ActionableEvents, and GameView tests.**

  Run: `npx vitest tests/client/WarDiplomacyPanel.test.ts tests/client/graphics/layers/PlayerPanelActions.test.ts tests/client/graphics/layers/ActionableEventsAlliance.test.ts tests/client/view/GameView.test.ts --run`

- [ ] **Step 7: Commit the diplomacy UI and translations.**

### Task 6: Complete AI integration and verify replay consistency

**Files:**
- Modify: `src/core/execution/nation/NationAllianceBehavior.ts`
- Modify: `src/core/execution/utils/AiAttackBehavior.ts`
- Modify: `src/core/game/WarDiplomacy.ts`
- Modify: `src/core/GameRunner.ts`
- Test: `tests/NationAllianceBehavior.test.ts`
- Test: `tests/core/GameRunner.test.ts`
- Test: `tests/GameUpdateUtils.test.ts`

**Interfaces:**
- AI CTA/peace decisions are pure deterministic functions of the player's status, current scores, and clause data; no connection state or wall clock.
- Every observable state transition emits a complete stable-order snapshot, and hashing includes active/truce membership, score counters, pending offer IDs, deadlines, and next event sequence.

- [ ] **Step 1: Add failing tests** for deterministic bot votes across equal states, replaying the same turns to equal hashes, reconstructing an active war from history, and eliminating a player during a pending offer without partial settlement.
- [ ] **Step 2: Run the focused AI/replay tests and verify failures are in war state or turn reconstruction.**
- [ ] **Step 3: Refactor AI aggression/targeting to use the new call-to-arms and battle-permission rules; remove protection seeking and automatic protection decisions.**
- [ ] **Step 4: Ensure `GameImpl.hash()` and war snapshots sort players/events/records by stable IDs before hashing or emitting.**
- [ ] **Step 5: Run the focused tests, then full verification: `npm test`, `npm run lint`, and `npm run build-prod`.**
- [ ] **Step 6: Review the final diff against every spec section, fix critical/important gaps, and commit the integration.**
