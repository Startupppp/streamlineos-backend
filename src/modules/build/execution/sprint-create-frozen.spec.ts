import { GoneException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { SprintsService } from "./sprints.service";

const ORG = "org-1";
const PROJECT_ID = 42;
const SPRINT_ID = 7;
const CREATE_INPUT = { name: "Sprint Q4", startDate: "2026-10-01", endDate: "2026-10-14" };
const UPDATE_INPUT = { name: "Changed", startDate: undefined, endDate: undefined };

function trackingDb() {
  const calls = {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    sprintsFindFirst: jest.fn(),
    sprintsFindMany: jest.fn(),
    ticketsFindMany: jest.fn(),
  };
  const db = {
    select: calls.select,
    insert: calls.insert,
    update: calls.update,
    delete: calls.delete,
    transaction: calls.transaction,
    query: {
      sprints: { findFirst: calls.sprintsFindFirst, findMany: calls.sprintsFindMany },
      tickets: { findMany: calls.ticketsFindMany },
      projects: { findFirst: jest.fn() },
    },
  } as unknown as Db;
  return { db, calls };
}

function invoke(svc: SprintsService, method: string): Promise<unknown> {
  switch (method) {
    case "listSprints":
      return svc.listSprints(ORG, PROJECT_ID);
    case "createSprint":
      return svc.createSprint(ORG, PROJECT_ID, CREATE_INPUT);
    case "getSprint":
      return svc.getSprint(ORG, PROJECT_ID, SPRINT_ID);
    case "updateSprint":
      return svc.updateSprint(ORG, PROJECT_ID, SPRINT_ID, UPDATE_INPUT, "user-1");
    case "deleteSprint":
      return svc.deleteSprint(ORG, PROJECT_ID, SPRINT_ID);
    default:
      throw new Error(`unknown method ${method}`);
  }
}

const FROZEN_METHODS = ["listSprints", "createSprint", "getSprint", "updateSprint", "deleteSprint"];

describe("SprintsService — the whole legacy Sprints surface is frozen", () => {
  it.each(FROZEN_METHODS)("%s throws GoneException, because Cycles are the only iteration identity", async (method) => {
    const { db } = trackingDb();
    await expect(invoke(new SprintsService(db, null), method)).rejects.toThrow(GoneException);
  });

  it.each(FROZEN_METHODS)("%s points the caller at the cycles route so a client can migrate without reading the changelog", async (method) => {
    const { db } = trackingDb();
    await expect(invoke(new SprintsService(db, null), method)).rejects.toThrow(
      "Use /build/:projectId/cycles",
    );
  });

  it.each(FROZEN_METHODS)(
    "%s touches the database nowhere, which is the precondition a-sprint-cycle-05-drop.sql needs before it drops build.sprints",
    async (method) => {
      const { db, calls } = trackingDb();
      await expect(invoke(new SprintsService(db, null), method)).rejects.toThrow(GoneException);

      for (const [name, spy] of Object.entries(calls)) {
        expect([name, spy.mock.calls.length]).toEqual([name, 0]);
      }
    },
  );

  it.each(FROZEN_METHODS)("%s throws for every org, so no tenant can bypass the freeze", async (method) => {
    const { db } = trackingDb();
    const svc = new SprintsService(db, null);
    await expect(invoke(svc, method)).rejects.toThrow(GoneException);

    const attacker = new SprintsService(db, null);
    await expect(
      method === "listSprints"
        ? attacker.listSprints("org-attacker", PROJECT_ID)
        : method === "createSprint"
          ? attacker.createSprint("org-attacker", PROJECT_ID, CREATE_INPUT)
          : method === "getSprint"
            ? attacker.getSprint("org-attacker", PROJECT_ID, SPRINT_ID)
            : method === "updateSprint"
              ? attacker.updateSprint("org-attacker", PROJECT_ID, SPRINT_ID, UPDATE_INPUT)
              : attacker.deleteSprint("org-attacker", PROJECT_ID, SPRINT_ID),
    ).rejects.toThrow(GoneException);
  });

  it("the freeze covers every public method on the service, so a later addition cannot quietly reopen a write path", () => {
    const methods = Object.getOwnPropertyNames(SprintsService.prototype).filter((n) => n !== "constructor");
    expect([...methods].sort()).toEqual([...FROZEN_METHODS].sort());
  });

  it("emits no outbox event and needs no webhook dispatcher, because a frozen writer has no state change to announce", async () => {
    const { db } = trackingDb();
    const dispatch = { enqueue: jest.fn() };
    const svc = new SprintsService(db, dispatch as never);

    await expect(svc.updateSprint(ORG, PROJECT_ID, SPRINT_ID, { status: "COMPLETED", startDate: undefined, endDate: undefined })).rejects.toThrow(
      GoneException,
    );

    expect(dispatch.enqueue).not.toHaveBeenCalled();
  });
});
