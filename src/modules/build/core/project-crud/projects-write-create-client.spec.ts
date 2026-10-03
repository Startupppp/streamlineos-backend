jest.mock("../../../email/app-url", () => ({ appUrl: "https://test.example.com" }));

const CREATOR = "user-xyz";
const CLIENT_USER = "client-user-1";
const CLIENT_MEMBERSHIP_ID = 5;

jest.mock("../../../../common/organization/organization-actor", () => ({
  resolveOrganizationActorsByUserIds: jest.fn().mockResolvedValue(
    new Map([
      [CREATOR, { membershipId: 1, organizationPersonId: "person-1", orgId: "org-abc", userId: CREATOR, role: "MEMBER", isOwner: false, resolvedVia: "user" }],
      [CLIENT_USER, { membershipId: CLIENT_MEMBERSHIP_ID, organizationPersonId: null, orgId: "org-abc", userId: CLIENT_USER, role: "MEMBER", isOwner: false, resolvedVia: "user" }],
    ]),
  ),
}));

import { ProjectsProvisionService } from "./projects-provision.service";
import type { Db } from "../../../../db/drizzle.module";

const ORG = "org-abc";

function makeDb() {
  const txInsert = {
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([{ id: 1, orgId: ORG, key: "TST-001", name: "Test Project" }]),
  };
  const tx = {
    execute: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnValue(txInsert),
  };
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    }),
    transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  } as unknown as Db;
  return { db, tx, txInsert };
}

function crmClientWrites(execute: jest.Mock): unknown[][] {
  return execute.mock.calls
    .map(([statement]) => (statement as { queryChunks: unknown[] }).queryChunks)
    .filter((chunks) =>
      chunks.some(
        (chunk) =>
          typeof chunk === "object" &&
          chunk !== null &&
          Array.isArray((chunk as { value?: unknown }).value) &&
          (chunk as { value: string[] }).value.join("").includes("crm_client_id"),
      ),
    );
}

function makeSvc(db: Db) {
  return new ProjectsProvisionService(
    db,
    { log: jest.fn() } as never,
    { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } as never,
    { emit: jest.fn().mockResolvedValue(undefined) } as never,
  );
}

describe("ProjectsProvisionService.createProject — clientId is the CRM client id", () => {
  it("records a numeric clientId as crm_client_id and no longer resolves it as a membership", async () => {
    const { db, tx, txInsert } = makeDb();
    const svc = makeSvc(db);

    await svc.createProject(ORG, CREATOR, { name: "Test Project", clientId: "42" });

    const insertedRow = txInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertedRow).toBeDefined();
    expect(insertedRow["clientMembershipId"]).toBeUndefined();
    const writes = crmClientWrites(tx.execute);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain(42);
  });

  it("writes no crm_client_id when clientId is not provided", async () => {
    const { db, tx, txInsert } = makeDb();
    const svc = makeSvc(db);

    await svc.createProject(ORG, CREATOR, { name: "Test Project" });

    const insertedRow = txInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertedRow).toBeDefined();
    expect(insertedRow["clientMembershipId"]).toBeUndefined();
    expect(crmClientWrites(tx.execute)).toEqual([]);
  });

  it("writes no crm_client_id for a clientId that is not a positive integer", async () => {
    const { db, tx } = makeDb();
    const svc = makeSvc(db);

    await svc.createProject(ORG, CREATOR, { name: "Test Project", clientId: CLIENT_USER });

    expect(crmClientWrites(tx.execute)).toEqual([]);
  });
});
