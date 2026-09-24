import { simpleHash } from "../Util";
import type { Game, Player, PlayerID, Tick } from "./Game";
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
}
interface MutableWar extends WarSnapshot {
  sides: [MutableWarSide, MutableWarSide];
  events: WarEventSnapshot[];
}

const MAX_RECENT_WAR_EVENTS = 20;

export class WarDiplomacy {
  private readonly _wars = new Map<number, MutableWar>();
  private _nextWarID = 1;
  private _nextEventSequence = 1;

  constructor(private readonly game: Game) {}

  canAttack(attacker: Player, target: Player): boolean {
    if (
      attacker === target ||
      !attacker.isAlive() ||
      !target.isAlive() ||
      this.hasBlockingRelation(attacker, target)
    ) {
      return false;
    }

    const existing = this.findWarBetween(attacker.id(), target.id());
    if (existing?.status === "truce") return false;
    if (existing !== undefined) return true;

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
    const war: MutableWar = {
      id,
      createdAt,
      status: "active",
      sides: [
        {
          participants: this.makeParticipants(
            attackingSide,
            attacker,
            target,
            "attacker",
            "defender",
            createdAt,
          ),
          score: this.emptyScore(),
        },
        {
          participants: this.makeParticipants(
            defendingSide,
            attacker,
            target,
            "attacker",
            "defender",
            createdAt,
          ),
          score: this.emptyScore(),
        },
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
          side.participants.some((participant) => participant.playerID === player.id()),
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
        .map((war) => this.snapshot(war)),
    };
    return simpleHash(JSON.stringify(normalized));
  }

  private emptyScore(): WarScoreSnapshot {
    return { territory: 0, militaryLosses: 0, structures: 0, total: 0 };
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
    const teamMembers = alive.filter(
      (player) => player === root || player.isOnSameTeam(root),
    );
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
      .map((player): MutableWarParticipant => ({
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
      }))
      .sort((a, b) => a.playerID.localeCompare(b.playerID));
  }

  private findWarBetween(a: PlayerID, b: PlayerID): MutableWar | undefined {
    return Array.from(this._wars.values())
      .sort((left, right) => left.id - right.id)
      .find((war) => {
        if (war.status === "ended") return false;
        return (
          this.hasParticipant(war.sides[0], a) &&
          this.hasParticipant(war.sides[1], b)
        ) || (
          this.hasParticipant(war.sides[0], b) &&
          this.hasParticipant(war.sides[1], a)
        );
      });
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
      ...(war.truceEndsAt === undefined ? {} : { truceEndsAt: war.truceEndsAt }),
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
