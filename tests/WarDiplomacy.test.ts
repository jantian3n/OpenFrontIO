import { vi } from "vitest";
import { Executor } from "../src/core/execution/ExecutionManager";
import {
  ColoredTeams,
  Player,
  PlayerInfo,
  PlayerType,
} from "../src/core/game/Game";
import { GameImpl } from "../src/core/game/GameImpl";
import { GameRunner } from "../src/core/GameRunner";
import { Turn, WarDiplomacyIntentSchema } from "../src/core/Schemas";
import { setup } from "./util/Setup";

type TestGame = Awaited<ReturnType<typeof setup>>;

function addPlayer(
  game: TestGame,
  id: string,
  type = PlayerType.Human,
  team?: string,
): Player {
  return (game as GameImpl).addPlayer(new PlayerInfo(id, type, id, id), team);
}

async function makeWar(
  options: {
    bot?: boolean;
    ally?: boolean;
    defenderLand?: number;
    attackerTeammate?: boolean;
  } = {},
) {
  const game = await setup("plains");
  const attacker = addPlayer(
    game,
    "attacker",
    PlayerType.Human,
    ColoredTeams.Red,
  );
  const defender = addPlayer(
    game,
    "defender",
    options.bot ? PlayerType.Bot : PlayerType.Human,
    ColoredTeams.Blue,
  );
  const ally = addPlayer(
    game,
    "ally",
    options.bot ? PlayerType.Bot : PlayerType.Human,
  );
  const teammate = options.attackerTeammate
    ? addPlayer(game, "teammate", PlayerType.Human, ColoredTeams.Red)
    : null;
  attacker.conquer(game.ref(0, 0));
  const defenderTiles = Array.from(
    { length: options.defenderLand ?? 1 },
    (_, i) => game.ref(40 + i, 40),
  );
  defenderTiles.forEach((tile) => defender.conquer(tile));
  ally.conquer(game.ref(20, 20));
  teammate?.conquer(game.ref(1, 1));
  attacker.setTroops(10_000);
  defender.setTroops(10_000);
  const warId = game.warDiplomacy().beginHostileAction(attacker, defender)!;
  if (options.ally) attacker.createAllianceRequest(ally)?.accept();
  return {
    game,
    diplomacy: game.warDiplomacy(),
    warId,
    attacker,
    defender,
    ally,
    defenderTiles,
    teammate,
  };
}

describe("war diplomacy offers and settlements", () => {
  test("replaying the same turn history reconstructs the same active war and hash", async () => {
    async function replayActiveWar() {
      const game = await setup("plains");
      const attacker = addPlayer(game, "attacker");
      const defender = addPlayer(game, "defender");
      attacker.conquer(game.ref(0, 0));
      defender.conquer(game.ref(40, 40));
      attacker.setTroops(10_000);

      const runner = new GameRunner(
        game,
        new Executor(game, "war_replay", undefined),
        () => {},
      );
      const history: Turn[] = [
        {
          turnNumber: 1,
          intents: [
            {
              type: "attack",
              clientID: "attacker",
              targetID: defender.id(),
              troops: 5_000,
            },
          ],
        },
      ];
      history.forEach((turn) => runner.addTurn(turn));

      expect(runner.executeNextTick()).toBe(true);
      return {
        war: game.warDiplomacy().warsFor(attacker)[0],
        hash: game.warDiplomacy().hash(),
      };
    }

    const continuous = await replayActiveWar();
    const replayed = await replayActiveWar();

    expect(continuous.war).toEqual(replayed.war);
    expect(continuous.hash).toBe(replayed.hash);
  });

  test("a called ally joins only the named war after accepting, and duplicate answers are harmless", async () => {
    const { diplomacy, warId, attacker, ally } = await makeWar({ ally: true });
    const callId = diplomacy.createCallToArms(warId, attacker, ally);

    expect(callId).not.toBeNull();
    expect(diplomacy.answerCall(warId, ally, true)).toBe(true);
    expect(diplomacy.answerCall(warId, ally, true)).toBe(false);
    expect(
      diplomacy
        .getWar(warId)
        ?.sides[0].participants.find(
          (participant) => participant.playerID === ally.id(),
        )?.reason,
    ).toBe("callToArms");
  });

  test("turn execution dispatches a validated call-to-arms intent", async () => {
    const { game, warId, attacker, ally } = await makeWar({ ally: true });
    const execution = new Executor(
      game,
      "war_game",
      attacker.clientID() ?? undefined,
    ).createExec({
      type: "war_call_to_arms",
      clientID: attacker.clientID()!,
      warId,
      recipient: ally.id(),
    });
    execution.init(game, game.ticks());
    execution.tick(game.ticks());

    expect(game.warDiplomacy().getWar(warId)?.calls).toHaveLength(1);
  });

  test("a call cannot pull an ally across an opposing alliance or arrive through an ally chain", async () => {
    const { diplomacy, warId, attacker, defender, ally, game } = await makeWar({
      ally: true,
    });
    const allyCall = diplomacy.createCallToArms(warId, attacker, ally)!;
    expect(allyCall).toBeGreaterThan(0);
    expect(diplomacy.answerCall(warId, ally, true)).toBe(true);

    const chainedAlly = addPlayer(game, "chained");
    chainedAlly.conquer(game.ref(12, 12));
    ally.createAllianceRequest(chainedAlly)?.accept();
    expect(diplomacy.createCallToArms(warId, ally, chainedAlly)).toBeNull();

    const contestedAlly = addPlayer(game, "contested");
    contestedAlly.conquer(game.ref(28, 28));
    attacker.createAllianceRequest(contestedAlly)?.accept();
    defender.createAllianceRequest(contestedAlly)?.accept();
    expect(
      diplomacy.createCallToArms(warId, attacker, contestedAlly),
    ).toBeNull();
  });

  test("white peace enters a truce only after every living human participant signs", async () => {
    const { diplomacy, warId, attacker, defender } = await makeWar();
    const proposalId = diplomacy.proposePeace(warId, attacker, {
      kind: "whitePeace",
    });

    expect(proposalId).not.toBeNull();
    expect(diplomacy.getWar(warId)?.status).toBe("peacePending");
    expect(diplomacy.answerPeace(warId, proposalId!, defender, true)).toBe(
      true,
    );
    expect(diplomacy.getWar(warId)?.status).toBe("truce");
  });

  test("bots vote deterministically when a peace proposal is opened", async () => {
    const first = await makeWar({ bot: true });
    const second = await makeWar({ bot: true });
    first.diplomacy.proposePeace(first.warId, first.attacker, {
      kind: "whitePeace",
    });
    second.diplomacy.proposePeace(second.warId, second.attacker, {
      kind: "whitePeace",
    });

    expect(first.diplomacy.getWar(first.warId)?.status).toBe("truce");
    expect(first.diplomacy.hash()).toBe(second.diplomacy.hash());
  });

  test("reparations validate score and balance atomically at the final signature", async () => {
    const { diplomacy, warId, attacker, defender, teammate } = await makeWar({
      attackerTeammate: true,
    });
    diplomacy.recordTroopLoss(warId, attacker, defender, 10_000);
    defender.addGold(100n);
    const before = attacker.gold();
    const proposalId = diplomacy.proposePeace(warId, attacker, {
      kind: "reparations",
      payerId: defender.id(),
      receiverId: attacker.id(),
      amount: 80,
    });

    expect(proposalId).not.toBeNull();
    expect(diplomacy.answerPeace(warId, proposalId!, defender, true)).toBe(
      true,
    );
    expect(defender.gold()).toBe(100n);
    expect(attacker.gold()).toBe(before);
    expect(diplomacy.answerPeace(warId, proposalId!, teammate!, true)).toBe(
      true,
    );
    expect(defender.gold()).toBe(20n);
    expect(attacker.gold()).toBe(before + 80n);
    expect(diplomacy.answerPeace(warId, proposalId!, teammate!, true)).toBe(
      false,
    );
    expect(diplomacy.getWar(warId)?.status).toBe("truce");
  });

  test("an unaffordable final offer expires without partial payment or truce", async () => {
    const { diplomacy, warId, attacker, defender } = await makeWar();
    diplomacy.recordTroopLoss(warId, attacker, defender, 10_000);
    defender.addGold(100n);
    const proposalId = diplomacy.proposePeace(warId, attacker, {
      kind: "reparations",
      payerId: defender.id(),
      receiverId: attacker.id(),
      amount: 80,
    });
    defender.removeGold(30n);

    expect(diplomacy.answerPeace(warId, proposalId!, defender, true)).toBe(
      false,
    );
    expect(attacker.gold()).toBe(0n);
    expect(defender.gold()).toBe(70n);
    expect(diplomacy.getWar(warId)?.status).toBe("active");
  });

  test("puppetization requires the score threshold and creates a one-tier puppet", async () => {
    const { diplomacy, warId, attacker, defender, defenderTiles } =
      await makeWar({
        defenderLand: 10,
      });
    const tooEarly = diplomacy.proposePeace(warId, attacker, {
      kind: "puppet",
      targetId: defender.id(),
      overlordId: attacker.id(),
    });
    expect(tooEarly).toBeNull();

    defenderTiles.slice(0, 9).forEach((tile) => attacker.conquer(tile));
    diplomacy.recordTroopLoss(warId, attacker, defender, 10_000);
    const eligible = diplomacy.proposePeace(warId, attacker, {
      kind: "puppet",
      targetId: defender.id(),
      overlordId: attacker.id(),
    });
    expect(eligible).not.toBeNull();
    expect(diplomacy.answerPeace(warId, eligible!, defender, true)).toBe(true);
    expect(defender.isPuppetOf(attacker)).toBe(true);
    expect(attacker.subjects()).toContain(defender);
  });

  test("an independence clause releases only a participant puppet from its overlord", async () => {
    const game = await setup("plains");
    const overlord = addPlayer(
      game,
      "overlord",
      PlayerType.Human,
      ColoredTeams.Red,
    );
    const defender = addPlayer(
      game,
      "defender",
      PlayerType.Human,
      ColoredTeams.Blue,
    );
    const puppet = addPlayer(game, "puppet");
    overlord.conquer(game.ref(0, 0));
    defender.conquer(game.ref(40, 40));
    puppet.conquer(game.ref(20, 20));
    overlord.setTroops(100_000);
    for (let x = 1; x <= 20; x++) overlord.conquer(game.ref(x, 0));
    puppet.setTroops(1);
    expect(overlord.demandSubjugation(puppet)).toBe(true);
    expect(puppet.acceptSubjectRequest(overlord, "subjugation")).toBe(true);

    const diplomacy = game.warDiplomacy();
    const warId = diplomacy.beginHostileAction(overlord, defender)!;
    const proposalId = diplomacy.proposePeace(warId, overlord, {
      kind: "independence",
      subjectId: puppet.id(),
    })!;
    expect(diplomacy.answerPeace(warId, proposalId, defender, true)).toBe(true);
    expect(diplomacy.answerPeace(warId, proposalId, puppet, true)).toBe(true);
    expect(puppet.isSubject()).toBe(false);
    expect(overlord.subjects()).not.toContain(puppet);
  });

  test("expired proposals enter a deterministic cooldown and truce ends on its deadline", async () => {
    const { game, diplomacy, warId, attacker, defender } = await makeWar();
    const proposalId = diplomacy.proposePeace(warId, attacker, {
      kind: "whitePeace",
    })!;
    const proposal = diplomacy.getWar(warId)!.proposal!;

    vi.spyOn(game, "ticks").mockReturnValue(proposal.expiresAt);
    diplomacy.tick();
    expect(diplomacy.getWar(warId)?.status).toBe("active");
    expect(diplomacy.answerPeace(warId, proposalId, defender, true)).toBe(
      false,
    );
    expect(
      diplomacy.proposePeace(warId, attacker, { kind: "whitePeace" }),
    ).toBeNull();

    vi.mocked(game.ticks).mockReturnValue(proposal.expiresAt + 300);
    const renewed = diplomacy.proposePeace(warId, attacker, {
      kind: "whitePeace",
    })!;
    expect(diplomacy.answerPeace(warId, renewed, defender, true)).toBe(true);
    const truceEndsAt = diplomacy.getWar(warId)!.truceEndsAt!;

    vi.mocked(game.ticks).mockReturnValue(truceEndsAt - 1);
    diplomacy.tick();
    expect(diplomacy.getWar(warId)?.status).toBe("truce");
    vi.mocked(game.ticks).mockReturnValue(truceEndsAt);
    diplomacy.tick();
    expect(diplomacy.getWar(warId)?.status).toBe("ended");
  });

  test("call invitations expire and enforce a recipient cooldown", async () => {
    const { game, diplomacy, warId, attacker, ally } = await makeWar({
      ally: true,
    });
    const callID = diplomacy.createCallToArms(warId, attacker, ally)!;
    const call = diplomacy
      .getWar(warId)!
      .calls.find((entry) => entry.id === callID)!;

    vi.spyOn(game, "ticks").mockReturnValue(call.expiresAt);
    diplomacy.tick();
    expect(
      diplomacy.getWar(warId)?.calls.find((entry) => entry.id === callID)
        ?.status,
    ).toBe("expired");
    expect(diplomacy.createCallToArms(warId, attacker, ally)).toBeNull();
    vi.mocked(game.ticks).mockReturnValue(call.expiresAt + 300);
    expect(diplomacy.createCallToArms(warId, attacker, ally)).not.toBeNull();
  });

  test("war diplomacy intents reject missing identifiers and unsafe reparations amounts", () => {
    expect(
      WarDiplomacyIntentSchema.safeParse({
        type: "war_call_to_arms",
        warId: 1,
        recipient: "recipient1",
      }).success,
    ).toBe(true);
    expect(
      WarDiplomacyIntentSchema.safeParse({
        type: "war_answer_peace",
        warId: 1,
        accepted: true,
      }).success,
    ).toBe(false);
    expect(
      WarDiplomacyIntentSchema.safeParse({
        type: "war_propose_peace",
        warId: 1,
        clause: {
          kind: "reparations",
          payerId: "payer001",
          receiverId: "receive1",
          amount: Number.MAX_SAFE_INTEGER + 1,
        },
      }).success,
    ).toBe(false);
  });
});
