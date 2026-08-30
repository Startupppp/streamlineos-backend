import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, isNull, isNotNull, lt, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import { billingProrationLines } from "../../../db/schema";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { computeProrationMinor, type RoundingRule } from "./proration-math";
import { VersionedCatalogService } from "./versioned-catalog.service";

export const PRORATION_LINE_TYPES = ["UPGRADE", "DOWNGRADE", "QUANTITY_CHANGE"] as const;

export type ProrationLineType = (typeof PRORATION_LINE_TYPES)[number];

export interface ProrationChangeInput {
  orgId: string;
  subscriptionId: number;
  idempotencyKey: string;
  oldPriceVersionId: number;
  newPriceVersionId: number;
  oldQuantity: number;
  newQuantity: number;
  periodStart: Date;
  periodEnd: Date;
  effectiveFrom: Date;
  effectiveUntil?: Date;
  roundingRule?: RoundingRule;
  providerAmountMinor?: number | null;
  providerRef?: string | null;
  createdBy?: string | null;
}

export interface ProrationLineRecord {
  id: number;
  lineType: ProrationLineType;
  oldPriceVersionId: number | null;
  newPriceVersionId: number | null;
  effectiveFrom: Date;
  effectiveUntil: Date;
  quantity: number;
  currency: string;
  amountMinor: number;
  roundingRule: string;
  replayed: boolean;
}

export interface ProrationReconciliation {
  id: number;
  amountMinor: number;
  providerAmountMinor: number;
  varianceMinor: number;
  agrees: boolean;
  providerRef: string;
  reconciledAt: Date;
}

function classify(input: {
  oldUnitAmountMinor: number;
  newUnitAmountMinor: number;
  oldQuantity: number;
  newQuantity: number;
}): ProrationLineType {
  if (input.oldUnitAmountMinor !== input.newUnitAmountMinor)
    return input.newUnitAmountMinor > input.oldUnitAmountMinor ? "UPGRADE" : "DOWNGRADE";
  return "QUANTITY_CHANGE";
}

@Injectable()
export class ProrationLedgerService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly catalog: VersionedCatalogService,
  ) {}

  async recordPlanChange(input: ProrationChangeInput, executor?: DbOrTx): Promise<ProrationLineRecord> {
    if (executor) return this.write(executor, input);
    return runInTenantTransaction(this.db, (tx) => this.write(tx, input), { orgId: input.orgId });
  }

  private async write(tx: DbOrTx, input: ProrationChangeInput): Promise<ProrationLineRecord> {
    const { orgId, idempotencyKey } = input;

    const replay = await this.findByIdempotencyKey(tx, orgId, idempotencyKey);
    if (replay) return replay;

    const [oldPrice, newPrice] = await Promise.all([
      this.catalog.getPriceVersionById(input.oldPriceVersionId),
      this.catalog.getPriceVersionById(input.newPriceVersionId),
    ]);

    if (!oldPrice) throw new NotFoundException(`Price version ${input.oldPriceVersionId} does not exist`);
    if (!newPrice) throw new NotFoundException(`Price version ${input.newPriceVersionId} does not exist`);
    if (oldPrice.currency !== newPrice.currency)
      throw new BadRequestException(
        `Cannot prorate across currencies (${oldPrice.currency} → ${newPrice.currency}); issue a credit note and a new invoice instead`,
      );

    const effectiveUntil = input.effectiveUntil ?? input.periodEnd;
    const roundingRule: RoundingRule = input.roundingRule ?? "HALF_UP";
    const lineType = classify({
      oldUnitAmountMinor: oldPrice.amountMinor,
      newUnitAmountMinor: newPrice.amountMinor,
      oldQuantity: input.oldQuantity,
      newQuantity: input.newQuantity,
    });

    const amountMinor = computeProrationMinor({
      oldUnitAmountMinor: oldPrice.amountMinor,
      oldQuantity: input.oldQuantity,
      newUnitAmountMinor: newPrice.amountMinor,
      newQuantity: input.newQuantity,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      effectiveFrom: input.effectiveFrom,
      effectiveUntil,
      roundingRule,
    });

    const [inserted] = await tx
      .insert(billingProrationLines)
      .values({
        orgId,
        subscriptionId: input.subscriptionId,
        idempotencyKey,
        lineType,
        oldPriceVersionId: input.oldPriceVersionId,
        newPriceVersionId: input.newPriceVersionId,
        effectiveFrom: input.effectiveFrom,
        effectiveUntil,
        quantity: input.newQuantity,
        currency: newPrice.currency,
        amountMinor,
        roundingRule,
        providerAmountMinor: input.providerAmountMinor ?? null,
        providerRef: input.providerRef ?? null,
        createdBy: input.createdBy ?? null,
      })
      .onConflictDoNothing({
        target: [billingProrationLines.orgId, billingProrationLines.idempotencyKey],
      })
      .returning({ id: billingProrationLines.id });

    if (!inserted) {
      const stored = await this.findByIdempotencyKey(tx, orgId, idempotencyKey);
      if (!stored) throw new Error(`Proration line for org ${orgId} was neither inserted nor replayable`);
      return stored;
    }

    return {
      id: inserted.id,
      lineType,
      oldPriceVersionId: input.oldPriceVersionId,
      newPriceVersionId: input.newPriceVersionId,
      effectiveFrom: input.effectiveFrom,
      effectiveUntil,
      quantity: input.newQuantity,
      currency: newPrice.currency,
      amountMinor,
      roundingRule,
      replayed: false,
    };
  }

  private async findByIdempotencyKey(
    tx: DbOrTx,
    orgId: string,
    idempotencyKey: string,
  ): Promise<ProrationLineRecord | null> {
    const [existing] = await tx
      .select({
        id: billingProrationLines.id,
        lineType: billingProrationLines.lineType,
        oldPriceVersionId: billingProrationLines.oldPriceVersionId,
        newPriceVersionId: billingProrationLines.newPriceVersionId,
        effectiveFrom: billingProrationLines.effectiveFrom,
        effectiveUntil: billingProrationLines.effectiveUntil,
        quantity: billingProrationLines.quantity,
        currency: billingProrationLines.currency,
        amountMinor: billingProrationLines.amountMinor,
        roundingRule: billingProrationLines.roundingRule,
      })
      .from(billingProrationLines)
      .where(
        and(
          eq(billingProrationLines.orgId, orgId),
          eq(billingProrationLines.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);

    if (!existing) return null;
    return {
      ...existing,
      lineType: existing.lineType as ProrationLineType,
      oldPriceVersionId: existing.oldPriceVersionId ?? null,
      newPriceVersionId: existing.newPriceVersionId ?? null,
      replayed: true,
    };
  }

  /** `amountMinor` is never overwritten: a provider figure that disagrees is a discrepancy, not a correction. */
  async reconcileProviderAmount(
    orgId: string,
    idempotencyKey: string,
    providerAmountMinor: number,
    providerRef: string,
  ): Promise<ProrationReconciliation> {
    if (!Number.isInteger(providerAmountMinor))
      throw new BadRequestException("Provider amount must be an integer minor unit");

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const reconciledAt = new Date();
        const [updated] = await tx
          .update(billingProrationLines)
          .set({ providerAmountMinor, providerRef, reconciledAt })
          .where(
            and(
              eq(billingProrationLines.orgId, orgId),
              eq(billingProrationLines.idempotencyKey, idempotencyKey),
            ),
          )
          .returning({
            id: billingProrationLines.id,
            amountMinor: billingProrationLines.amountMinor,
          });

        if (!updated) throw new NotFoundException("Proration line not found");

        const varianceMinor = providerAmountMinor - updated.amountMinor;
        return {
          id: Number(updated.id),
          amountMinor: updated.amountMinor,
          providerAmountMinor,
          varianceMinor,
          agrees: varianceMinor === 0,
          providerRef,
          reconciledAt,
        };
      },
      { orgId },
    );
  }

  async listUnreconciled(orgId: string, limit = 100) {
    const capped = Math.min(Math.max(limit, 1), 100);
    return runInTenantTransaction(
      this.db,
      (tx) =>
        tx
          .select({
            id: billingProrationLines.id,
            idempotencyKey: billingProrationLines.idempotencyKey,
            amountMinor: billingProrationLines.amountMinor,
            providerAmountMinor: billingProrationLines.providerAmountMinor,
            providerRef: billingProrationLines.providerRef,
            currency: billingProrationLines.currency,
            effectiveFrom: billingProrationLines.effectiveFrom,
          })
          .from(billingProrationLines)
          .where(
            and(
              eq(billingProrationLines.orgId, orgId),
              isNull(billingProrationLines.reconciledAt),
              isNotNull(billingProrationLines.providerRef),
            ),
          )
          .orderBy(desc(billingProrationLines.effectiveFrom))
          .limit(capped),
      { orgId },
    );
  }

  async listForSubscription(orgId: string, subscriptionId: number, limit = 100) {
    const capped = Math.min(Math.max(limit, 1), 100);
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const lines = await tx
          .select({
            id: billingProrationLines.id,
            lineType: billingProrationLines.lineType,
            effectiveFrom: billingProrationLines.effectiveFrom,
            effectiveUntil: billingProrationLines.effectiveUntil,
            quantity: billingProrationLines.quantity,
            currency: billingProrationLines.currency,
            amountMinor: billingProrationLines.amountMinor,
            roundingRule: billingProrationLines.roundingRule,
            reconciledAt: billingProrationLines.reconciledAt,
          })
          .from(billingProrationLines)
          .where(
            and(
              eq(billingProrationLines.orgId, orgId),
              eq(billingProrationLines.subscriptionId, subscriptionId),
            ),
          )
          .orderBy(desc(billingProrationLines.effectiveFrom))
          .limit(capped);

        const chargeMinor = lines.reduce((sum, line) => sum + Math.max(line.amountMinor, 0), 0);
        const creditMinor = lines.reduce((sum, line) => sum + Math.min(line.amountMinor, 0), 0);
        return { lines, chargeMinor, creditMinor, netMinor: chargeMinor + creditMinor };
      },
      { orgId },
    );
  }

  async sumForPeriod(orgId: string, subscriptionId: number, periodStart: Date, periodEnd: Date) {
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const [row] = await tx
          .select({
            netMinor: sql<number>`COALESCE(SUM(${billingProrationLines.amountMinor}), 0)::bigint`,
            lineCount: sql<number>`COUNT(*)::int`,
          })
          .from(billingProrationLines)
          .where(
            and(
              eq(billingProrationLines.orgId, orgId),
              eq(billingProrationLines.subscriptionId, subscriptionId),
              gte(billingProrationLines.effectiveFrom, periodStart),
              lt(billingProrationLines.effectiveFrom, periodEnd),
            ),
          );
        return { netMinor: Number(row?.netMinor ?? 0), lineCount: Number(row?.lineCount ?? 0) };
      },
      { orgId },
    );
  }
}
