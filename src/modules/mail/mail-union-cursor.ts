import { isPartialGmailCursor, type AccountCursorValue, type OpaqueCursor } from "./providers/mail-normalizers";

/**
 * How a union scroll's per-mailbox positions advance.
 *
 * One inbox page merges several mailboxes by date and then keeps only `limit`
 * rows, so each mailbox has consumed a DIFFERENT amount of what it fetched, and
 * each provider expresses "where I got to" differently — Gmail a page token
 * (plus a within-page skip when the merge cut mid-page), Outlook a numeric skip.
 * Getting this wrong does not fail loudly: it silently re-delivers or skips
 * whole stretches of somebody's mail.
 *
 * It is pure, and separate from `MailService`, because it is the one part of the
 * listing path with no provider call and no database in it — the arithmetic can
 * be stated and checked on its own.
 */

export interface AccountFetchOutcome {
  accId: number;
  provider: string;
  messages: ReadonlyArray<{ accountId: number; id: string }>;
  nextPageToken: string | undefined;
  outlookHasMore: boolean;
  currentCursorValue: AccountCursorValue;
}

export function advanceUnionCursor(
  accountFetches: readonly AccountFetchOutcome[],
  mergedIds: ReadonlySet<string>,
  carriedCursors: readonly { accId: number; value: AccountCursorValue }[],
): OpaqueCursor {
  const nextCursorMap: OpaqueCursor = {};
  for (const fetch of accountFetches) {
    // Exhausted stays exhausted. Writing `undefined` here would be dropped by
    // JSON on the way out and read back as "no position yet".
    if (fetch.currentCursorValue === null) {
      nextCursorMap[fetch.accId] = null;
      continue;
    }
    const consumed = fetch.messages.filter((m) => mergedIds.has(`${m.accountId}:${m.id}`)).length;
    if (fetch.provider === "outlook") {
      if (!fetch.outlookHasMore && consumed === fetch.messages.length) {
        nextCursorMap[fetch.accId] = null;
      } else {
        const prevSkip = typeof fetch.currentCursorValue === "number" ? fetch.currentCursorValue : 0;
        nextCursorMap[fetch.accId] = prevSkip + consumed;
      }
    } else if (consumed === fetch.messages.length) {
      nextCursorMap[fetch.accId] = fetch.nextPageToken ?? null;
    } else {
      const prevToken = isPartialGmailCursor(fetch.currentCursorValue)
        ? fetch.currentCursorValue.token
        : typeof fetch.currentCursorValue === "string"
          ? fetch.currentCursorValue
          : "";
      const prevSkip = isPartialGmailCursor(fetch.currentCursorValue) ? fetch.currentCursorValue.skip : 0;
      nextCursorMap[fetch.accId] = consumed > 0
        ? { token: prevToken, skip: prevSkip + consumed }
        : fetch.currentCursorValue;
    }
  }

  // Applied after the fetch loop rather than inside it: an account is either
  // fulfilled or rejected, never both, so these keys never collide with one the
  // loop wrote. A carried non-null position also keeps `hasMore` true, so a
  // scroll whose only remaining mailbox errored can still be resumed instead of
  // ending on a failure the reader never chose.
  for (const carried of carriedCursors) nextCursorMap[carried.accId] = carried.value;

  return nextCursorMap;
}
