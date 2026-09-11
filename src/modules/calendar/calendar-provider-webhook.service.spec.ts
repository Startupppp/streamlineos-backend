jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(),
}));

import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { CalendarProviderWebhookService } from "./calendar-provider-webhook.service";
import type { Db } from "../../db/drizzle.module";

const mockedRunInTx = runInNewTenantTransaction as jest.MockedFunction<typeof runInNewTenantTransaction>;

const ORG = "org-webhook-spec";
const EXT_ID = "google-evt-001";
const LOCAL_UPDATED_AT = new Date("2026-09-01T12:00:00Z");
const LOCAL_VERSION = 3;

type EventRow = {
  id: number;
  updatedAt: Date;
  localVersion: number;
  integrationConnectionId: number | null;
  externalEventId: string | null;
  createdByMembershipId: number;
};

function makeEventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: 42,
    updatedAt: LOCAL_UPDATED_AT,
    localVersion: LOCAL_VERSION,
    integrationConnectionId: 7,
    externalEventId: EXT_ID,
    createdByMembershipId: 5,
    ...overrides,
  };
}

function makeTx(
  eventRows: EventRow[],
  pendingRows: { id: number }[],
  memberRow: { userId: string } | undefined,
  captureInsert?: (values: unknown) => void,
) {
  let selectCall = 0;
  return {
    select: jest.fn().mockImplementation(() => {
      const callIdx = selectCall++;
      if (callIdx === 0) {
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(eventRows) }),
          }),
        };
      }
      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(pendingRows) }),
        }),
      };
    }),
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(memberRow),
      },
    },
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockImplementation((v: unknown) => {
        captureInsert?.(v);
        return Promise.resolve([]);
      }),
    })),
  };
}

function makeDb(
  eventRows: EventRow[],
  pendingRows: { id: number }[],
  memberRow: { userId: string } | undefined,
  captureInsert?: (values: unknown) => void,
): Db {
  const tx = makeTx(eventRows, pendingRows, memberRow, captureInsert);
  mockedRunInTx.mockImplementation(async (_db, _orgId, cb) => {
    return cb(tx as never);
  });
  return {} as unknown as Db;
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe("CalendarProviderWebhookService.handleProviderWebhook — discard: stale provider echo", () => {
  it("discards when provider timestamp is strictly older than local updatedAt", async () => {
    const db = makeDb([makeEventRow()], [], { userId: "user-1" });
    const svc = new CalendarProviderWebhookService(db);

    const result = await svc.handleProviderWebhook(
      ORG,
      EXT_ID,
      "2026-09-01T11:59:59Z",
    );

    expect(result.action).toBe("discarded");
  });

  it("discards when provider timestamp equals local updatedAt (local is authoritative, ties go to local)", async () => {
    const db = makeDb([makeEventRow()], [], { userId: "user-1" });
    const svc = new CalendarProviderWebhookService(db);

    const result = await svc.handleProviderWebhook(
      ORG,
      EXT_ID,
      LOCAL_UPDATED_AT.toISOString(),
    );

    expect(result.action).toBe("discarded");
  });

  it("discards when provider timestamp is newer but a PENDING sync job already exists — our push is in flight", async () => {
    const db = makeDb([makeEventRow()], [{ id: 99 }], { userId: "user-1" });
    const svc = new CalendarProviderWebhookService(db);

    const result = await svc.handleProviderWebhook(
      ORG,
      EXT_ID,
      "2026-09-01T13:00:00Z",
    );

    expect(result.action).toBe("discarded");
  });

  it("discards when provider timestamp is newer but an IN_FLIGHT sync job exists — our push is in progress", async () => {
    const db = makeDb([makeEventRow()], [{ id: 100 }], { userId: "user-1" });
    const svc = new CalendarProviderWebhookService(db);

    const result = await svc.handleProviderWebhook(
      ORG,
      EXT_ID,
      "2026-09-01T14:00:00Z",
    );

    expect(result.action).toBe("discarded");
  });

  it("returns not_found when no local event maps to the provider externalEventId (event deleted locally)", async () => {
    const db = makeDb([], [], undefined);
    const svc = new CalendarProviderWebhookService(db);

    const result = await svc.handleProviderWebhook(
      ORG,
      EXT_ID,
      "2026-09-01T13:00:00Z",
    );

    expect(result.action).toBe("not_found");
  });
});

describe("CalendarProviderWebhookService.handleProviderWebhook — newer local edit survives provider echo", () => {
  it("the event is not overwritten: the hook discards when local updatedAt is newer", async () => {
    const olderProviderTimestamp = new Date(LOCAL_UPDATED_AT.getTime() - 60_000).toISOString();
    let insertCalled = false;
    const db = makeDb([makeEventRow()], [], { userId: "user-1" }, () => { insertCalled = true; });
    const svc = new CalendarProviderWebhookService(db);

    const result = await svc.handleProviderWebhook(ORG, EXT_ID, olderProviderTimestamp);

    expect(result.action).toBe("discarded");
    expect(insertCalled).toBe(false);
  });

  it("when local edit is newer and a pending sync exists, no re-queue fires — the pending sync will push local state", async () => {
    const newerProviderTimestamp = new Date(LOCAL_UPDATED_AT.getTime() + 60_000).toISOString();
    let insertCalled = false;
    const db = makeDb([makeEventRow()], [{ id: 55 }], { userId: "user-1" }, () => { insertCalled = true; });
    const svc = new CalendarProviderWebhookService(db);

    const result = await svc.handleProviderWebhook(ORG, EXT_ID, newerProviderTimestamp);

    expect(result.action).toBe("discarded");
    expect(insertCalled).toBe(false);
  });
});

describe("CalendarProviderWebhookService.handleProviderWebhook — genuine drift: re-queue local push", () => {
  it("re-queues an UPDATE sync job when provider is genuinely newer and no pending sync exists", async () => {
    const newerProviderTimestamp = new Date(LOCAL_UPDATED_AT.getTime() + 5_000).toISOString();
    let capturedInsert: unknown;
    const db = makeDb(
      [makeEventRow()],
      [],
      { userId: "user-creator" },
      (v) => { capturedInsert = v; },
    );
    const svc = new CalendarProviderWebhookService(db);

    const result = await svc.handleProviderWebhook(ORG, EXT_ID, newerProviderTimestamp);

    expect(result.action).toBe("requeued");
    expect(capturedInsert).toBeDefined();
    const inserted = capturedInsert as Record<string, unknown>;
    expect(inserted.operation).toBe("update");
    expect(inserted.orgId).toBe(ORG);
    expect(inserted.externalEventId).toBe(EXT_ID);
    expect(inserted.eventId).toBe(42);
    expect((inserted.payload as Record<string, unknown>).userId).toBe("user-creator");
  });

  it("the re-queued job carries the current local_version so the sweep can detect superseded runs", async () => {
    const newerProviderTimestamp = new Date(LOCAL_UPDATED_AT.getTime() + 5_000).toISOString();
    let capturedInsert: unknown;
    const db = makeDb(
      [makeEventRow({ localVersion: LOCAL_VERSION })],
      [],
      { userId: "user-creator" },
      (v) => { capturedInsert = v; },
    );
    const svc = new CalendarProviderWebhookService(db);

    await svc.handleProviderWebhook(ORG, EXT_ID, newerProviderTimestamp);

    const inserted = capturedInsert as Record<string, unknown>;
    expect(inserted.eventLocalVersion).toBe(LOCAL_VERSION);
  });

  it("discards instead of re-queuing when event has no integrationConnectionId", async () => {
    const newerProviderTimestamp = new Date(LOCAL_UPDATED_AT.getTime() + 5_000).toISOString();
    let insertCalled = false;
    const db = makeDb(
      [makeEventRow({ integrationConnectionId: null })],
      [],
      { userId: "user-1" },
      () => { insertCalled = true; },
    );
    const svc = new CalendarProviderWebhookService(db);

    const result = await svc.handleProviderWebhook(ORG, EXT_ID, newerProviderTimestamp);

    expect(result.action).toBe("discarded");
    expect(insertCalled).toBe(false);
  });
});
