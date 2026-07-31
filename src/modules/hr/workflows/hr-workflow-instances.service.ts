import { Inject, Injectable } from "@nestjs/common";
import { and, eq, desc, inArray, lte, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrWorkflowInstances,
  hrWorkflowStepActions,
  hrWorkflowDelegations,
} from "../../../db/schema/hr/workflow-engine";
import { users, organizationMembers } from "../../../db/schema/common/auth";
import { orgUnits } from "../../../db/schema/common/organization";
import type { WorkflowInstanceQueryDto } from "./dto/workflow.schemas";
import { HrWorkflowEngineService } from "./hr-workflow-engine.service";
import { AccessService } from "../../access/access.service";

interface ResolvedStep {
  stepOrder: number;
  approverType: string;
  approverValue?: string | null;
}

@Injectable()
export class HrWorkflowInstancesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly engine: HrWorkflowEngineService,
    private readonly access: AccessService,
  ) {}

  async listForDefinition(
    orgId: string,
    definitionId: number,
    query: WorkflowInstanceQueryDto,
  ) {
    const conditions = [
      eq(hrWorkflowInstances.orgId, orgId),
      eq(hrWorkflowInstances.definitionId, definitionId),
    ];

    if (query.status)
      conditions.push(eq(hrWorkflowInstances.status, query.status));
    if (query.objectType)
      conditions.push(eq(hrWorkflowInstances.objectType, query.objectType));

    const offset = (query.page - 1) * query.limit;

    const rows = await this.db
      .select()
      .from(hrWorkflowInstances)
      .where(and(...conditions))
      .orderBy(desc(hrWorkflowInstances.createdAt))
      .limit(query.limit)
      .offset(offset);

    return { data: rows, page: query.page, limit: query.limit };
  }

  async listAll(orgId: string, query: WorkflowInstanceQueryDto) {
    const conditions = [eq(hrWorkflowInstances.orgId, orgId)];

    if (query.status)
      conditions.push(eq(hrWorkflowInstances.status, query.status));
    if (query.objectType)
      conditions.push(eq(hrWorkflowInstances.objectType, query.objectType));

    const offset = (query.page - 1) * query.limit;

    const rows = await this.db
      .select({
        id: hrWorkflowInstances.id,
        orgId: hrWorkflowInstances.orgId,
        definitionId: hrWorkflowInstances.definitionId,
        objectType: hrWorkflowInstances.objectType,
        objectId: hrWorkflowInstances.objectId,
        requestedBy: hrWorkflowInstances.requestedBy,
        subjectEmployeeId: hrWorkflowInstances.subjectEmployeeId,
        status: hrWorkflowInstances.status,
        currentStepOrder: hrWorkflowInstances.currentStepOrder,
        dueAt: hrWorkflowInstances.dueAt,
        createdAt: hrWorkflowInstances.createdAt,
        updatedAt: hrWorkflowInstances.updatedAt,
        requesterName: users.name,
        requesterEmail: users.email,
      })
      .from(hrWorkflowInstances)
      .innerJoin(users, eq(users.id, hrWorkflowInstances.requestedBy))
      .where(and(...conditions))
      .orderBy(desc(hrWorkflowInstances.createdAt))
      .limit(query.limit)
      .offset(offset);

    return { data: rows, page: query.page, limit: query.limit };
  }

  async getDetail(orgId: string, instanceId: number) {
    const { instance, actions } = await this.engine.getInstanceTimeline(
      orgId,
      instanceId,
    );

    const userIds = [
      ...new Set([
        instance.requestedBy,
        instance.subjectEmployeeId,
        ...actions.map((a) => a.approverUserId),
        ...actions.map((a) => a.actedByUserId),
      ]),
    ];

    const resolvedUsers = await this.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(users)
      .where(inArray(users.id, userIds));

    const userMap = Object.fromEntries(resolvedUsers.map((u) => [u.id, u]));

    return {
      ...instance,
      requester: userMap[instance.requestedBy],
      subjectEmployee: userMap[instance.subjectEmployeeId],
      timeline: actions.map((a) => ({
        ...a,
        approver: userMap[a.approverUserId],
        actedBy: userMap[a.actedByUserId],
      })),
    };
  }

  async getMyActed(orgId: string, userId: string, page: number, limit: number) {
    const offset = (page - 1) * limit;

    const distinctRows = await this.db
      .selectDistinct({ instanceId: hrWorkflowStepActions.instanceId })
      .from(hrWorkflowStepActions)
      .where(
        and(
          eq(hrWorkflowStepActions.orgId, orgId),
          eq(hrWorkflowStepActions.actedByUserId, userId),
          inArray(hrWorkflowStepActions.action, ["approved", "rejected"]),
        ),
      )
      .orderBy(hrWorkflowStepActions.instanceId)
      .limit(limit)
      .offset(offset);

    const instanceIds = distinctRows.map((r) => r.instanceId);
    if (instanceIds.length === 0) return { data: [], page, limit, total: 0 };

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(hrWorkflowInstances)
        .where(
          and(
            eq(hrWorkflowInstances.orgId, orgId),
            inArray(hrWorkflowInstances.id, instanceIds),
          ),
        )
        .orderBy(desc(hrWorkflowInstances.updatedAt)),
      this.db
        .select({
          total: sql<number>`count(distinct ${hrWorkflowStepActions.instanceId})::int`,
        })
        .from(hrWorkflowStepActions)
        .where(
          and(
            eq(hrWorkflowStepActions.orgId, orgId),
            eq(hrWorkflowStepActions.actedByUserId, userId),
            inArray(hrWorkflowStepActions.action, ["approved", "rejected"]),
          ),
        ),
    ]);

    return { data: rows, page, limit, total: total ?? 0 };
  }

  async getInbox(orgId: string, userId: string, page: number, limit: number) {
    const now = new Date();
    const delegations = await this.db
      .select({
        delegatorUserId: hrWorkflowDelegations.delegatorUserId,
        endsAt: hrWorkflowDelegations.endsAt,
      })
      .from(hrWorkflowDelegations)
      .where(
        and(
          eq(hrWorkflowDelegations.orgId, orgId),
          eq(hrWorkflowDelegations.delegateUserId, userId),
          eq(hrWorkflowDelegations.active, true),
          lte(hrWorkflowDelegations.startsAt, now),
        ),
      )
      .limit(50);

    const allUserIds = [
      userId,
      ...delegations
        .filter((d) => d.endsAt >= now)
        .map((d) => d.delegatorUserId),
    ];

    const candidates = await this.db
      .select({
        id: hrWorkflowInstances.id,
        orgId: hrWorkflowInstances.orgId,
        definitionId: hrWorkflowInstances.definitionId,
        objectType: hrWorkflowInstances.objectType,
        objectId: hrWorkflowInstances.objectId,
        requestedBy: hrWorkflowInstances.requestedBy,
        subjectEmployeeId: hrWorkflowInstances.subjectEmployeeId,
        context: hrWorkflowInstances.context,
        status: hrWorkflowInstances.status,
        currentStepOrder: hrWorkflowInstances.currentStepOrder,
        dueAt: hrWorkflowInstances.dueAt,
        createdAt: hrWorkflowInstances.createdAt,
        updatedAt: hrWorkflowInstances.updatedAt,
        definitionSnapshot: hrWorkflowInstances.definitionSnapshot,
      })
      .from(hrWorkflowInstances)
      .where(
        and(
          eq(hrWorkflowInstances.orgId, orgId),
          or(
            eq(hrWorkflowInstances.status, "in_progress"),
            eq(hrWorkflowInstances.status, "pending"),
          ),
        ),
      )
      .orderBy(desc(hrWorkflowInstances.createdAt))
      .limit(limit * 5);

    const cache = await this.buildApproverCache(
      orgId,
      candidates.map((i) => i.subjectEmployeeId),
    );

    const myInstances: (typeof candidates)[number][] = [];
    for (const instance of candidates) {
      const steps = (instance.definitionSnapshot as { steps: ResolvedStep[] })
        .steps;
      const currentStep = steps.find(
        (s) => s.stepOrder === instance.currentStepOrder,
      );
      if (!currentStep) continue;
      const approvers = this.resolveApproversFromCache(
        currentStep,
        instance.subjectEmployeeId,
        cache,
      );
      if (approvers.some((id) => allUserIds.includes(id)))
        myInstances.push(instance);
      if (myInstances.length >= limit * page) break;
    }

    const offset = (page - 1) * limit;
    return {
      data: myInstances.slice(offset, offset + limit),
      total: myInstances.length,
      page,
      limit,
    };
  }

  private async buildApproverCache(orgId: string, subjectIds: string[]) {
    const uniqueSubjectIds = [...new Set(subjectIds)];

    const [subjectRows, hrApprovers, financeApprovers] = await Promise.all([
      uniqueSubjectIds.length > 0
        ? this.db
            .select({
              id: users.id,
              reportingTo: users.reportingTo,
              orgDepartmentId: users.orgDepartmentId,
              branchId: users.branchId,
            })
            .from(users)
            .innerJoin(
              organizationMembers,
              and(
                eq(organizationMembers.userId, users.id),
                eq(organizationMembers.orgId, orgId),
              ),
            )
            .where(inArray(users.id, uniqueSubjectIds))
        : Promise.resolve([]),
      this.access.membersWithPermission(orgId, "hr:leaves:approve"),
      this.access.membersWithPermission(orgId, "accounting:approvals:decide"),
    ]);

    const hrUserIds = hrApprovers.map((m) => m.userId);

    const subjectMap = new Map(subjectRows.map((u) => [u.id, u]));
    const managerIds = [
      ...new Set(
        subjectRows
          .map((u) => u.reportingTo)
          .filter((id): id is string => id !== null && id !== undefined),
      ),
    ];
    const deptIds = [
      ...new Set(
        subjectRows
          .map((u) => u.orgDepartmentId)
          .filter((id): id is string => id !== null && id !== undefined),
      ),
    ];
    const branchIds = [
      ...new Set(
        subjectRows
          .map((u) => u.branchId)
          .filter((id): id is string => id !== null && id !== undefined),
      ),
    ];

    const [managerRows, deptRows, locationHrRows] = await Promise.all([
      managerIds.length > 0
        ? this.db
            .select({ id: users.id, reportingTo: users.reportingTo })
            .from(users)
            .where(inArray(users.id, managerIds))
        : Promise.resolve([]),
      deptIds.length > 0
        ? this.db
            .select({ id: orgUnits.id, managerId: orgUnits.headUserId })
            .from(orgUnits)
            .where(inArray(orgUnits.id, deptIds))
        : Promise.resolve([]),
      branchIds.length > 0 && hrUserIds.length > 0
        ? this.db
            .select({ id: users.id, branchId: users.branchId })
            .from(users)
            .where(
              and(
                inArray(users.id, hrUserIds),
                inArray(users.branchId, branchIds),
              ),
            )
            .limit(branchIds.length * 10)
        : Promise.resolve([]),
    ]);

    const locationHrMap = new Map<string, string[]>();
    for (const row of locationHrRows) {
      if (row.branchId === null || row.branchId === undefined) continue;
      const existing = locationHrMap.get(row.branchId);
      if (existing) {
        existing.push(row.id);
      } else {
        locationHrMap.set(row.branchId, [row.id]);
      }
    }

    return {
      subjectMap,
      managerMap: new Map(managerRows.map((u) => [u.id, u])),
      deptMap: new Map(deptRows.map((d) => [d.id, d])),
      locationHrMap,
      hrUserIds,
      financeUserIds: financeApprovers.map((m) => m.userId),
    };
  }

  private resolveApproversFromCache(
    step: ResolvedStep,
    subjectEmployeeId: string,
    cache: Awaited<ReturnType<typeof this.buildApproverCache>>,
  ): string[] {
    switch (step.approverType) {
      case "named_user":
        return step.approverValue ? [step.approverValue] : [];
      case "direct_manager": {
        const reportingTo =
          cache.subjectMap.get(subjectEmployeeId)?.reportingTo;
        return reportingTo ? [reportingTo] : [];
      }
      case "managers_manager": {
        const mgr = cache.subjectMap.get(subjectEmployeeId)?.reportingTo;
        if (!mgr) return [];
        const mm = cache.managerMap.get(mgr)?.reportingTo;
        return mm ? [mm] : [];
      }
      case "department_head": {
        const deptId = cache.subjectMap.get(subjectEmployeeId)?.orgDepartmentId;
        if (!deptId) return [];
        const managerId = cache.deptMap.get(deptId)?.managerId;
        return managerId ? [managerId] : [];
      }
      case "hr_role":
        return cache.hrUserIds;
      case "finance_role":
        return cache.financeUserIds;
      case "location_hr": {
        const branchId = cache.subjectMap.get(subjectEmployeeId)?.branchId;
        if (!branchId) return [];
        return cache.locationHrMap.get(branchId) ?? [];
      }
      default:
        return [];
    }
  }
}
