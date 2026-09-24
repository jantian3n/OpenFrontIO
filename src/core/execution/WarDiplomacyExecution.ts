import type { WarDiplomacyIntent } from "../Schemas";
import { Execution, Game, Player } from "../game/Game";

export class WarDiplomacyExecution implements Execution {
  private active = true;
  private game: Game | null = null;

  constructor(
    private readonly player: Player,
    private readonly intent: WarDiplomacyIntent,
  ) {}

  init(game: Game, _: number): void {
    this.game = game;
  }

  tick(_: number): void {
    if (!this.active || this.game === null) return;
    const diplomacy = this.game.warDiplomacy();
    switch (this.intent.type) {
      case "war_call_to_arms":
        if (this.game.hasPlayer(this.intent.recipient)) {
          diplomacy.createCallToArms(
            this.intent.warId,
            this.player,
            this.game.player(this.intent.recipient),
          );
        }
        break;
      case "war_answer_call":
        diplomacy.answerCall(
          this.intent.warId,
          this.player,
          this.intent.accepted,
        );
        break;
      case "war_propose_peace":
        diplomacy.proposePeace(
          this.intent.warId,
          this.player,
          this.intent.clause,
        );
        break;
      case "war_answer_peace":
        diplomacy.answerPeace(
          this.intent.warId,
          this.intent.proposalId,
          this.player,
          this.intent.accepted,
        );
        break;
    }
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
