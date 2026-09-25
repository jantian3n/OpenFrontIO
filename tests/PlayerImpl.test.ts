import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  Relation,
  SubjectRelationKind,
  UnitType,
} from "../src/core/game/Game";
import { setup } from "./util/Setup";

let game: Game;
let player: Player;
let other: Player;

describe("PlayerImpl", () => {
  beforeEach(async () => {
    game = await setup("plains", { instantBuild: true }, [
      new PlayerInfo("player", PlayerType.Human, null, "player_id"),
      new PlayerInfo("other", PlayerType.Human, null, "other_id"),
    ]);

    player = game.player("player_id");
    other = game.player("other_id");

    player.conquer(game.ref(0, 0));
    other.conquer(game.ref(50, 50));
    player.addGold(BigInt(1000000));

    game.config().structureMinDist = () => 10;
  });

  test("City can be upgraded", () => {
    const city = player.buildUnit(UnitType.City, game.ref(0, 0), {});
    const buCity = player
      .buildableUnits(game.ref(0, 0))
      .find((bu) => bu.type === UnitType.City);
    expect(buCity).toBeDefined();
    expect(buCity!.canUpgrade).toBe(city.id());
  });

  test("DefensePost cannot be upgraded", () => {
    player.buildUnit(UnitType.DefensePost, game.ref(0, 0), {});
    const buDefensePost = player
      .buildableUnits(game.ref(0, 0))
      .find((bu) => bu.type === UnitType.DefensePost);
    expect(buDefensePost).toBeDefined();
    expect(buDefensePost!.canUpgrade).toBeFalsy();
  });

  test("City can be upgraded from another city", () => {
    const city = player.buildUnit(UnitType.City, game.ref(0, 0), {});
    const cityToUpgrade = player.findUnitToUpgrade(
      UnitType.City,
      game.ref(0, 1),
    );
    expect(cityToUpgrade).toBeTruthy();
    if (cityToUpgrade === false) {
      return;
    }
    expect(cityToUpgrade.id()).toBe(city.id());
  });
  test("City cannot be upgraded when too far away", () => {
    player.buildUnit(UnitType.City, game.ref(0, 0), {});
    const cityToUpgrade = player.findUnitToUpgrade(
      UnitType.City,
      game.ref(50, 50),
    );
    expect(cityToUpgrade).toBe(false);
  });
  test("Unit cannot be upgraded when not enough gold", () => {
    player.buildUnit(UnitType.City, game.ref(0, 0), {});
    player.removeGold(BigInt(1000000));
    const cityToUpgrade = player.findUnitToUpgrade(
      UnitType.City,
      game.ref(0, 1),
    );
    expect(cityToUpgrade).toBe(false);
  });

  describe("units() type filtering", () => {
    beforeEach(() => {
      player.buildUnit(UnitType.City, game.ref(0, 0), {});
      player.buildUnit(UnitType.DefensePost, game.ref(11, 0), {});
      player.buildUnit(UnitType.City, game.ref(0, 11), {});
      player.buildUnit(UnitType.MissileSilo, game.ref(11, 11), {});
    });

    // Reference implementation: filter _units preserving insertion order.
    function expected(...types: UnitType[]) {
      const ts = new Set(types);
      return player.units().filter((u) => ts.has(u.type()));
    }

    test("single type returns matching units in insertion order", () => {
      expect(player.units(UnitType.City)).toEqual(expected(UnitType.City));
      expect(player.units(UnitType.City)).toHaveLength(2);
    });

    test("returns a fresh array, not the internal or shared buffer", () => {
      const a = player.units(UnitType.City);
      const b = player.units(UnitType.City);
      expect(a).not.toBe(b);
      expect(a).not.toBe(player.units());
      // Mutating one result must not affect a later query.
      a.length = 0;
      expect(player.units(UnitType.City)).toHaveLength(2);
    });

    test("two and three types return the union in insertion order", () => {
      expect(player.units(UnitType.City, UnitType.MissileSilo)).toEqual(
        expected(UnitType.City, UnitType.MissileSilo),
      );
      expect(
        player.units(UnitType.City, UnitType.DefensePost, UnitType.MissileSilo),
      ).toEqual(
        expected(UnitType.City, UnitType.DefensePost, UnitType.MissileSilo),
      );
      // Duplicate types don't duplicate results.
      expect(player.units(UnitType.City, UnitType.City)).toEqual(
        expected(UnitType.City),
      );
    });

    test("array of types (Set path) and no match", () => {
      expect(
        player.units([
          UnitType.City,
          UnitType.DefensePost,
          UnitType.MissileSilo,
          UnitType.Port,
        ]),
      ).toEqual(
        expected(UnitType.City, UnitType.DefensePost, UnitType.MissileSilo),
      );
      expect(player.units(UnitType.Port)).toEqual([]);
    });
  });

  test("Can't send alliance requests when dead", () => {
    // conquer other
    const otherTiles = other.tiles();
    for (const tile of otherTiles) {
      player.conquer(tile);
    }
    expect(other.canSendAllianceRequest(player)).toBe(false);
  });

  describe("subject diplomacy", () => {
    function makePlayerDominant() {
      player.addTroops(Math.max(100_000, other.troops() * 5));
      for (let x = 1; x <= 20; x++) {
        player.conquer(game.ref(x, 0));
      }
    }

    function formPuppet() {
      makePlayerDominant();
      expect(player.demandSubjugation(other)).toBe(true);
      expect(other.acceptSubjectRequest(player, "subjugation")).toBe(true);
    }

    test("similarly strong players cannot create a puppet relation", () => {
      expect(player.canDemandSubjugation(other)).toBe(false);
      expect(other.canRequestPuppet(player)).toBe(false);
    });

    test("strong player can demand subjugation and creates only a puppet", () => {
      formPuppet();

      expect(other.isPuppetOf(player)).toBe(true);
      expect(player.isOverlordOf(other)).toBe(true);
      expect(other.subjectInfo()).toMatchObject({
        kind: SubjectRelationKind.Puppet,
        origin: "subjugation",
        autonomy: 40,
        tributeRate: 20,
      });
      expect(player.isFriendly(other)).toBe(true);
      expect(other.isFriendly(player)).toBe(true);
      expect(player.canTarget(other)).toBe(false);
      expect(other.canTarget(player)).toBe(false);
    });

    test("a weak player can request to become a puppet of a stronger ally", () => {
      makePlayerDominant();
      const allianceRequest = other.createAllianceRequest(player);
      expect(allianceRequest).not.toBeNull();
      allianceRequest!.accept();
      expect(other.isAlliedWith(player)).toBe(true);

      expect(other.requestPuppet(player)).toBe(true);
      expect(player.acceptSubjectRequest(other, "subjugation")).toBe(true);
      expect(other.isAlliedWith(player)).toBe(false);
      expect(other.isPuppetOf(player)).toBe(true);
    });

    test("becoming a puppet clears pending and existing alliances", () => {
      makePlayerDominant();
      const third = game.addPlayer(
        new PlayerInfo("third", PlayerType.Human, null, "third_id"),
      );
      third.conquer(game.ref(40, 40));

      const existing = other.createAllianceRequest(third);
      expect(existing).not.toBeNull();
      existing!.accept();
      expect(other.isAlliedWith(third)).toBe(true);
      const pending = other.createAllianceRequest(player);
      expect(pending).not.toBeNull();

      expect(player.demandSubjugation(other)).toBe(true);
      expect(other.acceptSubjectRequest(player, "subjugation")).toBe(true);
      expect(other.outgoingAllianceRequests()).toHaveLength(0);
      expect(other.alliances()).toHaveLength(0);
      expect(other.isAlliedWith(third)).toBe(false);
      expect(other.isPuppet()).toBe(true);
      expect(other.canSendAllianceRequest(third)).toBe(false);
      expect(other.createAllianceRequest(third)).toBeNull();
    });

    test("a puppet cannot start an independent offensive war", () => {
      formPuppet();
      const third = game.addPlayer(
        new PlayerInfo("third", PlayerType.Bot, null, "third_id"),
      );
      third.conquer(game.ref(40, 40));
      expect(other.canTarget(third)).toBe(false);
      expect(other.canAttackPlayer(third)).toBe(false);
    });

    test("a puppet can defend itself and follow an overlord-designated enemy", () => {
      formPuppet();
      const defensiveEnemy = game.addPlayer(
        new PlayerInfo(
          "defensiveEnemy",
          PlayerType.Bot,
          null,
          "defensive_enemy",
        ),
      );
      const overlordEnemy = game.addPlayer(
        new PlayerInfo("overlordEnemy", PlayerType.Bot, null, "overlord_enemy"),
      );
      defensiveEnemy.conquer(game.ref(40, 40));
      overlordEnemy.conquer(game.ref(45, 45));

      defensiveEnemy.recordAggressionAgainst(other);
      expect(other.canTarget(defensiveEnemy)).toBe(true);
      expect(other.canAttackPlayer(defensiveEnemy)).toBe(true);
      player.target(overlordEnemy);
      expect(other.canTarget(overlordEnemy)).toBe(true);
      expect(other.canAttackPlayer(overlordEnemy)).toBe(true);
    });

    test("a puppet can join its overlord's defense when the overlord is attacked", () => {
      formPuppet();
      const enemy = game.addPlayer(
        new PlayerInfo("enemy", PlayerType.Bot, null, "enemy"),
      );
      enemy.conquer(game.ref(40, 40));
      enemy.recordAggressionAgainst(player);

      const warId = game.warDiplomacy().beginHostileAction(enemy, player)!;

      expect(other.canAttackPlayer(enemy)).toBe(true);
      expect(
        game.warDiplomacy().getWar(warId)?.sides[1].participants,
      ).toContainEqual(
        expect.objectContaining({ playerID: other.id(), reason: "puppet" }),
      );
    });

    test("a subjugation request can be rejected", () => {
      makePlayerDominant();
      expect(player.demandSubjugation(other)).toBe(true);
      expect(other.rejectSubjectRequest(player, "subjugation")).toBe(true);
      expect(player.outgoingSubjectRequests()).toHaveLength(0);
      expect(other.isSubject()).toBe(false);
    });

    test("an overlord can release a puppet", () => {
      formPuppet();
      expect(player.releaseSubject(other)).toBe(true);
      expect(player.isOverlordOf(other)).toBe(false);
      expect(other.overlord()).toBeNull();
      expect(other.subjectInfo()).toBeNull();
    });

    test("80 autonomy allows an independence request and 100 allows peaceful independence", () => {
      formPuppet();
      expect(other.subjectInfo()?.autonomy).toBe(40);
      expect(other.canRequestIndependence(player)).toBe(false);
      (other as any)._subjectInfo.autonomy = 80;

      expect(other.canRequestIndependence(player)).toBe(true);
      expect(other.requestIndependence(player)).toBe(true);
      expect(other.isRequestingSubjectRelation(player, "independence")).toBe(
        true,
      );
      expect(player.rejectSubjectRequest(other, "independence")).toBe(true);
      expect(other.isSubject()).toBe(true);
      const independenceWar = game.warDiplomacy().warsFor(other)[0];
      expect(independenceWar?.status).toBe("active");
      expect(independenceWar?.sides[0].participants).toContainEqual(
        expect.objectContaining({
          playerID: other.id(),
          reason: "independence",
        }),
      );
      expect(independenceWar?.sides[1].participants).toContainEqual(
        expect.objectContaining({ playerID: player.id() }),
      );
      expect(other.canAttackPlayer(player)).toBe(true);
      const unrelated = game.addPlayer(
        new PlayerInfo("unrelated", PlayerType.Bot, null, "unrelated"),
      );
      unrelated.conquer(game.ref(40, 40));
      expect(other.canAttackPlayer(unrelated)).toBe(false);

      const whitePeaceId = game
        .warDiplomacy()
        .proposePeace(independenceWar!.id, player, { kind: "whitePeace" });
      expect(whitePeaceId).not.toBeNull();
      expect(
        game
          .warDiplomacy()
          .answerPeace(independenceWar!.id, whitePeaceId!, other, true),
      ).toBe(true);
      expect(other.canAttackPlayer(player)).toBe(false);

      (other as any)._subjectInfo.autonomy = 100;
      expect(other.canDeclareIndependence()).toBe(true);
      expect(other.declareIndependence()).toBe(true);
      expect(other.isSubject()).toBe(false);
      expect(player.isOverlordOf(other)).toBe(false);
      expect(other.relation(player)).not.toBe(Relation.Hostile);
    });

    test("an overlord can accept an independence request at 80 autonomy", () => {
      formPuppet();
      (other as any)._subjectInfo.autonomy = 80;
      expect(other.requestIndependence(player)).toBe(true);
      expect(player.acceptSubjectRequest(other, "independence")).toBe(true);
      expect(other.isSubject()).toBe(false);
      expect(player.isOverlordOf(other)).toBe(false);
    });

    test("a puppet pays the agreed tribute from newly earned gold", () => {
      formPuppet();
      const overlordGold = player.gold();
      const subjectGold = other.gold();
      other.addGold(1_000n);
      (game as any)._ticks += 300;
      other.processSubjectRelationTick();
      expect(player.gold() - overlordGold).toBe(200n);
      expect(other.gold() - subjectGold).toBe(800n);
    });

    test("reciprocal puppet requests are blocked while one is pending", () => {
      makePlayerDominant();
      expect(player.demandSubjugation(other)).toBe(true);
      expect(other.canRequestPuppet(player)).toBe(false);
      expect(other.requestPuppet(player)).toBe(false);
    });
  });

  describe("tiles()", () => {
    test("returns a live view that reflects later ownership changes", () => {
      const tiles = player.tiles();
      const sizeBefore = tiles.size;
      const tile = game.ref(5, 5);
      player.conquer(tile);
      expect(tiles.has(tile)).toBe(true);
      expect(tiles.size).toBe(sizeBefore + 1);
    });

    test("every tile is visited when relinquishing during iteration", () => {
      player.conquer(game.ref(1, 0));
      player.conquer(game.ref(2, 0));
      const owned = player.numTilesOwned();
      expect(owned).toBeGreaterThan(1);
      // SpawnExecution relinquishes all tiles while iterating tiles().
      let visited = 0;
      player.tiles().forEach((t) => {
        visited++;
        player.relinquish(t);
      });
      expect(visited).toBe(owned);
      expect(player.numTilesOwned()).toBe(0);
    });
  });
});
