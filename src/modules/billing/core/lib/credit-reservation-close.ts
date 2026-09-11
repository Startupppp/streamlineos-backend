import { ConflictException, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, lte, sql } from "drizzle-orm";
import { type Db } from "../../../../db/drizzle.module";
import {
  aiCreditReservations,
  aiCreditTransactions,
  orgAiCredits,
} from "../../../../db/schema";
import {
  runInTenantTransaction,
  runInNewTenantTransaction,
} from "../../../../common/tenant/run-in-tenant-transaction";
import { forEachOrg } from "../../../../common/tenant";
import type { AiCreditSettleInput } from "../../../ai/core/gateway/credit-ledger.interface";

/**
 * Closing out a credit reservation: settle it at the real cost, release it, or
 * sweep the ones nobody came back for.
 *
 * Split from `reserve` because the two halves fail in opposite directions. A
 * reservation that is never taken is a HOLD on credits the org can still spend
 * — which is why the sweep exists and runs `forEachOrg` outside any request —
 * whereas a settle that runs twice would charge twice, so it is the half that
 * has to be idempotent against its own effect.
 */
export interface ReservationCloseDeps {
  readonly db: Db;
  readonly logger: Logger;
}

export async function settle(
  deps: ReservationCloseDeps,
  reservationId: number,
  input: AiCreditSettleInput,
): Promise<void> {
  const orgId = input.orgId;

  await runInTenantTransaction(
    deps.db,
    async (tx) => {
      const [reservation] = await tx
        .select()
        .from(aiCreditReservations)
        .where(
          and(
            eq(aiCreditReservations.id, reservationId),
            eq(aiCreditReservations.orgId, orgId),
          ),
        )
        .for("update");

      if (!reservation) throw new NotFoundException("Reservation not found");
      if (reservation.status === "SETTLED") return;
      if (reservation.status !== "RESERVED")
        throw new ConflictException(
          `Cannot settle a reservation in status ${reservation.status}`,
        );

      const actualMilli = Math.max(
        0,
        input.actualMilli ?? reservation.credits,
      );
      const reservedMilli = reservation.credits;
      const delta = reservedMilli - actualMilli;

      const [wallet] = await tx
        .select()
        .from(orgAiCredits)
        .where(eq(orgAiCredits.orgId, reservation.orgId))
        .for("update");

      const currentBalance = wallet?.balance ?? 0;
      const newBalance = currentBalance + delta;

      await tx
        .update(orgAiCredits)
        .set({
          balance: newBalance,
          lifetimeConsumed: sql`${orgAiCredits.lifetimeConsumed} + ${actualMilli}`,
          updatedAt: new Date(),
        })
        .where(eq(orgAiCredits.orgId, reservation.orgId));

      if (actualMilli > 0) {
        const costUsdStr =
          input.costUsd !== undefined
            ? String(input.costUsd.toFixed(6))
            : null;
        await tx.insert(aiCreditTransactions).values({
          orgId: reservation.orgId,
          userId: reservation.userId,
          type: "USAGE",
          amount: -actualMilli,
          balanceAfter: newBalance,
          feature: reservation.feature,
          model: input.model ?? null,
          metadata: input.metadata ?? null,
          promptTokens: input.promptTokens ?? null,
          completionTokens: input.completionTokens ?? null,
          totalTokens: input.totalTokens ?? null,
          costUsd: costUsdStr,
        });
      }

      await tx
        .update(aiCreditReservations)
        .set({
          status: "SETTLED",
          model: input.model ?? null,
          metadata: input.metadata ?? null,
          updatedAt: new Date(),
        })
        .where(eq(aiCreditReservations.id, reservationId));
    },
    { orgId },
  );
}

export async function release(
  deps: ReservationCloseDeps,
  reservationId: number,
  reason: string,
  orgId: string,
): Promise<void> {
  await runInTenantTransaction(
    deps.db,
    async (tx) => {
      const [reservation] = await tx
        .select()
        .from(aiCreditReservations)
        .where(
          and(
            eq(aiCreditReservations.id, reservationId),
            eq(aiCreditReservations.orgId, orgId),
          ),
        )
        .for("update");

      if (!reservation) throw new NotFoundException("Reservation not found");
      if (reservation.status === "RELEASED") return;
      if (reservation.status === "SETTLED")
        throw new ConflictException(
          "Cannot release an already settled reservation",
        );

      const [wallet] = await tx
        .select()
        .from(orgAiCredits)
        .where(eq(orgAiCredits.orgId, reservation.orgId))
        .for("update");

      const currentBalance = wallet?.balance ?? 0;
      const newBalance = currentBalance + reservation.credits;

      await tx
        .update(orgAiCredits)
        .set({ balance: newBalance, updatedAt: new Date() })
        .where(eq(orgAiCredits.orgId, reservation.orgId));

      await tx
        .update(aiCreditReservations)
        .set({
          status: "RELEASED",
          metadata: { reason },
          updatedAt: new Date(),
        })
        .where(eq(aiCreditReservations.id, reservationId));
    },
    { orgId },
  );
}

export async function sweepExpiredReservations(deps: ReservationCloseDeps): Promise<number> {
  const now = new Date();
  let swept = 0;
  await forEachOrg(deps.db, "sweep:expired-ai-reservations", async (tx, orgId) => {
    const expired = await tx
      .select({ id: aiCreditReservations.id })
      .from(aiCreditReservations)
      .where(
        and(
          eq(aiCreditReservations.orgId, orgId),
          eq(aiCreditReservations.status, "RESERVED"),
          lte(aiCreditReservations.expiresAt, now),
        ),
      )
      .limit(500);
    for (const row of expired) {
      try {
        await runInNewTenantTransaction(deps.db, orgId, () =>
          release(deps, row.id, "expired", orgId),
        );
        swept++;
      } catch (err) {
        deps.logger.warn(
          `Failed to sweep expired reservation ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  });
  return swept;
}
