import { EventBus, GameEvent } from "../../../core/EventBus";
import { Controller } from "../../Controller";
import { CloseViewEvent } from "../../InputHandler";
import { translateText } from "../../Utils";
import {
  MenuElement,
  MenuElementParams,
  TooltipKey,
} from "./ContextMenuElements";

export class CloseContextMenuEvent implements GameEvent {
  constructor() {}
}

type MenuPage = { title?: string; parent?: MenuElement; items: MenuElement[] };

/** Accessible text actions anchored to a map tile or selected player. */
export class TextContextMenu implements Controller {
  public container: HTMLDivElement;
  private header: HTMLDivElement;
  private breadcrumb: HTMLDivElement;
  private list: HTMLDivElement;
  private params: MenuElementParams | null = null;
  private pageStack: MenuPage[] = [];
  public visible = false;
  private anchorX = 0;
  private anchorY = 0;
  private listenerAbort: AbortController | null = null;

  get pages(): MenuElement[][] {
    return this.pageStack.map((page) => page.items);
  }

  get pageIndex(): number {
    return this.pageStack.length - 1;
  }

  constructor(
    private eventBus: EventBus,
    private rootMenu: MenuElement,
  ) {
    this.container = document.createElement("div");
    this.container.className = "text-context-menu";
    this.container.setAttribute("role", "dialog");
    this.container.setAttribute(
      "aria-label",
      translateText("context_menu.actions"),
    );
    this.container.setAttribute("aria-modal", "false");
    this.container.hidden = true;
    this.header = document.createElement("div");
    this.header.className = "text-context-menu__header";
    this.header.setAttribute("aria-live", "polite");
    this.breadcrumb = document.createElement("div");
    this.breadcrumb.className = "text-context-menu__breadcrumb";
    this.list = document.createElement("div");
    this.list.className = "text-context-menu__list";
    this.list.setAttribute("role", "menu");
    this.container.append(this.header, this.breadcrumb, this.list);
  }

  init() {
    document.body.appendChild(this.container);
    this.container.addEventListener("keydown", (event) =>
      this.onKeyDown(event),
    );
    this.container.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.dismiss();
    });
    this.eventBus.on(CloseViewEvent, () => this.hide());
  }

  setParams(params: MenuElementParams) {
    const activeElement = document.activeElement;
    const focusKey =
      this.visible &&
      activeElement instanceof HTMLButtonElement &&
      this.container.contains(activeElement)
        ? activeElement.dataset.action
          ? `action:${activeElement.dataset.action}`
          : `item:${activeElement.id}`
        : null;
    const path = this.pageStack
      .slice(1)
      .map((page) => page.parent?.id)
      .filter((id): id is string => !!id);
    this.params = params;
    const root = this.rootMenu.subMenu?.(params) ?? [];
    this.pageStack = [{ items: root }];
    for (const parentID of path) {
      const current = this.pageStack[this.pageStack.length - 1].items.find(
        (item) => item.id === parentID,
      );
      if (!current?.subMenu || current.disabled(params)) break;
      const children = current.subMenu(params);
      if (children.length === 0) break;
      this.pageStack.push({
        title: current.name,
        parent: current,
        items: children,
      });
    }
    this.render();
    if (focusKey) {
      const focusTarget = [
        ...this.container.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        ),
      ].find((button) =>
        focusKey.startsWith("action:")
          ? button.dataset.action === focusKey.slice("action:".length)
          : button.id === focusKey.slice("item:".length),
      );
      focusTarget?.focus();
    }
  }

  show(x: number, y: number) {
    if (!this.params) return;
    this.anchorX = x;
    this.anchorY = y;
    this.visible = true;
    this.container.hidden = false;
    this.container.style.display = "block";
    this.listenerAbort?.abort();
    this.listenerAbort = new AbortController();
    const signal = this.listenerAbort.signal;
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!this.container.contains(event.target as Node)) this.dismiss();
      },
      { capture: true, signal },
    );
    window.addEventListener(
      "resize",
      () => this.clampToViewport(this.anchorX, this.anchorY),
      { signal },
    );
    this.render();
    this.clampToViewport(x, y);
    requestAnimationFrame(() => this.focusFirst());
  }

  hide() {
    this.visible = false;
    this.container.hidden = true;
    this.container.style.display = "none";
    this.listenerAbort?.abort();
    this.listenerAbort = null;
    this.pageStack = [];
  }

  refresh() {
    if (!this.params) return;
    this.setParams(this.params);
    if (this.visible) this.clampToViewport(this.anchorX, this.anchorY);
  }

  isVisible() {
    return this.visible;
  }

  private dismiss() {
    if (!this.visible) return;
    this.hide();
    this.eventBus.emit(new CloseContextMenuEvent());
  }

  private clampToViewport(x: number, y: number) {
    if (!this.visible) return;
    const rect = this.container.getBoundingClientRect();
    const margin = 8;
    const clampedX = Math.max(
      margin,
      Math.min(x, window.innerWidth - rect.width - margin),
    );
    const clampedY = Math.max(
      margin,
      Math.min(y, window.innerHeight - rect.height - margin),
    );
    this.container.style.left = `${clampedX}px`;
    this.container.style.top = `${clampedY}px`;
  }

  private render() {
    if (!this.params || this.pageStack.length === 0) return;
    const target =
      this.params.selected?.name() ?? translateText("context_menu.map_actions");
    this.header.textContent = target;
    this.breadcrumb.replaceChildren();
    if (this.pageStack.length > 1) {
      const back = document.createElement("button");
      back.type = "button";
      back.className = "text-context-menu__row";
      back.textContent = `‹ ${translateText("common.back")}`;
      back.setAttribute("role", "menuitem");
      back.dataset.action = "back";
      back.addEventListener("click", () => {
        this.pageStack.pop();
        this.render();
        this.focusFirst();
      });
      const current = this.pageStack[this.pageStack.length - 1];
      const title = document.createElement("span");
      title.className = "text-context-menu__breadcrumb-title";
      title.textContent = current.parent
        ? this.resolveItemLabel(current.parent)
        : (current.title ?? "");
      this.breadcrumb.append(back, title);
    }
    this.list.replaceChildren();
    const items = this.pageStack[this.pageStack.length - 1].items
      .filter((item) => this.isDisplayed(item))
      .sort((a, b) => this.groupOrder(a.group) - this.groupOrder(b.group));
    const buckets = new Map<string, MenuElement[]>();
    for (const item of items) {
      const group = item.group ?? "other";
      const bucket = buckets.get(group) ?? [];
      bucket.push(item);
      buckets.set(group, bucket);
    }
    for (const [group, groupItems] of buckets) {
      const section = document.createElement("section");
      section.className = "text-context-menu__group";
      section.setAttribute("role", "group");
      const title = document.createElement("div");
      title.className = "text-context-menu__group-title";
      title.id = `text-context-menu-group-${this.pageStack.length}-${group}`;
      title.textContent = translateText(`context_menu.group.${group}`);
      section.setAttribute("aria-labelledby", title.id);
      section.appendChild(title);
      for (const item of groupItems) section.appendChild(this.renderItem(item));
      this.list.appendChild(section);
    }
    this.clampToViewport(this.anchorX, this.anchorY);
  }

  private renderItem(item: MenuElement): HTMLButtonElement {
    const params = this.params!;
    const disabled = item.disabled(params);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "text-context-menu__row";
    row.id = item.id;
    row.setAttribute("role", "menuitem");
    row.disabled = disabled;
    const label = document.createElement("span");
    label.className = "text-context-menu__row-label";
    label.appendChild(document.createTextNode(this.resolveItemLabel(item)));
    const details = this.getDetails(item, params, disabled);
    if (details.length > 0) {
      details.forEach((detail) => {
        const detailEl = document.createElement("span");
        detailEl.className = `text-context-menu__detail${disabled ? "" : " text-context-menu__detail--muted"}`;
        detailEl.textContent = detail;
        label.appendChild(detailEl);
      });
    }
    if (item.icon) {
      const icon = document.createElement("img");
      icon.className = "text-context-menu__row-icon";
      icon.src = item.icon;
      icon.alt = "";
      row.appendChild(icon);
    }
    row.appendChild(label);
    if (item.subMenu) {
      const arrow = document.createElement("span");
      arrow.className = "text-context-menu__arrow";
      arrow.textContent = "›";
      row.appendChild(arrow);
      row.setAttribute("aria-haspopup", "menu");
    }
    row.addEventListener("click", () => {
      if (disabled) return;
      const children = item.subMenu?.(params) ?? [];
      if (children.length > 0) {
        this.pageStack.push({
          title: item.name,
          parent: item,
          items: children,
        });
        this.render();
        this.focusFirst();
      } else if (item.action) {
        item.action(params);
        if (this.visible) this.dismiss();
      }
    });
    return row;
  }

  private resolveLabel(name: string): string {
    if (name.startsWith("context_menu.")) return translateText(name);
    const aliases: Record<string, string> = {
      info: "info",
      diplomacy: "diplomacy",
      radial_attack: "attack_options",
      attack: "attack_now",
      build: "build",
      boat: "boat",
      delete: "delete",
      request: "alliance_request",
      extend: "extend_alliance",
      break: "break_alliance",
      "donate gold": "donate_gold",
      "donate troops": "donate_troops",
      radial_donate_gold: "donate_gold",
      trade: "start_trade",
      embargo: "stop_trade",
      target: "target_player",
    };
    const candidateKey = `context_menu.action.${aliases[name] ?? name.toLowerCase().replace(/\s+/g, "_")}`;
    const translated = translateText(candidateKey);
    return translated === candidateKey ? translateText(name) : translated;
  }

  private resolveItemLabel(item: MenuElement): string {
    if (item.text) return item.text;
    if (item.id === "main_action" && this.params) {
      if (this.params.game.inSpawnPhase()) {
        return translateText("context_menu.action.spawn");
      }
      const selected = this.params.selected;
      if (
        selected?.isFriendly(this.params.myPlayer) &&
        !selected.isDisconnected()
      ) {
        return translateText("context_menu.action.donate_troops");
      }
    }
    const label = this.resolveLabel(item.name);
    if (label !== item.name) return label;
    const translatedTitle = item.tooltipItems?.find(
      (tip) => tip.className === "title",
    )?.text;
    if (translatedTitle) return translatedTitle;
    const tooltipKeys: TooltipKey[] =
      typeof item.tooltipKeys === "function"
        ? this.params
          ? item.tooltipKeys(this.params)
          : []
        : (item.tooltipKeys ?? []);
    const title = tooltipKeys.find((tip) => tip.className === "title");
    return title ? this.translateTooltip(title) : label;
  }

  private getDetails(
    item: MenuElement,
    params: MenuElementParams,
    disabled: boolean,
  ): string[] {
    const details: string[] = [];
    const reason = item.unavailableReason?.(params);
    if (reason) details.push(this.translateTooltip(reason));
    const tips: TooltipKey[] =
      typeof item.tooltipKeys === "function"
        ? item.tooltipKeys(params)
        : (item.tooltipKeys ?? []);
    for (const tip of tips) {
      if (tip.className !== "title") details.push(this.translateTooltip(tip));
    }
    for (const tip of item.tooltipItems ?? []) {
      if (tip.className !== "title") details.push(tip.text);
    }
    const cooldown = item.cooldown?.(params) ?? 0;
    if (cooldown > 0) {
      details.push(
        translateText("context_menu.cooldown", {
          seconds: Math.ceil(cooldown / 10),
        }),
      );
    }
    if (disabled && !reason) {
      details.push(translateText("context_menu.reason.unavailable"));
    }
    return [...new Set(details)];
  }

  private translateTooltip(tip: TooltipKey) {
    return translateText(tip.key, tip.params);
  }

  private isDisplayed(item: MenuElement) {
    if (item.displayed === undefined) return true;
    return typeof item.displayed === "function"
      ? item.displayed(this.params!)
      : item.displayed;
  }

  private groupOrder(group: MenuElement["group"]) {
    return ["primary", "diplomacy", "resources", "trade", "other"].indexOf(
      group ?? "other",
    );
  }

  private focusFirst() {
    this.list
      .querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
  }

  private onKeyDown(event: KeyboardEvent) {
    const rows = [
      ...this.list.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
    ];
    if (event.key === "Escape") {
      event.preventDefault();
      if (this.pageStack.length > 1) {
        this.pageStack.pop();
        this.render();
        this.focusFirst();
      } else this.dismiss();
      return;
    }
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      this.moveMenuFocus(event, rows);
      return;
    }
    if (event.key === "Enter") {
      const active = document.activeElement;
      if (
        active instanceof HTMLButtonElement &&
        this.container.contains(active)
      ) {
        event.preventDefault();
        active.click();
      }
    } else if (event.key === "ArrowLeft" && this.pageStack.length > 1) {
      event.preventDefault();
      this.pageStack.pop();
      this.render();
      this.focusFirst();
    } else if (
      event.key === "ArrowRight" &&
      document.activeElement instanceof HTMLButtonElement &&
      document.activeElement.getAttribute("aria-haspopup") === "menu"
    ) {
      event.preventDefault();
      document.activeElement.click();
    }
  }

  private moveMenuFocus(
    event: KeyboardEvent,
    rows = [
      ...this.list.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
    ],
  ) {
    event.preventDefault();
    if (rows.length === 0) return;
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : current === -1
            ? event.key === "ArrowDown"
              ? 0
              : rows.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : rows.length - 1)) %
              rows.length;
    rows[index].focus();
  }
}
