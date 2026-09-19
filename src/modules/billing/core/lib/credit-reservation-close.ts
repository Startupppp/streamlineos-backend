import { ConflictException, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { type Db } from "../../../../db/drizzle.module";
import {
  aiCreditReservations,
  aiCreditTransactions,
  orgAiCredits,
} from "../../../../db/schema";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
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

      if (!wallet)
        throw new ConflictException(
          `AI credit wallet for organisation ${reservation.orgId} is missing; ` +
            `refusing to settle reservation ${reservationId} against a balance that does not exist`,
        );

      const newBalance = Math.max(0, wallet.balance + delta);

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

      if (!wallet)
        throw new ConflictException(
          `AI credit wallet for organisation ${reservation.orgId} is missing; ` +
            `refusing to refund reservation ${reservationId} into a balance that does not exist`,
        );

      const newBalance = wallet.balance + reservation.credits;

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

/** Bounded so no single claim statement locks an unbounded row set. */
const SWEEP_PAGE_SIZE = 500;

/**
 * Drains every expired reservation for each organisation inside the one tenant
 * transaction `forEachOrg` already opened.
 *
 * It used to open `runInNewTenantTransaction` per row — up to 500 fresh
 * transactions per organisation, each borrowing a second pooled connection
 * while the sweep's own transaction sat idle holding the first. The claim is
 * now a single compare-and-set `UPDATE … WHERE status = 'RESERVED' RETURNING`,
 * which cannot double-release a row a concurrent settle already took, and the
 * wallet is credited with atomic SQL rather than a read-modify-write.
 *
 * The page is bounded so no single statement locks an unbounded row set; the
 * loop keeps going until the organisation is drained, so nothing is silently
 * left behind the way a bare `.limit(500)` left it.
 */
export async function sweepExpiredReservations(deps: ReservationCloseDeps): Promise<number> {
  const now = new Date();
  let swept = 0;
  await forEachOrg(deps.db, "sweep:expired-ai-reservations", async (tx, orgId) => {
    for (;;) {
      const due = await tx
        .select({ id: aiCreditReservations.id })
        .from(aiCreditReservations)
        .where(
          and(
            eq(aiCreditReservations.orgId, orgId),
            eq(aiCreditReservations.status, "RESERVED"),
            lte(aiCreditReservations.expiresAt, now),
          ),
        )
        .limit(SWEEP_PAGE_SIZE);
      if (due.length === 0) return;

      const claimed = await tx
        .update(aiCreditReservations)
        .set({
          status: "RELEASED",
          metadata: { reason: "expired" },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiCreditReservations.orgId, orgId),
            eq(aiCreditReservations.status, "RESERVED"),
            inArray(
              aiCreditReservations.id,
              due.map((row) => row.id),
            ),
          ),
        )
        .returning({ credits: aiCreditReservations.credits });

      const refunded = claimed.reduce((sum, row) => sum + row.credits, 0);
      if (refunded > 0)
        await tx
          .update(orgAiCredits)
          .set({
            balance: sql`${orgAiCredits.balance} + ${refunded}`,
            updatedAt: new Date(),
          })
          .where(eq(orgAiCredits.orgId, orgId));

      swept += claimed.length;
      if (due.length < SWEEP_PAGE_SIZE) return;
    }
  });
  return swept;
}
