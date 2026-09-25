import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CloseViewEvent,
  ContextMenuEvent,
} from "../../src/client/InputHandler";
import { MainContextMenu } from "../../src/client/hud/layers/MainContextMenu";
import { EventBus } from "../../src/core/EventBus";

vi.mock("../../src/client/hud/layers/ContextMenuElements", () => ({
  COLORS: { chat: { default: "#000000" } },
  rootMenuElement: {
    id: "root",
    name: "root",
    disabled: () => false,
    subMenu: (params: { tile: number }) => [
      {
        id: `tile-${params.tile}`,
        name: `Tile ${params.tile}`,
        disabled: () => false,
      },
    ],
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("MainContextMenu", () => {
  it("ignores an older action request that resolves after a newer right-click", async () => {
    document.body.appendChild(document.createElement("chat-modal"));

    const first = deferred<any>();
    const second = deferred<any>();
    const myPlayer = {
      actions: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    };
    const game = {
      isValidCoord: () => true,
      ref: (x: number) => x,
      isSpectator: () => false,
      myPlayer: () => myPlayer,
      owner: () => ({ isPlayer: () => false }),
    };
    const transform = {
      screenToWorldCoordinates: (x: number, y: number) => ({ x, y }),
    };
    const bus = new EventBus();
    const controller = new MainContextMenu(
      bus,
      game as any,
      transform as any,
      { isVisible: false } as any,
      { isVisible: false } as any,
      {} as any,
      { isVisible: false } as any,
    );
    controller.init();

    bus.emit(new ContextMenuEvent(10, 0));
    bus.emit(new ContextMenuEvent(20, 0));
    expect(myPlayer.actions).toHaveBeenCalledTimes(2);

    second.resolve({ buildableUnits: [] });
    await vi.waitFor(() => {
      expect(
        document.querySelector(".text-context-menu #tile-20"),
      ).not.toBeNull();
    });

    first.resolve({ buildableUnits: [] });
    await Promise.resolve();
    expect(
      document.querySelector(".text-context-menu #tile-20"),
    ).not.toBeNull();
    expect(
      document.querySelector(".text-context-menu #tile-10"),
    ).toBeNull();
  });

  it("does not reopen after the view closes while actions are loading", async () => {
    document.body.appendChild(document.createElement("chat-modal"));

    const request = deferred<any>();
    const myPlayer = { actions: vi.fn(() => request.promise) };
    const game = {
      isValidCoord: () => true,
      ref: (x: number) => x,
      isSpectator: () => false,
      myPlayer: () => myPlayer,
      owner: () => ({ isPlayer: () => false }),
    };
    const bus = new EventBus();
    const controller = new MainContextMenu(
      bus,
      game as any,
      { screenToWorldCoordinates: (x: number, y: number) => ({ x, y }) } as any,
      { isVisible: false } as any,
      { isVisible: false } as any,
      {} as any,
      { isVisible: false } as any,
    );
    controller.init();

    bus.emit(new ContextMenuEvent(10, 0));
    bus.emit(new CloseViewEvent());
    request.resolve({ buildableUnits: [] });
    await Promise.resolve();

    expect((controller as any).contextMenu.isVisible()).toBe(false);
  });
});
