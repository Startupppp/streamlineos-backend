import { NotFoundException } from "@nestjs/common";
import { TeamMembersService } from "./team-members.service";
import type { TeamsService } from "./teams.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { Db } from "../../../db/drizzle.module";

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";
const TEAM_ID = 1;

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
