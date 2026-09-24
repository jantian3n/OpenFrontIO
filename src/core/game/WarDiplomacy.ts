import { simpleHash } from "../Util";
import {
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
  truceEndsAt?: Tick;
  events: WarEventSnapshot[];
}

interface MutableWarParticipant extends WarParticipantSnapshot {}
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
}

const MAX_RECENT_WAR_EVENTS = 20;

export class WarDiplomacy {
  private readonly _wars = new Map<number, MutableWar>();
  private readonly _dirtyWars = new Set<number>();
  private _nextWarID = 1;
  private _nextEventSequence = 1;

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

  tick(): void {
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
      if (changed) this.emit(war);
    }
  }

  hash(): number {
    const normalized = {
      nextWarID: this._nextWarID,
      nextEventSequence: this._nextEventSequence,
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
