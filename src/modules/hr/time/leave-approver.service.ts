import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { organizationMembers, users } from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";

const LEAVE_APPROVE_PERMISSION = "hr:leaves:approve";
const APPROVER_CANDIDATE_LIMIT = 100;

export interface LeaveApprover {
  id: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string;
  image: string | null;
  designation: string | null;
}

/**
 * Resolves one deterministic approver on the server. The direct manager is
 * preferred, then permission holders are considered in membership order. A
 * candidate's effective AccessService scope must include the subject.
 */
@Injectable()
export class LeaveApproverService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async resolve(
    orgId: string,
    subjectUserId: string,
  ): Promise<LeaveApprover | null> {
    const [subject] = await this.db
      .select({ reportingTo: users.reportingTo })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, subjectUserId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      )
      .limit(1);
    if (!subject) return null;

    const holders = await this.access.membersWithPermission(
      orgId,
      LEAVE_APPROVE_PERMISSION,
      { limit: APPROVER_CANDIDATE_LIMIT },
    );
    const candidateIds = [
      ...(subject.reportingTo ? [subject.reportingTo] : []),
      ...holders.map((holder) => holder.userId),
    ];

    for (const candidateId of new Set(candidateIds)) {
      if (candidateId === subjectUserId) continue;
      const permissions = await this.access.resolveUserPermissions(
        orgId,
        candidateId,
      );
      const scope = permissions.get(LEAVE_APPROVE_PERMISSION) ?? "none";
      if (!(await this.includesSubject(scope, orgId, candidateId, subjectUserId))) {
        continue;
      }

      const [candidate] = await this.db
        .select({
          id: users.id,
          name: users.name,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          image: users.image,
          designation: users.designation,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.userId, candidateId),
            eq(organizationMembers.status, "ACTIVE"),
          ),
        )
        .limit(1);
      if (candidate) return candidate;
    }

    return null;
  }

  private async includesSubject(
    scope: DataScope,
    orgId: string,
    candidateId: string,
    subjectUserId: string,
  ): Promise<boolean> {
    if (scope === "all") return true;
    if (scope === "none" || scope === "own") return false;

    const [visible] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, subjectUserId),
          eq(organizationMembers.status, "ACTIVE"),
          applyScope(scope, orgId, candidateId, {
            ownerColumn: organizationMembers.userId,
          }),
        ),
      )
      .limit(1);
    return Boolean(visible);
  }
}
