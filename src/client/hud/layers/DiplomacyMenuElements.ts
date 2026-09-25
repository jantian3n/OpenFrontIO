import type { WarSnapshot } from "../../../core/game/WarDiplomacy";
import { SendSubjectIntentEvent } from "../../Transport";
import { translateText } from "../../Utils";
import type {
  MenuElement,
  MenuElementParams,
  TooltipKey,
} from "./ContextMenuElements";
import { callToArmsUnavailableReason } from "./WarDiplomacyEligibility";
import { OpenWarDiplomacyEvent, warSide } from "./WarDiplomacyNavigation";

const reason = (key: string): TooltipKey => ({
  key: `context_menu.reason.${key}`,
  className: "",
});

function actionBlocked(params: MenuElementParams): TooltipKey | null {
  if (params.game.inSpawnPhase()) return reason("spawn_phase");
  if (!params.myPlayer.isAlive() || !params.selected?.isAlive())
    return reason("player_defeated");
  return null;
}

function sharedWars(params: MenuElementParams): WarSnapshot[] {
  if (!params.selected || params.selected.id() === params.myPlayer.id())
    return [];
  return params.game
    .wars()
    .filter(
      (war) =>
        war.status !== "ended" &&
        warSide(war, params.myPlayer.id()) !== -1 &&
        warSide(war, params.selected!.id()) !== -1,
    );
}

function peaceWars(params: MenuElementParams): WarSnapshot[] {
  return sharedWars(params).filter(
    (war) =>
      war.status === "peacePending" ||
      (war.status === "active" &&
        warSide(war, params.myPlayer.id()) !==
          warSide(war, params.selected!.id())),
  );
}

function relationshipDetails(params: MenuElementParams): TooltipKey[] {
  const other = params.selected;
  if (!other || other.id() === params.myPlayer.id()) return [];
  const details: TooltipKey[] = [
    ...new Set(sharedWars(params).map((war) => war.status)),
  ].map((status) => ({ key: `war_panel.status_${status}`, className: "" }));
  if (params.myPlayer.isSubjectOf(other)) {
    details.push({
      key: "context_menu.relation.overlord",
      className: "",
      params: { autonomy: params.myPlayer.autonomy() ?? 0 },
    });
  } else if (other.isSubjectOf(params.myPlayer)) {
    details.push({
      key: "context_menu.relation.subject",
      className: "",
      params: { autonomy: other.autonomy() ?? 0 },
    });
  } else if (params.myPlayer.isOnSameTeam(other)) {
    details.push({ key: "context_menu.relation.teammate", className: "" });
  } else if (params.myPlayer.isAlliedWith(other)) {
    details.push({ key: "context_menu.relation.ally", className: "" });
  } else if (details.length === 0) {
    details.push({ key: "context_menu.relation.neutral", className: "" });
  }
  return details;
}

function openWar(
  params: MenuElementParams,
  war: WarSnapshot,
  section: "peace" | "call",
) {
  params.closeMenu();
  params.eventBus.emit(
    new OpenWarDiplomacyEvent(
      params.selected?.id() ?? null,
      war.id,
      section,
      section === "call" ? params.selected?.id() : undefined,
    ),
  );
}

function warChoice(war: WarSnapshot, section: "peace" | "call"): MenuElement {
  return {
    id: `diplomacy_${section}_${war.id}`,
    name: `context_menu.action.${section}`,
    text: translateText("war_panel.war_number", { number: war.id }),
    tooltipKeys: [{ key: `war_panel.status_${war.status}`, className: "" }],
    disabled: (params) => actionBlocked(params) !== null,
    unavailableReason: actionBlocked,
    action: (params) => openWar(params, war, section),
  };
}

export const peaceMenuElement: MenuElement = {
  id: "diplomacy_peace",
  name: "context_menu.action.peace",
  group: "diplomacy",
  disabled: (params) =>
    actionBlocked(params) !== null || peaceWars(params).length === 0,
  unavailableReason: (params) =>
    actionBlocked(params) ??
    (peaceWars(params).length > 0
      ? null
      : reason(
          sharedWars(params).some((war) => war.status === "truce")
            ? "truce"
            : "no_opposing_war",
        )),
  subMenu: (params) => {
    const wars = peaceWars(params);
    return wars.length > 1 ? wars.map((war) => warChoice(war, "peace")) : [];
  },
  action: (params) => {
    const war = peaceWars(params)[0];
    if (war && !actionBlocked(params)) openWar(params, war, "peace");
  },
};

export const peaceShortcutElement: MenuElement = {
  ...peaceMenuElement,
  displayed: (params) => peaceWars(params).length > 0,
};

function callWars(params: MenuElementParams): WarSnapshot[] {
  const target = params.selected;
  if (
    !target ||
    target.id() === params.myPlayer.id() ||
    !params.myPlayer.isAlliedWith(target)
  )
    return [];
  return params.game
    .wars()
    .filter(
      (war) =>
        callToArmsUnavailableReason(
          params.game,
          war,
          params.myPlayer,
          target,
        ) === null,
    );
}

const callAllyElement: MenuElement = {
  id: "diplomacy_call_ally",
  name: "context_menu.action.call_ally",
  group: "diplomacy",
  displayed: (params) =>
    !!params.selected && params.myPlayer.isAlliedWith(params.selected),
  disabled: (params) =>
    actionBlocked(params) !== null || callWars(params).length === 0,
  unavailableReason: (params) =>
    actionBlocked(params) ??
    (callWars(params).length
      ? null
      : reason(
          params.game
            .wars()
            .filter(
              (war) =>
                war.status === "active" &&
                warSide(war, params.myPlayer.id()) !== -1,
            )
            .map((war) =>
              callToArmsUnavailableReason(
                params.game,
                war,
                params.myPlayer,
                params.selected!,
              ),
            )
            .find(
              (key) =>
                key === "call_chain" || key === "call_conflicting_relation",
            ) ?? "no_callable_war",
        )),
  subMenu: (params) => callWars(params).map((war) => warChoice(war, "call")),
};

function subjectElements(params: MenuElementParams): MenuElement[] {
  const other = params.selected;
  if (!other || other.id() === params.myPlayer.id()) return [];
  const interaction = params.playerActions.interaction;
  const make = (
    label: string,
    action: SendSubjectIntentEvent["action"],
    enabled: boolean,
    disabledReason: string,
    requestType?: SendSubjectIntentEvent["requestType"],
  ): MenuElement => ({
    id: `diplomacy_${action}`,
    name: `context_menu.action.${label}`,
    group: "diplomacy",
    disabled: (current) => !enabled || actionBlocked(current) !== null,
    unavailableReason: (current) =>
      actionBlocked(current) ?? (enabled ? null : reason(disabledReason)),
    action: (current) => {
      if (!enabled || actionBlocked(current)) return;
      current.eventBus.emit(
        new SendSubjectIntentEvent(
          action,
          action === "independence" ? undefined : current.selected!,
          requestType,
        ),
      );
      current.closeMenu();
    },
  });
  const items: MenuElement[] = [];
  const requestType = interaction?.pendingSubjectRequest;
  if (requestType) {
    items.push(
      make(`accept_${requestType}`, "accept", true, "unavailable", requestType),
      make(`reject_${requestType}`, "reject", true, "unavailable", requestType),
    );
  }
  if (params.myPlayer.isSubjectOf(other)) {
    items.push(
      make(
        "request_independence",
        "request_independence",
        !!interaction?.canRequestIndependence,
        "independence_request_unavailable",
      ),
    );
    items.push(
      make(
        "declare_independence",
        "independence",
        !!interaction?.canDeclareIndependence,
        "independence_unavailable",
      ),
    );
  } else if (other.isSubjectOf(params.myPlayer)) {
    items.push(
      make(
        "release_subject",
        "release",
        !!interaction?.canReleaseSubject,
        "unavailable",
      ),
    );
  } else if (!params.myPlayer.isInSubjectRelation(other)) {
    items.push(
      make(
        "demand_subjugation",
        "demand_subjugation",
        !!interaction?.canDemandSubjugation,
        "subjugation_unavailable",
      ),
    );
  }
  return items;
}

/** Existing quick actions are also available together in the diplomacy submenu. */
export function createDiplomacyMenuElement(
  existingActions: MenuElement[],
): MenuElement {
  return {
    id: "diplomacy_manage",
    name: "context_menu.action.diplomacy",
    group: "diplomacy",
    displayed: (params) => params.selected !== null,
    disabled: () => false,
    tooltipKeys: relationshipDetails,
    subMenu: (params) => {
      const target = params.selected;
      if (!target) return [];
      const own = target.id() === params.myPlayer.id();
      const overview: MenuElement = {
        id: "diplomacy_wars",
        name: "context_menu.action.wars",
        group: "diplomacy",
        disabled: () => false,
        action: (current) => {
          current.closeMenu();
          current.eventBus.emit(
            new OpenWarDiplomacyEvent(current.selected?.id() ?? null),
          );
        },
      };
      const incomingCalls = params.game
        .wars()
        .filter(
          (war) =>
            war.status === "active" &&
            war.calls.some(
              (call) =>
                call.recipientID === params.myPlayer.id() &&
                call.inviterID === target.id() &&
                call.status === "pending",
            ),
        );
      const incoming: MenuElement[] = incomingCalls.length
        ? [
            {
              id: "diplomacy_review_call",
              name: "context_menu.action.review_call",
              group: "diplomacy",
              disabled: () => false,
              subMenu: () => incomingCalls.map((war) => warChoice(war, "call")),
            },
          ]
        : [];
      const actions = own
        ? []
        : existingActions.map((item) => ({
            ...item,
            displayed: (current: MenuElementParams) => {
              if (
                item.group === "trade" &&
                current.myPlayer.isInSubjectRelation(current.selected!)
              )
                return false;
              return typeof item.displayed === "function"
                ? item.displayed(current)
                : item.displayed !== false;
            },
            disabled: (current: MenuElementParams) =>
              !!actionBlocked(current) || item.disabled(current),
            unavailableReason: (current: MenuElementParams) =>
              actionBlocked(current) ??
              item.unavailableReason?.(current) ??
              null,
          }));
      return [
        overview,
        ...(!own ? [peaceMenuElement, ...incoming, callAllyElement] : []),
        ...actions,
        ...subjectElements(params),
      ];
    },
  };
}
