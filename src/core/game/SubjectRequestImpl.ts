import {
  Player,
  SubjectRequest,
  SubjectRequestType,
  Tick,
} from "./Game";
import { GameUpdateType, SubjectRequestUpdate } from "./GameUpdates";

export class SubjectRequestImpl implements SubjectRequest {
  constructor(
    private readonly requestor_: Player,
    private readonly recipient_: Player,
    private readonly requestType_: SubjectRequestType,
    private readonly createdAt_: Tick,
  ) {}

  requestor(): Player {
    return this.requestor_;
  }

  recipient(): Player {
    return this.recipient_;
  }

  requestType(): SubjectRequestType {
    return this.requestType_;
  }

  createdAt(): Tick {
    return this.createdAt_;
  }

  toUpdate(): SubjectRequestUpdate {
    return {
      type: GameUpdateType.SubjectRequest,
      requestorID: this.requestor_.smallID(),
      recipientID: this.recipient_.smallID(),
      requestType: this.requestType_,
      createdAt: this.createdAt_,
    };
  }
}
