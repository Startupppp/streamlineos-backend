import {
  NotificationTimeSweepsService,
  SCHEDULED_BROADCAST_SWEEP_CAP,
} from "./notification-time-sweeps.service";
import type { Db } from "../../../db/drizzle.module";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined) return [v];
  if (typeof v !== "object") return [v];
  if (v instanceof Date) return [v];
  if (Array.isArray(v)) return v.flatMap((i) => sqlValues(i, seen));
  if (seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value")
      ? sqlValues(r.value, seen)
      : []),
  ];
}

type Harness = {
  tx: Db;
  updates: { set: unknown; where: unknown }[];
  selectWhere: unknown[];
  limits: number[];
};

function makeTx(dueIds: number[]): Harness {
  const updates: { set: unknown; where: unknown }[] = [];
  const selectWhere: unknown[] = [];
  const limits: number[] = [];
  const tx = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((w: unknown) => {
          selectWhere.push(w);
          return {
            limit: jest.fn().mockImplementation((n: number) => {
              limits.push(n);
              return Promise.resolve(dueIds.map((id) => ({ id })));
            }),
          };
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockImplementation((s: unknown) => ({
        where: jest.fn().mockImplementation((w: unknown) => {
          updates.push({ set: s, where: w });
          return Promise.resolve([]);
        }),
      })),
    }),
  } as unknown as Db;
  return { tx, updates, selectWhere, limits };
}

function sweepOne(svc: NotificationTimeSweepsService, h: Harness) {
  const result = {
    slaBreached: 0,
    invoicesDueSoon: 0,
    envelopesExpiring: 0,
    eventsStartingSoon: 0,
    scheduledBroadcastsSent: 0,
  };
  const run = (
    svc as unknown as {
      sweepScheduledBroadcasts: (
        tx: Db,
        orgId: string,
        r: typeof result,
      ) => Promise<void>;
    }
  ).sweepScheduledBroadcasts.bind(svc);
  return run(h.tx, "org-1", result).then(() => result);
}

function makeService() {
  return new NotificationTimeSweepsService({} as Db, { emit: jest.fn() } as never);
}

describe("a scheduled broadcast whose time has passed is published by the sweep", () => {
  it("flips a due SCHEDULED broadcast to SENT so the Inbox can see it", async () => {
    const h = makeTx([7, 9]);

    const result = await sweepOne(makeService(), h);

    expect(h.updates.length).toBe(1);
    expect(h.updates[0]?.set).toMatchObject({ status: "SENT" });
    expect(result.scheduledBroadcastsSent).toBe(2);
  });

  it("stamps sentAt so the row is not left looking unsent", async () => {
    const h = makeTx([7]);

    await sweepOne(makeService(), h);

    const set = h.updates[0]?.set as { sentAt?: unknown };
    expect(set.sentAt).toBeInstanceOf(Date);
  });

  it("writes nothing when no broadcast is due, so an idle sweep is not a write", async () => {
    const h = makeTx([]);

    const result = await sweepOne(makeService(), h);

    expect(h.updates.length).toBe(0);
    expect(result.scheduledBroadcastsSent).toBe(0);
  });

  it("scopes both the read and the write to the sweeping org", async () => {
    const h = makeTx([7]);

    await sweepOne(makeService(), h);

    expect(sqlValues(h.selectWhere[0])).toContain("org-1");
    expect(sqlValues(h.updates[0]?.where)).toContain("org-1");
  });

  it("only selects rows already due, never future ones", async () => {
    const h = makeTx([7]);

    await sweepOne(makeService(), h);

    const values = sqlValues(h.selectWhere[0]);
    expect(values).toContain("SCHEDULED");
    expect(values.some((v) => v instanceof Date)).toBe(true);
  });

  it("caps the batch so one org cannot monopolise the sweep", async () => {
    const h = makeTx([7]);

    await sweepOne(makeService(), h);

    expect(h.limits[0]).toBe(SCHEDULED_BROADCAST_SWEEP_CAP);
  });
});
