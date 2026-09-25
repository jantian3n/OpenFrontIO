import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { EventBus } from "../../../core/EventBus";
import {
  GameType,
  GameUpdates,
  PlayerID,
  PlayerType,
} from "../../../core/game/Game";
import {
  ConquestPendingUpdate,
  GameUpdateType,
} from "../../../core/game/GameUpdates";
import type { ConquestSettleIntent } from "../../../core/Schemas";
import type { Controller } from "../../Controller";
import {
  PauseGameIntentEvent,
  SendConquestSettleIntentEvent,
} from "../../Transport";
import { renderDuration, renderNumber, translateText } from "../../Utils";
import type { GameView, PlayerView } from "../../view";

type ConquestDecision = ConquestSettleIntent["decision"];

interface PendingConquest {
  conqueredId: PlayerID;
  expiresAt: number;
  target: PlayerView;
}

/**
 * Modal shown to a human conqueror when a target drops below the conquest
 * threshold. The engine pends the conquest (`ConquestPending`) instead of
 * resolving it, and auto-annexes at `expiresAt`; this component turns that
 * window into a four-way choice and emits `conquest_settle`.
 *
 * Singleplayer only: while the modal is open we hold the sim with the
 * existing `toggle_pause` intent. Note LocalServer drops gameplay intents
 * while paused, so the pause is always released *before* the settle intent
 * goes out.
 */
@customElement("conquest-settlement-modal")
export class ConquestSettlementModal extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  /** Queue of unsettled conquests waiting on this player; head is displayed. */
  @state() private pending: PendingConquest[] = [];
  @state() private selected: ConquestDecision | null = null;
  @state() private reparationsAmount = 0;

  /** True while this modal owns the singleplayer pause. */
  private pausedForModal = false;
  /** Latest known sim pause state, tracked from `GamePaused` updates. */
  private gamePaused = false;

  createRenderRoot() {
    return this;
  }

  initEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
    // New game: drop any leftover state without touching pause — the
    // transport no longer listens for the previous game's intents.
    this.pending = [];
    this.selected = null;
    this.reparationsAmount = 0;
    this.pausedForModal = false;
    this.gamePaused = false;
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("pending") && this.pending.length > 0) {
      queueMicrotask(() =>
        (this.querySelector('[role="dialog"]') as HTMLElement | null)?.focus({
          preventScroll: true,
        }),
      );
    }
  }

  tick(): void {
    const updates = this.game.updatesSinceLastTick();
    if (updates !== null) {
      this.processUpdates(updates);
    }
    if (this.pending.length > 0) {
      const my = this.game.myPlayer();
      // Force-close so neither a settled game nor a dead conqueror can leave
      // the modal (or the pause it holds) stranded on screen.
      if (this.game.gameOver() || my === null || !my.isAlive()) {
        this.closeSession();
        return;
      }
      // Keep the countdown fresh (10Hz — one renderer tick per game tick).
      this.requestUpdate();
    }
  }

  private processUpdates(updates: GameUpdates): void {
    for (const pause of updates[GameUpdateType.GamePaused]) {
      this.gamePaused = pause.paused;
    }
    const my = this.game.myPlayer();
    if (my === null) return;
    // Enqueue before dropping: a catch-up batch can carry both a
    // ConquestPending and a later settlement of the same conquest, and the
    // settlement must win so no stale modal opens.
    if (my.isAlive() && !this.game.gameOver()) {
      for (const pendingUpdate of updates[GameUpdateType.ConquestPending]) {
        if (pendingUpdate.conquerorId !== my.id()) continue;
        this.enqueuePending(pendingUpdate);
      }
    }
    for (const settled of updates[GameUpdateType.ConquestSettled]) {
      if (settled.conquerorId !== my.id()) continue;
      this.dropPending(settled.conqueredId);
    }
  }

  private enqueuePending(update: ConquestPendingUpdate): void {
    if (this.pending.some((entry) => entry.conqueredId === update.conqueredId))
      return;
    let target: PlayerView;
    try {
      target = this.game.player(update.conqueredId);
    } catch {
      return;
    }
    if (!target.isAlive()) return;
    const wasEmpty = this.pending.length === 0;
    this.pending = [
      ...this.pending,
      { conqueredId: update.conqueredId, expiresAt: update.expiresAt, target },
    ];
    if (wasEmpty) {
      this.prepareSelection();
      this.acquirePause();
    }
    this.requestUpdate();
  }

  private dropPending(conqueredId: PlayerID): void {
    const next = this.pending.filter(
      (entry) => entry.conqueredId !== conqueredId,
    );
    if (next.length === this.pending.length) return;
    this.pending = next;
    if (next.length === 0) {
      this.closeSession();
      return;
    }
    this.prepareSelection();
    this.requestUpdate();
  }

  private prepareSelection(): void {
    const entry = this.pending[0];
    this.selected = null;
    this.reparationsAmount =
      entry === undefined ? 0 : Number(entry.target.gold());
  }

  private closeSession(): void {
    this.pending = [];
    this.selected = null;
    this.reparationsAmount = 0;
    this.releasePause();
    this.requestUpdate();
  }

  private isSinglePlayer(): boolean {
    const config = this.game.config();
    return (
      config.gameConfig().gameType === GameType.Singleplayer &&
      !config.isReplay()
    );
  }

  private acquirePause(): void {
    if (this.pausedForModal || !this.isSinglePlayer() || this.gamePaused) {
      return;
    }
    this.eventBus.emit(new PauseGameIntentEvent(true));
    this.pausedForModal = true;
  }

  private releasePause(): void {
    if (!this.pausedForModal) return;
    this.pausedForModal = false;
    this.eventBus.emit(new PauseGameIntentEvent(false));
  }

  private selectDecision(decision: ConquestDecision): void {
    this.selected = decision;
  }

  private clampAmount(value: number, entry: PendingConquest): number {
    const max = Number(entry.target.gold());
    if (!Number.isFinite(value)) return 0;
    const floored = Math.floor(value);
    if (floored < 0) return 0;
    return Math.min(floored, Math.max(0, max));
  }

  private onAmountInput = (event: Event): void => {
    const input = event.target as HTMLInputElement;
    const entry = this.pending[0];
    if (entry === undefined) return;
    const clamped = this.clampAmount(Number(input.value), entry);
    this.reparationsAmount = clamped;
    // Write the clamp back immediately: when the clamped value equals the
    // previous state, Lit's .value binding has nothing to re-apply.
    if (input.value !== String(clamped)) {
      input.value = String(clamped);
    }
  };

  private confirm(): void {
    const entry = this.pending[0];
    if (entry === undefined || this.selected === null || !this.eventBus) return;
    const decision = this.selected;
    const intent: ConquestSettleIntent = {
      type: "conquest_settle",
      targetId: entry.conqueredId,
      decision,
    };
    if (decision === "reparations") {
      intent.amount = this.clampAmount(this.reparationsAmount, entry);
    }
    // Resume before settling: LocalServer drops gameplay intents while the
    // sim is paused, so a settle sent under the pause would never execute.
    this.releasePause();
    this.eventBus.emit(new SendConquestSettleIntentEvent(intent));
    this.pending = this.pending.slice(1);
    if (this.pending.length === 0) {
      this.selected = null;
      this.reparationsAmount = 0;
    } else {
      this.prepareSelection();
    }
    this.requestUpdate();
  }

  private handleKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      this.closeSession();
    }
  };

  private annexGold(target: PlayerView): bigint {
    const gold = target.gold();
    const type = target.type();
    // Mirrors Config.conquerGoldAmount: bots/nations drop their whole
    // treasury, humans only half.
    return type === PlayerType.Bot || type === PlayerType.Nation
      ? gold
      : gold / 2n;
  }

  private remainingTicks(entry: PendingConquest): number {
    return Math.max(0, entry.expiresAt - this.game.ticks());
  }

  private renderOption(
    decision: ConquestDecision,
    title: string,
    description: string,
  ) {
    const checked = this.selected === decision;
    return html`<label
      class="flex cursor-pointer gap-3 rounded-xl border p-3 transition ${checked
        ? "border-cyan-300/60 bg-cyan-400/10"
        : "border-white/10 bg-black/20 hover:border-white/25"}"
      data-decision=${decision}
    >
      <input
        type="radio"
        name="conquest-settlement-decision"
        value=${decision}
        class="mt-1 shrink-0 accent-cyan-300"
        .checked=${checked}
        @change=${() => this.selectDecision(decision)}
      />
      <span class="min-w-0">
        <span
          class="block text-sm font-semibold ${checked
            ? "text-cyan-100"
            : "text-zinc-100"}"
          >${title}</span
        >
        <span class="mt-0.5 block text-xs text-zinc-400">${description}</span>
      </span>
    </label>`;
  }

  render() {
    const entry = this.pending[0];
    if (entry === undefined) return html``;
    const name = entry.target.displayName();
    const remaining = this.remainingTicks(entry);
    const seconds = Math.ceil(remaining / 10);
    const urgent = remaining <= 100;

    return html`<div
      class="fixed inset-0 z-[9600] flex items-center justify-center p-4"
    >
      <div class="absolute inset-0 bg-black/70" aria-hidden="true"></div>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="conquest-settlement-title"
        tabindex="0"
        class="relative w-full max-w-xl rounded-2xl border border-white/10 bg-zinc-950/95 p-4 text-zinc-100 shadow-2xl shadow-black/50 backdrop-blur-xl sm:p-5"
        @keydown=${this.handleKeydown}
      >
        <header class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h1
              id="conquest-settlement-title"
              class="text-base font-bold text-white sm:text-lg"
            >
              ${translateText("conquest_settlement.title")}
            </h1>
            <p class="mt-1 text-xs text-zinc-300 sm:text-sm">
              ${translateText("conquest_settlement.description", { name })}
            </p>
          </div>
          <div
            role="timer"
            data-remaining-ticks=${remaining}
            class="shrink-0 rounded-lg bg-amber-500/15 px-3 py-2 text-right ring-1 ring-amber-400/40 ${urgent
              ? "animate-pulse"
              : ""}"
          >
            <div
              class="text-sm font-bold tabular-nums text-amber-100 sm:text-base"
            >
              ${translateText("conquest_settlement.time_left", {
                time: renderDuration(seconds),
              })}
            </div>
          </div>
        </header>

        <section
          class="mt-3 rounded-xl border border-white/10 bg-black/30 p-3"
          aria-label=${name}
        >
          <div class="truncate text-sm font-semibold text-white">${name}</div>
          <div
            class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-300"
          >
            <span
              >${translateText("conquest_settlement.territory", {
                tiles: renderNumber(entry.target.numTilesOwned()),
              })}</span
            >
            <span
              >${translateText("conquest_settlement.gold", {
                gold: renderNumber(Number(entry.target.gold())),
              })}</span
            >
          </div>
        </section>

        <fieldset class="mt-3 space-y-2" data-role="options">
          <legend class="sr-only">
            ${translateText("conquest_settlement.title")}
          </legend>
          ${this.renderOption(
            "annex",
            translateText("conquest_settlement.annex"),
            translateText("conquest_settlement.annex_desc", {
              name,
              gold: renderNumber(Number(this.annexGold(entry.target))),
            }),
          )}
          ${this.renderOption(
            "puppet",
            translateText("conquest_settlement.puppet"),
            translateText("conquest_settlement.puppet_desc", { name }),
          )}
          ${this.renderOption(
            "reparations",
            translateText("conquest_settlement.reparations"),
            translateText("conquest_settlement.reparations_desc", { name }),
          )}
          ${this.renderOption(
            "release",
            translateText("conquest_settlement.release"),
            translateText("conquest_settlement.release_desc", { name }),
          )}
        </fieldset>

        ${this.selected === "reparations"
          ? html`<label
              class="mt-2 block rounded-xl border border-white/10 bg-black/20 p-3 text-xs text-zinc-300"
            >
              ${translateText("conquest_settlement.amount_label")}
              <input
                type="number"
                min="0"
                step="1"
                inputmode="numeric"
                data-role="reparations-amount"
                class="mt-1 min-h-11 w-full rounded-lg border border-white/10 bg-zinc-900 px-2 py-2 text-sm text-zinc-100"
                .value=${String(this.reparationsAmount)}
                @input=${this.onAmountInput}
              />
            </label>`
          : ""}
        ${this.pausedForModal
          ? html`<p class="mt-2 text-xs text-zinc-400">
              ${translateText("conquest_settlement.paused_hint")}
            </p>`
          : ""}

        <div class="mt-4 flex justify-end gap-2">
          <button
            data-action="cancel"
            class="min-h-11 cursor-pointer rounded-lg bg-white/5 px-4 py-2 text-sm font-semibold text-zinc-200 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
            @click=${() => this.closeSession()}
          >
            ${translateText("common.cancel")}
          </button>
          <button
            data-action="confirm"
            class="min-h-11 cursor-pointer rounded-lg bg-emerald-500/15 px-4 py-2 text-sm font-semibold text-emerald-100 ring-1 ring-emerald-400/40 hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
            ?disabled=${this.selected === null}
            @click=${() => this.confirm()}
          >
            ${translateText("common.confirm")}
          </button>
        </div>
      </div>
    </div>`;
  }
}
