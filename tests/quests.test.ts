// tests/quests.test.ts — S3 behavior gate for Alpine Post over
// the PURE session reducer (no host, no pixels): mailbag handout, the
// three-wares shop with not-enough-gold branches, mushroom sales, the hay/
// sheep herd route, soup for the miner, matches for the hermit opening the
// bridge, keeper letter, three lamps, the triple-lamp door, the autorun
// ending (both parcel branches), the five-parcel common-event counter and
// the one-time clerk payout.

import { describe, expect, test } from "bun:test";
import { buildGame } from "../game/game-data.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { canStepFrom } from "../vendor/pocket-rpgkit/src/engine/passability.ts";
import type { Dir4 } from "../vendor/pocket-rpgkit/src/engine/passability.ts";
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

class Driver {
  readonly session: Session;
  state: SessionState;
  private prev = 0;
  private readonly project = buildGame().project;

  constructor(hz = 60) {
    this.session = createSession(this.project, hz);
    this.state = startSession(this.project, this.session);
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
    const blocked = new Set<number>();
    for (const ch of Object.values(s.chars.chars)) {
      blocked.add(idx(ch.tx, ch.ty));
      if (ch.moving) blocked.add(idx(ch.tx + DX[ch.stepDir], ch.ty + DY[ch.stepDir]));
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

  walkTo(tx: number, ty: number, maxFrames = 8000): void {
    const avoid = this.pads();
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

  /** Face a direction by pressing into the tile (bounded bodies turn the
   *  mover in place). */
  face(dir: Dir4): void {
    this.go(DIR_BTN[dir]);
  }

  settle(maxFrames = 8000, wantMap?: string): void {
    let confirm = true;
    for (let i = 0; i < maxFrames; i++) {
      const s = this.state;
      if (s.interp.main === null && !s.fade && (!wantMap || s.mapId === wantMap)) return;
      this.go(confirm ? BTN_CIRCLE : 0);
      confirm = !confirm;
    }
    throw new Error("settle timed out");
  }

  /** Settle that also bridges the one-frame gap before a follow-on
   *  autorun starts (the sheep herds via a new fiber on the next frame).
   *  With confirm=false no CIRCLE is sent, so an adjacent talkable NPC
   *  cannot be reopened while the autorun runs. */
  settleQuiet(idleFrames = 4, maxFrames = 8000, sendConfirm = true): void {
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

  /** Open the blocking event in front (caller already faces it). The
   *  release frame matters: settle() can leave CIRCLE held, and a press
   *  only registers on the held-level transition. */
  talk(): void {
    this.go(0);
    this.go(BTN_CIRCLE);
  }

  /** Advance any open TEXT modal until the choices box (or fiber end). */
  waitChoices(maxFrames = 400): void {
    let confirm = true;
    for (let i = 0; i < maxFrames; i++) {
      const kind = this.state.interp.modal?.kind;
      if (kind === "choices") return;
      if (this.state.interp.main === null) return;
      this.go(confirm ? BTN_CIRCLE : 0);
      confirm = !confirm;
    }
    throw new Error("waitChoices timed out");
  }

  /** Pick a row in the open choices modal (0-based), then settle the
   *  branch. */
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
    this.settle(8000, wantMap);
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
  vars(): Record<string, VariableValue> {
    return { ...this.state.sw.variables };
  }
  at(map: string, x: number, y: number): boolean {
    return this.state.mapId === map && this.state.move.tx === x && this.state.move.ty === y;
  }
}

/** Open the chest at hub (21,3) from the yard gate tile (21,4). */
function openVillageChest(d: Driver): void {
  d.walkTo(21, 4);
  d.face(2);
  d.talk();
  d.settle();
}

// --- mailbag ------------------------------------------------------------------

describe("alpine-post quests — mailbag", () => {
  test("the postmaster hands over three letters and the mailbag switch", () => {
    const d = new Driver();
    d.walkTo(12, 10);
    d.face(2);
    d.talk();
    d.choose(0); // Take the mail
    expect(d.switches.mailbag).toBe(true);
    expect(d.items["letter-farmer"]).toBe(1);
    expect(d.items["letter-miner"]).toBe(1);
    expect(d.items["letter-keeper"]).toBe(1);
  });

  test("asking twice does not duplicate the letters", () => {
    const d = new Driver();
    d.walkTo(12, 10);
    d.face(2);
    d.talk();
    d.choose(0);
    d.talk();
    d.choose(0);
    expect(d.items["letter-farmer"]).toBe(1);
    expect(d.items["letter-keeper"]).toBe(1);
  });
});

// --- shop ---------------------------------------------------------------------

describe("alpine-post quests — general store", () => {
  test("not-enough-gold refuses each ware without changing gold", () => {
    const d = new Driver();
    d.walkTo(4, 4);
    d.face(2);
    d.talk();
    for (const row of [0, 1, 2]) {
      const before = d.gold;
      // Re-open the shop choices for each ware: the modal closes after a
      // branch, so talk again each time.
      if (row > 0) {
        d.talk();
      }
      d.choose(row);
      expect(d.gold).toBe(before);
    }
    expect(d.items.matches ?? 0).toBe(0);
    expect(d.items.soup ?? 0).toBe(0);
    expect(d.items.stamp ?? 0).toBe(0);
  });

  test("with gold, matches, soup and stamp can each be bought once", () => {
    const d = new Driver();
    openVillageChest(d);
    expect(d.gold).toBe(25);
    d.walkTo(4, 4);
    d.face(2);
    d.talk();
    d.choose(0); // matches 5
    expect(d.items.matches).toBe(1);
    expect(d.gold).toBe(20);
    d.talk();
    d.choose(1); // soup 15
    expect(d.items.soup).toBe(1);
    expect(d.gold).toBe(5);
    d.talk();
    d.choose(2); // stamp 10 -> refused with 5
    expect(d.items.stamp ?? 0).toBe(0);
    expect(d.gold).toBe(5);
  });

  test("mushrooms sell for three gold each in pairs or singly", () => {
    const d = new Driver();
    // Grant mushrooms by visiting the pine pickups would route through the
    // north gate; drive the reducer directly through the two items instead
    // via one extra farm payout? Keep it pure-data: emulate a fresh run to
    // the pines.
    d.walkTo(12, 1);
    d.stepOntoPad(2, "pine");
    d.walkTo(6, 8); // mushroom-1 sits at (6,7); stand below and face up
    d.face(2);
    d.talk();
    d.settle();
    expect(d.items.mushroom).toBe(1);
    // Sell single through the shop: walk to the south pad, transfer.
    d.walkTo(9, 10);
    d.stepOntoPad(0, "hub"); // pine return lands hub (12,1)
    d.walkTo(4, 4);
    d.face(2);
    d.talk();
    d.choose(3); // sell row
    expect(d.gold).toBe(3);
    expect(d.items.mushroom ?? 0).toBe(0);
  });
});

// --- farm ---------------------------------------------------------------------

describe("alpine-post quests — east-slope farm", () => {
  test("the farmer holds the letter until three hay are gathered", () => {
    const d = new Driver();
    d.walkTo(12, 10);
    d.face(2);
    d.talk();
    d.choose(0); // mailbag
    d.walkTo(22, 7);
    d.stepOntoPad(3, "farm");
    d.walkTo(10, 9);
    d.face(2);
    d.talk();
    d.settle();
    // Greeting text only; no choices branch exists without three hay.
    expect(d.switches["farmer-done"] ?? false).toBe(false);
    expect(d.items["letter-farmer"]).toBe(1);
  });

  test("hay, sheep herd and letter delivery pay ten gold", () => {
    const d = new Driver();
    d.walkTo(12, 10);
    d.face(2);
    d.talk();
    d.choose(0); // mailbag
    // East to the farm.
    d.walkTo(22, 7);
    d.stepOntoPad(3, "farm");
    // The first parcel sits on the hay-1 standoff (13,7); collect it
    // first so the southern tile frees.
    d.walkTo(13, 8);
    d.face(2);
    d.talk();
    d.settle();
    // Three hay bales on row 6; stand one tile south and face up. The
    // eastern standoff (19,7) is reached along the row.
    for (const hx of [13, 16, 19]) {
      d.walkTo(hx, 7);
      d.face(2);
      d.talk();
      d.settle();
    }
    expect(d.items.hay).toBe(3);
    // Herd via the farmer at (10,8): stand at (10,9) facing up.
    d.walkTo(10, 9);
    d.face(2);
    d.talk();
    d.choose(0); // herd them home
    d.settleQuiet(4, 8000, false); // sheep autorun, no confirm: don't reopen the farmer
    expect(d.switches["sheep-herd"]).toBe(true);
    expect(d.switches["farmer-done"]).toBe(true);
    expect(d.items["letter-farmer"] ?? 0).toBe(0);
    expect(d.items.hay).toBe(0);
    expect(d.gold).toBe(10);
    // The sheep walked its route into the pen at (4,11).
    const sheep = d.state.chars.chars["sheep"];
    expect(sheep ? [sheep.tx, sheep.ty] : null).toEqual([4, 11]);
  });
});

// --- mine ---------------------------------------------------------------------

describe("alpine-post quests — west-slope mine", () => {
  test("soup and the letter settle the fevered miner", () => {
    const d = new Driver();
    d.walkTo(12, 10);
    d.face(2);
    d.talk();
    d.choose(0); // mailbag
    openVillageChest(d);
    d.walkTo(4, 4);
    d.face(2);
    d.talk();
    d.choose(1); // soup
    // West to the mine.
    d.walkTo(1, 7);
    d.stepOntoPad(1, "mine");
    d.walkTo(3, 3); // below the hut door
    d.face(2);
    d.talk();
    d.choose(0); // give hot soup
    expect(d.switches["miner-done"]).toBe(true);
    expect(d.items["letter-miner"] ?? 0).toBe(0);
    expect(d.items.soup ?? 0).toBe(0);
  });
});

// --- pine / bridge -------------------------------------------------------------

describe("alpine-post quests — pine trail bridge", () => {
  test("the bridge blocks transfer until the hermit gets matches", () => {
    const d = new Driver();
    d.walkTo(12, 1);
    d.stepOntoPad(2, "pine");
    // Stand on the bridge pad (10,0): closed page blocks the body, so
    // approach (10,1) facing up and action.
    d.walkTo(10, 1);
    d.face(2);
    d.talk();
    d.settle();
    expect(d.switches["bridge-fixed"] ?? false).toBe(false);
    // Step up: the closed page blocks; map does not change.
    d.go(BTN_UP);
    expect(d.state.mapId).toBe("pine");
  });

  test("matches light the fire, fix the bridge and open the transfer", () => {
    const d = new Driver();
    openVillageChest(d);
    d.walkTo(4, 4);
    d.face(2);
    d.talk();
    d.choose(0); // matches
    d.walkTo(12, 1);
    d.stepOntoPad(2, "pine");
    d.walkTo(4, 4); // beside the hermit at (4,3)
    d.face(2);
    d.talk();
    d.choose(0); // give matches
    expect(d.items.matches ?? 0).toBe(0);
    expect(d.switches["fire-lit"]).toBe(true);
    expect(d.switches["bridge-fixed"]).toBe(true);
    // Cross.
    d.walkTo(10, 1);
    d.stepOntoPad(2, "light");
    expect(d.state.mapId).toBe("light");
  });
});

// --- lighthouse ----------------------------------------------------------------

describe("alpine-post quests — lighthouse ending", () => {
  function setupForLight(): Driver {
    const d = new Driver();
    // Take the mailbag (the keeper letter is required on the summit).
    d.walkTo(12, 10);
    d.face(2);
    d.talk();
    d.choose(0);
    openVillageChest(d); // 25
    d.walkTo(4, 4);
    d.face(2);
    d.talk();
    d.choose(0); // matches
    d.talk();
    d.choose(1); // soup
    d.walkTo(12, 1);
    d.stepOntoPad(2, "pine");
    d.walkTo(4, 4);
    d.face(2);
    d.talk();
    d.choose(0); // matches -> bridge
    d.walkTo(10, 1);
    d.stepOntoPad(2, "light");
    return d;
  }

  test("the keeper takes the letter and unlocks the lamps", () => {
    const d = setupForLight();
    d.walkTo(8, 10); // below keeper (8,9)
    d.face(2);
    d.talk();
    d.settle();
    expect(d.switches["keeper-done"]).toBe(true);
    expect(d.items["letter-keeper"] ?? 0).toBe(0);
  });

  test("a lamp refuses to light before the keeper accepts the letter", () => {
    const d = setupForLight();
    d.walkTo(6, 8); // below lamp-1 at (6,7)
    d.face(2);
    d.talk();
    d.settle();
    expect(d.switches["lamp-1"] ?? false).toBe(false);
  });

  test("three lamps open the door and the autorun ending plays", () => {
    const d = setupForLight();
    d.walkTo(8, 10);
    d.face(2);
    d.talk();
    d.settle(); // keeper
    for (const [lx, ly] of [[6, 8], [10, 8], [8, 12]] as [number, number][]) {
      d.walkTo(lx, ly);
      d.face(ly === 12 ? 2 : 2);
      d.talk();
      d.settle();
    }
    expect(d.switches["lamp-1"]).toBe(true);
    expect(d.switches["lamp-2"]).toBe(true);
    expect(d.switches["lamp-3"]).toBe(true);
    // Door.
    d.walkTo(8, 7);
    d.face(2);
    d.talk();
    d.settle();
    expect(d.switches["lamp-ready"]).toBe(true);
    // The beacon autorun fires on its own; settle clicks through THE END.
    d.settleQuiet(20, 8000, true);
    // The ending spent page self-latches: its fiber is gone and the
    // lamp-ready switch holds.
    expect(d.state.interp.main).toBeNull();
    expect(d.switches["lamp-ready"]).toBe(true);
  });

  test("the ending carries the five-parcel stanza only when all five are delivered", () => {
    for (const parcels of [5, 0]) {
      const project = buildGame().project;
      const sess = createSession(project, 60);
      let st = startSession(project, sess);
      st.mapId = "light";
      // Start one tile south of the beacon and walk in: the ending is a
      // playerTouch page gated on door-open.
      st.move.tx = 8;
      st.move.ty = 6;
      st.move.px = 8 * 16;
      st.move.py = 6 * 16;
      st.move.facing = 2;
      st.sw.switches["door-open"] = true;
      st.sw.variables.parcels = parcels;
      const seen: string[] = [];
      let confirm = true;
      let mask = 0x0010; // UP, held until the player reaches the cell
      for (let i = 0; i < 900; i++) {
        st = stepSession(sess, st, {
          buttons: st.interp.main ? (confirm ? BTN_CIRCLE : 0) : mask,
          confirmEdge: st.interp.main ? confirm : false,
        });
        const m = st.interp.modal;
        if (m?.kind === "text") seen.push(...m.lines);
        if (st.interp.main) {
          mask = 0;
          confirm = !confirm;
        }
        if (st.interp.main === null && seen.length > 0 && i > 40) break;
      }
      const text = seen.join(" ");
      if (parcels === 5) expect(text).toContain("five lost parcels");
      else expect(text).not.toContain("five lost parcels");
      expect(text).toContain("THE END.");
    }
  });
});

// --- parcels -------------------------------------------------------------------

describe("alpine-post quests — five parcels and the clerk", () => {
  test("every parcel pickup increments the shared counter through its common event", () => {
    const d = new Driver();
    d.walkTo(22, 7);
    d.stepOntoPad(3, "farm");
    // Two parcels in the farm: (13,7) from below, (19,8) from the west.
    d.walkTo(13, 8);
    d.face(2);
    d.talk();
    d.settle();
    d.walkTo(18, 8);
    d.face(3);
    d.talk();
    d.settle();
    expect(d.vars().parcels).toBe(2);
    // Parcels stay collected after revisiting the cell.
    d.walkTo(13, 8);
    expect(d.vars().parcels).toBe(2);
  });

  test("the clerk pays twenty gold once for all five", () => {
    const d = new Driver();
    // Drive the counter to five by issuing the common event through five
    // parcel pickups across the maps: 2 farm, 1 mine, 1 pine, 1 light.
    d.walkTo(22, 7);
    d.stepOntoPad(3, "farm");
    for (const spot of [[13, 8, 2], [18, 8, 3]] as [number, number, Dir4][]) {
      d.walkTo(spot[0], spot[1]);
      d.face(spot[2]);
      d.talk();
      d.settle();
    }
    d.walkTo(1, 7); // stand just east of the farm's west pad (0,7)
    d.stepOntoPad(1, "hub");
    d.walkTo(1, 7); // stand just east of the hub's west pad (0,7)
    d.stepOntoPad(1, "mine");
    d.walkTo(6, 10);
    d.face(2);
    d.talk();
    d.settle();
    d.walkTo(14, 6); // just west of the mine's east pad (15,6)
    d.stepOntoPad(3, "hub"); // mine return lands (1,7)
    d.walkTo(12, 1);
    d.stepOntoPad(2, "pine");
    d.walkTo(13, 9);
    d.face(2);
    d.talk();
    d.settle();
    expect(d.vars().parcels).toBe(4);
    // Back to the hub to fund the bridge: chest gold and a box of matches.
    d.walkTo(9, 10);
    d.stepOntoPad(0, "hub");
    openChestAndBuyMatches(d);
    // Up the trail again; the hermit repairs the bridge for the matches.
    d.walkTo(12, 1);
    d.stepOntoPad(2, "pine");
    d.walkTo(4, 4);
    d.face(2);
    d.talk();
    d.choose(0);
    d.walkTo(10, 1);
    d.stepOntoPad(2, "light");
    d.walkTo(1, 9); // west of the parcel at (2,9)
    d.face(3);
    d.talk();
    d.settle();
    expect(d.vars().parcels).toBe(5);
    d.walkTo(8, 12); // above the light's south pad (8,13)
    d.stepOntoPad(0, "pine");
    d.walkTo(9, 10); // above the pine's south pad (9,11)
    d.stepOntoPad(0, "hub"); // lands hub (12,1)
    d.walkTo(6, 4); // below clerk (6,3)
    d.face(2);
    d.talk();
    d.settle();
    expect(d.switches["parcels-done"]).toBe(true);
    expect(d.gold).toBe(40); // 25 chest - 5 matches + 20 payout
    // Talking again does not pay twice.
    d.talk();
    d.settle();
    expect(d.gold).toBe(40);
  });
});

function openChestAndBuyMatches(d: Driver): void {
  if (d.state.mapId !== "hub") throw new Error("must be on hub");
  openVillageChest(d);
  d.walkTo(4, 4);
  d.face(2);
  d.talk();
  d.choose(0);
}
