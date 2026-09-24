import { MeetingsService } from "./meetings.service";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import * as projectAccessSeam from "../core/project-access";

jest.mock("../core/project-access", () => ({
  assertProjectAccess: jest.fn().mockResolvedValue(undefined),
  assertProjectInOrg: jest.fn().mockResolvedValue(undefined),
}));

const mockAudit = { log: jest.fn() } as unknown as AuditService;
const mockAccess = { resolveUserPermissions: jest.fn() } as unknown as AccessService;

const makeU = (): CurrentUserContext => ({
  userId: "user-7",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(7, false),
});

const MEETING_ROW = {
  id: 2,
  orgId: "org-1",
  projectId: 1,
  meetingNumber: 1,
  title: "Planning",
  type: "planning",
  status: "scheduled",
  agenda: null,
  notes: null,
  scheduledAt: null,
  endAt: null,
  durationMinutes: null,
  timezone: null,
  recurrenceRule: null,
  cycleId: 55,
  createdBy: "user-7",
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

type SelectScript = { rows: unknown[] }[];

function makeHarness(opts: {
  selectScript: SelectScript;
  insertedRow?: Record<string, unknown>;
  updatedRow?: Record<string, unknown>;
}) {
  const insertedValues: Record<string, unknown>[] = [];
  const updatedPatches: Record<string, unknown>[] = [];
  let selectCall = 0;

  const nextRows = () => {
    const step = opts.selectScript[selectCall];
    selectCall += 1;
    return step ? step.rows : [];
  };

  const makeSelectChain = () => {
    const rows = nextRows();
    const chain: Record<string, unknown> = {};
    chain.from = jest.fn().mockReturnValue(chain);
    chain.innerJoin = jest.fn().mockReturnValue(chain);
    chain.where = jest.fn().mockReturnValue(chain);
    chain.groupBy = jest.fn().mockResolvedValue(rows);
    chain.orderBy = jest.fn().mockReturnValue(chain);
    chain.limit = jest.fn().mockResolvedValue(rows);
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
    return chain;
  };

  const insertChain: Record<string, unknown> = {};
  insertChain.values = jest.fn().mockImplementation((v: Record<string, unknown>) => {
    insertedValues.push(v);
    return insertChain;
  });
  insertChain.onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
  insertChain.returning = jest
    .fn()
    .mockResolvedValue([opts.insertedRow ?? { ...MEETING_ROW }]);

  const updateChain: Record<string, unknown> = {};
  updateChain.set = jest.fn().mockImplementation((p: Record<string, unknown>) => {
    updatedPatches.push(p);
    return updateChain;
  });
  updateChain.where = jest.fn().mockReturnValue(updateChain);
  updateChain.returning = jest
    .fn()
    .mockResolvedValue([opts.updatedRow ?? { ...MEETING_ROW }]);

  const db = {
    query: {
      projectMeetings: { findFirst: jest.fn().mockResolvedValue({ ...MEETING_ROW }) },
      projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) },
    },
    select: jest.fn().mockImplementation(() => makeSelectChain()),
    insert: jest.fn().mockReturnValue(insertChain),
    update: jest.fn().mockReturnValue(updateChain),
    transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        execute: jest.fn().mockResolvedValue([]),
        select: jest.fn().mockImplementation(() => makeSelectChain()),
        insert: jest.fn().mockReturnValue(insertChain),
      }),
    ),
  } as unknown as Db;

  const svc = new MeetingsService(db, mockAccess, mockAudit);
  const meetingInsert = () => insertedValues.find((v) => "meetingNumber" in v);
  return { svc, db, meetingInsert, updatedPatches, insertedValues };
}

beforeEach(() => {
  jest.clearAllMocks();
  (projectAccessSeam.assertProjectAccess as jest.Mock).mockResolvedValue(undefined);
});

describe("MeetingsService.createMeeting — cycleId binding", () => {
  it("accepts cycleId as the canonical input", async () => {
    const { svc, meetingInsert, db } = makeHarness({
      selectScript: [],
      insertedRow: { ...MEETING_ROW, cycleId: 77 },
    });
    await svc.createMeeting(makeU(), 1, { title: "Planning", cycleId: 77 });
    expect(meetingInsert()).toMatchObject({ cycleId: 77 });
    expect((db as unknown as { select: jest.Mock }).select).toHaveBeenCalledTimes(0);
  });

  it("lets an explicit cycleId win — the insert row carries the supplied cycleId", async () => {
    const { svc, meetingInsert } = makeHarness({
      selectScript: [],
      insertedRow: { ...MEETING_ROW, cycleId: 77 },
    });
    await svc.createMeeting(makeU(), 1, { title: "Planning", cycleId: 77 });
    expect(meetingInsert()).toMatchObject({ cycleId: 77 });
  });

  it("writes a null cycleId when no cycleId is supplied", async () => {
    const { svc, meetingInsert } = makeHarness({
      selectScript: [],
      insertedRow: { ...MEETING_ROW, cycleId: null },
    });
    await svc.createMeeting(makeU(), 1, { title: "Planning" });
    expect(meetingInsert()).toMatchObject({ cycleId: null });
  });
});

describe("MeetingsService.updateMeeting — cycleId binding", () => {
  it("leaves the cycle binding untouched when neither cycleId is in the patch", async () => {
    const { svc, updatedPatches } = makeHarness({
      selectScript: [],
    });
    await svc.updateMeeting("org-1", "user-7", 1, 2, { title: "Renamed" });
    expect(Object.keys(updatedPatches[0]!)).not.toContain("cycleId");
  });

  it("lets an explicit cycleId win on update — the SET carries the supplied cycleId", async () => {
    const { svc, updatedPatches } = makeHarness({
      selectScript: [],
      updatedRow: { ...MEETING_ROW, cycleId: 77 },
    });
    await svc.updateMeeting("org-1", "user-7", 1, 2, { cycleId: 77 });
    expect(updatedPatches[0]).toMatchObject({ cycleId: 77 });
  });

  it("clears the binding to null when the request explicitly nulls cycleId", async () => {
    const { svc, updatedPatches } = makeHarness({
      selectScript: [],
      updatedRow: { ...MEETING_ROW, cycleId: null },
    });
    await svc.updateMeeting("org-1", "user-7", 1, 2, { cycleId: null });
    expect(updatedPatches[0]).toMatchObject({ cycleId: null });
  });
});

describe("MeetingsService — sprintId removal guard", () => {
  it("createMeeting insert payload contains cycleId and no sprintId key", async () => {
    const { svc, meetingInsert } = makeHarness({
      selectScript: [],
      insertedRow: { ...MEETING_ROW, cycleId: 55 },
    });
    await svc.createMeeting(makeU(), 1, { title: "Planning", cycleId: 55 });
    const payload = meetingInsert()!;
    expect(payload).toBeDefined();
    expect(Object.keys(payload)).toContain("cycleId");
    expect(Object.keys(payload)).not.toContain("sprintId");
  });

  it("createMeeting response row carries no sprintId key", async () => {
    const { svc } = makeHarness({
      selectScript: [],
      insertedRow: { ...MEETING_ROW, cycleId: 55 },
    });
    const row = await svc.createMeeting(makeU(), 1, { title: "Planning", cycleId: 55 });
    expect(row).not.toHaveProperty("sprintId");
  });

  it("updateMeeting SET payload contains no sprintId key", async () => {
    const { svc, updatedPatches } = makeHarness({
      selectScript: [],
      updatedRow: { ...MEETING_ROW, cycleId: 55 },
    });
    await svc.updateMeeting("org-1", "user-7", 1, 2, { cycleId: 55 });
    expect(Object.keys(updatedPatches[0]!)).not.toContain("sprintId");
  });

  it("updateMeeting response row carries no sprintId key", async () => {
    const { svc } = makeHarness({
      selectScript: [],
      updatedRow: { ...MEETING_ROW, cycleId: 55 },
    });
    const row = await svc.updateMeeting("org-1", "user-7", 1, 2, { cycleId: 55 });
    expect(row).not.toHaveProperty("sprintId");
  });

  it("no cycle lookup is issued when the caller supplies no cycleId on create", async () => {
    const { svc, db } = makeHarness({
      selectScript: [],
      insertedRow: { ...MEETING_ROW, cycleId: null },
    });
    await svc.createMeeting(makeU(), 1, { title: "Planning" });
    expect((db as unknown as { select: jest.Mock }).select).toHaveBeenCalledTimes(0);
  });
});
