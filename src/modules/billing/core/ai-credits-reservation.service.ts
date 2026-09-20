import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import { milliToCredits } from "../../ai/core/billing/ai-model-pricing.constants";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";
import {
  aiCreditReservations,
  aiCreditTransactions,
  orgAiCredits,
} from "../../../db/schema";
import { TRIAL_GRANT_MILLI } from "./ai-credit-units";
import {
  release,
  settle,
  sweepExpiredReservations,
  type ReservationCloseDeps,
} from "./lib/credit-reservation-close";
import { runInNewTenantTransaction, runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import type {
  AiCreditReserveInput,
  AiCreditSettleInput,
} from "../../ai/core/gateway/credit-ledger.interface";

@Injectable()
export class AiCreditsReservationService {
  private readonly logger = new Logger(AiCreditsReservationService.name);
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async reserve(
    input: AiCreditReserveInput,
  ): Promise<{ reservationId: number }> {
    const { orgId, userId, feature, credits, idempotencyKey } = input;

    if (idempotencyKey) {
      const existing = await this.findByIdempotencyKey(orgId, idempotencyKey);
      if (existing !== null && existing.status === "RESERVED")
        return { reservationId: existing.id };
      if (existing !== null)
        throw new ConflictException(
          `AI reservation ${existing.id} for this idempotency key is already ${existing.status.toLowerCase()}.`,
        );
    }

    try {
      return await runInTenantTransaction(
        this.db,
        (outer) =>
          outer.transaction(async (tx) => {
            const wallet = await this.ensureWallet(tx, orgId);

            if (wallet.balance < credits)
              throw new InsufficientAiCreditsException({
                details: {
                  feature,
                  requiredCredits: milliToCredits(credits),
                  availableCredits: milliToCredits(wallet.balance),
                },
              });

            const newBalance = wallet.balance - credits;
            await tx
              .update(orgAiCredits)
              .set({ balance: newBalance, updatedAt: new Date() })
              .where(eq(orgAiCredits.orgId, orgId));

            const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
            const [reservation] = await tx
              .insert(aiCreditReservations)
              .values({
                orgId,
                userId,
                feature,
                credits,
                status: "RESERVED",
                idempotencyKey: idempotencyKey ?? null,
                expiresAt,
              })
              .returning({ id: aiCreditReservations.id });

            return { reservationId: reservation.id };
          }),
        { orgId },
      );
    } catch (err: unknown) {
      // A concurrent reserve with the same key won `uq_ai_credit_res_org_idem_key`.
      // Shared helper: Drizzle leaves the SQLSTATE on `.cause`, which the
      // private `Reflect.get(err, "code")` this replaced never read. The failed
      // writes ran inside `outer.transaction` — a savepoint — so the handle the
      // lookup below reuses is still live.
      if (isUniqueViolation(err) && idempotencyKey) {
        const existing = await this.findByIdempotencyKey(
          orgId,
          idempotencyKey,
        );
        if (existing !== null) return { reservationId: existing.id };
      }
      throw err;
    }
  }

  /** @see lib/credit-reservation-close.ts */
  async settle(reservationId: number, input: AiCreditSettleInput): Promise<void> {
    return settle(this.closeDeps, reservationId, input);
  }

  /** @see lib/credit-reservation-close.ts */
  async release(reservationId: number, reason: string, orgId: string): Promise<void> {
    return release(this.closeDeps, reservationId, reason, orgId);
  }

  /** @see lib/credit-reservation-close.ts */
  async sweepExpiredReservations(): Promise<number> {
    return sweepExpiredReservations(this.closeDeps);
  }

  private get closeDeps(): ReservationCloseDeps {
    return { db: this.db, logger: this.logger };
  }

  /**
   * `SELECT … FOR UPDATE` locks nothing when the row is not there yet, so the
   * first two AI calls an organisation ever made both found no wallet, both
   * INSERTed, and the loser took a raw 23505 out of the request as a 500. The
   * unique index on `org_id` is the only thing that can serialise a row that
   * does not exist: `onConflictDoNothing().returning()` yields the row to the
   * transaction that actually created it and an empty array to every other one,
   * which is what keeps the trial grant to exactly one row — a loser that also
   * wrote a PLAN_GRANT would hand out the free credits twice. The loser then
   * re-reads under `FOR UPDATE`, which by then has a row to lock, and takes its
   * deduction behind the winner's.
   */
  async ensureWalletForOrg(orgId: string): Promise<typeof orgAiCredits.$inferSelect> {
    return runInNewTenantTransaction(this.db, orgId, (tx) => this.ensureWallet(tx, orgId));
  }

  private async ensureWallet(
    tx: TenantTx,
    orgId: string,
  ): Promise<typeof orgAiCredits.$inferSelect> {
    const [locked] = await tx
      .select()
      .from(orgAiCredits)
      .where(eq(orgAiCredits.orgId, orgId))
      .for("update");
    if (locked) return locked;

    const [created] = await tx
      .insert(orgAiCredits)
      .values({
        orgId,
        balance: TRIAL_GRANT_MILLI,
        lifetimeGranted: TRIAL_GRANT_MILLI,
      })
      .onConflictDoNothing({ target: orgAiCredits.orgId })
      .returning();

    if (created) {
      await tx.insert(aiCreditTransactions).values({
        orgId,
        userId: null,
        type: "PLAN_GRANT",
        amount: TRIAL_GRANT_MILLI,
        balanceAfter: TRIAL_GRANT_MILLI,
        feature: "trial-grant",
        referenceId: "trial-grant",
      });
      return created;
    }

    const [existing] = await tx
      .select()
      .from(orgAiCredits)
      .where(eq(orgAiCredits.orgId, orgId))
      .for("update");
    if (!existing)
      throw new ConflictException(
        `AI credit wallet for organisation ${orgId} was neither created nor readable`,
      );
    return existing;
  }

  private async findByIdempotencyKey(
    orgId: string,
    idempotencyKey: string,
  ): Promise<{ id: number; status: string } | null> {
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const [existing] = await tx
          .select({
            id: aiCreditReservations.id,
            status: aiCreditReservations.status,
          })
          .from(aiCreditReservations)
          .where(
            and(
              eq(aiCreditReservations.orgId, orgId),
              eq(aiCreditReservations.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1);
        return existing ?? null;
      },
      { orgId },
    );
  }

}
