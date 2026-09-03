/**
 * Drain every member of a channel in keyset batches.
 *
 * Two huddle fan-outs walk `chat_channel_members` page by page ordered on `membership_id` — the
 * calendar attendee backfill and the huddle-start notification. The bookkeeping between pages is
 * the part that goes wrong: a cursor that fails to advance re-reads the same page forever. It lives
 * here once, and each caller supplies only its own query and its own work.
 */
export async function forEachChannelMemberBatch<Row extends { membershipId: number }>(
  batchSize: number,
  fetchBatch: (afterMembershipId: number | null) => Promise<Row[]>,
  handleBatch: (rows: Row[]) => Promise<void> | void,
): Promise<void> {
  let afterMembershipId: number | null = null;
  for (;;) {
    const batch = await fetchBatch(afterMembershipId);
    if (batch.length === 0) return;
    await handleBatch(batch);
    if (batch.length < batchSize) return;
    const last = batch.at(-1);
    if (last === undefined) return;
    afterMembershipId = last.membershipId;
  }
}
