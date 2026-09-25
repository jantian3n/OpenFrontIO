import { SpawnExecution } from "../../../src/core/execution/SpawnExecution";
import { TransportShipExecution } from "../../../src/core/execution/TransportShipExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../../src/core/game/Game";
import { GameID } from "../../../src/core/Schemas";
import { setup } from "../../util/Setup";

const gameID: GameID = "transport-war-diplomacy-test";

async function setupTransportWar(): Promise<{
  game: Game;
  attacker: Player;
  defender: Player;
}> {
  const game = await setup("ocean_and_land", {
    infiniteGold: true,
    instantBuild: true,
    infiniteTroops: true,
  });
  const attackerInfo = new PlayerInfo(
    "attacker",
    PlayerType.Human,
    null,
    "attacker",
  );
  const defenderInfo = new PlayerInfo(
    "defender",
    PlayerType.Human,
    null,
    "defender",
  );
  game.addPlayer(attackerInfo);
  game.addPlayer(defenderInfo);
  game.addExecution(
    new SpawnExecution(
      gameID,
      game.player(attackerInfo.id).info(),
      game.ref(7, 0),
    ),
    new SpawnExecution(
      gameID,
      game.player(defenderInfo.id).info(),
      game.ref(7, 15),
    ),
  );
  game.executeNextTick();
  game.executeNextTick();
  for (let tick = 0; tick < 11; tick++) game.executeNextTick();

  return {
    game,
    attacker: game.player(attackerInfo.id),
    defender: game.player(defenderInfo.id),
  };
}

describe("TransportShipExecution war diplomacy", () => {
  test("does not capture a destination that became owned by an ally in transit", async () => {
    const { game, attacker, defender } = await setupTransportWar();
    const target = game.ref(7, 15);
    const execution = new TransportShipExecution(attacker, target, 10);
    game.addExecution(execution);
    game.executeNextTick();

    const boat = attacker.units(UnitType.TransportShip)[0];
    expect(boat).toBeDefined();
    const destination = boat.targetTile();
    expect(game.owner(destination).id()).toBe(defender.id());
    const warId = game.warDiplomacy().warsFor(attacker)[0]?.id;
    expect(warId).toBeDefined();

    const ally = game.addPlayer(
      new PlayerInfo("ally", PlayerType.Human, null, "ally"),
    );
    attacker.createAllianceRequest(ally)?.accept();
    ally.conquer(destination);

    for (let tick = 0; tick < 80 && execution.isActive(); tick++) {
      game.executeNextTick();
    }

    expect(game.owner(destination).id()).toBe(ally.id());
    expect(
      game.warDiplomacy().getWar(warId!)?.sides[0].participants,
    ).toContainEqual(expect.objectContaining({ playerID: attacker.id() }));
  });

  test("retreats instead of landing after a truce starts in transit", async () => {
    const { game, attacker, defender } = await setupTransportWar();
    const execution = new TransportShipExecution(attacker, game.ref(7, 15), 10);
    game.addExecution(execution);
    game.executeNextTick();

    const boat = attacker.units(UnitType.TransportShip)[0];
    expect(boat).toBeDefined();
    const destination = boat.targetTile();
    const warId = game.warDiplomacy().warsFor(attacker)[0]?.id;
    expect(warId).toBeDefined();
    const proposalId = game.warDiplomacy().proposePeace(warId!, attacker, {
      kind: "whitePeace",
    });
    expect(proposalId).not.toBeNull();
    expect(
      game.warDiplomacy().answerPeace(warId!, proposalId!, defender, true),
    ).toBe(true);

    for (let tick = 0; tick < 80 && execution.isActive(); tick++) {
      game.executeNextTick();
    }

    expect(game.warDiplomacy().isTruce(warId!)).toBe(true);
    expect(game.owner(destination).id()).toBe(defender.id());
  });
});
