import { Inject, Injectable } from "@nestjs/common";
import { and, eq, desc, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { hrWorkflowInstances, hrWorkflowStepActions } from "../../db/schema/hr/workflow-engine";
import { users } from "../../db/schema/auth";
import type { WorkflowInstanceQueryDto } from "./dto/workflow.schemas";
import { HrWorkflowEngineService } from "./hr-workflow-engine.service";

@Injectable()
export class HrWorkflowInstancesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly engine: HrWorkflowEngineService,
  ) {}

  async listForDefinition(orgId: string, definitionId: number, query: WorkflowInstanceQueryDto) {
    const conditions = [
      eq(hrWorkflowInstances.orgId, orgId),
      eq(hrWorkflowInstances.definitionId, definitionId),
    ];

    if (query.status) conditions.push(eq(hrWorkflowInstances.status, query.status));
    if (query.objectType) conditions.push(eq(hrWorkflowInstances.objectType, query.objectType));

    const offset = (query.page - 1) * query.limit;

    const rows = await this.db.select()
      .from(hrWorkflowInstances)
      .where(and(...conditions))
      .orderBy(desc(hrWorkflowInstances.createdAt))
      .limit(query.limit)
      .offset(offset);

    return { data: rows, page: query.page, limit: query.limit };
  }

  async listAll(orgId: string, query: WorkflowInstanceQueryDto) {
    const conditions = [eq(hrWorkflowInstances.orgId, orgId)];

    if (query.status) conditions.push(eq(hrWorkflowInstances.status, query.status));
    if (query.objectType) conditions.push(eq(hrWorkflowInstances.objectType, query.objectType));

    const offset = (query.page - 1) * query.limit;

    const rows = await this.db.select({
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
    const { instance, actions } = await this.engine.getInstanceTimeline(orgId, instanceId);

    const userIds = [...new Set([
      instance.requestedBy,
      instance.subjectEmployeeId,
      ...actions.map((a) => a.approverUserId),
      ...actions.map((a) => a.actedByUserId),
    ])];

    const resolvedUsers = await this.db.select({
      id: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
      firstName: users.firstName,
      lastName: users.lastName,
    }).from(users).where(inArray(users.id, userIds));

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
    const myActions = await this.db.select({ instanceId: hrWorkflowStepActions.instanceId })
      .from(hrWorkflowStepActions)
      .where(and(
        eq(hrWorkflowStepActions.orgId, orgId),
        eq(hrWorkflowStepActions.actedByUserId, userId),
        inArray(hrWorkflowStepActions.action, ["approved", "rejected"]),
      ))
      .orderBy(desc(hrWorkflowStepActions.actedAt))
      .limit(200);

    const instanceIds = [...new Set(myActions.map((a) => a.instanceId))];
    if (instanceIds.length === 0) return { data: [], page, limit };

    const offset = (page - 1) * limit;
    const rows = await this.db.select()
      .from(hrWorkflowInstances)
      .where(and(
        eq(hrWorkflowInstances.orgId, orgId),
        inArray(hrWorkflowInstances.id, instanceIds.slice(offset, offset + limit)),
      ))
      .orderBy(desc(hrWorkflowInstances.updatedAt));

    return { data: rows, page, limit, total: instanceIds.length };
  }
}
