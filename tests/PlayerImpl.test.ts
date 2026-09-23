import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
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

  describe("puppet diplomacy", () => {
    test("request can be accepted and makes both players friendly", () => {
      expect(player.requestPuppet(other)).toBe(true);
      expect(player.isRequestingPuppetOf(other)).toBe(true);

      expect(other.acceptPuppetRequest(player)).toBe(true);
      expect(other.isPuppetOf(player)).toBe(true);
      expect(player.isOverlordOf(other)).toBe(true);
      expect(player.isFriendly(other)).toBe(true);
      expect(other.isFriendly(player)).toBe(true);
      expect(player.canTarget(other)).toBe(false);
      expect(other.canTarget(player)).toBe(false);
    });

    test("request can be rejected", () => {
      expect(player.requestPuppet(other)).toBe(true);
      expect(other.rejectPuppetRequest(player)).toBe(true);
      expect(player.isRequestingPuppetOf(other)).toBe(false);
      expect(other.isPuppet()).toBe(false);
    });

    test("overlord can release a subject", () => {
      expect(player.requestPuppet(other)).toBe(true);
      expect(other.acceptPuppetRequest(player)).toBe(true);
      expect(player.releasePuppet(other)).toBe(true);
      expect(player.isOverlordOf(other)).toBe(false);
      expect(other.overlord()).toBeNull();
    });

    test("subject can declare independence", () => {
      expect(player.requestPuppet(other)).toBe(true);
      expect(other.acceptPuppetRequest(player)).toBe(true);
      expect(other.declareIndependence()).toBe(true);
      expect(other.isPuppet()).toBe(false);
      expect(player.isOverlordOf(other)).toBe(false);
      expect(other.isFriendly(player)).toBe(false);
    });

    test("reciprocal demands are blocked while a request is pending", () => {
      expect(player.requestPuppet(other)).toBe(true);
      expect(other.canSendPuppetRequest(player)).toBe(false);
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
