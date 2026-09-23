<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="proprietary/images/OpenFrontLogoDark.svg">
    <source media="(prefers-color-scheme: light)" srcset="proprietary/images/OpenFrontLogo.svg">
    <img src="proprietary/images/OpenFrontLogo.svg" alt="OpenFrontIO Logo" width="300">
  </picture>
</p>

[OpenFront.io](https://openfront.io/) is an online real-time strategy game focused on territorial control and alliance building. Players compete to expand their territory, build structures, and form strategic alliances in various maps based on real-world geography.

This repository is **jantian3n's gameplay-development fork of OpenFrontIO**. It currently contains additional subject-diplomacy mechanics such as protectorates, puppets, autonomy, tribute, and defensive protection obligations. Upstream OpenFront development lives at `openfrontio/OpenFrontIO`.

OpenFrontIO itself is a fork/rewrite of WarFront.io. Credit to https://github.com/WarFrontIO.

![CI](https://github.com/jantian3n/OpenFrontIO/actions/workflows/ci.yml/badge.svg)
[![Crowdin](https://badges.crowdin.net/openfront-mls/localized.svg)](https://crowdin.com/project/openfront-mls)
[![CLA assistant](https://cla-assistant.io/readme/badge/openfrontio/OpenFrontIO)](https://cla-assistant.io/openfrontio/OpenFrontIO)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Assets: CC BY-SA 4.0](https://img.shields.io/badge/Assets-CC%20BY--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-sa/4.0/)

## License

OpenFront source code is licensed under the **GNU Affero General Public License v3.0**

Current copyright notices appear in:

- Footer: "© OpenFront and Contributors"
- Loading screen: "© OpenFront and Contributors"

Modified versions must preserve these notices in reasonably visible locations.

See the [LICENSE](LICENSE) for complete requirements.

For asset licensing, see [LICENSE-ASSETS](LICENSE-ASSETS).  
For license history, see [LICENSING.md](LICENSING.md).

## 🌟 Features

- **Real-time Strategy Gameplay**: Expand your territory and engage in strategic battles
- **Alliance System**: Form alliances with other players for mutual defense
- **Multiple Maps**: Play across various geographical regions including Europe, Asia, Africa, and more
- **Resource Management**: Balance your expansion with defensive capabilities
- **Cross-platform**: Play in any modern web browser

## 🤖 Fork Development / Agent Quick Start

If you are an AI coding agent working in a local clone of this fork, **read this section before editing code**.

### Recommended local workflow

Use **Node.js 24** to match GitHub Actions.

```bash
git clone https://github.com/jantian3n/OpenFrontIO.git
cd OpenFrontIO
npm run inst
npm run dev
```

`npm run dev` starts both the Vite client and the development game server. For a LAN-accessible development server, use:

```bash
npm run dev:host
```

Before considering a change ready, run the same classes of checks used by CI:

```bash
npm run format
npm run lint:github
npm run build-prod
npm run test:coverage
npm run gen-maps
git status --short
```

`npm run gen-maps` also runs formatting. If it changes tracked files, inspect and commit the intended generated/formatting changes; CI expects the working tree to remain clean after generation.

### Agent rules for this fork

- Inspect existing architecture and nearby implementations before adding new abstractions.
- Keep deterministic game-simulation logic in `src/core`; do not use wall-clock time or nondeterministic behavior in core simulation.
- Add or update tests for changes to `src/core`, especially diplomacy, combat permissions, player-state replication, and economy rules.
- When adding replicated player state, update the full chain as needed: core model/interface → `PlayerUpdate` / diff-apply logic → client `PlayerView` / renderer state → UI.
- Enforce gameplay permissions in core APIs, not only by hiding UI buttons. AI, scripts, naval actions, and future callers must obey the same rules.
- Preserve compatibility-sensitive numeric enum values by appending new entries instead of inserting them in the middle unless a migration is intentional.
- Keep `resources/lang/en.json` sorted as required by repository tests, and add Simplified Chinese strings for fork-specific player-facing features where appropriate.
- Prefer a feature branch + pull request for substantial work. Do not treat a change as complete while CI is red.
- Do not add official OpenFront production secrets, domains, or infrastructure credentials to this fork.

### Current subject-diplomacy rules

These are intentional gameplay rules and should not be weakened accidentally:

- **Protectorate**
  - voluntarily requested by a meaningfully weaker country;
  - keeps independent third-party diplomacy;
  - may form alliances, trade, embargo third parties, and start its own wars;
  - its overlord's protection guarantee is **defensive only** — a protectorate that starts a war cannot invoke protection against retaliation;
  - starts at **60 autonomy / 10% tribute**.

- **Puppet**
  - created through accepted subjugation;
  - **cannot form or retain independent third-party alliances**;
  - **cannot start an independent offensive war**;
  - may defend itself against an aggressor;
  - may fight a country explicitly designated or actively attacked by its overlord;
  - starts at **40 autonomy / 20% tribute**.

- **Independence**
  - requires **80 autonomy**;
  - ignored or refused protection obligations can increase subject autonomy;
  - fulfilled protection obligations can reduce autonomy slightly.

- **Protection obligations**
  - direct land attacks, naval invasions, direct nuclear attacks, and warship shelling can invoke a valid defensive protection call;
  - stale calls are cancelled when the conflict is no longer valid;
  - subject relationships dissolve if either side is eliminated.

The main implementation areas are:

```text
src/core/game/Game.ts
src/core/game/PlayerImpl.ts
src/core/game/GameImpl.ts
src/core/game/GameUpdates.ts
src/core/game/GameUpdateUtils.ts
src/core/execution/SubjectExecution.ts
src/core/execution/AttackExecution.ts
src/core/execution/TransportShipExecution.ts
src/core/execution/NukeExecution.ts
src/core/execution/WarshipExecution.ts
src/core/execution/nation/NationAllianceBehavior.ts
src/client/Transport.ts
src/client/view/PlayerView.ts
src/client/hud/layers/PlayerPanel.ts
src/client/hud/layers/ActionableEvents.ts
tests/PlayerImpl.test.ts
tests/GameUpdateUtils.test.ts
```

### CI and deployment

The fork's CI workflow can be run from **Actions → CI → Run workflow** and checks build, tests, lint, formatting, and generated maps.

The existing `.github/workflows/deploy.yml` is the upstream OpenFront deployment workflow. It is explicitly gated to `openfrontio/OpenFrontIO` and depends on upstream private infrastructure/secrets, so it **does not deploy this fork**. Use `npm run dev` for local testing. A separate fork-owned deployment workflow should be created if this fork is later hosted publicly.

## 📋 Prerequisites

- [npm](https://www.npmjs.com/) (v10.9.2 or higher)
- A modern web browser (Chrome, Firefox, Edge, etc.)

## 🚀 Installation

1. **Clone the repository**

   ```bash
   git clone https://github.com/jantian3n/OpenFrontIO.git
   cd OpenFrontIO
   ```

2. **Install dependencies**

   ```bash
   npm run inst
   ```

   Do NOT use `npm install` nor `npm i` but instead use our `npm run inst`. It runs the safer `npm ci --ignore-scripts` to install dependencies exactly according to the versions in `package-lock.json` and doesn't run scripts. This can prevent being hit by a supply chain attack.

## 🎮 Running the Game

### Development Mode

Run both the client and server in development mode with live reloading:

```bash
npm run dev
```

This will:

- Start the Vite dev server for the client
- Launch the game server with development settings
- Open the game in your default browser (to disable this behavior, set `SKIP_BROWSER_OPEN=true` in your environment)

### Client Only

To run just the client with hot reloading:

```bash
npm run start:client
```

### Server Only

To run just the server with development settings:

```bash
npm run start:server-dev
```

### Connecting to staging or production backends

Sometimes it's useful to connect to production servers when replaying a game, testing user profiles, purchases, or login flow.

> To replay a production game, make sure you're on the same commit that the game you want to replay was executed on, you can find the `gitCommit` value via `https://api.openfront.io/game/[gameId]`.
> Unfinished games cannot be replayed on localhost.

To connect to staging api servers:

```bash
npm run dev:staging
```

To connect to production api servers:

```bash
npm run dev:prod
```

## 🛠️ Development Tools

- **Format code**:

  ```bash
  npm run format
  ```

- **Lint code with Oxlint and ESLint**:

  ```bash
  npm run lint
  ```

- **Lint and fix code with Oxlint and ESLint**:

  ```bash
  npm run lint:fix
  ```

- **Testing**
  ```bash
  npm test
  ```

## 🏗️ Project Structure

- `/src/client` - Frontend game client
- `/src/core` - Deterministic game simulation
- `/src/server` - Backend game server
- `/resources` - Static assets (images, maps, etc.)
- `/zbin` - Compact binary wire format for zod schemas (self-contained, zod-only)

## 🤝 Contributing

Contributions and translations are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, the approved-issue process, project governance, and translation info.
