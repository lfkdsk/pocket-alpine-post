// ui/GameView.tsx — Alpine Post game screen.
//
// Layers (all nodes authored at 0..mapSize inside a centered, clipped world
// frame sized to the CURRENT map):
//   ground 512 Image        one per map, src swap on transfer
//   water atlas nodes       vblank auto-play sprites at ground level
//   per-map NPC containers  one translated node per event slot; the slot
//                           holds a static <Image> and an animated-atlas
//                           <Image>, toggled by the active page's sprite key
//   player                  reducer-pose walker
//   upper 512 Image         star layer
//   object atlas nodes      lamps / beacon, above the upper layer
//   DialogBox, SaveMenu, gold HUD, fade overlay
//
// One pure fold per virtual frame over the shared session reducer. START
// opens the save menu only at a safe point; the fold freezes while it is
// open. The animated atlases are core vblank playback — zero per-frame JS.

import { batch, createMemo, createSignal, onMount, Show } from "solid-js";
import { Image, Sprite, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createJumpBatch, type JumpBatch } from "@pocketjs/framework/animation";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { useActions } from "@pocketjs/framework/actions";
import { simulationHz } from "@pocketjs/framework/clock";
import { createOsk } from "@pocketjs/framework/osk";
import { BTN } from "@pocketjs/framework/input";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import { SCREEN_H, SCREEN_W } from "../vendor/pocket-rpgkit/vendor/pocketjs/contracts/spec/spec.ts";
import { fadeOpacity, type Session, type SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { AttractController, type AttractStatus } from "../vendor/pocket-rpgkit/src/engine/attract.ts";
import {
  activePage,
  createSwitchState,
  modalChanged,
  type Modal,
} from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import { menuStep, type MenuAction, type MenuState } from "../vendor/pocket-rpgkit/src/engine/save-menu.ts";
import { deepClone } from "../vendor/pocket-rpgkit/src/engine/clone.ts";
import { centerOffset } from "../vendor/pocket-rpgkit/src/engine/viewport.ts";
import { walkPose, type WalkPose } from "../vendor/pocket-rpgkit/src/engine/movement.ts";
import { playerBlockedBy } from "../vendor/pocket-rpgkit/src/engine/chars.ts";
import { canSave, createSnapshot, decodeSaveCode, encodeSaveCode } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import type { SaveSnapshot } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import type { Facing, GameEvent, MapDef } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { buildGame, ANIMATIONS, ANIM_SPRITE_KEYS, type AnimAtlas } from "../game/game-data.ts";
import { alpineAttractTape } from "../game/demo-tape.ts";
import { restoreSession } from "../game/restore.ts";
import { hasFsSave, listSlotsFs, loadSlotFs, saveSlotFs } from "../save-fs.ts";
import {
  DIR_BUTTON,
  choiceSelectionSequence,
  connectPointer,
  dialogClickAt,
  findRoute,
  menuClickActions,
  screenToTile,
  type Point,
  type TilePoint,
} from "../input/pointer.ts";
import { PlayerSprite } from "./PlayerSprite.tsx";
import { DialogBox } from "../vendor/pocket-rpgkit/src/ui/DialogBox.tsx";
import { Panel } from "../vendor/pocket-rpgkit/src/ui/Panel.tsx";
import { SaveMenu, type SlotInfo } from "../vendor/pocket-rpgkit/src/ui/SaveMenu.tsx";
import { FACE_SRC } from "./assets.ts";
import { PANEL } from "./theme.ts";
import {
  ALPINE_CONTROL_PLATE_COLOR,
  ALPINE_CONTROL_PLATE_OPACITY,
  ALPINE_CONTROL_PLATE_RECT,
  ALPINE_CONTROL_TEXT_COLOR,
  ALPINE_HELP_PLATE_RECT,
} from "./hud-layout.ts";
import {
  ANIM_ATLASES,
  MAP_GROUND,
  MAP_UPPER,
  MAP_ORDER,
  MAP_WORLD,
  NPC_SRC,
} from "./assets.ts";

interface NpcSlot {
  mapId: string;
  eventId: string;
  key: string;
  initial: string;
}

function collectSlots(maps: readonly MapDef[]): NpcSlot[] {
  const slots: NpcSlot[] = [];
  const empty = createSwitchState();
  for (const mapId of MAP_ORDER) {
    const map = maps.find((m) => m.id === mapId)!;
    for (const ev of [...(map.events as GameEvent[])].sort((a, b) =>
      a.id < b.id ? -1 : a.id === b.id ? 0 : 1,
    )) {
      if (!ev.pages.some((p) => typeof p.sprite === "string")) continue;
      const active = activePage(ev, empty, mapId);
      slots.push({
        mapId,
        eventId: ev.id,
        key: `${mapId}/${ev.id}`,
        initial: typeof active?.page.sprite === "string" ? active.page.sprite : "",
      });
    }
  }
  return slots;
}

function staticSrcOf(key: string): string {
  return NPC_SRC[key] ?? "";
}

function animOf(key: string): { atlas: AnimAtlas; frameStep: number } | null {
  return ANIM_SPRITE_KEYS[key] ?? null;
}

declare global {
  // eslint-disable-next-line no-var
  var __alpineState: SessionState | undefined;
  // eslint-disable-next-line no-var
  var __alpineSession: AlpineHooks | undefined;
}

export interface AlpineHooks {
  hasFs: () => boolean;
  canSave: () => boolean;
  snapshot: () => SaveSnapshot;
  restore: (snap: SaveSnapshot) => void;
  saveSlot: (slot: number) => void;
  loadSlot: (slot: number) => SaveSnapshot;
  encodeCode: () => string;
  decodeCode: (code: string) => SaveSnapshot;
  menu: () => MenuState;
  slots: () => SlotInfo;
  attract: () => AttractStatus;
  pointer: () => {
    connected: boolean;
    route: TilePoint | null;
    marker: PointerMarker | null;
    help: boolean;
  };
}

interface PointerRoute extends TilePoint {
  mapId: string;
}

export interface PointerMarker extends PointerRoute {
  kind: "target" | "rejected";
}

export function GameView() {
  const { project } = buildGame();
  const hz = simulationHz();
  let attract = new AttractController(project, alpineAttractTape(), { hz });
  let session: Session = attract.getSession();
  let state: SessionState = attract.state;
  globalThis.__alpineState = state;

  const slots = collectSlots(project.maps);
  const slotIndex = new Map(slots.map((s, i) => [s.key, i]));
  const mapsById = new Map(project.maps.map((m) => [m.id, m]));
  // An NPC whose map is not loaded stands on its authored tile.
  const slotHome = slots.map((slot) => {
    const ev = mapsById.get(slot.mapId)!.events!.find((e) => e.id === slot.eventId)!;
    return { px: ev.x * 16, py: ev.y * 16 };
  });
  // Per map, the slot events in authored order with the sprite mode each
  // page selects, so the per-frame page sync only picks the active page.
  const slotEvents = new Map(project.maps.map((map) => [
    map.id,
    (map.events ?? [])
      .filter((ev) => slotIndex.has(`${map.id}/${ev.id}`))
      .map((ev) => ({
        ev,
        key: `${map.id}/${ev.id}`,
        modes: ev.pages.map((page) => {
          const name = page.sprite;
          return !name || typeof name !== "string"
            ? ""
            : animOf(name)
              ? `anim:${animOf(name)!.atlas}`
              : `static:${staticSrcOf(name)}`;
        }),
      })),
  ]));

  const [mapId, setMapId] = createSignal(state.mapId);
  const [pose, setPose] = createSignal<WalkPose>(walkPose(state.move.phase));
  const [facing, setFacing] = createSignal<Facing>(state.move.facing);
  const [modal, setModal] = createSignal<Modal | null>(null);
  const [gold, setGold] = createSignal(state.sw.gold);
  const [fade, setFade] = createSignal(0);
  const [switches, setSwitches] = createSignal<Record<string, boolean>>({});
  const [demo, setDemo] = createSignal<AttractStatus | null>(null);
  const [pointerMarker, setPointerMarker] = createSignal<PointerMarker | null>(null);
  const [pointerNotice, setPointerNotice] = createSignal(0);
  const [help, setHelp] = createSignal(false);
  const vp0 = hostViewport(getOps());
  const [viewport, setViewport] = createSignal(vp0 ? { w: vp0.w, h: vp0.h } : { w: SCREEN_W, h: SCREEN_H });

  const initialMode: Record<string, string> = {};
  for (const s of slots) {
    initialMode[s.key] = s.initial
      ? animOf(s.initial)
        ? `anim:${animOf(s.initial)!.atlas}`
        : `static:${staticSrcOf(s.initial)}`
      : "";
  }
  const [slotMode, setSlotMode] = createSignal<Record<string, string>>(initialMode);
  // One memo per slot: a page switch on one NPC re-runs that NPC's node
  // props only, not those of every slot on all five maps.
  const slotModeOf = new Map(slots.map((s) => [s.key, createMemo(() => slotMode()[s.key] ?? "")]));
  const pointer = connectPointer();
  let pointerRoute: PointerRoute | null = null;
  let pointerMasks: number[] = [];
  let desktopConfirmHeld = false;
  let desktopCancelHeld = false;
  let pointerChoicePending: number | null = null;
  const transferPads = new Map(project.maps.map((map) => [
    map.id,
    new Set((map.events ?? [])
      .filter((event) => event.pages.some((page) => page.trigger === "playerTouch"))
      .map((event) => event.y * map.width + event.x)),
  ]));

  // --- save menu -------------------------------------------------------------
  const [menu, setMenu] = createSignal<MenuState>({ kind: "closed" });
  const [slotList, setSlotList] = createSignal<SlotInfo>(listSlotsFs());
  const [saveCode, setSaveCode] = createSignal("");
  const [codeInput, setCodeInput] = createSignal("");
  const fsSave = hasFsSave();
  const osk = createOsk({
    value: codeInput,
    setValue: setCodeInput,
    onCommit: (text) => importCode(text),
    onClose: () => {
      if (menu().kind === "message") setMenu({ kind: "code-import" });
    },
  });

  const actions = useActions(() => {
    const m = modal();
    if (m?.kind === "choices") {
      return { confirm: { label: "ok" }, ...(m.cancellable ? { back: { label: "back" } } : {}) };
    }
    return { confirm: { label: m ? "next" : "talk" } };
  });

  const playerRefs: (NodeMirror | undefined)[] = [];
  const npcRefs: (NodeMirror | undefined)[] = slots.map(() => undefined);
  let jumpBatch: JumpBatch | undefined;
  let prevButtons = 0;
  let prevHostButtons = 0;

  onMount(() => {
    const entries: [NodeMirror, "translateX" | "translateY"][] = [];
    if (playerRefs[0]) entries.push([playerRefs[0], "translateX"], [playerRefs[0], "translateY"]);
    for (const ref of npcRefs) if (ref) entries.push([ref, "translateX"], [ref, "translateY"]);
    jumpBatch = createJumpBatch(entries);
    jumpBatch.set(0, state.move.px);
    jumpBatch.set(1, state.move.py);
    slots.forEach((_, i) => {
      jumpBatch!.set(2 + i * 2, slotHome[i]!.px);
      jumpBatch!.set(3 + i * 2, slotHome[i]!.py);
    });
    jumpBatch.commit();
  });

  let modesSyncedFor: {
    mapId: string;
    switches: object;
    self: object;
    items: object;
    variables: object;
  } | null = null;
  let switchesSyncedFrom: object | null = null;
  // Slot indices per map, for the per-frame NPC position sync.
  const slotsOnMap = new Map<string, number[]>();
  slots.forEach((slot, i) => {
    const list = slotsOnMap.get(slot.mapId);
    if (list) list.push(i);
    else slotsOnMap.set(slot.mapId, [i]);
  });

  const npcXY = (st: SessionState, slot: NpcSlot, i: number): { px: number; py: number } => {
    if (st.mapId === slot.mapId) {
      const ch = st.chars.chars[slot.eventId];
      if (ch) return ch;
    }
    return slotHome[i]!;
  };

  function syncSignals(prev: SessionState, force = false): void {
    // The engine copies a switch-bank record only when a command writes it,
    // so records with the identities of the last sync hold the same values:
    // the active pages, and with them the slot modes, are unchanged.
    const sw = state.sw;
    const pagesSettled = !force && modesSyncedFor !== null && modesSyncedFor.mapId === state.mapId &&
      modesSyncedFor.switches === sw.switches && modesSyncedFor.self === sw.self &&
      modesSyncedFor.items === sw.items && modesSyncedFor.variables === sw.variables;
    let nextMode: Record<string, string> | null = null;
    if (!pagesSettled) {
      const shownMode = slotMode();
      for (const { ev, key, modes } of slotEvents.get(state.mapId)!) {
        const index = activePage(ev, sw, state.mapId)?.index;
        const want = index !== undefined ? modes[index]! : "";
        if ((nextMode ?? shownMode)[key] !== want) {
          nextMode ??= { ...shownMode };
          nextMode[key] = want;
        }
      }
      modesSyncedFor = { mapId: state.mapId, switches: sw.switches, self: sw.self, items: sw.items, variables: sw.variables };
    }
    const swChanged = sw.switches !== switchesSyncedFrom && (() => {
      const a = switches();
      const b = sw.switches;
      const ak = Object.keys(a);
      const bk = Object.keys(b);
      return ak.length !== bk.length || ak.some((k) => a[k] !== b[k]);
    })();
    switchesSyncedFrom = sw.switches;
    batch(() => {
      if (force || state.mapId !== prev.mapId || mapId() !== state.mapId) setMapId(state.mapId);
      const nextPose = walkPose(state.move.phase);
      if (force || nextPose !== pose()) setPose(nextPose);
      if (force || state.move.facing !== facing()) setFacing(state.move.facing);
      if (force || state.sw.gold !== gold()) setGold(state.sw.gold);
      if (nextMode) setSlotMode(nextMode);
      const op = fadeOpacity(state.fade);
      if (force || op !== fade()) setFade(op);
      const shownModal = attract.presentedModal();
      setModal((m) => (modalChanged(m, shownModal) ? deepClone(shownModal) : m));
      if (force || swChanged) setSwitches({ ...state.sw.switches });
    });
  }

  function applyRestore(snap: SaveSnapshot): void {
    const prev = state;
    const restored = restoreSession(session, project, snap);
    // Loading starts a new player-owned timeline. A fresh app controller
    // prevents pre-load input history from becoming rewindable after the
    // restore; the shared reducer/session implementation remains read-only.
    attract = new AttractController(project, alpineAttractTape(), { hz });
    session = attract.getSession();
    attract.state = restored;
    attract.startPlay();
    state = attract.state;
    globalThis.__alpineState = state;
    prevButtons = snap.held >>> 0;
    prevHostButtons = snap.held >>> 0;
    pointerRoute = null;
    pointerMasks = [];
    pointerChoicePending = null;
    setPointerMarker(null);
    setPointerNotice(0);
    actions.resetEdges(snap.held >>> 0);
    jumpBatch?.set(0, state.move.px);
    jumpBatch?.set(1, state.move.py);
    slots.forEach((slot, i) => {
      const b = npcXY(state, slot, i);
      jumpBatch?.set(2 + i * 2, b.px);
      jumpBatch?.set(3 + i * 2, b.py);
    });
    jumpBatch?.commit();
    setMenu({ kind: "closed" });
    syncSignals(prev, true);
  }

  function takeSnapshot(): SaveSnapshot {
    return createSnapshot(state.mapId, state.move, state.interp, prevButtons);
  }

  function message(title: string, body: string, back: MenuState): void {
    setMenu({ kind: "message", title, body, back });
  }

  function saveSlot(slot: number): void {
    try {
      saveSlotFs(slot, takeSnapshot());
      setSlotList(listSlotsFs());
      message(`SAVED — SLOT ${slot}`, "Mailbag stowed at this station.", { kind: "slots-save", index: slot - 1 });
    } catch (e) {
      message("SAVE FAILED", (e as Error).message, { kind: "slots-save", index: slot - 1 });
    }
  }

  function loadSlot(slot: number): void {
    try {
      applyRestore(loadSlotFs(slot));
    } catch (e) {
      message("LOAD FAILED", (e as Error).message, { kind: "slots-load", index: slot - 1 });
    }
  }

  function openExport(): void {
    try {
      setSaveCode(encodeSaveCode(takeSnapshot()));
    } catch (e) {
      message("SAVE FAILED", (e as Error).message, { kind: "root", index: fsSave ? 2 : 0 });
    }
  }

  function openImport(): void {
    setCodeInput("");
    setMenu({ kind: "code-import" });
    osk.open();
  }

  function importCode(text: string): void {
    try {
      applyRestore(decodeSaveCode(text));
    } catch (e) {
      message("BAD SAVE CODE", (e as Error).message, { kind: "code-import" });
    }
  }

  function runMenuCommand(command: NonNullable<ReturnType<typeof menuStep>["command"]>): void {
    switch (command.op) {
      case "save-slot": saveSlot(command.slot); break;
      case "load-slot": loadSlot(command.slot); break;
      case "open-export": openExport(); break;
      case "open-import": openImport(); break;
    }
  }

  function applyMenuAction(action: MenuAction): void {
    if (menu().kind === "code-import" && action === "confirm") {
      osk.open();
      return;
    }
    const list = slotList();
    const result = menuStep(menu(), action, {
      hasFs: fsSave,
      slotNonEmpty: [0, 1, 2].map((i) => list[i] !== null && !("error" in (list[i] ?? {}))) as readonly boolean[],
      codePages: Math.max(1, Math.ceil(saveCode().length / 240)),
    });
    setMenu(result.state);
    if (result.command) runMenuCommand(result.command);
  }

  function handleMenuInput(pressed: number): void {
    if (pressed & BTN.START) {
      setMenu({ kind: "closed" });
      return;
    }
    let action: MenuAction | null = null;
    if (pressed & BTN.UP) action = "up";
    else if (pressed & BTN.DOWN) action = "down";
    else if (pressed & BTN.CIRCLE) action = "confirm";
    else if (pressed & BTN.CROSS) action = "back";
    if (!action) return;
    applyMenuAction(action);
  }

  function clearPointerRoute(): void {
    pointerRoute = null;
    setPointerMarker(null);
  }

  function rejectPointer(tile: TilePoint): void {
    pointerRoute = null;
    setPointerMarker({ mapId: state.mapId, ...tile, kind: "rejected" });
    setPointerNotice(Math.max(1, Math.round(hz * 0.75)));
  }

  function beginPointerRoute(point: Point): void {
    const map = mapsById.get(state.mapId)!;
    const tile = screenToTile(point, worldFrame(), map.width, map.height, project.tileSize);
    if (!tile) return;
    if (state.fade || state.playerRoute || state.interp.main || state.interp.modal) {
      rejectPointer(tile);
      return;
    }
    const route = findRoute(
      session.tables.get(state.mapId)!,
      { x: state.move.tx, y: state.move.ty },
      tile,
      playerBlockedBy(state.chars),
      transferPads.get(state.mapId),
    );
    if (route === null) {
      rejectPointer(tile);
      return;
    }
    pointerRoute = { mapId: state.mapId, ...tile };
    setPointerMarker({ ...pointerRoute, kind: "target" });
    setPointerNotice(0);
    if (route.length === 0) clearPointerRoute();
  }

  function handlePointerClick(point: Point): void {
    if (help()) {
      setHelp(false);
      return;
    }
    if (menu().kind !== "closed") {
      for (const action of menuClickActions(menu(), point, fsSave)) applyMenuAction(action);
      return;
    }
    const dialog = dialogClickAt(modal(), point);
    if (dialog?.kind === "confirm") {
      if (attract.status().phase === "attract") pointerMasks.push(BTN.CIRCLE, 0);
      pointerMasks.push(BTN.CIRCLE, 0);
      return;
    }
    if (dialog?.kind === "choice") {
      const m = modal();
      if (m?.kind === "choices") {
        if (attract.status().phase === "attract") pointerMasks.push(BTN.CIRCLE, 0);
        pointerMasks.push(...choiceSelectionSequence(m.index, dialog.index, m.options.length));
        pointerChoicePending = dialog.index;
      }
      return;
    }
    if (modal()) return;
    if (attract.status().phase === "play" && point.x >= 207 && point.x < 273 && point.y >= 6 && point.y < 24) {
      setHelp(true);
      return;
    }
    beginPointerRoute(point);
  }

  function handlePointerRelease(point: Point): void {
    if (pointerChoicePending === null) return;
    // The row under release owns the click. If the pointer crossed rows
    // while held, move the reducer cursor to that row before confirming it.
    const released = dialogClickAt(modal(), point);
    const m = modal();
    if (released?.kind !== "choice") {
      pointerChoicePending = null;
      return;
    }
    const target = released.index;
    pointerChoicePending = null;
    if (m?.kind !== "choices") return;
    // Drop any unfinished press-time cursor motion. A zero first releases its
    // direction edge, then the release row is selected from the cursor state
    // the reducer has reached and confirmed. No confirm is queued while down.
    pointerMasks = [0, ...choiceSelectionSequence(m.index, target, m.options.length), BTN.CIRCLE, 0];
  }

  function routeMask(): number {
    if (!pointerRoute) return 0;
    if (pointerRoute.mapId !== state.mapId || state.fade || state.playerRoute || state.interp.modal || state.interp.main) {
      clearPointerRoute();
      return 0;
    }
    if (state.move.tx === pointerRoute.x && state.move.ty === pointerRoute.y && !state.move.moving) {
      clearPointerRoute();
      return 0;
    }
    if (state.move.moving) return DIR_BUTTON[state.move.stepDir];
    const route = findRoute(
      session.tables.get(state.mapId)!,
      { x: state.move.tx, y: state.move.ty },
      pointerRoute,
      playerBlockedBy(state.chars),
      transferPads.get(state.mapId),
    );
    if (!route?.length) {
      rejectPointer(pointerRoute);
      return 0;
    }
    return DIR_BUTTON[route[0]!];
  }

  globalThis.__alpineSession = {
    hasFs: () => fsSave,
    canSave: () => canSave(state.move, state.interp),
    snapshot: takeSnapshot,
    restore: applyRestore,
    saveSlot: (slot) => {
      saveSlotFs(slot, takeSnapshot());
      setSlotList(listSlotsFs());
    },
    loadSlot: (slot) => {
      const snap = loadSlotFs(slot);
      applyRestore(snap);
      return snap;
    },
    encodeCode: () => encodeSaveCode(takeSnapshot()),
    decodeCode: (code) => {
      const snap = decodeSaveCode(code);
      applyRestore(snap);
      return snap;
    },
    menu,
    slots: slotList,
    attract: () => attract.status(),
    pointer: () => ({
      connected: pointer !== null,
      route: pointerRoute ? { x: pointerRoute.x, y: pointerRoute.y } : null,
      marker: pointerMarker(),
      help: help(),
    }),
  };

  onFrame((rawButtons) => {
    const nextViewport = hostViewport(getOps());
    if (nextViewport && (nextViewport.w !== viewport().w || nextViewport.h !== viewport().h)) {
      setViewport({ w: nextViewport.w, h: nextViewport.h });
    }

    const desktop = pointer?.poll() ?? { clicks: [], releases: [], keys: [] };
    for (const key of desktop.keys) {
      if (key === "z" || key === "enter") desktopConfirmHeld = true;
      if (key === "x" || key === "backspace") desktopCancelHeld = true;
    }
    if (!(rawButtons & BTN.CROSS)) desktopConfirmHeld = false;
    if (!(rawButtons & BTN.CIRCLE)) desktopCancelHeld = false;
    let hostButtons = rawButtons;
    // The portable desktop host's historical key table exposes Z/Enter as
    // CROSS and X/Backspace as CIRCLE. Its key service retains the physical
    // names, so Alpine corrects those two intentions at the app boundary.
    if (desktopConfirmHeld && (hostButtons & BTN.CROSS)) {
      hostButtons = (hostButtons & ~BTN.CROSS) | BTN.CIRCLE;
    }
    if (desktopCancelHeld && (hostButtons & BTN.CIRCLE)) {
      hostButtons = (hostButtons & ~BTN.CIRCLE) | BTN.CROSS;
    }
    const hostPressed = hostButtons & ~prevHostButtons;
    for (const click of desktop.clicks) handlePointerClick(click);
    for (const release of desktop.releases) handlePointerRelease(release);

    if (
      (hostPressed & (BTN.SQUARE | BTN.TRIANGLE)) &&
      attract.status().phase === "play" &&
      menu().kind === "closed" &&
      modal() === null
    ) {
      clearPointerRoute();
      pointerMasks = [];
      setHelp((open) => !open);
      prevHostButtons = hostButtons;
      prevButtons = hostButtons;
      return;
    }
    if (help()) {
      prevHostButtons = hostButtons;
      prevButtons = hostButtons;
      return;
    }

    if (hostButtons !== 0) {
      clearPointerRoute();
      pointerMasks = [];
      pointerChoicePending = null;
    }
    let buttons = hostButtons;
    if (buttons === 0) {
      if (pointerMasks.length > 0) buttons = pointerMasks.shift()!;
      else buttons = routeMask();
    }
    const pressed = buttons & ~prevButtons;
    if (menu().kind !== "closed") {
      if (!osk.isOpen()) handleMenuInput(pressed);
      prevButtons = buttons;
      prevHostButtons = hostButtons;
      return;
    }

    const prev = state;
    const result = attract.step(buttons);
    state = result.state;
    globalThis.__alpineState = state;

    let moved = state.move.px !== prev.move.px || state.move.py !== prev.move.py;
    jumpBatch?.set(0, state.move.px);
    jumpBatch?.set(1, state.move.py);
    // Off both the previous and the current map, an NPC stays at home.
    for (const mapOf of state.mapId === prev.mapId ? [state.mapId] : [prev.mapId, state.mapId]) {
      for (const i of slotsOnMap.get(mapOf) ?? []) {
        const slot = slots[i]!;
        const a = npcXY(prev, slot, i);
        const b = npcXY(state, slot, i);
        if (a.px === b.px && a.py === b.py) continue;
        jumpBatch?.set(2 + i * 2, b.px);
        jumpBatch?.set(3 + i * 2, b.py);
        moved = true;
      }
    }
    if (moved || state.mapId !== prev.mapId || result.status.loopReset || result.status.rewound) jumpBatch?.commit();
    if (state.mapId !== prev.mapId || result.status.rewound || result.status.loopReset) clearPointerRoute();

    syncSignals(prev);
    setDemo((d) =>
      d === null ||
      d.phase !== result.status.phase ||
      d.demoFrame !== result.status.demoFrame ||
      d.controlNotice !== result.status.controlNotice ||
      d.rewindNotice !== result.status.rewindNotice
        ? { ...result.status }
        : d,
    );

    if (pressed & BTN.START) {
      clearPointerRoute();
      setSlotList(listSlotsFs());
      setMenu((m) => (m.kind === "closed" && canSave(state.move, state.interp) ? { kind: "root", index: 0 } : m));
    }
    if (pointerNotice() > 0) {
      setPointerNotice((left) => {
        if (left <= 1 && pointerMarker()?.kind === "rejected") setPointerMarker(null);
        return Math.max(0, left - 1);
      });
    }
    prevButtons = buttons;
    prevHostButtons = hostButtons;
  });

  const worldFrame = () => {
    const size = MAP_WORLD[mapId()] ?? MAP_WORLD[MAP_ORDER[0]!]!;
    const off = centerOffset(size, viewport());
    return { ...off, ...size };
  };

  // Reactive per-slot accessors used only as node props, so a page/sprite
  // mode change updates src/display without remounting nodes.
  const modeSrc = (key: string): string => {
    const mode = slotModeOf.get(key)!();
    return mode.startsWith("static:") ? mode.slice(7) : "";
  };
  const modeDisplay = (key: string, kind: "static" | "anim"): number => {
    const mode = slotModeOf.get(key)!();
    return mode.startsWith(kind + ":") ? 0 : 1;
  };
  const animProps = (key: string): { sprite: string; frameStep: number } => {
    const mode = slotModeOf.get(key)!();
    const name = mode.startsWith("anim:") ? mode.slice(5) : "";
    const a = name ? ANIM_ATLASES[name as AnimAtlas] : undefined;
    return { sprite: a ? a.src : "", frameStep: a?.step ?? 1 };
  };

  return (
    <View class="w-full h-full overflow-hidden bg-black">
      <View
        class="absolute overflow-hidden"
        style={{
          posType: 1,
          insetL: worldFrame().x,
          insetT: worldFrame().y,
          width: worldFrame().w,
          height: worldFrame().h,
        }}
        debugName="alpine-world-frame"
      >
        <Image src={MAP_GROUND[mapId()]} class="absolute w-[512] h-[512]" style={{ posType: 1, insetL: 0, insetT: 0 }} debugName="alpine-ground" />

        {/* Ground-level auto-play water (below characters). */}
        {MAP_ORDER.map((mid) => (
          <View class="absolute" style={{ posType: 1, insetL: 0, insetT: 0, display: mapId() === mid ? 0 : 1 }} debugName={`alpine-water-${mid}`}>
            {(ANIMATIONS[mid] ?? []).filter((a) => a.layer === "ground").map((a) => (
              <Sprite
                class="absolute w-[16] h-[16]"
                sprite={ANIM_ATLASES[a.atlas]?.src}
                frameStep={a.frameStep}
                style={{ posType: 1, insetL: a.x * 16, insetT: a.y * 16 }}
              />
            ))}
          </View>
        ))}

        {MAP_ORDER.map((mid) => (
          <View class="absolute" style={{ posType: 1, insetL: 0, insetT: 0, display: mapId() === mid ? 0 : 1 }} debugName={`alpine-npcs-${mid}`}>
            {slots.filter((s) => s.mapId === mid).map((slot) => {
              const i = slotIndex.get(slot.key)!;
              // slotMode() must only be read inside node props: a read in
              // this transform body would remount every slot on any mode
              // change (100+ createNodes when the sheep page switches).
              return (
                <View
                  class="absolute"
                  style={{ posType: 1, insetL: 0, insetT: 0 }}
                  nodeRef={(n) => {
                    npcRefs[i] = n;
                  }}
                >
                  <Image
                    class="absolute w-[16] h-[16]"
                    src={modeSrc(slot.key)}
                    style={{ posType: 1, insetL: 0, insetT: 0, display: modeDisplay(slot.key, "static") }}
                  />
                  <Sprite
                    class="absolute w-[16] h-[16]"
                    {...animProps(slot.key)}
                    style={{ posType: 1, insetL: 0, insetT: 0, display: modeDisplay(slot.key, "anim") }}
                  />
                </View>
              );
            })}
          </View>
        ))}

        <PlayerSprite
          pose={pose()}
          facing={facing()}
          ref={(n) => {
            playerRefs[0] = n;
          }}
        />

        <Image src={MAP_UPPER[mapId()]} class="absolute w-[512] h-[512]" style={{ posType: 1, insetL: 0, insetT: 0 }} debugName="alpine-upper" />

        {/* Object-level auto-play sprites (street lamps, beacon). The
            switch read sits in the style expression itself, so Solid
            tracks it and flips only this node's display (a getter inside
            the object literal was invisible to the compiler and froze the
            beacon at its mount-time value); reading the signal in the
            .map() body instead would remount every sprite. */}
        {MAP_ORDER.map((mid) => (
          <View class="absolute" style={{ posType: 1, insetL: 0, insetT: 0, display: mapId() === mid ? 0 : 1 }} debugName={`alpine-lamps-${mid}`}>
            {(ANIMATIONS[mid] ?? []).filter((a) => a.layer === "object").map((a) => (
              <Sprite
                class="absolute w-[16] h-[16]"
                sprite={ANIM_ATLASES[a.atlas]?.src}
                frameStep={a.frameStep}
                style={{ posType: 1, insetL: a.x * 16 + (a.dx ?? 0), insetT: a.y * 16, display: !a.when || switches()[a.when] ? 0 : 1 }}
              />
            ))}
          </View>
        ))}

        <Show when={pointerMarker()?.mapId === mapId()}>
          <View
            class="absolute"
            style={{
              get posType() { return 1; },
              get insetL() { return (pointerMarker()?.x ?? 0) * project.tileSize; },
              get insetT() { return (pointerMarker()?.y ?? 0) * project.tileSize; },
              width: project.tileSize,
              height: project.tileSize,
              borderWidth: 2,
              get borderColor() { return pointerMarker()?.kind === "rejected" ? "#ff5b57" : "#64e8ff"; },
            }}
            debugName="alpine-pointer-marker"
          />
        </Show>
      </View>

      {/* Gold HUD, top-left. */}
      <View class="absolute flex-row items-center" style={{ posType: 1, insetT: 6, insetL: 8, bgColor: "#1a1208", opacity: 0.78, height: 16 }} debugName="alpine-gold-plate">
        <Text class="text-xs" style={{ textColor: "#ffd961", lineHeight: 13, height: 13, insetL: 5, insetR: 5 }}>
          {`GOLD ${gold()}`}
        </Text>
      </View>

      {/* The kit's boxes in the pack's HUD colours; portraits are 38x38 faces
          in a 64x64 frame, so the text column starts 56 px in. */}
      <DialogBox modal={modal} legend={actions.legend} theme={PANEL} faces={FACE_SRC} faceWidth={56} />
      <SaveMenu
        menu={menu} hasFs={fsSave} slots={slotList} saveCode={saveCode} osk={osk} legend={actions.legend}
        theme={PANEL} title="ALPINE POST — SAVE"
      />

      <Show when={pointer !== null && demo()?.phase !== "attract" && menu().kind === "closed" && modal() === null && !help()}>
        <View
          class="absolute flex-row justify-center"
          style={{
            posType: 1,
            insetT: ALPINE_HELP_PLATE_RECT.y,
            insetL: ALPINE_HELP_PLATE_RECT.x,
            width: ALPINE_HELP_PLATE_RECT.width,
            height: ALPINE_HELP_PLATE_RECT.height,
            bgColor: "#1a1208",
            opacity: 0.82,
          }}
          debugName="alpine-help-button"
        >
          <Text class="text-xs" style={{ textColor: "#c7a97c", lineHeight: 13, height: 13, insetT: 2 }}>S HELP</Text>
        </View>
      </Show>

      <Show when={pointerNotice() > 0}>
        <View class="absolute flex-row justify-center" style={{ posType: 1, insetB: 28, insetL: 0, insetR: 0 }} debugName="alpine-pointer-rejected">
          <Text class="text-sm" style={{ textColor: "#ff8178", lineHeight: 18, height: 18, bgColor: "#1a1208" }}>NO ROUTE</Text>
        </View>
      </Show>

      <Show when={help()}>
        <View class="absolute inset-0 flex-row justify-center items-center" style={{ posType: 1, bgColor: "#00000a" }} debugName="alpine-help-overlay">
          <Panel theme={PANEL} style={{ width: 420, height: 232 }} paperClass="flex-col grow p-[8]">
          <Text class="text-sm" style={{ textColor: PANEL.accent, lineHeight: 18, height: 18 }}>ALPINE POST — CONTROLS</Text>
          <View style={{ height: 7 }} />
          <Text class="text-xs" style={{ textColor: PANEL.ink, lineHeight: 17, height: 17 }}>ARROWS  walk / choose</Text>
          <Text class="text-xs" style={{ textColor: PANEL.ink, lineHeight: 17, height: 17 }}>Z or ENTER  talk / confirm</Text>
          <Text class="text-xs" style={{ textColor: PANEL.ink, lineHeight: 17, height: 17 }}>X or BACKSPACE  back</Text>
          <Text class="text-xs" style={{ textColor: PANEL.ink, lineHeight: 17, height: 17 }}>SPACE  save menu</Text>
          <Text class="text-xs" style={{ textColor: PANEL.ink, lineHeight: 17, height: 17 }}>Q or L  rewind 3 seconds</Text>
          <Text class="text-xs" style={{ textColor: PANEL.ink, lineHeight: 17, height: 17 }}>TAB  demo / restart demo</Text>
          <Text class="text-xs" style={{ textColor: PANEL.ink, lineHeight: 17, height: 17 }}>S  open / close help</Text>
          <Text class="text-xs" style={{ textColor: PANEL.ink, lineHeight: 17, height: 17 }}>MOUSE  walk / advance / choose</Text>
          <View class="grow" />
          <Text class="text-xs" style={{ textColor: PANEL.dim, lineHeight: 14, height: 14 }}>S or click  close help</Text>
          </Panel>
        </View>
      </Show>

      <Show when={demo()?.phase === "attract"}>
        <View
          class="absolute flex-col items-end"
          style={{ posType: 1, insetT: 6, insetR: 8, bgColor: "#1a1208", opacity: 0.8 }}
          debugName="alpine-demo-badge"
        >
          <Text class="text-xs" style={{ textColor: "#ffd961", lineHeight: 13, height: 13, insetL: 6, insetT: 2, insetR: 6 }}>
            {`DEMO ${String(demo()?.demoFrame ?? 0).padStart(4, "0")}/${demo()?.tapeFrames ?? 0}`}
          </Text>
        </View>
      </Show>
      <Show when={(demo()?.controlNotice ?? 0) > 0}>
        <View
          class="absolute flex-row justify-center items-center"
          style={{
            posType: 1,
            insetL: ALPINE_CONTROL_PLATE_RECT.x,
            insetT: ALPINE_CONTROL_PLATE_RECT.y,
            width: ALPINE_CONTROL_PLATE_RECT.width,
            height: ALPINE_CONTROL_PLATE_RECT.height,
          }}
          debugName="alpine-control-notice"
        >
          <View
            class="absolute"
            style={{
              posType: 1,
              insetL: 0,
              insetT: 0,
              width: ALPINE_CONTROL_PLATE_RECT.width,
              height: ALPINE_CONTROL_PLATE_RECT.height,
              bgColor: ALPINE_CONTROL_PLATE_COLOR,
              opacity: ALPINE_CONTROL_PLATE_OPACITY,
            }}
            debugName="alpine-control-notice-plate"
          />
          <Text
            class="text-sm"
            style={{ textColor: ALPINE_CONTROL_TEXT_COLOR, lineHeight: 18, height: 18 }}
          >
            YOU HAVE CONTROL
          </Text>
        </View>
      </Show>
      <Show when={(demo()?.rewindNotice ?? 0) > 0}>
        <View class="absolute flex-row justify-center" style={{ posType: 1, insetT: 40, insetL: 0, insetR: 0 }} debugName="alpine-rewind-notice">
          <Text class="text-sm" style={{ textColor: "#8ad0ff", lineHeight: 18, height: 18 }}>REWIND 3 SEC</Text>
        </View>
      </Show>

      <View
        class="absolute left-0 right-0 top-0 bottom-0"
        style={{ posType: 1, bgColor: "#000000", opacity: fade() }}
        debugName="alpine-fade"
      />
    </View>
  );
}
