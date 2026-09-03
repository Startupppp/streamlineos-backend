/**
 * Drain every member of a channel in keyset batches.
 *
 * Two huddle fan-outs walk `chat_channel_members` page by page ordered on `membership_id` — the
 * calendar attendee backfill and the huddle-start notification. The bookkeeping between pages is
 * the part that goes wrong: a cursor that fails to advance re-reads the same page forever. It lives
 * here once, and each caller supplies only its own query and its own work.
 *
 * The handle is a PARAMETER, threaded into `fetchBatch`, rather than something each caller closes
 * over. Two reasons, and the second is not cosmetic. It makes the dependency visible in the
 * signature — this helper reads a database, and a `fetchBatch` that is a pure function of
 * `(handle, cursor)` cannot accidentally capture a transaction that has already committed (§4).
 * And it keeps `check:db-call-count` able to SEE the drain: the detector matches a helper that
 * receives the handle, and when these two `for(;;)` loops were inlined in `chat-huddles.service.ts`
 * it watched both. Extracting them behind a closure silently removed the file from the gate's
 * counts and left a stale FALSE-POSITIVE verdict pointing at a file the loop had left — the "the
 * detector lost sight of it" half of that check, on real code. The verdict now lives here, where
 * the loop does.
 */
export async function forEachChannelMemberBatch<Handle, Row extends { membershipId: number }>(
  db: Handle,
  batchSize: number,
  fetchBatch: (db: Handle, afterMembershipId: number | null) => Promise<Row[]>,
  handleBatch: (rows: Row[]) => Promise<void> | void,
): Promise<void> {
  let afterMembershipId: number | null = null;
  for (;;) {
    const batch = await fetchBatch(db, afterMembershipId);
    if (batch.length === 0) return;
    await handleBatch(batch);
    if (batch.length < batchSize) return;
    const last = batch.at(-1);
    if (last === undefined) return;
    afterMembershipId = last.membershipId;
  }
}
