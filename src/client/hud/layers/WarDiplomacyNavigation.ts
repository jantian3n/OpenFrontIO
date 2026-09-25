import type { WarSnapshot } from "../../../core/game/WarDiplomacy";

export type WarDiplomacySection = "overview" | "peace" | "call";

/** Navigation only: the player reviews the panel before sending any intent. */
export class OpenWarDiplomacyEvent {
  constructor(
    public readonly playerID: string | null = null,
    public readonly warID: number | null = null,
    public readonly section: WarDiplomacySection = "overview",
    public readonly recipientID?: string,
  ) {}
}

export function warSide(war: WarSnapshot, playerID: string): number {
  return war.sides.findIndex((side) =>
    side.participants.some((participant) => participant.playerID === playerID),
  );
}

export function warInvolvesPlayer(war: WarSnapshot, playerID: string): boolean {
  return (
    warSide(war, playerID) !== -1 ||
    war.calls.some(
      (call) => call.recipientID === playerID && call.status === "pending",
    )
  );
}
