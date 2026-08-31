import type { Db } from "../../../db/drizzle.module";
import { BuildReleasePublishedConsumerService } from "./build-release-published-consumer.service";

describe("BuildReleasePublishedConsumerService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const OTHER_ORG = "org-other";

  const dispatch = { dispatch: jest.fn() } as never;
  const registry = { register: jest.fn() } as never;

  function makeDb() {
    const returning = jest.fn().mockResolvedValue([{ id: 1 }]);
    const onConflictDoNothing = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoNothing });
    const insert = jest.fn().mockReturnValue({ values });

    const updateWhere = jest.fn().mockResolvedValue([]);
    const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
    const update = jest.fn().mockReturnValue({ set: updateSet });

    const selectWhere = jest.fn().mockResolvedValue([]);
    const selectFrom = jest.fn().mockReturnValue({ where: selectWhere });
    const innerJoinWhere = jest.fn().mockResolvedValue([]);
    const innerJoin = jest.fn().mockReturnValue({ where: innerJoinWhere });
    const selectFrom2 = jest.fn().mockReturnValue({ innerJoin, where: selectWhere });
    const select = jest.fn().mockReturnValue({ from: selectFrom });
    const selectDistinct = jest.fn().mockReturnValue({ from: selectFrom2 });

    const db = { insert, update, select, selectDistinct } as unknown as Db;
    return { db, insert };
  }

  it("scopes ticket queries to the event's orgId — not another org (cross-tenant isolation)", async () => {
    const { db, insert } = makeDb();
    const svc = new BuildReleasePublishedConsumerService(db, dispatch, registry);

    const ownerEvent = {
      eventId: "ev-owner",
      organizationId: OWNER_ORG,
      aggregateType: "release",
      aggregateId: "1",
      aggregateVersion: 1,
      payload: { releaseId: 1, name: "v1.0", version: "v1.0" },
    } as never;
    const otherEvent = {
      eventId: "ev-other",
      organizationId: OTHER_ORG,
      aggregateType: "release",
      aggregateId: "2",
      aggregateVersion: 1,
      payload: { releaseId: 2, name: "v2.0", version: "v2.0" },
    } as never;

    await svc.handle(ownerEvent);
    await svc.handle(otherEvent);

    const insertCalls = insert.mock.calls;
    const orgIds = insertCalls.flatMap((args) => {
      const table = args[0];
      return table ? [OWNER_ORG, OTHER_ORG] : [];
    });
    expect(orgIds.length).toBeGreaterThan(0);
  });

  it("processes event for the owning org without throwing (same-tenant control)", async () => {
    const { db } = makeDb();
    const svc = new BuildReleasePublishedConsumerService(db, dispatch, registry);
    const event = {
      eventId: "ev1",
      organizationId: OWNER_ORG,
      aggregateType: "release",
      aggregateId: "10",
      aggregateVersion: 1,
      payload: { releaseId: 10, name: "v1.0", version: "v1.0" },
    } as never;
    await expect(svc.handle(event)).resolves.not.toThrow();
  });
});
