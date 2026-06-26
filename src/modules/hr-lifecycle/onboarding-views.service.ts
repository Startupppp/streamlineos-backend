import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { documentTypes, onboardingDocuments, users, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

@Injectable()
export class OnboardingViewsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async summary(orgId: string) {
    const mandatoryTypes = await this.db
      .select({ id: documentTypes.id, name: documentTypes.name })
      .from(documentTypes)
      .where(and(eq(documentTypes.orgId, orgId), eq(documentTypes.isActive, true), eq(documentTypes.isMandatory, true)));

    const totalRequired = mandatoryTypes.length;

    const employees = await this.db
      .select({
        id: users.id,
        name: users.name,
        image: users.image,
        designation: users.designation,
        employeeId: users.employeeId,
        onboardingDocStatus: users.onboardingDocStatus,
      })
      .from(users)
      .innerJoin(
        organizationMembers,
        and(eq(organizationMembers.userId, users.id), eq(organizationMembers.orgId, orgId)),
      )
      .where(eq(users.isActive, true));

    if (employees.length === 0) return [];

    const employeeIds = employees.map((e) => e.id);

    const allDocs = await this.db
      .select({
        userId: onboardingDocuments.userId,
        documentTypeId: onboardingDocuments.documentTypeId,
        status: onboardingDocuments.status,
        id: onboardingDocuments.id,
      })
      .from(onboardingDocuments)
      .where(eq(onboardingDocuments.orgId, orgId))
      .orderBy(desc(onboardingDocuments.id));

    const userDocMap = new Map<string, Map<number, string>>();

    for (const doc of allDocs) {
      if (!employeeIds.includes(doc.userId)) continue;

      if (!userDocMap.has(doc.userId)) {
        userDocMap.set(doc.userId, new Map());
      }
      const typeMap = userDocMap.get(doc.userId);
      if (typeMap && !typeMap.has(doc.documentTypeId)) {
        typeMap.set(doc.documentTypeId, doc.status ?? "PENDING");
      }
    }

    return employees.map((emp) => {
      const typeMap = userDocMap.get(emp.id) ?? new Map<number, string>();

      let totalSubmitted = 0;
      let totalApproved = 0;
      let totalRejected = 0;

      for (const [, status] of typeMap) {
        if (status === "SUBMITTED" || status === "RE_UPLOAD_REQUESTED" || status === "APPROVED" || status === "REJECTED") {
          totalSubmitted++;
        }
        if (status === "APPROVED") totalApproved++;
        if (status === "REJECTED") totalRejected++;
      }

      return {
        userId: emp.id,
        userName: emp.name,
        userImage: emp.image,
        designation: emp.designation,
        employeeId: emp.employeeId,
        totalRequired,
        totalSubmitted,
        totalApproved,
        totalRejected,
        onboardingDocStatus: emp.onboardingDocStatus ?? "PENDING",
      };
    });
  }
}
