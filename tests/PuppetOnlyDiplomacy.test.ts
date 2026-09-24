import { SubjectExecution } from "../src/core/execution/SubjectExecution";
import {
  PlayerInfo,
  PlayerType,
  SubjectRelationKind,
} from "../src/core/game/Game";
import { GameImpl } from "../src/core/game/GameImpl";
import { setup } from "./util/Setup";

describe("puppet-only subject diplomacy", () => {
  async function players() {
    const game = await setup("plains");
    const overlord = (game as GameImpl).addPlayer(
      new PlayerInfo("overlord", PlayerType.Human, "overlord", "overlord"),
    );
    const subject = (game as GameImpl).addPlayer(
      new PlayerInfo("subject", PlayerType.Human, "subject", "subject"),
    );
    overlord.conquer(game.ref(0, 0));
    subject.conquer(game.ref(40, 40));
    overlord.setTroops(100_000);
    for (let x = 1; x <= 20; x++) overlord.conquer(game.ref(x, 0));
    subject.setTroops(1);
    return { game, overlord, subject };
  }

  test("legacy protection request and acceptance replay as a puppet relation", async () => {
    const { game, overlord, subject } = await players();
    const legacyRequest = new SubjectExecution(
      subject,
      "request_protection",
      overlord.id(),
      "protection",
    );
    legacyRequest.init(game, game.ticks());
    legacyRequest.tick(game.ticks());

    const legacyAcceptance = new SubjectExecution(
      overlord,
      "accept",
      subject.id(),
      "protection",
    );
    legacyAcceptance.init(game, game.ticks());
    legacyAcceptance.tick(game.ticks());

    expect(subject.isPuppetOf(overlord)).toBe(true);
    expect(subject.subjectInfo()).toMatchObject({
      kind: SubjectRelationKind.Puppet,
      origin: "subjugation",
      autonomy: 40,
      tributeRate: 20,
    });
  });

  test("the active player API exposes no protectorate or protection-call operations", async () => {
    const { overlord, subject } = await players();
    expect(SubjectRelationKind).not.toHaveProperty("Protectorate");
    expect("isProtectorate" in subject).toBe(false);
    expect("requestProtection" in subject).toBe(false);
    expect("incomingProtectionCalls" in overlord).toBe(false);
    expect("raiseProtectionCall" in subject).toBe(false);
    expect("respondToProtectionCall" in overlord).toBe(false);
  });

  test("ordinary subjugation still produces a puppet with the standard starting terms", async () => {
    const { overlord, subject } = await players();
    expect(overlord.demandSubjugation(subject)).toBe(true);
    expect(subject.acceptSubjectRequest(overlord, "subjugation")).toBe(true);
    expect(subject.isPuppetOf(overlord)).toBe(true);
    expect(subject.subjectInfo()).toMatchObject({
      kind: SubjectRelationKind.Puppet,
      autonomy: 40,
      tributeRate: 20,
    });
  });
});
