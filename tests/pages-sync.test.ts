// tests/pages-sync.test.ts — regression for the pagesSettled cache key in
// ui/GameView.tsx's syncSignals (extracted to ui/page-sync.ts).
//
// Page selection (activePage -> evalCondition) can read sw.gold, so a state
// change where ONLY gold moved must invalidate the slot-mode cache. The
// engine's copy-on-write banks make reference identity a sound test for the
// four banks, but gold is a plain number mutated in place — the key must
// compare it by value. If gold is removed from PageSyncKey, the "key
// changes on a gold-only write" assertions below go red.
//
// Pure bun: folds stepSession directly, no built bundle.

import { describe, expect, test } from "bun:test";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { activePage } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import { pageSyncKey, samePageSyncKey } from "../ui/page-sync.ts";
import type {
  Command,
  Dir,
  GameEvent,
  MapDef,
  Page,
  Project,
  TileId,
} from "../vendor/pocket-rpgkit/src/engine/types.ts";

const GRASS: TileId = "town.0";

function smap(id: string, w: number, h: number, events: GameEvent[]): MapDef {
  return {
    id, name: id, width: w, height: h, sheets: ["town"],
    ground: new Array(w * h).fill(GRASS), events,
  };
}

function ge(id: string, x: number, y: number, pages: Page[]): GameEvent {
  return { id, x, y, pages };
}

function pg(trigger: Page["trigger"], commands: Command[], extra: Partial<Page> = {}): Page {
  return { trigger, sprite: null, commands, ...extra };
}

function project(maps: MapDef[]): Project {
  return {
    format: "rpgkit-project/v1", title: "pages-sync", tileSize: 16,
    start: { map: "a", x: 1, y: 1, dir: "right" as Dir },
    sheets: [{ id: "town", cols: 12, rows: 11, defaultPassage: "pass" }],
    items: [], maps,
  };
}

/** Fold n host frames with no input. */
function fold(sess: Session, s: SessionState, frames: number): SessionState {
  let out = s;
  for (let i = 0; i < frames; i++) out = stepSession(sess, out, { buttons: 0 });
  return out;
}

/** Fold until `pred` holds or the frame ceiling trips. */
function foldUntil(sess: Session, s: SessionState, pred: (s: SessionState) => boolean, ceiling = 300): SessionState {
  let out = s;
  for (let i = 0; i < ceiling; i++) {
    if (pred(out)) return out;
    out = stepSession(sess, out, { buttons: 0 });
  }
  if (pred(out)) return out;
  throw new Error("foldUntil timed out");
}

// An NPC whose second page is gated on gold: page 0 shows "npc-a" for free,
// page 1 shows "npc-b" once the party holds 50 gold.
const gate = ge("gate", 3, 1, [
  pg("action", [], { sprite: "npc-a" }),
  pg("action", [], { sprite: "npc-b", condition: { all: [{ kind: "gold", amount: 50 }] } }),
]);

// A one-shot autorun that grants 50 gold and erases itself, so the gold
// write is the ONLY state change between the two compared states (no bank
// is written: erase marks the event, it does not touch a switch record).
const gilder = ge("gilder", 0, 0, [
  pg("autorun", [{ op: "gold", set: "add", amount: 50 }, { op: "erase" }]),
]);

const proj = project([smap("a", 4, 4, [gate, gilder])]);

describe("pagesSettled cache key", () => {
  test("a gold-only write changes the key and flips the gold-gated page", () => {
    const sess = createSession(proj, 60);
    const s0 = startSession(proj, sess);
    expect(s0.sw.gold).toBe(0);
    expect(activePage(gate, s0.sw, "a")?.index).toBe(0);

    const s1 = foldUntil(sess, s0, (s) => s.sw.gold === 50);
    // The autorun erased itself: folding on must not grant gold again.
    expect(fold(sess, s1, 120).sw.gold).toBe(50);

    // COW premise for identity comparison: the gold command mutated sw.gold
    // in place without copying any of the four banks.
    expect(s1.sw.switches).toBe(s0.sw.switches);
    expect(s1.sw.self).toBe(s0.sw.self);
    expect(s1.sw.items).toBe(s0.sw.items);
    expect(s1.sw.variables).toBe(s0.sw.variables);
    expect(s1.sw.gold).not.toBe(s0.sw.gold);

    // The gold-gated page is now active: syncSignals must recompute the
    // slot mode, i.e. the cache key must differ.
    expect(activePage(gate, s1.sw, "a")?.index).toBe(1);
    const k0 = pageSyncKey("a", s0.sw);
    const k1 = pageSyncKey("a", s1.sw);
    expect(samePageSyncKey(k0, k1)).toBe(false);
    // Deep equality goes red at runtime if gold is dropped from the key:
    // with only bank identities in it, k0 and k1 would be structurally equal.
    expect(k1).not.toEqual(k0);
    expect(k1).toEqual({
      mapId: "a",
      switches: s1.sw.switches,
      self: s1.sw.self,
      items: s1.sw.items,
      variables: s1.sw.variables,
      gold: 50,
    });
  });

  test("the key is stable across frames that write nothing", () => {
    const sess = createSession(proj, 60);
    const s0 = startSession(proj, sess);
    const s1 = foldUntil(sess, s0, (s) => s.sw.gold === 50);
    const s2 = fold(sess, s1, 60);
    // No commands ran: gold unchanged, banks still shared, so the cache may
    // legitimately hit.
    expect(samePageSyncKey(pageSyncKey("a", s1.sw), pageSyncKey("a", s2.sw))).toBe(true);
  });
});
