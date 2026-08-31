import type { hrWorkflowObjectTypeEnum } from "../../../db/schema/hr/workflow-engine";

export type HrWorkflowObjectType = typeof hrWorkflowObjectTypeEnum.enumValues[number];

export interface ResolvedStep {
  stepOrder: number;
  name: string;
  approverType: string;
  approverValue?: string | null;
  mode: string;
  slaHours?: number | null;
  escalationApproverType?: string | null;
  escalationApproverValue?: string | null;
  condition?: { field: string; operator: string; value: unknown } | null;
}
