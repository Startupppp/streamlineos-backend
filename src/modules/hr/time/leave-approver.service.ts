import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { organizationMembers, users } from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import { EmploymentFactsService } from "../../directory/employment-facts.service";

const LEAVE_APPROVE_PERMISSION = "hr:leaves:approve";
const APPROVER_CANDIDATE_LIMIT = 100;

/**
 * Only an `all` scope reaches a member other than the holder. `own` and `none`
 * exclude a different subject by definition, and `team` was resolved by a probe
 * that passed no team column, so `applyScope` degraded to `member.user_id =
 * candidate` and the surrounding WHERE already pinned `member.user_id = subject`
 * — a contradiction for every candidate the caller does not skip, and therefore
 * one guaranteed-empty round trip per candidate. Deciding what `team` should mean
 * for leave approval is a product question; running the query is not an answer.
 */
function coversAnotherMember(scope: DataScope): boolean {
  return scope === "all";
}

export interface LeaveApprover {
  id: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string;
  image: string | null;
  designation: string | null;
}

@Injectable()
export class LeaveApproverService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly employment: EmploymentFactsService,
  ) {}

  async resolve(
    orgId: string,
    subjectUserId: string,
  ): Promise<LeaveApprover | null> {
    const [memberCheck] = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, subjectUserId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      )
      .limit(1);
    if (!memberCheck) return null;

    const [subjectFacts, holders] = await Promise.all([
      this.employment.getFacts(orgId, subjectUserId),
      this.access.membersWithPermission(orgId, LEAVE_APPROVE_PERMISSION, { limit: APPROVER_CANDIDATE_LIMIT }),
    ]);

    const candidateIds = [
      ...(subjectFacts.managerUserId ? [subjectFacts.managerUserId] : []),
      ...holders.map((holder) => holder.userId),
    ];

    const uniqueCandidateIds = [...new Set(candidateIds)];
    if (uniqueCandidateIds.length === 0) return null;

    const [candidateFactsBatch, candidateRows] = await Promise.all([
      this.employment.getFactsBatch(orgId, uniqueCandidateIds),
      this.db
        .select({
          id: users.id,
          name: users.name,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          image: users.image,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            inArray(organizationMembers.userId, uniqueCandidateIds),
            eq(organizationMembers.status, "ACTIVE"),
          ),
        )
        .limit(uniqueCandidateIds.length),
    ]);

    const candidateById = new Map(candidateRows.map((row) => [row.id, row]));

    const idsToCheck = uniqueCandidateIds.filter(id => id !== subjectUserId);
    if (idsToCheck.length === 0) return null;

    const resolvedPermissions = new Map<string, Map<string, DataScope>>();
    await Promise.all(
      idsToCheck.map(async id => {
        resolvedPermissions.set(id, await this.access.resolveUserPermissions(orgId, id));
      }),
    );

    for (const candidateId of idsToCheck) {
      const permissions = resolvedPermissions.get(candidateId);
      if (!coversAnotherMember(permissions?.get(LEAVE_APPROVE_PERMISSION) ?? "none")) continue;

      const candidate = candidateById.get(candidateId);
      if (candidate) {
        const facts = candidateFactsBatch.get(candidateId);
        return { ...candidate, designation: facts?.designation ?? null };
      }
    }

    return null;
  }
}
