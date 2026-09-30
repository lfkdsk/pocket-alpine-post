// game/journey.ts — deterministic winning-route driver
// and frozen RLE tape for Alpine Post, modeled on the kit's
// engine/journey.ts. The driver ADAPTS: at each boundary it BFSes toward
// the next authored tile through live passage tables and moving NPC
// bodies, and pulses confirm until fibers close. The same virtual journey
// therefore folds identically at 60/30/20/4 Hz. Below 60 Hz one host frame
// folds several motion reference ticks under one mask, so walkTo plans
// those frames with the real reducer (rpgkit engine/journey-search.ts);
// the 60 Hz path that generates the frozen tape is unchanged.
//
// The winning run: mailbag, chest, matches + soup, farm (three hay,
// sheep herd, two parcels), mine (soup for the fevered miner, one
// parcel), pines (one parcel, two mushrooms, matches for the bridge),
// lighthouse (the fifth parcel, keeper letter, three lamps, the beacon).
// All five parcels are delivered before the ending, so the five-parcel
// stanza plays.

import { buildGame } from "./game-data.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { canStepFrom, type Dir4 } from "../vendor/pocket-rpgkit/src/engine/passability.ts";
import { activePage } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import { searchWalk } from "../vendor/pocket-rpgkit/src/engine/journey-search.ts";
import type { VariableValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const BTN_UP = 0x0010;
const BTN_RIGHT = 0x0020;
const BTN_DOWN = 0x0040;
const BTN_LEFT = 0x0080;
const BTN_CIRCLE = 0x2000;
const BTN_CROSS = 0x4000;
const DX = [0, -1, 0, 1] as const;
const DY = [1, 0, -1, 0] as const;
const DIR_BTN = [BTN_DOWN, BTN_LEFT, BTN_UP, BTN_RIGHT] as const;

/** Switch/item/gold/map snapshot at a named route milestone. */
export interface MilestoneSnapshot {
  frame: number;
  mapId: string;
  x: number;
  y: number;
  switches: Record<string, boolean>;
  items: Record<string, number>;
  variables: Record<string, VariableValue>;
  gold: number;
  rng: number;
}

export function milestoneSnapshot(s: SessionState): MilestoneSnapshot {
  return {
    frame: s.interp.frame,
    mapId: s.mapId,
    x: s.move.tx,
    y: s.move.ty,
    switches: { ...s.sw.switches },
    items: { ...s.sw.items },
    variables: { ...s.sw.variables },
    gold: s.sw.gold,
    rng: s.sw.rng,
  };
}

export class Driver {
  readonly session: Session;
  state: SessionState;
  readonly masks: number[] = [];
  readonly states: SessionState[] = [];
  readonly milestones: Record<string, MilestoneSnapshot> = {};
  private prev = 0;
  private readonly project = buildGame().project;
  private readonly afterGo?: (s: SessionState) => void;

  constructor(hz = 60, opts: { afterGo?: (s: SessionState) => void } = {}) {
    this.session = createSession(this.project, hz);
    this.state = startSession(this.project, this.session);
    this.afterGo = opts.afterGo;
  }

  go(mask: number): SessionState {
    const pressed = mask & ~this.prev;
    this.prev = mask;
    this.state = stepSession(this.session, this.state, {
      buttons: mask,
      confirmEdge: !!(pressed & BTN_CIRCLE),
      cancelEdge: !!(pressed & BTN_CROSS),
      upEdge: !!(pressed & BTN_UP),
      downEdge: !!(pressed & BTN_DOWN),
    });
    this.masks.push(mask >>> 0);
    this.states.push(this.state);
    this.afterGo?.(this.state);
    return this.state;
  }

  private pads(): Set<number> {
    const map = this.session.maps.get(this.state.mapId)!;
    const out = new Set<number>();
    for (const ev of map.events ?? []) {
      if (ev.pages.some((p) => p.trigger === "playerTouch")) out.add(ev.y * map.width + ev.x);
    }
    return out;
  }

  private nextStep(tx: number, ty: number, avoid: Set<number>): Dir4 | null {
    const s = this.state;
    const table = this.session.tables.get(s.mapId)!;
    const map = this.session.maps.get(s.mapId)!;
    const W = map.width;
    const H = map.height;
    const idx = (x: number, y: number) => y * W + x;
    // Match session.tableWithBodies: only an active page with blocks:true
    // keeps the player out; sprite-less touch pads and below-character
    // events are walkable.
    const blocked = new Set<number>();
    for (const ev of map.events ?? []) {
      const page = activePage(ev, s.sw, map.id)?.page;
      if (page?.blocks !== true) continue;
      const ch = s.chars.chars[ev.id];
      if (ch) blocked.add(idx(ch.tx, ch.ty));
    }
    const start = idx(s.move.tx, s.move.ty);
    const goal = idx(tx, ty);
    if (start === goal) return null;
    const parent = new Int32Array(W * H).fill(-2);
    parent[start] = -1;
    const queue = [start];
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi]!;
      if (cur === goal) break;
      const cx = cur % W;
      const cy = Math.floor(cur / W);
      for (let dir = 0 as Dir4; dir < 4; dir = (dir + 1) as Dir4) {
        const nx = cx + DX[dir];
        const ny = cy + DY[dir];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = idx(nx, ny);
        if (parent[ni] !== -2) continue;
        if (ni !== goal && (avoid.has(ni) || blocked.has(ni))) continue;
        if (!canStepFrom(table, cx, cy, dir)) continue;
        parent[ni] = cur;
        queue.push(ni);
      }
    }
    if (parent[goal] === -2) return null;
    let cur = goal;
    let p = parent[cur]!;
    while (p !== start) {
      cur = p;
      p = parent[cur]!;
      if (p < 0) return null;
    }
    const sx = start % W;
    const sy = Math.floor(start / W);
    const nx = cur % W;
    const ny = Math.floor(cur / W);
    if (nx === sx + 1) return 3;
    if (nx === sx - 1) return 1;
    if (ny === sy + 1) return 0;
    return 2;
  }

  walkTo(tx: number, ty: number, maxFrames = 12000): void {
    const avoid = this.pads();
    if (this.session.ticksPerFrame > 1) {
      const plan = searchWalk({ session: this.session, state: this.state, prevMask: this.prev, tx, ty, avoid });
      plan.masks.forEach((mask, i) => {
        this.go(mask);
        if (JSON.stringify(this.state.move) !== JSON.stringify(plan.states[i]!.move)) {
          throw new Error(`walkTo: replay of the ${this.session.hz} Hz plan to (${tx},${ty}) diverged at step ${i}`);
        }
      });
      return;
    }
    let stuck = 0;
    for (let i = 0; i < maxFrames; i++) {
      const s = this.state;
      if (s.move.tx === tx && s.move.ty === ty && !s.move.moving) return;
      let held = 0;
      if (s.move.moving) {
        held = this.prev;
      } else {
        const dir = this.nextStep(tx, ty, avoid);
        if (dir === null) {
          if (++stuck > 600) throw new Error(`walkTo ${s.mapId}(${tx},${ty}) blocked at (${s.move.tx},${s.move.ty})`);
        } else {
          stuck = 0;
          held = DIR_BTN[dir];
        }
      }
      this.go(held);
    }
    throw new Error("walkTo timed out");
  }

  face(dir: Dir4): void {
    this.go(DIR_BTN[dir]);
  }

  talk(): void {
    this.go(0);
    this.go(BTN_CIRCLE);
  }

  settle(maxFrames = 12000, wantMap?: string): void {
    let confirm = true;
    for (let i = 0; i < maxFrames; i++) {
      const s = this.state;
      if (s.interp.main === null && !s.fade && (!wantMap || s.mapId === wantMap)) return;
      this.go(confirm ? BTN_CIRCLE : 0);
      confirm = !confirm;
    }
    throw new Error("settle timed out");
  }

  /** Like settle but requires N consecutive idle frames, so a follow-on
   *  autorun (the sheep) cannot be mistaken for the fiber end. */
  settleQuiet(idleFrames = 4, sendConfirm = true, maxFrames = 12000): void {
    let quiet = 0;
    let confirm = true;
    for (let i = 0; i < maxFrames; i++) {
      const s = this.state;
      if (s.interp.main === null && !s.fade) {
        if (++quiet >= idleFrames) return;
      } else {
        quiet = 0;
      }
      this.go(sendConfirm && confirm ? BTN_CIRCLE : 0);
      confirm = !confirm;
    }
    throw new Error("settleQuiet timed out");
  }

  waitChoices(maxFrames = 600): void {
    let confirm = true;
    for (let i = 0; i < maxFrames; i++) {
      const kind = this.state.interp.modal?.kind;
      if (kind === "choices" || this.state.interp.main === null) return;
      this.go(confirm ? BTN_CIRCLE : 0);
      confirm = !confirm;
    }
    throw new Error("waitChoices timed out");
  }

  choose(row: number): void {
    this.waitChoices();
    for (let i = 0; i < row; i++) {
      this.go(BTN_DOWN);
      this.go(0);
    }
    this.go(BTN_CIRCLE);
    this.settle();
  }

  stepOntoPad(dir: Dir4, wantMap: string): void {
    this.go(DIR_BTN[dir]);
    this.settle(12000, wantMap);
  }

  mark(name: string): void {
    this.milestones[name] = milestoneSnapshot(this.state);
  }

  get gold(): number {
    return this.state.sw.gold;
  }
  get items(): Record<string, number> {
    return { ...this.state.sw.items };
  }
  get switches(): Record<string, boolean> {
    return { ...this.state.sw.switches };
  }
}

// --- RLE -----------------------------------------------------------------------

export interface RunResult {
  masks: number[];
  milestones: Record<string, MilestoneSnapshot>;
  endFrame: number;
}

/** Play the complete winning route. */
export function playWinningRun(
  hz = 60,
  afterGo?: (s: SessionState) => void,
): RunResult {
  const d = new Driver(hz, afterGo ? { afterGo } : {});

  // 1. Mailbag.
  d.walkTo(12, 10);
  d.face(2);
  d.talk();
  d.choose(0);
  d.mark("mailbag");

  // 2. Rainy-day chest (25g).
  d.walkTo(21, 4);
  d.face(2);
  d.talk();
  d.settle();
  d.mark("chest");

  // 3. Matches and hot soup (20g spent).
  d.walkTo(4, 4);
  d.face(2);
  d.talk();
  d.choose(0); // matches
  d.talk();
  d.choose(1); // soup
  d.mark("supplies");

  // 4. East farm: parcel on the first hay standoff, three hay, second
  //    parcel, then the herd/letter for 10g.
  d.walkTo(22, 7);
  d.stepOntoPad(3, "farm");
  d.walkTo(13, 8);
  d.face(2);
  d.talk();
  d.settle(); // parcel-farm-1
  for (const hx of [13, 16, 19]) {
    d.walkTo(hx, 7);
    d.face(2);
    d.talk();
    d.settle();
  }
  d.walkTo(18, 8);
  d.face(3);
  d.talk();
  d.settle(); // parcel-farm-2
  d.walkTo(10, 9);
  d.face(2);
  d.talk();
  d.choose(0);
  d.settleQuiet(6, false); // sheep autorun
  d.mark("farm");

  // 5. West mine: parcel, then hot soup for the fevered miner.
  d.walkTo(1, 7); // just east of the farm's west pad (0,7)
  d.stepOntoPad(1, "hub");
  d.walkTo(1, 7); // just east of the hub's west pad (0,7)
  d.stepOntoPad(1, "mine");
  d.walkTo(6, 10);
  d.face(2);
  d.talk();
  d.settle(); // parcel-mine
  d.walkTo(3, 3);
  d.face(2);
  d.talk();
  d.choose(0); // give hot soup
  d.mark("mine");
  d.walkTo(14, 6);
  d.stepOntoPad(3, "hub");

  // 6. Pines: parcel, mushrooms, matches repair the bridge.
  d.walkTo(12, 1);
  d.stepOntoPad(2, "pine");
  d.walkTo(13, 9);
  d.face(2);
  d.talk();
  d.settle(); // parcel-pine
  d.walkTo(6, 8);
  d.face(2);
  d.talk();
  d.settle(); // mushroom-1
  d.walkTo(13, 4);
  d.face(2);
  d.talk();
  d.settle(); // mushroom-2
  d.walkTo(4, 4);
  d.face(2);
  d.talk();
  d.choose(0); // matches -> fire + bridge
  d.mark("bridge");
  d.walkTo(10, 1);
  d.stepOntoPad(2, "light");

  // 7. Lighthouse: fifth parcel, keeper letter, three lamps, the door.
  d.walkTo(1, 9);
  d.face(3);
  d.talk();
  d.settle(); // parcel-light (all five)
  d.walkTo(8, 10);
  d.face(2);
  d.talk();
  d.settle(); // keeper letter
  d.mark("keeper");
  for (const [lx, ly] of [[6, 8], [10, 8], [8, 12]] as [number, number][]) {
    d.walkTo(lx, ly);
    d.face(2);
    d.talk();
    d.settle();
  }
  d.mark("lamps");
  d.walkTo(8, 7);
  d.face(2);
  d.talk();
  d.settle(); // door opens

  // 8. Walk into the lamp room: the ending text opens on entry. Send no
  // confirm — the first THE END screen types out (cps 30) and holds, so a
  // real player reads it and a golden can capture it fully revealed.
  d.walkTo(8, 5);
  for (let i = 0; i < 240; i++) d.go(0);
  d.mark("end");

  // Idle tail on the held ending screen for stable framebuffer captures.
  for (let i = 0; i < 60; i++) d.go(0);

  return { masks: d.masks, milestones: d.milestones, endFrame: d.masks.length };
}

/** Run-length compress a mask stream: [mask, frames] pairs. */
export function runsFromMasks(masks: readonly number[]): [number, number][] {
  const runs: [number, number][] = [];
  for (const mask of masks) {
    const last = runs[runs.length - 1];
    if (last && last[0] === mask) last[1]++;
    else runs.push([mask, 1]);
  }
  return runs;
}

export function expandRuns(runs: readonly (readonly [number, number])[]): number[] {
  const out: number[] = [];
  for (const [mask, count] of runs) {
    for (let i = 0; i < count; i++) out.push(mask);
  }
  return out;
}
