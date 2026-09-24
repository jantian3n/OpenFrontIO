# Text Context Menus and Support Requests

**Status:** Design proposal for user review  
**Date:** 2026-09-23

## Goal

Replace the abstract right-click icon wheel with a readable, text-first context menu. Make war support and the transfer of troops or gold clear actions with outcomes appropriate to each relationship.

## Agreed direction

- Use layout B: keep frequent actions directly visible, and put less frequent actions in labeled text groups such as Diplomacy, Troops and Gold, and Trade.
- A context menu targeting an enemy may offer **Request all allies to support this attack**. A neutral or friendly target does not show this war-support action.
- Sending a support request broadcasts it to all current allies. Each ally decides whether to respond. For a human ally, acceptance signals intent to support; it does not move their field armies automatically. They still control and move their forces. AI allies can act on an accepted target using their existing target behavior.
- A context menu targeting an ally, protectorate, or puppet can offer **Request Troops** and **Request Gold**.
- For an ally, each resource request is a proposal with a chosen amount. The ally can accept or decline; accepted requests transfer the agreed amount.
- For a protectorate or puppet, the overlord chooses an amount and directly requisitions it. The amount cannot exceed the subject's current available gold or reserve troops. It is a one-time transfer from the existing treasury or reserve, separate from recurring tribute. Subject armies already deployed on the map are not teleported or transferred by this action.
- Before a direct requisition, show the amount, the subject's current available balance or reserve, and the resulting balance. Allow requesting all currently available stock; make the consequences clear before confirming.
- Display unavailable actions with disabled styling and a concise reason when their relationship context is relevant. Do not hide a contextual diplomacy action solely because its eligibility condition is unmet.

## Context menu behavior

1. Right-clicking a map target opens a text menu anchored near the pointer and kept within the viewport.
2. The menu header names the target and shows its relationship and war state.
3. Frequent, immediate actions appear first. Related actions are placed in named text submenus. Menu item text describes the action; icons may supplement text but are never the only label.
4. The menu supports dismissal by clicking outside or pressing Escape. Focus and keyboard navigation remain available.
5. Actions which affect another player display a confirmation or clear preview before dispatch. This is especially important for broadcasting a war request to every ally and for taking most or all of a subject's reserves.

## War support flow

1. The requester opens the context menu on a current enemy and chooses **Request all allies to support this attack**.
2. A preview lists the allies who will receive the request and identifies the enemy target. If there are no allies, the action remains visible but disabled with an explanation.
3. On confirmation, all allies who are allied at send time receive the same request. New allies do not get added to an already-sent request.
4. Each recipient can accept or decline. The requester sees pending and resolved responses.
5. Accepting does not transfer gold or reserve troops. It communicates the shared target; human allies choose and move their own armies, while AI behavior follows existing target rules.

## Troop and gold request flow

1. Right-click a single ally, protectorate, or puppet and choose **Request Troops** or **Request Gold**.
2. For an ally, select the amount and send the request. The sender sees pending, accepted, or declined status. Transfer occurs only after acceptance and is capped by what the ally can provide at that time.
3. For a protectorate or puppet, select an amount up to currently available reserve and confirm. The game transfers it immediately, records the action, and notifies the subject.
4. A troop transfer moves reserve troops only. It does not order troops already on the map to move, and the receiving player must deploy or direct the newly received reserve.
5. Resource requests are separate from tribute settlements. A one-time requisition does not change the recurring tribute rate.

## UX states

- Enemy target: war-support action is prominent; ordinary attack, targeting, diplomacy, resource, and trade actions remain grouped by text.
- Neutral target: regular applicable actions are available; war-support is absent.
- Allied target: resource requests require recipient approval; alliance-specific actions remain available.
- Protectorate or puppet target: resource requisitions are direct, with available stock and post-transfer stock preview.
- Relevant but unavailable action: visible and disabled with a reason. Actions irrelevant to the target's relationship are omitted.
- Empty amount or unavailable troops/gold: explain the zero amount and disable confirmation.

## Design rationale and balance

This separates three different intents: asking allies to coordinate against an enemy, asking one ally to voluntarily transfer resources, and directly requisitioning resources from an attached state. The UI makes the consent difference explicit. Requisition uses only current available stock and lets the overlord choose the amount, including all of it, preserving the intended political power of subject relations. A preview and event record make the cost visible and auditable.

## Out of scope

- Changing the passive income formula, the recurring tribute percentage, or its settlement interval.
- Automatically teleporting a player's deployed armies.
- Automatically transferring resources from an ally without acceptance.
- Redesigning diplomacy eligibility thresholds in the existing subject-diplomacy work.

## Review questions

- Does this scope match the intended text-first menu, including non-diplomacy right-click actions?
- Are the response and transfer rules correct, especially that allied troop requests transfer reserve troops only after acceptance?
- Is direct requisition of all available subject gold or reserve troops acceptable when the menu previews the result and records the event?
