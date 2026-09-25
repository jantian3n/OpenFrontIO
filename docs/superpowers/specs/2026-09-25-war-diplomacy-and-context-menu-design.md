# War Diplomacy Integrity and Text Context Menu

**Status:** Draft for user review
**Date:** 2026-09-25

## Goal

Make the existing war diplomacy system reliable across combat, coalition changes, independence, peace proposals, and participant elimination. Replace the radial right-click menu with a text-first menu while preserving the actions already supported on `main`.

## Scope

This work covers the war diplomacy gaps identified during review:

- Invalid land attacks must not create a war or consume troops.
- A transport landing must revalidate its destination owner and current diplomatic relationship before capturing territory.
- A puppet must be able to defend its overlord when the overlord is attacked.
- Accepting a call to arms must bring the recipient's eligible teammates and subjects into that war.
- A war must end when one side has no living participants.
- Refusing an independence request at 80 autonomy must create an independence war. The independence peace clause must only be available in that subject's war against its overlord.
- A participant's elimination must not automatically invalidate an otherwise viable peace proposal.
- The war panel must summarize visible land attacks, transport landings, hostile warships near the player's territory, and nuclear weapons directed at the player or their territory.

This work also replaces the radial right-click interface with a text-first menu. It preserves actions already supported on `main`, including inspect, attack, build, transport, delete, alliance, subject diplomacy, trade, chat, emoji, and existing donations. New ally-support calls, ally resource requests, subject requisitions, and the separate postwar settlement implementation in the other worktree are excluded.

## Design

### Authoritative war rules

Keep `WarDiplomacy` as the authoritative owner of war membership, status, proposals, and scoring. Combat executions ask it to validate hostility before creating war state or making irreversible changes. Land attacks should create a war only once a legal attack is ready to execute; any later validation failure must restore deducted troops. Transport ships re-check the actual owner of the landing tile and current diplomatic relations on arrival. If the tile has become friendly or protected by a truce, the ship must not capture it and must resolve through the existing safe retreat/cancel path. A still-hostile target remains eligible only after current war rules pass again.

Coalition membership remains deterministic. A defending puppet can retaliate against an attacker of its overlord. When an invited ally accepts a call to arms, add the ally's currently eligible team and subject coalition as participants, update war baselines, and keep participant ordering stable. Do not add any coalition member who is already on the opposing side or has a blocking relation with it.

The regular war tick checks living participants on both sides. When either side has no living members, mark the war ended, cancel pending calls and peace proposals, and emit deterministic events/updates. A pending peace proposal is not canceled merely because one signer dies: remove eliminated signers from the required signature set, then settle only when all surviving required signers accept and the clause still validates. If the war itself ends or the clause becomes invalid, cancel the proposal.

### Independence flow

At 80 autonomy, an overlord's rejection of an independence request starts a special independence war between the subject and the overlord's side without silently releasing the subject first. This special war separates the subject coalition from the overlord coalition while the subject relationship remains pending. At 100 autonomy, the existing peaceful declaration remains available. The independence peace clause validates only when the named subject is alive, still a subject of its current overlord, the subject joined that war with the existing `independence` join reason, and the subject and overlord are on opposing sides of that same active war. Accepting that clause releases the subject and settles the war under the existing truce rules.

### Text-first right-click menu

Replace the radial SVG menu with an anchored HTML menu. Keep frequent actions directly available and place less frequent actions in labeled groups. Text labels carry the meaning; icons remain optional decoration. Display relationship-relevant unavailable actions in a disabled state with a concise reason. Clamp the menu to the viewport, dismiss on outside click or Escape, and support focus plus keyboard navigation. Continue using the existing action handlers and server-authoritative `PlayerActions` data so the presentation change does not create a second rules path.

### Threat summary

Build the threat summary from data already delivered to the current client. Group active inbound land attacks, transport ships approaching owned territory, visible hostile warships operating adjacent to owned territory, and active nuclear projectiles whose target player or target area includes the player. Exclude retreating or inactive units. Do not reveal hidden units or new server state through the panel.

## Compatibility and failure handling

- Keep existing `WarSnapshot` fields and peace-clause transport shape compatible; use the existing `independence` participant join reason to identify the special war and add deterministic events for automatic ending.
- Revalidate rules at the moment an execution commits or lands, since diplomacy and tile ownership can change while an execution is queued or moving.
- Reject stale peace responses, calls, or landings without partial resource, territory, or war-state changes.
- Preserve deterministic event order and state hashing.
- Preserve current radial actions and callback semantics when replacing the renderer.

## Acceptance checks

- Invalid attacks leave troop counts and war lists unchanged.
- An arriving transport cannot take land that is now friendly or covered by a truce; valid hostile landings still resolve normally.
- A puppet can defend its overlord, and an accepted ally call includes eligible teammates and subjects exactly once.
- Eliminating every participant on one side ends the war and prevents later calls or peace actions from reopening it.
- An 80-autonomy refusal creates an independence war; a normal unrelated war rejects an independence clause; a valid independence treaty releases the subject.
- Eliminating one signer preserves the peace proposal for surviving signers, while eliminating an entire side ends it.
- The panel reports all four visible threat classes and omits inactive, retreating, or hidden threats.
- The text menu exposes every currently supported right-click action with its applicable disabled state and reason, works at viewport edges, and supports pointer and keyboard dismissal/navigation.
- Regression tests cover the listed edge cases. Run focused affected suites and type/lint/build checks; report any pre-existing full-suite failures separately.

## Out of scope

- All-allies support calls and recipient response workflows.
- Ally resource requests and direct subject requisitions.
- The separate postwar settlement implementation from the other worktree.
- Changes to subject tribute rates, ordinary alliance eligibility, or unrelated menu actions.
