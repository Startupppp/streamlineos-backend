import { makeFakeDb } from "../../../test/fake-select-db";
import type { Db } from "../../../db/drizzle.module";
import { HrSettingsHubService } from "./hr-settings-hub.service";

const ORG = "org-1";

function definition(overrides: Record<string, unknown>) {
  return {
    id: 1,
    org_id: ORG,
    name: "Leave approval",
    object_type: "leave",
    version: 1,
    status: "active",
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

describe("HR settings hub version lineage excludes soft-deleted rows", () => {
  it("getVersions('workflow') omits a soft-deleted workflow version", async () => {
    const db = makeFakeDb(
      {
        hr_workflow_definitions: [
          definition({ id: 1, version: 1 }),
          definition({ id: 2, version: 2, deleted_at: new Date() }),
        ],
      },
      { hrWorkflowDefinitions: "hr_workflow_definitions" },
    );
    const service = new HrSettingsHubService(db as unknown as Db, { evaluatePolicy: jest.fn() } as never);

    const lineage = await service.getVersions(ORG, "workflow", "1");

    expect(lineage.items.map((row) => row.id)).toEqual([1]);
  });

  it("getVersions('workflow') still returns live sibling versions", async () => {
    const db = makeFakeDb(
      {
        hr_workflow_definitions: [definition({ id: 1, version: 1 }), definition({ id: 2, version: 2 })],
      },
      { hrWorkflowDefinitions: "hr_workflow_definitions" },
    );
    const service = new HrSettingsHubService(db as unknown as Db, { evaluatePolicy: jest.fn() } as never);

    const lineage = await service.getVersions(ORG, "workflow", "1");

    expect(lineage.items.map((row) => row.id).sort()).toEqual([1, 2]);
  });
});
