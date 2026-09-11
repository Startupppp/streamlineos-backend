import { BadRequestException } from "@nestjs/common";
import { logSideEffectFailure } from "../../../common/logger/side-effect";
import { and, desc, eq } from "drizzle-orm";
import {
  clientAccounts,
  clientAccountActivities,
  incentives,
  incentiveConfig,
  notifications,
} from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import { ClientsEmailService } from "../clients-email.service";
import type { UpdateClientStatusInput } from "../dto/clients.schemas";

/**
 * The status change that pays somebody.
 *
 * Nominally one field on one row, and in practice the only write in
 * `ClientAccountsService` that fans out past the account: moving a client to
 * INVESTED books an incentive against the sales rep at the org's current rate,
 * notifies that rep and everyone holding `hr:employees:manage`, writes an audit
 * entry and fires two emails. `updateRenewal` and `addActivity` next door change
 * a row and stop.
 *
 * That fan-out is the seam, and it is also why the shape here is deliberate:
 *
 *   - the HR recipients are resolved BEFORE the transaction opens, because
 *     `membersWithPermission` is a separate read and the transaction should not
 *     be held open across it;
 *   - the incentive, the activity row and both notification inserts are INSIDE
 *     one transaction, so a rep is never told about money that was not booked;
 *   - the audit entry and the emails are outside it, the emails `void`-ed with
 *     `logSideEffectFailure`, because a bounced mail must not roll back an
 *     investment that really happened.
 *
 * A missing incentive config is not an error: the transition still lands and the
 * rep is still told. An org that has not configured a rate has not decided the
 * amount, which is different from deciding it is zero.
 */

export interface ClientInvestmentDeps {
  readonly db: Db;
  readonly audit: AuditService;
  readonly clientsEmail: ClientsEmailService;
  readonly access: AccessService;
}

export async function updateClientStatus(
  deps: ClientInvestmentDeps,
  orgId: string,
  userId: string,
  accountId: number,
  input: UpdateClientStatusInput,
) {
  const account = await deps.db.query.clientAccounts.findFirst({
    where: and(eq(clientAccounts.id, accountId), eq(clientAccounts.orgId, orgId)),
  });
  if (!account) return null;

  const investmentAmount = input.investmentAmount;
  const isInvested = input.status === "INVESTED";
  if (isInvested && !investmentAmount) {
    throw new BadRequestException("Investment amount is required for INVESTED status");
  }

  const updateData: Partial<typeof clientAccounts.$inferInsert> = {
    status: input.status,
    updatedAt: new Date(),
  };
  if (isInvested && investmentAmount) {
    updateData.investmentAmount = investmentAmount;
    updateData.planName = input.planName ?? null;
    updateData.investmentDate = input.investmentDate ? new Date(input.investmentDate) : new Date();
    updateData.transactionRef = input.transactionRef ?? null;
    updateData.investedAt = new Date();
  }

  const recordInvestment = isInvested && !!investmentAmount;
  const formattedAmount = investmentAmount
    ? Number.parseFloat(investmentAmount).toLocaleString("en-IN")
    : "";

  const hrMemberRows = recordInvestment
    ? await deps.access.membersWithPermission(orgId, "hr:employees:manage")
    : [];

  const updated = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(clientAccounts)
      .set(updateData)
      .where(and(eq(clientAccounts.id, accountId), eq(clientAccounts.orgId, orgId)))
      .returning();

    await tx.insert(clientAccountActivities).values({
      clientAccountId: accountId,
      userId,
      activityType: "status_change",
      title: `Status changed to ${input.status}`,
      description: recordInvestment ? `Investment: ${investmentAmount}, Plan: ${input.planName || "N/A"}` : null,
    });

    if (recordInvestment && investmentAmount) {
      const [config] = await tx
        .select({ incentiveRate: incentiveConfig.incentiveRate })
        .from(incentiveConfig)
        .where(and(eq(incentiveConfig.orgId, orgId), eq(incentiveConfig.isActive, true)))
        .orderBy(desc(incentiveConfig.effectiveFrom))
        .limit(1);

      if (config) {
        const amount = Number.parseFloat(investmentAmount);
        const rate = Number.parseFloat(config.incentiveRate);
        const calculated = (amount * rate) / 100;
        await tx.insert(incentives).values({
          orgId,
          clientAccountId: accountId,
          salesRepId: account.salesRepId,
          investmentAmount,
          incentiveRate: config.incentiveRate,
          calculatedAmount: String(calculated),
          branchId: account.branchId,
        });
      }

      await tx.insert(notifications).values({
        orgId,
        userId: account.salesRepId,
        type: "SUCCESS",
        title: "Client Invested!",
        message: `${account.clientName} has invested ₹${formattedAmount}. Your incentive is being processed.`,
        link: `/crm/clients/${account.id}`,
      });

      if (hrMemberRows.length > 0) {
        const investmentMsg = `${account.clientName} has invested ₹${formattedAmount}. Sales rep: ${account.salesRepId ? "assigned" : "N/A"}.`;
        await tx.insert(notifications).values(
          hrMemberRows.map((hr) => ({
            orgId,
            userId: hr.userId,
            type: "SUCCESS" as const,
            title: "Client Invested!",
            message: investmentMsg,
            link: `/crm/clients/${account.id}`,
          })),
        );
      }
    }

    return row;
  });

  deps.audit.log({
    action: "client.status_changed",
    userId,
    orgId,
    targetId: String(accountId),
    targetType: "client",
    metadata: { status: input.status, investmentAmount: input.investmentAmount },
  });

  if (recordInvestment) {
    void deps.clientsEmail
      .sendInvestmentEmails(
        account.id,
        account.salesRepId,
        account.clientName,
        formattedAmount,
        hrMemberRows.map((m) => m.userId),
      )
      .catch(logSideEffectFailure("investment notification emails", { orgId, accountId }));
  }

  return updated;
}
