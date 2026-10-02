import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  humanSessionPrincipal,
  personalTokenPrincipal,
  systemJobPrincipal,
} from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { AccessService } from "../../../access/access.service";
import {
  assertCanManageProject,
  assertCanManageProjectLink,
  assertProjectAccess,
  assertProjectVisibleForWrite,
  assertProjectWriteAccess,
  assertTicketReadAccess,
  assertTicketWriteAccess,
  authorizeApprovalDecision,
  authorizeProjectUpdate,
  authorizeTicketMutation,
  decideProjectWrite,
  decideTicketChange,
  decideTicketRead,
  resolveProjectAccess,
  resolveProjectReach,
  type ProjectState,
} from "./project-access";
import { MEMBER_STANDING, projectAccessRow, principalAccess } from "../../__tests__/project-access-doubles";
import { queuedSelectDb } from "../../__tests__/project-access-db";

const ORG_ID = "org-1";
const MID = 7;
const dialect = new PgDialect();

function actor(principal = humanSessionPrincipal(MID, false)): CurrentUserContext {
  return {
    orgId: ORG_ID,
    userId: "u-1",
    role: "MEMBER",
    isOrgOwner: principal.kind === "human-session" || principal.kind === "personal-token" ? principal.isOrgOwner : false,
    sessionId: "s-1",
    tokenScopes: null,
    principal,
  };
}

const owner = () => actor(humanSessionPrincipal(MID, true));
const ownerToken = (ceiling: readonly string[]) => actor(personalTokenPrincipal(MID, true, "tok-1", ceiling));
const memberAccess = () => principalAccess(MEMBER_STANDING);
const asService = (access: ReturnType<typeof principalAccess>) => access as unknown as AccessService;

function projectDb(state: ProjectState, relation: Parameters<typeof projectAccessRow>[0] = {}) {
  return queuedSelectDb({ selects: [[projectAccessRow({ state, ...relation })]] }).db;
}

async function lockCode(promise: Promise<unknown>): Promise<unknown> {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConflictException);
  return err instanceof ConflictException ? err.getResponse() : null;
}

describe("token ceiling — standing comes from scopeFor, so a personal token cannot borrow its owner's bypass", () => {
  it("an org owner on a human session is OWNER of every project", async () => {
    const result = await resolveProjectAccess(projectDb("ACTIVE"), memberAccess(), owner(), 1);
    expect(result).toMatchObject({ hasAccess: true, role: "OWNER", bypassesWorkflow: true });
  });

  it("an org owner's personal token without build:manage in its ceiling is refused a project it has no relationship to", async () => {
    const result = await resolveProjectAccess(projectDb("ACTIVE"), memberAccess(), ownerToken(["build:view"]), 1);
    expect(result).toMatchObject({ hasAccess: false, role: null, bypassesWorkflow: false });
  });

  it("the same ceilinged token still reaches a project it is a member of, as a member rather than OWNER", async () => {
    const result = await resolveProjectAccess(
      projectDb("ACTIVE", { memberRole: "CONTRIBUTOR" }), memberAccess(), ownerToken(["build:view"]), 1,
    );
    expect(result).toMatchObject({ hasAccess: true, role: "CONTRIBUTOR", bypassesWorkflow: false });
  });

  it("an owner token whose ceiling includes build:manage keeps the OWNER standing", async () => {
    const result = await resolveProjectAccess(projectDb("ACTIVE"), memberAccess(), ownerToken(["build:manage"]), 1);
    expect(result).toMatchObject({ hasAccess: true, role: "OWNER" });
  });

  it("the list predicate agrees with the single read: the ceilinged owner token gets the relationship rule, the session gets everything", async () => {
    const tokenReach = await resolveProjectReach(memberAccess(), ownerToken(["build:view"]));
    const sessionReach = await resolveProjectReach(memberAccess(), owner());
    expect(dialect.sqlToQuery(tokenReach.where).sql).toContain("project_members");
    expect(dialect.sqlToQuery(sessionReach.where).sql).toBe("true");
  });

  it("a non-owner build:manage holder is OWNER for access but does not inherit the workflow bypass", async () => {
    const access = principalAccess({ ...MEMBER_STANDING, "build:manage": "all" });
    const result = await resolveProjectAccess(projectDb("ACTIVE"), access, actor(), 1);
    expect(result).toMatchObject({ hasAccess: true, role: "OWNER", bypassesWorkflow: false });
  });
});

describe("business state — an ARCHIVED or COMPLETED project refuses writes and still serves reads", () => {
  it.each(["ARCHIVED", "COMPLETED"] as const)("assertProjectAccess still lets a member read a %s project", async (state) => {
    await expect(assertProjectAccess(projectDb(state, { manages: true }), memberAccess(), actor(), 1)).resolves.toBeUndefined();
  });

  it.each(["ARCHIVED", "COMPLETED"] as const)("assertProjectWriteAccess refuses a %s project with 409 PROJECT_LOCKED", async (state) => {
    const body = await lockCode(assertProjectWriteAccess(projectDb(state, { manages: true }), memberAccess(), actor(), 1));
    expect(body).toMatchObject({ code: "PROJECT_LOCKED", details: { state } });
  });

  it("assertProjectWriteAccess lets the same member write to an ACTIVE project", async () => {
    await expect(
      assertProjectWriteAccess(projectDb("ACTIVE", { manages: true }), memberAccess(), actor(), 1),
    ).resolves.toBeUndefined();
  });

  it("checks the relationship before the state, so an outsider learns 403 rather than the project's lifecycle", async () => {
    const err = await assertProjectWriteAccess(projectDb("ARCHIVED"), memberAccess(), actor(), 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
  });

  it("assertCanManageProject refuses settings writes on an archived project even for the org owner", async () => {
    await lockCode(assertCanManageProject(projectDb("ARCHIVED"), memberAccess(), owner(), 1));
    await expect(assertCanManageProject(projectDb("ACTIVE"), memberAccess(), owner(), 1)).resolves.toBeUndefined();
  });

  it.each(["ARCHIVED", "COMPLETED"] as const)("assertCanManageProjectLink lets a manager link a %s project while assertCanManageProject still locks it", async (state) => {
    await expect(assertCanManageProjectLink(projectDb(state, { manages: true }), memberAccess(), actor(), 1)).resolves.toBeUndefined();
    await lockCode(assertCanManageProject(projectDb(state, { manages: true }), memberAccess(), actor(), 1));
  });

  it("assertCanManageProjectLink refuses a same-org member who does not manage an archived project with 403", async () => {
    const err = await assertCanManageProjectLink(projectDb("ARCHIVED", { memberRole: "MEMBER" }), memberAccess(), actor(), 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
  });

  it("assertCanManageProjectLink conceals a project outside the caller's org as 404", async () => {
    const db = queuedSelectDb({ selects: [[]] }).db;
    await expect(assertCanManageProjectLink(db, memberAccess(), owner(), 1)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("authorizeProjectUpdate lets a manager change the lifecycle of an archived project so it can be reopened", async () => {
    await expect(
      authorizeProjectUpdate(projectDb("ARCHIVED", { manages: true }), memberAccess(), actor(), 1, true),
    ).resolves.toBeUndefined();
  });

  it("authorizeProjectUpdate refuses a non-lifecycle edit of an archived project", async () => {
    await lockCode(authorizeProjectUpdate(projectDb("ARCHIVED", { manages: true }), memberAccess(), actor(), 1, false));
  });

  it("authorizeProjectUpdate still refuses a lifecycle change from someone who cannot manage the project", async () => {
    await expect(
      authorizeProjectUpdate(projectDb("ARCHIVED", { onTeam: true }), memberAccess(), actor(), 1, true),
    ).rejects.toThrow(ForbiddenException);
  });

  it("authorizeTicketMutation refuses ticket writes on a completed project and allows them on an active one", async () => {
    await lockCode(authorizeTicketMutation(projectDb("COMPLETED", { manages: true }), asService(memberAccess()), actor(), 1));
    await expect(
      authorizeTicketMutation(projectDb("ACTIVE", { manages: true }), asService(memberAccess()), actor(), 1),
    ).resolves.toMatchObject({ role: "MANAGER" });
  });

  it("assertProjectVisibleForWrite conceals a non-member as 404 and locks an archived project for a member", async () => {
    await expect(assertProjectVisibleForWrite(projectDb("ACTIVE"), memberAccess(), actor(), 1)).rejects.toThrow(NotFoundException);
    await lockCode(assertProjectVisibleForWrite(projectDb("ARCHIVED", { onTeam: true }), memberAccess(), actor(), 1));
  });
});

describe("ticket decisions", () => {
  const ticketRow = (over: object = {}) => ({
    projectId: 1, projectState: "ACTIVE", projectDeletedAt: null, reachable: true, inScope: true, ...over,
  });
  const ticketDb = (row: object | undefined) => queuedSelectDb({ selects: [row === undefined ? [] : [row]] }).db;

  it("reports why a ticket read was refused so the detail route can audit it", async () => {
    await expect(decideTicketRead(ticketDb(ticketRow({ reachable: false })), memberAccess(), actor(), 5, { projectId: 1 }))
      .resolves.toMatchObject({ kind: "denied", reason: "NO_PROJECT_ACCESS" });
    await expect(decideTicketRead(ticketDb(ticketRow({ inScope: false })), memberAccess(), actor(), 5, { projectId: 1 }))
      .resolves.toMatchObject({ kind: "denied", reason: "RESTRICTED_SCOPE" });
    await expect(decideTicketRead(ticketDb(ticketRow()), memberAccess(), actor(), 5, { projectId: 1 }))
      .resolves.toMatchObject({ kind: "allowed", projectState: "ACTIVE" });
  });

  it("decides a project-less ticket on ticket scope alone instead of a hand-written assignee check", async () => {
    const row = ticketRow({ projectId: null, projectState: null });
    await expect(decideTicketRead(ticketDb(row), memberAccess(), actor(), 5, { projectId: null }))
      .resolves.toMatchObject({ kind: "allowed", projectId: null });
    await expect(decideTicketRead(ticketDb({ ...row, inScope: false }), memberAccess(), actor(), 5, { projectId: null }))
      .resolves.toMatchObject({ kind: "denied", reason: "RESTRICTED_SCOPE" });
  });

  it("assertTicketWriteAccess locks a ticket in an archived project while assertTicketReadAccess still serves it", async () => {
    const archived = ticketRow({ projectState: "ARCHIVED" });
    await expect(assertTicketReadAccess(ticketDb(archived), memberAccess(), actor(), 1, 5)).resolves.toBeUndefined();
    await lockCode(assertTicketWriteAccess(ticketDb(archived), memberAccess(), actor(), 1, 5));
    await expect(assertTicketWriteAccess(ticketDb(ticketRow()), memberAccess(), actor(), 1, 5)).resolves.toBeUndefined();
  });

  it("decideTicketChange gives a covering system job the lock-only arm but still refuses an archived project", async () => {
    const job = actor(systemJobPrincipal("integrations.git.webhook"));
    await expect(
      decideTicketChange(queuedSelectDb({ selects: [[{ state: "ACTIVE" }]] }).db, asService(memberAccess()), job, 1),
    ).resolves.toEqual({ role: "OWNER", bypassesWorkflow: false, rowScoped: false });
    await lockCode(decideTicketChange(queuedSelectDb({ selects: [[{ state: "ARCHIVED" }]] }).db, asService(memberAccess()), job, 1));
  });

  it("decideTicketChange row-scopes a human actor and carries the owner workflow bypass from the decision", async () => {
    await expect(decideTicketChange(projectDb("ACTIVE"), asService(memberAccess()), owner(), 1))
      .resolves.toEqual({ role: "OWNER", bypassesWorkflow: true, rowScoped: true });
    await expect(decideTicketChange(projectDb("ACTIVE"), asService(memberAccess()), actor(), 1))
      .rejects.toThrow(ForbiddenException);
  });
});

describe("authorizeApprovalDecision", () => {
  it("lets the assigned approver decide without project membership", async () => {
    await expect(authorizeApprovalDecision(projectDb("ACTIVE"), memberAccess(), actor(), 1, MID)).resolves.toBeUndefined();
  });

  it("conceals the approval as 404 from someone who is neither the approver nor an approvals manager", async () => {
    await expect(authorizeApprovalDecision(projectDb("ACTIVE"), memberAccess(), actor(), 1, 999)).rejects.toThrow(NotFoundException);
  });

  it("refuses an approvals manager outside the project with 403 and admits one inside it", async () => {
    const managerAccess = principalAccess({ ...MEMBER_STANDING, "build:approvals:manage": "all" });
    await expect(authorizeApprovalDecision(projectDb("ACTIVE"), managerAccess, actor(), 1, 999)).rejects.toThrow(ForbiddenException);
    await expect(
      authorizeApprovalDecision(projectDb("ACTIVE", { onTeam: true }), managerAccess, actor(), 1, 999),
    ).resolves.toBeUndefined();
  });

  it("refuses a decision on an archived project even for the assigned approver", async () => {
    await lockCode(authorizeApprovalDecision(projectDb("ARCHIVED"), memberAccess(), actor(), 1, MID));
  });
});

describe("decideProjectWrite — the per-row write decision for transports that carry a reach predicate", () => {
  const db = (rows: object[]) => queuedSelectDb({ selects: [rows] }).db;

  it("distinguishes missing, denied, locked and allowed", async () => {
    await expect(decideProjectWrite(db([]), ORG_ID, 1, sql`true`)).resolves.toBe("missing");
    await expect(decideProjectWrite(db([{ state: "ACTIVE", reachable: false }]), ORG_ID, 1, sql`false`)).resolves.toBe("denied");
    await expect(decideProjectWrite(db([{ state: "ARCHIVED", reachable: true }]), ORG_ID, 1, sql`true`)).resolves.toBe("locked");
    await expect(decideProjectWrite(db([{ state: "ACTIVE", reachable: true }]), ORG_ID, 1, sql`true`)).resolves.toBe("allowed");
  });
});
