import type { WarSnapshot } from "../../../core/game/WarDiplomacy";
import type { GameView, PlayerView } from "../../view";
import { warSide } from "./WarDiplomacyNavigation";

/** Observable eligibility; the execution layer also checks its request cooldown. */
export function callToArmsUnavailableReason(
  game: GameView,
  war: WarSnapshot,
  inviter: PlayerView,
  recipient: PlayerView,
): string | null {
  if (!inviter.isAlive() || !recipient.isAlive()) return "player_defeated";
  const side = warSide(war, inviter.id());
  if (war.status !== "active" || side === -1) return "no_callable_war";
  if (
    war.sides[side].participants.find((p) => p.playerID === inviter.id())
      ?.reason === "callToArms"
  )
    return "call_chain";
  if (
    warSide(war, recipient.id()) !== -1 ||
    war.calls.some(
      (call) =>
        call.recipientID === recipient.id() && call.status === "pending",
    )
  )
    return "no_callable_war";

  const wars = game.wars();
  for (const participant of war.sides[side === 0 ? 1 : 0].participants) {
    const opponent = game.player(participant.playerID);
    if (
      recipient.isAlliedWith(opponent) ||
      recipient.isOnSameTeam(opponent) ||
      recipient.isInSubjectRelation(opponent)
    )
      return "call_conflicting_relation";
    if (
      wars.some((other) => {
        if (other.status !== "truce") return false;
        const recipientSide = warSide(other, recipient.id());
        const opponentSide = warSide(other, opponent.id());
        return (
          recipientSide !== -1 &&
          opponentSide !== -1 &&
          recipientSide !== opponentSide
        );
      })
    )
      return "call_conflicting_relation";
  }
  return null;
}
