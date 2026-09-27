import { UnprocessableEntityException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import { ProjectsAutomationsService } from "./projects-automations.service";
import type { CreateAutomationInput } from "../dto/automation.schemas";

const VALID_CREATE: CreateAutomationInput = {
  name: "Auto",
  triggerEvent: "ticket.created",
  conditions: [],
  actions: [{ type: "set_status", value: "IN_PROGRESS" }],
  isActive: true,
};

const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } as never;
const members = {
  assertProjectAccess: jest.fn().mockResolvedValue(undefined),
  assertCanManageProject: jest.fn().mockResolvedValue(undefined),
} as never;

function makeDb(existingStatusNames: string[]) {
  const statusRows = existingStatusNames.map((name) => ({ name }));
  const where = jest.fn().mockResolvedValue(statusRows);
  const from = jest.fn().mockReturnValue({ where });
  const insertReturning = jest.fn().mockResolvedValue([{ id: 1, ...VALID_CREATE }]);
  const insertValues = jest.fn().mockReturnValue({ returning: insertReturning });
  const insert = jest.fn().mockReturnValue({ values: insertValues });
  const updateReturning = jest.fn().mockResolvedValue([{ id: 1 }]);
  const updateWhere = jest.fn().mockReturnValue({ returning: updateReturning });
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  const update = jest.fn().mockReturnValue({ set: updateSet });
  const db = { select: jest.fn().mockReturnValue({ from }), insert, update } as unknown as Db;
  return { db, where };
}

describe("ProjectsAutomationsService — set_status config-time validation", () => {
  const u = { orgId: "org-1", userId: "u1" } as never;

  it("accepts a set_status action when the status exists in the project", async () => {
    const { db } = makeDb(["IN_PROGRESS", "TODO", "DONE"]);
    const svc = new ProjectsAutomationsService(db, planLimits, members);

    await expect(svc.createAutomation(u, 1, VALID_CREATE)).resolves.toBeDefined();
  });

  it("rejects a set_status action with 422 when the status does not exist in the project", async () => {
    const { db } = makeDb(["TODO", "DONE"]);
    const svc = new ProjectsAutomationsService(db, planLimits, members);

    await expect(
      svc.createAutomation(u, 1, { ...VALID_CREATE, actions: [{ type: "set_status", value: "MISSING" }] }),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it("names the missing status in the rejection message", async () => {
    const { db } = makeDb(["TODO"]);
    const svc = new ProjectsAutomationsService(db, planLimits, members);

    await expect(
      svc.createAutomation(u, 1, { ...VALID_CREATE, actions: [{ type: "set_status", value: "GHOST" }] }),
    ).rejects.toThrow(/GHOST/);
  });

  it("rejects an update that introduces an invalid set_status value", async () => {
    const { db } = makeDb(["TODO"]);
    const svc = new ProjectsAutomationsService(db, planLimits, members);

    await expect(
      svc.updateAutomation(u, 1, 99, { actions: [{ type: "set_status", value: "NOWHERE" }] }),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it("does not query project_statuses when the update carries no set_status actions", async () => {
    const { db, where } = makeDb([]);
    const svc = new ProjectsAutomationsService(db, planLimits, members);

    await svc.updateAutomation(u, 1, 99, { actions: [{ type: "set_priority", value: "HIGH" }] });

    expect(where).not.toHaveBeenCalled();
  });
});
