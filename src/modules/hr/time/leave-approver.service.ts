import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { organizationMembers, users } from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import type { ScopedRead } from "../../access/scoped-read";
import { leaveApproverRead } from "./leaves-scope";
import { EmploymentFactsService } from "../../directory/employment-facts.service";

const LEAVE_APPROVE_PERMISSION = "hr:leaves:approve";
const APPROVER_CANDIDATE_LIMIT = 100;

function coversAnotherMember(read: ScopedRead): boolean {
  return read.unrestricted;
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
      this.access.membersWithPermission(orgId, LEAVE_APPROVE_PERMISSION, {
        limit: APPROVER_CANDIDATE_LIMIT,
      }),
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

    const idsToCheck = uniqueCandidateIds.filter((id) => id !== subjectUserId);
    if (idsToCheck.length === 0) return null;

    for (const candidateId of idsToCheck) {
      const permissions = await this.access.resolveUserPermissions(
        orgId,
        candidateId,
      );
      if (
        !coversAnotherMember(leaveApproverRead(orgId, candidateId, permissions))
      )
        continue;

      const candidate = candidateById.get(candidateId);
      if (candidate) {
        const facts = candidateFactsBatch.get(candidateId);
        return { ...candidate, designation: facts?.designation ?? null };
      }
    }

    return null;
  }
}
