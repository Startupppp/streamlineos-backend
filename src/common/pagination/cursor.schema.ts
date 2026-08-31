import { z } from "zod";

/**
 * A keyset cursor on a monotonic integer id, which degrades to the first page.
 *
 * `cursor.ts` already decided this for opaque cursors — "a stale or hand-edited
 * cursor is a client problem, and the useful response is the first page, not a
 * 500". The rule holds for a numeric cursor for the same reason: the cursor
 * encodes position and nothing else, carrying no tenant, no permission and no
 * filter state, so a corrupted one cannot express anything the server would not
 * otherwise serve. The worst it can produce is the newest page.
 *
 * `z.coerce.number().int().positive().optional()` answered the same input with a
 * 400. That turned a client-side mistake — a bookmarked deep link, a cursor
 * persisted across a deploy — into a hard failure, and left the two cursor
 * implementations in this repo disagreeing about identical malformed input,
 * which is the per-endpoint pagination decision c13 exists to end.
 */
export const idCursorSchema = z.preprocess((value) => {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (value === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}, z.number().int().positive().optional());
