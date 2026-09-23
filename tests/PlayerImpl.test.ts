import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
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

    test("similarly strong players cannot create a subject relation", () => {
      expect(player.canDemandSubjugation(other)).toBe(false);
      expect(other.canRequestProtection(player)).toBe(false);
    });

    test("strong player can demand subjugation", () => {
      makePlayerDominant();

      expect(player.demandSubjugation(other)).toBe(true);
      expect(
        player.isRequestingSubjectRelation(other, "subjugation"),
      ).toBe(true);

      expect(other.acceptSubjectRequest(player, "subjugation")).toBe(true);
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

    test("an alliance can peacefully upgrade into a protectorate", () => {
      makePlayerDominant();
      const allianceRequest = other.createAllianceRequest(player);
      expect(allianceRequest).not.toBeNull();
      allianceRequest!.accept();
      expect(other.isAlliedWith(player)).toBe(true);

      expect(other.requestProtection(player)).toBe(true);
      expect(player.acceptSubjectRequest(other, "protection")).toBe(true);

      expect(other.isAlliedWith(player)).toBe(false);
      expect(other.isProtectorate()).toBe(true);
      expect(other.isTraitor()).toBe(false);
      expect(player.isTraitor()).toBe(false);
    });

    test("weak player can seek protection from a stronger player", () => {
      makePlayerDominant();

      expect(other.requestProtection(player)).toBe(true);
      expect(
        other.isRequestingSubjectRelation(player, "protection"),
      ).toBe(true);

      expect(player.acceptSubjectRequest(other, "protection")).toBe(true);
      expect(other.isProtectorate()).toBe(true);
      expect(other.isSubjectOf(player)).toBe(true);
      expect(other.subjectInfo()).toMatchObject({
        kind: SubjectRelationKind.Protectorate,
        origin: "protection",
        autonomy: 60,
        tributeRate: 10,
      });
    });

    test("subject request can be rejected", () => {
      makePlayerDominant();
      expect(other.requestProtection(player)).toBe(true);
      expect(player.rejectSubjectRequest(other, "protection")).toBe(true);
      expect(other.outgoingSubjectRequests()).toHaveLength(0);
      expect(other.isSubject()).toBe(false);
    });

    test("overlord can release a subject", () => {
      makePlayerDominant();
      expect(player.demandSubjugation(other)).toBe(true);
      expect(other.acceptSubjectRequest(player, "subjugation")).toBe(true);
      expect(player.releaseSubject(other)).toBe(true);
      expect(player.isOverlordOf(other)).toBe(false);
      expect(other.overlord()).toBeNull();
      expect(other.subjectInfo()).toBeNull();
    });

    test("subject needs sufficient autonomy to declare independence", () => {
      makePlayerDominant();
      expect(other.requestProtection(player)).toBe(true);
      expect(player.acceptSubjectRequest(other, "protection")).toBe(true);

      expect(other.subjectInfo()?.autonomy).toBe(60);
      expect(other.canDeclareIndependence()).toBe(false);
      expect(other.declareIndependence()).toBe(false);

      // Simulate a subject that has built enough autonomy over time.
      (other as any)._subjectInfo.autonomy = 80;

      expect(other.canDeclareIndependence()).toBe(true);
      expect(other.declareIndependence()).toBe(true);
      expect(other.isSubject()).toBe(false);
      expect(player.isOverlordOf(other)).toBe(false);
      expect(other.isFriendly(player)).toBe(false);
    });

    test("protectorate pays tribute on newly earned gold", () => {
      makePlayerDominant();
      expect(other.requestProtection(player)).toBe(true);
      expect(player.acceptSubjectRequest(other, "protection")).toBe(true);

      const overlordGold = player.gold();
      const subjectGold = other.gold();

      other.addGold(1_000n);
      (game as any)._ticks += 300;
      other.processSubjectRelationTick();

      expect(player.gold() - overlordGold).toBe(100n);
      expect(other.gold() - subjectGold).toBe(900n);
    });

    test("reciprocal subject requests are blocked while one is pending", () => {
      makePlayerDominant();
      expect(player.demandSubjugation(other)).toBe(true);
      expect(other.canRequestProtection(player)).toBe(false);
      expect(other.requestProtection(player)).toBe(false);
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
