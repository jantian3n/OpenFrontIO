import { ConquestSettlementModal } from "../../src/client/hud/layers/ConquestSettlementModal";
import {
  PauseGameIntentEvent,
  SendConquestSettleIntentEvent,
} from "../../src/client/Transport";
import type { GameView, PlayerView } from "../../src/client/view";
import { EventBus } from "../../src/core/EventBus";
import type { GameUpdates } from "../../src/core/game/Game";
import { GameType, PlayerType } from "../../src/core/game/Game";
import {
  ConquestPendingUpdate,
  ConquestSettledUpdate,
  GameUpdateType,
} from "../../src/core/game/GameUpdates";

vi.mock("../../src/client/Utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Utils")>()),
  translateText: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}|${Object.values(params).join(",")}` : key,
}));

function player(
  id: string,
  opts: { gold?: number; tiles?: number; type?: PlayerType } = {},
): PlayerView {
  const { gold = 0, tiles = 0, type = PlayerType.Human } = opts;
  return {
    id: () => id,
    smallID: () => Number(id.replace(/\D/g, "")) || 1,
    displayName: () => `Name-${id}`,
    isAlive: () => true,
    isPlayer: () => true,
    gold: () => BigInt(gold),
    numTilesOwned: () => tiles,
    type: () => type,
  } as unknown as PlayerView;
}

function setup(opts: { gameType?: GameType } = {}) {
  const mine = player("p1", { gold: 500 });
  const target = player("p2", { gold: 1000, tiles: 47 });
  const rival = player("p3");
  const players = [mine, target, rival];
  const ticks = 100;
  let gameOver = false;
  let updates: GameUpdates | null = null;

  const game = {
    myPlayer: () => mine,
    ticks: () => ticks,
    gameOver: () => gameOver,
    player: (id: string) => {
      const found = players.find((p) => p.id() === id);
      if (found === undefined) throw new Error(`player ${id} not found`);
      return found;
    },
    updatesSinceLastTick: () => updates,
    config: () => ({
      gameConfig: () => ({ gameType: opts.gameType ?? GameType.Public }),
      isReplay: () => false,
    }),
  } as unknown as GameView;

  const bus = new EventBus();
  const modal = new ConquestSettlementModal();
  modal.game = game;
  modal.initEventBus(bus);
  document.body.append(modal);

  const events: string[] = [];
  bus.on(PauseGameIntentEvent, (e) => events.push(`pause:${e.paused}`));
  bus.on(SendConquestSettleIntentEvent, (e) =>
    events.push(`settle:${JSON.stringify(e.intent)}`),
  );

  const batch = (partial: Partial<GameUpdates> = {}): GameUpdates =>
    ({
      [GameUpdateType.GamePaused]: [],
      [GameUpdateType.ConquestPending]: [],
      [GameUpdateType.ConquestSettled]: [],
      ...partial,
    }) as unknown as GameUpdates;

  const push = async (partial: Partial<GameUpdates> = {}) => {
    updates = batch(partial);
    modal.tick();
    await modal.updateComplete;
  };

  const pending = (
    conquerorId: string,
    conqueredId = "p2",
    expiresAt = 400,
  ): ConquestPendingUpdate => ({
    type: GameUpdateType.ConquestPending,
    conquerorId,
    conqueredId,
    expiresAt,
  });

  const settled = (
    conquerorId: string,
    conqueredId = "p2",
  ): ConquestSettledUpdate => ({
    type: GameUpdateType.ConquestSettled,
    conquerorId,
    conqueredId,
    decision: "annex",
    gold: 1000n,
  });

  const dialog = () => modal.querySelector('[role="dialog"]');

  const select = async (decision: string) => {
    const input = modal.querySelector<HTMLInputElement>(
      `[data-decision="${decision}"] input`,
    );
    expect(input, `option ${decision} exists`).not.toBeNull();
    input!.checked = true;
    input!.dispatchEvent(new Event("change", { bubbles: true }));
    await modal.updateComplete;
  };

  const confirm = async () => {
    const button = modal.querySelector<HTMLButtonElement>(
      '[data-action="confirm"]',
    );
    expect(button, "confirm button exists").not.toBeNull();
    button!.click();
    await modal.updateComplete;
  };

  return {
    modal,
    bus,
    game,
    mine,
    target,
    rival,
    events,
    push,
    pending,
    settled,
    dialog,
    select,
    confirm,
    setGameOver: (value: boolean) => {
      gameOver = value;
    },
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("conquest settlement modal", () => {
  it("opens on my ConquestPending with target stats and a countdown", async () => {
    const { push, pending, dialog, modal } = setup();
    expect(dialog()).toBeNull();
    await push({ [GameUpdateType.ConquestPending]: [pending("p1")] });
    expect(dialog()).not.toBeNull();
    const text = modal.textContent ?? "";
    expect(text).toContain("Name-p2");
    expect(text).toContain("conquest_settlement.territory|47");
    expect(text).toContain("conquest_settlement.gold|1.00K");
    expect(text).toContain("conquest_settlement.time_left|");
    const timer = modal.querySelector('[role="timer"]');
    expect(timer?.getAttribute("data-remaining-ticks")).toBe("300");
    expect(
      modal.querySelector('[data-action="confirm"]')?.hasAttribute("disabled"),
    ).toBe(true);
  });

  it("stays closed for someone else's conquest", async () => {
    const { push, pending, dialog } = setup();
    await push({ [GameUpdateType.ConquestPending]: [pending("p3")] });
    expect(dialog()).toBeNull();
  });

  it("renders all four options with their consequence copy", async () => {
    const { push, pending, modal } = setup();
    await push({ [GameUpdateType.ConquestPending]: [pending("p1")] });
    const cards = modal.querySelectorAll("[data-decision]");
    expect(
      Array.from(cards).map((card) => card.getAttribute("data-decision")),
    ).toEqual(["annex", "puppet", "reparations", "release"]);
    const text = modal.textContent ?? "";
    for (const key of [
      "conquest_settlement.annex",
      "conquest_settlement.annex_desc",
      "conquest_settlement.puppet",
      "conquest_settlement.puppet_desc",
      "conquest_settlement.reparations",
      "conquest_settlement.reparations_desc",
      "conquest_settlement.release",
      "conquest_settlement.release_desc",
    ]) {
      expect(text, `${key} rendered`).toContain(key);
    }
    // annex_desc surfaces the gold the conqueror stands to gain.
    expect(text).toContain("conquest_settlement.annex_desc|Name-p2,500");
  });

  it("defaults the reparations amount to the target treasury and clamps it", async () => {
    const { push, pending, modal, select, confirm, events } = setup();
    await push({ [GameUpdateType.ConquestPending]: [pending("p1")] });
    await select("reparations");
    const input = modal.querySelector<HTMLInputElement>(
      '[data-role="reparations-amount"]',
    );
    expect(input).not.toBeNull();
    expect(input!.value).toBe("1000");

    // Over the treasury: clamped back down on the next render.
    input!.value = "999999";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await modal.updateComplete;
    expect(
      modal.querySelector<HTMLInputElement>('[data-role="reparations-amount"]')!
        .value,
    ).toBe("1000");
    await confirm();
    expect(JSON.parse(events[events.length - 1].split("settle:")[1])).toEqual({
      type: "conquest_settle",
      targetId: "p2",
      decision: "reparations",
      amount: 1000,
    });

    // Below zero: clamped to 0.
    await push({ [GameUpdateType.ConquestPending]: [pending("p1")] });
    await select("reparations");
    const fresh = modal.querySelector<HTMLInputElement>(
      '[data-role="reparations-amount"]',
    )!;
    fresh.value = "-50";
    fresh.dispatchEvent(new Event("input", { bubbles: true }));
    await modal.updateComplete;
    await confirm();
    expect(JSON.parse(events[events.length - 1].split("settle:")[1])).toEqual({
      type: "conquest_settle",
      targetId: "p2",
      decision: "reparations",
      amount: 0,
    });
  });

  it("emits conquest_settle with the selected decision and closes", async () => {
    const { push, pending, select, confirm, dialog, events } = setup();
    await push({ [GameUpdateType.ConquestPending]: [pending("p1")] });
    await select("annex");
    await confirm();
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].split("settle:")[1])).toEqual({
      type: "conquest_settle",
      targetId: "p2",
      decision: "annex",
    });
    expect(dialog()).toBeNull();
    // No pause traffic in multiplayer.
    expect(events.filter((e) => e.startsWith("pause:"))).toEqual([]);
  });

  it("closes when ConquestSettled arrives", async () => {
    const { push, pending, settled, dialog } = setup();
    await push({ [GameUpdateType.ConquestPending]: [pending("p1")] });
    expect(dialog()).not.toBeNull();
    await push({ [GameUpdateType.ConquestSettled]: [settled("p1")] });
    expect(dialog()).toBeNull();
  });

  it("does not open for a catch-up batch that already carries the settlement", async () => {
    const { push, pending, settled, dialog } = setup();
    await push({
      [GameUpdateType.ConquestPending]: [pending("p1")],
      [GameUpdateType.ConquestSettled]: [settled("p1")],
    });
    expect(dialog()).toBeNull();
  });

  it("holds and releases the singleplayer pause, resuming before settling", async () => {
    const { push, pending, select, confirm, events, settled } = setup({
      gameType: GameType.Singleplayer,
    });
    await push({ [GameUpdateType.ConquestPending]: [pending("p1")] });
    expect(events).toEqual(["pause:true"]);
    await select("puppet");
    await confirm();
    // LocalServer drops gameplay intents while paused, so the resume must
    // precede the settle intent.
    expect(events).toEqual([
      "pause:true",
      "pause:false",
      'settle:{"type":"conquest_settle","targetId":"p2","decision":"puppet"}',
    ]);
    // A later ConquestSettled must not resume a second time.
    await push({ [GameUpdateType.ConquestSettled]: [settled("p1")] });
    expect(events).toHaveLength(3);
  });

  it("releases the singleplayer pause when cancelled", async () => {
    const { push, pending, modal, dialog, events } = setup({
      gameType: GameType.Singleplayer,
    });
    await push({ [GameUpdateType.ConquestPending]: [pending("p1")] });
    expect(events).toEqual(["pause:true"]);
    modal.querySelector<HTMLButtonElement>('[data-action="cancel"]')!.click();
    await modal.updateComplete;
    expect(dialog()).toBeNull();
    expect(events).toEqual(["pause:true", "pause:false"]);
  });

  it("force-closes when the conqueror dies or the game ends", async () => {
    const { push, pending, dialog, events, mine, setGameOver } = setup({
      gameType: GameType.Singleplayer,
    });
    await push({ [GameUpdateType.ConquestPending]: [pending("p1")] });
    expect(events).toEqual(["pause:true"]);

    mine.isAlive = () => false;
    await push();
    expect(dialog()).toBeNull();
    expect(events).toEqual(["pause:true", "pause:false"]);

    // Game over takes the same path.
    mine.isAlive = () => true;
    await push({ [GameUpdateType.ConquestPending]: [pending("p1")] });
    expect(dialog()).not.toBeNull();
    setGameOver(true);
    await push();
    expect(dialog()).toBeNull();
    expect(events).toEqual([
      "pause:true",
      "pause:false",
      "pause:true",
      "pause:false",
    ]);
  });
});
