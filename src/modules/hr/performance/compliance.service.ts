import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import {
  backgroundVerifications,
  certifications,
  documents,
  organizationMembers,
  policyAcknowledgments,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { AckInput, SendAckInput } from "./dto/documents.schemas";
import { formatDateOnly } from "../../../common/date";

interface CalendarEvent {
  date: string;
  type: "document_expiry" | "certification_expiry";
  title: string;
  entityId: number;
  entityName: string;
}

@Injectable()
export class ComplianceService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listAcknowledgments(orgId: string, userId: string, scope: DataScope) {
    const conditions = [
      eq(policyAcknowledgments.orgId, orgId),
      applyScope(scope, orgId, userId, { ownerColumn: policyAcknowledgments.userId }),
    ];

    return this.db.query.policyAcknowledgments.findMany({
      where: and(...conditions),
      with: { document: true, user: { columns: { id: true, name: true } } },
      orderBy: [desc(policyAcknowledgments.createdAt)],
      limit: 100,
    });
  }

  async sendAcknowledgments(orgId: string, input: SendAckInput) {
    const doc = await this.db.query.documents.findFirst({
      columns: { id: true },
      where: and(eq(documents.id, input.documentId), eq(documents.orgId, orgId)),
    });
    if (!doc) throw new NotFoundException("Document not found.");

    const values = input.userIds.map((userId) => ({
      orgId,
      documentId: input.documentId,
      userId,
      status: "PENDING" as const,
    }));

    await this.db.insert(policyAcknowledgments).values(values);
    return { success: true, sent: values.length };
  }

  async acknowledge(orgId: string, userId: string, input: AckInput) {
    const existing = await this.db.query.policyAcknowledgments.findFirst({
      columns: { id: true },
      where: and(
        eq(policyAcknowledgments.id, input.acknowledgmentId),
        eq(policyAcknowledgments.orgId, orgId),
        eq(policyAcknowledgments.userId, userId),
      ),
    });
    if (!existing) throw new NotFoundException("Acknowledgment not found.");

    await this.db
      .update(policyAcknowledgments)
      .set({ status: input.status, acknowledgedAt: new Date() })
      .where(and(eq(policyAcknowledgments.id, input.acknowledgmentId), eq(policyAcknowledgments.orgId, orgId)));

    return { success: true };
  }

  async statutory(orgId: string) {
    const now = new Date();
    const thirtyDaysAhead = new Date();
    thirtyDaysAhead.setDate(thirtyDaysAhead.getDate() + 30);
    const todayStr = formatDateOnly(now);
    const futureStr = formatDateOnly(thirtyDaysAhead);

    const [totalEmployees, pendingAcks, expiringCerts, pendingBgv, payrollsMissing] =
      await Promise.all([
        this.db
          .select({ count: count() })
          .from(organizationMembers)
          .innerJoin(users, eq(organizationMembers.userId, users.id))
          .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true))),

        this.db
          .select({ count: count() })
          .from(policyAcknowledgments)
          .where(
            and(
              eq(policyAcknowledgments.orgId, orgId),
              eq(policyAcknowledgments.status, "PENDING"),
            ),
          ),

        this.db
          .select({ count: count() })
          .from(certifications)
          .where(
            and(
              eq(certifications.orgId, orgId),
              lte(certifications.expiryDate, futureStr),
              gte(certifications.expiryDate, todayStr),
            ),
          ),

        this.db
          .select({ count: count() })
          .from(backgroundVerifications)
          .where(
            and(
              eq(backgroundVerifications.orgId, orgId),
              eq(backgroundVerifications.status, "PENDING"),
            ),
          ),

        this.db
          .select({ count: count() })
          .from(organizationMembers)
          .innerJoin(users, eq(organizationMembers.userId, users.id))
          .where(
            and(
              eq(organizationMembers.orgId, orgId),
              eq(users.isActive, true),
              sql`${users.id} NOT IN (SELECT pre.user_id FROM payroll_run_employees pre JOIN payroll_runs pr ON pr.id = pre.run_id WHERE pr.org_id = ${orgId} AND pr.month = to_char(now(), 'YYYY-MM'))`,
            ),
          ),
      ]);

    const total = Number(totalEmployees[0]?.count ?? 0);
    const checks = [
      {
        name: "Policy Acknowledgments",
        status: Number(pendingAcks[0]?.count ?? 0) === 0 ? "COMPLIANT" : "ACTION_NEEDED",
        pending: Number(pendingAcks[0]?.count ?? 0),
        description: "Pending policy acknowledgments from employees",
      },
      {
        name: "Certification Expiry",
        status: Number(expiringCerts[0]?.count ?? 0) === 0 ? "COMPLIANT" : "WARNING",
        pending: Number(expiringCerts[0]?.count ?? 0),
        description: "Certifications expiring within 30 days",
      },
      {
        name: "Background Verification",
        status: Number(pendingBgv[0]?.count ?? 0) === 0 ? "COMPLIANT" : "ACTION_NEEDED",
        pending: Number(pendingBgv[0]?.count ?? 0),
        description: "Pending background verifications",
      },
      {
        name: "Payroll Processing",
        status: Number(payrollsMissing[0]?.count ?? 0) === 0 ? "COMPLIANT" : "WARNING",
        pending: Number(payrollsMissing[0]?.count ?? 0),
        description: "Employees without payroll for current month",
      },
    ];

    const compliantCount = checks.filter((c) => c.status === "COMPLIANT").length;
    const overallScore = Math.round((compliantCount / checks.length) * 100);

    return {
      totalEmployees: total,
      overallComplianceScore: overallScore,
      checks,
    };
  }

  async calendar(orgId: string, year: number, month: number): Promise<{ events: CalendarEvent[]; year: number; month: number }> {
    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0);
    const fromStr = formatDateOnly(firstDay);
    const toStr = formatDateOnly(lastDay);

    const [expiringDocs, expiringCerts] = await Promise.all([
      this.db
        .select({ id: documents.id, name: documents.name, expiryDate: documents.expiryDate })
        .from(documents)
        .where(
          and(
            eq(documents.orgId, orgId),
            eq(documents.isActive, true),
            sql`${documents.expiryDate} IS NOT NULL`,
            gte(documents.expiryDate, fromStr),
            lte(documents.expiryDate, toStr),
          ),
        )
        .limit(100),

      this.db
        .select({ id: certifications.id, name: certifications.name, expiryDate: certifications.expiryDate })
        .from(certifications)
        .where(
          and(
            eq(certifications.orgId, orgId),
            sql`${certifications.expiryDate} IS NOT NULL`,
            gte(certifications.expiryDate, fromStr),
            lte(certifications.expiryDate, toStr),
          ),
        )
        .limit(100),
    ]);

    const events: CalendarEvent[] = [
      ...expiringDocs
        .filter((d) => d.expiryDate !== null)
        .map((d) => ({
          date: d.expiryDate as string,
          type: "document_expiry" as const,
          title: `Document expiring: ${d.name}`,
          entityId: d.id,
          entityName: d.name,
        })),
      ...expiringCerts
        .filter((c) => c.expiryDate !== null)
        .map((c) => ({
          date: c.expiryDate as string,
          type: "certification_expiry" as const,
          title: `Certification expiring: ${c.name}`,
          entityId: c.id,
          entityName: c.name,
        })),
    ];

    events.sort((a, b) => a.date.localeCompare(b.date));
    return { events, year, month };
  }
}
