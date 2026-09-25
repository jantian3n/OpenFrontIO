import { AttackExecution } from "../src/core/execution/AttackExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  Team,
  UnitType,
} from "../src/core/game/Game";
import { GameImpl } from "../src/core/game/GameImpl";
import { setup } from "./util/Setup";

function addPlayerWithTeam(game: Game, info: PlayerInfo, team?: Team): Player {
  return (game as GameImpl).addPlayer(info, team);
}

describe("war combat integration", () => {
  test("the first effective land attack creates a war", async () => {
    const game = await setup("plains", {}, [
      new PlayerInfo("attacker", PlayerType.Human, null, "attacker"),
      new PlayerInfo("defender", PlayerType.Human, null, "defender"),
    ]);
    const attacker = game.player("attacker");
    const defender = game.player("defender");
    attacker.conquer(game.ref(0, 0));
    defender.conquer(game.ref(1, 0));

    game.addExecution(new AttackExecution(10_000, attacker, defender.id()));
    game.executeNextTick();

    expect(game.warDiplomacy().warsFor(attacker)).toHaveLength(1);
    expect(game.warDiplomacy().warsFor(defender)[0].id).toBe(1);
  });

  test("does not start a war or consume troops when it has no hostile border", async () => {
    const game = await setup("plains", {}, [
      new PlayerInfo("attacker", PlayerType.Human, null, "attacker"),
      new PlayerInfo("defender", PlayerType.Human, null, "defender"),
    ]);
    const attacker = game.player("attacker");
    const defender = game.player("defender");
    attacker.conquer(game.ref(0, 0));
    defender.conquer(game.ref(40, 40));
    defender.createAllianceRequest(attacker);
    const troopsBefore = attacker.troops();

    game.addExecution(
      new AttackExecution(10_000, attacker, defender.id(), game.ref(0, 0)),
    );
    game.executeNextTick();

    expect(game.warDiplomacy().warsFor(attacker)).toEqual([]);
    expect(attacker.troops()).toBe(troopsBefore);
    expect(attacker.incomingAllianceRequests()).toHaveLength(1);
  });

  test("returns boat troops when diplomacy blocks the landing attack", async () => {
    const game = await setup("plains", {}, [
      new PlayerInfo("attacker", PlayerType.Human, null, "attacker"),
      new PlayerInfo("defender", PlayerType.Human, null, "defender"),
    ]);
    const attacker = game.player("attacker");
    const defender = game.player("defender");
    const landing = game.ref(0, 0);
    attacker.conquer(landing);
    defender.conquer(game.ref(1, 0));
    attacker.addTroops(1_000);
    const carriedTroops = attacker.removeTroops(250);
    const troopsAfterLoading = attacker.troops();
    attacker.createAllianceRequest(defender)?.accept();

    game.addExecution(
      new AttackExecution(
        carriedTroops,
        attacker,
        defender.id(),
        landing,
        false,
      ),
    );
    game.executeNextTick();

    expect(attacker.troops()).toBe(troopsAfterLoading + carriedTroops);
    expect(game.warDiplomacy().warsFor(attacker)).toEqual([]);
  });

  test("same-team players cannot attack each other or create a war", async () => {
    const game = await setup("plains");
    const attacker = addPlayerWithTeam(
      game,
      new PlayerInfo("attacker", PlayerType.Human, null, "attacker"),
      "Red",
    );
    const defender = addPlayerWithTeam(
      game,
      new PlayerInfo("defender", PlayerType.Human, null, "defender"),
      "Red",
    );
    attacker.conquer(game.ref(0, 0));
    defender.conquer(game.ref(40, 40));

    expect(attacker.canAttackPlayer(defender)).toBe(false);
    expect(game.warDiplomacy().beginHostileAction(attacker, defender)).toBe(
      null,
    );
  });

  test("opposing war participants remain combat-enabled", async () => {
    const game = await setup("plains", {}, [
      new PlayerInfo("attacker", PlayerType.Human, null, "attacker"),
      new PlayerInfo("defender", PlayerType.Human, null, "defender"),
    ]);
    const attacker = game.player("attacker");
    const defender = game.player("defender");
    attacker.conquer(game.ref(0, 0));
    defender.conquer(game.ref(40, 40));
    game.warDiplomacy().beginHostileAction(attacker, defender);

    expect(attacker.canAttackPlayer(defender)).toBe(true);
    expect(defender.canAttackPlayer(attacker)).toBe(true);
  });

  test("military loss score is proportional and capped at its component maximum", async () => {
    const game = await setup("plains", {}, [
      new PlayerInfo("attacker", PlayerType.Human, null, "attacker"),
      new PlayerInfo("defender", PlayerType.Human, null, "defender"),
    ]);
    const attacker = game.player("attacker");
    const defender = game.player("defender");
    attacker.conquer(game.ref(0, 0));
    defender.conquer(game.ref(40, 40));
    const warId = game.warDiplomacy().beginHostileAction(attacker, defender)!;

    game.warDiplomacy().recordTroopLoss(warId, attacker, defender, 100_000);
    const score = game.warDiplomacy().getWar(warId)!.sides[0].score;
    expect(score.militaryLosses).toBeGreaterThan(0);
    expect(score.militaryLosses).toBeLessThanOrEqual(3000);
    expect(score.total).toBe(
      score.territory + score.militaryLosses + score.structures,
    );
  });

  test("capturing baseline territory scores once and recapture removes that score", async () => {
    const game = await setup("plains", {}, [
      new PlayerInfo("attacker", PlayerType.Human, null, "attacker"),
      new PlayerInfo("defender", PlayerType.Human, null, "defender"),
    ]);
    const attacker = game.player("attacker");
    const defender = game.player("defender");
    attacker.conquer(game.ref(0, 0));
    const targetTile = game.ref(40, 40);
    defender.conquer(targetTile);
    const warId = game.warDiplomacy().beginHostileAction(attacker, defender)!;

    attacker.conquer(targetTile);
    const capturedScore = game.warDiplomacy().getWar(warId)!.sides[0].score
      .territory;
    expect(capturedScore).toBe(5000);

    defender.conquer(targetTile);
    expect(game.warDiplomacy().getWar(warId)!.sides[0].score.territory).toBe(0);
  });

  test("destroying a baseline defensive structure earns bounded structure score", async () => {
    const game = await setup("plains", { infiniteGold: true }, [
      new PlayerInfo("attacker", PlayerType.Human, null, "attacker"),
      new PlayerInfo("defender", PlayerType.Human, null, "defender"),
    ]);
    const attacker = game.player("attacker");
    const defender = game.player("defender");
    attacker.conquer(game.ref(0, 0));
    defender.conquer(game.ref(40, 40));
    const structure = defender.buildUnit(
      UnitType.DefensePost,
      game.ref(40, 40),
      {},
    );
    const warId = game.warDiplomacy().beginHostileAction(attacker, defender)!;

    structure.delete(true, attacker, warId);

    const score = game.warDiplomacy().getWar(warId)!.sides[0].score;
    expect(score.structures).toBe(2000);
    expect(score.total).toBe(2000);
  });
});
