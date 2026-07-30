import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { paymentManualMethods } from "../../db/schema";
import { PaymentAuditService } from "./payment-audit.service";
import type { CreateManualMethodInput, UpdateManualMethodInput } from "./dto/manual-methods.schemas";
import type { RequestActorContext } from "../../common/audit/actor-context";

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
  ) {}

  async list(orgId: string) {
    return this.db.query.paymentManualMethods.findMany({
      where: eq(paymentManualMethods.orgId, orgId),
    });
  }

  async create(orgId: string, input: CreateManualMethodInput, actor: RequestActorContext) {
    const existing = await this.db.query.paymentManualMethods.findFirst({
      where: and(eq(paymentManualMethods.orgId, orgId), eq(paymentManualMethods.methodType, input.methodType)),
    });

    const status = computeStatus(input);
    const values = { ...input, status };

    const [saved] = existing
      ? await this.db
          .update(paymentManualMethods)
          .set(values)
          .where(eq(paymentManualMethods.id, existing.id))
          .returning()
      : await this.db.insert(paymentManualMethods).values({ ...values, orgId }).returning();

    await this.audit.log({
      orgId,
      actorUserId: actor.userId,
      action: existing ? "payment_manual_method.updated" : "payment_manual_method.created",
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      afterRedacted: { methodType: input.methodType, status },
    });

    return saved;
  }

  async update(orgId: string, id: number, input: UpdateManualMethodInput, actor: RequestActorContext) {
    const existing = await this.db.query.paymentManualMethods.findFirst({
      where: and(eq(paymentManualMethods.id, id), eq(paymentManualMethods.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Manual payment method not found");

    const merged = { ...existing, ...input };
    const status = computeStatus(merged);

    const [updated] = await this.db
      .update(paymentManualMethods)
      .set({ ...input, status })
      .where(eq(paymentManualMethods.id, id))
      .returning();

    await this.audit.log({
      orgId,
      actorUserId: actor.userId,
      action: "payment_manual_method.updated",
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      afterRedacted: { methodType: existing.methodType, status },
    });

    return updated;
  }

  async disable(orgId: string, id: number, actor: RequestActorContext) {
    const existing = await this.db.query.paymentManualMethods.findFirst({
      where: and(eq(paymentManualMethods.id, id), eq(paymentManualMethods.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Manual payment method not found");

    const [updated] = await this.db
      .update(paymentManualMethods)
      .set({ status: "disabled" })
      .where(eq(paymentManualMethods.id, id))
      .returning();

    await this.audit.log({
      orgId,
      actorUserId: actor.userId,
      action: "payment_manual_method.disabled",
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return updated;
  }
}
