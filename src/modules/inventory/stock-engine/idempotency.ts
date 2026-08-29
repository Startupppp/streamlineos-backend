import { BadRequestException, ConflictException, UnprocessableEntityException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { invIdempotencyKeys } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { INV_ERRORS, type StockEngineResult } from "./stock-engine.types";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type IdempotencyClaim =
  | { kind: "proceed" }
  | { kind: "replay"; stored: unknown };

const KEY_TTL_MS = 86_400_000;
const LEASE_TTL_MS = 15 * 60 * 1000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Rebuilds a stored engine result from the idempotency row's JSON response. */
export function extractEngineResult(stored: unknown): StockEngineResult {
  const transactionIds: number[] = [];
  const levels: StockEngineResult["levels"] = [];

  if (isPlainObject(stored)) {
    if (Array.isArray(stored.transactionIds)) {
      for (const id of stored.transactionIds)
        if (typeof id === "number") transactionIds.push(id);
    }
    if (Array.isArray(stored.levels)) {
      for (const l of stored.levels) {
        if (isPlainObject(l)) {
          levels.push({
            productVariantId: Number(l.productVariantId),
            locationId: Number(l.locationId),
            onHand: String(l.onHand ?? "0"),
          });
        }
      }
    }
  }

  return { transactionIds, levels };
}

/**
 * Claims an idempotency key, or reports that a prior request already owns it.
 *
 * Claimed with ON CONFLICT rather than try/catch: Postgres aborts the whole
 * transaction on a statement error and Drizzle takes no per-statement savepoint,
 * so a caught duplicate-key insert poisons every later statement and the replay
 * branch below is never reached. Proven by `stock-engine.db.spec.ts`.
 */
export async function claimIdempotencyKey(
  tx: Tx,
  orgId: string,
  key: string,
  requestHash: string,
): Promise<IdempotencyClaim> {
  const now = Date.now();
  const expiresAt = new Date(now + KEY_TTL_MS);
  const leaseExpiresAt = new Date(now + LEASE_TTL_MS);

  const claimed = await tx
    .insert(invIdempotencyKeys)
    .values({
      orgId,
      idempotencyKey: key,
      requestHash,
      status: "IN_FLIGHT",
      expiresAt,
      leaseExpiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: invIdempotencyKeys.id });

  if (claimed.length > 0) return { kind: "proceed" };

  const existing = await tx.query.invIdempotencyKeys.findFirst({
    where: and(
      eq(invIdempotencyKeys.orgId, orgId),
      eq(invIdempotencyKeys.idempotencyKey, key),
    ),
  });
  if (!existing)
    throw new ConflictException({ code: INV_ERRORS.DUPLICATE_IDEMPOTENCY_KEY });

  if (existing.requestHash !== null && existing.requestHash !== requestHash) {
    throw new UnprocessableEntityException(
      "This idempotency key was already used with a different request",
    );
  }

  if (existing.status === "COMPLETED")
    return { kind: "replay", stored: existing.response };

  if (
    existing.status === "IN_FLIGHT" &&
    existing.leaseExpiresAt !== null &&
    existing.leaseExpiresAt > new Date()
  ) {
    throw new ConflictException({ code: INV_ERRORS.DUPLICATE_IDEMPOTENCY_KEY });
  }

  const leaseLock =
    existing.leaseExpiresAt !== null
      ? eq(invIdempotencyKeys.leaseExpiresAt, existing.leaseExpiresAt)
      : isNull(invIdempotencyKeys.leaseExpiresAt);

  const reclaimed = await tx
    .update(invIdempotencyKeys)
    .set({ status: "IN_FLIGHT", requestHash, expiresAt, leaseExpiresAt })
    .where(
      and(
        eq(invIdempotencyKeys.orgId, orgId),
        eq(invIdempotencyKeys.idempotencyKey, key),
        leaseLock,
      ),
    )
    .returning({ id: invIdempotencyKeys.id });
  if (reclaimed.length === 0)
    throw new ConflictException({ code: INV_ERRORS.DUPLICATE_IDEMPOTENCY_KEY });

  return { kind: "proceed" };
}

/**
 * A3. Run a command once per idempotency key, and replay its result thereafter.
 *
 * `claimIdempotencyKey` gives the claim; every caller that used it then repeated
 * the same three steps — claim, run, mark COMPLETED with a response — and the
 * commands that skipped the last step replayed nothing, so a retry either
 * 409'd until the lease expired or, where no claim was taken at all, simply ran
 * a second time. A reserve run twice is two ACTIVE reservations against the same
 * stock.
 *
 * `revive` rather than a cast: the stored response is JSON that has been through
 * the database, so `Date`s are strings and a blind cast to `T` is a lie the type
 * system cannot catch. The engine's `extractEngineResult` is the same idea.
 */
export async function runIdempotent<T>(
  tx: Tx,
  orgId: string,
  key: string,
  request: unknown,
  work: () => Promise<T>,
  revive: (stored: unknown) => T | Promise<T>,
): Promise<T> {
  // An absent key used to reach the INSERT as a column default and fail on the
  // NOT NULL, naming `inv_idempotency_keys` rather than the caller that forgot
  // to pass one. A command guarded by a key that is not there is not guarded.
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new BadRequestException(
      "An Idempotency-Key is required for this operation",
    );
  }

  const requestHash = createHash("sha256")
    .update(JSON.stringify(request))
    .digest("hex");

  const claim = await claimIdempotencyKey(tx, orgId, key, requestHash);
  if (claim.kind === "replay") return await revive(claim.stored);

  const result = await work();

  await tx
    .update(invIdempotencyKeys)
    .set({ status: "COMPLETED", response: toStoredResponse(result) })
    .where(
      and(
        eq(invIdempotencyKeys.orgId, orgId),
        eq(invIdempotencyKeys.idempotencyKey, key),
      ),
    );

  return result;
}

/**
 * The column is `jsonb`, which cannot hold a bare scalar under this schema's
 * typing, so a non-object result is wrapped. `revive` unwraps it.
 */
function toStoredResponse(result: unknown): Record<string, unknown> {
  if (isPlainObject(result)) return result;
  return { value: result ?? null };
}

/** The counterpart to `toStoredResponse` for a scalar-valued command. */
export function revivedScalar(stored: unknown): unknown {
  return isPlainObject(stored) && "value" in stored ? stored.value : stored;
}

/**
 * The common case: a command whose result is the id of the row it created.
 *
 * Three services had grown their own copy of this, which is how a formula
 * starts drifting.
 */
export function revivedId(stored: unknown): number {
  return Number(revivedScalar(stored));
}
