import { Inject, Injectable, NotFoundException, BadRequestException, ForbiddenException } from "@nestjs/common";
import { and, eq, desc } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { hrWorkflowDelegations } from "../../../db/schema/hr/workflow-engine";
import { users } from "../../../db/schema";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import type { CreateDelegationDto, UpdateDelegationDto } from "./dto/workflow.schemas";
import { requireOrganizationMembershipId } from "../time/organization-membership";

@Injectable()
export class HrWorkflowDelegationsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async myDelegations(u: CurrentUserContext) {
    const membershipId = actingMembershipId(u.principal);
    if (membershipId == null) throw new ForbiddenException("Organization membership required.");
    return this.db
      .select({
        id: hrWorkflowDelegations.id,
        orgId: hrWorkflowDelegations.orgId,
        delegatorUserId: hrWorkflowDelegations.delegatorUserId,
        delegateUserId: hrWorkflowDelegations.delegateUserId,
        objectType: hrWorkflowDelegations.objectType,
        startsAt: hrWorkflowDelegations.startsAt,
        endsAt: hrWorkflowDelegations.endsAt,
        reason: hrWorkflowDelegations.reason,
        active: hrWorkflowDelegations.active,
        createdAt: hrWorkflowDelegations.createdAt,
        delegateName: users.name,
        delegateEmail: users.email,
      })
      .from(hrWorkflowDelegations)
      .leftJoin(users, eq(users.id, hrWorkflowDelegations.delegateUserId))
      .where(and(
        eq(hrWorkflowDelegations.orgId, u.orgId),
        eq(hrWorkflowDelegations.delegatorMembershipId, membershipId),
      ))
      .orderBy(desc(hrWorkflowDelegations.createdAt))
      .limit(50);
  }

  async orgDelegations(orgId: string) {
    return this.db
      .select({
        id: hrWorkflowDelegations.id,
        orgId: hrWorkflowDelegations.orgId,
        delegatorUserId: hrWorkflowDelegations.delegatorUserId,
        delegateUserId: hrWorkflowDelegations.delegateUserId,
        objectType: hrWorkflowDelegations.objectType,
        startsAt: hrWorkflowDelegations.startsAt,
        endsAt: hrWorkflowDelegations.endsAt,
        reason: hrWorkflowDelegations.reason,
        active: hrWorkflowDelegations.active,
        createdAt: hrWorkflowDelegations.createdAt,
        delegateName: users.name,
        delegateEmail: users.email,
      })
      .from(hrWorkflowDelegations)
      .leftJoin(users, eq(users.id, hrWorkflowDelegations.delegateUserId))
      .where(eq(hrWorkflowDelegations.orgId, orgId))
      .orderBy(desc(hrWorkflowDelegations.createdAt))
      .limit(100);
  }

  async create(u: CurrentUserContext, dto: CreateDelegationDto) {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);

    if (endsAt <= startsAt) throw new BadRequestException("endsAt must be after startsAt");
    if (dto.delegateUserId === u.userId) throw new BadRequestException("Cannot delegate to yourself");

    const delegatorMembershipId = actingMembershipId(u.principal);
    if (delegatorMembershipId == null) throw new ForbiddenException("Organization membership required.");
    const delegateMembershipId = await requireOrganizationMembershipId(this.db, u.orgId, dto.delegateUserId);
    if (delegateMembershipId === delegatorMembershipId) {
      throw new BadRequestException("Cannot delegate to yourself");
    }
    const [delegation] = await this.db.insert(hrWorkflowDelegations).values({
      orgId: u.orgId,
      delegatorUserId: u.userId,
      delegatorMembershipId,
      delegateUserId: dto.delegateUserId,
      delegateMembershipId,
      objectType: dto.objectType ?? null,
      startsAt,
      endsAt,
      reason: dto.reason ?? null,
      active: true,
    }).returning();

    return delegation;
  }

  async update(u: CurrentUserContext, id: number, dto: UpdateDelegationDto) {
    const membershipId = actingMembershipId(u.principal);
    if (membershipId == null) throw new ForbiddenException("Organization membership required.");
    const [existing] = await this.db.select()
      .from(hrWorkflowDelegations)
      .where(and(
        eq(hrWorkflowDelegations.id, id),
        eq(hrWorkflowDelegations.orgId, u.orgId),
        eq(hrWorkflowDelegations.delegatorMembershipId, membershipId),
      ))
      .limit(1);

    if (!existing) throw new NotFoundException("Delegation not found");

    const updates: Partial<typeof hrWorkflowDelegations.$inferInsert> = {};
    if (dto.active !== undefined) updates.active = dto.active;
    if (dto.endsAt !== undefined) updates.endsAt = new Date(dto.endsAt);
    if (dto.reason !== undefined) updates.reason = dto.reason;

    const [updated] = await this.db.update(hrWorkflowDelegations)
      .set(updates)
      .where(and(
        eq(hrWorkflowDelegations.id, id),
        eq(hrWorkflowDelegations.orgId, u.orgId),
        eq(hrWorkflowDelegations.delegatorMembershipId, membershipId),
      ))
      .returning();

    return updated;
  }

  async remove(u: CurrentUserContext, id: number) {
    const membershipId = actingMembershipId(u.principal);
    if (membershipId == null) throw new ForbiddenException("Organization membership required.");
    const [existing] = await this.db.select()
      .from(hrWorkflowDelegations)
      .where(and(
        eq(hrWorkflowDelegations.id, id),
        eq(hrWorkflowDelegations.orgId, u.orgId),
        eq(hrWorkflowDelegations.delegatorMembershipId, membershipId),
      ))
      .limit(1);

    if (!existing) throw new NotFoundException("Delegation not found");

    await this.db.update(hrWorkflowDelegations)
      .set({ active: false })
      .where(and(
        eq(hrWorkflowDelegations.id, id),
        eq(hrWorkflowDelegations.orgId, u.orgId),
        eq(hrWorkflowDelegations.delegatorMembershipId, membershipId),
      ));
  }
}
