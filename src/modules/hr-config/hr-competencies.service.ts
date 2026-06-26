import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { certifications, employeeSkills } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type {
  CertificationListQuery,
  CreateCertificationInput,
  CreateSkillInput,
  SkillListQuery,
} from "./dto/competencies.schemas";

type SkillRow = typeof employeeSkills.$inferSelect;

export type CreateSkillResult =
  | { created: false; data: { id: number } }
  | { created: true; data: SkillRow };

@Injectable()
export class HrCompetenciesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listSkills(orgId: string, query: SkillListQuery) {
    const conditions = [eq(employeeSkills.orgId, orgId)];
    if (query.userId) conditions.push(eq(employeeSkills.userId, query.userId));

    return this.db.query.employeeSkills.findMany({
      where: and(...conditions),
      with: { user: true },
      orderBy: [desc(employeeSkills.createdAt)],
      limit: query.limit,
    });
  }

  async createSkill(orgId: string, targetUserId: string, input: CreateSkillInput): Promise<CreateSkillResult> {
    const existing = await this.db.query.employeeSkills.findFirst({
      where: and(
        eq(employeeSkills.orgId, orgId),
        eq(employeeSkills.userId, targetUserId),
        eq(employeeSkills.skillName, input.skillName),
      ),
      columns: { id: true },
    });
    if (existing) return { created: false, data: existing };

    const [skill] = await this.db
      .insert(employeeSkills)
      .values({
        orgId,
        userId: targetUserId,
        skillName: input.skillName,
        level: input.level,
      })
      .returning();
    return { created: true, data: skill };
  }

  listCertifications(orgId: string, query: CertificationListQuery) {
    const conditions = [eq(certifications.orgId, orgId)];
    if (query.userId) conditions.push(eq(certifications.userId, query.userId));

    if (query.expiringSoon === "true") {
      const thirtyDaysFromNow = new Date();
      thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
      conditions.push(lte(certifications.expiryDate, thirtyDaysFromNow.toISOString().split("T")[0]));
      conditions.push(gte(certifications.expiryDate, new Date().toISOString().split("T")[0]));
    }

    return this.db.query.certifications.findMany({
      where: and(...conditions),
      with: { user: true },
      orderBy: [desc(certifications.createdAt)],
      limit: query.limit,
    });
  }

  createCertification(orgId: string, userId: string, input: CreateCertificationInput) {
    return this.db
      .insert(certifications)
      .values({
        orgId,
        userId: input.userId ?? userId,
        name: input.name,
        issuingOrganization: input.issuingOrganization,
        issueDate: input.issueDate,
        expiryDate: input.expiryDate,
        credentialId: input.credentialId,
        credentialUrl: input.credentialUrl || undefined,
        documentUrl: input.documentUrl || undefined,
      })
      .returning()
      .then((rows) => rows[0]);
  }
}
