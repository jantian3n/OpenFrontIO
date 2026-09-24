import { SendWarDiplomacyIntentEvent } from "../../src/client/Transport";
import { WarDiplomacyPanel } from "../../src/client/hud/layers/WarDiplomacyPanel";
import type { GameView, PlayerView } from "../../src/client/view";
import { EventBus } from "../../src/core/EventBus";
import type { WarSnapshot } from "../../src/core/game/WarDiplomacy";

vi.mock("../../src/client/Utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Utils")>()),
  translateText: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}|${Object.values(params).join(",")}` : key,
}));

function player(id: string, name: string, gold = 1000): PlayerView {
  return {
    id: () => id,
    smallID: () => Number(id.replace(/\D/g, "")) || 1,
    displayName: () => name,
    isAlive: () => true,
    gold: () => BigInt(gold),
    goldEarned: () => 250,
    tradeGold: () => 30,
    trainGold: () => 20,
    piracyGold: () => 10,
    allies: () => [],
    incomingAttacks: () => [],
    outgoingAttacks: () => [],
    subjects: () => [],
    isPuppet: () => false,
    overlord: () => null,
  } as unknown as PlayerView;
}

function war(overrides: Partial<WarSnapshot> = {}): WarSnapshot {
  return {
    id: 7,
    createdAt: 10,
    status: "active",
    sides: [
      {
        participants: [
          { playerID: "p1", joinedAt: 10, reason: "attacker", isAlive: true },
        ],
        score: {
          territory: 400,
          militaryLosses: 250,
          structures: 100,
          total: 750,
        },
      },
      {
        participants: [
          { playerID: "p2", joinedAt: 10, reason: "defender", isAlive: true },
        ],
        score: {
          territory: 200,
          militaryLosses: 50,
          structures: 0,
          total: 250,
        },
      },
    ],
    calls: [],
    events: [],
    ...overrides,
  };
}

function setupPanel(wars: WarSnapshot[] = [], mine = player("p1", "Aster")) {
  const game = {
    wars: () => wars,
    ticks: () => 100,
    myPlayer: () => mine,
    player: (id: string) =>
      id === "p1" ? mine : player(id, id === "p2" ? "Boreal" : `Player ${id}`),
  } as unknown as GameView;
  const eventBus = new EventBus();
  const panel = new WarDiplomacyPanel();
  panel.game = game;
  panel.eventBus = eventBus;
  document.body.append(panel);
  return { panel, eventBus };
}

describe("WarDiplomacyPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("opens with an empty state when no wars are active", async () => {
    const { panel } = setupPanel();
    await panel.updateComplete;
    panel
      .querySelector<HTMLButtonElement>(
        "[aria-controls='war-diplomacy-content']",
      )!
      .click();
    await panel.updateComplete;

    expect(panel.textContent).toContain("war_panel.title");
    expect(panel.textContent).toContain("war_panel.empty");
  });

  it("shows sides and the full war score breakdown", async () => {
    const { panel } = setupPanel([war()]);
    await panel.updateComplete;
    panel
      .querySelector<HTMLButtonElement>(
        "[aria-controls='war-diplomacy-content']",
      )!
      .click();
    await panel.updateComplete;

    expect(panel.textContent).toContain("Aster");
    expect(panel.textContent).toContain("Boreal");
    expect(panel.textContent).toContain("war_panel.score_territory");
    expect(panel.textContent).toContain("war_panel.score_military");
    expect(panel.textContent).toContain("war_panel.score_structures");
    expect(panel.textContent).toContain("war_panel.economy");
    expect(panel.textContent).toContain("war_panel.treasury");
    expect(panel.textContent).toContain("war_panel.defense");
    expect(panel.textContent).toContain("war_panel.no_visible_threats");
  });

  it("sends call-to-arms accept and reject intents", async () => {
    const invite = {
      id: 31,
      inviterID: "p2",
      recipientID: "p1",
      side: 1,
      createdAt: 90,
      expiresAt: 120,
      status: "pending",
    } as const;
    const { panel, eventBus } = setupPanel([war({ calls: [invite] })]);
    const sent: unknown[] = [];
    eventBus.on(SendWarDiplomacyIntentEvent, (event) =>
      sent.push(event.intent),
    );
    await panel.updateComplete;
    panel
      .querySelector<HTMLButtonElement>(
        "[aria-controls='war-diplomacy-content']",
      )!
      .click();
    await panel.updateComplete;

    panel
      .querySelector<HTMLButtonElement>("[data-action='answer-call-accept']")!
      .click();
    await panel.updateComplete;
    expect(sent).toContainEqual({
      type: "war_answer_call",
      warId: 7,
      accepted: true,
    });
    expect(
      panel.querySelector("[data-action='answer-call-reject']"),
    ).not.toBeNull();
  });

  it("sends a rejected call-to-arms response", async () => {
    const invite = {
      id: 31,
      inviterID: "p2",
      recipientID: "p1",
      side: 1,
      createdAt: 90,
      expiresAt: 120,
      status: "pending",
    } as const;
    const { panel, eventBus } = setupPanel([war({ calls: [invite] })]);
    const sent: unknown[] = [];
    eventBus.on(SendWarDiplomacyIntentEvent, (event) =>
      sent.push(event.intent),
    );
    await panel.updateComplete;
    panel
      .querySelector<HTMLButtonElement>(
        "[aria-controls='war-diplomacy-content']",
      )!
      .click();
    await panel.updateComplete;
    panel
      .querySelector<HTMLButtonElement>("[data-action='answer-call-reject']")!
      .click();

    expect(sent).toContainEqual({
      type: "war_answer_call",
      warId: 7,
      accepted: false,
    });
  });

  it("sends a call-to-arms intent for a formal ally", async () => {
    const mine = player("p1", "Aster");
    const ally = player("p3", "Cinder");
    (mine as unknown as { allies: () => PlayerView[] }).allies = () => [ally];
    const { panel, eventBus } = setupPanel([war()], mine);
    const sent: unknown[] = [];
    eventBus.on(SendWarDiplomacyIntentEvent, (event) =>
      sent.push(event.intent),
    );
    await panel.updateComplete;
    panel
      .querySelector<HTMLButtonElement>(
        "[aria-controls='war-diplomacy-content']",
      )!
      .click();
    await panel.updateComplete;

    panel
      .querySelector<HTMLButtonElement>("[data-action='call-ally']")!
      .click();
    expect(sent).toContainEqual({
      type: "war_call_to_arms",
      warId: 7,
      recipient: "p3",
    });
  });

  it("validates reparations input and lists every human signer", async () => {
    const active = war({
      sides: [
        {
          participants: [
            { playerID: "p1", joinedAt: 10, reason: "attacker", isAlive: true },
          ],
          score: {
            territory: 3000,
            militaryLosses: 500,
            structures: 0,
            total: 3500,
          },
        },
        {
          participants: [
            { playerID: "p2", joinedAt: 10, reason: "defender", isAlive: true },
          ],
          score: {
            territory: 500,
            militaryLosses: 0,
            structures: 0,
            total: 500,
          },
        },
      ],
    });
    const pending = war({
      id: 8,
      status: "peacePending",
      proposal: {
        id: 32,
        proposerID: "p2",
        createdAt: 90,
        expiresAt: 120,
        clause: {
          kind: "reparations",
          payerId: "p2",
          receiverId: "p1",
          amount: 500,
        },
        signatures: [
          { playerID: "p1", status: "pending" },
          { playerID: "p2", status: "accepted" },
        ],
      },
    });
    const { panel, eventBus } = setupPanel([active, pending]);
    const sent: unknown[] = [];
    eventBus.on(SendWarDiplomacyIntentEvent, (event) =>
      sent.push(event.intent),
    );
    await panel.updateComplete;
    panel
      .querySelector<HTMLButtonElement>(
        "[aria-controls='war-diplomacy-content']",
      )!
      .click();
    await panel.updateComplete;

    expect(panel.textContent).toContain("Boreal");
    expect(panel.textContent).toContain("war_panel.signature_pending");
    panel
      .querySelector<HTMLButtonElement>("[data-action='answer-peace-accept']")!
      .click();
    expect(sent).toContainEqual({
      type: "war_answer_peace",
      warId: 8,
      proposalId: 32,
      accepted: true,
    });
    const kindSelect = panel.querySelector<HTMLSelectElement>(
      "select[name='clause-kind']",
    )!;
    kindSelect.value = "reparations";
    kindSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await panel.updateComplete;
    const amountInput = panel.querySelector<HTMLInputElement>(
      "input[name='amount']",
    )!;
    expect(amountInput).not.toBeNull();
    amountInput.value = "2000";
    panel
      .querySelector<HTMLFormElement>("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await panel.updateComplete;
    expect(panel.textContent).toContain("war_panel.error_reparations");
  });

  it("shows truce timing and a narrow-viewport-safe drawer", async () => {
    const { panel } = setupPanel([war({ status: "truce", truceEndsAt: 180 })]);
    await panel.updateComplete;
    panel
      .querySelector<HTMLButtonElement>(
        "[aria-controls='war-diplomacy-content']",
      )!
      .click();
    await panel.updateComplete;

    expect(panel.textContent).toContain("war_panel.truce");
    expect(panel.querySelector(".max-w-xl")).not.toBeNull();
    expect(panel.querySelector("[data-remaining-ticks='80']")).not.toBeNull();
  });
});
