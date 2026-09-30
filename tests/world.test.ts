// tests/world.test.ts — S2 structural gate for Alpine Post:
// the emitted rpgkit-project/v1 document validates against the kit schema;
// every tile/sprite/transfer reference resolves; border pads form the
// hub<->farm/mine/pine<->light chain; and from the start tile, walking the
// passage tables through transfer pads can REACH every map, every
// non-blocking event cell, and a standable tile beside every blocking
// event. Also checks the cooked assets and the seeded decor determinism.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { validateSchema } from "../vendor/pocket-rpgkit/src/engine/schema-validate.ts";
import { buildPassage, isStandable } from "../vendor/pocket-rpgkit/src/engine/passability.ts";
import { activePage, createSwitchState } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import type { Command, MapDef, Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { buildGame, ANIMATIONS, ANIM_SPRITE_KEYS, STATIC_SPRITES } from "../game/game-data.ts";
import { ANIM_ATLASES } from "../ui/assets.ts";

const { project, maps } = buildGame();
const byId = new Map(maps.map((m) => [m.id, m]));
const sheets = new Map(project.sheets.map((s) => [s.id, s]));

// --- schema -------------------------------------------------------------------

describe("alpine-post v1 document", () => {
  test("emitted data/alpine-post.json equals buildGame()", async () => {
    const onDisk = await Bun.file(new URL("../data/alpine-post.json", import.meta.url)).json();
    expect(onDisk).toEqual(project);
  });

  test("validates against the rpgkit-project v1 JSON schema", async () => {
    const schema = await Bun.file(new URL("../vendor/pocket-rpgkit/src/data/schema.json", import.meta.url)).json();
    expect(validateSchema(schema, project as unknown as Record<string, unknown>)).toEqual([]);
  });
});

// --- references ---------------------------------------------------------------

describe("alpine-post world references", () => {
  test("every tile id names a real sheet cell", () => {
    const refs: Array<[string, TileRef]> = [];
    type TileRef = { sheet: string; cell: number };
    const parse = (id: string): TileRef => {
      const dot = id.lastIndexOf(".");
      return { sheet: id.slice(0, dot), cell: Number(id.slice(dot + 1)) };
    };
    for (const m of maps) {
      for (const g of m.ground) if (typeof g === "string") refs.push([m.id, parse(g)]);
      for (const [, u] of m.upper ?? []) if (typeof u === "string") refs.push([m.id, parse(u)]);
    }
    for (const item of project.items) refs.push(["items", parse(item.sprite)]);
    for (const [, ref] of refs) {
      const s = sheets.get(ref.sheet);
      expect(s, `unknown sheet ${ref.sheet}`).toBeTruthy();
      expect(ref.cell, `cell out of bounds ${ref.sheet}.${ref.cell}`).toBeLessThan(s!.cols * s!.rows);
    }
  });

  test("events are in bounds with unique ids and resolvable sprite keys", () => {
    const seen = new Set<string>();
    for (const m of maps) {
      const ids = new Set<string>();
      for (const ev of m.events ?? []) {
        expect(ids.has(ev.id), `dup event ${m.id}/${ev.id}`).toBe(false);
        ids.add(ev.id);
        seen.add(`${m.id}/${ev.id}`);
        expect(ev.x).toBeGreaterThanOrEqual(0);
        expect(ev.x).toBeLessThan(m.width);
        expect(ev.y).toBeGreaterThanOrEqual(0);
        expect(ev.y).toBeLessThan(m.height);
        for (const page of ev.pages) {
          if (page.sprite) {
            expect(
              page.sprite in STATIC_SPRITES || page.sprite in ANIM_SPRITE_KEYS,
              `unresolved sprite ${page.sprite} on ${m.id}/${ev.id}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  test("all transfers target a standable tile on a real map", () => {
    for (const m of maps) {
      const tables = new Map(maps.map((mm) => [mm.id, buildPassage(mm, sheets)]));
      for (const ev of m.events ?? []) {
        for (const page of ev.pages) {
          for (const c of page.commands) walk(c);
        }
      }
      function walk(c: Command): void {
        if (c.op === "transfer") {
          // Alpine Post authors only literal transfers; the structural gate
          // does not exercise variable-reference targets.
          const { map, x, y } = literalTransfer(c);
          const tm = byId.get(map);
          expect(tm, `transfer to unknown map ${map}`).toBeTruthy();
          const table = tables.get(map)!;
          expect(isStandable(table, x, y), `bad landing ${map}(${x},${y})`).toBe(true);
        }
        if ("commands" in c) for (const sub of (c as { commands: Command[] }).commands) walk(sub);
      }
    }
  });

  test("border pads make the hub<->farm/mine and hub->pine<->light chain bidirectional", () => {
    const pads = collectTransfers();
    const has = (from: string, to: string) => pads.some((p) => p.from === from && p.to === to);
    expect(has("hub", "farm")).toBe(true);
    expect(has("farm", "hub")).toBe(true);
    expect(has("hub", "mine")).toBe(true);
    expect(has("mine", "hub")).toBe(true);
    expect(has("hub", "pine")).toBe(true);
    expect(has("pine", "hub")).toBe(true);
    expect(has("pine", "light")).toBe(true);
    expect(has("light", "pine")).toBe(true);
  });

  test("animated overlays name existing atlases and stay in bounds", () => {
    for (const [mapId, cells] of Object.entries(ANIMATIONS)) {
      const m = byId.get(mapId)!;
      for (const a of cells) {
        expect(ANIM_ATLASES[a.atlas]).toBeTruthy();
        expect(a.x).toBeGreaterThanOrEqual(0);
        expect(a.x).toBeLessThan(m.width);
        expect(a.y).toBeGreaterThanOrEqual(0);
        expect(a.y).toBeLessThan(m.height);
      }
    }
    for (const key of Object.values(ANIM_SPRITE_KEYS)) {
      expect(ANIM_ATLASES[key.atlas]).toBeTruthy();
    }
  });

  test("cooked map, npc, player and atlas files exist", () => {
    for (const m of maps) {
      expect(existsSync(`assets/map-${m.id}-ground.png`)).toBe(true);
      expect(existsSync(`assets/map-${m.id}-upper.png`)).toBe(true);
    }
    for (const name of Object.keys(STATIC_SPRITES)) {
      expect(existsSync(`assets/npc/${name}.png`), `missing npc ${name}`).toBe(true);
    }
    for (const name of Object.keys(ANIM_ATLASES)) {
      expect(existsSync(`assets/anim/${name}.png`), `missing atlas ${name}`).toBe(true);
    }
  });

  test("decor is deterministic: buildGame() is a pure function", () => {
    const a = JSON.stringify(buildGame().project);
    const b = JSON.stringify(buildGame().project);
    expect(a).toBe(b);
  });
});

// --- reachability --------------------------------------------------------------

describe("alpine-post traversal", () => {
  // Walking graph from a switch bank. FRESH: the broken bridge (page gated
  // on bridge-fixed) keeps the lighthouse unreachable. OPEN: with the
  // repair/keeper/lamp switches flipped, every quest tile is reachable.
  const tables = new Map(maps.map((m) => [m.id, buildPassage(m, sheets)]));

  function worldAt(switchOverrides: Record<string, boolean>, selfOverrides: Record<string, "A" | "B" | "C" | "D"> = {}): {
    standable: (map: MapDef, x: number, y: number) => boolean;
    bfs: () => { maps: Set<string>; nodes: Set<string> };
  } {
    const sw = createSwitchState({ switches: switchOverrides, self: selfOverrides });
    const blockingBodies = new Map<string, Set<number>>();
    const padTargets = new Map<string, { map: string; x: number; y: number }>();
    for (const m of maps) {
      const bodies = new Set<number>();
      for (const ev of m.events ?? []) {
        const page = activePage(ev, sw, m.id);
        if (page && page.page.blocks === true) bodies.add(ev.y * m.width + ev.x);
        if (page && page.page.trigger === "playerTouch") {
          const tr = firstTransfer(page.page.commands);
          if (tr) {
            const { map, x, y } = literalTransfer(tr);
            padTargets.set(`${m.id}:${ev.x},${ev.y}`, { map, x, y });
          }
        }
      }
      blockingBodies.set(m.id, bodies);
    }
    const standable = (map: MapDef, x: number, y: number): boolean => {
      if (!isStandable(tables.get(map.id)!, x, y)) return false;
      return !blockingBodies.get(map.id)!.has(y * map.width + x);
    };
    const neighbors = (m: MapDef, x: number, y: number): string[] =>
      [[x, y - 1], [x, y + 1], [x - 1, y], [x + 1, y]]
        .filter(([nx, ny]) => nx >= 0 && ny >= 0 && nx < m.width && ny < m.height)
        .filter(([nx, ny]) => standable(m, nx, ny))
        .map(([nx, ny]) => `${m.id}:${nx},${ny}`);
    const bfs = () => {
      const nodes = new Set<string>();
      const mapsSeen = new Set<string>([project.start.map]);
      const queue = [`${project.start.map}:${project.start.x},${project.start.y}`];
      nodes.add(queue[0]!);
      while (queue.length) {
        const cur = queue.shift()!;
        const [mapId, rest] = cur.split(":");
        const [x, y] = rest!.split(",").map(Number);
        const m = byId.get(mapId!)!;
        for (const n of neighbors(m, x!, y!)) {
          if (!nodes.has(n)) {
            nodes.add(n);
            queue.push(n);
          }
        }
        const pad = padTargets.get(cur);
        if (pad) {
          mapsSeen.add(pad.map);
          const target = `${pad.map}:${pad.x},${pad.y}`;
          if (!nodes.has(target)) {
            nodes.add(target);
            queue.push(target);
          }
        }
      }
      return { maps: mapsSeen, nodes };
    };
    return { standable, bfs };
  }

  test("fresh world: hamlet, farm, mine, pine are reachable; the lighthouse is gated", () => {
    const { bfs } = worldAt({});
    const reached = bfs();
    expect(reached.maps.has("hub")).toBe(true);
    expect(reached.maps.has("farm")).toBe(true);
    expect(reached.maps.has("mine")).toBe(true);
    expect(reached.maps.has("pine")).toBe(true);
    expect(reached.maps.has("light")).toBe(false);
  });

  test("fresh world: every hub/farm/mine/pine event is reachable or adjacent", () => {
    const { bfs } = worldAt({});
    const reached = bfs();
    for (const m of maps.filter((mm) => mm.id !== "light")) {
      const bodies = new Set(
        (m.events ?? [])
          .filter((ev) => activePage(ev, createSwitchState(), m.id)?.page.blocks === true)
          .map((ev) => ev.y * m.width + ev.x),
      );
      for (const ev of m.events ?? []) {
        const node = `${m.id}:${ev.x},${ev.y}`;
        if (bodies.has(ev.y * m.width + ev.x) || !isStandable(tables.get(m.id)!, ev.x, ev.y)) {
          // Blocking body, or a wall-mounted event (e.g. the apothecary
          // window): action fires from a standable tile in front.
          const anyNeighbor = [[ev.x, ev.y - 1], [ev.x, ev.y + 1], [ev.x - 1, ev.y], [ev.x + 1, ev.y]]
            .some(([nx, ny]) => reached.nodes.has(`${m.id}:${nx},${ny}`));
          expect(anyNeighbor, `event ${node} has no reachable adjacent tile`).toBe(true);
        } else {
          expect(reached.nodes.has(node), `event tile ${node} unreachable`).toBe(true);
        }
      }
    }
  });

  test("quest-open world: lighthouse, all lamps and the beacon are reachable", () => {
    const { bfs } = worldAt(
      {
        "bridge-fixed": true,
        "fire-lit": true,
        "keeper-done": true,
        "lamp-1": true,
        "lamp-2": true,
        "lamp-3": true,
        "lamp-ready": true,
      },
      {
        "light/tower-door": "A",
        "light/lamp-1": "A",
        "light/lamp-2": "A",
        "light/lamp-3": "A",
      },
    );
    const reached = bfs();
    expect(reached.maps.has("light")).toBe(true);
    for (const node of [
      "light:8,12", // landing
      "light:8,10", // south of the keeper
      "light:7,9", // around the keeper
      "light:6,8", "light:10,8", // beside lamps 1/2
      "light:8,5", // beacon cell (door open)
      "farm:12,6", // beside a hay bale
      "pine:4,4", // hermit's camp
    ]) {
      expect(reached.nodes.has(node), `${node} unreachable`).toBe(true);
    }
    // Every light event is reachable or adjacent in the open world.
    const light = byId.get("light")!;
    for (const ev of light.events ?? []) {
      const node = `${light.id}:${ev.x},${ev.y}`;
      const adjacent = [[ev.x, ev.y - 1], [ev.x, ev.y + 1], [ev.x - 1, ev.y], [ev.x + 1, ev.y]]
        .some(([nx, ny]) => reached.nodes.has(`${light.id}:${nx},${ny}`));
      expect(reached.nodes.has(node) || adjacent, `light event ${node} isolated`).toBe(true);
    }
  });
});

function firstTransfer(cmds: readonly Command[]): Extract<Command, { op: "transfer" }> | null {
  for (const c of cmds) {
    if (c.op === "transfer") return c;
    if ("commands" in c) {
      const inner = firstTransfer((c as { commands: Command[] }).commands);
      if (inner) return inner;
    }
  }
  return null;
}

/** Narrow a transfer to its literal fields. The kit also accepts
 *  variable-reference targets (TransferMap/TransferCoordinate), but Alpine
 *  Post authors none; the structural gate throws if that ever changes. */
function literalTransfer(c: Extract<Command, { op: "transfer" }>): { map: string; x: number; y: number } {
  if (typeof c.map !== "string" || typeof c.x !== "number" || typeof c.y !== "number") {
    throw new Error(`variable-reference transfer not authored: ${JSON.stringify(c)}`);
  }
  return { map: c.map, x: c.x, y: c.y };
}

function collectTransfers(): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (const m of maps) {
    for (const ev of m.events ?? []) {
      for (const page of ev.pages) {
        for (const c of page.commands) {
          if (c.op === "transfer") out.push({ from: m.id, to: literalTransfer(c).map });
          if ("commands" in c) for (const s of (c as { commands: Command[] }).commands) if (s.op === "transfer") out.push({ from: m.id, to: literalTransfer(s).map });
        }
      }
    }
  }
  return out;
}

// Keep the Project import used for type-level checks elsewhere.
export type _Project = Project;
