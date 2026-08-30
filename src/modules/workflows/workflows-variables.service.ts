import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { workflows, workflowVersions, workflowVariables } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

@Injectable()
export class WorkflowsVariablesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listGlobalVariables(orgId: string) {
    return this.db
      .select({
        id: workflowVariables.id,
        key: workflowVariables.key,
        valueType: workflowVariables.valueType,
        defaultValue: workflowVariables.defaultValue,
        workflowVersionId: workflowVariables.workflowVersionId,
        createdAt: workflowVariables.createdAt,
        workflowId: workflows.id,
        workflowName: workflows.name,
      })
      .from(workflowVariables)
      .innerJoin(
        workflowVersions,
        eq(workflowVariables.workflowVersionId, workflowVersions.id),
      )
      .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
      .where(eq(workflowVariables.orgId, orgId))
      .orderBy(desc(workflowVariables.createdAt));
  }

  async deleteGlobalVariable(orgId: string, variableId: string) {
    const existing = await this.db
      .select({ id: workflowVariables.id })
      .from(workflowVariables)
      .where(
        and(
          eq(workflowVariables.id, variableId),
          eq(workflowVariables.orgId, orgId),
        ),
      )
      .limit(1);
    if (!existing.length) throw new NotFoundException("Variable not found");
    await this.db
      .delete(workflowVariables)
      .where(
        and(
          eq(workflowVariables.id, variableId),
          eq(workflowVariables.orgId, orgId),
        ),
      );
  }
}
