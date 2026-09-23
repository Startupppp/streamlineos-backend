jest.mock("../../../common/organization/organization-actor", () => ({
  assertOrganizationActor: jest.fn(),
}));

import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import { assertOrganizationActor } from "../../../common/organization/organization-actor";
import type { OrganizationActor } from "../../../common/organization/organization-actor";
import { TeamMembersService } from "./team-members.service";
import type { TeamsService } from "./teams.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { Db } from "../../../db/drizzle.module";

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";
const TEAM_ID = 1;

const dialect = new PgDialect();

function render(value: unknown): string {
  return dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

const mockActor: OrganizationActor = {
  orgId: OWNER_ORG,
  membershipId: 42,
  userId: "user-target",
  organizationPersonId: null,
  role: "MEMBER",
  isOwner: false,
  resolvedVia: "user",
};

function makeDb(rows: unknown[] = [], whereCalls?: unknown[]): Db {
  const countLimit = jest.fn().mockResolvedValue([{ total: 0 }]);
  const countWhere = jest.fn().mockReturnValue({ limit: countLimit });
  const countFrom = jest.fn().mockReturnValue({ where: countWhere });

  const limit = jest.fn().mockResolvedValue(rows);
  const offset = jest.fn().mockReturnValue({ ...makeListChainEnd(rows) });
  const where = jest.fn().mockImplementation((cond: unknown) => {
    whereCalls?.push(cond);
    return { limit, offset };
  });
  const innerJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ innerJoin });

  let callIndex = 0;
  return {
    select: jest.fn().mockImplementation(() => {
      callIndex++;
      if (callIndex % 2 === 0) return { from: countFrom };
      return { from };
    }),
    insert: jest.fn(),
    delete: jest.fn(),
    update: jest.fn(),
  } as unknown as Db;
}

function makeListChainEnd(rows: unknown[]) {
  return { limit: jest.fn().mockResolvedValue(rows) };
}

function sqlValues(val: unknown, seen = new Set<object>()): unknown[] {
  if (val === null || val === undefined || typeof val === "string" || typeof val === "number" || typeof val === "boolean") return [val];
  if (Array.isArray(val)) return val.flatMap((v) => sqlValues(v, seen));
  if (typeof val !== "object" || seen.has(val as object)) return [];
  seen.add(val as object);
  const rec = val as Record<string, unknown>;
  return [
    ...(rec["queryChunks"] ? sqlValues(rec["queryChunks"], seen) : []),
    ...(Object.prototype.hasOwnProperty.call(rec, "value") ? sqlValues(rec["value"], seen) : []),
  ];
}

function makeTeams(throwForOrg?: string): TeamsService {
  return {
    loadTeam: jest.fn().mockImplementation((orgId: string) => {
      if (throwForOrg && orgId === throwForOrg) throw new NotFoundException("Team not found");
      return Promise.resolve({ id: TEAM_ID, orgId, name: "Alpha Team" });
    }),
  } as unknown as TeamsService;
}

const mockAudit = { log: jest.fn() } as unknown as AuditService;

beforeEach(() => jest.resetAllMocks());

describe("TeamMembersService — cross-tenant isolation (BOLA)", () => {
  it("listTeamMembers throws NotFoundException when team belongs to a different org (DENY)", async () => {
    const db = makeDb([]);
    const teams = makeTeams(ATTACKER_ORG);
    const svc = new TeamMembersService(db, teams, mockAudit);
    await expect(
      svc.listTeamMembers(ATTACKER_ORG, TEAM_ID, { pageSize: 20 }),
    ).rejects.toThrow(NotFoundException);
  });

  it("removeMember throws NotFoundException when team belongs to a different org — cross-org isolation", async () => {
    const db = makeDb([]);
    const teams = makeTeams(ATTACKER_ORG);
    const svc = new TeamMembersService(db, teams, mockAudit);
    await expect(
      svc.removeMember(ATTACKER_ORG, "actor-1", TEAM_ID, "member-1"),
    ).rejects.toThrow(NotFoundException);
  });

  it("updateMemberRole throws NotFoundException when team belongs to a different org — cross-org isolation", async () => {
    const db = makeDb([]);
    const teams = makeTeams(ATTACKER_ORG);
    const svc = new TeamMembersService(db, teams, mockAudit);
    await expect(
      svc.updateMemberRole(ATTACKER_ORG, "actor-1", TEAM_ID, "member-1", { role: "lead" }),
    ).rejects.toThrow(NotFoundException);
  });
});

function makeAddMemberDb(buildMemberFound: boolean, insertedRow: unknown): Db {
  const limit = jest.fn().mockResolvedValue(buildMemberFound ? [{ id: 99 }] : []);
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where });
  const returning = jest.fn().mockResolvedValue(insertedRow ? [insertedRow] : []);
  const values = jest.fn().mockReturnValue({ returning });
  return {
    select: jest.fn().mockReturnValue({ from }),
    insert: jest.fn().mockReturnValue({ values }),
  } as unknown as Db;
}

function makeCaptureWhereDb(capture: { value: unknown }, buildMemberFound: boolean, insertedRow: unknown): Db {
  const limit = jest.fn().mockResolvedValue(buildMemberFound ? [{ id: 99 }] : []);
  const where = jest.fn().mockImplementation((cond: unknown) => {
    capture.value = cond;
    return { limit };
  });
  const from = jest.fn().mockReturnValue({ where });
  const returning = jest.fn().mockResolvedValue(insertedRow ? [insertedRow] : []);
  const values = jest.fn().mockReturnValue({ returning });
  return {
    select: jest.fn().mockReturnValue({ from }),
    insert: jest.fn().mockReturnValue({ values }),
  } as unknown as Db;
}

const insertedMemberRow = {
  id: 1,
  orgId: OWNER_ORG,
  teamId: TEAM_ID,
  membershipId: 42,
  role: "member",
  joinedAt: new Date(),
};

describe("TeamMembersService.addMember — single actor resolution", () => {
  beforeEach(() => {
    jest.mocked(assertOrganizationActor).mockResolvedValue(mockActor);
  });

  it("resolves assertOrganizationActor exactly once for the target userId (failing before fix: called twice)", async () => {
    const db = makeAddMemberDb(true, insertedMemberRow);
    const svc = new TeamMembersService(db, makeTeams(), mockAudit);
    await svc.addMember(OWNER_ORG, "actor-user", TEAM_ID, { userId: "user-target" });
    expect(jest.mocked(assertOrganizationActor)).toHaveBeenCalledTimes(1);
  });

  it("passes the caller-supplied userId to assertOrganizationActor with the correct orgId", async () => {
    const db = makeAddMemberDb(true, insertedMemberRow);
    const svc = new TeamMembersService(db, makeTeams(), mockAudit);
    await svc.addMember(OWNER_ORG, "actor-user", TEAM_ID, { userId: "user-target" });
    expect(jest.mocked(assertOrganizationActor)).toHaveBeenCalledWith(
      expect.anything(),
      OWNER_ORG,
      { kind: "user", userId: "user-target" },
    );
  });
});

describe("TeamMembersService.addMember — gated on Build membership, scoped to the org (not the workspace)", () => {
  beforeEach(() => {
    jest.mocked(assertOrganizationActor).mockResolvedValue(mockActor);
  });

  it("Build membership WHERE includes org_id and membership_id, not any workspace column", async () => {
    const capture: { value: unknown } = { value: undefined };
    const db = makeCaptureWhereDb(capture, true, insertedMemberRow);
    const svc = new TeamMembersService(db, makeTeams(), mockAudit);
    await svc.addMember(OWNER_ORG, "actor-user", TEAM_ID, { userId: "user-target" });

    const rendered = render(capture.value);
    expect(rendered).toContain("org_id");
    expect(rendered).toContain("membership_id");
    expect(rendered).not.toContain("pm_workspace_id");
  });

  it("the Build membership check binds the actor's membershipId and the org as parameters", async () => {
    const capture: { value: unknown } = { value: undefined };
    const db = makeCaptureWhereDb(capture, true, insertedMemberRow);
    const svc = new TeamMembersService(db, makeTeams(), mockAudit);
    await svc.addMember(OWNER_ORG, "actor-user", TEAM_ID, { userId: "user-target" });

    const query = dialect.sqlToQuery(capture.value as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(query.params).toContain(mockActor.membershipId);
    expect(query.params).toContain(OWNER_ORG);
  });

  it("rejects with a Build-members message, not a workspace message, when the actor has no Build membership row", async () => {
    const db = makeAddMemberDb(false, insertedMemberRow);
    const svc = new TeamMembersService(db, makeTeams(), mockAudit);

    await expect(
      svc.addMember(OWNER_ORG, "actor-user", TEAM_ID, { userId: "user-target" }),
    ).rejects.toThrow("Only Build members can be added to a team. Add this person on the Build members page first.");
  });

  it("succeeds when the actor has a Build membership row for the org", async () => {
    const db = makeAddMemberDb(true, insertedMemberRow);
    const svc = new TeamMembersService(db, makeTeams(), mockAudit);

    await expect(
      svc.addMember(OWNER_ORG, "actor-user", TEAM_ID, { userId: "user-target" }),
    ).resolves.toMatchObject({ id: insertedMemberRow.id });
  });
});
