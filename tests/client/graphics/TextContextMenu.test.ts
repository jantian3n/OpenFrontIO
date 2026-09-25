import { afterEach, describe, expect, it, vi } from "vitest";
import type { MenuElementParams } from "../../../src/client/hud/layers/ContextMenuElements";
import {
  CloseContextMenuEvent,
  TextContextMenu,
} from "../../../src/client/hud/layers/TextContextMenu";
import { EventBus } from "../../../src/core/EventBus";

vi.mock("../../../src/client/Utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/client/Utils")>()),
  translateText: (key: string) => key,
}));

function menuFixture() {
  const action = vi.fn();
  const root = {
    id: "root",
    name: "root",
    disabled: () => false,
    subMenu: () => [
      {
        id: "attack",
        name: "context_menu.action.attack",
        group: "primary",
        disabled: () => false,
        action,
      },
      {
        id: "disabled",
        name: "context_menu.action.disabled",
        group: "diplomacy",
        disabled: () => true,
        unavailableReason: () => ({
          key: "context_menu.reason.unavailable",
          className: "",
        }),
      },
      {
        id: "submenu",
        name: "context_menu.action.more",
        group: "other",
        disabled: () => false,
        subMenu: () => [
          {
            id: "child",
            name: "context_menu.action.child",
            disabled: () => false,
            action,
          },
        ],
      },
    ],
  } as any;
  const bus = new EventBus();
  const menu = new TextContextMenu(bus, root);
  menu.setParams({} as MenuElementParams);
  menu.init();
  return { action, bus, menu, root };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("TextContextMenu", () => {
  it("renders labeled, grouped actions and disabled explanations", () => {
    const { menu } = menuFixture();
    menu.show(100, 100);

    expect(menu.container.textContent).toContain("context_menu.action.attack");
    expect(menu.container.textContent).toContain("context_menu.group.primary");
    expect(menu.container.textContent).toContain(
      "context_menu.reason.unavailable",
    );
    expect(
      menu.container.querySelector<HTMLButtonElement>("#disabled")?.disabled,
    ).toBe(true);
  });

  it("navigates into a submenu and back", () => {
    const { menu } = menuFixture();
    menu.show(100, 100);
    menu.container.querySelector<HTMLButtonElement>("#submenu")!.click();

    expect(menu.container.textContent).toContain("context_menu.action.child");
    menu.container
      .querySelector<HTMLButtonElement>("[data-action='back']")!
      .click();
    expect(menu.container.textContent).toContain("context_menu.action.attack");
  });

  it("clamps its position to the viewport", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 500,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 400,
    });
    const { menu } = menuFixture();
    vi.spyOn(menu.container, "getBoundingClientRect").mockReturnValue({
      width: 120,
      height: 100,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    menu.show(490, 390);

    expect(menu.container.style.left).toBe("372px");
    expect(menu.container.style.top).toBe("292px");
  });

  it("moves focus, activates actions, and dismisses on Escape or outside click", () => {
    const { action, bus, menu } = menuFixture();
    const closed = vi.fn();
    bus.on(CloseContextMenuEvent, closed);
    menu.show(100, 100);

    menu.container.querySelector<HTMLButtonElement>("#attack")!.focus();
    menu.setParams({} as MenuElementParams);
    const enabled = menu.container.querySelectorAll<HTMLButtonElement>(
      "button:not(:disabled)",
    );
    expect(document.activeElement).toBe(enabled[0]);
    enabled[0].focus();
    menu.container.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    expect(document.activeElement).toBe(enabled[1]);
    menu.container.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    expect(document.activeElement).toBe(enabled[0]);
    menu.container.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
    menu.container.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(menu.isVisible()).toBe(false);
    expect(action).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();

    menu.show(100, 100);
    menu.container.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(menu.isVisible()).toBe(false);
    expect(closed).toHaveBeenCalledTimes(2);

    menu.show(100, 100);
    document.body.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true }),
    );
    expect(menu.isVisible()).toBe(false);
    expect(closed).toHaveBeenCalledTimes(3);
  });
});
