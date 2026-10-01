import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { humanSessionPrincipal, systemJobPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { AccessService } from "../../../access/access.service";
import {
  assertCanDeleteProject,
  assertCanModifyAuthoredRecord,
  assertProjectAccess,
  assertProjectAggregateAccess,
  assertProjectInOrg,
  assertProjectVisible,
  assertTicketReadAccess,
  authorizeProjectTicketRead,
  authorizeTicketMutation,
  readMutationTickets,
  resolveProjectAccess,
} from "./project-access";
import { MEMBER_STANDING, projectAccessRow, standingAccess, type StandingScopes } from "./__tests__/project-access-doubles";
import { queuedSelectDb } from "./__tests__/project-access-db";

const MEMBER_MID = 42;
const PROJECT_ID = 10;
const TICKET_ID = 99;
const ORG_ID = "org-1";
const USER_ID = "user-1";

function makeActor(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    orgId: ORG_ID,
    userId: USER_ID,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(MEMBER_MID, false),
    ...overrides,
  };
}

const owner = () => makeActor({ isOrgOwner: true, principal: humanSessionPrincipal(MEMBER_MID, true) });

function fullAccess(scopes: StandingScopes): AccessService {
  return standingAccess(scopes) as unknown as AccessService;
}

describe("assertProjectInOrg", () => {
  it("resolves when project belongs to the tenant", async () => {
    const { db } = queuedSelectDb({ inOrg: { id: PROJECT_ID } });
    await expect(assertProjectInOrg(db, ORG_ID, PROJECT_ID)).resolves.toBeUndefined();
  });

  it("throws 404 not 403 for cross-tenant miss (conceals existence)", async () => {
    const { db } = queuedSelectDb({ inOrg: undefined });
    const err = await assertProjectInOrg(db, "foreign-org", PROJECT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err).not.toBeInstanceOf(ForbiddenException);
  });
});

describe("resolveProjectAccess — standing comes from scopeFor, so the owner shortcut is build:manage at all", () => {
  it("grants OWNER to the org owner because scopeFor answers all for build:manage", async () => {
    const { db } = queuedSelectDb({ selects: [[projectAccessRow()]] });
    const access = standingAccess({ "build:manage": "all" });
    const result = await resolveProjectAccess(db, access, owner(), PROJECT_ID);
    expect(result).toMatchObject({ hasAccess: true, role: "OWNER", state: "ACTIVE" });
    expect(access.scopeFor).toHaveBeenCalledWith(expect.objectContaining({ isOrgOwner: true }), "build:manage");
  });

  it("throws 404 even for the org owner when the project is in a foreign tenant", async () => {
    const { db } = queuedSelectDb({ selects: [[]] });
    await expect(
      resolveProjectAccess(db, standingAccess({ "build:manage": "all" }), owner(), PROJECT_ID),
    ).rejects.toThrow(NotFoundException);
  });

  it("does not treat an own-scoped build:manage holder as OWNER, matching the list which bypasses only on all", async () => {
    const { db } = queuedSelectDb({ selects: [[projectAccessRow()]] });
    const result = await resolveProjectAccess(db, standingAccess({ "build:manage": "own" }), makeActor(), PROJECT_ID);
    expect(result).toMatchObject({ hasAccess: false, role: null });
  });

  it("grants the own-scoped build:manage holder access through a real project relationship (positive pair)", async () => {
    const { db } = queuedSelectDb({ selects: [[projectAccessRow({ memberRole: "CONTRIBUTOR" })]] });
    const result = await resolveProjectAccess(db, standingAccess({ "build:manage": "own" }), makeActor(), PROJECT_ID);
    expect(result).toMatchObject({ hasAccess: true, role: "CONTRIBUTOR" });
  });

  it("refuses a related member who holds neither build:manage nor build:view, so a token without either key reaches nothing", async () => {
    const { db } = queuedSelectDb({ selects: [[projectAccessRow({ manages: true })]] });
    const result = await resolveProjectAccess(db, standingAccess({}), makeActor(), PROJECT_ID);
    expect(result).toMatchObject({ hasAccess: false, role: null });
  });

  it("grants MANAGER to the named project manager", async () => {
    const { db } = queuedSelectDb({ selects: [[projectAccessRow({ manages: true })]] });
    const result = await resolveProjectAccess(db, standingAccess(MEMBER_STANDING), makeActor(), PROJECT_ID);
    expect(result).toMatchObject({ hasAccess: true, role: "MANAGER" });
  });

  it("grants MEMBER through a team assignment", async () => {
    const { db } = queuedSelectDb({ selects: [[projectAccessRow({ onTeam: true })]] });
    const result = await resolveProjectAccess(db, standingAccess(MEMBER_STANDING), makeActor(), PROJECT_ID);
    expect(result).toMatchObject({ hasAccess: true, role: "MEMBER" });
  });

  it("returns hasAccess false for a same-tenant user with no relationship", async () => {
    const { db } = queuedSelectDb({ selects: [[projectAccessRow()]] });
    const result = await resolveProjectAccess(db, standingAccess(MEMBER_STANDING), makeActor(), PROJECT_ID);
    expect(result).toMatchObject({ hasAccess: false, role: null });
  });
});

describe("assertProjectAccess", () => {
  it("resolves for an authorized project member", async () => {
    const { db } = queuedSelectDb({ selects: [[projectAccessRow({ manages: true })]] });
    await expect(assertProjectAccess(db, standingAccess(MEMBER_STANDING), makeActor(), PROJECT_ID)).resolves.toBeUndefined();
  });

  it("throws 403 for an in-tenant non-member (does not conceal project existence)", async () => {
    const { db } = queuedSelectDb({ selects: [[projectAccessRow()]] });
    const err = await assertProjectAccess(db, standingAccess(MEMBER_STANDING), makeActor(), PROJECT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err).not.toBeInstanceOf(NotFoundException);
  });

  it("throws 404 for a cross-tenant project (conceals existence)", async () => {
    const { db } = queuedSelectDb({ selects: [[]] });
    const err = await assertProjectAccess(db, standingAccess(MEMBER_STANDING), makeActor(), PROJECT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err).not.toBeInstanceOf(ForbiddenException);
  });
});

describe("assertProjectAggregateAccess — system-job path", () => {
  it("allows build.daily-snapshots when project is in tenant", async () => {
    const { db } = queuedSelectDb({ inOrg: { id: PROJECT_ID } });
    const actor = makeActor({ principal: systemJobPrincipal("build.daily-snapshots") });
    await expect(assertProjectAggregateAccess(db, fullAccess({}), actor, PROJECT_ID)).resolves.toBeUndefined();
  });

  it("refuses integrations.git.webhook whose ceiling excludes build:manage", async () => {
    const { db } = queuedSelectDb({ inOrg: { id: PROJECT_ID } });
    const actor = makeActor({ principal: systemJobPrincipal("integrations.git.webhook") });
    await expect(assertProjectAggregateAccess(db, fullAccess({}), actor, PROJECT_ID)).rejects.toThrow(ForbiddenException);
  });

  it("throws 404 for build.daily-snapshots when project is in a foreign tenant", async () => {
    const { db } = queuedSelectDb({ inOrg: undefined });
    const actor = makeActor({ principal: systemJobPrincipal("build.daily-snapshots") });
    await expect(assertProjectAggregateAccess(db, fullAccess({}), actor, PROJECT_ID)).rejects.toThrow(NotFoundException);
  });
});

describe("assertProjectAggregateAccess — human actor path", () => {
  it("allows a project manager with unrestricted ticket scope", async () => {
    const { db } = queuedSelectDb({ selects: [[projectAccessRow({ manages: true })]] });
    await expect(
      assertProjectAggregateAccess(db, fullAccess(MEMBER_STANDING), makeActor(), PROJECT_ID),
    ).resolves.toBeUndefined();
  });

  it.each(["own", "team", "none"] as const)("denies a project manager with restricted %s ticket scope", async (scope) => {
    const { db } = queuedSelectDb({ selects: [[projectAccessRow({ manages: true })]] });
    const access = fullAccess({ ...MEMBER_STANDING, "build:tickets:view": scope });
    await expect(assertProjectAggregateAccess(db, access, makeActor(), PROJECT_ID)).rejects.toThrow(ForbiddenException);
  });

  it("throws 403 for a same-tenant non-member (does not throw 404)", async () => {
    const { db } = queuedSelectDb({ selects: [[projectAccessRow()]] });
    const err = await assertProjectAggregateAccess(db, fullAccess(MEMBER_STANDING), makeActor(), PROJECT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err).not.toBeInstanceOf(NotFoundException);
  });

  it("throws 404 when project is cross-tenant (does not throw 403)", async () => {
    const { db } = queuedSelectDb({ selects: [[]] });
    const err = await assertProjectAggregateAccess(db, fullAccess(MEMBER_STANDING), makeActor(), PROJECT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err).not.toBeInstanceOf(ForbiddenException);
  });
});

describe("assertTicketReadAccess", () => {
  const ticketRow = (over: object = {}) => ({
    projectId: PROJECT_ID,
    projectState: "ACTIVE",
    projectDeletedAt: null,
    reachable: true,
    inScope: true,
    ...over,
  });

  it("resolves when ticket is within the actor scope and the project is reachable", async () => {
    const { db } = queuedSelectDb({ selects: [[ticketRow()]] });
    await expect(assertTicketReadAccess(db, standingAccess(MEMBER_STANDING), makeActor(), PROJECT_ID, TICKET_ID)).resolves.toBeUndefined();
  });

  it("throws 404 when ticket does not exist in the project (conceals)", async () => {
    const { db } = queuedSelectDb({ selects: [[]] });
    const err = await assertTicketReadAccess(db, standingAccess(MEMBER_STANDING), makeActor(), PROJECT_ID, TICKET_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err).not.toBeInstanceOf(ForbiddenException);
  });

  it("throws 403 when ticket exists but is outside the actor data scope", async () => {
    const { db } = queuedSelectDb({ selects: [[ticketRow({ inScope: false })]] });
    await expect(
      assertTicketReadAccess(db, standingAccess(MEMBER_STANDING), makeActor(), PROJECT_ID, TICKET_ID),
    ).rejects.toThrow(ForbiddenException);
  });

  it("throws 403 when the ticket is in scope but its project is not reachable", async () => {
    const { db } = queuedSelectDb({ selects: [[ticketRow({ reachable: false })]] });
    await expect(
      assertTicketReadAccess(db, standingAccess(MEMBER_STANDING), makeActor(), PROJECT_ID, TICKET_ID),
    ).rejects.toThrow(ForbiddenException);
  });

  it("throws 404 when the ticket's project is soft-deleted", async () => {
    const { db } = queuedSelectDb({ selects: [[ticketRow({ projectDeletedAt: new Date() })]] });
    const err = await assertTicketReadAccess(db, standingAccess(MEMBER_STANDING), makeActor(), PROJECT_ID, TICKET_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
  });
});

describe("authorizeTicketMutation", () => {
  it("returns role, workflow bypass and predicate for an authorized project manager", async () => {
    const { db } = queuedSelectDb({ selects: [[projectAccessRow({ manages: true })]] });
    const result = await authorizeTicketMutation(db, fullAccess(MEMBER_STANDING), makeActor(), PROJECT_ID);
    expect(result.role).toBe("MANAGER");
    expect(result.bypassesWorkflow).toBe(false);
    expect(result).toHaveProperty("predicate");
  });

  it("throws 403 for a same-tenant non-member", async () => {
    const { db } = queuedSelectDb({ selects: [[projectAccessRow()]] });
    const err = await authorizeTicketMutation(db, fullAccess(MEMBER_STANDING), makeActor(), PROJECT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err).not.toBeInstanceOf(NotFoundException);
  });

  it("throws 404 for a cross-tenant project (conceals)", async () => {
    const { db } = queuedSelectDb({ selects: [[]] });
    const err = await authorizeTicketMutation(db, fullAccess(MEMBER_STANDING), makeActor(), PROJECT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err).not.toBeInstanceOf(ForbiddenException);
  });
});

describe("readMutationTickets", () => {
  const policy = { role: "MANAGER", bypassesWorkflow: false, predicate: sql`true` };
  const row = (allowed: boolean) => ({
    id: TICKET_ID, status: "TODO", rank: "1", version: 1, assigneeMembershipId: null, dueDate: null,
    priority: "MEDIUM", points: null, epicId: null, cycleId: null, allowed,
  });

  it("returns rows when all ticket ids are found and within scope", async () => {
    const { db } = queuedSelectDb({ lockedRows: [row(true)] });
    const rows = await readMutationTickets(db, makeActor(), PROJECT_ID, [TICKET_ID], policy);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(TICKET_ID);
  });

  it("throws 404 when a ticket id is not found in the project (conceals)", async () => {
    const { db } = queuedSelectDb({ lockedRows: [] });
    const err = await readMutationTickets(db, makeActor(), PROJECT_ID, [TICKET_ID], policy).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
  });

  it("throws 403 when a ticket exists but is outside the actor data scope", async () => {
    const { db } = queuedSelectDb({ lockedRows: [row(false)] });
    const err = await readMutationTickets(db, makeActor(), PROJECT_ID, [TICKET_ID], policy).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
  });
});

describe("authorizeProjectTicketRead", () => {
  it("returns the tickets read scope for a project member", async () => {
    const { db } = queuedSelectDb({ selects: [[projectAccessRow({ manages: true })]] });
    const read = await authorizeProjectTicketRead(
      db, standingAccess({ ...MEMBER_STANDING, "build:tickets:view": "own" }), makeActor(), PROJECT_ID,
    );
    expect(read.unrestricted).toBe(false);
    expect(read.denied).toBe(false);
  });

  it("conceals the project from a same-tenant non-member as 404", async () => {
    const { db } = queuedSelectDb({ selects: [[projectAccessRow()]] });
    await expect(
      authorizeProjectTicketRead(db, standingAccess(MEMBER_STANDING), makeActor(), PROJECT_ID),
    ).rejects.toThrow(NotFoundException);
  });
});

describe("assertProjectVisible", () => {
  it("resolves for a project member", async () => {
    const { db } = queuedSelectDb({ selects: [[projectAccessRow({ manages: true })]] });
    await expect(assertProjectVisible(db, standingAccess(MEMBER_STANDING), makeActor(), PROJECT_ID)).resolves.toBeUndefined();
  });

  it("conceals the project from a same-tenant non-member as 404", async () => {
    const { db } = queuedSelectDb({ selects: [[projectAccessRow()]] });
    await expect(assertProjectVisible(db, standingAccess(MEMBER_STANDING), makeActor(), PROJECT_ID)).rejects.toThrow(NotFoundException);
  });
});

describe("assertCanDeleteProject", () => {
  it("allows an actor whose build:delete scope is not none", async () => {
    await expect(assertCanDeleteProject(standingAccess({ "build:delete": "all" }), makeActor())).resolves.toBeUndefined();
  });

  it("throws 403 for a member without build:delete", async () => {
    await expect(assertCanDeleteProject(standingAccess({}), makeActor())).rejects.toThrow(ForbiddenException);
  });
});

describe("assertCanModifyAuthoredRecord", () => {
  it("allows the author by membership", async () => {
    await expect(
      assertCanModifyAuthoredRecord(standingAccess({}), makeActor(), { membershipId: MEMBER_MID }, "build:files:manage", "denied"),
    ).resolves.toBeUndefined();
  });

  it("allows the author by user id", async () => {
    await expect(
      assertCanModifyAuthoredRecord(standingAccess({}), makeActor(), { userId: USER_ID }, null, "denied"),
    ).resolves.toBeUndefined();
  });

  it("allows the org owner over another author when build:manage resolves to all", async () => {
    await expect(
      assertCanModifyAuthoredRecord(standingAccess({ "build:manage": "all" }), owner(), { userId: "someone-else" }, null, "denied"),
    ).resolves.toBeUndefined();
  });

  it("denies the org owner whose build:manage standing is ceilinged away", async () => {
    await expect(
      assertCanModifyAuthoredRecord(standingAccess({ "build:view": "all" }), owner(), { userId: "someone-else" }, null, "denied"),
    ).rejects.toThrow(ForbiddenException);
  });

  it("allows a holder of the manage permission over another author", async () => {
    await expect(
      assertCanModifyAuthoredRecord(standingAccess({ "build:files:manage": "all" }), makeActor(), { membershipId: 7 }, "build:files:manage", "denied"),
    ).resolves.toBeUndefined();
  });

  it("denies a non-author without the manage permission", async () => {
    await expect(
      assertCanModifyAuthoredRecord(standingAccess({}), makeActor(), { membershipId: 7 }, "build:files:manage", "denied"),
    ).rejects.toThrow(ForbiddenException);
  });

  it("never treats a null author membership as the actor", async () => {
    const actor = makeActor({ principal: systemJobPrincipal("build.daily-snapshots") });
    await expect(
      assertCanModifyAuthoredRecord(standingAccess({}), actor, { membershipId: null }, "build:files:manage", "denied"),
    ).rejects.toThrow(ForbiddenException);
  });
});
