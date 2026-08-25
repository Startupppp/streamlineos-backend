import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, lte, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { externalEffectLedger } from "../../db/schema/common/outbox";
import { runInNewTenantTransaction } from "../tenant/run-in-tenant-transaction";

const EFFECT_LEASE_MS = 60_000;

export type ProviderIdempotencyGuarantee =
  | "NONE"
  | "STABLE_KEY_PROPAGATED"
  | "PROVIDER_ENFORCED";

export interface ExternalEffect {
  organizationId: string;
  producerEventId: string;
  effectKey: string;
  effectType: string;
  providerIdempotency: ProviderIdempotencyGuarantee;
}

export type ExternalEffectResult = "EXECUTED" | "ALREADY_SUCCEEDED";

export class ExternalEffectLeaseBusyError extends Error {
  constructor(effectKey: string) {
    super(`external effect '${effectKey}' is already leased`);
  }
}

/**
 * Executes one externally visible effect behind a durable, token-fenced lease.
 *
 * This is an at-least-once contract. The ledger prevents repeats after SUCCEEDED is durable and
 * prevents a stale attempt from finalizing a newer lease. It cannot atomically commit a remote
 * provider call with Postgres. If a process dies after the provider accepts the effect but before
 * SUCCEEDED is recorded, the expired lease is retried and `uncertainRetryCount` records that
 * ambiguity. Exactly-once exists only when `providerIdempotency` is PROVIDER_ENFORCED.
 */
@Injectable()
export class ExternalEffectLedger {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async execute(effect: ExternalEffect, send: () => Promise<void>): Promise<ExternalEffectResult> {
    const token = randomUUID();
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + EFFECT_LEASE_MS);

    const claim = await runInNewTenantTransaction(this.db, effect.organizationId, async (tx) => {
      await tx.insert(externalEffectLedger).values({
        organizationId: effect.organizationId,
        producerEventId: effect.producerEventId,
        effectKey: effect.effectKey,
        effectType: effect.effectType,
        providerIdempotency: effect.providerIdempotency,
      }).onConflictDoNothing({
        target: [externalEffectLedger.organizationId, externalEffectLedger.effectKey],
      });

      const claimed = await tx.update(externalEffectLedger).set({
        state: "IN_FLIGHT",
        attemptToken: token,
        leaseExpiresAt,
        attemptCount: sql`${externalEffectLedger.attemptCount} + 1`,
        uncertainRetryCount: sql`${externalEffectLedger.uncertainRetryCount} + case when ${externalEffectLedger.state} = 'IN_FLIGHT' then 1 else 0 end`,
        lastError: null,
        updatedAt: now,
      }).where(and(
        eq(externalEffectLedger.organizationId, effect.organizationId),
        eq(externalEffectLedger.effectKey, effect.effectKey),
        or(
          eq(externalEffectLedger.state, "PENDING"),
          eq(externalEffectLedger.state, "FAILED"),
          and(
            eq(externalEffectLedger.state, "IN_FLIGHT"),
            lte(externalEffectLedger.leaseExpiresAt, now),
          ),
        ),
      )).returning({ id: externalEffectLedger.externalEffectId });

      if (claimed.length > 0) return "CLAIMED" as const;
      const existing = await tx.select({ state: externalEffectLedger.state })
        .from(externalEffectLedger)
        .where(and(
          eq(externalEffectLedger.organizationId, effect.organizationId),
          eq(externalEffectLedger.effectKey, effect.effectKey),
        )).limit(1);
      return existing[0]?.state === "SUCCEEDED" ? "SUCCEEDED" as const : "BUSY" as const;
    });

    if (claim === "SUCCEEDED") return "ALREADY_SUCCEEDED";
    if (claim === "BUSY") throw new ExternalEffectLeaseBusyError(effect.effectKey);

    try {
      await send();
    } catch (error: unknown) {
      await this.finish(effect, token, "FAILED", error instanceof Error ? error.message : String(error));
      throw error;
    }

    const finalized = await this.finish(effect, token, "SUCCEEDED", null);
    if (!finalized) {
      throw new Error(`external effect '${effect.effectKey}' lost its lease before completion was recorded`);
    }
    return "EXECUTED";
  }

  private async finish(
    effect: ExternalEffect,
    token: string,
    state: "SUCCEEDED" | "FAILED",
    lastError: string | null,
  ): Promise<boolean> {
    return runInNewTenantTransaction(this.db, effect.organizationId, async (tx) => {
      const rows = await tx.update(externalEffectLedger).set({
        state,
        lastError,
        completedAt: state === "SUCCEEDED" ? new Date() : null,
        leaseExpiresAt: null,
        attemptToken: null,
        updatedAt: new Date(),
      }).where(and(
        eq(externalEffectLedger.organizationId, effect.organizationId),
        eq(externalEffectLedger.effectKey, effect.effectKey),
        eq(externalEffectLedger.state, "IN_FLIGHT"),
        eq(externalEffectLedger.attemptToken, token),
      )).returning({ id: externalEffectLedger.externalEffectId });
      return rows.length > 0;
    });
  }
}
