# War Diplomacy and Text Context Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the war diplomacy edge cases from the review and replace the radial right-click menu with a text-first menu that keeps all current `main` actions.

**Architecture:** Keep war membership and diplomacy authoritative in `WarDiplomacy`; revalidate hostility at combat and landing boundaries; let `PlayerImpl` initiate special independence wars after a rejected eligible request. Extend the existing war panel from client-visible unit and attack snapshots. Replace only the right-click renderer and its wiring, reusing current menu action callbacks and server-provided `PlayerActions`.

**Tech Stack:** TypeScript, Vitest, Lit, existing GameView/UnitView snapshots, existing event bus and intent flow.

**Spec:** `docs/superpowers/specs/2026-09-25-war-diplomacy-and-context-menu-design.md`

## Global Constraints

- "Keep `WarDiplomacy` as the authoritative owner of war membership, status, proposals, and scoring."
- "Combat executions ask it to validate hostility before creating war state or making irreversible changes."
- "Coalition membership remains deterministic."
- "At 80 autonomy, an overlord's rejection of an independence request starts a special independence war between the subject and the overlord's side without silently releasing the subject first."
- "At 100 autonomy, the existing peaceful declaration remains available."
- "Keep existing `WarSnapshot` fields and peace-clause transport shape compatible; use the existing `independence` participant join reason to identify the special war and add deterministic events for automatic ending."
- "Revalidate rules at the moment an execution commits or lands, since diplomacy and tile ownership can change while an execution is queued or moving."
- "Build the threat summary from data already delivered to the current client."
- "Do not reveal hidden units or new server state through the panel."
- "Preserve deterministic event order and state hashing."
- "Preserve current radial actions and callback semantics when replacing the renderer."
- "New ally-support calls, ally resource requests, subject requisitions, and the separate postwar settlement implementation in the other worktree are excluded."

## Preflight

Before Task 1, run the focused existing regression suites and the full `npm test` once in the clean worktree. Record any baseline failures in the task ledger so final failures can be separated from regressions.

## Review Focus

- An army execution with no legal target border must neither leave a war behind nor consume troops. (Task 1: `does not start a war or consume troops when it has no hostile border`.)
- A transport whose target tile changes owner or becomes protected while en route must not capture that tile. (Task 1: `does not capture a destination that became friendly during transit`.)
- A call-to-arms recipient with a teammate or subject already on the opposing side must not split a protected coalition or duplicate a participant. (Task 2: `rejects a coalition that conflicts with the opposing side`.)
- A dead signer must not block surviving signatures, but eliminating an entire side must end the war and invalidate its pending proposal. (Task 3: `removes a dead signer and settles on surviving approvals`; `ends when either side has no living participants`.)
- A surviving signer can answer even if another signer was just eliminated and diplomacy has not ticked yet. (Task 3: `a live signer can answer before the next diplomacy tick prunes the dead signer`.)
- Threat rows must omit inactive, retreating, and non-visible units while preserving transport, warship, and nuclear warnings. (Task 5: `summarizes active visible threats by class`.)

---

### Task 1: Validate land attacks and transport landings

**Files:**

- Modify: `src/core/execution/AttackExecution.ts`
- Modify: `src/core/execution/TransportShipExecution.ts`
- Test: `tests/WarDiplomacyCombat.test.ts`
- Create: `tests/core/executions/TransportShipExecutionWarDiplomacy.test.ts`

**Interfaces:**

- Consumes: `WarDiplomacy.canAttack(attacker, target)`, `beginHostileAction(attacker, target)`, `isTruce(warId)`, and existing `Player` ownership, troop, and retreat APIs.
- Produces: no new public API; attack and landing executions must leave war state unchanged when validation fails.

- [x] **Step 1: Add the land attack regression** in `tests/WarDiplomacyCombat.test.ts`.

```ts
test("does not start a war or consume troops when it has no hostile border", async () => {
  const game = await setup("plains", {}, [
    new PlayerInfo("attacker", PlayerType.Human, null, "attacker"),
    new PlayerInfo("defender", PlayerType.Human, null, "defender"),
  ]);
  const attacker = game.player("attacker");
  const defender = game.player("defender");
  attacker.conquer(game.ref(0, 0));
  defender.conquer(game.ref(40, 40));
  const troopsBefore = attacker.troops();
  defender.createAllianceRequest(attacker);

  game.addExecution(
    new AttackExecution(10_000, attacker, defender.id(), game.ref(0, 0)),
  );
  game.executeNextTick();

  expect(game.warDiplomacy().warsFor(attacker)).toEqual([]);
  expect(attacker.troops()).toBe(troopsBefore);
  expect(attacker.incomingAllianceRequests()).toHaveLength(1);
});
```

- [x] **Step 2: Run the new land regression and observe the current failure.**

Run: `npx vitest run tests/WarDiplomacyCombat.test.ts -t "no hostile border"`

Expected: FAIL because the current execution creates a war before discovering it has no target border.

- [x] **Step 3: Add transport transit regressions** in `tests/core/executions/TransportShipExecutionWarDiplomacy.test.ts`, using the spawned coastal-player fixture from `tests/Attack.test.ts`. After `init`, transfer the selected landing tile to an ally and assert the transport does not capture it. In a second case, accept white peace in transit and assert the boat retreats and the destination remains defended.

```ts
expect(game.owner(destination)).toBe(defender);
expect(game.warDiplomacy().getWar(warId)?.sides[0].participants).toContainEqual(
  expect.objectContaining({ playerID: attacker.id() }),
);
```

- [x] **Step 4: Run both focused regressions and observe the landing failure.**

Run: `npx vitest run tests/WarDiplomacyCombat.test.ts tests/core/executions/TransportShipExecutionWarDiplomacy.test.ts`

Expected: the no-border land regression and changed-owner landing regression fail against the current implementation. The in-transit truce regression already passes because the execution begins retreat when the truce starts; retain it to protect that existing behavior.

- [x] **Step 5: Delay war creation until an attack has a legal target border.** Build and populate the attack border first; if it is empty, refund exactly the troops removed and finish without registering hostility, rejecting alliance requests, or adding war state. Once a target tile exists, call `beginHostileAction` and then apply the existing hostile-action side effects.

```ts
this.attack = this._owner.createAttack(
  this.target,
  this.startTroops,
  this.sourceTile,
  new Set<TileRef>(),
);
if (this.sourceTile !== null) this.addNeighbors(this.sourceTile);
else this.refreshToConquer();
if (this.toConquer.size() === 0) {
  if (this.removeTroops || this.sourceTile !== null) {
    this._owner.addTroops(this.startTroops);
  }
  this.attack.delete();
  this.active = false;
  return;
}
// Only now create/reuse the war and apply hostile-action side effects.
```

- [x] **Step 6: Revalidate the transport destination before conquest.** At `PathStatus.COMPLETE`, require the destination owner to still be the original hostile player and re-check the war/truce relation. If not, route the boat through its existing retreat or cancellation cleanup and never call `conquer` on the stale destination.

```ts
const landingOwner = this.mg.owner(this.dst);
if (
  landingOwner !== this.target ||
  (this.target.isPlayer() && !this.attacker.canAttackPlayer(this.target))
) {
  this.boat.updateTransportShipState({ isRetreating: true });
  this.retreatDst = null;
  return;
}
this.attacker.conquer(this.dst);
```

- [x] **Step 7: Run the focused combat and transport tests.**

Run: `npx vitest run tests/WarDiplomacyCombat.test.ts tests/core/executions/TransportShipExecutionWarDiplomacy.test.ts`

Expected: PASS, including the first-effective-land-attack case with adjacent owned tiles. If that case currently uses separated tiles, update its fixture to express an actually reachable hostile border.

- [x] **Step 8: Commit the execution boundary fix.**

```bash
git add tests/WarDiplomacyCombat.test.ts tests/core/executions/TransportShipExecutionWarDiplomacy.test.ts src/core/execution/AttackExecution.ts src/core/execution/TransportShipExecution.ts
git commit -m "fix: validate hostile attacks before war side effects"
```

### Task 2: Include defensive puppets and called coalition members

**Files:**

- Modify: `src/core/game/PlayerImpl.ts`
- Modify: `src/core/game/WarDiplomacy.ts`
- Test: `tests/PlayerImpl.test.ts`
- Test: `tests/core/WarDiplomacy.test.ts`

**Interfaces:**

- Consumes: `PlayerImpl.puppetMayFight`, `WarDiplomacy.expandSide`, `isEligibleCallRecipient`, and `joinSide`.
- Produces: accepted call-to-arms offers add the recipient's eligible coalition with stable participant reasons/order; a puppet can fight a current attacker of its overlord only as a defensive response.
- Add private `canCoalitionJoin(war: MutableWar, sideIndex: 0 | 1, members: Player[]): boolean` to validate the full incoming coalition before mutation.

- [x] **Step 1: Add a puppet-defense regression** to `tests/PlayerImpl.test.ts`: record aggression by an enemy against the overlord, create/reuse the overlord's war, then assert the puppet can attack that enemy and appears on the overlord's side.

```ts
enemy.recordAggressionAgainst(overlord);
const warId = game.warDiplomacy().beginHostileAction(enemy, overlord)!;
expect(puppet.canAttackPlayer(enemy)).toBe(true);
expect(game.warDiplomacy().getWar(warId)?.sides[1].participants).toContainEqual(
  expect.objectContaining({ playerID: puppet.id(), reason: "puppet" }),
);
```

- [x] **Step 2: Add coalition call tests** to `tests/core/WarDiplomacy.test.ts`: accept an eligible ally, assert the ally, a teammate, and a subject all join once; add `test("rejects a coalition that conflicts with the opposing side", ...)` where one invitee coalition member is allied with an opponent and assert the call is rejected without partial membership.

- [x] **Step 3: Run the new coalition and puppet tests and observe their failures.**

Run: `npx vitest run tests/PlayerImpl.test.ts tests/core/WarDiplomacy.test.ts -t "puppet|call"`

Expected: FAIL because the puppet only recognizes aggression against itself/its direct target list, and call acceptance currently joins only the named recipient.

- [x] **Step 4: Permit defensive puppet retaliation against an active attacker of the overlord.** In `puppetMayFight`, treat recent aggression against the live overlord or an active incoming attack against the overlord as defensive eligibility. Keep unrelated offensive target selection blocked.

```ts
const overlord = this._overlord;
const overlordWasAttacked =
  overlord !== null &&
  overlord.isAlive() &&
  (other.hasRecentAggressionAgainst(overlord) ||
    overlord
      .incomingAttacks()
      .some((attack) => attack.isActive() && attack.attacker() === other));
if (defensiveWar || overlordWasAttacked) return true;
```

- [x] **Step 5: Expand an accepted call to the recipient's eligible team/subject coalition.** Compute the coalition once, validate it as a whole against the opposing side and existing war participants, then add each member deterministically; do not mutate the war if any blocking relation makes the proposed coalition invalid.

```ts
const joining = this.expandSide(recipient).filter((member) => member.isAlive());
if (!this.canCoalitionJoin(war, call.side, joining)) return false;
for (const member of joining.sort((a, b) => a.id().localeCompare(b.id()))) {
  const reason =
    member === recipient
      ? "callToArms"
      : member.isOnSameTeam(recipient)
        ? "team"
        : "puppet";
  this.joinSide(war, call.side, member, reason);
}
```

- [x] **Step 6: Run the full player and war-diplomacy files** so the formal-alliance and deterministic-ordering regressions are included.

Run: `npx vitest run tests/PlayerImpl.test.ts tests/core/WarDiplomacy.test.ts`

Expected: PASS, including existing formal-alliance and deterministic-ordering cases.

- [x] **Step 7: Commit the coalition fix.**

```bash
git add tests/PlayerImpl.test.ts tests/core/WarDiplomacy.test.ts src/core/game/PlayerImpl.ts src/core/game/WarDiplomacy.ts
git commit -m "fix: join defensive coalitions to wars consistently"
```

### Task 3: End wars after annihilation and preserve viable peace offers

**Files:**

- Modify: `src/core/game/WarDiplomacy.ts`
- Test: `tests/core/WarDiplomacy.test.ts`
- Test: `tests/WarDiplomacy.test.ts`

**Interfaces:**

- Consumes: participant `isAlive`, proposal signature snapshots, call statuses, existing event emission and deterministic `tick()`.
- Produces: an ended war has no pending calls or peace proposal; dead signers no longer count as required approvals.
- Add private `endWar(war: MutableWar, winningSide: 0 | 1): void` to close proposals/calls, record events, and preserve the `ended` status.

- [x] **Step 1: Add `test("removes a dead signer and settles on surviving approvals", ...)`** to `tests/WarDiplomacy.test.ts`. Propose white peace with at least three living participants, accept with one survivor, relinquish all tiles of another signer, tick diplomacy, then assert the proposal remains and the final living signer can settle it.

```ts
deadSigner.tiles().forEach((tile) => deadSigner.relinquish(tile));
diplomacy.tick();
expect(diplomacy.getWar(warId)?.proposal).toBeDefined();
expect(diplomacy.answerPeace(warId, proposalId, lastSigner, true)).toBe(true);
```

- [x] **Step 2: Add `test("ends when either side has no living participants", ...)`**. Relinquish all land for every participant on one side, call `tick()`, and assert the status is `ended`, pending calls are cancelled, the proposal is removed, and new call/peace actions return false/null.

- [x] **Step 3: Run the new lifecycle tests and observe the current failures.**

Run: `npx vitest run tests/core/WarDiplomacy.test.ts tests/WarDiplomacy.test.ts -t "signer|ends when"`

Expected: FAIL because any dead signature cancels the offer and `tick()` currently has no defeated-side end condition.

- [x] **Step 4: Resolve dead signers without resetting accepted survivors.** Remove dead participant signatures from the required set, emit one deterministic signer-eliminated event, and settle only when all remaining signatures are accepted and the clause is still valid.

```ts
const deadSigners = war.proposal.signatures.filter(
  (signature) => !this.game.player(signature.playerID).isAlive(),
);
if (deadSigners.length > 0) {
  const deadIDs = new Set(deadSigners.map((signature) => signature.playerID));
  war.proposal.signatures = war.proposal.signatures.filter(
    (signature) => !deadIDs.has(signature.playerID),
  );
  for (const signature of deadSigners) {
    this.addEvent(war, "peaceSignerEliminated", signature.playerID);
  }
  changed = true;
}
```

- [x] **Step 5: End the war when either side has no living participants.** Set status to `ended`, clear pending proposal/call actions without returning status to `active`, record deterministic cancellation/end events, emit one snapshot update, and do not re-emit the terminal snapshot on later ticks unless participant liveness changes.

```ts
const defeated = war.sides.findIndex(
  (side) => !side.participants.some((participant) => participant.isAlive),
);
if (defeated !== -1) this.endWar(war, defeated === 0 ? 1 : 0);
```

- [x] **Step 6: Run all war diplomacy tests.**

Run: `npx vitest run tests/core/WarDiplomacy.test.ts tests/WarDiplomacy.test.ts`

Expected: PASS, including offer expiry, call expiry, cooldown, truce, and settlement behavior.

- [x] **Step 7: Commit the lifecycle fix.**

```bash
git add tests/core/WarDiplomacy.test.ts tests/WarDiplomacy.test.ts src/core/game/WarDiplomacy.ts
git commit -m "fix: resolve wars and peace offers after elimination"
```

### Task 4: Start and constrain independence wars

**Files:**

- Modify: `src/core/game/PlayerImpl.ts`
- Modify: `src/core/game/WarDiplomacy.ts`
- Test: `tests/PlayerImpl.test.ts`
- Test: `tests/WarDiplomacy.test.ts`

**Interfaces:**

- Produces: `WarDiplomacy.beginIndependenceWar(subject: Player, overlord: Player): number | null`, which creates/reuses a war with the subject coalition on one side and the overlord coalition on the other, marking the subject participant with reason `independence`; `isInIndependenceWar(subject, overlord)` is the guarded combat predicate used by puppet target selection.
- Consumes: existing `WarClause` shape `{ kind: "independence"; subjectId: PlayerID }`; no transport schema change.
- Add private helpers `expandIndependenceSubjectSide(subject, overlord)`, `expandIndependenceOverlordSide(overlord, subject)`, `canIndependenceSidesFight(subjectSide, overlordSide, subject, overlord)`, and `createWar(attacker, defender, attackerSide, defenderSide, attackerReason)`; `createWar` creates snapshots and baselines from already validated memberships.
- Add private `participantReason(war, playerID): WarJoinReason | null` so clause validation and combat authorization use the snapshot join reason.

- [x] **Step 1: Update the 80-autonomy rejection test** in `tests/PlayerImpl.test.ts`. After rejecting the request, assert the subject remains a puppet and a war exists with the subject and overlord on opposing sides; preserve the separate 100-autonomy peaceful declaration assertion.

- [x] **Step 2: Add a combat eligibility assertion** for the new war: the subject may attack its overlord only while the active independence war places them on opposing sides; unrelated puppet offensives remain blocked.

- [x] **Step 3: Add war-clause tests** in `tests/WarDiplomacy.test.ts`: a subject and overlord who merely share a side in an ordinary war cannot use the independence clause; a proposal in their active independence war releases the subject only after all required signatures accept.

- [x] **Step 4: Run the focused independence tests and observe the current failures.**

Run: `npx vitest run tests/PlayerImpl.test.ts tests/WarDiplomacy.test.ts -t "independence"`

Expected: FAIL because rejection only removes the request, and the current clause validator accepts a subject sharing the overlord's side.

- [x] **Step 5: Add `beginIndependenceWar` and the guarded combat exception.** Build deterministic subject/overlord coalitions that exclude each other, validate all other relations normally, use participant reason `independence`, and allow `canAttack`/`puppetMayFight` only for those opposing participants while that war is active.

```ts
beginIndependenceWar(subject: Player, overlord: Player): number | null {
  if (!subject.isAlive() || !overlord.isAlive() || !subject.isSubjectOf(overlord)) return null;
  const existing = this.findWarBetween(subject.id(), overlord.id());
if (
  existing !== undefined &&
  this.isIndependenceWarPair(existing, subject, overlord)
) return existing.id;
  const subjectSide = this.expandIndependenceSubjectSide(subject, overlord);
  const overlordSide = this.expandIndependenceOverlordSide(overlord, subject);
  if (!this.canIndependenceSidesFight(subjectSide, overlordSide, subject, overlord)) return null;
  return this.createWar(subject, overlord, subjectSide, overlordSide, "independence", "defender");
}
```

- [x] **Step 6: Start the war from rejected eligible requests.** In `rejectSubjectRequest`, revalidate that the subject is still the recipient's puppet and has at least 80 autonomy; after publishing the rejection, begin the special war. Keep the relation intact until the independence treaty is accepted.

```ts
const atWarAutonomy = subject._subjectInfo?.autonomy ?? 0;
const startsWar =
  subject.isSubjectOf(this) &&
  atWarAutonomy >= SUBJECT_INDEPENDENCE_REQUEST_AUTONOMY;
this._outgoingSubjectRequests = this._outgoingSubjectRequests.filter(
  (outgoing) => outgoing.id !== request.id,
);
this.mg.addUpdate({
  type: GameUpdateType.SubjectRequestReply,
  request: request.toUpdate(),
  accepted: false,
});
if (startsWar) this.mg.warDiplomacy().beginIndependenceWar(subject, this);
```

- [x] **Step 7: Restrict independence clause validation.** Require the subject's current overlord to be alive and on the opposite side, and require the subject's participant reason to be `independence`. Keep the existing release and truce settlement path on acceptance.

```ts
return (
  subject.isAlive() &&
  subject.isSubjectOf(overlord) &&
  this.participantReason(war, subject.id()) === "independence" &&
  this.sideIndex(war, subject.id()) !== this.sideIndex(war, overlord.id())
);
```

- [x] **Step 8: Run the focused independence and diplomacy tests.**

Run: `npx vitest run tests/PlayerImpl.test.ts tests/core/WarDiplomacy.test.ts tests/WarDiplomacy.test.ts`

Expected: PASS for refusal-triggered independence, the unrelated-war clause rejection, valid treaty settlement, peaceful 100-autonomy release, and the existing player/diplomacy cases affected by war creation.

- [x] **Step 9: Commit the independence fix.**

```bash
git add tests/PlayerImpl.test.ts tests/WarDiplomacy.test.ts src/core/game/PlayerImpl.ts src/core/game/WarDiplomacy.ts
git commit -m "feat: start wars when independence requests are rejected"
```

### Task 5: Summarize visible naval and nuclear threats

**Files:**

- Modify: `src/client/hud/layers/WarDiplomacyPanel.ts`
- Modify: `resources/lang/en.json`
- Modify: `resources/lang/zh-CN.json`
- Test: `tests/client/WarDiplomacyPanel.test.ts`

**Interfaces:**

- Consumes: `PlayerView.incomingAttacks()`, `GameView.units()`, `GameView.owner()`, `GameView.neighbors4()`, `GameView.circleSearch()`, `GameView.config()`, `UnitView` active/retreat/target state, tile ownership, and existing diplomacy predicates.
- Produces: one defensive panel summary with separate active visible counts for land attacks, transport landings, hostile warships, and nukes targeting the player's area.

- [x] **Step 1: Extend panel fixtures** in `tests/client/WarDiplomacyPanel.test.ts` to provide `game.units`, `game.owner`, player territory, and unit views for each threat class.

- [x] **Step 2: Add `test("summarizes active visible threats by class", ...)`**. Include one active inbound land attack, a transport targeting owned land, a nearby hostile warship, a nuke whose target is owned, and inactive/retreating/friendly control units; assert the four threat classes render and excluded controls do not affect counts.

- [x] **Step 3: Run the panel tests and observe the missing-class failure.**

Run: `npx vitest run tests/client/WarDiplomacyPanel.test.ts`

Expected: FAIL because `renderVisibleThreats()` currently totals land attacks only.

- [x] **Step 4: Implement a pure threat-summary helper** within `WarDiplomacyPanel.ts` or a focused adjacent `lib/VisibleThreats.ts`. Filter inactive and retreating objects, select hostile transports aimed at the player's current land, select hostile warships adjacent to owned territory or in combat with the player's units, and select active nuclear units whose target tiles/blast area include owned land.

```ts
interface VisibleThreatSummary {
  landAttacks: number;
  landings: number;
  warships: number;
  nukes: number;
}

function visibleThreatSummary(
  game: GameView,
  player: PlayerView,
): VisibleThreatSummary {
  const hostile = (unit: UnitView) => !unit.owner().isFriendly(player);
  const active = (unit: UnitView) => unit.isActive() && !unit.state.retreating;
  const units = game.units().filter(active);
  const owns = (tile: TileRef | undefined) => {
    if (tile === undefined) return false;
    const owner = game.owner(tile);
    return owner.isPlayer() && owner.isFriendly(player);
  };
  const hasOwnedNeighbor = (tile: TileRef) => {
    const neighbors: TileRef[] = [0, 0, 0, 0];
    const count = game.neighbors4(tile, neighbors);
    return neighbors.slice(0, count).some((neighbor) => owns(neighbor));
  };
  const nuclearThreat = (unit: UnitView) => {
    const target = unit.targetTile();
    if (target === undefined) return false;
    const radiusType =
      unit.type() === UnitType.MIRV ? UnitType.MIRVWarhead : unit.type();
    const radius = game.config().nukeMagnitudes(radiusType).outer;
    return game.circleSearch(target, radius, (tile) => owns(tile)).size > 0;
  };
  return {
    landAttacks: player.incomingAttacks().filter((attack) => !attack.retreating)
      .length,
    landings: units.filter(
      (unit) =>
        unit.type() === UnitType.TransportShip &&
        hostile(unit) &&
        !unit.transportShipState().isRetreating &&
        owns(unit.targetTile()),
    ).length,
    warships: units.filter(
      (unit) =>
        unit.type() === UnitType.Warship &&
        hostile(unit) &&
        (unit.isInCombat() || hasOwnedNeighbor(unit.tile())),
    ).length,
    nukes: units.filter(
      (unit) =>
        [
          UnitType.AtomBomb,
          UnitType.HydrogenBomb,
          UnitType.MIRV,
          UnitType.MIRVWarhead,
        ].includes(unit.type()) &&
        hostile(unit) &&
        nuclearThreat(unit),
    ).length,
  };
}
```

- [x] **Step 5: Render the four counts with bilingual labels.** Keep the existing no-threat message for an all-zero summary and do not alter server snapshots or expose units outside the client view.

```ts
const threats = visibleThreatSummary(this.game, my);
const total =
  threats.landAttacks + threats.landings + threats.warships + threats.nukes;
return total === 0
  ? html`<p>${translateText("war_panel.no_visible_threats")}</p>`
  : html`<ul>
      <li>
        ${translateText("war_panel.land_attacks", {
          count: threats.landAttacks,
        })}
      </li>
      <li>
        ${translateText("war_panel.landings", { count: threats.landings })}
      </li>
      <li>
        ${translateText("war_panel.warships", { count: threats.warships })}
      </li>
      <li>${translateText("war_panel.nukes", { count: threats.nukes })}</li>
    </ul>`;
```

- [x] **Step 6: Run the war panel tests.**

Run: `npx vitest run tests/client/WarDiplomacyPanel.test.ts`

Expected: PASS for the no-threat state, all four active classes, and inactive/retreating/friendly exclusions.

- [x] **Step 7: Commit the threat summary.**

```bash
git add tests/client/WarDiplomacyPanel.test.ts src/client/hud/layers/WarDiplomacyPanel.ts resources/lang/en.json resources/lang/zh-CN.json
git commit -m "feat: show naval and nuclear threats in war panel"
```

### Task 6: Replace the radial right-click menu with accessible text actions

**Files:**

- Create: `src/client/hud/layers/TextContextMenu.ts`
- Create: `src/client/hud/layers/MainContextMenu.ts`
- Create: `src/client/hud/layers/ContextMenuElements.ts` from the current action descriptors
- Modify: `src/client/hud/GameRenderer.ts`
- Modify: `src/client/hud/layers/PlayerInfoOverlay.ts`
- Modify: `src/client/hud/layers/ChatIntegration.ts`
- Modify: `resources/lang/en.json`
- Modify: `resources/lang/zh-CN.json`
- Delete: `src/client/hud/layers/RadialMenu.ts`
- Delete: `src/client/hud/layers/MainRadialMenu.ts`
- Delete: `src/client/hud/layers/RadialMenuElements.ts` after imports move
- Test: `tests/client/graphics/RadialMenuElements.test.ts`
- Create: `tests/client/graphics/TextContextMenu.test.ts`

**Interfaces:**

- `TextContextMenu` owns `container: HTMLElement`, `visible: boolean`, `pages: MenuElement[][]`, and `pageIndex: number`; it consumes `MenuElement[]` and `MenuElementParams`, and exposes `init()`, `setParams(params)`, `show(x, y)`, `hide()`, `refresh()`, and `isVisible()`.
- Its private `clampToViewport(x: number, y: number)` positions the current container; `moveMenuFocus(event: KeyboardEvent)` navigates enabled buttons in `container`.
- Extend `MenuElement` with `group?: "primary" | "diplomacy" | "resources" | "trade" | "other"` and `unavailableReason?: (params: MenuElementParams) => TooltipKey | null`.
- `MainContextMenu` replaces `MainRadialMenu` while retaining `ContextMenuEvent`, `PlayerView.actions(tile)`, `BuildMenu`, `EmojiTable`, `PlayerPanel`, and `PlayerActionHandler` wiring.
- Replace `CloseRadialMenuEvent` with `CloseContextMenuEvent`; do not add ally-support or resource-request intents.
- Add private `clampToViewport(x: number, y: number): void` and `moveMenuFocus(event: KeyboardEvent): void` methods to `TextContextMenu`.

- [x] **Step 1: Add DOM behavior tests** in `tests/client/graphics/TextContextMenu.test.ts` for visible text labels, grouped actions, disabled explanations, submenu/back navigation, viewport clamping, Escape/outside dismissal, and keyboard focus movement.

- [x] **Step 2: Run the new menu test and observe the missing renderer.**

Run: `npx vitest run tests/client/graphics/TextContextMenu.test.ts`

Expected: FAIL because the text menu element does not exist yet.

- [x] **Step 3: Implement `TextContextMenu`.** Render buttons and labeled groups, clamp position using measured element bounds, preserve submenu stacks, dismiss on outside click/Escape, and handle ArrowUp/ArrowDown/Home/End/Enter with focusable enabled rows.

```ts
show(x: number, y: number): void {
  this.visible = true;
  this.container.hidden = false;
  this.render();
  requestAnimationFrame(() => this.clampToViewport(x, y));
}

private onKeyDown(event: KeyboardEvent): void {
  if (event.key === "Escape") this.dismiss();
  else if (["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(event.key)) {
    this.moveMenuFocus(event);
  }
}
```

- [x] **Step 4: Adapt existing action descriptors and orchestration.** Keep each current callback and relationship condition; display relevant disabled actions with the existing tooltip key as a text reason. Exclude descriptors that require unmerged ally-support/resource backends. Switch `GameRenderer` and `PlayerInfoOverlay` to `MainContextMenu` and `CloseContextMenuEvent`.

```ts
const visibleItems = page.items.filter(
  (item) => item.displayed?.(params) ?? true,
);
for (const item of visibleItems) {
  const button = document.createElement("button");
  button.type = "button";
  button.disabled = item.disabled(params);
  button.textContent = translateText(item.name);
  const reason = item.unavailableReason?.(params);
  if (reason) {
    const detail = document.createElement("span");
    detail.textContent = translateText(reason.key, reason.params);
    button.append(detail);
  }
  button.addEventListener("click", () => item.action?.(params));
}
```

- [x] **Step 5: Add bilingual menu group/action/reason labels** to `resources/lang/en.json` and `resources/lang/zh-CN.json` and update the existing descriptor tests to import `ContextMenuElements.ts`.

- [x] **Step 6: Run the menu and existing HUD regression tests.**

Run: `npx vitest run tests/client/graphics/TextContextMenu.test.ts tests/client/graphics/RadialMenuElements.test.ts tests/client/graphics/RadialMenuSpawn.test.ts`

Expected: PASS with every currently supported action still discoverable as a labeled menu item.

- [x] **Step 7: Remove the obsolete radial implementation** after `rg "RadialMenu|CloseRadialMenuEvent" src tests` finds no production imports; rename/update test titles that still describe the radial renderer.

- [x] **Step 8: Commit the text menu replacement.**

```bash
git add src/client/hud/GameRenderer.ts src/client/hud/layers/PlayerInfoOverlay.ts src/client/hud/layers/ChatIntegration.ts src/client/hud/layers/TextContextMenu.ts src/client/hud/layers/MainContextMenu.ts src/client/hud/layers/ContextMenuElements.ts src/client/hud/layers/RadialMenu.ts src/client/hud/layers/MainRadialMenu.ts src/client/hud/layers/RadialMenuElements.ts resources/lang/en.json resources/lang/zh-CN.json tests/client/graphics/RadialMenuElements.test.ts tests/client/graphics/TextContextMenu.test.ts
git commit -m "feat: replace radial actions with a text context menu"
```

### Task 7: Review the complete change and verify before pushing

**Files:**

- Review: all files changed by Tasks 1–6
- Modify: affected regression tests or implementation files only when a concrete review finding requires a fix

**Interfaces:**

- Consumes: completed implementations and task-level commits from Tasks 1–6.
- Produces: a clean, tested feature branch ready to push to `origin`.

- [x] **Step 1: Run all war diplomacy, combat, subject, panel, and context-menu tests.**

Run: `npx vitest run tests/core/WarDiplomacy.test.ts tests/WarDiplomacy.test.ts tests/WarDiplomacyCombat.test.ts tests/PlayerImpl.test.ts tests/client/WarDiplomacyPanel.test.ts tests/client/graphics/TextContextMenu.test.ts tests/client/graphics/RadialMenuElements.test.ts tests/client/graphics/RadialMenuSpawn.test.ts tests/core/executions/TransportShipExecutionWarDiplomacy.test.ts`

Expected: PASS. If a pre-existing unrelated failure appears, capture the exact test and compare it against the baseline recorded before implementation.

- [x] **Step 2: Run repository lint and production build.**

Run: `npm run lint && npm run build-prod`

Expected: both commands exit 0.

- [x] **Step 3: Run the full `npm test` suite** because the earlier review explicitly identified it as not green; record and resolve failures caused by this change, and report any confirmed baseline failures separately.

Full-suite result: `npm test` did not finish green. The run reproduced the baseline `localStorage`-unavailable client failures and stalled in `tests/server/GameApiCors.test.ts` (7 request timeouts) and `tests/server/WorkerPathPrefix.test.ts` (4 request timeouts); it was interrupted after those suites stopped making progress. The run also caught an English translation-key ordering regression from this branch; that was fixed, and `tests/EnJsonSorted.test.ts` now passes. The final focused regression group passes 105 tests across 10 files.

- [x] **Step 4: Review the final diff** with `git diff origin/main...HEAD`, inspect the worktree status, and verify that no resource-request, ally-support, or alternate settlement changes were pulled in.

- [ ] **Step 5: Push the completed branch to GitHub.**

```bash
git push -u origin codex/war-diplomacy-context-menu
```

Expected: the remote branch contains the design, plan, and implementation commits. Report the branch and compare URL in the final response.
