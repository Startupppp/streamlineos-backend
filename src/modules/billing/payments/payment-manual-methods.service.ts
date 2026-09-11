import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { paymentManualMethods } from "../../../db/schema";
import { PaymentAuditService } from "./payment-audit.service";
import type { CreateManualMethodInput, UpdateManualMethodInput } from "./dto/manual-methods.schemas";
import type { RequestActorContext } from "../../../common/audit/actor-context";

type ManualMethodStatus = "enabled" | "missing_instructions" | "disabled";

function computeStatus(values: {
  instructions?: string | null;
  upiId?: string | null;
  bankName?: string | null;
  accountHolder?: string | null;
  maskedAccountNumber?: string | null;
}): ManualMethodStatus {
  const hasInstructions = Boolean(
    values.instructions?.trim() ||
    values.upiId?.trim() ||
    (values.bankName?.trim() && values.accountHolder?.trim() && values.maskedAccountNumber?.trim()),
  );
  return hasInstructions ? "enabled" : "missing_instructions";
}

@Injectable()
export class PaymentManualMethodsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: PaymentAuditService,
  ) { }

  async list(orgId: string) {
    return this.db.query.paymentManualMethods.findMany({
      where: eq(paymentManualMethods.orgId, orgId),
    });
  }

  async create(orgId: string, input: CreateManualMethodInput, actor: RequestActorContext) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-method:${orgId}:${input.methodType}`}, 0))`);
      const existing = await tx.query.paymentManualMethods.findFirst({
        columns: { id: true },
        where: and(eq(paymentManualMethods.orgId, orgId), eq(paymentManualMethods.methodType, input.methodType)),
      });

      const status = computeStatus(input);
      const values = { ...input, status };

      const [saved] = existing
        ? await tx
          .update(paymentManualMethods)
          .set(values)
          .where(and(eq(paymentManualMethods.orgId, orgId), eq(paymentManualMethods.id, existing.id)))
          .returning()
        : await tx.insert(paymentManualMethods).values({ ...values, orgId }).returning();

      await this.audit.log({
        orgId,
        actorUserId: actor.userId,
        action: existing ? "payment_manual_method.updated" : "payment_manual_method.created",
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        afterRedacted: { methodType: input.methodType, status },
      }, tx);

      return saved;
    });
  }

  async update(orgId: string, id: number, input: UpdateManualMethodInput, actor: RequestActorContext) {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx.select({
        methodType: paymentManualMethods.methodType,
        instructions: paymentManualMethods.instructions,
        upiId: paymentManualMethods.upiId,
        bankName: paymentManualMethods.bankName,
        accountHolder: paymentManualMethods.accountHolder,
        maskedAccountNumber: paymentManualMethods.maskedAccountNumber,
      }).from(paymentManualMethods)
        .where(and(eq(paymentManualMethods.id, id), eq(paymentManualMethods.orgId, orgId)))
        .limit(1).for("update");
      if (!existing) throw new NotFoundException("Manual payment method not found");

      const merged = { ...existing, ...input };
      const status = computeStatus(merged);

      const [updated] = await tx
        .update(paymentManualMethods)
        .set({ ...input, status })
        .where(and(eq(paymentManualMethods.orgId, orgId), eq(paymentManualMethods.id, id)))
        .returning();

      await this.audit.log({
        orgId,
        actorUserId: actor.userId,
        action: "payment_manual_method.updated",
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        afterRedacted: { methodType: existing.methodType, status },
      }, tx);

      return updated;
    });
  }

  async disable(orgId: string, id: number, actor: RequestActorContext) {
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(paymentManualMethods)
        .set({ status: "disabled" })
        .where(and(eq(paymentManualMethods.orgId, orgId), eq(paymentManualMethods.id, id)))
        .returning();
      if (!updated) throw new NotFoundException("Manual payment method not found");

      await this.audit.log({
        orgId,
        actorUserId: actor.userId,
        action: "payment_manual_method.disabled",
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      }, tx);

      return updated;
    });
  }
}
