import { AllianceRequestExecution } from "../src/core/execution/alliance/AllianceRequestExecution";
import {
  chooseAINegotiationClause,
  NationAllianceBehavior,
  shouldAcceptCallToArms,
  shouldInviteAlliesToWar,
} from "../src/core/execution/nation/NationAllianceBehavior";
import { NationEmojiBehavior } from "../src/core/execution/nation/NationEmojiBehavior";
import {
  AllianceRequest,
  Difficulty,
  Game,
  GameMode,
  Player,
  PlayerInfo,
  PlayerType,
  Tick,
  UnitType,
} from "../src/core/game/Game";
import type { WarSnapshot } from "../src/core/game/WarDiplomacy";
import { PseudoRandom } from "../src/core/PseudoRandom";
import { setup } from "./util/Setup";

function makeWarSnapshot(
  score0: number,
  score1: number,
  reason0: "attacker" | "callToArms" = "attacker",
): WarSnapshot {
  return {
    id: 7,
    createdAt: 0,
    status: "active",
    sides: [
      {
        participants: [
          { playerID: "nation-a", joinedAt: 0, reason: reason0, isAlive: true },
        ],
        score: {
          territory: score0,
          militaryLosses: 0,
          structures: 0,
          total: score0,
        },
      },
      {
        participants: [
          {
            playerID: "nation-b",
            joinedAt: 0,
            reason: "defender",
            isAlive: true,
          },
        ],
        score: {
          territory: score1,
          militaryLosses: 0,
          structures: 0,
          total: score1,
        },
      },
    ],
    calls: [],
    events: [],
  };
}

describe("deterministic AI war diplomacy", () => {
  test("call decisions depend only on stable side scores", () => {
    const losingSide = makeWarSnapshot(100, 300);
    expect(shouldInviteAlliesToWar(losingSide, "nation-a")).toBe(true);
    expect(shouldAcceptCallToArms(losingSide, 0)).toBe(true);
    expect(shouldAcceptCallToArms(makeWarSnapshot(100, 300), 0)).toBe(
      shouldAcceptCallToArms(losingSide, 0),
    );
    expect(shouldAcceptCallToArms(makeWarSnapshot(100, 5000), 1)).toBe(false);
  });

  test("called participants cannot create an alliance chain", () => {
    expect(
      shouldInviteAlliesToWar(
        makeWarSnapshot(100, 300, "callToArms"),
        "nation-a",
      ),
    ).toBe(false);
    expect(shouldInviteAlliesToWar(makeWarSnapshot(5000, 0), "nation-a")).toBe(
      false,
    );
  });

  test("peace decisions choose deterministic terms from score and candidate data", () => {
    const leading = makeWarSnapshot(9000, 500);
    leading.sides[1].participants.push({
      playerID: "nation-b2",
      joinedAt: 0,
      reason: "team",
      isAlive: true,
    });
    const candidates = [
      { playerID: "nation-b", availableGold: 900n, puppetEligible: false },
      { playerID: "nation-b2", availableGold: 1900n, puppetEligible: true },
    ];
    expect(chooseAINegotiationClause(leading, "nation-a", candidates)).toEqual({
      kind: "puppet",
      targetId: "nation-b2",
      overlordId: "nation-a",
    });
    expect(chooseAINegotiationClause(leading, "nation-a", candidates)).toEqual(
      chooseAINegotiationClause(leading, "nation-a", candidates),
    );
    expect(
      chooseAINegotiationClause(makeWarSnapshot(100, 2500), "nation-a", []),
    ).toEqual({ kind: "whitePeace" });
    expect(
      chooseAINegotiationClause(makeWarSnapshot(1500, 1000), "nation-a", []),
    ).toBeNull();
  });

  test("a nation joins an eligible call but does not invite its own ally chain", async () => {
    const testGame = await setup("plains");
    const addNation = (id: string) =>
      testGame.addPlayer(
        new PlayerInfo(id, PlayerType.Nation, null, `${id}_client`),
      );
    const inviter = addNation("inviter");
    const invited = addNation("invited");
    const chained = addNation("chained");
    const defender = addNation("defender");
    for (const [index, player] of [
      inviter,
      invited,
      chained,
      defender,
    ].entries()) {
      player.conquer(testGame.ref(index * 10, 0));
      player.setTroops(10_000);
    }
    inviter.createAllianceRequest(invited)?.accept();
    invited.createAllianceRequest(chained)?.accept();
    const warId = testGame
      .warDiplomacy()
      .beginHostileAction(inviter, defender)!;
    const makeBehavior = (player: Player) => {
      const random = new PseudoRandom(123);
      return new NationAllianceBehavior(
        random,
        testGame,
        player,
        new NationEmojiBehavior(random, testGame, player),
      );
    };

    makeBehavior(inviter).handleWarDiplomacy();
    expect(testGame.warDiplomacy().getWar(warId)?.calls).toMatchObject([
      { recipientID: invited.id(), status: "pending" },
    ]);

    makeBehavior(invited).handleWarDiplomacy();
    const snapshot = testGame.warDiplomacy().getWar(warId)!;
    expect(
      snapshot.sides[0].participants.find(
        (participant) => participant.playerID === invited.id(),
      )?.reason,
    ).toBe("callToArms");
    expect(
      snapshot.calls.some((call) => call.recipientID === chained.id()),
    ).toBe(false);
  });

  test("a leading nation proposes affordable reparations and bot voters settle them", async () => {
    const testGame = await setup("plains");
    const inviter = testGame.addPlayer(
      new PlayerInfo("peace_inviter", PlayerType.Nation, null, "peace_inviter"),
    );
    const defender = testGame.addPlayer(
      new PlayerInfo(
        "peace_defender",
        PlayerType.Nation,
        null,
        "peace_defender",
      ),
    );
    inviter.conquer(testGame.ref(0, 0));
    defender.conquer(testGame.ref(40, 40));
    defender.conquer(testGame.ref(41, 40));
    inviter.setTroops(10_000);
    defender.setTroops(10_000);
    defender.addGold(1_000n);
    const warId = testGame
      .warDiplomacy()
      .beginHostileAction(inviter, defender)!;

    inviter.conquer(testGame.ref(40, 40));
    const random = new PseudoRandom(7);
    const behavior = new NationAllianceBehavior(
      random,
      testGame,
      inviter,
      new NationEmojiBehavior(random, testGame, inviter),
    );
    behavior.handleWarDiplomacy();
    expect(testGame.warDiplomacy().getWar(warId)?.status).toBe("truce");
    expect(defender.gold()).toBe(900n);
    expect(inviter.gold()).toBe(100n);
  });
});

let game: Game;
let player: Player;
let requestor: Player;
let allianceBehavior: NationAllianceBehavior;

describe("AllianceBehavior.handleAllianceRequests", () => {
  beforeEach(async () => {
    game = await setup("big_plains", {
      infiniteGold: true,
      instantBuild: true,
    });

    const playerInfo = new PlayerInfo(
      "player_id",
      PlayerType.Bot,
      null,
      "player_id",
    );
    const requestorInfo = new PlayerInfo(
      "requestor_id",
      PlayerType.Human,
      null,
      "requestor_id",
    );

    game.addPlayer(playerInfo);
    game.addPlayer(requestorInfo);

    player = game.player("player_id");
    requestor = game.player("requestor_id");

    // Use a fixed random seed for deterministic behavior
    const random = new PseudoRandom(46);

    allianceBehavior = new NationAllianceBehavior(
      random,
      game,
      player,
      new NationEmojiBehavior(random, game, player),
    );
  });

  function setupAllianceRequest({
    isTraitor = false,
    relationDelta = 2,
    numTilesPlayer = 10,
    numTilesRequestor = 10,
    alliancesCount = 0,
    createdAtTick = game.config().numSpawnPhaseTurns() + 2,
  } = {}) {
    if (isTraitor) requestor.markTraitor();

    player.updateRelation(requestor, relationDelta);
    requestor.updateRelation(player, relationDelta);

    game.map().forEachTile((tile) => {
      if (game.map().isLand(tile)) {
        if (numTilesPlayer > 0) {
          player.conquer(tile);
          numTilesPlayer--;
        } else if (numTilesRequestor > 0) {
          requestor.conquer(tile);
          numTilesRequestor--;
        }
      }
    });

    vi.spyOn(player, "alliances").mockReturnValue(new Array(alliancesCount));

    const mockRequest = {
      requestor: () => requestor,
      recipient: () => player,
      createdAt: () => createdAtTick as unknown as Tick,
      accept: vi.fn(),
      reject: vi.fn(),
    } as unknown as AllianceRequest;

    vi.spyOn(player, "incomingAllianceRequests").mockReturnValue([mockRequest]);

    return mockRequest;
  }

  test("should reject alliance created on first post-spawn tick", () => {
    const cutoff = game.config().numSpawnPhaseTurns() + 1;
    const request = setupAllianceRequest({ createdAtTick: cutoff });

    allianceBehavior.handleAllianceRequests();

    expect(request.accept).not.toHaveBeenCalled();
    expect(request.reject).toHaveBeenCalled();
  });

  test("should accept alliance when all conditions are met", () => {
    const request = setupAllianceRequest({});

    allianceBehavior.handleAllianceRequests();

    expect(request.accept).toHaveBeenCalled();
    expect(request.reject).not.toHaveBeenCalled();
  });

  test("should reject alliance if requestor is a traitor", () => {
    const request = setupAllianceRequest({ isTraitor: true });

    allianceBehavior.handleAllianceRequests();

    expect(request.accept).not.toHaveBeenCalled();
    expect(request.reject).toHaveBeenCalled();
  });

  test("should reject alliance if relation is hostile", () => {
    const request = setupAllianceRequest({ relationDelta: -2 });

    allianceBehavior.handleAllianceRequests();

    expect(request.accept).not.toHaveBeenCalled();
    expect(request.reject).toHaveBeenCalled();
  });

  test("should accept alliance if requestor is much larger (> 3 times size of recipient)", () => {
    const request = setupAllianceRequest({
      numTilesRequestor: 40,
    });

    allianceBehavior.handleAllianceRequests();

    expect(request.accept).toHaveBeenCalled();
    expect(request.reject).not.toHaveBeenCalled();
  });

  test("should reject alliance if player has too many alliances", () => {
    const request = setupAllianceRequest({ alliancesCount: 10 });

    allianceBehavior.handleAllianceRequests();

    expect(request.accept).not.toHaveBeenCalled();
    expect(request.reject).toHaveBeenCalled();
  });
});

describe("AllianceBehavior.handleAllianceExtensionRequests", () => {
  let mockGame: any;
  let mockPlayer: any;
  let mockAlliance: any;
  let mockHuman: any;
  let mockRandom: any;
  let allianceBehavior: NationAllianceBehavior;

  beforeEach(() => {
    mockGame = {
      addExecution: vi.fn(),
      config: vi.fn(() => ({ disableAlliances: vi.fn(() => false) })),
    };
    mockHuman = { id: vi.fn(() => "human_id") };
    mockAlliance = {
      onlyOneAgreedToExtend: vi.fn(() => true),
      other: vi.fn(() => mockHuman),
    };
    mockRandom = { chance: vi.fn() };

    mockPlayer = {
      alliances: vi.fn(() => [mockAlliance]),
      relation: vi.fn(),
      id: vi.fn(() => "bot_id"),
      type: vi.fn(() => PlayerType.Nation),
    };

    allianceBehavior = new NationAllianceBehavior(
      mockRandom,
      mockGame,
      mockPlayer,
      new NationEmojiBehavior(mockRandom, mockGame, mockPlayer),
    );
  });

  it("should NOT request extension if onlyOneAgreedToExtend is false (no expiration yet or both already agreed)", () => {
    mockAlliance.onlyOneAgreedToExtend.mockReturnValue(false);
    allianceBehavior.handleAllianceExtensionRequests();
    expect(mockGame.addExecution).not.toHaveBeenCalled();
  });
});

describe("AllianceBehavior.maybeBetray - juicy ally strategy", () => {
  /**
   * Player allied with `allyJuicy` (extra tiles + an upgraded city, so it
   * scores juicier) and `allyMeh` (plain), plus a non-allied `threat`
   * bordering the player. `maybeBetray` is called directly with hand-built
   * bordering lists, so no real map adjacency between these players is needed.
   */
  async function setupBetrayTest(
    difficulty: Difficulty,
    {
      threatTroops = 5_000,
      threatOutgoingTroops = 0,
      allyMehTroops = 10_000,
    } = {},
  ) {
    const testGame = await setup(
      "big_plains",
      { infiniteGold: true, difficulty },
      [
        new PlayerInfo("player", PlayerType.Nation, null, "player_id"),
        new PlayerInfo("allyJuicy", PlayerType.Human, null, "ally_juicy_id"),
        new PlayerInfo("allyMeh", PlayerType.Human, null, "ally_meh_id"),
        new PlayerInfo("threat", PlayerType.Human, null, "threat_id"),
      ],
    );

    const player = testGame.player("player_id");
    const allyJuicy = testGame.player("ally_juicy_id");
    const allyMeh = testGame.player("ally_meh_id");
    const threat = testGame.player("threat_id");

    let assigned = 0;
    const owners = [player, allyJuicy, allyMeh, threat];
    testGame.map().forEachTile((tile) => {
      if (assigned >= 80) return;
      if (!testGame.map().isLand(tile)) return;
      owners[assigned % 4].conquer(tile);
      assigned++;
    });

    // Give allyJuicy extra territory + an upgraded city - the actual prize.
    let extra = 0;
    testGame.map().forEachTile((tile) => {
      if (extra >= 100) return;
      if (!testGame.map().isLand(tile) || testGame.hasOwner(tile)) return;
      allyJuicy.conquer(tile);
      extra++;
    });
    const city = allyJuicy.buildUnit(
      UnitType.City,
      Array.from(allyJuicy.tiles())[0],
      {},
    );
    city.increaseLevel();
    city.increaseLevel();

    player.setTroops(100_000);
    allyJuicy.setTroops(10_000);
    allyMeh.setTroops(allyMehTroops);
    threat.setTroops(threatTroops);
    if (threatOutgoingTroops > 0) {
      // createAttack() directly (no execution/tick) - registers the attack in
      // threat.outgoingAttacks() without ticking the game, which would also
      // run every Nation's own AI turn and disturb the state set up above.
      threat.createAttack(player, threatOutgoingTroops, null, new Set());
    }

    // Form real alliances so isAlliedWith()/allianceWith() behave normally.
    for (const ally of [allyJuicy, allyMeh]) {
      testGame.addExecution(new AllianceRequestExecution(player, ally.id()));
      testGame.executeNextTick();
      testGame.addExecution(new AllianceRequestExecution(ally, player.id()));
      testGame.executeNextTick();
    }
    expect(player.isAlliedWith(allyJuicy)).toBe(true);
    expect(player.isAlliedWith(allyMeh)).toBe(true);

    const random = new PseudoRandom(42);
    const allianceBehavior = new NationAllianceBehavior(
      random,
      testGame,
      player,
      new NationEmojiBehavior(random, testGame, player),
    );

    return { testGame, player, allyJuicy, allyMeh, threat, allianceBehavior };
  }

  it.each([Difficulty.Hard, Difficulty.Impossible])(
    "%s: betrays the juicier ally when nearby non-allied players are weak",
    async (difficulty) => {
      const { player, allyJuicy, allyMeh, threat, allianceBehavior } =
        await setupBetrayTest(difficulty);

      const result = allianceBehavior.maybeBetray(
        allyJuicy,
        allianceBehavior.findJuiciestAlly([allyJuicy, allyMeh]),
        [allyJuicy, allyMeh],
        [threat],
      );

      expect(result).toBe(true);
      expect(player.isAlliedWith(allyJuicy)).toBe(false);
    },
  );

  it.each([Difficulty.Hard, Difficulty.Impossible])(
    "%s: does not betray the less juicy ally, even though it's also weak enough to attack",
    async (difficulty) => {
      const { player, allyJuicy, allyMeh, threat, allianceBehavior } =
        await setupBetrayTest(difficulty);

      const result = allianceBehavior.maybeBetray(
        allyMeh,
        allianceBehavior.findJuiciestAlly([allyJuicy, allyMeh]),
        [allyJuicy, allyMeh],
        [threat],
      );

      expect(result).toBe(false);
      expect(player.isAlliedWith(allyMeh)).toBe(true);
    },
  );

  it.each([Difficulty.Hard, Difficulty.Impossible])(
    "%s: does not betray the juiciest ally when a nearby non-allied player is strong enough to punish it",
    async (difficulty) => {
      const { player, allyJuicy, allyMeh, threat, allianceBehavior } =
        await setupBetrayTest(difficulty, { threatTroops: 60_000 });

      const result = allianceBehavior.maybeBetray(
        allyJuicy,
        allianceBehavior.findJuiciestAlly([allyJuicy, allyMeh]),
        [allyJuicy, allyMeh],
        [threat],
      );

      expect(result).toBe(false);
      expect(player.isAlliedWith(allyJuicy)).toBe(true);
    },
  );

  it.each([Difficulty.Hard, Difficulty.Impossible])(
    "%s: counts a nearby threat's outgoing attack troops toward the safety check",
    async (difficulty) => {
      const { player, allyJuicy, allyMeh, threat, allianceBehavior } =
        await setupBetrayTest(difficulty, {
          threatTroops: 10_000,
          threatOutgoingTroops: 45_000,
        });

      const result = allianceBehavior.maybeBetray(
        allyJuicy,
        allianceBehavior.findJuiciestAlly([allyJuicy, allyMeh]),
        [allyJuicy, allyMeh],
        [threat],
      );

      expect(result).toBe(false);
      expect(player.isAlliedWith(allyJuicy)).toBe(true);
    },
  );

  it.each([Difficulty.Hard, Difficulty.Impossible])(
    "%s: does not betray a non-traitor ally when another current ally could turn on the resulting traitor for free",
    async (difficulty) => {
      // Betraying a non-traitor makes `player` a traitor (see breakAlliance()
      // in GameImpl), so allyMeh could then betray `player` without becoming
      // a traitor itself - it must count as a threat here too.
      const { player, allyJuicy, allyMeh, threat, allianceBehavior } =
        await setupBetrayTest(difficulty, { allyMehTroops: 40_000 });

      const result = allianceBehavior.maybeBetray(
        allyJuicy,
        allianceBehavior.findJuiciestAlly([allyJuicy, allyMeh]),
        [allyJuicy, allyMeh],
        [threat],
      );

      expect(result).toBe(false);
      expect(player.isAlliedWith(allyJuicy)).toBe(true);
    },
  );

  it.each([Difficulty.Hard, Difficulty.Impossible])(
    "%s: betrays an already-traitor ally regardless of other allies' strength",
    async (difficulty) => {
      // Betraying an already-traitor target doesn't make `player` a traitor
      // (see breakAlliance()), so allyMeh's strength is irrelevant here.
      const { player, allyJuicy, allyMeh, threat, allianceBehavior } =
        await setupBetrayTest(difficulty, { allyMehTroops: 40_000 });
      allyJuicy.markTraitor();

      const result = allianceBehavior.maybeBetray(
        allyJuicy,
        allianceBehavior.findJuiciestAlly([allyJuicy, allyMeh]),
        [allyJuicy, allyMeh],
        [threat],
      );

      expect(result).toBe(true);
      expect(player.isAlliedWith(allyJuicy)).toBe(false);
    },
  );

  it.each([Difficulty.Hard, Difficulty.Impossible])(
    "%s: does not count a friendly-but-not-allied bordering player (e.g. a teammate) as a betrayal threat",
    async (difficulty) => {
      // borderingFriends can hold teammates too (isFriendly() = isOnSameTeam()
      // || isAlliedWith()), but a teammate is never actually allied with us
      // and can never attack us - it must not count as a threat.
      const testGame = await setup(
        "big_plains",
        {
          infiniteGold: true,
          difficulty,
          gameMode: GameMode.Team,
          playerTeams: 2,
        },
        [
          // Pinned team slots: player+teammate share team 0, ally sits on
          // team 1, so ally can still form a real alliance with player.
          new PlayerInfo(
            "player",
            PlayerType.Nation,
            null,
            "player_id",
            false,
            null,
            [],
            0,
          ),
          new PlayerInfo(
            "teammate",
            PlayerType.Nation,
            null,
            "teammate_id",
            false,
            null,
            [],
            0,
          ),
          new PlayerInfo(
            "ally",
            PlayerType.Human,
            null,
            "ally_id",
            false,
            null,
            [],
            1,
          ),
        ],
      );

      const player = testGame.player("player_id");
      const teammate = testGame.player("teammate_id");
      const ally = testGame.player("ally_id");

      let assigned = 0;
      const owners = [player, teammate, ally];
      testGame.map().forEachTile((tile) => {
        if (assigned >= 60) return;
        if (!testGame.map().isLand(tile)) return;
        owners[assigned % 3].conquer(tile);
        assigned++;
      });

      expect(player.isOnSameTeam(teammate)).toBe(true);
      expect(player.isAlliedWith(teammate)).toBe(false);

      player.setTroops(1_000_000);
      teammate.setTroops(600_000); // would blow the 33% threshold if wrongly counted
      ally.setTroops(10_000);

      testGame.addExecution(new AllianceRequestExecution(player, ally.id()));
      testGame.executeNextTick();
      testGame.addExecution(new AllianceRequestExecution(ally, player.id()));
      testGame.executeNextTick();
      expect(player.isAlliedWith(ally)).toBe(true);

      const random = new PseudoRandom(42);
      const allianceBehavior = new NationAllianceBehavior(
        random,
        testGame,
        player,
        new NationEmojiBehavior(random, testGame, player),
      );

      const result = (allianceBehavior as any).isSafeToBetray(
        ally,
        [ally, teammate],
        [],
      );

      expect(result).toBe(true);
    },
  );
});
