// ui/page-sync.ts — cache key for the per-frame NPC page sync in GameView.
//
// syncSignals recomputes every slot's sprite mode only when the active
// pages may have changed. Page selection (activePage -> conditionHolds ->
// evalCondition in vendor/pocket-rpgkit/src/engine/interpreter.ts) reads
// exactly five SwitchState fields: the switches/self/items/variables banks
// and gold. GameView calls activePage without facing/extension, so those
// two condition inputs are out of scope here. shopStock is deliberately
// absent: no condition kind reads it (only the shop buy/sell path does).
//
// The four banks are copy-on-write (ownRecord copies a shared bank before
// the first write of a step), so reference identity is a sound change
// test. Gold is a plain number the gold command mutates in place, so it is
// compared by value. If evalCondition ever grows a new SwitchState input,
// this key must grow the same field — tests/pages-sync.test.ts pins it.

import type { SwitchState } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";

export interface PageSyncKey {
  mapId: string;
  switches: object;
  self: object;
  items: object;
  variables: object;
  gold: number;
}

/** Snapshot of the page-selection inputs for one state. */
export function pageSyncKey(mapId: string, sw: SwitchState): PageSyncKey {
  return {
    mapId,
    switches: sw.switches,
    self: sw.self,
    items: sw.items,
    variables: sw.variables,
    gold: sw.gold,
  };
}

/** Field-wise comparison: banks by reference, gold by value. */
export function samePageSyncKey(a: PageSyncKey, b: PageSyncKey): boolean {
  return a.mapId === b.mapId &&
    a.switches === b.switches &&
    a.self === b.self &&
    a.items === b.items &&
    a.variables === b.variables &&
    a.gold === b.gold;
}
