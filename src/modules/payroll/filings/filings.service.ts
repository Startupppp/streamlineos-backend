import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { payrollFilings } from "../../../db/schema";

/**
 * Filing workflows are export-first until provider integrations exist.
 * UI must show honest labels: "Export prepared — external filing required."
 */
@Injectable()
export class PayrollFilingsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string) {
    return this.db
      .select()
      .from(payrollFilings)
      .where(eq(payrollFilings.orgId, orgId))
      .orderBy(desc(payrollFilings.createdAt))
      .limit(100);
  }

  async prepareExport(
    orgId: string,
    actorId: string,
    body: {
      filingType: string;
      periodId?: number;
      entityId?: number;
      fiscalYear?: string;
      payload?: Record<string, unknown>;
      ruleVersion?: string;
    },
  ) {
    const [row] = await this.db
      .insert(payrollFilings)
      .values({
        orgId,
        entityId: body.entityId ?? null,
        periodId: body.periodId ?? null,
        fiscalYear: body.fiscalYear ?? null,
        filingType: body.filingType,
        ruleVersion: body.ruleVersion ?? "IN-2025.04",
        status: "EXPORT_PREPARED",
        payload: body.payload ?? {},
        externalFilingRequired: true,
        statusLabel: "Export prepared — external filing required",
        createdBy: actorId,
      })
      .returning();
    return row;
  }

  async attachAcknowledgement(
    orgId: string,
    filingId: number,
    body: { challanRef?: string; acknowledgementRef?: string },
  ) {
    const existing = await this.db.query.payrollFilings.findFirst({
      where: and(eq(payrollFilings.id, filingId), eq(payrollFilings.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Filing not found");

    const hasAck = !!(body.acknowledgementRef || body.challanRef);
    const [row] = await this.db
      .update(payrollFilings)
      .set({
        challanRef: body.challanRef ?? existing.challanRef,
        acknowledgementRef: body.acknowledgementRef ?? existing.acknowledgementRef,
        status: hasAck ? "ACKNOWLEDGED" : existing.status,
        statusLabel: hasAck
          ? "Acknowledged — reconciliation pending"
          : existing.statusLabel,
        submittedAt: hasAck ? new Date() : existing.submittedAt,
      })
      .where(eq(payrollFilings.id, filingId))
      .returning();
    return row;
  }
}
