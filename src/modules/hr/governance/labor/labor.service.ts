import {
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { decodeCursor, buildCursorPage } from "../../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../../common/pagination/keyset";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { hrUnionMemberships, hrCollectiveAgreements } from "../../../../db/schema/hr/governance";
import { HrAuditService } from "../../core/hr-audit.service";
import type {
  CreateUnionMembershipInput,
  UpdateUnionMembershipInput,
  ListUnionMembershipsInput,
  CreateCollectiveAgreementInput,
  UpdateCollectiveAgreementInput,
  ListAgreementsInput,
  ExpiringAgreementsInput,
  CreateLaborCaseInput,
  UpdateLaborCaseInput,
  ListLaborCasesInput,
} from "./labor.dto";
import * as laborCases from "./labor-cases";

@Injectable()
export class LaborService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  async listMemberships(orgId: string, input: ListUnionMembershipsInput) {
    const { cursor, limit, unionName, status, userId } = input;
    const pos = decodeCursor(cursor);

    const conditions = [eq(hrUnionMemberships.orgId, orgId), isNull(hrUnionMemberships.deletedAt)];
    if (unionName) conditions.push(eq(hrUnionMemberships.unionName, unionName));
    if (status) conditions.push(eq(hrUnionMemberships.status, status));
    if (userId) conditions.push(eq(hrUnionMemberships.userId, userId));
    if (pos) conditions.push(keysetBeforeId(hrUnionMemberships.createdAt, hrUnionMemberships.id, pos));

    const rows = await this.db
      .select()
      .from(hrUnionMemberships)
      .where(and(...conditions))
      .orderBy(desc(hrUnionMemberships.createdAt), desc(hrUnionMemberships.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));
  }

  async createMembership(orgId: string, actorId: string, input: CreateUnionMembershipInput, ipAddress?: string) {
    const [row] = await this.db
      .insert(hrUnionMemberships)
      .values({
        orgId,
        userId: input.userId,
        unionName: input.unionName,
        memberSince: new Date(input.memberSince),
        status: input.status,
      })
      .returning();

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_union_membership",
      entityId: String(row!.id),
      action: "union_membership.created",
      after: { userId: input.userId, unionName: input.unionName },
      ipAddress,
    });

    return row!;
  }

  async updateMembership(orgId: string, membershipId: number, actorId: string, input: UpdateUnionMembershipInput, ipAddress?: string) {
    const existing = await this.getMembershipById(orgId, membershipId);

    const [updated] = await this.db
      .update(hrUnionMemberships)
      .set({
        ...(input.userId !== undefined && { userId: input.userId }),
        ...(input.unionName !== undefined && { unionName: input.unionName }),
        ...(input.memberSince !== undefined && { memberSince: new Date(input.memberSince) }),
        ...(input.status !== undefined && { status: input.status }),
        updatedAt: new Date(),
      })
      .where(and(eq(hrUnionMemberships.orgId, orgId), eq(hrUnionMemberships.id, membershipId)))
      .returning();

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_union_membership",
      entityId: String(membershipId),
      action: "union_membership.updated",
      before: { status: existing.status },
      after: input,
      ipAddress,
    });

    return updated!;
  }

  async deleteMembership(orgId: string, membershipId: number, actorId: string, ipAddress?: string) {
    await this.getMembershipById(orgId, membershipId);

    await this.db
      .update(hrUnionMemberships)
      .set({ deletedAt: new Date() })
      .where(and(eq(hrUnionMemberships.orgId, orgId), eq(hrUnionMemberships.id, membershipId)));

    await this.audit.log({ orgId, actorId, entityType: "hr_union_membership", entityId: String(membershipId), action: "union_membership.deleted", ipAddress });
  }

  async listAgreements(orgId: string, input: ListAgreementsInput) {
    const { cursor, limit, status, unionName } = input;
    const pos = decodeCursor(cursor);

    const conditions = [eq(hrCollectiveAgreements.orgId, orgId), isNull(hrCollectiveAgreements.deletedAt)];
    if (status) conditions.push(eq(hrCollectiveAgreements.status, status));
    if (unionName) conditions.push(eq(hrCollectiveAgreements.unionName, unionName));
    if (pos) conditions.push(keysetBeforeId(hrCollectiveAgreements.createdAt, hrCollectiveAgreements.id, pos));

    const rows = await this.db
      .select()
      .from(hrCollectiveAgreements)
      .where(and(...conditions))
      .orderBy(desc(hrCollectiveAgreements.createdAt), desc(hrCollectiveAgreements.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));
  }

  async listExpiringAgreements(orgId: string, input: ExpiringAgreementsInput) {
    const cutoff = new Date(Date.now() + input.days * 86400_000);
    const now = new Date();

    const data = await this.db
      .select()
      .from(hrCollectiveAgreements)
      .where(
        and(
          eq(hrCollectiveAgreements.orgId, orgId),
          isNull(hrCollectiveAgreements.deletedAt),
          eq(hrCollectiveAgreements.status, "active"),
          gte(hrCollectiveAgreements.expiresAt, now),
          lte(hrCollectiveAgreements.expiresAt, cutoff),
        ),
      )
      .orderBy(hrCollectiveAgreements.expiresAt)
      .limit(100);

    return { data, daysWindow: input.days };
  }

  async createAgreement(orgId: string, actorId: string, input: CreateCollectiveAgreementInput, ipAddress?: string) {
    const [row] = await this.db
      .insert(hrCollectiveAgreements)
      .values({
        orgId,
        unionName: input.unionName,
        title: input.title,
        effectiveFrom: new Date(input.effectiveFrom),
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        documentUrl: input.documentUrl ?? null,
        status: input.status,
      })
      .returning();

    await this.audit.log({
      orgId, actorId, entityType: "hr_collective_agreement", entityId: String(row!.id),
      action: "collective_agreement.created", after: { title: input.title, unionName: input.unionName }, ipAddress,
    });

    return row!;
  }

  async updateAgreement(orgId: string, agreementId: number, actorId: string, input: UpdateCollectiveAgreementInput, ipAddress?: string) {
    const existing = await this.getAgreementById(orgId, agreementId);

    const [updated] = await this.db
      .update(hrCollectiveAgreements)
      .set({
        ...(input.unionName !== undefined && { unionName: input.unionName }),
        ...(input.title !== undefined && { title: input.title }),
        ...(input.effectiveFrom !== undefined && { effectiveFrom: new Date(input.effectiveFrom) }),
        ...(input.expiresAt !== undefined && { expiresAt: input.expiresAt ? new Date(input.expiresAt) : null }),
        ...(input.documentUrl !== undefined && { documentUrl: input.documentUrl }),
        ...(input.status !== undefined && { status: input.status }),
        updatedAt: new Date(),
      })
      .where(and(eq(hrCollectiveAgreements.orgId, orgId), eq(hrCollectiveAgreements.id, agreementId)))
      .returning();

    await this.audit.log({ orgId, actorId, entityType: "hr_collective_agreement", entityId: String(agreementId), action: "collective_agreement.updated", before: { status: existing.status }, after: input, ipAddress });

    return updated!;
  }

  async deleteAgreement(orgId: string, agreementId: number, actorId: string, ipAddress?: string) {
    await this.getAgreementById(orgId, agreementId);

    await this.db
      .update(hrCollectiveAgreements)
      .set({ deletedAt: new Date() })
      .where(and(eq(hrCollectiveAgreements.orgId, orgId), eq(hrCollectiveAgreements.id, agreementId)));

    await this.audit.log({ orgId, actorId, entityType: "hr_collective_agreement", entityId: String(agreementId), action: "collective_agreement.deleted", ipAddress });
  }

  async listLaborCases(orgId: string, input: ListLaborCasesInput) {
    return laborCases.listLaborCases(this.db, orgId, input);
  }

  async createLaborCase(orgId: string, actorId: string, input: CreateLaborCaseInput, ipAddress?: string) {
    return laborCases.createLaborCase(this.db, this.audit, orgId, actorId, input, ipAddress);
  }

  async updateLaborCase(orgId: string, caseId: number, actorId: string, input: UpdateLaborCaseInput, ipAddress?: string) {
    return laborCases.updateLaborCase(this.db, this.audit, orgId, caseId, actorId, input, ipAddress);
  }

  async deleteLaborCase(orgId: string, caseId: number, actorId: string, ipAddress?: string) {
    return laborCases.deleteLaborCase(this.db, this.audit, orgId, caseId, actorId, ipAddress);
  }

  private async getMembershipById(orgId: string, id: number) {
    const [row] = await this.db.select().from(hrUnionMemberships).where(and(eq(hrUnionMemberships.orgId, orgId), eq(hrUnionMemberships.id, id), isNull(hrUnionMemberships.deletedAt))).limit(1);
    if (!row) throw new NotFoundException("Union membership not found");
    return row;
  }

  private async getAgreementById(orgId: string, id: number) {
    const [row] = await this.db.select().from(hrCollectiveAgreements).where(and(eq(hrCollectiveAgreements.orgId, orgId), eq(hrCollectiveAgreements.id, id), isNull(hrCollectiveAgreements.deletedAt))).limit(1);
    if (!row) throw new NotFoundException("Collective agreement not found");
    return row;
  }
}
