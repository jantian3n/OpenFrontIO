import { vi } from "vitest";

// Mock BuildMenu to avoid importing lit and other ESM-heavy deps in this unit test
vi.mock("../../../src/client/hud/layers/BuildMenu", () => ({
  BuildMenu: class {},
  flattenedBuildTable: [],
}));

// Mock Utils to avoid touching DOM (document) during tests
vi.mock("../../../src/client/Utils", () => ({
  translateText: (key: string) => key,
  renderNumber: (num: number) => num.toString(),
}));

import {
  mainActionMenuElement,
  MenuElementParams,
} from "../../../src/client/hud/layers/ContextMenuElements";
import { TileRef } from "../../../src/core/game/GameMap";

describe("Text context menu main action - spawn phase", () => {
  it("activating the main action during the spawn phase spawns on the tile", () => {
    const tile = 42 as TileRef;
    const handleSpawn = vi.fn();
    const handleAttack = vi.fn();
    const closeMenu = vi.fn();

    const params = {
      tile,
      game: { inSpawnPhase: () => true },
      playerActionHandler: { handleSpawn, handleAttack },
      closeMenu,
    } as unknown as MenuElementParams;

    mainActionMenuElement.action!(params);

    expect(handleSpawn).toHaveBeenCalledExactlyOnceWith(tile);
    expect(handleAttack).not.toHaveBeenCalled();
    expect(closeMenu).toHaveBeenCalled();
  });
});
