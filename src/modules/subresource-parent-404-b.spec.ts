import { NotFoundException } from "@nestjs/common";
import { PartyRolesService } from "./party/party-roles.service";
import { SubjectService } from "./party/subject.service";
import { SupportAiService } from "./support/core/support-ai.service";
import { SupportCustomFieldsService } from "./support/core/support-custom-fields.service";
import { SupportWorkspaceService } from "./support/core/support-workspace.service";
import { ProfilesService } from "./payroll/runs/profiles.service";
import type { Db } from "../db/drizzle.module";

const stub = <T,>() => ({}) as T;
const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

function makeDb(parent: Record<string, unknown> | undefined) {
  const rows: unknown[] = [];
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const key of ["from", "where", "orderBy", "limit", "offset", "innerJoin", "leftJoin", "groupBy"])
    chain[key] = jest.fn(self);
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
  const findFirst = jest.fn().mockResolvedValue(parent);
  const findMany = jest.fn().mockResolvedValue(rows);
  return {
    query: {
      businessParties: { findFirst },
      supportTickets: { findFirst },
      supportAiSuggestions: { findMany },
      supportTicketWatchers: { findMany },
      organizationMembers: { findFirst },
    },
    select: jest.fn(self),
  } as unknown as Db;
}

const salaryRepo = {
  findByUser: jest.fn().mockResolvedValue({ active: null, components: [], history: [] }),
  historyByUser: jest.fn().mockResolvedValue([]),
} as unknown as ConstructorParameters<typeof ProfilesService>[2];

describe("a sub-resource read whose parent id is outside the caller's org answers 404 (batch b)", () => {
  const cases: Array<[string, (db: Db, org: string) => Promise<unknown>]> = [
    [
      "GET /party/parties/:partyId/roles",
      (db, org) =>
        new PartyRolesService(
          db,
          stub<ConstructorParameters<typeof PartyRolesService>[1]>(),
          stub<ConstructorParameters<typeof PartyRolesService>[2]>(),
        ).listRoles(org, "p-1"),
    ],
    [
      "GET /party/parties/:partyId/subjects",
      (db, org) =>
        new SubjectService(
          db,
          stub<ConstructorParameters<typeof SubjectService>[1]>(),
          stub<ConstructorParameters<typeof SubjectService>[2]>(),
        ).listForParty(org, "p-1"),
    ],
    [
      "GET /support/:ticketId/ai/suggestions",
      (db, org) =>
        new SupportAiService(
          db,
          stub<ConstructorParameters<typeof SupportAiService>[1]>(),
          stub<ConstructorParameters<typeof SupportAiService>[2]>(),
          stub<ConstructorParameters<typeof SupportAiService>[3]>(),
          stub<ConstructorParameters<typeof SupportAiService>[4]>(),
        ).listSuggestions(org, 1),
    ],
    [
      "GET /support/:ticketId/custom-fields",
      (db, org) => new SupportCustomFieldsService(db).getFieldValues(org, 1),
    ],
    [
      "GET /support/:supportTicketId/watchers",
      (db, org) => new SupportWorkspaceService(db).listWatchers(org, 1),
    ],
    [
      "GET /payroll/employees/:employeeUserId",
      (db, org) =>
        new ProfilesService(db, stub<ConstructorParameters<typeof ProfilesService>[1]>(), salaryRepo).getProfile(
          org,
          "u-1",
        ),
    ],
    [
      "GET /payroll/employees/:employeeUserId/history",
      (db, org) =>
        new ProfilesService(db, stub<ConstructorParameters<typeof ProfilesService>[1]>(), salaryRepo).listHistory(
          org,
          "u-1",
        ),
    ],
  ];

  it.each(cases)("%s refuses a parent the org does not own", async (_name, call) => {
    await expect(call(makeDb(undefined), ATTACKER_ORG)).rejects.toThrow(NotFoundException);
  });

  it.each(cases)("%s still runs for a parent the org owns (control)", async (_name, call) => {
    await expect(call(makeDb({ id: 1, partyId: "p-1" }), OWNER_ORG)).resolves.toBeDefined();
  });
});
