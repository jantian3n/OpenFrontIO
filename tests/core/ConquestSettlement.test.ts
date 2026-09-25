import { AttackExecution } from "../../src/core/execution/AttackExecution";
import { ConquestSettlementExecution } from "../../src/core/execution/ConquestSettlementExecution";
import { Executor } from "../../src/core/execution/ExecutionManager";
import {
  CONQUEST_SETTLEMENT_DURATION_TICKS,
  ConquestSettlementDecision,
  Execution,
  Game,
  GameUpdates,
  Player,
  PlayerInfo,
  PlayerType,
} from "../../src/core/game/Game";
import { GameUpdateType } from "../../src/core/game/GameUpdates";
import {
  ConquestSettleIntentSchema,
  StampedIntent,
} from "../../src/core/Schemas";
import { setup } from "../util/Setup";

const GAME_ID = "conquest_test";

/** Pends a conquest the way AttackExecution/PlayerExecution trigger it, but
 * on a deterministic tick of its own so tests can assert the update shape. */
class StartConquestSettleExecution implements Execution {
  private active = true;

  constructor(
    private readonly game: Game,
    private readonly conqueror: Player,
    private readonly conquered: Player,
  ) {}

  init(): void {}

  tick(): void {
    this.game.startConquestSettle(this.conqueror, this.conquered);
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}

async function setupGame() {
  const game = await setup("plains", {}, [
    new PlayerInfo("conqueror", PlayerType.Human, "conqueror", "conqueror"),
    new PlayerInfo("victim", PlayerType.Human, "victim", "victim"),
    new PlayerInfo("other", PlayerType.Human, "other", "other"),
  ]);
  const conqueror = game.player("conqueror");
  const victim = game.player("victim");
  const other = game.player("other");
  conqueror.conquer(game.ref(0, 0));
  victim.conquer(game.ref(0, 1));
  victim.conquer(game.ref(0, 2));
  victim.conquer(game.ref(0, 3));
  other.conquer(game.ref(40, 40));
  return {
    game,
    conqueror,
    victim,
    other,
    executor: new Executor(game, GAME_ID, undefined),
  };
}

function pend(game: Game, conqueror: Player, victim: Player): void {
  game.addExecution(new StartConquestSettleExecution(game, conqueror, victim));
  game.executeNextTick(); // init tick: executions added between ticks first init here
  const before = game.ticks();
  const updates = game.executeNextTick();
  expect(updates[GameUpdateType.ConquestPending]).toEqual([
    {
      type: GameUpdateType.ConquestPending,
      conquerorId: conqueror.id(),
      conqueredId: victim.id(),
      expiresAt: before + CONQUEST_SETTLEMENT_DURATION_TICKS,
    },
  ]);
  expect(game.hasPendingConquest(victim)).toBe(true);
}

/** Sends a `conquest_settle` intent through the real intent -> execution
 * pipeline (Executor.createExec) and returns the resulting tick's updates. */
function settle(
  game: Game,
  executor: Executor,
  senderClientID: string,
  decision: ConquestSettlementDecision,
  amount?: number,
): GameUpdates {
  const intent: StampedIntent = {
    type: "conquest_settle",
    clientID: senderClientID,
    targetId: "victim",
    decision,
    ...(amount !== undefined ? { amount } : {}),
  };
  game.addExecution(executor.createExec(intent));
  game.executeNextTick(); // init tick: executions added between ticks first init here
  return game.executeNextTick();
}

describe("conquest settlement triggering", () => {
  test("a human conqueror's conquest pends instead of resolving immediately", async () => {
    const { game, conqueror, victim } = await setupGame();
    pend(game, conqueror, victim);

    expect(victim.isAlive()).toBe(true);
    expect(victim.numTilesOwned()).toBe(3);
    expect(game.hasPendingConquest(victim)).toBe(true);
  });

  test("the attack trigger tick pends the conquest and freezes the border right away", async () => {
    const { game, conqueror, victim } = await setupGame();
    conqueror.setTroops(10_000);
    game.addExecution(new AttackExecution(100, conqueror, victim.id()));

    let triggerUpdates: GameUpdates | null = null;
    let before = game.ticks();
    for (let i = 0; i < 10; i++) {
      before = game.ticks();
      const updates = game.executeNextTick();
      if (updates[GameUpdateType.ConquestPending].length > 0) {
        triggerUpdates = updates;
        break;
      }
    }
    expect(triggerUpdates).not.toBeNull();
    expect(triggerUpdates![GameUpdateType.ConquestPending]).toEqual([
      {
        type: GameUpdateType.ConquestPending,
        conquerorId: "conqueror",
        conqueredId: "victim",
        expiresAt: before + CONQUEST_SETTLEMENT_DURATION_TICKS,
      },
    ]);
    expect(triggerUpdates![GameUpdateType.ConquestEvent]).toHaveLength(0);
    // Exactly the first border tile fell before the settlement pended; the
    // conquest loop must not take another one on the same tick.
    expect(victim.numTilesOwned()).toBe(2);
    expect(victim.isAlive()).toBe(true);

    // And the pending target stays frozen: the attack retreats instead of
    // continuing to chew through the remaining territory.
    for (let i = 0; i < 5; i++) {
      const updates = game.executeNextTick();
      expect(updates[GameUpdateType.ConquestSettled]).toHaveLength(0);
    }
    expect(victim.numTilesOwned()).toBe(2);
    expect(victim.isAlive()).toBe(true);
    expect(game.hasPendingConquest(victim)).toBe(true);
  });

  test("a bot conqueror annexes immediately with no pending settlement", async () => {
    const { game, victim } = await setupGame();
    game.addPlayer(new PlayerInfo("bot", PlayerType.Bot, "bot", "bot"));
    const bot = game.player("bot");
    bot.conquer(game.ref(1, 1)); // a border next to the victim to attack from
    bot.setTroops(10_000);
    bot.addGold(600n);
    victim.addGold(1000n);
    // A human who never attacked transfers no gold; record one attack so the
    // annex gold assertions below are meaningful.
    game.stats().attack(victim, game.terraNullius(), 100);

    game.addExecution(new AttackExecution(100, bot, victim.id()));
    let pending = 0;
    let conquests = 0;
    for (let i = 0; i < 15 && victim.isAlive(); i++) {
      const updates = game.executeNextTick();
      pending += updates[GameUpdateType.ConquestPending].length;
      conquests += updates[GameUpdateType.ConquestEvent].length;
    }

    expect(victim.isAlive()).toBe(false);
    expect(pending).toBe(0);
    expect(conquests).toBe(1);
    expect(game.hasPendingConquest(victim)).toBe(false);
    expect(victim.gold()).toBe(0n);
    // Humans surrender half their gold: 600 + 1000 / 2.
    expect(bot.gold()).toBe(1100n);
  });

  test("a victim already reduced to zero tiles settles on the spot, never pending", async () => {
    const { game, conqueror, victim } = await setupGame();
    victim.addGold(1000n);
    // The victim attacked once, so it counts as active and its gold moves.
    game.stats().attack(victim, game.terraNullius(), 100);
    const goldBefore = conqueror.gold();
    // Simulate the attack taking the victim's last tile: the trigger then
    // sees a dead target with nothing left to keep.
    for (const tile of [...victim.tiles()]) {
      conqueror.conquer(tile);
    }
    expect(victim.isAlive()).toBe(false);

    game.startConquestSettle(conqueror, victim);

    // Pending a corpse would strand the settlement: expiry drops dead
    // targets without annexing and executeConquestSettle refuses them.
    expect(game.hasPendingConquest(victim)).toBe(false);
    expect(victim.gold()).toBe(0n);
    expect(conqueror.gold()).toBe(goldBefore + 500n);
  });

  test("the executor dispatches conquest_settle intents", async () => {
    const { executor } = await setupGame();
    const exec = executor.createExec({
      type: "conquest_settle",
      clientID: "conqueror",
      targetId: "victim",
      decision: "release",
    });
    expect(exec).toBeInstanceOf(ConquestSettlementExecution);
  });
});

describe("conquest settlement decisions", () => {
  test("annex transfers gold, hands over the territory and eliminates the victim", async () => {
    const { game, conqueror, victim, executor } = await setupGame();
    victim.addGold(1000n);
    game.stats().attack(victim, game.terraNullius(), 100);
    pend(game, conqueror, victim);
    const goldBefore = conqueror.gold();

    const updates = settle(game, executor, "conqueror", "annex");

    expect(updates[GameUpdateType.ConquestSettled]).toEqual([
      {
        type: GameUpdateType.ConquestSettled,
        conquerorId: "conqueror",
        conqueredId: "victim",
        decision: "annex",
        gold: 500n,
      },
    ]);
    expect(victim.isAlive()).toBe(false);
    expect(victim.numTilesOwned()).toBe(0);
    expect(victim.gold()).toBe(0n);
    expect(conqueror.gold()).toBe(goldBefore + 500n);
    expect(conqueror.numTilesOwned()).toBe(4);
    expect(game.hasPendingConquest(victim)).toBe(false);
    expect(updates[GameUpdateType.ConquestEvent]).toHaveLength(1);
    const messages = updates[GameUpdateType.DisplayEvent].map(
      (e) => e.message,
    );
    expect(messages).toContain("events_display.received_gold_from_conquest");
    expect(messages).toContain("events_display.settled_conquest_annex");
  });

  test("puppet keeps the victim alive as a subject and converts the war to a truce", async () => {
    const { game, conqueror, victim, executor } = await setupGame();
    const warId = game
      .warDiplomacy()
      .beginHostileAction(conqueror, victim)!;
    pend(game, conqueror, victim);
    const goldBefore = conqueror.gold();

    const updates = settle(game, executor, "conqueror", "puppet");

    expect(updates[GameUpdateType.ConquestSettled]).toEqual([
      {
        type: GameUpdateType.ConquestSettled,
        conquerorId: "conqueror",
        conqueredId: "victim",
        decision: "puppet",
        gold: 0n,
      },
    ]);
    expect(victim.isAlive()).toBe(true);
    expect(victim.numTilesOwned()).toBe(3);
    expect(victim.isSubject()).toBe(true);
    expect(victim.overlord()).toBe(conqueror);
    expect(conqueror.gold()).toBe(goldBefore);
    expect(game.warDiplomacy().getWar(warId)?.status).toBe("truce");
    expect(game.hasPendingConquest(victim)).toBe(false);
  });

  test("reparations clamp to the victim's treasury and convert the war to a truce", async () => {
    const { game, conqueror, victim, executor } = await setupGame();
    const warId = game
      .warDiplomacy()
      .beginHostileAction(conqueror, victim)!;
    victim.addGold(1000n);
    pend(game, conqueror, victim);
    const goldBefore = conqueror.gold();

    const updates = settle(
      game,
      executor,
      "conqueror",
      "reparations",
      999_999_999,
    );

    expect(updates[GameUpdateType.ConquestSettled]).toEqual([
      {
        type: GameUpdateType.ConquestSettled,
        conquerorId: "conqueror",
        conqueredId: "victim",
        decision: "reparations",
        gold: 1000n,
      },
    ]);
    expect(victim.gold()).toBe(0n);
    expect(conqueror.gold()).toBe(goldBefore + 1000n);
    expect(victim.isAlive()).toBe(true);
    expect(victim.numTilesOwned()).toBe(3);
    expect(game.warDiplomacy().getWar(warId)?.status).toBe("truce");

    // A smaller demand pays exactly what was asked.
    victim.addGold(400n);
    pend(game, conqueror, victim);
    const second = settle(game, executor, "conqueror", "reparations", 150);
    expect(second[GameUpdateType.ConquestSettled][0].gold).toBe(150n);
    expect(victim.gold()).toBe(250n);
  });

  test("release keeps the victim, its gold and its land, and only truces the war", async () => {
    const { game, conqueror, victim, executor } = await setupGame();
    const warId = game
      .warDiplomacy()
      .beginHostileAction(conqueror, victim)!;
    victim.addGold(250n);
    pend(game, conqueror, victim);

    const updates = settle(game, executor, "conqueror", "release");

    expect(updates[GameUpdateType.ConquestSettled]).toEqual([
      {
        type: GameUpdateType.ConquestSettled,
        conquerorId: "conqueror",
        conqueredId: "victim",
        decision: "release",
        gold: 0n,
      },
    ]);
    expect(victim.isAlive()).toBe(true);
    expect(victim.numTilesOwned()).toBe(3);
    expect(victim.gold()).toBe(250n);
    expect(game.warDiplomacy().getWar(warId)?.status).toBe("truce");
    expect(game.hasPendingConquest(victim)).toBe(false);
  });
});

describe("conquest settlement rejection", () => {
  test("a player who is not the conqueror cannot settle the conquest", async () => {
    const { game, conqueror, victim, other, executor } = await setupGame();
    pend(game, conqueror, victim);

    const updates = settle(game, executor, "other", "annex");

    expect(updates[GameUpdateType.ConquestSettled]).toHaveLength(0);
    expect(game.hasPendingConquest(victim)).toBe(true);
    expect(victim.isAlive()).toBe(true);
    expect(other.numTilesOwned()).toBe(1);
  });

  test("a settlement cannot be applied twice", async () => {
    const { game, conqueror, victim, executor } = await setupGame();
    pend(game, conqueror, victim);

    const first = settle(game, executor, "conqueror", "release");
    expect(first[GameUpdateType.ConquestSettled]).toHaveLength(1);

    const second = settle(game, executor, "conqueror", "annex");
    expect(second[GameUpdateType.ConquestSettled]).toHaveLength(0);
    // The stale annex is ignored: the release already stood.
    expect(victim.isAlive()).toBe(true);
  });

  test("an expired settlement auto-annexes and later settles are rejected", async () => {
    const { game, conqueror, victim, executor } = await setupGame();
    victim.addGold(1000n);
    game.stats().attack(victim, game.terraNullius(), 100);
    pend(game, conqueror, victim);
    const goldBefore = conqueror.gold();

    for (let i = 0; i < CONQUEST_SETTLEMENT_DURATION_TICKS - 1; i++) {
      const updates = game.executeNextTick();
      expect(updates[GameUpdateType.ConquestSettled]).toHaveLength(0);
      expect(game.hasPendingConquest(victim)).toBe(true);
    }

    const updates = game.executeNextTick();
    expect(updates[GameUpdateType.ConquestSettled]).toEqual([
      {
        type: GameUpdateType.ConquestSettled,
        conquerorId: "conqueror",
        conqueredId: "victim",
        decision: "annex",
        gold: 500n,
      },
    ]);
    expect(victim.isAlive()).toBe(false);
    expect(conqueror.gold()).toBe(goldBefore + 500n);
    expect(game.hasPendingConquest(victim)).toBe(false);

    // A settle intent arriving after expiry is ignored.
    const late = settle(game, executor, "conqueror", "annex");
    expect(late[GameUpdateType.ConquestSettled]).toHaveLength(0);
  });
});

describe("conquest_settle intent schema", () => {
  test("accepts the four decisions and rejects malformed ones", () => {
    for (const decision of ["annex", "puppet", "reparations", "release"]) {
      expect(
        ConquestSettleIntentSchema.safeParse({
          type: "conquest_settle",
          targetId: "victim001",
          decision,
        }).success,
      ).toBe(true);
    }
    expect(
      ConquestSettleIntentSchema.safeParse({
        type: "conquest_settle",
        targetId: "victim001",
        decision: "destroy",
      }).success,
    ).toBe(false);
    expect(
      ConquestSettleIntentSchema.safeParse({
        type: "conquest_settle",
        targetId: "victim001",
        decision: "reparations",
        amount: -1,
      }).success,
    ).toBe(false);
    expect(
      ConquestSettleIntentSchema.safeParse({
        type: "conquest_settle",
        targetId: "victim001",
        decision: "reparations",
        amount: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
  });
});
