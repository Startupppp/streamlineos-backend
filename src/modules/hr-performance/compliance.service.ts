import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import {
  backgroundVerifications,
  certifications,
  documents,
  organizationMembers,
  policyAcknowledgments,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { AckInput, SendAckInput } from "./dto/documents.schemas";

function formatDateString(value: Date): string {
  return value.toISOString().split("T")[0];
}

@Injectable()
export class ComplianceService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listAcknowledgments(orgId: string, userId: string, isAdmin: boolean) {
    const conditions = [eq(policyAcknowledgments.orgId, orgId)];
    if (!isAdmin) conditions.push(eq(policyAcknowledgments.userId, userId));

    return this.db.query.policyAcknowledgments.findMany({
      where: and(...conditions),
      with: { document: true, user: true },
      orderBy: [desc(policyAcknowledgments.createdAt)],
    });
  }

  async sendAcknowledgments(orgId: string, input: SendAckInput) {
    const doc = await this.db.query.documents.findFirst({
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

  async acknowledge(userId: string, input: AckInput) {
    const existing = await this.db.query.policyAcknowledgments.findFirst({
      where: and(
        eq(policyAcknowledgments.id, input.acknowledgmentId),
        eq(policyAcknowledgments.userId, userId),
      ),
    });
    if (!existing) throw new NotFoundException("Acknowledgment not found.");

    await this.db
      .update(policyAcknowledgments)
      .set({ status: input.status, acknowledgedAt: new Date() })
      .where(eq(policyAcknowledgments.id, input.acknowledgmentId));

    return { success: true };
  }

  async statutory(orgId: string) {
    const now = new Date();
    const thirtyDaysAhead = new Date();
    thirtyDaysAhead.setDate(thirtyDaysAhead.getDate() + 30);
    const todayStr = formatDateString(now);
    const futureStr = formatDateString(thirtyDaysAhead);

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
              sql`${users.id} NOT IN (SELECT user_id FROM payrolls WHERE org_id = ${orgId} AND month = to_char(now(), 'YYYY-MM'))`,
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
}
