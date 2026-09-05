import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { paymentAuditEvents } from "../../../db/schema";

export interface PaymentAuditEntry {
  orgId: string;
  actorUserId: string | null;
  providerId?: number | null;
  action: string;
  environment?: "test" | "live";
  beforeRedacted?: Record<string, unknown>;
  afterRedacted?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class PaymentAuditService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async log(entry: PaymentAuditEntry, db: Db = this.db) {
    await db.insert(paymentAuditEvents).values({
      orgId: entry.orgId,
      actorUserId: entry.actorUserId,
      providerId: entry.providerId ?? null,
      action: entry.action,
      environment: entry.environment,
      beforeRedacted: entry.beforeRedacted,
      afterRedacted: entry.afterRedacted,
      ipAddress: entry.ipAddress,
      userAgent: entry.userAgent,
    });
  }

  async listForOrg(orgId: string, limit = 100) {
    return this.db.query.paymentAuditEvents.findMany({
      where: eq(paymentAuditEvents.orgId, orgId),
      orderBy: desc(paymentAuditEvents.createdAt),
      limit,
    });
  }

  async listForProvider(orgId: string, providerId: number, limit = 100) {
    return this.db.query.paymentAuditEvents.findMany({
      where: and(eq(paymentAuditEvents.orgId, orgId), eq(paymentAuditEvents.providerId, providerId)),
      orderBy: desc(paymentAuditEvents.createdAt),
      limit,
    });
  }
}
