// game/restore.ts — restore a save snapshot onto the multi-map session.
// The kit ships a single-map restore gate
// (vendor/pocket-rpgkit/src/engine/save-restore.ts); this app-layer helper
// extends the documented MV semantics across maps: a load whose snapshot
// names another map enters that map exactly the way a transfer does —
// fresh map interpreter links onto the saved switch bank, characters
// rebuilt at their authored cells (the save snapshot intentionally
// excludes chars: vendor/pocket-rpgkit/src/engine/save.ts). No engine code
// changes were needed.

import { createChars } from "../vendor/pocket-rpgkit/src/engine/chars.ts";
import { restoreProblem } from "../vendor/pocket-rpgkit/src/engine/save-restore.ts";
import { decodeExtension } from "../vendor/pocket-rpgkit/src/engine/extensions.ts";
import type { Session, SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import type { SaveSnapshot } from "../vendor/pocket-rpgkit/src/engine/save.ts";

/** Build the live SessionState a loaded snapshot describes, or throw a
 *  human-readable reason before any live state is replaced. */
export function restoreSession(sess: Session, project: Project, snap: SaveSnapshot): SessionState {
  const map = project.maps.find((m) => m.id === snap.map);
  if (!map) throw new Error(`save is for unknown map ${snap.map}`);
  const table = sess.tables.get(map.id);
  if (!table) throw new Error(`save: no passage table for map ${snap.map}`);
  const problem = restoreProblem(snap, map, table);
  if (problem !== null) throw new Error(problem);
  return {
    frame: snap.interp.frame,
    mapId: map.id,
    sw: snap.interp.sw,
    move: { ...snap.player },
    chars: createChars(),
    interp: snap.interp,
    fade: null,
    playerRoute: null,
    // The kit added ext (game-owned JSON) and scene (battle/shop slot) to
    // SessionState after this helper was written; stepSession folds both
    // every frame, so a load must populate them exactly like the kit's own
    // restoreSessionSnapshot does.
    ext: decodeExtension(sess.extensions, snap.ext),
    scene: null,
  };
}
