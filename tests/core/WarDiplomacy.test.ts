import {
  ColoredTeams,
  Player,
  PlayerInfo,
  PlayerType,
  Team,
} from "../../src/core/game/Game";
import { GameImpl } from "../../src/core/game/GameImpl";
import { setup } from "../util/Setup";

function addPlayerWithTeam(
  game: Awaited<ReturnType<typeof setup>>,
  info: PlayerInfo,
  team?: Team,
): Player {
  return (game as GameImpl).addPlayer(info, team);
}

describe("WarDiplomacy", () => {
  test("the first hostile action creates one stable conflict with both sides", async () => {
    const game = await setup("plains", {}, [
      new PlayerInfo("attacker", PlayerType.Human, null, "attacker"),
      new PlayerInfo("defender", PlayerType.Human, null, "defender"),
    ]);
    const attacker = game.player("attacker");
    const defender = game.player("defender");
    attacker.conquer(game.ref(0, 0));
    defender.conquer(game.ref(40, 40));

    const warId = game.warDiplomacy().beginHostileAction(attacker, defender);
    const war = game.warDiplomacy().getWar(warId!);

    expect(warId).toBe(1);
    expect(war?.status).toBe("active");
    expect(
      war?.sides.map((side) =>
        side.participants.map((participant) => participant.playerID),
      ),
    ).toEqual([["attacker"], ["defender"]]);
  });

  test("repeated actions reuse the same conflict without duplicate participants", async () => {
    const game = await setup("plains", {}, [
      new PlayerInfo("attacker", PlayerType.Human, null, "attacker"),
      new PlayerInfo("defender", PlayerType.Human, null, "defender"),
    ]);
    const attacker = game.player("attacker");
    const defender = game.player("defender");
    attacker.conquer(game.ref(0, 0));
    defender.conquer(game.ref(40, 40));

    const firstWarId = game
      .warDiplomacy()
      .beginHostileAction(attacker, defender);
    const secondWarId = game
      .warDiplomacy()
      .beginHostileAction(attacker, defender);
    const wars = game.warDiplomacy().warsFor(attacker);

    expect(secondWarId).toBe(firstWarId);
    expect(wars).toHaveLength(1);
    expect(wars[0].sides[0].participants).toHaveLength(1);
    expect(wars[0].sides[1].participants).toHaveLength(1);
  });

  test("team members and a puppet join their sovereign's side, while a formal ally stays out", async () => {
    const game = await setup("plains");
    const attacker = addPlayerWithTeam(
      game,
      new PlayerInfo("attacker", PlayerType.Human, null, "attacker"),
      ColoredTeams.Red,
    );
    const teammate = addPlayerWithTeam(
      game,
      new PlayerInfo("teammate", PlayerType.Human, null, "teammate"),
      ColoredTeams.Red,
    );
    const defender = addPlayerWithTeam(
      game,
      new PlayerInfo("defender", PlayerType.Human, null, "defender"),
      ColoredTeams.Blue,
    );
    const puppet = addPlayerWithTeam(
      game,
      new PlayerInfo("puppet", PlayerType.Bot, null, "puppet"),
    );
    const ally = addPlayerWithTeam(
      game,
      new PlayerInfo("ally", PlayerType.Human, null, "ally"),
    );
    [attacker, teammate, defender, puppet, ally].forEach((player, index) =>
      player.conquer(game.ref(index * 8, index * 8)),
    );
    defender.setTroops(100_000);
    puppet.setTroops(1_000);
    attacker.createAllianceRequest(ally)?.accept();
    expect(defender.demandSubjugation(puppet)).toBe(true);
    expect(puppet.acceptSubjectRequest(defender, "subjugation")).toBe(true);

    const warId = game.warDiplomacy().beginHostileAction(attacker, defender);
    const war = game.warDiplomacy().getWar(warId!);

    expect(
      war?.sides.map((side) =>
        side.participants.map((participant) => participant.playerID),
      ),
    ).toEqual([
      ["attacker", "teammate"],
      ["defender", "puppet"],
    ]);
    expect(game.warDiplomacy().warsFor(ally)).toEqual([]);
  });

  test("accepting a call joins the recipient's team and subject coalition once", async () => {
    const game = await setup("plains");
    const attacker = addPlayerWithTeam(
      game,
      new PlayerInfo("attacker", PlayerType.Human, null, "attacker"),
      "Red",
    );
    const defender = addPlayerWithTeam(
      game,
      new PlayerInfo("defender", PlayerType.Human, null, "defender"),
      "Blue",
    );
    const recipient = addPlayerWithTeam(
      game,
      new PlayerInfo("recipient", PlayerType.Human, null, "recipient"),
      "Green",
    );
    const teammate = addPlayerWithTeam(
      game,
      new PlayerInfo("teammate", PlayerType.Human, null, "teammate"),
      "Green",
    );
    const subject = addPlayerWithTeam(
      game,
      new PlayerInfo("subject", PlayerType.Bot, null, "subject"),
    );
    [attacker, defender, recipient, teammate, subject].forEach(
      (member, index) => member.conquer(game.ref(index * 8, index * 8)),
    );
    expect(subject.formPuppetFromPeace(recipient)).toBe(true);
    attacker.createAllianceRequest(recipient)?.accept();
    const warId = game.warDiplomacy().beginHostileAction(attacker, defender)!;
    const callId = game
      .warDiplomacy()
      .createCallToArms(warId, attacker, recipient);

    expect(callId).not.toBeNull();
    expect(game.warDiplomacy().answerCall(warId, recipient, true)).toBe(true);

    const participants = game.warDiplomacy().getWar(warId)!.sides[0]
      .participants;
    for (const member of [recipient, teammate, subject]) {
      expect(
        participants.filter(
          (participant) => participant.playerID === member.id(),
        ),
      ).toHaveLength(1);
    }
    expect(participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          playerID: recipient.id(),
          reason: "callToArms",
        }),
        expect.objectContaining({ playerID: teammate.id(), reason: "team" }),
        expect.objectContaining({ playerID: subject.id(), reason: "puppet" }),
      ]),
    );
  });

  test("rejects a called coalition that conflicts with the opposing side", async () => {
    const game = await setup("plains");
    const attacker = addPlayerWithTeam(
      game,
      new PlayerInfo("attacker", PlayerType.Human, null, "attacker"),
      "Red",
    );
    const defender = addPlayerWithTeam(
      game,
      new PlayerInfo("defender", PlayerType.Human, null, "defender"),
      "Blue",
    );
    const recipient = addPlayerWithTeam(
      game,
      new PlayerInfo("recipient", PlayerType.Human, null, "recipient"),
      "Green",
    );
    const teammate = addPlayerWithTeam(
      game,
      new PlayerInfo("teammate", PlayerType.Human, null, "teammate"),
      "Green",
    );
    [attacker, defender, recipient, teammate].forEach((member, index) =>
      member.conquer(game.ref(index * 8, index * 8)),
    );
    attacker.createAllianceRequest(recipient)?.accept();
    teammate.createAllianceRequest(defender)?.accept();
    const warId = game.warDiplomacy().beginHostileAction(attacker, defender)!;
    const callId = game
      .warDiplomacy()
      .createCallToArms(warId, attacker, recipient);

    expect(callId).not.toBeNull();
    expect(game.warDiplomacy().answerCall(warId, recipient, true)).toBe(false);
    expect(
      game.warDiplomacy().getWar(warId)!.sides[0].participants,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ playerID: recipient.id() }),
        expect.objectContaining({ playerID: teammate.id() }),
      ]),
    );
  });

  test("an existing formal alliance blocks war creation without partial sides", async () => {
    const game = await setup("plains", {}, [
      new PlayerInfo("attacker", PlayerType.Human, null, "attacker"),
      new PlayerInfo("defender", PlayerType.Human, null, "defender"),
    ]);
    const attacker = game.player("attacker");
    const defender = game.player("defender");
    attacker.conquer(game.ref(0, 0));
    defender.conquer(game.ref(40, 40));
    attacker.createAllianceRequest(defender)?.accept();

    expect(game.warDiplomacy().beginHostileAction(attacker, defender)).toBe(
      null,
    );
    expect(game.warDiplomacy().warsFor(attacker)).toEqual([]);
    expect(game.warDiplomacy().warsFor(defender)).toEqual([]);
  });

  test("participant ordering and war hashes do not depend on player insertion order", async () => {
    const makeWar = async (order: string[]) => {
      const game = await setup("plains");
      const players = new Map<string, ReturnType<typeof game.player>>();
      for (const id of order) {
        const team = id === "attacker" || id === "ally" ? "Red" : "Blue";
        players.set(
          id,
          addPlayerWithTeam(
            game,
            new PlayerInfo(id, PlayerType.Human, null, id),
            team,
          ),
        );
      }
      const tileByPlayer: Record<string, [number, number]> = {
        attacker: [0, 0],
        ally: [8, 8],
        defender: [16, 16],
      };
      for (const [id, player] of players) {
        const [x, y] = tileByPlayer[id];
        player.conquer(game.ref(x, y));
      }
      const attacker = players.get("attacker")!;
      const defender = players.get("defender")!;
      game.warDiplomacy().beginHostileAction(attacker, defender);
      return {
        participantIDs: game
          .warDiplomacy()
          .getWar(1)!
          .sides[0].participants.map((participant) => participant.playerID),
        hash: game.warDiplomacy().hash(),
      };
    };

    const first = await makeWar(["attacker", "ally", "defender"]);
    const second = await makeWar(["defender", "ally", "attacker"]);

    expect(first.participantIDs).toEqual(["ally", "attacker"]);
    expect(second.participantIDs).toEqual(first.participantIDs);
    expect(second.hash).toBe(first.hash);
  });
});
