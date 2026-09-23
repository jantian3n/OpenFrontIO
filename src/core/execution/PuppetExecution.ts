import { Execution, Game, Player, PlayerID } from "../game/Game";

export type PuppetAction =
  | "request"
  | "accept"
  | "reject"
  | "release"
  | "independence";

export class PuppetExecution implements Execution {
  private active = true;
  private target: Player | null = null;

  constructor(
    private readonly player: Player,
    private readonly action: PuppetAction,
    private readonly targetID?: PlayerID,
  ) {}

  init(mg: Game, _: number): void {
    if (this.action === "independence") {
      return;
    }

    if (this.targetID === undefined || !mg.hasPlayer(this.targetID)) {
      console.warn(
        `[PuppetExecution] target ${this.targetID ?? "<missing>"} not found for ${this.action}`,
      );
      this.active = false;
      return;
    }

    this.target = mg.player(this.targetID);
  }

  tick(_: number): void {
    if (!this.active) return;

    let success = false;

    switch (this.action) {
      case "request":
        success = this.target !== null && this.player.requestPuppet(this.target);
        break;
      case "accept":
        success =
          this.target !== null && this.player.acceptPuppetRequest(this.target);
        break;
      case "reject":
        success =
          this.target !== null && this.player.rejectPuppetRequest(this.target);
        break;
      case "release":
        success = this.target !== null && this.player.releasePuppet(this.target);
        break;
      case "independence":
        success = this.player.declareIndependence();
        break;
    }

    if (!success) {
      console.warn(
        `[PuppetExecution] action ${this.action} rejected for player ${this.player.id()}`,
      );
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
