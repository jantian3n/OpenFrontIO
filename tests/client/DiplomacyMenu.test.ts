import {
  SendEmbargoIntentEvent,
  SendSubjectIntentEvent,
  SendWarDiplomacyIntentEvent,
} from "../../src/client/Transport";
import {
  rootMenuElement,
  type MenuElementParams,
} from "../../src/client/hud/layers/ContextMenuElements";
import { PlayerActionHandler } from "../../src/client/hud/layers/PlayerActionHandler";
import { TextContextMenu } from "../../src/client/hud/layers/TextContextMenu";
import { OpenWarDiplomacyEvent } from "../../src/client/hud/layers/WarDiplomacyNavigation";
import { WarDiplomacyPanel } from "../../src/client/hud/layers/WarDiplomacyPanel";
import type { GameView, PlayerView } from "../../src/client/view";
import { EventBus } from "../../src/core/EventBus";
import type { PlayerInteraction } from "../../src/core/game/Game";
import type { WarSnapshot } from "../../src/core/game/WarDiplomacy";

vi.mock("../../src/client/Utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Utils")>()),
  translateText: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}|${Object.values(params).join(",")}` : key,
}));

function player(id: string): PlayerView {
  return {
    id: () => id,
    smallID: () => Number(id.slice(1)),
    name: () => id,
    displayName: () => id,
    isPlayer: () => true,
    isAlive: () => true,
    isFriendly: () => false,
    isAlliedWith: () => false,
    isOnSameTeam: () => false,
    isDisconnected: () => false,
    isSubjectOf: () => false,
    isInSubjectRelation: () => false,
    isSubject: () => false,
    isPuppet: () => false,
    autonomy: () => 50,
    overlord: () => null,
    subjects: () => [],
    allies: () => [],
    units: () => [],
    deleteUnitCooldown: () => 0,
    incomingAttacks: () => [],
    gold: () => 0n,
    goldEarned: () => 0,
    tradeGold: () => 0,
    trainGold: () => 0,
    piracyGold: () => 0,
  } as unknown as PlayerView;
}

function war(
  id = 7,
  target = "p2",
  status: WarSnapshot["status"] = "active",
): WarSnapshot {
  const score = { territory: 0, militaryLosses: 0, structures: 0, total: 0 };
  return {
    id,
    status,
    createdAt: 1,
    calls: [],
    events: [],
    sides: [
      {
        score,
        participants: [
          { playerID: "p1", joinedAt: 1, reason: "attacker", isAlive: true },
        ],
      },
      {
        score,
        participants: [
          { playerID: target, joinedAt: 1, reason: "defender", isAlive: true },
        ],
      },
    ],
  };
}

function setup(wars: WarSnapshot[] = [war()]) {
  const mine = player("p1");
  const enemy = player("p2");
  const ally = player("p3");
  const players = [mine, enemy, ally];
  const bus = new EventBus();
  const game = {
    wars: () => wars,
    myPlayer: () => mine,
    ticks: () => 100,
    units: () => [],
    player: (id: string) => players.find((p) => p.id() === id)!,
    inSpawnPhase: () => false,
    isLand: () => true,
    owner: () => enemy,
    config: () => ({ isRandomSpawn: () => false }),
  } as unknown as GameView;
  const panel = new WarDiplomacyPanel();
  panel.game = game;
  panel.initEventBus(bus);
  document.body.append(panel);
  const menu = new TextContextMenu(bus, rootMenuElement);
  const params = {
    myPlayer: mine,
    selected: enemy,
    tile: 1,
    game,
    eventBus: bus,
    playerActions: {
      canAttack: true,
      buildableUnits: [],
      interaction: {} as PlayerInteraction,
    },
    playerActionHandler: new PlayerActionHandler(bus, {} as any),
    closeMenu: () => menu.hide(),
  } as unknown as MenuElementParams;
  menu.init();
  const refresh = () => {
    menu.setParams(params);
    menu.show(50, 50);
  };
  refresh();
  const click = (id: string) => {
    const button = menu.container.querySelector<HTMLButtonElement>(`#${id}`);
    expect(button, `menu action ${id} exists`).not.toBeNull();
    button!.click();
    return button!;
  };
  const manage = () => click("diplomacy_manage");
  return {
    menu,
    panel,
    bus,
    game,
    params,
    mine,
    enemy,
    ally,
    click,
    manage,
    refresh,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("right-click diplomacy", () => {
  it("opens the enemy's peace form from the real root menu without sending a proposal", async () => {
    const { panel, menu, bus, click } = setup([war(), war(8, "p3")]);
    const sent = vi.fn();
    bus.on(SendWarDiplomacyIntentEvent, sent);
    click("diplomacy_peace");
    await panel.updateComplete;
    expect(menu.isVisible()).toBe(false);
    expect(panel.querySelectorAll("[data-war-id]")).toHaveLength(1);
    expect(
      panel.querySelector("[data-war-id='7'] select[name='clause-kind']"),
    ).not.toBeNull();
    expect(document.activeElement).toBe(
      panel.querySelector("select[name='clause-kind']"),
    );
    expect(sent).not.toHaveBeenCalled();
  });

  it("requires choosing between multiple wars and resets to all wars", async () => {
    const { panel, click } = setup([war(), war(8)]);
    click("diplomacy_peace");
    click("diplomacy_peace_8");
    await panel.updateComplete;
    expect(panel.querySelector("[data-war-id='7']")).toBeNull();
    expect(panel.querySelector("[data-war-id='8']")).not.toBeNull();
    panel
      .querySelector<HTMLButtonElement>("[data-action='show-all-wars']")!
      .click();
    await panel.updateComplete;
    expect(panel.querySelectorAll("[data-war-id]")).toHaveLength(2);
  });

  it("lets same-side signatories review pending peace", async () => {
    const negotiation = war(7, "p3", "peacePending");
    negotiation.sides[0].participants.push({
      playerID: "p2",
      joinedAt: 2,
      reason: "team",
      isAlive: true,
    });
    negotiation.proposal = {
      id: 1,
      proposerID: "p2",
      createdAt: 1,
      expiresAt: 300,
      clause: { kind: "whitePeace" },
      signatures: [{ playerID: "p1", status: "pending" }],
    };
    const { panel, click } = setup([negotiation]);
    click("diplomacy_peace");
    await panel.updateComplete;
    expect(
      panel.querySelector("[data-action='answer-peace-accept']"),
    ).not.toBeNull();
    expect(panel.querySelector("form")).toBeNull();
  });

  it.each(["truce", "ended"] as const)(
    "does not offer peace during %s",
    async (status) => {
      const { menu, panel, manage, click } = setup([war(7, "p2", status)]);
      expect(menu.container.querySelector("#diplomacy_peace")).toBeNull();
      manage();
      expect(click("diplomacy_peace").disabled).toBe(true);
      click("diplomacy_wars");
      await panel.updateComplete;
      expect(panel.querySelector("form")).toBeNull();
      expect(panel.textContent).toContain(
        status === "truce"
          ? "war_panel.status_truce"
          : "war_panel.empty_target",
      );
    },
  );

  it("shows an explanation before war and hides diplomacy on unowned land", () => {
    const { menu, params, manage, refresh } = setup([]);
    manage();
    expect(menu.container.textContent).toContain(
      "context_menu.reason.no_opposing_war",
    );
    params.selected = null;
    refresh();
    expect(menu.container.querySelector("#diplomacy_manage")).toBeNull();
  });

  it("offers only the war overview in own-country diplomacy", () => {
    const { menu, params, mine, manage, refresh } = setup();
    params.selected = mine;
    refresh();
    manage();
    expect(menu.container.querySelectorAll("[role='menuitem']")).toHaveLength(
      2,
    ); // Back + overview
    expect(menu.container.querySelector("#diplomacy_wars")).not.toBeNull();
  });

  it.each(["spawn", "defeated"])(
    "blocks diplomatic mutations while %s",
    (state) => {
      const { game, enemy, params, bus, refresh, manage, click } = setup();
      params.playerActions.interaction!.canDemandSubjugation = true;
      if (state === "spawn") game.inSpawnPhase = () => true;
      else enemy.isAlive = () => false;
      const sent = vi.fn();
      bus.on(SendSubjectIntentEvent, sent);
      refresh();
      expect(click("diplomacy_peace").disabled).toBe(true);
      manage();
      expect(click("diplomacy_demand_subjugation").disabled).toBe(true);
      expect(sent).not.toHaveBeenCalled();
    },
  );

  it("preselects the right ally without immediately sending a call", async () => {
    const { mine, ally, params, bus, panel, refresh, manage, click } = setup();
    const otherAlly = player("p4");
    mine.isAlliedWith = (target) => target === ally;
    mine.allies = () => [otherAlly, ally];
    params.selected = ally;
    const sent = vi.fn();
    bus.on(SendWarDiplomacyIntentEvent, sent);
    refresh();
    manage();
    click("diplomacy_call_ally");
    click("diplomacy_call_7");
    await panel.updateComplete;
    expect(panel.querySelector<HTMLSelectElement>("#war-call-7")?.value).toBe(
      "p3",
    );
    expect(sent).not.toHaveBeenCalled();
    panel
      .querySelector<HTMLButtonElement>("[data-action='call-ally']")!
      .click();
    expect(sent.mock.calls[0][0].intent).toEqual({
      type: "war_call_to_arms",
      warId: 7,
      recipient: "p3",
    });
  });

  it("opens an incoming call even though the player is not a participant yet", async () => {
    const invitation = war();
    invitation.sides[0].participants[0].playerID = "p3";
    invitation.calls.push({
      id: 1,
      inviterID: "p2",
      recipientID: "p1",
      side: 1,
      createdAt: 1,
      expiresAt: 300,
      status: "pending",
    });
    const { panel, manage, click } = setup([invitation]);
    manage();
    click("diplomacy_review_call");
    click("diplomacy_call_7");
    await panel.updateComplete;
    expect(
      panel.querySelector("[data-action='answer-call-accept']"),
    ).not.toBeNull();
  });

  it("does not silently switch to a different ally if the selected ally becomes ineligible", async () => {
    const { mine, enemy, ally, params, bus, panel, refresh, manage, click } =
      setup();
    const fallback = player("p4");
    mine.isAlliedWith = (target) => target === ally || target === fallback;
    mine.allies = () => [fallback, ally];
    params.selected = ally;
    const sent = vi.fn();
    bus.on(SendWarDiplomacyIntentEvent, sent);
    refresh();
    manage();
    click("diplomacy_call_ally");
    click("diplomacy_call_7");
    await panel.updateComplete;
    ally.isAlliedWith = (target) => target === enemy;
    panel.tick();
    await panel.updateComplete;
    const select = panel.querySelector<HTMLSelectElement>("#war-call-7")!;
    const send = panel.querySelector<HTMLButtonElement>(
      "[data-action='call-ally']",
    )!;
    expect(select.value).toBe("p3");
    expect(send.disabled).toBe(true);
    send.click();
    expect(sent).not.toHaveBeenCalled();
    select.value = "p4";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await panel.updateComplete;
    send.click();
    expect(sent.mock.calls[0][0].intent.recipient).toBe("p4");
  });

  it("does not invite an ally twice while a call is pending", () => {
    const existing = war();
    existing.calls.push({
      id: 1,
      inviterID: "p1",
      recipientID: "p3",
      side: 0,
      createdAt: 1,
      expiresAt: 300,
      status: "pending",
    });
    const { mine, ally, params, refresh, manage, click } = setup([existing]);
    mine.isAlliedWith = () => true;
    params.selected = ally;
    refresh();
    manage();
    expect(click("diplomacy_call_ally").disabled).toBe(true);
  });

  it.each(["callToArms", "allied", "team", "subject", "truce"])(
    "disables invitations rejected by the server because of %s",
    async (blocker) => {
      const current = war();
      const wars = [current];
      const {
        mine,
        enemy,
        ally,
        params,
        bus,
        panel,
        menu,
        refresh,
        manage,
        click,
      } = setup(wars);
      mine.isAlliedWith = (target) => target === ally;
      mine.allies = () => [ally];
      params.selected = ally;
      if (blocker === "callToArms")
        current.sides[0].participants[0].reason = "callToArms";
      if (blocker === "allied")
        ally.isAlliedWith = (target) => target === enemy;
      if (blocker === "team") ally.isOnSameTeam = (target) => target === enemy;
      if (blocker === "subject")
        ally.isInSubjectRelation = (target) => target === enemy;
      if (blocker === "truce") {
        const truce = war(8, "p2", "truce");
        truce.sides[0].participants[0].playerID = "p3";
        wars.push(truce);
      }
      refresh();
      manage();
      expect(click("diplomacy_call_ally").disabled).toBe(true);
      expect(menu.container.textContent).toContain(
        blocker === "callToArms"
          ? "context_menu.reason.call_chain"
          : "context_menu.reason.call_conflicting_relation",
      );
      bus.emit(new OpenWarDiplomacyEvent("p3", 7, "call", "p3"));
      await panel.updateComplete;
      expect(panel.querySelector("[data-action='call-ally']")).toBeNull();
    },
  );

  it("uses authoritative subject permissions and the current recipient after refresh", () => {
    const { params, enemy, ally, bus, refresh, manage, click } = setup();
    const sent: SendSubjectIntentEvent[] = [];
    bus.on(SendSubjectIntentEvent, (e) => sent.push(e));
    manage();
    expect(click("diplomacy_demand_subjugation").disabled).toBe(true);
    params.selected = ally;
    params.playerActions.interaction!.canDemandSubjugation = true;
    refresh();
    click("diplomacy_demand_subjugation");
    expect(sent).toHaveLength(1);
    expect(sent[0].target).toBe(ally);
    expect(sent[0].target).not.toBe(enemy);
  });

  it.each(["subjugation", "independence"] as const)(
    "routes the %s response with its request type",
    (type) => {
      const { params, enemy, bus, refresh, manage, click } = setup();
      params.playerActions.interaction!.pendingSubjectRequest = type;
      const sent = vi.fn();
      bus.on(SendSubjectIntentEvent, sent);
      refresh();
      manage();
      click("diplomacy_accept");
      expect(sent).toHaveBeenCalledWith(
        new SendSubjectIntentEvent("accept", enemy, type),
      );
    },
  );

  it("offers subject release and autonomy-gated independence", () => {
    const { mine, enemy, params, menu, bus, refresh, manage, click } = setup();
    const sent = vi.fn();
    bus.on(SendSubjectIntentEvent, sent);
    enemy.isSubjectOf = (target) => target === mine;
    params.playerActions.interaction!.canReleaseSubject = true;
    refresh();
    manage();
    click("diplomacy_release");
    expect(sent).toHaveBeenLastCalledWith(
      new SendSubjectIntentEvent("release", enemy),
    );
    enemy.isSubjectOf = () => false;
    mine.isSubjectOf = (target) => target === enemy;
    mine.isInSubjectRelation = () => true;
    refresh();
    manage();
    expect(click("diplomacy_independence").disabled).toBe(true);
    expect(menu.container.querySelector("#ally_embargo")).toBeNull();
    params.playerActions.interaction!.canDeclareIndependence = true;
    refresh();
    click("diplomacy_independence");
    expect(sent).toHaveBeenLastCalledWith(
      new SendSubjectIntentEvent("independence"),
    );
  });

  it("exposes the existing trade action in diplomacy", () => {
    const { params, bus, enemy, refresh, manage, click } = setup();
    params.playerActions.interaction!.canEmbargo = true;
    const sent = vi.fn();
    bus.on(SendEmbargoIntentEvent, sent);
    refresh();
    manage();
    click("ally_embargo");
    expect(sent).toHaveBeenCalledOnce();
    expect(sent.mock.calls[0][0]).toEqual(
      new SendEmbargoIntentEvent(enemy, "start"),
    );
  });

  it("does not fall through to another war when the selected war ended", async () => {
    const { panel, bus } = setup([war(7, "p2", "ended"), war(8)]);
    bus.emit(new OpenWarDiplomacyEvent("p2", 7, "peace"));
    await panel.updateComplete;
    expect(panel.textContent).toContain("war_panel.empty_target");
    expect(panel.querySelector("form")).toBeNull();
  });

  it("rebinds navigation when another game starts and removes listeners on disconnect", async () => {
    const { panel, bus } = setup();
    const newBus = new EventBus();
    panel.initEventBus(newBus);
    bus.emit(new OpenWarDiplomacyEvent("p2", 7, "peace"));
    await panel.updateComplete;
    expect(panel.querySelector("#war-diplomacy-content")).toBeNull();
    newBus.emit(new OpenWarDiplomacyEvent("p2", 7, "peace"));
    await panel.updateComplete;
    expect(panel.querySelector("form")).not.toBeNull();
    panel.remove();
    newBus.emit(new OpenWarDiplomacyEvent("p3", 8));
    document.body.append(panel);
    await panel.updateComplete;
    expect(panel.querySelector("#war-diplomacy-content")).toBeNull();
  });
});
