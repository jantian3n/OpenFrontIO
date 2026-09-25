import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { EventBus } from "../../../core/EventBus";
import { UnitType } from "../../../core/game/Game";
import type { TileRef } from "../../../core/game/GameMap";
import type { WarClause, WarSnapshot } from "../../../core/game/WarDiplomacy";
import {
  WAR_PUPPET_SCORE_THRESHOLD,
  WAR_REPARATIONS_SCORE_THRESHOLD,
} from "../../../core/game/WarDiplomacy";
import type { Controller } from "../../Controller";
import { SendWarDiplomacyIntentEvent } from "../../Transport";
import { renderDuration, renderNumber, translateText } from "../../Utils";
import type { GameView, PlayerView } from "../../view";

type PeaceClauseKind = WarClause["kind"];

interface VisibleThreatSummary {
  landAttacks: number;
  landAttackTroops: number;
  landings: number;
  warships: number;
  nukes: number;
}

function summarizeVisibleThreats(
  game: GameView,
  player: PlayerView,
): VisibleThreatSummary {
  const incomingAttacks = player
    .incomingAttacks()
    .filter((attack) => !attack.retreating);
  const ownedTerritory = (tile: TileRef): boolean => {
    const owner = game.owner(tile);
    return owner.isPlayer() && owner.id() === player.id();
  };
  const hasOwnedNeighbor = (tile: TileRef): boolean => {
    const neighbors: TileRef[] = [0, 0, 0, 0];
    const count = game.neighbors4(tile, neighbors);
    for (let i = 0; i < count; i++) {
      if (ownedTerritory(neighbors[i])) return true;
    }
    return false;
  };

  let landings = 0;
  let warships = 0;
  let nukes = 0;
  for (const unit of game.units()) {
    if (!unit.isActive() || unit.state.retreating) continue;
    const owner = unit.owner();
    if (owner.id() === player.id() || owner.isFriendly(player)) continue;

    switch (unit.type()) {
      case UnitType.TransportShip: {
        if (unit.transportShipState().isRetreating) continue;
        const target = unit.targetTile();
        if (target !== undefined && ownedTerritory(target)) landings++;
        break;
      }
      case UnitType.Warship:
        if (unit.isInCombat() || hasOwnedNeighbor(unit.tile())) warships++;
        break;
      case UnitType.AtomBomb:
      case UnitType.HydrogenBomb:
      case UnitType.MIRV:
      case UnitType.MIRVWarhead: {
        const target = unit.targetTile();
        if (target === undefined) break;
        const radius = game.config().nukeMagnitudes(unit.type()).outer;
        if (
          radius > 0 &&
          game.circleSearch(target, radius, ownedTerritory).size > 0
        ) {
          nukes++;
        }
        break;
      }
    }
  }

  return {
    landAttacks: incomingAttacks.length,
    landAttackTroops: incomingAttacks.reduce(
      (sum, attack) => sum + attack.troops,
      0,
    ),
    landings,
    warships,
    nukes,
  };
}

@customElement("war-diplomacy-panel")
export class WarDiplomacyPanel extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  @state() private isOpen = false;
  @state() private clauseKinds = new Map<number, PeaceClauseKind>();
  @state() private selectedRecipients = new Map<number, string>();
  @state() private pendingActions = new Set<string>();
  @state() private validationErrors = new Map<number, string>();

  createRenderRoot() {
    return this;
  }

  getTickIntervalMs(): number {
    return 500;
  }

  tick(): void {
    if (this.isOpen) this.requestUpdate();
  }

  private activeWars(): WarSnapshot[] {
    return this.game.wars().filter((war) => war.status !== "ended");
  }

  private participantName(id: string): string {
    try {
      return this.game.player(id).displayName();
    } catch {
      return id;
    }
  }

  private player(id: string): PlayerView | null {
    try {
      return this.game.player(id);
    } catch {
      return null;
    }
  }

  private statusLabel(war: WarSnapshot): string {
    return translateText(`war_panel.status_${war.status}`);
  }

  private reasonLabel(reason: string): string {
    return translateText(`war_panel.reason_${reason}`);
  }

  private sideFor(war: WarSnapshot, playerID: string): 0 | 1 | null {
    const side = war.sides.findIndex((entry) =>
      entry.participants.some(
        (participant) => participant.playerID === playerID,
      ),
    );
    return side === -1 ? null : (side as 0 | 1);
  }

  private send(
    intent: ConstructorParameters<typeof SendWarDiplomacyIntentEvent>[0],
    key: string,
  ): void {
    if (this.pendingActions.has(key)) return;
    this.pendingActions = new Set(this.pendingActions).add(key);
    this.eventBus.emit(new SendWarDiplomacyIntentEvent(intent));
    window.setTimeout(() => {
      const next = new Set(this.pendingActions);
      next.delete(key);
      this.pendingActions = next;
    }, 1500);
  }

  private answerCall(war: WarSnapshot, accepted: boolean): void {
    const my = this.game.myPlayer();
    if (!my) return;
    const call = war.calls.find(
      (entry) => entry.recipientID === my.id() && entry.status === "pending",
    );
    if (!call) return;
    this.send(
      { type: "war_answer_call", warId: war.id, accepted },
      `call:${war.id}:${call.id}`,
    );
  }

  private callAlly(war: WarSnapshot, recipientID: string): void {
    if (!recipientID) return;
    this.send(
      { type: "war_call_to_arms", warId: war.id, recipient: recipientID },
      `invite:${war.id}:${recipientID}`,
    );
  }

  private submitPeace(war: WarSnapshot, event: Event): void {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const kind = String(data.get("clause-kind")) as PeaceClauseKind;
    let clause: WarClause;

    if (kind === "whitePeace") {
      clause = { kind };
    } else if (kind === "reparations") {
      const payerId = String(data.get("payer"));
      const receiverId = String(data.get("receiver"));
      const amount = Number(data.get("amount"));
      const payer = this.player(payerId);
      const payerSide = this.sideFor(war, payerId);
      const receiverSide = this.sideFor(war, receiverId);
      if (
        !Number.isSafeInteger(amount) ||
        amount <= 0 ||
        payer === null ||
        payerSide === null ||
        receiverSide === null ||
        payerSide === receiverSide ||
        war.sides[receiverSide].score.total - war.sides[payerSide].score.total <
          WAR_REPARATIONS_SCORE_THRESHOLD ||
        payer.gold() < BigInt(amount)
      ) {
        this.setError(war.id, "war_panel.error_reparations");
        return;
      }
      clause = { kind, payerId, receiverId, amount };
    } else if (kind === "puppet") {
      const targetId = String(data.get("puppet-target"));
      const overlordId = String(data.get("puppet-overlord"));
      const targetSide = this.sideFor(war, targetId);
      const overlordSide = this.sideFor(war, overlordId);
      if (
        !targetId ||
        !overlordId ||
        targetId === overlordId ||
        targetSide === null ||
        overlordSide === null ||
        targetSide === overlordSide ||
        war.sides[overlordSide].score.total -
          war.sides[targetSide].score.total <
          WAR_PUPPET_SCORE_THRESHOLD
      ) {
        this.setError(war.id, "war_panel.error_puppet");
        return;
      }
      clause = { kind, targetId, overlordId };
    } else {
      const subject = this.game.myPlayer();
      const overlord = subject?.overlord();
      if (
        !subject?.isPuppet() ||
        !overlord ||
        this.sideFor(war, subject.id()) === null ||
        this.sideFor(war, subject.id()) !== this.sideFor(war, overlord.id())
      ) {
        this.setError(war.id, "war_panel.error_independence");
        return;
      }
      clause = { kind: "independence", subjectId: subject.id() };
    }

    this.setError(war.id, null);
    this.send(
      { type: "war_propose_peace", warId: war.id, clause },
      `peace-proposal:${war.id}`,
    );
  }

  private setError(warId: number, key: string | null): void {
    const errors = new Map(this.validationErrors);
    if (key === null) errors.delete(warId);
    else errors.set(warId, key);
    this.validationErrors = errors;
  }

  private answerPeace(war: WarSnapshot, accepted: boolean): void {
    const my = this.game.myPlayer();
    if (!my || !war.proposal) return;
    this.send(
      {
        type: "war_answer_peace",
        warId: war.id,
        proposalId: war.proposal.id,
        accepted,
      },
      `peace-answer:${war.id}:${war.proposal.id}`,
    );
  }

  private renderScores(war: WarSnapshot) {
    return html`<div class="mt-3 grid grid-cols-2 gap-2">
      ${war.sides.map(
        (side, index) =>
          html`<div class="rounded-xl border border-white/10 bg-black/20 p-3">
            <div
              class="mb-2 flex items-center justify-between gap-2 text-xs text-zinc-300"
            >
              <span
                >${translateText("war_panel.side", { number: index + 1 })}</span
              >
              <strong class="tabular-nums text-white"
                >${renderNumber(side.score.total)}</strong
              >
            </div>
            <div class="space-y-1 text-xs text-zinc-400">
              <div class="flex justify-between gap-2">
                <span>${translateText("war_panel.score_territory")}</span
                ><span class="tabular-nums"
                  >${renderNumber(side.score.territory)}</span
                >
              </div>
              <div class="flex justify-between gap-2">
                <span>${translateText("war_panel.score_military")}</span
                ><span class="tabular-nums"
                  >${renderNumber(side.score.militaryLosses)}</span
                >
              </div>
              <div class="flex justify-between gap-2">
                <span>${translateText("war_panel.score_structures")}</span
                ><span class="tabular-nums"
                  >${renderNumber(side.score.structures)}</span
                >
              </div>
            </div>
          </div>`,
      )}
    </div>`;
  }

  private renderParticipants(war: WarSnapshot) {
    return html`<div class="grid grid-cols-2 gap-2">
      ${war.sides.map(
        (side, index) =>
          html`<div class="min-w-0">
            <h3
              class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400"
            >
              ${translateText("war_panel.side", { number: index + 1 })}
            </h3>
            <ul class="space-y-1">
              ${side.participants.map(
                (participant) =>
                  html`<li
                    class="flex min-w-0 items-center gap-1.5 text-sm ${participant.isAlive
                      ? "text-zinc-100"
                      : "text-zinc-500 line-through"}"
                  >
                    <span class="min-w-0 truncate"
                      >${this.participantName(participant.playerID)}</span
                    >
                    <span
                      class="shrink-0 rounded-md bg-white/5 px-1.5 py-0.5 text-xs text-zinc-400"
                      >${this.reasonLabel(participant.reason)}</span
                    >
                  </li>`,
              )}
            </ul>
          </div>`,
      )}
    </div>`;
  }

  private renderIncomingCall(war: WarSnapshot) {
    const my = this.game.myPlayer();
    const call = war.calls.find(
      (entry) => entry.recipientID === my?.id() && entry.status === "pending",
    );
    if (!call) return html``;
    const key = `call:${war.id}:${call.id}`;
    const disabled = this.pendingActions.has(key);
    return html`<div
      class="mt-3 rounded-xl border border-sky-400/20 bg-sky-400/5 p-3"
      role="group"
      aria-label=${translateText("war_panel.call_invite_label")}
    >
      <p class="text-sm text-sky-100">
        ${translateText("war_panel.call_invite", {
          name: this.participantName(call.inviterID),
        })}
      </p>
      <div class="mt-2 flex gap-2">
        <button
          class="min-h-11 cursor-pointer rounded-lg bg-sky-500/20 px-3 py-2 text-sm font-semibold text-sky-100 hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-50"
          data-action="answer-call-accept"
          ?disabled=${disabled}
          @click=${() => this.answerCall(war, true)}
        >
          ${translateText("war_panel.accept")}
        </button>
        <button
          class="min-h-11 cursor-pointer rounded-lg bg-white/5 px-3 py-2 text-sm text-zinc-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
          data-action="answer-call-reject"
          ?disabled=${disabled}
          @click=${() => this.answerCall(war, false)}
        >
          ${translateText("war_panel.reject")}
        </button>
      </div>
    </div>`;
  }

  private renderCallControls(war: WarSnapshot) {
    const my = this.game.myPlayer();
    if (!my || this.sideFor(war, my.id()) === null || war.status !== "active")
      return html``;
    const participants = new Set(
      war.sides.flatMap((side) =>
        side.participants.map((entry) => entry.playerID),
      ),
    );
    const recipients = my
      .allies()
      .filter((ally) => !participants.has(ally.id()));
    if (recipients.length === 0) return html``;
    const value = this.selectedRecipients.get(war.id) ?? recipients[0].id();
    const key = `invite:${war.id}:${value}`;
    return html`<div class="mt-3 flex flex-wrap items-center gap-2">
      <label class="sr-only" for=${`war-call-${war.id}`}
        >${translateText("war_panel.call_ally")}</label
      >
      <select
        id=${`war-call-${war.id}`}
        class="min-h-11 min-w-0 flex-1 rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
        .value=${value}
        @change=${(event: Event) => {
          const next = new Map(this.selectedRecipients);
          next.set(war.id, (event.target as HTMLSelectElement).value);
          this.selectedRecipients = next;
        }}
      >
        ${recipients.map(
          (ally) =>
            html`<option value=${ally.id()}>${ally.displayName()}</option>`,
        )}
      </select>
      <button
        data-action="call-ally"
        class="min-h-11 cursor-pointer rounded-lg border border-sky-300/20 bg-sky-500/10 px-3 py-2 text-sm font-semibold text-sky-100 hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-50"
        ?disabled=${this.pendingActions.has(key)}
        @click=${() => this.callAlly(war, value)}
      >
        ${translateText("war_panel.call_ally")}
      </button>
    </div>`;
  }

  private renderClauseFields(war: WarSnapshot, kind: PeaceClauseKind) {
    const [side0, side1] = war.sides;
    const leadingSide: 0 | 1 = side0.score.total >= side1.score.total ? 0 : 1;
    const losingSide = leadingSide === 0 ? 1 : 0;
    const hasReparationsLead =
      war.sides[leadingSide].score.total - war.sides[losingSide].score.total >=
      WAR_REPARATIONS_SCORE_THRESHOLD;
    const hasPuppetLead =
      war.sides[leadingSide].score.total - war.sides[losingSide].score.total >=
      WAR_PUPPET_SCORE_THRESHOLD;
    if (kind === "reparations") {
      return html`<div
        class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_8rem]"
      >
        <label class="text-xs text-zinc-300"
          >${translateText("war_panel.payer")}
          <select
            name="payer"
            class="mt-1 min-h-11 w-full rounded-lg border border-white/10 bg-zinc-900 px-2 py-2 text-sm text-zinc-100"
            ?disabled=${!hasReparationsLead}
          >
            ${war.sides[losingSide].participants
              .filter((p) => p.isAlive)
              .map(
                (p) =>
                  html`<option value=${p.playerID}>
                    ${this.participantName(p.playerID)}
                  </option>`,
              )}
          </select>
        </label>
        <label class="text-xs text-zinc-300"
          >${translateText("war_panel.receiver")}
          <select
            name="receiver"
            class="mt-1 min-h-11 w-full rounded-lg border border-white/10 bg-zinc-900 px-2 py-2 text-sm text-zinc-100"
            ?disabled=${!hasReparationsLead}
          >
            ${war.sides[leadingSide].participants
              .filter((p) => p.isAlive)
              .map(
                (p) =>
                  html`<option value=${p.playerID}>
                    ${this.participantName(p.playerID)}
                  </option>`,
              )}
          </select>
        </label>
        <label class="text-xs text-zinc-300"
          >${translateText("war_panel.amount")}
          <input
            name="amount"
            type="number"
            min="1"
            step="1"
            required
            inputmode="numeric"
            class="mt-1 min-h-11 w-full rounded-lg border border-white/10 bg-zinc-900 px-2 py-2 text-sm text-zinc-100"
            ?disabled=${!hasReparationsLead}
          />
        </label>
        ${!hasReparationsLead
          ? html`<p class="text-xs text-amber-200 sm:col-span-3">
              ${translateText("war_panel.reparations_threshold", {
                points: WAR_REPARATIONS_SCORE_THRESHOLD,
              })}
            </p>`
          : ""}
      </div>`;
    }
    if (kind === "puppet") {
      return html`<div class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label class="text-xs text-zinc-300"
          >${translateText("war_panel.puppet_target")}
          <select
            name="puppet-target"
            class="mt-1 min-h-11 w-full rounded-lg border border-white/10 bg-zinc-900 px-2 py-2 text-sm text-zinc-100"
            ?disabled=${!hasPuppetLead}
          >
            ${war.sides[losingSide].participants
              .filter((p) => p.isAlive)
              .map(
                (p) =>
                  html`<option value=${p.playerID}>
                    ${this.participantName(p.playerID)}
                  </option>`,
              )}
          </select>
        </label>
        <label class="text-xs text-zinc-300"
          >${translateText("war_panel.puppet_overlord")}
          <select
            name="puppet-overlord"
            class="mt-1 min-h-11 w-full rounded-lg border border-white/10 bg-zinc-900 px-2 py-2 text-sm text-zinc-100"
            ?disabled=${!hasPuppetLead}
          >
            ${war.sides[leadingSide].participants
              .filter((p) => p.isAlive)
              .map(
                (p) =>
                  html`<option value=${p.playerID}>
                    ${this.participantName(p.playerID)}
                  </option>`,
              )}
          </select>
        </label>
        ${!hasPuppetLead
          ? html`<p class="text-xs text-amber-200 sm:col-span-2">
              ${translateText("war_panel.puppet_threshold", {
                points: WAR_PUPPET_SCORE_THRESHOLD,
              })}
            </p>`
          : ""}
      </div>`;
    }
    if (kind === "independence") {
      const my = this.game.myPlayer();
      const available = Boolean(
        my?.isPuppet() &&
        my.overlord() &&
        this.sideFor(war, my.id()) !== null &&
        this.sideFor(war, my.id()) === this.sideFor(war, my.overlord()!.id()),
      );
      return html`<p
        class="mt-2 rounded-lg bg-white/5 px-3 py-2 text-xs text-zinc-300"
      >
        ${available
          ? translateText("war_panel.independence_clause")
          : translateText("war_panel.error_independence")}
      </p>`;
    }
    return html``;
  }

  private renderPeaceProposalForm(war: WarSnapshot) {
    const my = this.game.myPlayer();
    if (!my || war.status !== "active" || this.sideFor(war, my.id()) === null)
      return html``;
    const leadingSide: 0 | 1 =
      war.sides[0].score.total >= war.sides[1].score.total ? 0 : 1;
    const losingSide = leadingSide === 0 ? 1 : 0;
    const hasReparationsLead =
      war.sides[leadingSide].score.total - war.sides[losingSide].score.total >=
      WAR_REPARATIONS_SCORE_THRESHOLD;
    const hasPuppetLead =
      war.sides[leadingSide].score.total - war.sides[losingSide].score.total >=
      WAR_PUPPET_SCORE_THRESHOLD;
    const overlord = my.overlord();
    const hasIndependenceTerm = Boolean(
      my.isPuppet() &&
      overlord &&
      this.sideFor(war, my.id()) === this.sideFor(war, overlord.id()),
    );
    const kind = this.clauseKinds.get(war.id) ?? "whitePeace";
    const key = `peace-proposal:${war.id}`;
    return html`<form
      class="mt-3 rounded-xl border border-white/10 bg-black/20 p-3"
      @submit=${(event: Event) => this.submitPeace(war, event)}
    >
      <label
        class="block text-xs font-semibold text-zinc-300"
        for=${`peace-kind-${war.id}`}
        >${translateText("war_panel.propose_peace")}</label
      >
      <select
        id=${`peace-kind-${war.id}`}
        name="clause-kind"
        class="mt-1 min-h-11 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
        .value=${kind}
        @change=${(event: Event) => {
          const next = new Map(this.clauseKinds);
          next.set(
            war.id,
            (event.target as HTMLSelectElement).value as PeaceClauseKind,
          );
          this.clauseKinds = next;
        }}
      >
        <option value="whitePeace">
          ${translateText("war_panel.clause_white_peace")}
        </option>
        <option value="reparations" ?disabled=${!hasReparationsLead}>
          ${translateText("war_panel.clause_reparations")}
        </option>
        <option value="puppet" ?disabled=${!hasPuppetLead}>
          ${translateText("war_panel.clause_puppet")}
        </option>
        <option value="independence" ?disabled=${!hasIndependenceTerm}>
          ${translateText("war_panel.clause_independence")}
        </option>
      </select>
      ${this.renderClauseFields(war, kind)}
      ${this.validationErrors.has(war.id)
        ? html`<p role="alert" class="mt-2 text-xs text-red-200">
            ${translateText(this.validationErrors.get(war.id)!)}
          </p>`
        : ""}
      <button
        type="submit"
        class="mt-3 min-h-11 w-full cursor-pointer rounded-lg bg-emerald-500/15 px-3 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50"
        ?disabled=${this.pendingActions.has(key)}
      >
        ${translateText("war_panel.submit_proposal")}
      </button>
    </form>`;
  }

  private renderProposal(war: WarSnapshot) {
    const proposal = war.proposal;
    if (!proposal) return html``;
    const my = this.game.myPlayer();
    const ownSignature = proposal.signatures.find(
      (entry) => entry.playerID === my?.id(),
    );
    const actionKey = `peace-answer:${war.id}:${proposal.id}`;
    return html`<section
      class="mt-3 rounded-xl border border-amber-300/20 bg-amber-300/5 p-3"
      aria-label=${translateText("war_panel.proposal")}
    >
      <div class="flex items-center justify-between gap-2">
        <h3 class="text-sm font-semibold text-amber-100">
          ${translateText("war_panel.proposal")}
        </h3>
        <span class="rounded-full bg-white/5 px-2 py-1 text-xs text-zinc-300"
          >${this.statusLabel(war)}</span
        >
      </div>
      <p class="mt-1 text-xs text-zinc-300">
        ${this.renderClauseLabel(proposal.clause)}
      </p>
      <ul class="mt-3 space-y-1">
        ${proposal.signatures.map(
          (signature) =>
            html`<li class="flex items-center justify-between gap-2 text-xs">
              <span class="truncate text-zinc-300"
                >${this.participantName(signature.playerID)}</span
              >
              <span
                class=${signature.status === "accepted"
                  ? "text-emerald-200"
                  : signature.status === "rejected"
                    ? "text-red-200"
                    : "text-amber-200"}
                >${translateText(
                  `war_panel.signature_${signature.status}`,
                )}</span
              >
            </li>`,
        )}
      </ul>
      ${ownSignature?.status === "pending"
        ? html`<div class="mt-3 flex gap-2">
            <button
              class="rounded-lg bg-emerald-500/15 px-3 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-50"
              data-action="answer-peace-accept"
              ?disabled=${this.pendingActions.has(actionKey)}
              @click=${() => this.answerPeace(war, true)}
            >
              ${translateText("war_panel.accept")}
            </button>
            <button
              class="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-100 hover:bg-red-500/20 disabled:opacity-50"
              data-action="answer-peace-reject"
              ?disabled=${this.pendingActions.has(actionKey)}
              @click=${() => this.answerPeace(war, false)}
            >
              ${translateText("war_panel.reject")}
            </button>
          </div>`
        : ""}
    </section>`;
  }

  private renderClauseLabel(clause: WarClause) {
    switch (clause.kind) {
      case "whitePeace":
        return translateText("war_panel.clause_white_peace");
      case "reparations":
        return translateText("war_panel.reparations_summary", {
          payer: this.participantName(clause.payerId),
          receiver: this.participantName(clause.receiverId),
          amount: renderNumber(clause.amount),
        });
      case "puppet":
        return translateText("war_panel.puppet_summary", {
          target: this.participantName(clause.targetId),
          overlord: this.participantName(clause.overlordId),
        });
      case "independence":
        return translateText("war_panel.independence_summary", {
          subject: this.participantName(clause.subjectId),
        });
    }
  }

  private renderEconomicContext() {
    const my = this.game.myPlayer();
    if (!my) return html``;
    const tributeRate = my
      .subjects()
      .reduce((sum, subject) => sum + (subject.tributeRate() ?? 0), 0);
    return html`<section
      class="mt-3 rounded-xl border border-emerald-300/10 bg-emerald-300/[0.04] p-3"
      aria-label=${translateText("war_panel.economy")}
    >
      <h3
        class="text-xs font-semibold uppercase tracking-wide text-emerald-100"
      >
        ${translateText("war_panel.economy")}
      </h3>
      <div class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <span class="text-zinc-400">${translateText("war_panel.treasury")}</span
        ><span class="text-right font-semibold tabular-nums text-white"
          >${renderNumber(Number(my.gold()))}</span
        >
        <span class="text-zinc-400"
          >${translateText("war_panel.cumulative_income")}</span
        ><span class="text-right tabular-nums text-zinc-200"
          >${renderNumber(my.goldEarned())}</span
        >
        <span class="text-zinc-400"
          >${translateText("war_panel.trade_income")}</span
        ><span class="text-right tabular-nums text-zinc-200"
          >${renderNumber(my.tradeGold())}</span
        >
        <span class="text-zinc-400"
          >${translateText("war_panel.train_income")}</span
        ><span class="text-right tabular-nums text-zinc-200"
          >${renderNumber(my.trainGold())}</span
        >
        <span class="text-zinc-400"
          >${translateText("war_panel.piracy_income")}</span
        ><span class="text-right tabular-nums text-zinc-200"
          >${renderNumber(my.piracyGold())}</span
        >
        <span class="text-zinc-400"
          >${translateText("war_panel.tribute_commitments")}</span
        ><span class="text-right tabular-nums text-zinc-200"
          >${tributeRate}%</span
        >
      </div>
    </section>`;
  }

  private renderVisibleThreats() {
    const my = this.game.myPlayer();
    if (!my) return html``;
    const threats = summarizeVisibleThreats(this.game, my);
    const hasThreats =
      threats.landAttacks +
        threats.landings +
        threats.warships +
        threats.nukes >
      0;
    return html`<section
      class="mt-3 rounded-xl border border-rose-300/10 bg-rose-300/[0.04] p-3"
      aria-label=${translateText("war_panel.defense")}
    >
      <h3 class="text-xs font-semibold uppercase tracking-wide text-rose-100">
        ${translateText("war_panel.defense")}
      </h3>
      ${!hasThreats
        ? html`<p class="mt-2 text-xs text-zinc-400">
            ${translateText("war_panel.no_visible_threats")}
          </p>`
        : html`<ul class="mt-2 space-y-1 text-sm text-zinc-200">
            ${threats.landAttacks > 0
              ? html`<li>
                  ${translateText("war_panel.land_attacks", {
                    count: threats.landAttacks,
                    troops: renderNumber(threats.landAttackTroops),
                  })}
                </li>`
              : html``}
            ${threats.landings > 0
              ? html`<li>
                  ${translateText("war_panel.landings", {
                    count: threats.landings,
                  })}
                </li>`
              : html``}
            ${threats.warships > 0
              ? html`<li>
                  ${translateText("war_panel.warships", {
                    count: threats.warships,
                  })}
                </li>`
              : html``}
            ${threats.nukes > 0
              ? html`<li>
                  ${translateText("war_panel.nukes", {
                    count: threats.nukes,
                  })}
                </li>`
              : html``}
          </ul>`}
    </section>`;
  }

  private renderEvents(war: WarSnapshot) {
    if (war.events.length === 0) return html``;
    return html`<details
      class="mt-3 rounded-xl border border-white/10 bg-black/15 px-3 py-2"
    >
      <summary class="cursor-pointer text-xs font-semibold text-zinc-300">
        ${translateText("war_panel.recent_events")}
      </summary>
      <ul class="mt-2 space-y-1.5">
        ${war.events
          .slice(-5)
          .reverse()
          .map(
            (event) =>
              html`<li class="text-xs text-zinc-400">
                ${translateText(`war_panel.event_${event.kind}`, {
                  name: event.actorID
                    ? this.participantName(event.actorID)
                    : "",
                  target: event.targetID
                    ? this.participantName(event.targetID)
                    : "",
                })}
              </li>`,
          )}
      </ul>
    </details>`;
  }

  private renderWar(war: WarSnapshot) {
    const remaining =
      war.truceEndsAt === undefined
        ? null
        : Math.max(0, war.truceEndsAt - this.game.ticks());
    return html`<article
      class="rounded-2xl border border-white/10 bg-zinc-900/80 p-3 shadow-lg shadow-black/10 sm:p-4"
      data-war-id=${war.id}
    >
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="text-sm font-bold text-white">
              ${translateText("war_panel.war_number", { number: war.id })}
            </h2>
            <span
              class="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-zinc-300"
              >${this.statusLabel(war)}</span
            >
          </div>
          <p class="mt-1 text-xs text-zinc-400">
            ${translateText("war_panel.started_at", { tick: war.createdAt })}
          </p>
        </div>
        ${remaining !== null
          ? html`<div
              class="shrink-0 text-right"
              role="timer"
              data-remaining-ticks=${remaining}
            >
              <div class="text-[10px] uppercase tracking-wide text-cyan-200">
                ${translateText("war_panel.truce")}
              </div>
              <div class="tabular-nums text-sm font-semibold text-cyan-100">
                ${translateText("war_panel.truce_time", {
                  time: renderDuration(Math.ceil(remaining / 10)),
                })}
              </div>
            </div>`
          : ""}
      </div>
      <div class="mt-3">${this.renderParticipants(war)}</div>
      ${this.renderScores(war)} ${this.renderIncomingCall(war)}
      ${this.renderProposal(war)} ${this.renderCallControls(war)}
      ${this.renderPeaceProposalForm(war)} ${this.renderEvents(war)}
    </article>`;
  }

  render() {
    const wars = this.activeWars();
    const my = this.game.myPlayer();
    const pendingResponses = wars.reduce((count, war) => {
      const callCount = war.calls.filter(
        (call) => call.recipientID === my?.id() && call.status === "pending",
      ).length;
      const peaceCount = war.proposal?.signatures.some(
        (signature) =>
          signature.playerID === my?.id() && signature.status === "pending",
      )
        ? 1
        : 0;
      return count + callCount + peaceCount;
    }, 0);
    return html`<div
      class="pointer-events-auto fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-3 z-[9000] sm:right-5"
    >
      <button
        class="flex min-h-11 items-center gap-2 rounded-xl border border-cyan-200/15 bg-zinc-950/95 px-4 py-2.5 text-sm font-semibold text-zinc-100 shadow-xl shadow-black/30 backdrop-blur hover:border-cyan-200/30 hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
        aria-expanded=${this.isOpen}
        aria-controls="war-diplomacy-content"
        @click=${() => (this.isOpen = !this.isOpen)}
      >
        <span
          aria-hidden="true"
          class="size-2 rounded-full ${wars.length
            ? "bg-cyan-300"
            : "bg-zinc-500"}"
        ></span>
        <span>${translateText("war_panel.title")}</span>
        ${wars.length
          ? html`<span
              class="rounded-full bg-cyan-300/15 px-2 py-0.5 text-xs tabular-nums text-cyan-100"
              >${wars.length}</span
            >`
          : ""}
        ${pendingResponses
          ? html`<span
              class="rounded-full bg-amber-300/15 px-2 py-0.5 text-xs tabular-nums text-amber-100"
              aria-label=${translateText("war_panel.pending_responses", {
                count: pendingResponses,
              })}
              >${pendingResponses}</span
            >`
          : ""}
      </button>
      ${this.isOpen
        ? html`<aside
            id="war-diplomacy-content"
            class="fixed inset-x-2 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] top-14 z-[9001] flex max-h-[calc(100dvh-6rem)] max-w-xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/95 text-zinc-100 shadow-2xl shadow-black/50 backdrop-blur-xl sm:inset-x-auto sm:right-5 sm:top-16 sm:w-[min(32rem,calc(100vw-2.5rem))]"
            aria-label=${translateText("war_panel.title")}
          >
            <header
              class="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3"
            >
              <div class="min-w-0">
                <h1 class="truncate text-base font-bold">
                  ${translateText("war_panel.title")}
                </h1>
                <p class="text-xs text-zinc-400">
                  ${translateText("war_panel.subtitle")}
                </p>
              </div>
              <button
                class="flex size-11 shrink-0 items-center justify-center rounded-lg bg-white/5 text-zinc-200 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
                aria-label=${translateText("common.close")}
                @click=${() => (this.isOpen = false)}
              >
                ×
              </button>
            </header>
            <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 sm:p-4">
              ${wars.length === 0
                ? html`<div
                    class="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-zinc-400"
                  >
                    ${translateText("war_panel.empty")}
                  </div>`
                : wars.map((war) => this.renderWar(war))}
              ${my
                ? html`${this.renderEconomicContext()}${this.renderVisibleThreats()}`
                : ""}
            </div>
          </aside>`
        : ""}
    </div>`;
  }
}
