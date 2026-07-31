export const HR_WORKFLOW_STARTER = "HR_WORKFLOW_STARTER";

export interface HrWorkflowStarterPort {
  startWorkflow(orgId: string, workflowId: string, context: Record<string, unknown>): Promise<{ executionId: string } | null>;
}

export const nopHrWorkflowStarter: HrWorkflowStarterPort = {
  async startWorkflow(_, __, ___) {
    return null;
  },
};
