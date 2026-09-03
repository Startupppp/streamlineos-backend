import { BadRequestException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  clientAccounts,
  incentiveConfig,
  incentives,
  notifications,
} from "../../db/schema";
import type { TenantTx } from "../../db/drizzle.types";
import type { UpdateClientStatusInput } from "./dto/clients.schemas";

const INVESTED = "INVESTED";
const AMOUNT_LOCALE = "en-IN";

type ClientAccountRow = typeof clientAccounts.$inferSelect;

export type InvestedAccount = Pick<ClientAccountRow, "id" | "clientName" | "salesRepId" | "branchId">;

export interface InvestmentEffects {
  readonly orgId: string;
  readonly account: InvestedAccount;
  readonly investmentAmount: string;
  readonly formattedAmount: string;
  readonly hrRecipientIds: readonly string[];
}

export function isInvestmentTransition(input: UpdateClientStatusInput): boolean {
  return input.status === INVESTED && !!input.investmentAmount;
}

export function formatInvestmentAmount(amount: string | undefined): string {
  return amount ? Number.parseFloat(amount).toLocaleString(AMOUNT_LOCALE) : "";
}

export function buildClientStatusUpdate(
  input: UpdateClientStatusInput,
): Partial<typeof clientAccounts.$inferInsert> {
  if (input.status === INVESTED && !input.investmentAmount) {
    throw new BadRequestException("Investment amount is required for INVESTED status");
  }

  const updateData: Partial<typeof clientAccounts.$inferInsert> = {
    status: input.status,
    updatedAt: new Date(),
  };
  if (isInvestmentTransition(input) && input.investmentAmount) {
    updateData.investmentAmount = input.investmentAmount;
    updateData.planName = input.planName ?? null;
    updateData.investmentDate = input.investmentDate ? new Date(input.investmentDate) : new Date();
    updateData.transactionRef = input.transactionRef ?? null;
    updateData.investedAt = new Date();
  }
  return updateData;
}

export async function recordInvestmentEffects(tx: TenantTx, effects: InvestmentEffects): Promise<void> {
  const { orgId, account, investmentAmount, formattedAmount, hrRecipientIds } = effects;

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
      clientAccountId: account.id,
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

  if (hrRecipientIds.length > 0) {
    const investmentMsg = `${account.clientName} has invested ₹${formattedAmount}. Sales rep: ${account.salesRepId ? "assigned" : "N/A"}.`;
    await tx.insert(notifications).values(
      hrRecipientIds.map((userId) => ({
        orgId,
        userId,
        type: "SUCCESS" as const,
        title: "Client Invested!",
        message: investmentMsg,
        link: `/crm/clients/${account.id}`,
      })),
    );
  }
}
