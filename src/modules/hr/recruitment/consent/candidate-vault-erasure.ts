/**
 * Whether a candidate's résumé vault was actually cleared during an erase.
 *
 * Split out of `candidate-consent.ts` because it answers a different question.
 * That file decides whether a record MAY be erased, which is policy about
 * dates. This one describes what happened when something TRIED to erase it,
 * which is a report about an object store that can fail — and conflating "we
 * were allowed to delete this" with "it is gone" is the exact confusion that
 * lets a candidate be told their data was destroyed when it was not.
 *
 * Pure, and importing nothing, so the erase service and the retention sweep
 * can both depend on it without either depending on the other.
 */

/**
 * What happened to one stored object during an erase.
 *
 * Declared here in this module's own vocabulary rather than imported from the
 * retention cron, because this file is pure and must stay importable without
 * dragging a Nest service and its dependency graph behind it. The erase service
 * maps the storage layer's outcome onto these exhaustively.
 */
export type ObjectErasureOutcome = "DELETED" | "RETRY_PENDING" | "LOST";

/**
 * Whether the résumé vault was actually cleared.
 *
 * `NOT_CONFIRMED` is a first-class answer and is the entire reason this type
 * exists. The storage delete happens over the network against an object store
 * this process does not own: it can fail, and an S3-compatible delete of a key
 * that is absent answers success either way. Reporting a candidate as erased
 * while their résumé is still sitting in a bucket is a false statement to the
 * person who asked to be forgotten and a false record for a regulator, so the
 * only outcome permitted to say CLEARED is one where every object was observed
 * to be deleted.
 */
export type VaultErasureSummary =
  | { vault: "CLEARED"; objectsDeleted: number; reason: string }
  | {
      vault: "NOT_CONFIRMED";
      objectsDeleted: number;
      objectsPendingRetry: number;
      objectsLost: number;
      reason: string;
    };

/**
 * Collapses per-object outcomes into the one claim the caller is allowed to
 * make.
 *
 * Note the empty case is CLEARED: a candidate with no vault objects genuinely
 * has nothing left in storage. Note also that a single unconfirmed object is
 * enough to deny the whole claim — a summary of "mostly deleted" is the kind of
 * thing that gets read as "deleted".
 */
export function summariseVaultErasure(
  outcomes: readonly ObjectErasureOutcome[],
): VaultErasureSummary {
  const objectsDeleted = outcomes.filter((o) => o === "DELETED").length;
  const objectsPendingRetry = outcomes.filter((o) => o === "RETRY_PENDING").length;
  const objectsLost = outcomes.filter((o) => o === "LOST").length;

  if (objectsPendingRetry === 0 && objectsLost === 0) {
    return {
      vault: "CLEARED",
      objectsDeleted,
      reason:
        objectsDeleted === 0
          ? "This candidate had no documents in the résumé vault."
          : `All ${objectsDeleted} vault document(s) were deleted from storage.`,
    };
  }

  const parts: string[] = [];
  if (objectsPendingRetry > 0) {
    parts.push(
      `${objectsPendingRetry} could not be deleted from storage and are queued for retry by the storage sweep`,
    );
  }
  if (objectsLost > 0) {
    parts.push(
      `${objectsLost} could not be deleted and could not be queued for retry, so they must be removed by hand`,
    );
  }

  return {
    vault: "NOT_CONFIRMED",
    objectsDeleted,
    objectsPendingRetry,
    objectsLost,
    reason: `The candidate's records were removed, but the résumé vault is NOT confirmed clear: ${parts.join("; ")}. Do not report this candidate as fully erased until the storage sweep confirms the remaining object(s).`,
  };
}
