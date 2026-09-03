import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { HrWorkflowInstancesService } from "src/modules/hr/workflows/hr-workflow-instances.service";
import type { Db } from "src/db/drizzle.module";
import type { WorkflowInstanceQueryDto } from "src/modules/hr/workflows/dto/workflow.schemas";

/**
 * `GET /hr/workflows/:workflowId/instances` — found by the live cross-tenant sweep at head, and
 * NOT in the previous run's pin file: it only became visible once the sweep could reach the route.
 *
 * `listForDefinition` filtered on `orgId` and on `definitionId` and never resolved the definition,
 * so another organisation's `:workflowId` returned an empty page with **200** — and so did an id
 * belonging to no organisation at all. Measured control 200 / cross-tenant 200 / absent 200, which
 * is the `NO-404` shape: nothing crossed, and the contract 404 was absent.
 */

const CALLER_ORG = "org-b-caller";
const FOREIGN_WORKFLOW_ID = 4242;
const QUERY = { limit: 20 } as unknown as WorkflowInstanceQueryDto;

function serviceSeeing(definition: { id: number } | undefined): {
  service: HrWorkflowInstancesService;
  instanceReads: () => number;
} {
  const state = { calls: 0, instanceReads: 0 };
  const db = {
    select: jest.fn().mockImplementation(() => {
      state.calls += 1;
      const first = state.calls === 1;
      if (!first) state.instanceReads += 1;
      return {
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(first ? (definition ? [definition] : []) : []),
            orderBy: () => ({ limit: () => Promise.resolve([]) }),
          }),
        }),
      };
    }),
  } as unknown as Db;
  const service = new HrWorkflowInstancesService(db, {} as never, {} as never, {} as never);
  return { service, instanceReads: () => state.instanceReads };
}

describe("BOLA probe — GET /hr/workflows/:workflowId/instances", () => {
  it("CROSS-TENANT-MISS: another organisation's workflow id is refused", async () => {
    const probe = serviceSeeing(undefined);
    await expect(
      probe.service.listForDefinition(CALLER_ORG, FOREIGN_WORKFLOW_ID, QUERY),
    ).rejects.toThrow(NotFoundException);
  });

  it("EXISTENCE-ORACLE-GUARD: the refusal is NotFound, never Forbidden", async () => {
    const probe = serviceSeeing(undefined);
    const thrown = await probe.service
      .listForDefinition(CALLER_ORG, FOREIGN_WORKFLOW_ID, QUERY)
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect(thrown).not.toBeInstanceOf(ForbiddenException);
  });

  it("NO-READ-ON-MISS: the instance page is never even queried for an unowned definition", async () => {
    const probe = serviceSeeing(undefined);
    await probe.service.listForDefinition(CALLER_ORG, FOREIGN_WORKFLOW_ID, QUERY).catch(() => undefined);
    expect(probe.instanceReads()).toEqual(0);
  });

  it("SAME-TENANT: the caller's own workflow still lists its instances", async () => {
    const probe = serviceSeeing({ id: FOREIGN_WORKFLOW_ID });
    await expect(
      probe.service.listForDefinition(CALLER_ORG, FOREIGN_WORKFLOW_ID, QUERY),
    ).resolves.toBeDefined();
    expect(probe.instanceReads()).toEqual(1);
  });
});
