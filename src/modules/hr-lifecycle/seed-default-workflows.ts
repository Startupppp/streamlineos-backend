import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { hrWorkflowDefinitions, hrWorkflowSteps } from "../../db/schema/hr/workflow-engine";

type WorkflowObjectType = "resignation" | "termination";

interface DefaultWorkflowSpec {
  objectType: WorkflowObjectType;
  name: string;
  steps: Array<{
    stepOrder: number;
    name: string;
    approverType: typeof hrWorkflowSteps.$inferInsert["approverType"];
    mode: typeof hrWorkflowSteps.$inferInsert["mode"];
  }>;
}

const DEFAULT_WORKFLOWS: DefaultWorkflowSpec[] = [
  {
    objectType: "resignation",
    name: "Default Resignation Approval",
    steps: [
      { stepOrder: 1, name: "HR Review", approverType: "hr_role", mode: "serial" },
      { stepOrder: 2, name: "Senior Approval", approverType: "department_head", mode: "serial" },
    ],
  },
  {
    objectType: "termination",
    name: "Default Termination Approval",
    steps: [
      { stepOrder: 1, name: "HR Review", approverType: "hr_role", mode: "serial" },
      { stepOrder: 2, name: "Senior Approval", approverType: "department_head", mode: "serial" },
    ],
  },
];

export async function seedDefaultWorkflows(db: Db, orgId: string): Promise<void> {
  for (const spec of DEFAULT_WORKFLOWS) {
    const existing = await db
      .select({ id: hrWorkflowDefinitions.id })
      .from(hrWorkflowDefinitions)
      .where(
        and(
          eq(hrWorkflowDefinitions.orgId, orgId),
          eq(hrWorkflowDefinitions.objectType, spec.objectType),
          eq(hrWorkflowDefinitions.isDefault, true),
          isNull(hrWorkflowDefinitions.deletedAt),
        ),
      )
      .limit(1);

    if (existing.length > 0) continue;

    const [definition] = await db
      .insert(hrWorkflowDefinitions)
      .values({
        orgId,
        objectType: spec.objectType,
        name: spec.name,
        status: "active",
        version: 1,
        isDefault: true,
        settings: {},
      })
      .returning();

    if (!definition) continue;

    await db.insert(hrWorkflowSteps).values(
      spec.steps.map((s) => ({
        definitionId: definition.id,
        stepOrder: s.stepOrder,
        name: s.name,
        approverType: s.approverType,
        mode: s.mode,
        approverValue: null,
        slaHours: null,
        escalationApproverType: null,
        escalationApproverValue: null,
        condition: null,
      })),
    );
  }
}
