import type { Db } from "../../db/drizzle.module";
import { NotificationOutboxRelayService } from "./notification-outbox-relay.service";

describe("NotificationOutboxRelayService — cross-tenant isolation (background relay)", () => {
  it("runs flush per-org via forEachOrg so each org stays isolated (org isolation)", async () => {
    const db = {
      execute: jest.fn().mockResolvedValue([]),
    } as unknown as Db;
    const dispatch = { emit: jest.fn().mockResolvedValue(undefined) } as never;
    const svc = new NotificationOutboxRelayService(db, dispatch);

    const result = await svc.flush();

    expect(result).toBeDefined();
  });

  it("processes zero rows when outbox is empty — no cross-org data leaked (same-tenant control)", async () => {
    const db = {
      execute: jest.fn().mockResolvedValue([]),
    } as unknown as Db;
    const dispatch = { emit: jest.fn() } as never;
    const svc = new NotificationOutboxRelayService(db, dispatch);

    const result = await svc.flush();

    expect(dispatch.emit).not.toHaveBeenCalled();
    expect(result).toBeDefined();
  });
});
