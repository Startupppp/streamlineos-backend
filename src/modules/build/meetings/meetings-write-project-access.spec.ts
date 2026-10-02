import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AccessService } from "../../access/access.service";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import {
  MEMBER_STANDING,
  projectAccessRow,
  standingAccess,
  type ProjectAccessRow,
} from "../__tests__/project-access-doubles";
import { MeetingsService } from "./meetings.service";

const PROJECT_ID = 7;
const MEETING_ID = 3;

const actor: CurrentUserContext = {
  userId: "user-21",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(21, false),
};

const meetingRow = { id: MEETING_ID, orgId: "org-1", projectId: PROJECT_ID, title: "Standup" };

function makeDb(project: ProjectAccessRow | null) {
  const projectRows = project === null ? [] : [project];
  const memberChain = { from: () => memberChain, where: () => memberChain, limit: () => Promise.resolve([{ id: 1, membershipId: 9 }]) };
  const select = jest.fn((fields?: object) =>
    fields !== undefined && "memberRole" in fields
      ? { from: () => ({ where: () => ({ limit: () => Promise.resolve(projectRows) }) }) }
      : memberChain,
  );
  const returning = jest.fn(() => Promise.resolve([meetingRow]));
  const update = jest.fn(() => ({ set: () => ({ where: () => Object.assign(Promise.resolve([]), { returning }) }) }));
  const insert = jest.fn(() => ({
    values: () => ({
      onConflictDoNothing: () => Promise.resolve([]),
      onConflictDoUpdate: () => ({ returning }),
    }),
  }));
  const remove = jest.fn(() => ({ where: () => Promise.resolve([]) }));
  const findFirst = jest.fn().mockResolvedValue(meetingRow);
  return { select, update, insert, delete: remove, query: { projectMeetings: { findFirst } } };
}

async function build(project: ProjectAccessRow | null) {
  const db = makeDb(project);
  const moduleRef = await Test.createTestingModule({
    providers: [
      MeetingsService,
      { provide: DRIZZLE, useValue: db },
      { provide: AccessService, useValue: standingAccess(MEMBER_STANDING) },
      { provide: AuditService, useValue: { log: jest.fn() } },
    ],
  }).compile();
  return { db, svc: moduleRef.get(MeetingsService) };
}

type Built = Awaited<ReturnType<typeof build>>;

const WRITES: Array<[string, (built: Built) => Promise<unknown>]> = [
  ["PATCH /build/:projectId/meetings/:meetingId", ({ svc }) => svc.updateMeeting(actor, PROJECT_ID, MEETING_ID, { title: "Retro" })],
  ["DELETE /build/:projectId/meetings/:meetingId", ({ svc }) => svc.deleteMeeting(actor, PROJECT_ID, MEETING_ID)],
  [
    "POST /build/:projectId/meetings/:meetingId/attendees",
    ({ svc }) => svc.addAttendee(actor, PROJECT_ID, MEETING_ID, { userId: "user-9" }),
  ],
  [
    "DELETE /build/:projectId/meetings/:meetingId/attendees/:attendeeUserId",
    ({ svc }) => svc.removeAttendee(actor, PROJECT_ID, MEETING_ID, "user-9"),
  ],
  [
    "PUT /build/:projectId/meetings/:meetingId/standup",
    ({ svc }) => svc.upsertStandup(actor, PROJECT_ID, MEETING_ID, { today: "ship" }),
  ],
];

function touched(built: Built): boolean {
  return (
    built.db.query.projectMeetings.findFirst.mock.calls.length > 0 ||
    built.db.update.mock.calls.length > 0 ||
    built.db.insert.mock.calls.length > 0 ||
    built.db.delete.mock.calls.length > 0
  );
}

describe("meeting writes are decided by the project-access write rule", () => {
  it.each(WRITES)("%s answers 403 to a same-org caller who is not on the project, before reading the meeting", async (_route, call) => {
    const built = await build(projectAccessRow());
    await expect(call(built)).rejects.toThrow(ForbiddenException);
    expect(touched(built)).toBe(false);
  });

  it.each(WRITES)("%s answers 404 for a project outside the caller's organisation", async (_route, call) => {
    const built = await build(null);
    await expect(call(built)).rejects.toThrow(NotFoundException);
    expect(touched(built)).toBe(false);
  });

  it.each(WRITES)("%s answers 409 PROJECT_LOCKED on an archived project", async (_route, call) => {
    const built = await build(projectAccessRow({ memberRole: "MEMBER", state: "ARCHIVED" }));
    await expect(call(built)).rejects.toThrow(ConflictException);
    expect(touched(built)).toBe(false);
  });

  it.each(WRITES)("%s succeeds for a project member", async (_route, call) => {
    const built = await build(projectAccessRow({ memberRole: "MEMBER" }));
    await call(built);
    expect(touched(built)).toBe(true);
  });
});
