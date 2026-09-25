# Context Diplomacy Implementation Plan

**Goal:** Make the right-click menu a usable entry point for war, peace, alliances, subjects, and trade, then publish the changes directly on `main` as requested.

**Architecture:** Keep existing quick actions and add a diplomacy submenu plus a visible peace shortcut. Reuse authoritative player interaction permissions and existing intents. A typed UI event opens the existing war panel at the selected war and section; opening the panel never submits a proposal or joins a war.

**Tech Stack:** TypeScript, Lit, EventBus, Vitest.

## Design and constraints

- Right-clicking another country offers diplomacy management; own territory offers the player's war overview.
- Peace is discoverable at the top level when the selected country shares an active war or pending negotiation with the player. Multiple relevant wars require choosing a war.
- The diplomacy submenu includes war/truce details, peace negotiations, ally support, existing alliance actions, subject requests/release/independence, and trade/resource actions.
- Invalid actions are disabled with explanations. Spawn and defeated-player states must not permit mutations.
- Peace and call-to-arms entries open the existing panel for review, with the selected war/ally preselected. Subject and trade actions reuse the existing validated intents.
- Navigation can be reset to all wars. A stale/ended war cannot reveal a different war's proposal form.
- Preserve Chinese and English text. Reuse the current menu styling and keyboard navigation.
- Work directly on local `main`; verify and push `main`. Leave the user's preview stopped.

## Task 1: Menu and navigation

- [x] Create `WarDiplomacyNavigation.ts` with the typed open event and shared participant lookup.
- [x] Create `DiplomacyMenuElements.ts` to build war, peace, call, and subject actions from the selected player and current snapshots.
- [x] Integrate the new submenu and peace shortcut in `ContextMenuElements.ts`, including existing alliance/trade/resource actions.
- [x] Wire `WarDiplomacyPanel.ts` to the open event via `GameRenderer.ts`; add war/player filtering, section focus, and an all-wars reset.
- [x] Add Chinese/English action labels, disabled explanations, and target-filter text.
- [x] Share observable call eligibility through `WarDiplomacyEligibility.ts`; the server retains final authority and cooldown checks.

## Task 2: Regression checks and publication

- [x] Exercise the rendered root menu with real menu definitions: an enemy at war has a peace entry that opens the correct panel without emitting a mutation.
- [x] Cover multiple wars, pending signatures, truce/ended wars, neutral/self targets, spawn and defeated states, subject permissions, independence, and pending ally calls.
- [x] Exercise panel navigation, selection reset, correct ally preselection, and event-bus rebinding.
- [x] Run the affected menu, panel, player-action, and renderer tests: 7 files, 78 tests passed. Lint and production build also passed; Vite retains its existing large-chunk warning.
- [x] Independently review the diff. Fix the discovered invitation eligibility gap with five failing-then-passing regression cases. A further regression protects explicit recipient selection while native select options change.

Publication: commit on `main`, push `origin main`, and confirm local/remote alignment in the delivery record.

## Review focus

1. Menus refresh while the selected country changes: actions must use the current target.
2. A peace proposal can involve a same-side signatory: pending signature access must remain available.
3. An ally not yet in a war must still reach the selected call form, without being filtered out.
4. Selecting a truce or ended war must not expose an unrelated actionable peace form.
5. Restarting a game must not retain old event subscriptions or target filters.
