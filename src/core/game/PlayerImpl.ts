import { PseudoRandom } from "../PseudoRandom";
import { ClientID } from "../Schemas";
import {
  assertNever,
  findClosestBy,
  minInt,
  simpleHash,
  toInt,
  within,
} from "../Util";
import { AttackImpl } from "./AttackImpl";
import {
  Alliance,
  AllianceInfo,
  AllianceRequest,
  AllPlayers,
  Attack,
  BuildableUnit,
  Cell,
  ColoredTeams,
  DisconnectSnapshot,
  Embargo,
  EmojiMessage,
  GameMode,
  GameType,
  Gold,
  MAX_UPGRADE_AMOUNT,
  MutableAlliance,
  Player,
  PlayerBuildable,
  PlayerBuildableUnitType,
  PlayerID,
  PlayerInfo,
  PlayerProfile,
  PlayerType,
  ProtectionCall,
  Relation,
  Structures,
  SubjectRelationInfo,
  SubjectRelationKind,
  SubjectRequest,
  SubjectRequestType,
  Team,
  TerraNullius,
  Tick,
  Unit,
  UnitParams,
  UnitType,
} from "./Game";
import { GameImpl } from "./GameImpl";
import { andFN, manhattanDistFN, TileRef } from "./GameMap";
import {
  ATTACK_DELTA_INCOMING,
  ATTACK_DELTA_OUTGOING,
  diffPlayerUpdate,
  packAttackTroopDeltas,
} from "./GameUpdateUtils";
import {
  AllianceView,
  AttackUpdate,
  GameUpdateType,
  PlayerUpdate,
} from "./GameUpdates";
import { SubjectRequestImpl } from "./SubjectRequestImpl";
import { ReadonlyTileSet, TileSet } from "./TileSet";
import {
  bumpTraversalGeneration,
  tileTraversalScratch,
} from "./TileTraversalScratch";
import {
  bestShoreDeploymentSource,
  canBuildTransportShip,
} from "./TransportShipUtils";
import { UnitImpl } from "./UnitImpl";

// Rot re-stamps every second, so a little slack keeps the cue from strobing.
const DECAY_CUE_GRACE_TICKS = 30;

interface Target {
  tick: Tick;
  target: Player;
}

class Donation {
  constructor(
    public readonly recipient: Player,
    public readonly tick: Tick,
  ) {}
}

class ProtectionCallRecord implements ProtectionCall {
  constructor(
    private readonly subject_: Player,
    private readonly attacker_: Player,
    private readonly createdAt_: Tick,
  ) {}

  subject(): Player {
    return this.subject_;
  }

  attacker(): Player {
    return this.attacker_;
  }

  createdAt(): Tick {
    return this.createdAt_;
  }
}

const SUBJECT_TRIBUTE_INTERVAL_TICKS = 300;
const SUBJECT_AUTONOMY_INTERVAL_TICKS = 600;
const SUBJECT_INDEPENDENCE_AUTONOMY = 80;
const SUBJECT_PROTECTION_OUTCOME_COOLDOWN_TICKS = 300;
// A state that starts a conflict cannot immediately turn the opponent's
// retaliation into a protection claim. Active attacks extend this implicitly.
const PROTECTION_AGGRESSION_MEMORY_TICKS = 600;

// Shared singletons for empty collections in toFullUpdate. Sharing
// references lets diffPlayerUpdate's `a === b` fast paths skip structural
// comparison and avoids per-player-per-tick allocations. The arrays are
// frozen so accidental in-worker mutation throws instead of silently
// corrupting every player's updates; updates crossing to the main thread
// are structured-cloned (clones are mutable). Sets cannot be frozen
// (Set.add ignores freeze) — EMPTY_EMBARGOES must never be mutated.
const EMPTY_NUMBER_ARRAY: number[] = [];
const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_ATTACK_UPDATES: AttackUpdate[] = [];
const EMPTY_ALLIANCE_VIEWS: AllianceView[] = [];
const EMPTY_EMOJIS: EmojiMessage[] = [];
const EMPTY_EMBARGOES = new Set<string>();
// Reusable buffers for hot loops. The simulation is single-threaded and these
// are fully consumed before any re-entrant call, so sharing is safe.
const NEIGHBOR_SCRATCH: TileRef[] = [0, 0, 0, 0];
const UNITS_SCRATCH: Unit[] = [];
const TYPE_SET_SCRATCH = new Set<UnitType>();
// N, S, W, E — the sampling directions used by shoreReachableNeighbors().
const SHORE_DIRECTIONS_DX = [0, 0, -1, 1];
const SHORE_DIRECTIONS_DY = [-1, 1, 0, 0];
Object.freeze(EMPTY_NUMBER_ARRAY);
Object.freeze(EMPTY_STRING_ARRAY);
Object.freeze(EMPTY_ATTACK_UPDATES);
Object.freeze(EMPTY_ALLIANCE_VIEWS);
Object.freeze(EMPTY_EMOJIS);

export class PlayerImpl implements Player {
  public _lastTileChange: number = 0;
  // Bumped on every ownership change of one of this player's tiles (several
  // can happen within one tick, so the tick alone is not a cache key).
  public _tileChangeVersion: number = 0;
  public _pseudo_random: PseudoRandom;

  private _gold: bigint;
  private _troops: bigint;

  /** Cumulative ship-trade revenue (arrival credit for src + dst port owners). */
  private _tradeGold: bigint = 0n;
  /** Cumulative train revenue: own trains + others' trains stopping at own stations. */
  private _trainGold: bigint = 0n;
  /** Cumulative piracy revenue: payouts for captured trade ships. */
  private _piracyGold: bigint = 0n;
  /** Cumulative gold received from all sources (incremented in addGold). */
  private _goldEarned: bigint = 0n;

  markedTraitorTick = -1;
  markedDoomsdayClockTick = -1;
  /** Tick territory rot last took land from this player (-1 = never). */
  private rottedAtTick = -1;
  private _betrayalCount: number = 0;

  private embargoes = new Map<PlayerID, Embargo>();

  public _borderTiles = new TileSet();

  public _units: Unit[] = [];
  /** Bumped on every change that can alter a per-type answer over _units: add, remove, ownership
   *  transfer, level-up, construction toggle (see UnitImpl). Keys the three memos below. */
  public _myUnitsVersion = 0;
  private readonly myUnitsMemo = new Map<
    UnitType,
    { version: number; list: Unit[] }
  >();
  private readonly myUnitCountMemo = new Map<
    UnitType,
    { version: number; count: number }
  >();
  private readonly myUnitsOwnedMemo = new Map<
    UnitType,
    { version: number; owned: number }
  >();
  public _tiles = new TileSet();

  public pastOutgoingAllianceRequests: AllianceRequest[] = [];
  private _expiredAlliances: Alliance[] = [];

  private targets_: Target[] = [];

  private outgoingEmojis_: EmojiMessage[] = [];
  private outgoingQuickChats_ = new Map<number, Tick>();

  private sentDonations: Donation[] = [];

  private relations = new Map<Player, number>();

  private _overlord: Player | null = null;
  private _subjects: Player[] = [];
  private _subjectInfo: SubjectRelationInfo | null = null;
  private _outgoingSubjectRequests: SubjectRequestImpl[] = [];
  private _lastSubjectRequestTick = new Map<PlayerID, Tick>();
  private _pendingProtectionCalls: ProtectionCallRecord[] = [];
  private _lastProtectionCallTick = new Map<string, Tick>();
  private _lastAggressionTick = new Map<PlayerID, Tick>();
  private _lastProtectionOutcomeTick: Tick = -1;
  private _subjectLastGoldEarned: Gold = 0n;
  private _lastSubjectEconomyTick: Tick = -1;
  private _lastSubjectAutonomyTick: Tick = -1;

  private lastDeleteUnitTick: Tick = -1;
  private lastEmbargoAllTick: Tick = -1;

  public _incomingAttacks: Attack[] = [];
  public _outgoingAttacks: Attack[] = [];
  public _outgoingLandAttacks: Attack[] = [];

  public _alliances: MutableAlliance[] = [];

  private _spawnTile: TileRef | undefined;
  private _isDisconnected = false;
  private _disconnectSnapshot: DisconnectSnapshot | null = null;

  /**
   * Last PlayerUpdate emitted for this player on the worker→main channel.
   * Used by GameImpl's tick loop to compute field-level diffs. Undefined on
   * first emission (full snapshot sent).
   */
  public lastSentUpdate: PlayerUpdate | undefined;

  constructor(
    private mg: GameImpl,
    private _smallID: number,
    private readonly playerInfo: PlayerInfo,
    startTroops: number,
    private readonly _team: Team | null,
  ) {
    this._troops = toInt(startTroops);
    this._gold = mg.config().startingGold(playerInfo);
    this._pseudo_random = new PseudoRandom(simpleHash(this.playerInfo.id));
  }

  largestClusterBoundingBox: { min: Cell; max: Cell } | null;

  /**
   * Build a PlayerUpdate for the worker→main wire.
   *
   * The first call for a player returns the full snapshot. Subsequent calls
   * return only fields that changed since the previous call (a partial
   * `{ type, id, ...changedFields }`), or `null` if nothing changed.
   *
   * tilesOwned / gold / troops / goldEarned are excluded from partial
   * updates (they churn for nearly every alive player every tick): when any
   * of them changed, a `[smallID, tilesOwned, gold, troops, goldEarned]`
   * quint is pushed to `statsOut` instead, which GameImpl drains into the
   * transferable `packedPlayerUpdates` buffer. Attack troop counts likewise
   * go to `attackTroopsOut` as `[smallID, direction, index, troops]` quads
   * (→ `packedAttackUpdates`) instead of re-sending whole attack arrays.
   *
   * `lastSentUpdate` is updated to the full snapshot on every call.
   */
  toUpdate(
    statsOut?: number[],
    attackTroopsOut?: number[],
  ): PlayerUpdate | null {
    const full = this.toFullUpdate();
    const prev = this.lastSentUpdate;
    this.lastSentUpdate = full;
    if (prev === undefined) return full;
    if (
      statsOut !== undefined &&
      (prev.tilesOwned !== full.tilesOwned ||
        prev.gold !== full.gold ||
        prev.troops !== full.troops ||
        prev.goldEarned !== full.goldEarned)
    ) {
      // goldEarned gets its own comparison: it can change even when gold
      // nets back to its previous value within one tick (addGold followed
      // by removeGold), and the quint must still flush then.
      statsOut.push(
        full.smallID!,
        full.tilesOwned!,
        Number(full.gold),
        full.troops!,
        Number(full.goldEarned),
      );
    }
    if (attackTroopsOut !== undefined) {
      packAttackTroopDeltas(
        prev.outgoingAttacks,
        full.outgoingAttacks,
        full.smallID!,
        ATTACK_DELTA_OUTGOING,
        attackTroopsOut,
      );
      packAttackTroopDeltas(
        prev.incomingAttacks,
        full.incomingAttacks,
        full.smallID!,
        ATTACK_DELTA_INCOMING,
        attackTroopsOut,
      );
    }
    return diffPlayerUpdate(prev, full);
  }

  private toFullUpdate(): PlayerUpdate {
    // Empty collections reuse shared singletons (EMPTY_*) so
    // diffPlayerUpdate's reference fast paths hit and nothing is allocated.
    // This runs for every player every tick; most collections are empty for
    // most players. The singletons are never mutated — updates are
    // structured-cloned before leaving the worker.
    let outgoingAllianceRequests = EMPTY_STRING_ARRAY;
    for (const ar of this.mg.allianceRequests) {
      if (ar.requestor() === this) {
        if (outgoingAllianceRequests === EMPTY_STRING_ARRAY) {
          outgoingAllianceRequests = [];
        }
        outgoingAllianceRequests.push(ar.recipient().id());
      }
    }

    const alliances = this.alliances();
    let allies = EMPTY_NUMBER_ARRAY;
    let allianceViews = EMPTY_ALLIANCE_VIEWS;
    if (alliances.length > 0) {
      allies = alliances.map((a) => a.other(this).smallID());
      const extensionCutoff =
        this.mg.ticks() + this.mg.config().allianceExtensionPromptOffset();
      allianceViews = alliances.map(
        (a) =>
          ({
            id: a.id(),
            other: a.other(this).id(),
            createdAt: a.createdAt(),
            expiresAt: a.expiresAt(),
            hasExtensionRequest: a.expiresAt() <= extensionCutoff,
          }) satisfies AllianceView,
      );
    }

    let embargoes = EMPTY_EMBARGOES;
    if (this.embargoes.size > 0) {
      embargoes = new Set<string>();
      for (const id of this.embargoes.keys()) {
        embargoes.add(id.toString());
      }
    }

    let targets = EMPTY_NUMBER_ARRAY;
    if (this.targets_.length > 0) {
      const t = this.targets();
      if (t.length > 0) {
        targets = t.map((p) => p.smallID());
      }
    }

    let outgoingEmojis = EMPTY_EMOJIS;
    if (this.outgoingEmojis_.length > 0) {
      const e = this.outgoingEmojis();
      if (e.length > 0) {
        outgoingEmojis = e;
      }
    }

    const outgoingAttacks =
      this._outgoingAttacks.length === 0
        ? EMPTY_ATTACK_UPDATES
        : this._outgoingAttacks.map((a) => {
            return {
              attackerID: a.attacker().smallID(),
              targetID: a.target().smallID(),
              troops: a.troops(),
              id: a.id(),
              retreating: a.retreating(),
            } satisfies AttackUpdate;
          });

    let incomingAttacks = EMPTY_ATTACK_UPDATES;
    if (this._incomingAttacks.length > 0) {
      const incoming = this.incomingAttacks();
      if (incoming.length > 0) {
        incomingAttacks = incoming.map((a) => {
          return {
            attackerID: a.attacker().smallID(),
            targetID: a.target().smallID(),
            troops: a.troops(),
            id: a.id(),
            retreating: a.retreating(),
          } satisfies AttackUpdate;
        });
      }
    }

    // OFM live standings: elimination info is stored on the player's stats
    // (set live in the sim via mg.stats()), surfaced here so it rides the live
    // PlayerUpdate every tick rather than only appearing in the game-end record.
    const deathStats = this.mg.stats().getPlayerStats(this);

    return {
      type: GameUpdateType.Player,
      clientID: this.clientID(),
      name: this.name(),
      displayName: this.displayName(),
      clanTag: this.clanTag(),
      nationFlag: this.nationFlag(),
      id: this.id(),
      team: this.team() ?? undefined,
      smallID: this.smallID(),
      playerType: this.type(),
      isAlive: this.isAlive(),
      isDisconnected: this.isDisconnected(),
      killedBy: deathStats?.killedBy ?? null,
      deathPosition: deathStats?.deathPosition ?? null,
      tilesOwned: this.numTilesOwned(),
      gold: this._gold,
      tradeGold: this._tradeGold,
      trainGold: this._trainGold,
      piracyGold: this._piracyGold,
      goldEarned: this._goldEarned,
      troops: this.troops(),
      allies: allies,
      overlord: this._overlord?.smallID() ?? null,
      subjects:
        this._subjects.length === 0
          ? EMPTY_NUMBER_ARRAY
          : this._subjects.map((p) => p.smallID()),
      subjectKind: this._subjectInfo?.kind ?? null,
      subjectOrigin: this._subjectInfo?.origin ?? null,
      subjectCreatedAt: this._subjectInfo?.createdAt ?? null,
      autonomy: this._subjectInfo?.autonomy ?? null,
      tributeRate: this._subjectInfo?.tributeRate ?? null,
      outgoingSubjectRequests: this.outgoingSubjectRequests().map((request) => ({
        recipientID: request.recipient().id(),
        requestType: request.requestType(),
        createdAt: request.createdAt(),
      })),
      embargoes: embargoes,
      isTraitor: this.isTraitor(),
      traitorRemainingTicks: this.getTraitorRemainingTicks(),
      inDoomsdayClock: this.inDoomsdayClock(),
      isDecaying: this.isDecaying(),
      markedDoomsdayClockTick: this.markedDoomsdayClockTick,
      targets: targets,
      outgoingEmojis: outgoingEmojis,
      outgoingAttacks: outgoingAttacks,
      incomingAttacks: incomingAttacks,
      outgoingAllianceRequests: outgoingAllianceRequests,
      alliances: allianceViews,
      hasSpawned: this.hasSpawned(),
      spawnTile: this._spawnTile,
      betrayals: this._betrayalCount,
      lastDeleteUnitTick: this.lastDeleteUnitTick,
      isLobbyCreator: this.isLobbyCreator(),
    };
  }

  smallID(): number {
    return this._smallID;
  }

  name(): string {
    return this.playerInfo.name;
  }
  displayName(): string {
    return this.playerInfo.displayName;
  }
  clanTag(): string | null {
    return this.playerInfo.clanTag;
  }
  nationFlag(): string | null {
    return this.playerInfo.nationFlag;
  }
  clientID(): ClientID | null {
    return this.playerInfo.clientID;
  }

  id(): PlayerID {
    return this.playerInfo.id;
  }

  type(): PlayerType {
    return this.playerInfo.playerType;
  }

  units(): Unit[];
  units(types: readonly UnitType[]): Unit[];
  units(type: UnitType, type2?: UnitType, type3?: UnitType): Unit[];
  units(
    first?: UnitType | readonly UnitType[],
    second?: UnitType,
    third?: UnitType,
  ): Unit[] {
    if (first === undefined) {
      return this._units;
    }

    // Hot path. Matches are gathered into a reusable scratch buffer and
    // copied out with an exact-size slice, so each call allocates exactly
    // one right-sized result array. Fixed-arity parameters (rather than a
    // rest parameter) avoid allocating an argument array per call.
    const scratch = UNITS_SCRATCH;
    let n = 0;

    if (Array.isArray(first)) {
      const types = first as readonly UnitType[];
      if (types.length === 0) {
        return this._units;
      }
      const ts = TYPE_SET_SCRATCH;
      ts.clear();
      for (const t of types) {
        ts.add(t);
      }
      for (const u of this._units) {
        if (ts.has(u.type())) scratch[n++] = u;
      }
    } else if (second === undefined) {
      // Single-type queries repeat heavily (warship heal, nation ship tracking,
      // troop caps): memoised on the per-player units version; hits hand out a copy.
      const memo = this.myUnitsMemo.get(first as UnitType);
      if (memo !== undefined && memo.version === this._myUnitsVersion) {
        return memo.list.slice();
      }
      for (const u of this._units) {
        if (u.type() === first) scratch[n++] = u;
      }
      const list = scratch.slice(0, n);
      this.myUnitsMemo.set(first as UnitType, {
        version: this._myUnitsVersion,
        list,
      });
      return list.slice();
    } else if (third === undefined) {
      for (const u of this._units) {
        const t = u.type();
        if (t === first || t === second) scratch[n++] = u;
      }
    } else {
      for (const u of this._units) {
        const t = u.type();
        if (t === first || t === second || t === third) scratch[n++] = u;
      }
    }
    return scratch.slice(0, n);
  }

  private numUnitsConstructed: Partial<Record<UnitType, number>> = {};
  private recordUnitConstructed(type: UnitType): void {
    if (this.numUnitsConstructed[type] !== undefined) {
      this.numUnitsConstructed[type]++;
    } else {
      this.numUnitsConstructed[type] = 1;
    }
  }

  // Count of units built by the player, including those still under
  // construction. recordUnitConstructed() is called in buildUnit() the moment a
  // unit is created (while still under construction), so numUnitsConstructed
  // already accounts for in-progress builds — don't re-count them.
  unitsConstructed(type: UnitType): number {
    return this.numUnitsConstructed[type] ?? 0;
  }

  // Count of units owned by the player, not including construction
  unitCount(type: UnitType): number {
    // Every train station asked for the owner's factory count every tick — a walk
    // over the whole unit list per station (~2 % of a long headless game).
    const memo = this.myUnitCountMemo.get(type);
    if (memo !== undefined && memo.version === this._myUnitsVersion) {
      return memo.count;
    }
    let total = 0;
    for (const unit of this._units) {
      if (unit.type() === type) {
        total += unit.level();
      }
    }
    this.myUnitCountMemo.set(type, {
      version: this._myUnitsVersion,
      count: total,
    });
    return total;
  }

  // Count of units owned by the player, including construction
  unitsOwned(type: UnitType): number {
    const memo = this.myUnitsOwnedMemo.get(type);
    if (memo !== undefined && memo.version === this._myUnitsVersion) {
      return memo.owned;
    }
    let total = 0;
    for (const unit of this._units) {
      if (unit.type() === type) {
        if (unit.isUnderConstruction()) {
          total++;
        } else {
          total += unit.level();
        }
      }
    }
    this.myUnitsOwnedMemo.set(type, {
      version: this._myUnitsVersion,
      owned: total,
    });
    return total;
  }

  sharesBorderWith(other: Player | TerraNullius): boolean {
    const map = this.mg.map();
    const otherID = other.smallID();
    const nbuf = NEIGHBOR_SCRATCH;
    for (const border of this._borderTiles) {
      const n = map.neighbors4(border, nbuf);
      for (let i = 0; i < n; i++) {
        if (map.ownerID(nbuf[i]) === otherID) {
          return true;
        }
      }
    }
    return false;
  }

  numTilesOwned(): number {
    return this._tiles.size;
  }

  tiles(): ReadonlyTileSet {
    return this._tiles;
  }

  borderTiles(): ReadonlyTileSet {
    return this._borderTiles;
  }

  private nearbyMemo: {
    version: number;
    waterVersion: number;
    result: (Player | TerraNullius)[];
  } | null = null;

  nearby(): (Player | TerraNullius)[] {
    // Nation AI asks several times per tick (maybeAttack, attackBestTarget,
    // attackBots, ...) with no map change in between; the answer depends on
    // tile ownership and fallout (covered by territoryVersion) and on the
    // land/water/shoreline terrain. Live nuke floods mutate the latter through
    // WaterManager on the raw GameMap — bypassing GameImpl's bump — so the
    // map's waterVersion() is a second key, which every conversion advances.
    const version = this.mg.territoryVersion();
    const waterVersion = this.mg.map().waterVersion();
    if (
      this.nearbyMemo !== null &&
      this.nearbyMemo.version === version &&
      this.nearbyMemo.waterVersion === waterVersion
    ) {
      return this.nearbyMemo.result.slice();
    }
    const result = this.computeNearby();
    this.nearbyMemo = { version, waterVersion, result };
    return result.slice();
  }

  private computeNearby(): (Player | TerraNullius)[] {
    const ns: Set<Player | TerraNullius> = new Set();
    const map = this.mg.map();
    const smallID = this.smallID();
    const visit = (neighbor: TileRef) => {
      if (map.isLand(neighbor) && !map.isImpassable(neighbor)) {
        if (!map.hasOwner(neighbor) && map.hasFallout(neighbor)) {
          return;
        }
        const owner = map.ownerID(neighbor);
        if (owner !== smallID) {
          ns.add(
            this.mg.playerBySmallID(owner) satisfies Player | TerraNullius,
          );
        }
      }
    };
    for (const border of this.borderTiles()) {
      map.forEachNeighbor(border, visit);
    }
    for (const n of this.shoreReachableNeighbors()) {
      ns.add(n);
    }
    return Array.from(ns);
  }

  // Samples every 10th border tile for shore tiles, checks the tile 5 steps
  // away in each cardinal direction that immediately enters water, to detect
  // players separated by a small river (up to 4 water tiles wide)
  private shoreReachableNeighbors(): Set<Player | TerraNullius> {
    const ns: Set<Player | TerraNullius> = new Set();
    const map = this.mg.map();

    let shoreIdx = 0;
    for (const border of this.borderTiles()) {
      if (!map.isShore(border)) continue;
      // Visit every 10th shore tile.
      if (shoreIdx++ % 10 !== 0) continue;

      const bx = map.x(border);
      const by = map.y(border);

      for (let d = 0; d < 4; d++) {
        const dx = SHORE_DIRECTIONS_DX[d];
        const dy = SHORE_DIRECTIONS_DY[d];
        // Only follow directions that immediately enter water; land-adjacent
        // directions are already covered by the direct neighbors() loop.
        const x1 = bx + dx;
        const y1 = by + dy;
        if (!map.isValidCoord(x1, y1) || !map.isWater(map.ref(x1, y1)))
          continue;

        const nx = bx + dx * 5;
        const ny = by + dy * 5;
        if (!map.isValidCoord(nx, ny)) continue;
        const tile = map.ref(nx, ny);
        if (!map.isLand(tile)) continue;
        if (map.isImpassable(tile)) continue;
        if (!map.hasOwner(tile) && map.hasFallout(tile)) continue;
        const owner = map.ownerID(tile);
        if (owner !== this.smallID()) {
          ns.add(
            this.mg.playerBySmallID(owner) satisfies Player | TerraNullius,
          );
        }
      }
    }

    return ns;
  }

  isPlayer(): this is Player {
    return true as const;
  }
  setTroops(troops: number) {
    this._troops = toInt(troops);
  }
  conquer(tile: TileRef) {
    this.mg.conquer(this, tile);
  }
  orderRetreat(id: string) {
    const attack = this._outgoingAttacks.find((attack) => attack.id() === id);
    if (!attack) {
      console.warn(`Didn't find outgoing attack with id ${id}`);
      return;
    }
    attack.orderRetreat();
  }
  executeRetreat(id: string): void {
    const attack = this._outgoingAttacks.find((attack) => attack.id() === id);
    // Execution is delayed so it's not an error that the attack does not exist.
    if (!attack) {
      return;
    }
    attack.executeRetreat();
  }
  relinquish(tile: TileRef) {
    if (this.mg.owner(tile) !== this) {
      throw new Error(`Cannot relinquish tile not owned by this player`);
    }
    this.mg.relinquish(tile);
  }
  info(): PlayerInfo {
    return this.playerInfo;
  }

  isLobbyCreator(): boolean {
    return this.playerInfo.isLobbyCreator;
  }

  isAlive(): boolean {
    return this._tiles.size > 0;
  }

  hasSpawned(): boolean {
    return this._spawnTile !== undefined;
  }

  setSpawnTile(spawnTile: TileRef): void {
    this._spawnTile = spawnTile;
  }

  spawnTile(): TileRef | undefined {
    return this._spawnTile;
  }

  incomingAllianceRequests(): AllianceRequest[] {
    return this.mg.allianceRequests.filter((ar) => ar.recipient() === this);
  }

  outgoingAllianceRequests(): AllianceRequest[] {
    return this.mg.allianceRequests.filter((ar) => ar.requestor() === this);
  }

  alliances(): MutableAlliance[] {
    return this._alliances;
  }

  expiredAlliances(): Alliance[] {
    return [...this._expiredAlliances];
  }

  allies(): Player[] {
    return this.alliances().map((a) => a.other(this));
  }

  isAlliedWith(other: Player): boolean {
    if (other === this) {
      return false;
    }
    return this.allianceWith(other) !== null;
  }

  allianceWith(other: Player): MutableAlliance | null {
    if (other === this) {
      return null;
    }
    return (
      this.alliances().find(
        (a) => a.recipient() === other || a.requestor() === other,
      ) ?? null
    );
  }

  allianceInfo(other: Player): AllianceInfo | null {
    const alliance = this.allianceWith(other);
    if (!alliance) {
      return null;
    }
    const inExtensionWindow =
      alliance.expiresAt() <=
      this.mg.ticks() + this.mg.config().allianceExtensionPromptOffset();
    const canExtend =
      !this.isDisconnected() &&
      !other.isDisconnected() &&
      this.isAlive() &&
      other.isAlive() &&
      inExtensionWindow &&
      !alliance.agreedToExtend(this);
    return {
      expiresAt: alliance.expiresAt(),
      inExtensionWindow,
      myPlayerAgreedToExtend: alliance.agreedToExtend(this),
      otherAgreedToExtend: alliance.agreedToExtend(other),
      canExtend,
    };
  }

  canSendAllianceRequest(other: Player): boolean {
    if (this.mg.config().disableAlliances()) {
      return false;
    }
    if (this.isPuppet() || other.isPuppet()) {
      return false;
    }
    if (other === this) {
      return false;
    }
    if (this.isDisconnected() || other.isDisconnected()) {
      // Disconnected players are marked as not-friendly even if they are allies,
      // so we need to return early if either player is disconnected.
      // Otherwise we could end up sending an alliance request to someone
      // we are already allied with.
      return false;
    }
    if (this.isFriendly(other) || !this.isAlive()) {
      return false;
    }

    const hasPending = this.outgoingAllianceRequests().some(
      (ar) => ar.recipient() === other,
    );

    if (hasPending) {
      return false;
    }

    const hasIncoming = this.incomingAllianceRequests().some(
      (ar) => ar.requestor() === other,
    );

    if (hasIncoming) {
      return true;
    }

    const recent = this.pastOutgoingAllianceRequests
      .filter((ar) => ar.recipient() === other)
      .sort((a, b) => b.createdAt() - a.createdAt());

    if (recent.length === 0) {
      return true;
    }

    const delta = this.mg.ticks() - recent[0].createdAt();

    return delta >= this.mg.config().allianceRequestCooldown();
  }

  breakAlliance(alliance: MutableAlliance): void {
    this.mg.breakAlliance(this, alliance);
  }

  removeAllAlliances(): void {
    this.mg.removeAlliancesByPlayerSilently(this);
  }

  isTraitor(): boolean {
    return this.getTraitorRemainingTicks() > 0;
  }

  getTraitorRemainingTicks(): number {
    if (this.markedTraitorTick < 0) return 0;
    const elapsed = this.mg.ticks() - this.markedTraitorTick;
    const duration = this.mg.config().traitorDuration();
    const remaining = duration - elapsed;
    return remaining > 0 ? remaining : 0;
  }

  markTraitor(): void {
    this.markedTraitorTick = this.mg.ticks();
    this._betrayalCount++; // Keep count for Nations too

    // Record stats (only for real Humans)
    this.mg.stats().betray(this);
  }

  // A dead player is never "in doomsday clock": nothing clears the mark on death
  // (the execution only processes alive contenders), so gate on isAlive() to
  // avoid a stuck skull/panel and per-tick update churn for eliminated players.
  inDoomsdayClock(): boolean {
    return this.isAlive() && this.markedDoomsdayClockTick >= 0;
  }

  // Ticks spent continuously below the doomsday-clock bar (0 when not marked or dead).
  doomsdayClockTicks(): number {
    return this.inDoomsdayClock()
      ? this.mg.ticks() - this.markedDoomsdayClockTick
      : 0;
  }

  enterDoomsdayClock(): void {
    if (this.markedDoomsdayClockTick < 0) {
      this.markedDoomsdayClockTick = this.mg.ticks();
    }
  }

  clearDoomsdayClock(): void {
    this.markedDoomsdayClockTick = -1;
    this.rottedAtTick = -1;
  }

  markRotted(): void {
    this.rottedAtTick = this.mg.ticks();
  }

  // Territory actively rotting. Stamped by the execution rather than derived from
  // troops vs the floor: that is a knife-edge equality (the drain lands exactly ON
  // the floor) and the floor moves as rot shrinks the cap, so a client-side copy
  // flickers.
  isDecaying(): boolean {
    if (!this.inDoomsdayClock() || this.rottedAtTick < 0) return false;
    return this.mg.ticks() - this.rottedAtTick <= DECAY_CUE_GRACE_TICKS;
  }

  betrayals(): number {
    return this._betrayalCount;
  }

  overlord(): Player | null {
    return this._overlord;
  }

  subjects(): Player[] {
    return [...this._subjects];
  }

  subjectInfo(): SubjectRelationInfo | null {
    return this._subjectInfo === null ? null : { ...this._subjectInfo };
  }

  isSubject(): boolean {
    return this._overlord !== null;
  }

  isProtectorate(): boolean {
    return (
      this._overlord !== null &&
      this._subjectInfo?.kind === SubjectRelationKind.Protectorate
    );
  }

  isPuppet(): boolean {
    return (
      this._overlord !== null &&
      this._subjectInfo?.kind === SubjectRelationKind.Puppet
    );
  }

  isSubjectOf(other: Player): boolean {
    return this._overlord === other;
  }

  isPuppetOf(other: Player): boolean {
    return this.isPuppet() && this._overlord === other;
  }

  isOverlordOf(other: Player): boolean {
    return this._subjects.includes(other);
  }

  isInSubjectRelation(other: Player): boolean {
    return this.isSubjectOf(other) || this.isOverlordOf(other);
  }

  isInPuppetRelation(other: Player): boolean {
    return (
      this.isPuppetOf(other) ||
      (this.isOverlordOf(other) && other.isPuppetOf(this))
    );
  }

  private pruneExpiredSubjectRequests(): void {
    const duration = this.mg.config().allianceRequestDuration();
    this._outgoingSubjectRequests = this._outgoingSubjectRequests.filter(
      (request) => this.mg.ticks() - request.createdAt() < duration,
    );
  }

  outgoingSubjectRequests(): SubjectRequest[] {
    this.pruneExpiredSubjectRequests();
    return [...this._outgoingSubjectRequests];
  }

  incomingSubjectRequests(): SubjectRequest[] {
    return this.mg
      .players()
      .flatMap((player) => player.outgoingSubjectRequests())
      .filter((request) => request.recipient() === this);
  }

  isRequestingSubjectRelation(
    other: Player,
    requestType?: SubjectRequestType,
  ): boolean {
    return this._outgoingSubjectRequests.some(
      (request) =>
        request.recipient() === other &&
        (requestType === undefined || request.requestType() === requestType),
    );
  }

  private hasPendingSubjectRequestWith(other: Player): boolean {
    return (
      this.isRequestingSubjectRelation(other) ||
      other.isRequestingSubjectRelation(this)
    );
  }

  private isActivelyFighting(other: Player): boolean {
    const attacks = (attacker: Player, target: Player) =>
      attacker
        .outgoingAttacks()
        .some(
          (attack) =>
            attack.isActive() &&
            attack.target().isPlayer() &&
            attack.target() === target,
        );
    return attacks(this, other) || attacks(other, this);
  }

  private isMeaningfullyWeakerThan(other: Player): boolean {
    const substantiallyLower = (mine: number, theirs: number) =>
      theirs > 0 && mine < theirs && mine * 100 <= theirs * 70;

    let weakerIndicators = 0;
    if (substantiallyLower(this.troops(), other.troops())) {
      weakerIndicators++;
    }
    if (
      substantiallyLower(
        this.mg.config().maxTroops(this),
        this.mg.config().maxTroops(other),
      )
    ) {
      weakerIndicators++;
    }
    if (substantiallyLower(this.numTilesOwned(), other.numTilesOwned())) {
      weakerIndicators++;
    }
    return weakerIndicators >= 2;
  }

  private canFormSubjectRelation(
    subject: Player,
    overlord: Player,
    requirePeace: boolean,
  ): boolean {
    if (subject === overlord || !subject.isAlive() || !overlord.isAlive()) {
      return false;
    }
    if (subject.isDisconnected() || overlord.isDisconnected()) return false;
    if (subject.isSubject() || subject.subjects().length > 0) return false;
    if (overlord.isSubject()) return false;
    if (
      requirePeace &&
      (subject as PlayerImpl).isActivelyFighting(overlord)
    ) {
      return false;
    }
    return (subject as PlayerImpl).isMeaningfullyWeakerThan(overlord);
  }

  private subjectRequestCooldownPassed(other: Player): boolean {
    const last = this._lastSubjectRequestTick.get(other.id());
    return (
      last === undefined ||
      this.mg.ticks() - last >= this.mg.config().allianceRequestCooldown()
    );
  }

  canRequestProtection(other: Player): boolean {
    if (!this.canFormSubjectRelation(this, other, true)) return false;
    if (!this.subjectRequestCooldownPassed(other)) return false;
    return !this.hasPendingSubjectRequestWith(other);
  }

  canDemandSubjugation(other: Player): boolean {
    if (!this.canFormSubjectRelation(other, this, false)) return false;
    if (!this.subjectRequestCooldownPassed(other)) return false;
    return !this.hasPendingSubjectRequestWith(other);
  }

  private createSubjectRequest(
    other: Player,
    requestType: SubjectRequestType,
  ): boolean {
    const allowed =
      requestType === "protection"
        ? this.canRequestProtection(other)
        : this.canDemandSubjugation(other);
    if (!allowed) return false;

    const request = new SubjectRequestImpl(
      this,
      other,
      requestType,
      this.mg.ticks(),
    );
    this._outgoingSubjectRequests.push(request);
    this._lastSubjectRequestTick.set(other.id(), this.mg.ticks());
    this.mg.addUpdate(request.toUpdate());
    return true;
  }

  requestProtection(other: Player): boolean {
    return this.createSubjectRequest(other, "protection");
  }

  demandSubjugation(other: Player): boolean {
    return this.createSubjectRequest(other, "subjugation");
  }

  private findOutgoingSubjectRequest(
    recipient: Player,
    requestType: SubjectRequestType,
  ): SubjectRequestImpl | undefined {
    return this._outgoingSubjectRequests.find(
      (request) =>
        request.recipient() === recipient &&
        request.requestType() === requestType,
    );
  }

  private clearSubjectRequestsInvolving(...players: Player[]): void {
    const affected = new Set(players);
    for (const player of this.mg.players()) {
      const impl = player as PlayerImpl;
      impl._outgoingSubjectRequests = impl._outgoingSubjectRequests.filter(
        (request) =>
          !affected.has(request.requestor()) &&
          !affected.has(request.recipient()),
      );
    }
  }

  private cancelDirectNukesBetween(a: Player, b: Player): void {
    const nukeTypes = [
      UnitType.AtomBomb,
      UnitType.HydrogenBomb,
      UnitType.MIRV,
      UnitType.MIRVWarhead,
    ];

    for (const launcher of [a, b]) {
      const other = launcher === a ? b : a;
      for (const unit of launcher.units(nukeTypes)) {
        if (!unit.isActive() || unit.reachedTarget()) continue;

        const targetTile = unit.targetTile();
        const directTarget =
          unit.type() === UnitType.MIRV
            ? (unit.targetPlayer() ??
              (targetTile !== undefined ? this.mg.owner(targetTile) : null))
            : targetTile !== undefined
              ? this.mg.owner(targetTile)
              : null;

        if (directTarget === other) {
          unit.delete(false);
        }
      }
    }
  }

  acceptSubjectRequest(
    requestor: Player,
    requestType: SubjectRequestType,
  ): boolean {
    const request = (requestor as PlayerImpl).findOutgoingSubjectRequest(
      this,
      requestType,
    );
    if (request === undefined) return false;

    const subject = (
      requestType === "protection" ? requestor : this
    ) as PlayerImpl;
    const overlord = (
      requestType === "protection" ? this : requestor
    ) as PlayerImpl;

    if (
      !this.canFormSubjectRelation(
        subject,
        overlord,
        requestType === "protection",
      )
    ) {
      return false;
    }

    const directAlliance = subject.allianceWith(overlord);
    if (directAlliance !== null) {
      this.mg.removeAllianceSilently(directAlliance);
    }

    subject._overlord = overlord;
    subject._subjectLastGoldEarned = subject._goldEarned;
    subject._lastSubjectEconomyTick = this.mg.ticks();
    subject._lastSubjectAutonomyTick = this.mg.ticks();
    subject._lastProtectionOutcomeTick = -1;
    subject._subjectInfo =
      requestType === "protection"
        ? {
            kind: SubjectRelationKind.Protectorate,
            origin: "protection",
            createdAt: this.mg.ticks(),
            autonomy: 60,
            tributeRate: 10,
          }
        : {
            kind: SubjectRelationKind.Puppet,
            origin: "subjugation",
            createdAt: this.mg.ticks(),
            autonomy: 40,
            tributeRate: 20,
          };

    if (!overlord._subjects.includes(subject)) {
      overlord._subjects.push(subject);
    }

    // Existing conventional attacks retreat as soon as isFriendly() changes;
    // strategic weapons need explicit neutralization because they keep flying.
    this.cancelDirectNukesBetween(subject, overlord);

    if (subject._subjectInfo.kind === SubjectRelationKind.Puppet) {
      // Puppets do not conduct an independent alliance policy. Any existing
      // third-party alliances end when the puppet relationship is formed,
      // and pending requests are rejected.
      subject.removeAllAlliances();
      this.mg.rejectAllianceRequestsInvolving(subject);
    }

    this.clearSubjectRequestsInvolving(subject, overlord);
    this.mg.addUpdate({
      type: GameUpdateType.SubjectRequestReply,
      request: request.toUpdate(),
      accepted: true,
    });

    // If protection is granted while the applicant is already under attack,
    // the guarantee applies immediately to those existing defensive wars.
    if (requestType === "protection") {
      const currentAttackers = new Set<Player>();
      for (const attack of subject.incomingAttacks()) {
        if (!attack.isActive()) continue;
        const attacker = attack.attacker();
        if (attacker !== overlord) currentAttackers.add(attacker);
      }
      for (const attacker of currentAttackers) {
        subject.raiseProtectionCall(attacker);
      }
    }

    return true;
  }

  rejectSubjectRequest(
    requestor: Player,
    requestType: SubjectRequestType,
  ): boolean {
    const requestorImpl = requestor as PlayerImpl;
    const request = requestorImpl.findOutgoingSubjectRequest(
      this,
      requestType,
    );
    if (request === undefined) return false;

    requestorImpl._outgoingSubjectRequests =
      requestorImpl._outgoingSubjectRequests.filter((r) => r !== request);
    this.mg.addUpdate({
      type: GameUpdateType.SubjectRequestReply,
      request: request.toUpdate(),
      accepted: false,
    });
    return true;
  }

  private cancelProtectionCallsForSubject(subject: Player): void {
    const remaining: ProtectionCallRecord[] = [];

    for (const call of this._pendingProtectionCalls) {
      if (call.subject() !== subject) {
        remaining.push(call);
        continue;
      }

      this.mg.addUpdate({
        type: GameUpdateType.ProtectionCallReply,
        call: {
          type: GameUpdateType.ProtectionCall,
          overlordID: this.smallID(),
          subjectID: subject.smallID(),
          attackerID: call.attacker().smallID(),
          createdAt: call.createdAt(),
        },
        intervened: false,
        cancelled: true,
      });
    }

    this._pendingProtectionCalls = remaining;
  }

  releaseSubject(subject: Player): boolean {
    if (!this.isOverlordOf(subject)) return false;
    this.cancelProtectionCallsForSubject(subject);
    this._subjects = this._subjects.filter((p) => p !== subject);
    const subjectImpl = subject as PlayerImpl;
    subjectImpl._overlord = null;
    subjectImpl._subjectInfo = null;
    subjectImpl._lastSubjectEconomyTick = -1;
    subjectImpl._lastSubjectAutonomyTick = -1;
    subjectImpl._lastProtectionOutcomeTick = -1;
    return true;
  }

  private protectionCallKey(subject: Player, attacker: Player): string {
    return `${subject.id()}|${attacker.id()}`;
  }

  private canApplyProtectionOutcome(subject: PlayerImpl): boolean {
    return (
      subject._lastProtectionOutcomeTick < 0 ||
      this.mg.ticks() - subject._lastProtectionOutcomeTick >=
        SUBJECT_PROTECTION_OUTCOME_COOLDOWN_TICKS
    );
  }

  private applyProtectionDecline(subject: PlayerImpl): void {
    if (subject._subjectInfo === null) return;
    if (!this.canApplyProtectionOutcome(subject)) return;

    subject._lastProtectionOutcomeTick = this.mg.ticks();
    const autonomyGain =
      subject._subjectInfo.kind === SubjectRelationKind.Protectorate ? 10 : 5;
    const relationLoss =
      subject._subjectInfo.kind === SubjectRelationKind.Protectorate ? -25 : -15;

    subject._subjectInfo.autonomy = Math.min(
      100,
      subject._subjectInfo.autonomy + autonomyGain,
    );
    subject.updateRelation(this, relationLoss);
  }

  private applyProtectionHonor(subject: PlayerImpl): void {
    if (subject._subjectInfo === null) return;
    if (!this.canApplyProtectionOutcome(subject)) return;

    subject._lastProtectionOutcomeTick = this.mg.ticks();
    subject._subjectInfo.autonomy = Math.max(
      0,
      subject._subjectInfo.autonomy - 2,
    );
    subject.updateRelation(this, 10);
  }

  private expireProtectionCalls(): void {
    const duration = this.mg.config().allianceRequestDuration();
    const active: ProtectionCallRecord[] = [];

    for (const call of this._pendingProtectionCalls) {
      const subject = call.subject() as PlayerImpl;
      const attacker = call.attacker();
      const noLongerValid =
        !subject.isSubjectOf(this) ||
        !subject.isAlive() ||
        !attacker.isAlive() ||
        subject.isFriendly(attacker);

      if (noLongerValid) {
        this.mg.addUpdate({
          type: GameUpdateType.ProtectionCallReply,
          call: {
            type: GameUpdateType.ProtectionCall,
            overlordID: this.smallID(),
            subjectID: subject.smallID(),
            attackerID: attacker.smallID(),
            createdAt: call.createdAt(),
          },
          intervened: false,
          cancelled: true,
        });
        continue;
      }

      if (this.mg.ticks() - call.createdAt() < duration) {
        active.push(call);
        continue;
      }

      this.applyProtectionDecline(subject);

      this.mg.addUpdate({
        type: GameUpdateType.ProtectionCallReply,
        call: {
          type: GameUpdateType.ProtectionCall,
          overlordID: this.smallID(),
          subjectID: subject.smallID(),
          attackerID: attacker.smallID(),
          createdAt: call.createdAt(),
        },
        intervened: false,
      });
    }

    this._pendingProtectionCalls = active;
  }

  incomingProtectionCalls(): ProtectionCall[] {
    this.expireProtectionCalls();
    return [...this._pendingProtectionCalls];
  }

  raiseProtectionCall(attacker: Player): boolean {
    if (
      this._overlord === null ||
      this._subjectInfo === null ||
      !this.isAlive() ||
      !attacker.isAlive() ||
      attacker === this ||
      attacker === this._overlord
    ) {
      return false;
    }

    // Protection is defensive. A subject that initiated this conflict cannot
    // invoke its overlord merely because the victim fights back.
    const stillAttacking = this.outgoingAttacks().some(
      (attack) =>
        attack.isActive() &&
        attack.target().isPlayer() &&
        attack.target() === attacker,
    );
    if (stillAttacking || this.hasRecentAggressionAgainst(attacker)) {
      return false;
    }

    const overlord = this._overlord as PlayerImpl;
    overlord.expireProtectionCalls();

    const key = overlord.protectionCallKey(this, attacker);
    const last = overlord._lastProtectionCallTick.get(key);
    if (
      last !== undefined &&
      this.mg.ticks() - last < this.mg.config().allianceRequestDuration()
    ) {
      return false;
    }

    const call = new ProtectionCallRecord(this, attacker, this.mg.ticks());
    overlord._pendingProtectionCalls.push(call);
    overlord._lastProtectionCallTick.set(key, this.mg.ticks());
    this.mg.addUpdate({
      type: GameUpdateType.ProtectionCall,
      overlordID: overlord.smallID(),
      subjectID: this.smallID(),
      attackerID: attacker.smallID(),
      createdAt: call.createdAt(),
    });
    return true;
  }

  respondToProtectionCall(
    subject: Player,
    attacker: Player,
    intervene: boolean,
  ): boolean {
    this.expireProtectionCalls();
    const callIndex = this._pendingProtectionCalls.findIndex(
      (call) => call.subject() === subject && call.attacker() === attacker,
    );
    if (callIndex < 0 || !subject.isSubjectOf(this)) return false;

    if (intervene && this.isOnSameTeam(attacker)) {
      return false;
    }

    const [call] = this._pendingProtectionCalls.splice(callIndex, 1);
    const subjectImpl = subject as PlayerImpl;

    if (!attacker.isAlive() || subject.isFriendly(attacker)) {
      this.mg.addUpdate({
        type: GameUpdateType.ProtectionCallReply,
        call: {
          type: GameUpdateType.ProtectionCall,
          overlordID: this.smallID(),
          subjectID: subject.smallID(),
          attackerID: attacker.smallID(),
          createdAt: call.createdAt(),
        },
        intervened: false,
        cancelled: true,
      });
      return true;
    }

    if (intervene) {
      const alliance = this.allianceWith(attacker);
      if (alliance !== null) {
        this.breakAlliance(alliance);
      }

      this.updateRelation(attacker, -100);
      attacker.updateRelation(this, -70);
      if (this.canTarget(attacker)) {
        this.target(attacker);
      }

      this.applyProtectionHonor(subjectImpl);
    } else {
      this.applyProtectionDecline(subjectImpl);
    }

    this.mg.addUpdate({
      type: GameUpdateType.ProtectionCallReply,
      call: {
        type: GameUpdateType.ProtectionCall,
        overlordID: this.smallID(),
        subjectID: subject.smallID(),
        attackerID: attacker.smallID(),
        createdAt: call.createdAt(),
      },
      intervened: intervene,
    });
    return true;
  }

  canDeclareIndependence(): boolean {
    return (
      this._overlord !== null &&
      this._subjectInfo !== null &&
      this._subjectInfo.autonomy >= SUBJECT_INDEPENDENCE_AUTONOMY
    );
  }

  processSubjectRelationTick(): void {
    // Overlords must resolve ignored protection calls too; expiration counts
    // as refusing the obligation and therefore raises subject autonomy.
    this.expireProtectionCalls();

    if (this._overlord === null || this._subjectInfo === null) return;

    const now = this.mg.ticks();
    const overlord = this._overlord as PlayerImpl;

    if (
      this._lastSubjectEconomyTick < 0 ||
      now - this._lastSubjectEconomyTick >= SUBJECT_TRIBUTE_INTERVAL_TICKS
    ) {
      const earnedSinceLast = this._goldEarned - this._subjectLastGoldEarned;
      this._subjectLastGoldEarned = this._goldEarned;
      this._lastSubjectEconomyTick = now;

      if (earnedSinceLast > 0n && this._subjectInfo.tributeRate > 0) {
        const due =
          (earnedSinceLast * BigInt(this._subjectInfo.tributeRate)) / 100n;
        const paid = due > this._gold ? this._gold : due;
        if (paid > 0n) {
          this.removeGold(paid);
          overlord.addGold(paid);
        }
      }
    }

    if (
      this._lastSubjectAutonomyTick < 0 ||
      now - this._lastSubjectAutonomyTick >= SUBJECT_AUTONOMY_INTERVAL_TICKS
    ) {
      this._lastSubjectAutonomyTick = now;

      const troopRatio =
        overlord.troops() > 0 ? this.troops() / overlord.troops() : 1;
      const tileRatio =
        overlord.numTilesOwned() > 0
          ? this.numTilesOwned() / overlord.numTilesOwned()
          : 1;

      let delta =
        this._subjectInfo.kind === SubjectRelationKind.Protectorate ? 1 : 0;

      if (troopRatio >= 0.9 && tileRatio >= 0.9) {
        delta += 2;
      } else if (troopRatio >= 0.6 || tileRatio >= 0.6) {
        delta += 1;
      }

      if (troopRatio <= 0.3 && tileRatio <= 0.3) {
        delta -= 1;
      }

      this._subjectInfo.autonomy = Math.max(
        0,
        Math.min(100, this._subjectInfo.autonomy + delta),
      );
    }
  }

  declareIndependence(): boolean {
    if (!this.canDeclareIndependence() || this._overlord === null) return false;
    const overlord = this._overlord as PlayerImpl;
    overlord.cancelProtectionCallsForSubject(this);
    overlord._subjects = overlord._subjects.filter((p) => p !== this);
    this._overlord = null;
    this._subjectInfo = null;
    this._lastSubjectEconomyTick = -1;
    this._lastSubjectAutonomyTick = -1;
    this._lastProtectionOutcomeTick = -1;
    this.updateRelation(overlord, -100);
    overlord.updateRelation(this, -100);
    return true;
  }

  createAllianceRequest(recipient: Player): AllianceRequest | null {
    if (this.isAlliedWith(recipient)) {
      throw new Error(`cannot create alliance request, already allies`);
    }
    if (!this.canSendAllianceRequest(recipient)) {
      return null;
    }
    return this.mg.createAllianceRequest(this, recipient satisfies Player);
  }

  relation(other: Player): Relation {
    if (other === this) {
      throw new Error(`cannot get relation with self: ${this}`);
    }
    const relation = this.relations.get(other) ?? 0;
    return this.relationFromValue(relation);
  }

  private relationFromValue(relationValue: number): Relation {
    if (relationValue < -50) {
      return Relation.Hostile;
    }
    if (relationValue < 0) {
      return Relation.Distrustful;
    }
    if (relationValue < 50) {
      return Relation.Neutral;
    }
    return Relation.Friendly;
  }

  allRelationsSorted(): { player: Player; relation: Relation }[] {
    return Array.from(this.relations, ([k, v]) => ({ player: k, relation: v }))
      .filter((r) => r.player.isAlive())
      .sort((a, b) => a.relation - b.relation)
      .map((r) => ({
        player: r.player,
        relation: this.relationFromValue(r.relation),
      }));
  }

  updateRelation(other: Player, delta: number): void {
    if (other === this) {
      throw new Error(`cannot update relation with self: ${this}`);
    }
    const relation = this.relations.get(other) ?? 0;
    const newRelation = within(relation + delta, -100, 100);
    this.relations.set(other, newRelation);
  }

  decayRelations() {
    this.relations.forEach((r: number, p: Player) => {
      const sign = -1 * Math.sign(r);
      const delta = 0.05;
      r += sign * delta;
      if (Math.abs(r) < delta * 2) {
        r = 0;
      }
      this.relations.set(p, r);
    });
  }

  private puppetMayFight(other: Player): boolean {
    if (!this.isPuppet()) return true;

    const defensiveWar =
      other.hasRecentAggressionAgainst(this) ||
      this.incomingAttacks().some(
        (attack) => attack.isActive() && attack.attacker() === other,
      );
    if (defensiveWar) return true;

    const overlord = this._overlord;
    if (overlord === null || !overlord.isAlive()) return false;

    const overlordDesignatedEnemy =
      overlord.targets().includes(other) ||
      overlord.outgoingAttacks().some(
        (attack) => attack.isActive() && attack.target() === other,
      );

    return overlordDesignatedEnemy;
  }

  canTarget(other: Player): boolean {
    if (this === other) {
      return false;
    }
    if (this.isFriendly(other)) {
      return false;
    }
    if (!this.puppetMayFight(other)) {
      return false;
    }
    for (const t of this.targets_) {
      if (this.mg.ticks() - t.tick < this.mg.config().targetCooldown()) {
        return false;
      }
    }
    return true;
  }

  target(other: Player): void {
    this.targets_.push({ tick: this.mg.ticks(), target: other });
    this.mg.target(this, other);
  }

  targets(): Player[] {
    return this.targets_
      .filter(
        (t) => this.mg.ticks() - t.tick < this.mg.config().targetDuration(),
      )
      .map((t) => t.target);
  }

  transitiveTargets(): Player[] {
    const ts = this.alliances()
      .map((a) => a.other(this))
      .flatMap((ally) => ally.targets());
    ts.push(...this.targets());
    return [...new Set(ts)] satisfies Player[];
  }

  sendEmoji(recipient: Player | typeof AllPlayers, emoji: string): void {
    if (recipient === this) {
      throw Error(`Cannot send emoji to oneself: ${this}`);
    }
    const msg: EmojiMessage = {
      message: emoji,
      senderID: this.smallID(),
      recipientID: recipient === AllPlayers ? recipient : recipient.smallID(),
      createdAt: this.mg.ticks(),
    };
    this.outgoingEmojis_.push(msg);
    this.mg.sendEmojiUpdate(msg);
  }

  outgoingEmojis(): EmojiMessage[] {
    return this.outgoingEmojis_
      .filter(
        (e) =>
          this.mg.ticks() - e.createdAt <
          this.mg.config().emojiMessageDuration(),
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  canSendEmoji(recipient: Player | typeof AllPlayers): boolean {
    if (recipient === this) {
      return false;
    }
    const recipientID =
      recipient === AllPlayers ? AllPlayers : recipient.smallID();
    const prevMsgs = this.outgoingEmojis_.filter(
      (msg) => msg.recipientID === recipientID,
    );
    for (const msg of prevMsgs) {
      if (
        this.mg.ticks() - msg.createdAt <
        this.mg.config().emojiMessageCooldown()
      ) {
        return false;
      }
    }
    return true;
  }

  canSendQuickChat(recipient: Player): boolean {
    if (recipient === this) {
      return false;
    }
    const lastSentAt = this.outgoingQuickChats_.get(recipient.smallID());
    return (
      lastSentAt === undefined ||
      this.mg.ticks() - lastSentAt >= this.mg.config().quickChatCooldown()
    );
  }

  recordQuickChat(recipient: Player): void {
    this.outgoingQuickChats_.set(recipient.smallID(), this.mg.ticks());
  }

  canDonateGold(recipient: Player): boolean {
    if (recipient === this) {
      return false;
    }
    if (
      !this.isAlive() ||
      !recipient.isAlive() ||
      !this.isFriendly(recipient)
    ) {
      return false;
    }
    if (
      recipient.type() === PlayerType.Human &&
      this.mg.config().donateGold() === false
    ) {
      return false;
    }
    for (const donation of this.sentDonations) {
      if (donation.recipient === recipient) {
        if (
          this.mg.ticks() - donation.tick <
          this.mg.config().donateCooldown()
        ) {
          return false;
        }
      }
    }
    return true;
  }

  canDonateTroops(recipient: Player): boolean {
    if (recipient === this) {
      return false;
    }
    if (
      !this.isAlive() ||
      !recipient.isAlive() ||
      !this.isFriendly(recipient)
    ) {
      return false;
    }
    if (
      recipient.type() === PlayerType.Human &&
      this.mg.config().donateTroops() === false
    ) {
      return false;
    }
    for (const donation of this.sentDonations) {
      if (donation.recipient === recipient) {
        if (
          this.mg.ticks() - donation.tick <
          this.mg.config().donateCooldown()
        ) {
          return false;
        }
      }
    }
    return true;
  }

  donateTroops(recipient: Player, troops: number): boolean {
    // Defense-in-depth: canDonateTroops already checks this, but guard here too
    // to prevent self-donation if the method is called directly.
    if (recipient === this) return false;
    if (troops <= 0) return false;
    const removed = this.removeTroops(troops);
    if (removed === 0) return false;
    recipient.addTroops(removed);

    this.sentDonations.push(new Donation(recipient, this.mg.ticks()));
    this.mg.addUpdate({
      type: GameUpdateType.DonateEvent,
      donationType: "troops",
      senderId: this.id(),
      recipientId: recipient.id(),
      amount: BigInt(removed),
    });
    return true;
  }

  donateGold(recipient: Player, gold: Gold): boolean {
    // Defense-in-depth: canDonateGold already checks this, but guard here too
    // to prevent self-donation if the method is called directly.
    if (recipient === this) return false;
    if (gold <= 0n) return false;
    const removed = this.removeGold(gold);
    if (removed === 0n) return false;
    recipient.addGold(removed);

    this.sentDonations.push(new Donation(recipient, this.mg.ticks()));
    this.mg.addUpdate({
      type: GameUpdateType.DonateEvent,
      donationType: "gold",
      senderId: this.id(),
      recipientId: recipient.id(),
      amount: removed,
    });
    return true;
  }

  canDeleteUnit(): boolean {
    return (
      this.mg.ticks() - this.lastDeleteUnitTick >=
      this.mg.config().deleteUnitCooldown()
    );
  }

  recordDeleteUnit(): void {
    this.lastDeleteUnitTick = this.mg.ticks();
  }

  canEmbargoAll(): boolean {
    // Cooldown gate
    if (
      this.mg.ticks() - this.lastEmbargoAllTick <
      this.mg.config().embargoAllCooldown()
    ) {
      return false;
    }
    // At least one eligible player exists
    for (const p of this.mg.players()) {
      if (p.id() === this.id()) continue;
      if (p.type() === PlayerType.Bot) continue;
      if (this.isOnSameTeam(p)) continue;
      return true;
    }
    return false;
  }

  recordEmbargoAll(): void {
    this.lastEmbargoAllTick = this.mg.ticks();
  }

  hasEmbargoAgainst(other: Player): boolean {
    return this.embargoes.has(other.id());
  }

  canTrade(other: Player): boolean {
    if (this.isInSubjectRelation(other)) return true;
    const embargo =
      other.hasEmbargoAgainst(this) || this.hasEmbargoAgainst(other);
    return !embargo && other.id() !== this.id();
  }

  getEmbargoes(): Embargo[] {
    return [...this.embargoes.values()];
  }

  addEmbargo(other: Player, isTemporary: boolean): void {
    if (this.isInSubjectRelation(other)) return;
    const embargo = this.embargoes.get(other.id());
    if (embargo !== undefined && !embargo.isTemporary) return;

    this.mg.addUpdate({
      type: GameUpdateType.EmbargoEvent,
      event: "start",
      playerID: this.smallID(),
      embargoedID: other.smallID(),
    });

    this.embargoes.set(other.id(), {
      createdAt: this.mg.ticks(),
      isTemporary: isTemporary,
      target: other,
    });
  }

  stopEmbargo(other: Player): void {
    this.embargoes.delete(other.id());
    this.mg.addUpdate({
      type: GameUpdateType.EmbargoEvent,
      event: "stop",
      playerID: this.smallID(),
      embargoedID: other.smallID(),
    });
  }

  endTemporaryEmbargo(other: Player): void {
    const embargo = this.embargoes.get(other.id());
    if (embargo !== undefined && !embargo.isTemporary) return;

    this.stopEmbargo(other);
  }

  tradingPartners(): Player[] {
    return this.mg
      .players()
      .filter((other) => other !== this && this.canTrade(other));
  }

  team(): Team | null {
    return this._team;
  }

  isOnSameTeam(other: Player): boolean {
    if (other === this) {
      return false;
    }
    if (this.team() === null || other.team() === null) {
      return false;
    }
    if (this.team() === ColoredTeams.Bot || other.team() === ColoredTeams.Bot) {
      return false;
    }
    return this._team === other.team();
  }

  isFriendly(other: Player, treatAFKFriendly: boolean = false): boolean {
    if (other === this) {
      return true;
    }
    if (other.isDisconnected() && !treatAFKFriendly) {
      return false;
    }
    const sharedOverlord =
      this.overlord() !== null && this.overlord() === other.overlord();
    return (
      this.isOnSameTeam(other) ||
      this.isAlliedWith(other) ||
      this.isInSubjectRelation(other) ||
      sharedOverlord
    );
  }

  gold(): Gold {
    return this._gold;
  }

  tradeGold(): Gold {
    return this._tradeGold;
  }

  addTradeGold(toAdd: Gold): void {
    this._tradeGold += toAdd;
  }

  trainGold(): Gold {
    return this._trainGold;
  }

  addTrainGold(toAdd: Gold): void {
    this._trainGold += toAdd;
  }

  piracyGold(): Gold {
    return this._piracyGold;
  }

  addPiracyGold(toAdd: Gold): void {
    this._piracyGold += toAdd;
  }

  goldEarned(): Gold {
    return this._goldEarned;
  }

  addGold(toAdd: Gold, tile?: TileRef): void {
    this._gold += toAdd;
    // Every gold grant flows through here (workers, trade, trains, piracy,
    // conquest, donations) — track lifetime income for the leaderboard's
    // "Gold Income/min" column. Starting gold is assigned directly to the
    // field in the constructor and deliberately does not count as income.
    this._goldEarned += toAdd;
    if (tile) {
      this.mg.addUpdate({
        type: GameUpdateType.BonusEvent,
        player: this.id(),
        tile,
        gold: Number(toAdd),
        troops: 0,
      });
    }
  }

  removeGold(toRemove: Gold): Gold {
    if (toRemove <= 0n) {
      return 0n;
    }
    const actualRemoved = minInt(this._gold, toRemove);
    this._gold -= actualRemoved;
    return actualRemoved;
  }

  troops(): number {
    return Number(this._troops);
  }

  addTroops(troops: number): void {
    if (troops < 0) {
      this.removeTroops(-1 * troops);
      return;
    }
    this._troops += toInt(troops);
  }
  removeTroops(troops: number): number {
    if (troops <= 0) {
      return 0;
    }
    const toRemove = minInt(this._troops, toInt(troops));
    this._troops -= toRemove;
    return Number(toRemove);
  }

  captureUnit(unit: Unit): void {
    if (unit.owner() === this) {
      throw new Error(`Cannot capture unit, ${this} already owns ${unit}`);
    }
    unit.setOwner(this);
  }

  buildUnit<T extends UnitType>(
    type: T,
    spawnTile: TileRef,
    params: UnitParams<T>,
  ): Unit {
    if (this.mg.config().isUnitDisabled(type)) {
      throw new Error(
        `Attempted to build disabled unit ${type} at tile ${spawnTile} by player ${this.name()}`,
      );
    }

    const cost = this.mg.unitInfo(type).cost(this.mg, this);
    const b = new UnitImpl(
      type,
      this.mg,
      spawnTile,
      this.mg.nextUnitID(),
      this,
      params,
    );
    this._units.push(b);
    this._myUnitsVersion++;
    this.recordUnitConstructed(type);
    this.removeGold(cost);
    this.removeTroops("troops" in params ? (params.troops ?? 0) : 0);
    this.mg.addUpdate(b.toUpdate());
    this.mg.addUnit(b);

    return b;
  }

  public findUnitToUpgrade(type: UnitType, targetTile: TileRef): Unit | false {
    const unit = this.findExistingUnitToUpgrade(type, targetTile);
    if (unit === false || !this.canUpgradeUnit(unit)) {
      return false;
    }
    return unit;
  }

  private findExistingUnitToUpgrade(
    type: UnitType,
    targetTile: TileRef,
  ): Unit | false {
    const closest = findClosestBy(
      this.mg.nearbyUnits(
        targetTile,
        this.mg.config().structureMinDist(),
        type,
        undefined,
        true,
      ),
      (entry) => entry.distSquared,
    );

    return closest?.unit ?? false;
  }

  private canBuildUnitType(
    unitType: UnitType,
    knownCost: Gold | null = null,
  ): boolean {
    if (this.mg.config().isUnitDisabled(unitType)) {
      return false;
    }
    const cost = knownCost ?? this.mg.unitInfo(unitType).cost(this.mg, this);
    if (this._gold < cost) {
      return false;
    }
    if (unitType !== UnitType.MIRVWarhead && !this.isAlive()) {
      return false;
    }
    return true;
  }

  private canUpgradeUnitType(unitType: UnitType): boolean {
    return Boolean(this.mg.config().unitInfo(unitType).upgradable);
  }

  private isUnitValidToUpgrade(unit: Unit): boolean {
    if (unit.isUnderConstruction()) {
      return false;
    }
    if (unit.isMarkedForDeletion()) {
      return false;
    }
    if (unit.owner() !== this) {
      return false;
    }
    return true;
  }

  public canUpgradeUnit(unit: Unit): boolean {
    if (!this.canUpgradeUnitType(unit.type())) {
      return false;
    }
    if (!this.canBuildUnitType(unit.type())) {
      return false;
    }
    if (!this.isUnitValidToUpgrade(unit)) {
      return false;
    }
    return true;
  }

  upgradeUnit(unit: Unit) {
    const cost = this.mg.unitInfo(unit.type()).cost(this.mg, this);
    this.removeGold(cost);
    unit.increaseLevel();
    this.recordUnitConstructed(unit.type());
  }

  public buildableUnits(
    tile: TileRef | null,
    units: readonly PlayerBuildableUnitType[] = PlayerBuildable.types,
  ): BuildableUnit[] {
    const mg = this.mg;
    const config = mg.config();
    const rail = mg.railNetwork();
    const inSpawnPhase = mg.inSpawnPhase();

    const validTiles =
      tile !== null && units.some((u) => Structures.has(u))
        ? this.validStructureSpawnTiles(tile)
        : [];

    const len = units.length;
    const result = new Array<BuildableUnit>(len);

    for (let i = 0; i < len; i++) {
      const u = units[i];

      const cost = config.unitInfo(u).cost(mg, this);
      let canUpgrade: number | false = false;
      let canBuild: TileRef | false = false;

      if (tile !== null && this.canBuildUnitType(u, cost) && !inSpawnPhase) {
        if (this.canUpgradeUnitType(u)) {
          const existingUnit = this.findExistingUnitToUpgrade(u, tile);
          if (
            existingUnit !== false &&
            this.isUnitValidToUpgrade(existingUnit)
          ) {
            canUpgrade = existingUnit.id();
          }
        }
        canBuild = this.canSpawnUnitType(u, tile, validTiles);
      }

      const buildNew = canBuild !== false && canUpgrade === false;

      // Cumulative bulk-upgrade totals. Each upgrade raises the unit's level
      // and the constructed count, so step n costs the same as if the player
      // already had n extra units — cost(mg, this, n).
      let upgradeCosts: Gold[] | undefined;
      if (canUpgrade !== false) {
        upgradeCosts = new Array<Gold>(MAX_UPGRADE_AMOUNT);
        let total = 0n;
        for (let n = 0; n < MAX_UPGRADE_AMOUNT; n++) {
          total += config.unitInfo(u).cost(mg, this, n);
          upgradeCosts[n] = total;
        }
      }

      result[i] = {
        type: u,
        canBuild,
        canUpgrade,
        cost,
        upgradeCosts,
        overlappingRailroads: buildNew
          ? rail.overlappingRailroads(u, canBuild as TileRef)
          : [],
        ghostRailPaths: buildNew
          ? rail.computeGhostRailPaths(u, canBuild as TileRef)
          : [],
      };
    }

    return result;
  }

  canBuild(
    unitType: UnitType,
    targetTile: TileRef,
    validTiles: TileRef[] | null = null,
  ): TileRef | false {
    if (!this.canBuildUnitType(unitType)) {
      return false;
    }

    return this.canSpawnUnitType(unitType, targetTile, validTiles);
  }

  private canSpawnUnitType(
    unitType: UnitType,
    targetTile: TileRef,
    validTiles: TileRef[] | null,
  ): TileRef | false {
    switch (unitType) {
      case UnitType.MIRV:
        if (!this.mg.hasOwner(targetTile)) {
          return false;
        }
        return this.nukeSpawn(targetTile, unitType);
      case UnitType.AtomBomb:
      case UnitType.HydrogenBomb:
        return this.nukeSpawn(targetTile, unitType);
      case UnitType.MIRVWarhead:
        return targetTile;
      case UnitType.Port:
        return this.portSpawn(targetTile, validTiles);
      case UnitType.Warship:
        return this.warshipSpawn(targetTile);
      case UnitType.Shell:
      case UnitType.SAMMissile:
        return targetTile;
      case UnitType.TransportShip:
        return canBuildTransportShip(this.mg, this, targetTile);
      case UnitType.TradeShip:
        return this.tradeShipSpawn(targetTile);
      case UnitType.Train:
        return this.landBasedUnitSpawn(targetTile);
      case UnitType.MissileSilo:
      case UnitType.DefensePost:
      case UnitType.SAMLauncher:
      case UnitType.City:
      case UnitType.Factory:
        return this.landBasedStructureSpawn(targetTile, validTiles);
      default:
        assertNever(unitType);
    }
  }

  nukeSpawn(tile: TileRef, nukeType: UnitType): TileRef | false {
    const mg = this.mg;
    if (mg.isSpawnImmunityActive()) {
      return false;
    }
    // Impassable terrain cannot be nuked.
    if (mg.isImpassable(tile)) {
      return false;
    }
    const owner = this.mg.owner(tile);
    // Allow nuking teammates after the game is over (aftergame fun), but not in singleplayer.
    const gameOver =
      mg.getWinner() !== null &&
      mg.config().gameConfig().gameType !== GameType.Singleplayer;
    if (owner.isPlayer()) {
      if (this.isOnSameTeam(owner) && !gameOver) {
        return false;
      }
    }
    const config = mg.config();

    // Prevent launching nukes that would hit teammate structures (only in team games).
    // Disabled after game-over so players can nuke teammates in the aftergame.
    if (
      config.gameConfig().gameMode === GameMode.Team &&
      nukeType !== UnitType.MIRV &&
      !gameOver
    ) {
      const magnitude = config.nukeMagnitudes(nukeType);
      const wouldHitTeammate = mg.anyUnitNearby(
        tile,
        magnitude.outer,
        Structures.types,
        (unit) => unit.owner().isPlayer() && this.isOnSameTeam(unit.owner()),
      );
      if (wouldHitTeammate) {
        return false;
      }
    }

    // only get missilesilos that are not on cooldown and not under construction
    const readySilos = this.units(UnitType.MissileSilo).filter(
      (silo) =>
        silo.isActive() && !silo.isInCooldown() && !silo.isUnderConstruction(),
    );
    readySilos.sort(
      (a, b) =>
        mg.manhattanDist(a.tile(), tile) - mg.manhattanDist(b.tile(), tile),
    );
    return readySilos[0]?.tile() ?? false;
  }

  portSpawn(tile: TileRef, validTiles: TileRef[] | null): TileRef | false {
    const spawns = Array.from(
      this.mg.bfs(
        tile,
        manhattanDistFN(tile, this.mg.config().radiusPortSpawn()),
      ),
    )
      .filter((t) => this.mg.owner(t) === this && this.mg.isShore(t))
      .sort(
        (a, b) =>
          this.mg.manhattanDist(a, tile) - this.mg.manhattanDist(b, tile),
      );
    const validTileSet = new Set(
      validTiles ?? this.validStructureSpawnTiles(tile),
    );
    for (const t of spawns) {
      if (validTileSet.has(t)) {
        return t;
      }
    }
    return false;
  }

  warshipSpawn(tile: TileRef): TileRef | false {
    if (!this.mg.isWater(tile)) {
      return false;
    }

    const tileComponent = this.mg.getWaterComponent(tile);
    const bestPort = findClosestBy(
      this.units(UnitType.Port),
      (port) => this.mg.manhattanDist(port.tile(), tile),
      (port) =>
        port.isActive() &&
        !port.isUnderConstruction() &&
        tileComponent !== null &&
        this.mg.hasWaterComponent(port.tile(), tileComponent),
    );

    return bestPort?.tile() ?? false;
  }

  landBasedUnitSpawn(tile: TileRef): TileRef | false {
    return this.mg.isLand(tile) && !this.mg.isImpassable(tile) ? tile : false;
  }

  landBasedStructureSpawn(
    tile: TileRef,
    validTiles: TileRef[] | null = null,
  ): TileRef | false {
    const tiles = validTiles ?? this.validStructureSpawnTiles(tile);
    if (tiles.length === 0) {
      return false;
    }
    return tiles[0];
  }

  private validStructureSpawnTiles(tile: TileRef): TileRef[] {
    if (this.mg.owner(tile) !== this) {
      return [];
    }
    const searchRadius = 15;
    const searchRadiusSquared = searchRadius ** 2;

    const nearbyUnits = this.mg.nearbyUnits(
      tile,
      searchRadius * 2,
      Structures.types,
      undefined,
      true,
    );
    // Flood the player's own tiles inside the radius. Same traversal as
    // GameMap.bfs (stack, N/S/W/E push order) so `nearbyTiles` comes out in
    // the same order — the stable sort below keeps that order for ties and
    // callers take the first entry — but on the shared visited array instead
    // of a Set per call (nation placement calls this per candidate tile).
    const map = this.mg.map();
    const w = map.width();
    const cx = tile % w;
    const cy = (tile / w) | 0;
    const smallID = this.smallID();
    const inside = (t: TileRef): boolean => {
      const dx = (t % w) - cx;
      const dy = ((t / w) | 0) - cy;
      return (
        dx * dx + dy * dy < searchRadiusSquared && map.ownerID(t) === smallID
      );
    };
    const scratch = tileTraversalScratch(this.mg);
    const gen = bumpTraversalGeneration(scratch);
    const visited = scratch.visited;
    const stack = scratch.stack;
    stack.length = 0;
    const nearbyTiles: TileRef[] = [];
    if (inside(tile)) {
      visited[tile] = gen;
      nearbyTiles.push(tile);
      stack.push(tile);
    }
    const visit = (n: TileRef) => {
      if (visited[n] !== gen && inside(n)) {
        visited[n] = gen;
        nearbyTiles.push(n);
        stack.push(n);
      }
    };
    while (stack.length > 0) {
      map.forEachNeighbor(stack.pop()!, visit);
    }

    const minDistSquared = this.mg.config().structureMinDist() ** 2;
    const valid: TileRef[] = [];
    for (const t of nearbyTiles) {
      let blocked = false;
      for (const { unit } of nearbyUnits) {
        if (this.mg.euclideanDistSquared(unit.tile(), t) < minDistSquared) {
          blocked = true;
          break;
        }
      }
      if (!blocked) valid.push(t);
    }
    valid.sort(
      (a, b) =>
        this.mg.euclideanDistSquared(a, tile) -
        this.mg.euclideanDistSquared(b, tile),
    );
    return valid;
  }

  tradeShipSpawn(targetTile: TileRef): TileRef | false {
    return this.units(UnitType.Port).find((u) => u.tile() === targetTile)
      ? targetTile
      : false;
  }
  tileChangeVersion(): number {
    return this._tileChangeVersion;
  }

  lastTileChange(): Tick {
    return this._lastTileChange;
  }

  isDisconnected(): boolean {
    return this._isDisconnected;
  }

  markDisconnected(
    isDisconnected: boolean,
    snapshot?: DisconnectSnapshot,
  ): void {
    this._isDisconnected = isDisconnected;
    if (isDisconnected) {
      if (this._disconnectSnapshot === null) {
        const team = this.team();
        this._disconnectSnapshot = snapshot ?? {
          currentTick: this.mg.ticks(),
          teamTiles: team ? this.mg.teamTilesOwned(team) : 0,
          totalLand: this.mg.totalLandTiles(),
          wasAlive: this.isAlive(),
        };
      }
    } else {
      this._disconnectSnapshot = null;
    }
  }

  disconnectSnapshot(): DisconnectSnapshot | null {
    return this._disconnectSnapshot;
  }

  disconnectedAtTick(): number | null {
    return this._disconnectSnapshot?.currentTick ?? null;
  }

  hash(): number {
    return (
      simpleHash(this.id()) * (this.troops() + this.numTilesOwned()) +
      this._units.reduce((acc, unit) => acc + unit.hash(), 0)
    );
  }
  toString(): string {
    return `Player:{name:${this.info().name},clientID:${
      this.info().clientID
    },isAlive:${this.isAlive()},troops:${
      this._troops
    },numTileOwned:${this.numTilesOwned()}}]`;
  }

  public playerProfile(): PlayerProfile {
    const rel = {
      relations: Object.fromEntries(
        this.allRelationsSorted().map(({ player, relation }) => [
          player.smallID(),
          relation,
        ]),
      ),
      alliances: this.alliances().map((a) => a.other(this).smallID()),
    };
    return rel;
  }

  createAttack(
    target: Player | TerraNullius,
    troops: number,
    sourceTile: TileRef | null,
    border: Set<number>,
  ): Attack {
    const attack = new AttackImpl(
      this._pseudo_random.nextID(),
      target,
      this,
      troops,
      sourceTile,
      border,
      this.mg,
    );
    this._outgoingAttacks.push(attack);
    if (target.isPlayer()) {
      (target as PlayerImpl)._incomingAttacks.push(attack);
    }
    return attack;
  }
  outgoingAttacks(): Attack[] {
    return this._outgoingAttacks;
  }
  incomingAttacks(): Attack[] {
    return this._incomingAttacks.filter((a) => a.attacker().isAlive());
  }

  public isImmune(): boolean {
    if (this.type() === PlayerType.Human) {
      return this.mg.isSpawnImmunityActive();
    }
    if (this.type() === PlayerType.Nation) {
      return this.mg.isNationSpawnImmunityActive();
    }
    return false;
  }

  recordAggressionAgainst(player: Player): void {
    if (player === this) return;
    this._lastAggressionTick.set(player.id(), this.mg.ticks());
  }

  hasRecentAggressionAgainst(player: Player): boolean {
    const tick = this._lastAggressionTick.get(player.id());
    return (
      tick !== undefined &&
      this.mg.ticks() - tick < PROTECTION_AGGRESSION_MEMORY_TICKS
    );
  }

  registerHostileActionAgainst(player: Player): void {
    if (player === this) return;

    const activeRetaliation = this.incomingAttacks().some(
      (incoming) =>
        incoming.isActive() &&
        incoming.attacker() === player,
    );
    const recentRetaliation = player.hasRecentAggressionAgainst(this);

    if (!activeRetaliation && !recentRetaliation) {
      this.recordAggressionAgainst(player);
    }
  }

  public canAttackPlayer(
    player: Player,
    treatAFKFriendly: boolean = false,
  ): boolean {
    if (this.isFriendly(player, treatAFKFriendly)) {
      return false;
    }
    if (!this.puppetMayFight(player)) {
      return false;
    }
    if (this.type() !== PlayerType.Human) {
      // Only human attackers respect PVP immunity
      return true;
    }
    return !player.isImmune();
  }

  public canAttack(tile: TileRef): boolean {
    const owner = this.mg.owner(tile);
    if (owner === this) {
      return false;
    }

    if (owner.isPlayer() && !this.canAttackPlayer(owner)) {
      return false;
    }

    if (!this.mg.isLand(tile) || this.mg.isImpassable(tile)) {
      return false;
    }
    if (this.mg.hasOwner(tile)) {
      return this.sharesBorderWith(owner);
    } else {
      for (const t of this.mg.bfs(
        tile,
        andFN(
          (gm, t) => !gm.hasOwner(t) && gm.isLand(t) && !gm.isImpassable(t),
          manhattanDistFN(tile, 200),
        ),
      )) {
        for (const n of this.mg.neighbors(t)) {
          if (this.mg.owner(n) === this) {
            return true;
          }
        }
      }
      return false;
    }
  }

  bestTransportShipSpawn(targetTile: TileRef): TileRef | false {
    return bestShoreDeploymentSource(this.mg, this, targetTile) ?? false;
  }
}
