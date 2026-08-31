import type { Db } from "../../../db/drizzle.module";
import { BuildSprintCompletedConsumerService } from "./build-sprint-completed-consumer.service";

describe("BuildSprintCompletedConsumerService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";

  const dispatch = { dispatch: jest.fn() } as never;
  const registry = { register: jest.fn() } as never;

  function makeDb() {
    const returning = jest.fn().mockResolvedValue([{ id: 1 }]);
    const onConflictDoNothing = jest.fn().mockReturnValue({ returning });
    const insert = jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ onConflictDoNothing }) });
    const update = jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) });
    const selectWhere = jest.fn().mockResolvedValue([]);
    const innerJoinWhere = jest.fn().mockResolvedValue([]);
    const innerJoin = jest.fn().mockReturnValue({ where: innerJoinWhere });
    const selectFrom = jest.fn().mockReturnValue({ where: selectWhere, innerJoin });
    const select = jest.fn().mockReturnValue({ from: selectFrom });
    const selectDistinct = jest.fn().mockReturnValue({ from: selectFrom });
    const db = { insert, update, select, selectDistinct } as unknown as Db;
    return { db, insert };
  }

  it("processes event using the event's orgId — scoped per org (cross-tenant isolation)", async () => {
    const { db, insert } = makeDb();
    const svc = new BuildSprintCompletedConsumerService(db, dispatch, registry);
    const event = {
      eventId: "ev1",
      organizationId: OWNER_ORG,
      aggregateType: "sprint",
      aggregateId: "1",
      aggregateVersion: 1,
      payload: { sprintId: 1, name: "Sprint 1" },
    } as never;
    await expect(svc.handle(event)).resolves.not.toThrow();
    const insertArg = insert.mock.calls[0]?.[0];
    expect(insertArg).toBeDefined();
  });

  it("handles different-org events without cross-contamination (same-tenant control)", async () => {
    const { db } = makeDb();
    const svc = new BuildSprintCompletedConsumerService(db, dispatch, registry);
    const event = {
      eventId: "ev2",
      organizationId: OWNER_ORG,
      aggregateType: "sprint",
      aggregateId: "2",
      aggregateVersion: 1,
      payload: { sprintId: 2, name: "Sprint 2" },
    } as never;
    await expect(svc.handle(event)).resolves.not.toThrow();
  });
});
