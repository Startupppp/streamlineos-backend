import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { organizationMembers, projects, users } from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { ApprovalAuthorityService } from "../../directory/approval-authority.service";
import type { ApprovalRung } from "../../directory/approval-authority.types";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import { ReportingLineService } from "../../directory/reporting-line.service";
import {
  decideTimesheetRoute,
  dominantProjectId,
  type DominantProjectManager,
  type TimesheetRoutingDecision,
  type TimesheetRoutingSettings,
} from "./lib/approval-routing";
import { TS_APPROVALS_MANAGE_PERMISSION } from "./timesheets-core-scope";

export interface TimesheetRoutingInput {
  orgId: string;
  subjectUserId: string;
  entries: ReadonlyArray<{ projectId: number | null }>;
  settings: TimesheetRoutingSettings;
  from?: ApprovalRung;
  at?: Date;
}

@Injectable()
export class TimesheetApprovalRoutingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly approvals: ApprovalAuthorityService,
    private readonly employment: EmploymentFactsService,
    private readonly reportingLines: ReportingLineService,
  ) {}

  async resolve(input: TimesheetRoutingInput): Promise<TimesheetRoutingDecision> {
    const at = input.at ?? new Date();
    const projectId = dominantProjectId(input.entries);
    const [chain, project] = await Promise.all([
      this.approvals.resolve(input.orgId, input.subjectUserId, "timesheet", { at, from: input.from }),
      projectId === null ? Promise.resolve(null) : this.dominantProjectManager(input.orgId, input.subjectUserId, projectId),
    ]);
    return decideTimesheetRoute(input.settings, chain, project, at);
  }

  private async dominantProjectManager(orgId: string, subjectUserId: string, projectId: number): Promise<DominantProjectManager | null> {
    const [project] = await this.db
      .select({
        id: projects.id,
        name: projects.name,
        managerUserId: organizationMembers.userId,
        managerMembershipId: organizationMembers.id,
        managerName: users.name,
        managerEmail: users.email,
      })
      .from(projects)
      .leftJoin(
        organizationMembers,
        and(eq(organizationMembers.id, projects.managerMembershipId), eq(organizationMembers.orgId, projects.orgId), eq(organizationMembers.status, "ACTIVE")),
      )
      .leftJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)))
      .limit(1);
    if (!project) return null;
    if (project.managerUserId === null || project.managerMembershipId === null || project.managerEmail === null)
      return { projectId: project.id, projectName: project.name, manager: null, unusable: "unassigned" };
    const manager = {
      userId: project.managerUserId,
      membershipId: project.managerMembershipId,
      name: project.managerName,
      email: project.managerEmail,
      designation: (await this.employment.getFacts(orgId, project.managerUserId)).designation,
    };
    if (manager.userId === subjectUserId) return { projectId: project.id, projectName: project.name, manager, unusable: "self" };
    const live = await this.reportingLines.checkManager(orgId, manager.userId);
    if (!live.ok) return { projectId: project.id, projectName: project.name, manager, unusable: "not-live" };
    const scope = (await this.access.resolveUserPermissions(orgId, manager.userId)).get(TS_APPROVALS_MANAGE_PERMISSION);
    if (scope === undefined || scope === "none")
      return { projectId: project.id, projectName: project.name, manager, unusable: "lacks-permission" };
    return { projectId: project.id, projectName: project.name, manager, unusable: null };
  }
}
