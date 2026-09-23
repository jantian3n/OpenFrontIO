import {
  Execution,
  Game,
  Player,
  PlayerID,
  SubjectRequestType,
} from "../game/Game";

export type SubjectAction =
  | "request_protection"
  | "demand_subjugation"
  | "accept"
  | "reject"
  | "release"
  | "independence";

export class SubjectExecution implements Execution {
  private active = true;
  private target: Player | null = null;

  constructor(
    private readonly player: Player,
    private readonly action: SubjectAction,
    private readonly targetID?: PlayerID,
    private readonly requestType?: SubjectRequestType,
  ) {}

  init(mg: Game, _: number): void {
    if (this.action === "independence") return;

    if (this.targetID === undefined || !mg.hasPlayer(this.targetID)) {
      console.warn(
        `[SubjectExecution] target ${this.targetID ?? "<missing>"} not found for ${this.action}`,
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
      case "request_protection":
        success =
          this.target !== null && this.player.requestProtection(this.target);
        break;
      case "demand_subjugation":
        success =
          this.target !== null && this.player.demandSubjugation(this.target);
        break;
      case "accept":
        success =
          this.target !== null &&
          this.requestType !== undefined &&
          this.player.acceptSubjectRequest(this.target, this.requestType);
        break;
      case "reject":
        success =
          this.target !== null &&
          this.requestType !== undefined &&
          this.player.rejectSubjectRequest(this.target, this.requestType);
        break;
      case "release":
        success =
          this.target !== null && this.player.releaseSubject(this.target);
        break;
      case "independence":
        success = this.player.declareIndependence();
        break;
    }

    if (!success) {
      console.warn(
        `[SubjectExecution] action ${this.action} rejected for player ${this.player.id()}`,
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
