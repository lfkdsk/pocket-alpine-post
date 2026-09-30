// input/pointer.ts — optional desktop pointer adapter and
// deterministic click-to-walk planning. The app still runs from buttons on
// hosts without the svc mailbox; this module probes instead of assuming it.

import { getOps } from "@pocketjs/framework/host";
import { BTN } from "@pocketjs/framework/input";
import type { Modal } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import { canStepFrom, type Dir4, type PassageTable } from "../vendor/pocket-rpgkit/src/engine/passability.ts";
import { ROOT_CODE, ROOT_FS, type MenuAction, type MenuState } from "../vendor/pocket-rpgkit/src/engine/save-menu.ts";

export const ALPINE_POINTER_SERVICE = "alpine-post";
export const TILE_SIZE = 16;

export interface Point {
  x: number;
  y: number;
}

export interface TilePoint {
  x: number;
  y: number;
}

export interface WorldRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PointerOps {
  svcOpen?: (app: string) => boolean;
  svcPoll?: () => string | undefined;
}

interface MousePacket {
  t?: unknown;
  x?: unknown;
  y?: unknown;
  d?: unknown;
  b?: unknown;
  k?: unknown;
}

export interface DesktopInputBatch {
  clicks: Point[];
  releases: Point[];
  keys: string[];
}

/** Stateful JSON-lines decoder. A press and release may share one poll, so
 * clicks are emitted on each primary-button false -> true edge in order. */
export class PointerDecoder {
  private down = false;
  private x: number | null = null;
  private y: number | null = null;

  decode(batch: string | undefined): DesktopInputBatch {
    if (!batch) return { clicks: [], releases: [], keys: [] };
    const clicks: Point[] = [];
    const releases: Point[] = [];
    const keys: string[] = [];
    for (const line of batch.split("\n")) {
      if (line === "") continue;
      let packet: MousePacket;
      try {
        packet = JSON.parse(line) as MousePacket;
      } catch {
        continue;
      }
      if (packet.t === "key" && typeof packet.k === "string") {
        keys.push(packet.k.toLowerCase());
        continue;
      }
      if (packet.t !== "mouse") continue;
      // A right-button packet carries d=true too. It must neither emit a
      // primary click nor poison the primary button's edge latch.
      if (packet.b !== undefined && packet.b !== 0) continue;
      const hasPoint = typeof packet.x === "number" && Number.isFinite(packet.x) &&
        typeof packet.y === "number" && Number.isFinite(packet.y);
      if (typeof packet.x === "number" && Number.isFinite(packet.x)) this.x = packet.x;
      if (typeof packet.y === "number" && Number.isFinite(packet.y)) this.y = packet.y;
      if (typeof packet.d !== "boolean") continue;
      if (packet.d && !this.down && this.x !== null && this.y !== null) {
        clicks.push({ x: this.x, y: this.y });
      }
      if (!packet.d && this.down && hasPoint && this.x !== null && this.y !== null) {
        releases.push({ x: this.x, y: this.y });
      }
      this.down = packet.d;
    }
    return { clicks, releases, keys };
  }
}

export interface PointerInput {
  poll(): DesktopInputBatch;
}

/** Probe the optional companion mailbox. null is the normal web/PSP path. */
export function connectPointer(ops: PointerOps = getOps()): PointerInput | null {
  if (!ops.svcOpen || !ops.svcPoll) return null;
  try {
    if (!ops.svcOpen(ALPINE_POINTER_SERVICE)) return null;
  } catch {
    return null;
  }
  const poll = ops.svcPoll.bind(ops);
  const decoder = new PointerDecoder();
  return {
    poll: () => {
      try {
        return decoder.decode(poll());
      } catch {
        return { clicks: [], releases: [], keys: [] };
      }
    },
  };
}

const DX = [0, -1, 0, 1] as const;
const DY = [1, 0, -1, 0] as const;
export const DIR_BUTTON: Readonly<Record<Dir4, number>> = {
  0: BTN.DOWN,
  1: BTN.LEFT,
  2: BTN.UP,
  3: BTN.RIGHT,
};

/** Map a screen-space click into a tile in the centered map frame. */
export function screenToTile(
  point: Point,
  world: WorldRect,
  mapWidth: number,
  mapHeight: number,
  tileSize = TILE_SIZE,
): TilePoint | null {
  if (point.x < world.x || point.y < world.y || point.x >= world.x + world.w || point.y >= world.y + world.h) {
    return null;
  }
  const x = Math.floor((point.x - world.x) / tileSize);
  const y = Math.floor((point.y - world.y) / tileSize);
  return x >= 0 && y >= 0 && x < mapWidth && y < mapHeight ? { x, y } : null;
}

/** Shortest deterministic route over the same one-way passage rules as the
 * reducer. `blocked` adds the current bodies of blocking characters and
 * `avoid` keeps automatic walking off map-transfer playerTouch pads. */
export function findRoute(
  table: PassageTable,
  from: TilePoint,
  to: TilePoint,
  blocked: (x: number, y: number) => boolean = () => false,
  avoid: ReadonlySet<number> = new Set(),
): Dir4[] | null {
  const { width: w, height: h } = table;
  if (from.x < 0 || from.y < 0 || from.x >= w || from.y >= h) return null;
  if (to.x < 0 || to.y < 0 || to.x >= w || to.y >= h) return null;
  if (blocked(to.x, to.y)) return null;
  if (from.x === to.x && from.y === to.y) return [];

  const index = (x: number, y: number): number => y * w + x;
  const start = index(from.x, from.y);
  const goal = index(to.x, to.y);
  const parent = new Int32Array(w * h).fill(-2);
  const parentDir = new Int8Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  parent[start] = -1;
  queue[tail++] = start;

  while (head < tail && parent[goal] === -2) {
    const current = queue[head++]!;
    const x = current % w;
    const y = Math.floor(current / w);
    for (let n = 0; n < 4; n++) {
      const dir = n as Dir4;
      const nx = x + DX[dir];
      const ny = y + DY[dir];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const next = index(nx, ny);
      if (parent[next] !== -2 || blocked(nx, ny) || (next !== goal && avoid.has(next)) || !canStepFrom(table, x, y, dir)) continue;
      parent[next] = current;
      parentDir[next] = dir;
      queue[tail++] = next;
    }
  }
  if (parent[goal] === -2) return null;

  const reversed: Dir4[] = [];
  for (let at = goal; at !== start; at = parent[at]!) reversed.push(parentDir[at]! as Dir4);
  reversed.reverse();
  return reversed;
}

export type DialogClick = { kind: "confirm" } | { kind: "choice"; index: number };

/** Hit-test only pixels occupied by the visible dialog panels/rows. */
export function dialogClickAt(modal: Modal | null, point: Point): DialogClick | null {
  if (!modal) return null;
  if (modal.kind === "text") {
    return point.x >= 8 && point.x < 472 && point.y >= 172 && point.y < 264
      ? { kind: "confirm" }
      : null;
  }
  // Shop rows are operated through the kit's menu input, not this dialog
  // hit-test, so a shop modal has no clickable choice rows here.
  if (modal.kind !== "choices") return null;
  if (point.x < 220 || point.x >= 468) return null;
  const row = Math.floor((point.y - 104) / 14);
  return row >= 0 && row < modal.options.length ? { kind: "choice", index: row } : null;
}

/** Button pulses that move the interpreter's existing choice cursor and
 * confirm it. Zero releases between pulses preserve reducer edge semantics. */
export function choiceButtonSequence(current: number, target: number, count: number): number[] {
  return [...choiceSelectionSequence(current, target, count), BTN.CIRCLE, 0];
}

/** Button pulses that move the choice cursor without confirming it. Pointer
 * press uses this sequence; release appends confirm, leaving the selected
 * row visible for as long as the primary button remains held. */
export function choiceSelectionSequence(current: number, target: number, count: number): number[] {
  if (count <= 0 || target < 0 || target >= count) return [];
  const down = (target - current + count) % count;
  const up = (current - target + count) % count;
  const mask = down <= up ? BTN.DOWN : BTN.UP;
  const steps = Math.min(down, up);
  const out: number[] = [];
  for (let i = 0; i < steps; i++) out.push(mask, 0);
  return out;
}

const MENU_X0 = 40;
const MENU_X1 = 440;
const MENU_ROW_Y = 54;

/** Translate clicks on rendered save-menu rows into the same menuStep
 * actions used by buttons. The sequence selects the row, then confirms it. */
export function menuClickActions(state: MenuState, point: Point, hasFs: boolean): MenuAction[] {
  if (point.x < MENU_X0 || point.x >= MENU_X1) return [];
  if (state.kind === "root") {
    const rows = hasFs ? ROOT_FS : ROOT_CODE;
    const target = Math.floor((point.y - MENU_ROW_Y) / 20);
    if (target < 0 || target >= rows.length) return [];
    return menuSelectionActions(state.index, target, rows.length);
  }
  if (state.kind === "slots-save" || state.kind === "slots-load") {
    const target = Math.floor((point.y - MENU_ROW_Y) / 22);
    if (target < 0 || target >= 3) return [];
    return menuSelectionActions(state.index, target, 3);
  }
  if (state.kind === "message" && point.y >= 20 && point.y < 252) return ["confirm"];
  if (state.kind === "code-export" && point.y >= 20 && point.y < 252) return ["confirm"];
  return [];
}

function menuSelectionActions(current: number, target: number, count: number): MenuAction[] {
  const down = (target - current + count) % count;
  const up = (current - target + count) % count;
  const action: MenuAction = down <= up ? "down" : "up";
  const steps = Math.min(down, up);
  return [...Array<MenuAction>(steps).fill(action), "confirm"];
}
