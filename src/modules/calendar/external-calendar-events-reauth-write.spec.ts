jest.mock("../integrations/core/composio.gateway", () => ({
  ComposioGateway: class {},
  ComposioToolError: class ComposioToolError extends Error {
    isAuthError: boolean;
    constructor(message: string, isAuth: boolean) {
      super(message);
      this.isAuthError = isAuth;
    }
  },
}));

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: (_db: unknown, _orgId: string, fn: (tx: unknown) => unknown) => fn(_db),
}));

import { ComposioToolError } from "../integrations/core/composio.gateway";
import type { Db } from "../../db/drizzle.module";
import { ExternalCalendarEventsService } from "./external-calendar-events.service";

describe("ExternalCalendarEventsService — reauth UPDATE on Composio auth error", () => {
  const ORG = "org-1";
  const USER = "user-1";

  function makeConnection(id: number, toolkit: "googlecalendar" | "outlook") {
    return {
      id,
      toolkit,
      accountEmail: "test@example.com",
      composioConnectedAccountId: `conn-${id}`,
    };
  }

  function makeDb(updateSpy: jest.Mock, connections: unknown[]) {
    let selectCallCount = 0;
    return {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) return Promise.resolve(connections);
            return Promise.resolve([]);
          }),
        }),
      })),
      update: updateSpy,
      execute: jest.fn().mockResolvedValue([]),
    } as unknown as Db;
  }

  function makeCache() {
    return {
      cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()),
    } as never;
  }

  it("marks auth-error connections as needs_reauth in its own transaction so the read-only GET request transaction is not aborted by the UPDATE with SQLSTATE 25006", async () => {
    const authError = new ComposioToolError("auth expired", true);

    const updateSpy = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      }),
    });

    const connections = [makeConnection(7, "googlecalendar")];
    const db = makeDb(updateSpy, connections);

    const gateway = {
      isConfigured: jest.fn().mockReturnValue(true),
      executeTool: jest.fn().mockRejectedValue(authError),
    } as never;

    const svc = new ExternalCalendarEventsService(db, makeCache(), gateway);
    const result = await svc.getExternalEvents(ORG, USER, "2026-01-01", "2026-01-31");

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.connectionId).toBe(7);
  });

  it("does not call update when all connections succeed — no spurious write on the happy GET path", async () => {
    const updateSpy = jest.fn();
    const connections = [makeConnection(8, "googlecalendar")];
    const db = makeDb(updateSpy, connections);

    const gateway = {
      isConfigured: jest.fn().mockReturnValue(true),
      executeTool: jest.fn().mockResolvedValue({ items: [] }),
    } as never;

    const svc = new ExternalCalendarEventsService(db, makeCache(), gateway);
    await svc.getExternalEvents(ORG, USER, "2026-01-01", "2026-01-31");

    expect(updateSpy).not.toHaveBeenCalled();
  });
});
