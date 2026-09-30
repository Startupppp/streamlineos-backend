import { inArray, sql, type SQL } from "drizzle-orm";
import { chatMessages } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";

/**
 * The one content predicate every chat message search is allowed to use.
 *
 * A bare `content ILIKE '%term%'` cannot use `idx_chat_messages_content_trgm` and cannot
 * be bounded: it is a full scan of the tenant's message table that any member can drive
 * on repeat. `ChatSearchService` had the hardened form — route the term through
 * `app.search_chat_message_ids`, which is the `SECURITY DEFINER` helper the search rules
 * require (org comes from `app.current_org_id()`, ids only, `LIMIT` argument), and cap the
 * id set — while `ChatPresenceService.searchMessages`, serving `GET /chat/search`, kept the
 * raw ILIKE. Two searches of the same column with two different cost ceilings is one
 * search too many, so the predicate lives here and both call sites read it.
 *
 * The trigram floor is pg_trgm's, not ours: a term shorter than three characters produces
 * no trigram and the index cannot serve it at any cost, so the ILIKE fallback is the only
 * answer available for those. That floor applies equally to BOTH routes and always has.
 */
export const CHAT_SEARCH_ID_CAP = 1000;

/** `%`, `_` and `\` in a user's term are literals, not ILIKE wildcards (default ESCAPE is `\`). */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, "\\$&");
}

export const TRIGRAM_MIN_TERM_LENGTH = 3;

/**
 * Ask the helper for `cap + 1` ids so "at the cap" is distinguishable from "exactly the
 * cap", and fall back to ILIKE above it — an unbounded SRF is materialised in full, which
 * is the cost this cap exists to avoid.
 */
export async function chatMessageContentMatch(db: Db, term: string): Promise<SQL<unknown>> {
  // The helper interpolates its argument into `ILIKE '%' || p_q || '%'`, so it gets the
  // escaped term too.
  const pattern = escapeLike(term);
  const like = sql`${chatMessages.content} ILIKE ${"%" + pattern + "%"}`;
  if (term.length < TRIGRAM_MIN_TERM_LENGTH) return like;
  const idRows = await db.execute(
    sql`SELECT app.search_chat_message_ids(${pattern}, ${CHAT_SEARCH_ID_CAP + 1}) AS id`,
  );
  if (idRows.length > CHAT_SEARCH_ID_CAP) return like;
  const ids = idRows.map((row) => Number(row["id"]));
  if (ids.length === 0) return sql`false`;
  return inArray(chatMessages.id, ids);
}
