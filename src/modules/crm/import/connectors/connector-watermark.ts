import { advanceWatermark } from "../../../ingress/adapters/mailbox-sync";

/**
 * How far a connector may claim to have read, after a walk.
 *
 * Pure, and separate from the service, for the reason `mailbox-sync` is separate
 * from `crm-mailbox.service`: this is the rule the whole ticket turns on, and a
 * rule buried in an `UPDATE` is a rule nobody can argue with.
 *
 * `advanceWatermark` is imported rather than rewritten. It already encodes the
 * half both channels share — never past the newest thing actually seen, never
 * backwards — and it is the function whose absence cost six days of mail. A
 * second copy here would be a second place for that lesson to be forgotten, and
 * the two would drift the first time somebody fixed one of them.
 *
 * ── The half that is only true here ────────────────────────────────────────
 *
 * A connector adds one condition, and it is stricter than the mail rule rather
 * than a variation on it: **a walk that did not reach the end of the collection
 * advances nothing at all.**
 *
 * Mail can do better than that because mail has an order. Both providers return
 * newest first, so a partial sweep has genuinely seen everything down to some
 * instant, and "everything at or before X" is a true statement about what it
 * read. A CRM list endpoint offers no such guarantee — two of the four providers
 * document none at all — so a walk that stopped at page ten has read ten pages
 * of an arbitrary permutation. The newest record in those ten pages says nothing
 * whatsoever about the records in pages eleven onwards, and many of them will be
 * older. Advancing to it would put every one of those below the floor, and they
 * would never be read again.
 *
 * That is precisely the mailbox bug — a watermark moved past what was actually
 * read — arriving through a door the mailbox rule does not cover. Hence the
 * gate, and hence it being the first thing this function does.
 *
 * The cost of being wrong in this direction is a re-read: records arrive at
 * `planImport`, match the parties they created last time, and become updates.
 * The cost of being wrong in the other direction is a customer nobody ever
 * imported.
 */
export function watermarkAfterWalk(
  current: Date | null,
  newestStaged: Date | null,
  drained: boolean,
): Date | null {
  if (!drained) return current;
  return advanceWatermark(current, newestStaged);
}
