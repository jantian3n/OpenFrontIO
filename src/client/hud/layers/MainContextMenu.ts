import { EventBus } from "../../../core/EventBus";
import { PlayerActions } from "../../../core/game/Game";
import { TileRef } from "../../../core/game/GameMap";
import { Controller } from "../../Controller";
import { ContextMenuEvent } from "../../InputHandler";
import { TransformHandler } from "../../TransformHandler";
import { UIState } from "../../UIState";
import { GameView, PlayerView } from "../../view";
import { BuildMenu } from "./BuildMenu";
import { ChatIntegration } from "./ChatIntegration";
import { MenuElementParams, rootMenuElement } from "./ContextMenuElements";
import { EmojiTable } from "./EmojiTable";
import { PlayerActionHandler } from "./PlayerActionHandler";
import { PlayerPanel } from "./PlayerPanel";
import { CloseContextMenuEvent, TextContextMenu } from "./TextContextMenu";

function emptyPlayerActions(): PlayerActions {
  return {
    canAttack: false,
    buildableUnits: [],
    canSendEmojiAllPlayers: false,
  };
}

export class MainContextMenu implements Controller {
  private contextMenu: TextContextMenu;

  private playerActionHandler: PlayerActionHandler;
  private chatIntegration: ChatIntegration;

  private clickedTile: TileRef | null = null;

  getTickIntervalMs() {
    return 500;
  }

  constructor(
    private eventBus: EventBus,
    private game: GameView,
    private transformHandler: TransformHandler,
    private emojiTable: EmojiTable,
    private buildMenu: BuildMenu,
    private uiState: UIState,
    private playerPanel: PlayerPanel,
  ) {
    this.contextMenu = new TextContextMenu(this.eventBus, rootMenuElement);

    this.playerActionHandler = new PlayerActionHandler(
      this.eventBus,
      this.uiState,
    );

    this.chatIntegration = new ChatIntegration(this.game, this.eventBus);
  }

  init() {
    this.contextMenu.init();
    this.eventBus.on(ContextMenuEvent, (event) => {
      const worldCoords = this.transformHandler.screenToWorldCoordinates(
        event.x,
        event.y,
      );
      if (!this.game.isValidCoord(worldCoords.x, worldCoords.y)) {
        return;
      }
      const clickedTile = this.game.ref(worldCoords.x, worldCoords.y);
      this.clickedTile = clickedTile;

      // Spectators (replay, dead, pre-spawn): skip actions and open
      // the read-only PlayerPanel directly when right-clicking on a player.
      if (this.game.isSpectator()) {
        if (this.game.owner(clickedTile).isPlayer()) {
          this.playerPanel.show(emptyPlayerActions(), clickedTile);
        }
        return;
      }

      const myPlayer = this.game.myPlayer();
      if (myPlayer === null) return;
      myPlayer
        .actions(clickedTile)
        .then((actions) => {
          this.updatePlayerActions(
            myPlayer,
            actions,
            clickedTile,
            event.x,
            event.y,
          );
        })
        .catch((error) => {
          console.warn("Failed to load context menu actions:", error);
        });
    });
  }

  private async updatePlayerActions(
    myPlayer: PlayerView,
    actions: PlayerActions,
    tile: TileRef,
    screenX: number | null = null,
    screenY: number | null = null,
  ) {
    this.buildMenu.playerBuildables = actions.buildableUnits;

    const tileOwner = this.game.owner(tile);
    const recipient = tileOwner.isPlayer() ? (tileOwner as PlayerView) : null;

    if (recipient) {
      this.chatIntegration.setupChatModal(myPlayer, recipient);
    }

    const params: MenuElementParams = {
      myPlayer,
      selected: recipient,
      tile,
      playerActions: actions,
      game: this.game,
      buildMenu: this.buildMenu,
      emojiTable: this.emojiTable,
      playerActionHandler: this.playerActionHandler,
      playerPanel: this.playerPanel,
      chatIntegration: this.chatIntegration,
      uiState: this.uiState,
      closeMenu: () => this.closeMenu(),
      eventBus: this.eventBus,
    };

    this.contextMenu.setParams(params);
    if (screenX !== null && screenY !== null) {
      this.contextMenu.show(screenX, screenY);
    } else {
      this.contextMenu.refresh();
    }
  }

  async tick() {
    if (!this.contextMenu.isVisible() || this.clickedTile === null) return;
    const myPlayer = this.game.myPlayer();
    if (myPlayer === null) return;
    const tile = this.clickedTile;
    myPlayer
      .actions(tile)
      .then((actions) => {
        this.updatePlayerActions(myPlayer, actions, tile);
      })
      .catch((error) => {
        console.warn("Failed to refresh context menu actions:", error);
      });
  }

  closeMenu() {
    if (this.contextMenu.isVisible()) this.contextMenu.hide();
    this.eventBus.emit(new CloseContextMenuEvent());

    if (this.buildMenu.isVisible) {
      this.buildMenu.hideMenu();
    }

    if (this.emojiTable.isVisible) {
      this.emojiTable.hideTable();
    }

    if (this.playerPanel.isVisible) {
      this.playerPanel.hide();
    }
  }
}
