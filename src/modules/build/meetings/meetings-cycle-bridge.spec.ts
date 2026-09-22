import { BadRequestException } from "@nestjs/common";
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

describe("MeetingsService.createMeeting — sprint-to-cycle write bridge", () => {
  it("never writes project_meetings.sprint_id, the column phase-04 drops, even when the request supplies sprintId", async () => {
    const { svc, meetingInsert } = makeHarness({
      selectScript: [{ rows: [{ id: 55 }] }, { rows: [{ maxNum: 0 }] }, { rows: [{ id: 55, legacySprintId: 9 }] }],
    });
    await svc.createMeeting(makeU(), 1, { title: "Planning", sprintId: 9 });
    expect(meetingInsert()).toBeDefined();
    expect(Object.keys(meetingInsert()!)).not.toContain("sprintId");
  });

  it("resolves a supplied sprintId to its cycle through cycles.legacySprintId and writes that cycleId", async () => {
    const { svc, meetingInsert } = makeHarness({
      selectScript: [{ rows: [{ id: 55 }] }, { rows: [{ maxNum: 0 }] }, { rows: [{ id: 55, legacySprintId: 9 }] }],
    });
    await svc.createMeeting(makeU(), 1, { title: "Planning", sprintId: 9 });
    expect(meetingInsert()).toMatchObject({ cycleId: 55 });
  });

  it("rejects an unmappable sprintId with BadRequestException instead of silently dropping the iteration binding", async () => {
    const { svc } = makeHarness({ selectScript: [{ rows: [] }] });
    await expect(
      svc.createMeeting(makeU(), 1, { title: "Planning", sprintId: 404 }),
    ).rejects.toThrow(BadRequestException);
  });

  it("accepts cycleId as the canonical input and skips the legacy bridge lookup entirely", async () => {
    const { svc, meetingInsert, db } = makeHarness({
      selectScript: [{ rows: [{ maxNum: 0 }] }, { rows: [{ id: 77, legacySprintId: 3 }] }],
      insertedRow: { ...MEETING_ROW, cycleId: 77 },
    });
    await svc.createMeeting(makeU(), 1, { title: "Planning", cycleId: 77 });
    expect(meetingInsert()).toMatchObject({ cycleId: 77 });
    expect((db as unknown as { select: jest.Mock }).select).toHaveBeenCalledTimes(1);
  });

  it("lets an explicit cycleId win over a legacy sprintId, matching the precedence the ticket update path already applies", async () => {
    const { svc, meetingInsert } = makeHarness({
      selectScript: [{ rows: [{ maxNum: 0 }] }, { rows: [{ id: 77, legacySprintId: 3 }] }],
      insertedRow: { ...MEETING_ROW, cycleId: 77 },
    });
    await svc.createMeeting(makeU(), 1, { title: "Planning", sprintId: 9, cycleId: 77 });
    expect(meetingInsert()).toMatchObject({ cycleId: 77 });
  });

  it("keeps the wire contract: the created meeting still carries sprintId, derived from the cycle's legacySprintId", async () => {
    const { svc } = makeHarness({
      selectScript: [{ rows: [{ id: 55 }] }, { rows: [{ maxNum: 0 }] }, { rows: [{ id: 55, legacySprintId: 9 }] }],
    });
    const created = await svc.createMeeting(makeU(), 1, { title: "Planning", sprintId: 9 });
    expect(created.sprintId).toBe(9);
  });
});

describe("MeetingsService.updateMeeting — sprint-to-cycle write bridge", () => {
  it("never patches project_meetings.sprint_id, the column phase-04 drops", async () => {
    const { svc, updatedPatches } = makeHarness({
      selectScript: [{ rows: [{ id: 55 }] }, { rows: [{ id: 55, legacySprintId: 9 }] }],
    });
    await svc.updateMeeting("org-1", "user-7", 1, 2, { sprintId: 9 });
    expect(Object.keys(updatedPatches[0])).not.toContain("sprintId");
  });

  it("patches cycleId resolved through cycles.legacySprintId when the request supplies the legacy sprintId", async () => {
    const { svc, updatedPatches } = makeHarness({
      selectScript: [{ rows: [{ id: 55 }] }, { rows: [{ id: 55, legacySprintId: 9 }] }],
    });
    await svc.updateMeeting("org-1", "user-7", 1, 2, { sprintId: 9 });
    expect(updatedPatches[0]).toMatchObject({ cycleId: 55 });
  });

  it("clears the binding to null when the request explicitly nulls sprintId", async () => {
    const { svc, updatedPatches } = makeHarness({
      selectScript: [{ rows: [] }],
      updatedRow: { ...MEETING_ROW, cycleId: null },
    });
    await svc.updateMeeting("org-1", "user-7", 1, 2, { sprintId: null });
    expect(updatedPatches[0]).toMatchObject({ cycleId: null });
  });

  it("leaves cycleId untouched when neither sprintId nor cycleId is supplied", async () => {
    const { svc, updatedPatches } = makeHarness({
      selectScript: [{ rows: [{ id: 55, legacySprintId: 9 }] }],
    });
    await svc.updateMeeting("org-1", "user-7", 1, 2, { title: "Renamed" });
    expect(Object.keys(updatedPatches[0])).not.toContain("cycleId");
  });

  it("lets an explicit cycleId win over a legacy sprintId on update too", async () => {
    const { svc, updatedPatches } = makeHarness({
      selectScript: [{ rows: [{ id: 77, legacySprintId: 3 }] }],
      updatedRow: { ...MEETING_ROW, cycleId: 77 },
    });
    await svc.updateMeeting("org-1", "user-7", 1, 2, { sprintId: 9, cycleId: 77 });
    expect(updatedPatches[0]).toMatchObject({ cycleId: 77 });
  });

  it("rejects an unmappable sprintId with BadRequestException rather than writing a null binding", async () => {
    const { svc, db } = makeHarness({ selectScript: [{ rows: [] }] });
    await expect(
      svc.updateMeeting("org-1", "user-7", 1, 2, { sprintId: 404 }),
    ).rejects.toThrow(BadRequestException);
    expect((db as unknown as { update: jest.Mock }).update).not.toHaveBeenCalled();
  });

  it("keeps the wire contract: the updated meeting still carries sprintId, derived from the cycle's legacySprintId", async () => {
    const { svc } = makeHarness({
      selectScript: [{ rows: [{ id: 55 }] }, { rows: [{ id: 55, legacySprintId: 9 }] }],
    });
    const updated = await svc.updateMeeting("org-1", "user-7", 1, 2, { sprintId: 9 });
    expect(updated.sprintId).toBe(9);
  });
});

describe("MeetingsService reads — sprintId is derived from the cycle, never selected from the dropped column", () => {
  it("getMeeting emits a sprintId derived from the bound cycle's legacySprintId", async () => {
    const { svc } = makeHarness({
      selectScript: [
        { rows: [] },
        { rows: [] },
        { rows: [] },
        { rows: [{ id: 55, legacySprintId: 9 }] },
      ],
    });
    const meeting = await svc.getMeeting(makeU(), 1, 2);
    expect(meeting.sprintId).toBe(9);
  });

  it("getMeeting emits sprintId null when the meeting is bound to a cycle that has no legacy sprint", async () => {
    const { svc, db } = makeHarness({
      selectScript: [
        { rows: [] },
        { rows: [] },
        { rows: [] },
        { rows: [{ id: 55, legacySprintId: null }] },
      ],
    });
    (db.query.projectMeetings.findFirst as jest.Mock).mockResolvedValue({ ...MEETING_ROW });
    const meeting = await svc.getMeeting(makeU(), 1, 2);
    expect(meeting.sprintId).toBeNull();
  });

  it("getMeeting emits sprintId null for an unbound meeting without issuing a cycle lookup", async () => {
    const { svc, db } = makeHarness({ selectScript: [{ rows: [] }, { rows: [] }, { rows: [] }] });
    (db.query.projectMeetings.findFirst as jest.Mock).mockResolvedValue({
      ...MEETING_ROW,
      cycleId: null,
    });
    const meeting = await svc.getMeeting(makeU(), 1, 2);
    expect(meeting.sprintId).toBeNull();
    expect((db as unknown as { select: jest.Mock }).select).toHaveBeenCalledTimes(3);
  });

  it("listMeetings emits a sprintId on every row, derived from each row's cycle", async () => {
    const { svc } = makeHarness({
      selectScript: [
        { rows: [{ ...MEETING_ROW, id: 2, cycleId: 55 }, { ...MEETING_ROW, id: 3, cycleId: null }] },
        { rows: [] },
        { rows: [] },
        { rows: [] },
        { rows: [{ id: 55, legacySprintId: 9 }] },
      ],
    });
    const rows = await svc.listMeetings(makeU(), 1, {});
    expect(rows.map((r) => r.sprintId)).toEqual([9, null]);
  });
});
