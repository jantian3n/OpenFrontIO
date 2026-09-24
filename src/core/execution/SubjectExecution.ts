import {
  Execution,
  Game,
  Player,
  PlayerID,
  SubjectIntentRequestType,
} from "../game/Game";

export type SubjectAction =
  | "request_protection"
  | "demand_subjugation"
  | "accept"
  | "reject"
  | "release"
  | "request_independence"
  | "independence"
  | "intervene"
  | "decline_protection_call";

export class SubjectExecution implements Execution {
  private active = true;
  private target: Player | null = null;
  private subject: Player | null = null;

  constructor(
    private readonly player: Player,
    private readonly action: SubjectAction,
    private readonly targetID?: PlayerID,
    private readonly requestType?: SubjectIntentRequestType,
    private readonly subjectID?: PlayerID,
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

    if (
      this.action === "intervene" ||
      this.action === "decline_protection_call"
    ) {
      if (this.subjectID === undefined || !mg.hasPlayer(this.subjectID)) {
        console.warn(
          `[SubjectExecution] subject ${this.subjectID ?? "<missing>"} not found for ${this.action}`,
        );
        this.active = false;
        return;
      }
      this.subject = mg.player(this.subjectID);
    }
  }

  tick(_: number): void {
    if (!this.active) return;

    let success = false;
    switch (this.action) {
      case "request_protection":
        success = this.target !== null && this.player.requestPuppet(this.target);
        break;
      case "demand_subjugation":
        success =
          this.target !== null && this.player.demandSubjugation(this.target);
        break;
      case "accept":
        {
          const requestType =
            this.requestType === "protection"
              ? "subjugation"
              : this.requestType;
        success =
          this.target !== null &&
            requestType !== undefined &&
            this.player.acceptSubjectRequest(this.target, requestType);
        }
        break;
      case "reject":
        {
          const requestType =
            this.requestType === "protection"
              ? "subjugation"
              : this.requestType;
        success =
          this.target !== null &&
            requestType !== undefined &&
            this.player.rejectSubjectRequest(this.target, requestType);
        }
        break;
      case "release":
        success =
          this.target !== null && this.player.releaseSubject(this.target);
        break;
      case "request_independence":
        success =
          this.target !== null && this.player.requestIndependence(this.target);
        break;
      case "independence":
        success = this.player.declareIndependence();
        break;
      case "intervene":
      case "decline_protection_call":
        // These turns remain readable so old histories can advance, but
        // protection-call mechanics no longer exist in the active game.
        success = true;
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
