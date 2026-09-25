import type { ConquestSettleIntent } from "../Schemas";
import { Execution, Game, Player } from "../game/Game";

export class ConquestSettlementExecution implements Execution {
  private active = true;
  private game: Game | null = null;

  constructor(
    private readonly player: Player,
    private readonly intent: ConquestSettleIntent,
  ) {}

  init(game: Game, _: number): void {
    this.game = game;
  }

  tick(_: number): void {
    if (!this.active || this.game === null) return;
    const mg = this.game;
    const intent = this.intent;

    if (!mg.hasPlayer(intent.targetId)) {
      console.warn(
        `[ConquestSettlementExecution] target ${intent.targetId} not found`,
      );
      this.active = false;
      return;
    }
    const target = mg.player(intent.targetId);

    if (!target.isAlive()) {
      this.active = false;
      return;
    }
    if (!mg.hasPendingConquest(target)) {
      // No pending settlement for this target (already settled, never
      // pended, or bot conqueror). Ownership/expiry checks live in
      // GameImpl.executeConquestSettle.
      this.active = false;
      return;
    }

    mg.executeConquestSettle(
      this.player,
      target,
      intent.decision,
      intent.amount === undefined ? undefined : BigInt(intent.amount),
    );
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
