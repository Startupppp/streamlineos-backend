import type { Db } from "../../db/drizzle.module";
import { CalendarProviderSyncSweepService } from "./calendar-provider-sync-sweep.service";
import type { ExternalCalendarSyncService } from "./external-calendar-sync.service";
import { providerSyncPayloadSchema } from "./dto/provider-sync.schemas";

jest.mock("../../common/tenant", () => ({
  forEachOrg: jest.fn(),
}));

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(),
}));

import { forEachOrg } from "../../common/tenant";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";

const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;
const mockedRunInTx = runInNewTenantTransaction as jest.MockedFunction<typeof runInNewTenantTransaction>;

function makeMarkTx() {
  return {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      }),
    }),
  };
}

function makeClaimingTx(rows: unknown[]) {
  return {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  };
}

describe("providerSyncPayloadSchema — schema validation", () => {
  it("accepts a well-formed payload", () => {
    const result = providerSyncPayloadSchema.safeParse({
      userId: "user-1",
      title: "Standup",
      startIso: "2024-06-01T10:00:00Z",
      endIso: "2024-06-01T10:30:00Z",
      allDay: false,
      attendeeEmails: ["a@example.com"],
      addConference: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a payload missing userId", () => {
    const result = providerSyncPayloadSchema.safeParse({ title: "No user" });
    expect(result.success).toBe(false);
  });

  it("rejects a payload with wrong type for attendeeEmails (string instead of array)", () => {
    const result = providerSyncPayloadSchema.safeParse({
      userId: "user-1",
      attendeeEmails: "not-an-array",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a payload with wrong type for startIso (number instead of string)", () => {
    const result = providerSyncPayloadSchema.safeParse({
      userId: "user-1",
      startIso: 99999,
    });
    expect(result.success).toBe(false);
  });
});

describe("CalendarProviderSyncSweepService — malformed payload routing", () => {
  const ORG_ID = "org-1";

  beforeEach(() => {
    jest.resetAllMocks();
    mockedRunInTx.mockImplementation(async (_db, _orgId, cb) => {
      await cb(makeMarkTx() as never);
    });
  });

  it("does not call pushCreate for a row with wrong-typed startIso and routes it to retry instead of pushing bad data", async () => {
    const badRow = {
      id: 1,
      orgId: ORG_ID,
      connectionId: 5,
      operation: "create",
      state: "PENDING",
      payload: { userId: "user-1", startIso: 99999 },
      eventId: 10,
      externalEventId: null,
      attemptCount: 0,
      leaseExpiresAt: null,
      processedAt: null,
      lastError: null,
    };

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      await cb(makeClaimingTx([badRow]) as never, ORG_ID);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    const pushCreate = jest.fn().mockResolvedValue({ externalEventId: "ext-1" });
    const sync = { pushCreate } as unknown as ExternalCalendarSyncService;
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([
              { id: 5, toolkit: "googlecalendar", composioConnectedAccountId: "c-1" },
            ]),
          }),
        }),
      }),
      query: {
        calendarEvents: {
          findFirst: jest.fn().mockResolvedValue({
            id: 10, title: "Stored", description: null,
            startDate: new Date("2024-06-01T10:00:00Z"),
            endDate: new Date("2024-06-01T11:00:00Z"),
            allDay: false, externalEventId: null,
          }),
        },
      },
    } as unknown as Db;

    const svc = new CalendarProviderSyncSweepService(db, sync);
    const result = await svc.run();

    expect(pushCreate).not.toHaveBeenCalled();
    expect(result.retried).toBe(1);
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("does not call pushDelete for a row with attendeeEmails as string instead of array", async () => {
    const badRow = {
      id: 2,
      orgId: ORG_ID,
      connectionId: 5,
      operation: "delete",
      state: "PENDING",
      payload: { userId: "user-1", attendeeEmails: "bad" },
      eventId: null,
      externalEventId: "ext-99",
      attemptCount: 0,
      leaseExpiresAt: null,
      processedAt: null,
      lastError: null,
    };

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      await cb(makeClaimingTx([badRow]) as never, ORG_ID);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    const pushDelete = jest.fn().mockResolvedValue({ success: true });
    const sync = { pushDelete } as unknown as ExternalCalendarSyncService;
    const db = {} as unknown as Db;

    const svc = new CalendarProviderSyncSweepService(db, sync);
    const result = await svc.run();

    expect(pushDelete).not.toHaveBeenCalled();
    expect(result.retried).toBe(1);
    expect(result.processed).toBe(0);
  });
});
