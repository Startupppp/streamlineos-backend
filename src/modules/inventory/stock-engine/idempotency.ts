import { ConflictException, UnprocessableEntityException } from "@nestjs/common";
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
