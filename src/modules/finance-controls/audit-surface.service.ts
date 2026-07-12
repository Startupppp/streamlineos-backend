import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { auditLogs } from "../../db/schema";
import { AuditService } from "../../common/audit/audit.service";
import { buildListResponse, paginateOffset } from "../../common/pagination/pagination";
import type { ListAuditQuery } from "./dto/finance-controls.schemas";

const FINANCE_RESOURCE_TYPES = [
  "journal_entry",
  "approval_request",
  "approval_policy",
  "exchange_rate",
  "credit_note",
  "purchase_bill",
  "expense",
  "invoice",
  "bank_account",
  "vendor_payment",
] as const;

const AUDIT_EXPORT_CAP = 10_000;

@Injectable()
export class AuditSurfaceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string, query: ListAuditQuery) {
    const { limit, offset } = paginateOffset(query);
    const conditions = this.buildConditions(orgId, query);

    const [rows, [{ count }]] = await Promise.all([
      this.db
        .select()
        .from(auditLogs)
        .where(and(...conditions))
        .orderBy(desc(auditLogs.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(auditLogs)
        .where(and(...conditions)),
    ]);

    return buildListResponse(rows, count, query);
  }

  async timeline(orgId: string, resourceType: string, resourceId: string) {
    return this.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.orgId, orgId),
          eq(auditLogs.resourceType, resourceType),
          eq(auditLogs.resourceId, resourceId),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(500);
  }

  async exportCsv(orgId: string, userId: string, query: ListAuditQuery): Promise<string> {
    const conditions = this.buildConditions(orgId, query);

    const rows = await this.db
      .select()
      .from(auditLogs)
      .where(and(...conditions))
      .orderBy(desc(auditLogs.createdAt))
      .limit(AUDIT_EXPORT_CAP);

    this.audit.log({
      action: "accounting.audit.export",
      userId,
      orgId,
      resourceType: "audit_log",
      metadata: { rowCount: rows.length, query },
      result: "SUCCESS",
    });

    return buildCsv(rows);
  }

  private buildConditions(orgId: string, query: ListAuditQuery) {
    const baseConditions = [
      eq(auditLogs.orgId, orgId),
      or(
        ilike(auditLogs.action, "accounting.%"),
        inArray(auditLogs.resourceType, [...FINANCE_RESOURCE_TYPES]),
      ),
    ];

    if (query.resourceType) {
      baseConditions.push(eq(auditLogs.resourceType, query.resourceType));
    }

    if (query.resourceId) {
      baseConditions.push(eq(auditLogs.resourceId, query.resourceId));
    }

    if (query.action) {
      baseConditions.push(ilike(auditLogs.action, `%${escapeLike(query.action)}%`));
    }

    if (query.from) baseConditions.push(gte(auditLogs.createdAt, new Date(query.from)));
    if (query.to) baseConditions.push(lte(auditLogs.createdAt, new Date(query.to)));

    return baseConditions;
  }
}

function escapeLike(value: string): string {
  return value.replaceAll("%", "\\%").replaceAll("_", "\\_");
}

type AuditRow = {
  id: number;
  action: string;
  userId: string;
  orgId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  actorUserId: string | null;
  ipAddress: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
};

function buildCsv(rows: AuditRow[]): string {
  const header = "id,action,userId,orgId,resourceType,resourceId,actorUserId,ipAddress,createdAt\n";
  const lines = rows.map((r) =>
    [
      r.id,
      csvEscape(r.action),
      csvEscape(r.userId),
      csvEscape(r.orgId ?? ""),
      csvEscape(r.resourceType ?? ""),
      csvEscape(r.resourceId ?? ""),
      csvEscape(r.actorUserId ?? ""),
      csvEscape(r.ipAddress ?? ""),
      r.createdAt.toISOString(),
    ].join(","),
  );
  return header + lines.join("\n");
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}
