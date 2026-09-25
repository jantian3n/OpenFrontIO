import { simpleHash } from "../Util";
import {
  PlayerType,
  Structures,
  UnitType,
  type Game,
  type Player,
  type PlayerID,
  type TerraNullius,
  type Tick,
} from "./Game";
import type { TileRef } from "./GameMap";
import { GameUpdateType } from "./GameUpdates";

export type WarStatus = "active" | "peacePending" | "truce" | "ended";
export type WarJoinReason =
  | "attacker"
  | "defender"
  | "team"
  | "puppet"
  | "callToArms"
  | "independence";

export const WAR_PROPOSAL_DURATION_TICKS = 300;
export const WAR_CALL_DURATION_TICKS = 300;
export const WAR_OFFER_COOLDOWN_TICKS = 300;
export const WAR_TRUCE_DURATION_TICKS = 600;
export const WAR_REPARATIONS_SCORE_THRESHOLD = 2_000;
export const WAR_PUPPET_SCORE_THRESHOLD = 7_500;

export interface WarParticipantSnapshot {
  playerID: PlayerID;
  joinedAt: Tick;
  reason: WarJoinReason;
  isAlive: boolean;
}

export interface WarScoreSnapshot {
  territory: number;
  militaryLosses: number;
  structures: number;
  total: number;
}

export interface WarSideSnapshot {
  participants: WarParticipantSnapshot[];
  score: WarScoreSnapshot;
}

export type WarClause =
  | { kind: "whitePeace" }
  | {
      kind: "reparations";
      payerId: PlayerID;
      receiverId: PlayerID;
      amount: number;
    }
  | { kind: "puppet"; targetId: PlayerID; overlordId: PlayerID }
  | { kind: "independence"; subjectId: PlayerID };

export interface WarPeaceProposalSnapshot {
  id: number;
  proposerID: PlayerID;
  createdAt: Tick;
  expiresAt: Tick;
  clause: WarClause;
  signatures: Array<{
    playerID: PlayerID;
    status: "pending" | "accepted" | "rejected";
  }>;
}

export interface WarCallSnapshot {
  id: number;
  inviterID: PlayerID;
  recipientID: PlayerID;
  side: 0 | 1;
  createdAt: Tick;
  expiresAt: Tick;
  status: "pending" | "accepted" | "rejected" | "expired" | "cancelled";
}

export interface PendingWarCall {
  war: WarSnapshot;
  call: WarCallSnapshot;
}

export interface WarEventSnapshot {
  sequence: number;
  tick: Tick;
  kind: string;
  actorID?: PlayerID;
  targetID?: PlayerID;
}

export interface WarSnapshot {
  id: number;
  createdAt: Tick;
  status: WarStatus;
  sides: [WarSideSnapshot, WarSideSnapshot];
  proposal?: WarPeaceProposalSnapshot;
  calls: WarCallSnapshot[];
  truceEndsAt?: Tick;
  events: WarEventSnapshot[];
}

type MutableWarParticipant = WarParticipantSnapshot;
interface MutableWarSide extends WarSideSnapshot {
  participants: MutableWarParticipant[];
  baselineTerritory: Set<TileRef>;
  baselineTroopsRemaining: Map<PlayerID, number>;
  baselineMilitaryValue: number;
  baselineStructureValue: number;
  militaryLossValue: number;
  baselineMilitaryUnits: Map<number, number>;
  baselineStructures: Map<number, { type: UnitType; level: number }>;
}
interface MutableWar extends WarSnapshot {
  sides: [MutableWarSide, MutableWarSide];
  events: WarEventSnapshot[];
  calls: WarCallSnapshot[];
}

const MAX_RECENT_WAR_EVENTS = 20;

export class WarDiplomacy {
  private readonly _wars = new Map<number, MutableWar>();
  private readonly _dirtyWars = new Set<number>();
  private _nextWarID = 1;
  private _nextEventSequence = 1;
  private _nextOfferID = 1;
  private readonly _peaceCooldownUntil = new Map<number, Tick>();
  private readonly _callCooldownUntil = new Map<string, Tick>();

  constructor(private readonly game: Game) {}

  canAttack(attacker: Player, target: Player): boolean {
    if (attacker === target || this.hasBlockingRelation(attacker, target)) {
      return false;
    }
    const existing = this.findWarBetween(attacker.id(), target.id());
    if (existing?.status === "truce") return false;
    if (existing !== undefined) return true;
    if (this.findWarOnSameSide(attacker.id(), target.id()) !== undefined) {
      return false;
    }

    const attackers = this.expandSide(attacker);
    const defenders = this.expandSide(target);
    return this.canSidesFight(attackers, defenders);
  }

  canAttackDisconnectedTeammate(attacker: Player, target: Player): boolean {
    return (
      attacker !== target &&
      target.isDisconnected() &&
      attacker.isOnSameTeam(target) &&
      !this.isInTruceAcrossSides(attacker.id(), target.id())
    );
  }

  beginHostileAction(attacker: Player, target: Player): number | null {
    if (!this.canAttack(attacker, target)) return null;

    const existing = this.findWarBetween(attacker.id(), target.id());
    if (existing !== undefined) return existing.id;

    const attackingSide = this.expandSide(attacker);
    const defendingSide = this.expandSide(target);
    if (!this.canSidesFight(attackingSide, defendingSide)) return null;

    const id = this._nextWarID++;
    const createdAt = this.game.ticks();
    const attackerParticipants = this.makeParticipants(
      attackingSide,
      attacker,
      target,
      "attacker",
      "defender",
      createdAt,
    );
    const defenderParticipants = this.makeParticipants(
      defendingSide,
      attacker,
      target,
      "attacker",
      "defender",
      createdAt,
    );
    const war: MutableWar = {
      id,
      createdAt,
      status: "active",
      sides: [
        this.makeSide(attackingSide, attackerParticipants),
        this.makeSide(defendingSide, defenderParticipants),
      ],
      events: [],
      calls: [],
    };
    this._wars.set(id, war);
    this.addEvent(war, "warStarted", attacker.id(), target.id());
    this.emit(war);
    return id;
  }

  getWar(id: number): WarSnapshot | undefined {
    const war = this._wars.get(id);
    return war === undefined ? undefined : this.snapshot(war);
  }

  warsFor(player: Player): WarSnapshot[] {
    return Array.from(this._wars.values())
      .filter((war) =>
        war.sides.some((side) =>
          side.participants.some(
            (participant) => participant.playerID === player.id(),
          ),
        ),
      )
      .sort((a, b) => a.id - b.id)
      .map((war) => this.snapshot(war));
  }

  pendingCallsFor(player: Player): PendingWarCall[] {
    return Array.from(this._wars.values())
      .filter((war) => war.status === "active")
      .flatMap((war) =>
        war.calls
          .filter(
            (call) =>
              call.recipientID === player.id() && call.status === "pending",
          )
          .map((call) => ({ war: this.snapshot(war), call: { ...call } })),
      )
      .sort(
        (left, right) =>
          left.war.id - right.war.id || left.call.id - right.call.id,
      );
  }

  tick(): void {
    const now = this.game.ticks();
    for (const war of this._wars.values()) {
      let changed = false;
      for (const side of war.sides) {
        for (const participant of side.participants) {
          const alive = this.game.player(participant.playerID).isAlive();
          if (participant.isAlive !== alive) {
            participant.isAlive = alive;
            changed = true;
            if (!alive) {
              this.addEvent(war, "participantEliminated", participant.playerID);
            }
          }
        }
      }
      const defeatedSide = war.sides.findIndex(
        (side) => !side.participants.some((participant) => participant.isAlive),
      );
      if (defeatedSide !== -1) {
        if (war.status !== "ended") {
          this.endWar(war, defeatedSide === 0 ? 1 : 0);
          changed = true;
        }
        if (changed) this.emit(war);
        continue;
      }
      if (war.proposal !== undefined) {
        if (now >= war.proposal.expiresAt) {
          this.cancelProposal(war, "peaceProposalExpired");
          changed = true;
        } else {
          changed = this.removeDeadPeaceSigners(war) || changed;
          if (
            war.proposal !== undefined &&
            war.proposal.signatures.every(
              (signature) => signature.status === "accepted",
            )
          ) {
            this.settleProposal(war);
            changed = true;
          }
        }
      }
      for (const call of war.calls) {
        if (call.status === "pending" && now >= call.expiresAt) {
          call.status = "expired";
          this._callCooldownUntil.set(
            this.callKey(war.id, call.recipientID),
            now + WAR_OFFER_COOLDOWN_TICKS,
          );
          this.addEvent(war, "callExpired", call.inviterID, call.recipientID);
          changed = true;
        }
      }
      if (
        war.status === "truce" &&
        war.truceEndsAt !== undefined &&
        now >= war.truceEndsAt
      ) {
        war.status = "ended";
        this.addEvent(war, "truceEnded");
        changed = true;
      }
      if (changed) this.emit(war);
    }
  }

  hash(): number {
    const normalized = {
      nextWarID: this._nextWarID,
      nextEventSequence: this._nextEventSequence,
      nextOfferID: this._nextOfferID,
      peaceCooldownUntil: Array.from(this._peaceCooldownUntil.entries()).sort(
        ([left], [right]) => left - right,
      ),
      callCooldownUntil: Array.from(this._callCooldownUntil.entries()).sort(
        ([left], [right]) => left.localeCompare(right),
      ),
      wars: Array.from(this._wars.values())
        .sort((a, b) => a.id - b.id)
        .map((war) => ({
          snapshot: this.snapshot(war),
          baselines: war.sides.map((side) => ({
            territory: Array.from(side.baselineTerritory).sort((a, b) => a - b),
            troops: Array.from(side.baselineTroopsRemaining.entries()).sort(
              ([left], [right]) => left.localeCompare(right),
            ),
            militaryValue: side.baselineMilitaryValue,
            structureValue: side.baselineStructureValue,
            militaryLossValue: side.militaryLossValue,
            militaryUnits: Array.from(
              side.baselineMilitaryUnits.entries(),
            ).sort(([left], [right]) => left - right),
            structures: Array.from(side.baselineStructures.entries())
              .map(([unitID, value]) => [unitID, value.type, value.level])
              .sort(([left], [right]) => Number(left) - Number(right)),
          })),
        })),
    };
    return simpleHash(JSON.stringify(normalized));
  }

  warIdBetween(attacker: Player, defender: Player): number | null {
    const war = this.findWarBetween(attacker.id(), defender.id());
    return war !== undefined && war.status !== "truce" ? war.id : null;
  }

  isTruce(warId: number): boolean {
    return this._wars.get(warId)?.status === "truce";
  }

  createCallToArms(
    warId: number,
    inviter: Player,
    recipient: Player,
  ): number | null {
    const war = this._wars.get(warId);
    if (
      war === undefined ||
      war.status !== "active" ||
      !inviter.isAlive() ||
      !recipient.isAlive()
    ) {
      return null;
    }
    const sideIndex = this.sideIndex(war, inviter.id());
    if (
      sideIndex === null ||
      !this.hasParticipant(war.sides[sideIndex], inviter.id()) ||
      war.sides[sideIndex].participants.find(
        (participant) => participant.playerID === inviter.id(),
      )?.reason === "callToArms" ||
      this.sideIndex(war, recipient.id()) !== null ||
      inviter.allianceWith(recipient) === null ||
      !this.isEligibleCallRecipient(war, sideIndex, recipient)
    ) {
      return null;
    }
    const key = this.callKey(warId, recipient.id());
    if ((this._callCooldownUntil.get(key) ?? 0) > this.game.ticks()) {
      return null;
    }
    const existing = war.calls.find(
      (call) =>
        call.recipientID === recipient.id() && call.status === "pending",
    );
    if (existing !== undefined) return existing.id;

    const now = this.game.ticks();
    const call: WarCallSnapshot = {
      id: this._nextOfferID++,
      inviterID: inviter.id(),
      recipientID: recipient.id(),
      side: sideIndex,
      createdAt: now,
      expiresAt: now + WAR_CALL_DURATION_TICKS,
      status: "pending",
    };
    war.calls.push(call);
    this.addEvent(war, "callOffered", inviter.id(), recipient.id());
    this.emit(war);
    return call.id;
  }

  answerCall(warId: number, recipient: Player, accepted: boolean): boolean {
    const war = this._wars.get(warId);
    const call = war?.calls.find(
      (offer) =>
        offer.recipientID === recipient.id() && offer.status === "pending",
    );
    if (war === undefined || war.status !== "active" || call === undefined) {
      return false;
    }
    if (this.game.ticks() >= call.expiresAt) {
      this.expireCall(war, call);
      return false;
    }
    if (accepted) {
      const inviter = this.game.player(call.inviterID);
      if (
        !recipient.isAlive() ||
        !inviter.isAlive() ||
        inviter.allianceWith(recipient) === null ||
        !this.isEligibleCallRecipient(war, call.side, recipient)
      ) {
        this.expireCall(war, call);
        return false;
      }
      const joining = this.expandSide(recipient).filter((member) =>
        member.isAlive(),
      );
      if (!this.canCoalitionJoin(war, call.side, joining)) {
        this.expireCall(war, call);
        return false;
      }
      call.status = "accepted";
      for (const member of joining) {
        if (this.sideIndex(war, member.id()) === call.side) continue;
        const reason: WarJoinReason =
          member === recipient
            ? "callToArms"
            : member.isOnSameTeam(recipient)
              ? "team"
              : "puppet";
        this.joinSide(war, call.side, member, reason);
      }
      this.addEvent(war, "callAccepted", recipient.id());
    } else {
      call.status = "rejected";
      this._callCooldownUntil.set(
        this.callKey(war.id, recipient.id()),
        this.game.ticks() + WAR_OFFER_COOLDOWN_TICKS,
      );
      this.addEvent(war, "callRejected", recipient.id());
    }
    this.emit(war);
    return true;
  }

  proposePeace(
    warId: number,
    proposer: Player,
    clause: WarClause,
  ): number | null {
    const war = this._wars.get(warId);
    const now = this.game.ticks();
    if (
      war === undefined ||
      war.status !== "active" ||
      war.proposal !== undefined ||
      (this._peaceCooldownUntil.get(warId) ?? 0) > now ||
      !proposer.isAlive() ||
      this.sideIndex(war, proposer.id()) === null ||
      !this.isValidClause(war, clause)
    ) {
      return null;
    }

    const proposalID = this._nextOfferID++;
    const signatures = war.sides
      .flatMap((side) => side.participants)
      .filter((participant) => this.game.player(participant.playerID).isAlive())
      .map((participant) => ({
        playerID: participant.playerID,
        status:
          participant.playerID === proposer.id()
            ? ("accepted" as const)
            : this.game.player(participant.playerID).type() === PlayerType.Human
              ? ("pending" as const)
              : this.botAcceptsClause(war, participant.playerID, clause)
                ? ("accepted" as const)
                : ("rejected" as const),
      }))
      .sort((a, b) => a.playerID.localeCompare(b.playerID));
    war.proposal = {
      id: proposalID,
      proposerID: proposer.id(),
      createdAt: now,
      expiresAt: now + WAR_PROPOSAL_DURATION_TICKS,
      clause: structuredClone(clause),
      signatures,
    };
    war.status = "peacePending";
    this.addEvent(war, "peaceProposed", proposer.id());

    if (signatures.some((signature) => signature.status === "rejected")) {
      this.cancelProposal(war, "peaceRejected");
    } else if (
      signatures.every((signature) => signature.status === "accepted")
    ) {
      this.settleProposal(war);
    }
    this.emit(war);
    return proposalID;
  }

  answerPeace(
    warId: number,
    proposalId: number,
    responder: Player,
    accepted: boolean,
  ): boolean {
    const war = this._wars.get(warId);
    const proposal = war?.proposal;
    if (
      war === undefined ||
      war.status !== "peacePending" ||
      proposal === undefined ||
      proposal.id !== proposalId ||
      !responder.isAlive()
    ) {
      return false;
    }
    if (this.game.ticks() >= proposal.expiresAt) {
      this.cancelProposal(war, "peaceProposalExpired", responder.id());
      this.emit(war);
      return false;
    }
    const removedDeadSigners = this.removeDeadPeaceSigners(war);
    const signature = proposal.signatures.find(
      (entry) => entry.playerID === responder.id(),
    );
    if (signature?.status !== "pending") {
      if (removedDeadSigners) this.emit(war);
      return false;
    }
    if (!accepted) {
      signature.status = "rejected";
      this.cancelProposal(war, "peaceRejected", responder.id());
      this.emit(war);
      return true;
    }
    signature.status = "accepted";
    this.addEvent(war, "peaceSigned", responder.id());
    let settledOrPending = true;
    if (proposal.signatures.every((entry) => entry.status === "accepted")) {
      settledOrPending = this.settleProposal(war);
    }
    this.emit(war);
    return settledOrPending;
  }

  recordTerritoryChange(
    warId: number,
    _tile: TileRef,
    _oldOwner: Player | TerraNullius,
    _newOwner: Player | TerraNullius,
  ): void {
    const war = this._wars.get(warId);
    if (war === undefined || !this.isScoring(war)) return;
    if (this.recalculateScores(war)) this._dirtyWars.add(war.id);
  }

  recordTerritoryOwnerChange(
    _tile: TileRef,
    oldOwner: Player | TerraNullius,
    newOwner: Player | TerraNullius,
  ): void {
    for (const war of this._wars.values()) {
      if (!this.isScoring(war)) continue;
      const involvesOwner = (owner: Player | TerraNullius) =>
        owner.isPlayer() && this.sideIndex(war, owner.id()) !== null;
      if (!involvesOwner(oldOwner) && !involvesOwner(newOwner)) continue;
      if (this.recalculateScores(war)) this._dirtyWars.add(war.id);
    }
  }

  recordTroopLoss(
    warId: number,
    attacker: Player,
    defender: Player,
    amount: number,
  ): void {
    const war = this._wars.get(warId);
    if (war === undefined || !this.isScoring(war)) return;
    const attackerSide = this.sideIndex(war, attacker.id());
    const defenderSide = this.sideIndex(war, defender.id());
    if (
      attackerSide === null ||
      defenderSide === null ||
      attackerSide === defenderSide
    ) {
      return;
    }
    const remaining =
      war.sides[defenderSide].baselineTroopsRemaining.get(defender.id()) ?? 0;
    const loss = Math.min(Math.max(0, Math.floor(amount)), remaining);
    if (loss === 0) return;
    war.sides[defenderSide].baselineTroopsRemaining.set(
      defender.id(),
      remaining - loss,
    );
    war.sides[attackerSide].militaryLossValue += loss;
    if (this.recalculateScores(war)) this._dirtyWars.add(war.id);
  }

  recordUnitLoss(
    warId: number,
    unitID: number,
    attacker: Player,
    defender: Player,
  ): void {
    const war = this._wars.get(warId);
    if (war === undefined || !this.isScoring(war)) return;
    const attackerSide = this.sideIndex(war, attacker.id());
    const defenderSide = this.sideIndex(war, defender.id());
    if (
      attackerSide === null ||
      defenderSide === null ||
      attackerSide === defenderSide
    ) {
      return;
    }
    const value = war.sides[defenderSide].baselineMilitaryUnits.get(unitID);
    if (value === undefined) return;
    war.sides[defenderSide].baselineMilitaryUnits.delete(unitID);
    war.sides[attackerSide].militaryLossValue += value;
    if (this.recalculateScores(war)) this._dirtyWars.add(war.id);
  }

  recordStructureLoss(
    warId: number,
    attacker: Player,
    defender: Player,
    type: UnitType,
    level: number,
    unitID?: number,
  ): void {
    const war = this._wars.get(warId);
    if (war === undefined || !this.isScoring(war) || level <= 0) return;
    const attackerSide = this.sideIndex(war, attacker.id());
    const defenderSide = this.sideIndex(war, defender.id());
    if (
      attackerSide === null ||
      defenderSide === null ||
      attackerSide === defenderSide
    ) {
      return;
    }
    const baseline =
      unitID === undefined
        ? undefined
        : war.sides[defenderSide].baselineStructures.get(unitID);
    if (baseline === undefined || baseline.type !== type) {
      return;
    }
    if (this.recalculateScores(war)) this._dirtyWars.add(war.id);
  }

  flushUpdates(): void {
    for (const warId of Array.from(this._dirtyWars).sort((a, b) => a - b)) {
      const war = this._wars.get(warId);
      if (war !== undefined) this.emit(war);
    }
    this._dirtyWars.clear();
  }

  private emptyScore(): WarScoreSnapshot {
    return { territory: 0, militaryLosses: 0, structures: 0, total: 0 };
  }

  private makeSide(
    members: Player[],
    participants: MutableWarParticipant[],
  ): MutableWarSide {
    const baselineTerritory = new Set<TileRef>();
    const baselineTroopsRemaining = new Map<PlayerID, number>();
    const baselineMilitaryUnits = new Map<number, number>();
    const baselineStructures = new Map<
      number,
      { type: UnitType; level: number }
    >();
    let baselineMilitaryValue = 0;
    let baselineStructureValue = 0;

    for (const player of members) {
      for (const tile of player.tiles()) baselineTerritory.add(tile);
      const troops = Math.max(0, Math.floor(player.troops()));
      baselineTroopsRemaining.set(player.id(), troops);
      baselineMilitaryValue += troops;
      for (const unit of player.units()) {
        if (Structures.has(unit.type())) {
          const level = Math.max(0, Math.floor(unit.level()));
          baselineStructures.set(unit.id(), { type: unit.type(), level });
          baselineStructureValue += this.structureWeight(unit.type()) * level;
        } else {
          const value = Number(unit.info().cost(this.game, player));
          baselineMilitaryUnits.set(unit.id(), Math.max(0, Math.floor(value)));
          baselineMilitaryValue += Math.max(0, Math.floor(value));
        }
      }
    }

    return {
      participants,
      score: this.emptyScore(),
      baselineTerritory,
      baselineTroopsRemaining,
      baselineMilitaryValue,
      baselineStructureValue,
      militaryLossValue: 0,
      baselineMilitaryUnits,
      baselineStructures,
    };
  }

  private structureWeight(type: UnitType): number {
    switch (type) {
      case UnitType.City:
        return 4;
      case UnitType.DefensePost:
      case UnitType.Port:
        return 2;
      case UnitType.MissileSilo:
      case UnitType.Factory:
        return 3;
      case UnitType.SAMLauncher:
        return 4;
      default:
        return 0;
    }
  }

  private isScoring(war: MutableWar): boolean {
    return war.status === "active" || war.status === "peacePending";
  }

  private sideIndex(war: MutableWar, playerID: PlayerID): 0 | 1 | null {
    if (this.hasParticipant(war.sides[0], playerID)) return 0;
    if (this.hasParticipant(war.sides[1], playerID)) return 1;
    return null;
  }

  private recalculateScores(war: MutableWar): boolean {
    const old = war.sides.map((side) => ({ ...side.score }));
    const territoryCounts: [number, number] = [0, 0];
    for (const tile of war.sides[0].baselineTerritory) {
      const owner = this.game.owner(tile);
      if (owner.isPlayer() && this.sideIndex(war, owner.id()) === 1) {
        territoryCounts[1]++;
      }
    }
    for (const tile of war.sides[1].baselineTerritory) {
      const owner = this.game.owner(tile);
      if (owner.isPlayer() && this.sideIndex(war, owner.id()) === 0) {
        territoryCounts[0]++;
      }
    }

    for (const sideIndex of [0, 1] as const) {
      const side = war.sides[sideIndex];
      const enemy = war.sides[sideIndex === 0 ? 1 : 0];
      let structureLossValue = 0;
      for (const [unitID, baseline] of enemy.baselineStructures) {
        const unit = this.game.unit(unitID);
        const currentLevel = unit?.isActive() ? unit.level() : 0;
        const lostLevels = Math.max(0, baseline.level - currentLevel);
        structureLossValue += this.structureWeight(baseline.type) * lostLevels;
      }
      side.score = {
        territory:
          enemy.baselineTerritory.size === 0
            ? 0
            : Math.min(
                5000,
                Math.floor(
                  (5000 * territoryCounts[sideIndex]) /
                    enemy.baselineTerritory.size,
                ),
              ),
        militaryLosses:
          enemy.baselineMilitaryValue === 0
            ? 0
            : Math.min(
                3000,
                Math.floor(
                  (3000 * side.militaryLossValue) / enemy.baselineMilitaryValue,
                ),
              ),
        structures:
          enemy.baselineStructureValue === 0
            ? 0
            : Math.min(
                2000,
                Math.floor(
                  (2000 * structureLossValue) / enemy.baselineStructureValue,
                ),
              ),
        total: 0,
      };
      side.score.total =
        side.score.territory +
        side.score.militaryLosses +
        side.score.structures;
    }
    return war.sides.some(
      (side, index) =>
        side.score.territory !== old[index].territory ||
        side.score.militaryLosses !== old[index].militaryLosses ||
        side.score.structures !== old[index].structures,
    );
  }

  private hasBlockingRelation(a: Player, b: Player): boolean {
    return (
      a.isOnSameTeam(b) ||
      a.isInSubjectRelation(b) ||
      a.allianceWith(b) !== null ||
      this.isInTruceAcrossSides(a.id(), b.id())
    );
  }

  private canSidesFight(a: Player[], b: Player[]): boolean {
    const bIDs = new Set(b.map((player) => player.id()));
    if (a.some((player) => bIDs.has(player.id()))) return false;
    for (const attacker of a) {
      for (const target of b) {
        if (this.hasBlockingRelation(attacker, target)) return false;
      }
    }
    return true;
  }

  private expandSide(root: Player): Player[] {
    const alive = this.game.players().filter((player) => player.isAlive());
    const teamMembers = alive.filter((player) => player.isOnSameTeam(root));
    if (!teamMembers.some((player) => player.id() === root.id())) {
      teamMembers.push(root);
    }
    const relationMembers = new Map<PlayerID, Player>();
    for (const member of teamMembers) {
      relationMembers.set(member.id(), member);
      const overlord = member.overlord();
      if (overlord?.isAlive()) relationMembers.set(overlord.id(), overlord);
      for (const subject of member.subjects()) {
        if (subject.isAlive()) relationMembers.set(subject.id(), subject);
      }
    }

    const sideMembers = new Map<PlayerID, Player>(relationMembers);
    for (const linked of relationMembers.values()) {
      for (const player of alive) {
        if (player.isOnSameTeam(linked)) sideMembers.set(player.id(), player);
      }
    }
    return Array.from(sideMembers.values()).sort((a, b) =>
      a.id().localeCompare(b.id()),
    );
  }

  private makeParticipants(
    members: Player[],
    attacker: Player,
    defender: Player,
    attackerReason: WarJoinReason,
    defenderReason: WarJoinReason,
    joinedAt: Tick,
  ): MutableWarParticipant[] {
    return members
      .map(
        (player): MutableWarParticipant => ({
          playerID: player.id(),
          joinedAt,
          reason:
            player === attacker
              ? attackerReason
              : player === defender
                ? defenderReason
                : player.isOnSameTeam(attacker) || player.isOnSameTeam(defender)
                  ? "team"
                  : "puppet",
          isAlive: player.isAlive(),
        }),
      )
      .sort((a, b) => a.playerID.localeCompare(b.playerID));
  }

  private findWarBetween(a: PlayerID, b: PlayerID): MutableWar | undefined {
    return Array.from(this._wars.values())
      .sort((left, right) => left.id - right.id)
      .find((war) => {
        if (war.status === "ended") return false;
        return (
          (this.hasParticipant(war.sides[0], a) &&
            this.hasParticipant(war.sides[1], b)) ||
          (this.hasParticipant(war.sides[0], b) &&
            this.hasParticipant(war.sides[1], a))
        );
      });
  }

  private findWarOnSameSide(a: PlayerID, b: PlayerID): MutableWar | undefined {
    return Array.from(this._wars.values())
      .filter((war) => war.status !== "ended")
      .sort((left, right) => left.id - right.id)
      .find(
        (war) =>
          (this.hasParticipant(war.sides[0], a) &&
            this.hasParticipant(war.sides[0], b)) ||
          (this.hasParticipant(war.sides[1], a) &&
            this.hasParticipant(war.sides[1], b)),
      );
  }

  private hasParticipant(side: MutableWarSide, playerID: PlayerID): boolean {
    return side.participants.some(
      (participant) => participant.playerID === playerID,
    );
  }

  private isInTruceAcrossSides(a: PlayerID, b: PlayerID): boolean {
    for (const war of this._wars.values()) {
      if (war.status !== "truce") continue;
      if (
        (this.hasParticipant(war.sides[0], a) &&
          this.hasParticipant(war.sides[1], b)) ||
        (this.hasParticipant(war.sides[0], b) &&
          this.hasParticipant(war.sides[1], a))
      ) {
        return true;
      }
    }
    return false;
  }

  private isEligibleCallRecipient(
    war: MutableWar,
    invitedSide: 0 | 1,
    recipient: Player,
  ): boolean {
    const otherSide = war.sides[invitedSide === 0 ? 1 : 0];
    return otherSide.participants.every((participant) => {
      const opponent = this.game.player(participant.playerID);
      return !this.hasBlockingRelation(recipient, opponent);
    });
  }

  private canCoalitionJoin(
    war: MutableWar,
    sideIndex: 0 | 1,
    members: Player[],
  ): boolean {
    const opposingSide = war.sides[sideIndex === 0 ? 1 : 0];
    const opposingIDs = new Set(
      opposingSide.participants.map((participant) => participant.playerID),
    );
    const uniqueMembers = new Map(
      members.map((member) => [member.id(), member] as const),
    );

    for (const member of uniqueMembers.values()) {
      const existingSide = this.sideIndex(war, member.id());
      if (existingSide !== null && existingSide !== sideIndex) return false;
      if (opposingIDs.has(member.id())) return false;
      for (const participant of opposingSide.participants) {
        const opponent = this.game.player(participant.playerID);
        if (this.hasBlockingRelation(member, opponent)) return false;
      }
    }
    return true;
  }

  private joinSide(
    war: MutableWar,
    sideIndex: 0 | 1,
    player: Player,
    reason: WarJoinReason,
  ): void {
    const participant: MutableWarParticipant = {
      playerID: player.id(),
      joinedAt: this.game.ticks(),
      reason,
      isAlive: player.isAlive(),
    };
    const side = war.sides[sideIndex];
    const baseline = this.makeSide([player], [participant]);
    side.participants.push(participant);
    side.participants.sort((a, b) => a.playerID.localeCompare(b.playerID));
    for (const tile of baseline.baselineTerritory) {
      side.baselineTerritory.add(tile);
    }
    for (const [id, troops] of baseline.baselineTroopsRemaining) {
      side.baselineTroopsRemaining.set(id, troops);
    }
    for (const [id, value] of baseline.baselineMilitaryUnits) {
      side.baselineMilitaryUnits.set(id, value);
    }
    for (const [id, value] of baseline.baselineStructures) {
      side.baselineStructures.set(id, value);
    }
    side.baselineMilitaryValue += baseline.baselineMilitaryValue;
    side.baselineStructureValue += baseline.baselineStructureValue;
    this.recalculateScores(war);
  }

  private isValidClause(war: MutableWar, clause: WarClause): boolean {
    if (clause.kind === "whitePeace") return true;
    if (clause.kind === "reparations") {
      if (!Number.isSafeInteger(clause.amount) || clause.amount < 0) {
        return false;
      }
      if (
        !this.game.hasPlayer(clause.payerId) ||
        !this.game.hasPlayer(clause.receiverId)
      ) {
        return false;
      }
      const payer = this.game.player(clause.payerId);
      const receiver = this.game.player(clause.receiverId);
      const payerSide = this.sideIndex(war, payer.id());
      const receiverSide = this.sideIndex(war, receiver.id());
      return (
        payer.isAlive() &&
        receiver.isAlive() &&
        payerSide !== null &&
        receiverSide !== null &&
        payerSide !== receiverSide &&
        war.sides[receiverSide].score.total -
          war.sides[payerSide].score.total >=
          WAR_REPARATIONS_SCORE_THRESHOLD &&
        payer.gold() >= BigInt(clause.amount)
      );
    }
    if (clause.kind === "puppet") {
      if (
        !this.game.hasPlayer(clause.targetId) ||
        !this.game.hasPlayer(clause.overlordId)
      ) {
        return false;
      }
      const target = this.game.player(clause.targetId);
      const overlord = this.game.player(clause.overlordId);
      const targetSide = this.sideIndex(war, target.id());
      const overlordSide = this.sideIndex(war, overlord.id());
      return (
        target.isAlive() &&
        overlord.isAlive() &&
        targetSide !== null &&
        overlordSide !== null &&
        targetSide !== overlordSide &&
        war.sides[overlordSide].score.total -
          war.sides[targetSide].score.total >=
          WAR_PUPPET_SCORE_THRESHOLD &&
        !target.isSubject() &&
        target.subjects().length === 0 &&
        !overlord.isSubject() &&
        !target.isOnSameTeam(overlord)
      );
    }

    if (!this.game.hasPlayer(clause.subjectId)) return false;
    const subject = this.game.player(clause.subjectId);
    const overlord = subject.overlord();
    return (
      subject.isAlive() &&
      subject.isPuppet() &&
      overlord !== null &&
      overlord.isAlive() &&
      this.sideIndex(war, subject.id()) !== null &&
      this.sideIndex(war, subject.id()) === this.sideIndex(war, overlord.id())
    );
  }

  private botAcceptsClause(
    war: MutableWar,
    botID: PlayerID,
    clause: WarClause,
  ): boolean {
    if (!this.isValidClause(war, clause)) return false;
    const side = this.sideIndex(war, botID);
    if (side === null) return false;
    const ownScore = war.sides[side].score.total;
    const enemyScore = war.sides[side === 0 ? 1 : 0].score.total;
    if (clause.kind === "reparations") {
      const payerSide = this.sideIndex(war, clause.payerId);
      const receiverSide = this.sideIndex(war, clause.receiverId);
      if (side === payerSide) return ownScore < enemyScore;
      if (side === receiverSide) return ownScore >= enemyScore;
    }
    if (clause.kind === "puppet") {
      const targetSide = this.sideIndex(war, clause.targetId);
      const overlordSide = this.sideIndex(war, clause.overlordId);
      if (side === targetSide) return ownScore < enemyScore;
      if (side === overlordSide) return ownScore >= enemyScore;
    }
    if (clause.kind === "independence" && botID === clause.subjectId) {
      return true;
    }
    return ownScore <= enemyScore + 1_000;
  }

  private settleProposal(war: MutableWar): boolean {
    const proposal = war.proposal;
    if (
      proposal === undefined ||
      proposal.signatures.some(
        (signature) => signature.status !== "accepted",
      ) ||
      !this.isValidClause(war, proposal.clause)
    ) {
      this.cancelProposal(war, "peaceProposalInvalidated");
      return false;
    }

    const clause = proposal.clause;
    if (clause.kind === "reparations") {
      const payer = this.game.player(clause.payerId);
      const receiver = this.game.player(clause.receiverId);
      const amount = BigInt(clause.amount);
      if (payer.gold() < amount) {
        this.cancelProposal(war, "peaceProposalInvalidated");
        return false;
      }
      const removed = payer.removeGold(amount);
      if (removed !== amount) {
        if (removed > 0n) payer.addGold(removed);
        this.cancelProposal(war, "peaceProposalInvalidated");
        return false;
      }
      receiver.addGold(amount);
    } else if (clause.kind === "puppet") {
      if (
        !this.game
          .player(clause.targetId)
          .formPuppetFromPeace(this.game.player(clause.overlordId))
      ) {
        this.cancelProposal(war, "peaceProposalInvalidated");
        return false;
      }
    } else if (clause.kind === "independence") {
      const subject = this.game.player(clause.subjectId);
      const overlord = subject.overlord();
      if (overlord === null || !overlord.releaseSubject(subject)) {
        this.cancelProposal(war, "peaceProposalInvalidated");
        return false;
      }
    }

    const now = this.game.ticks();
    war.status = "truce";
    war.truceEndsAt = now + WAR_TRUCE_DURATION_TICKS;
    war.proposal = undefined;
    for (const call of war.calls) {
      if (call.status === "pending") {
        call.status = "cancelled";
        this.addEvent(war, "callCancelled", undefined, call.recipientID);
      }
    }
    this._peaceCooldownUntil.delete(war.id);
    this.addEvent(war, "peaceAccepted");
    this.addEvent(war, "truceBegan");
    return true;
  }

  private cancelProposal(
    war: MutableWar,
    reason: string,
    actorID?: PlayerID,
  ): void {
    if (war.proposal === undefined) return;
    war.proposal = undefined;
    if (war.status === "peacePending") war.status = "active";
    this._peaceCooldownUntil.set(
      war.id,
      this.game.ticks() + WAR_OFFER_COOLDOWN_TICKS,
    );
    this.addEvent(war, reason, actorID);
  }

  private removeDeadPeaceSigners(war: MutableWar): boolean {
    const proposal = war.proposal;
    if (proposal === undefined) return false;

    const deadSigners = proposal.signatures.filter(
      (signature) => !this.game.player(signature.playerID).isAlive(),
    );
    if (deadSigners.length === 0) return false;

    const deadIDs = new Set(deadSigners.map((signature) => signature.playerID));
    proposal.signatures = proposal.signatures.filter(
      (signature) => !deadIDs.has(signature.playerID),
    );
    for (const signature of deadSigners) {
      this.addEvent(war, "peaceSignerEliminated", signature.playerID);
    }
    return true;
  }

  private endWar(war: MutableWar, winningSide: 0 | 1): void {
    if (war.status === "ended") return;

    for (const call of war.calls
      .filter((offer) => offer.status === "pending")
      .sort((left, right) => left.id - right.id)) {
      call.status = "cancelled";
      this.addEvent(war, "callCancelled", call.inviterID, call.recipientID);
    }
    if (war.proposal !== undefined) {
      this.cancelProposal(war, "peaceProposalInvalidated");
    }
    war.status = "ended";
    const winnerID = war.sides[winningSide].participants.find(
      (participant) => participant.isAlive,
    )?.playerID;
    this.addEvent(war, "warEnded", winnerID);
  }

  private expireCall(war: MutableWar, call: WarCallSnapshot): void {
    call.status = "expired";
    this._callCooldownUntil.set(
      this.callKey(war.id, call.recipientID),
      this.game.ticks() + WAR_OFFER_COOLDOWN_TICKS,
    );
    this.addEvent(war, "callInvalidated", call.inviterID, call.recipientID);
    this.emit(war);
  }

  private callKey(warId: number, recipientID: PlayerID): string {
    return `${warId}:${recipientID}`;
  }

  private addEvent(
    war: MutableWar,
    kind: string,
    actorID?: PlayerID,
    targetID?: PlayerID,
  ): void {
    war.events.push({
      sequence: this._nextEventSequence++,
      tick: this.game.ticks(),
      kind,
      actorID,
      targetID,
    });
    if (war.events.length > MAX_RECENT_WAR_EVENTS) {
      war.events.splice(0, war.events.length - MAX_RECENT_WAR_EVENTS);
    }
  }

  private snapshot(war: MutableWar): WarSnapshot {
    const cloneSide = (side: MutableWarSide): WarSideSnapshot => ({
      participants: side.participants
        .map((participant) => ({ ...participant }))
        .sort((a, b) => a.playerID.localeCompare(b.playerID)),
      score: { ...side.score },
    });
    return {
      id: war.id,
      createdAt: war.createdAt,
      status: war.status,
      sides: [cloneSide(war.sides[0]), cloneSide(war.sides[1])],
      calls: war.calls.map((call) => ({ ...call })),
      ...(war.proposal === undefined
        ? {}
        : { proposal: structuredClone(war.proposal) }),
      ...(war.truceEndsAt === undefined
        ? {}
        : { truceEndsAt: war.truceEndsAt }),
      events: war.events.map((event) => ({ ...event })),
    };
  }

  private emit(war: MutableWar): void {
    this.game.addUpdate({
      type: GameUpdateType.War,
      war: this.snapshot(war),
    });
  }
}
