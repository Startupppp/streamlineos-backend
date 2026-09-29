jest.mock("../../../../common/organization/organization-actor", () => ({
  resolveOrganizationActorsByUserIds: jest.fn(),
}));

import { ProjectsProvisionService } from "./projects-provision.service";
import { resolveOrganizationActorsByUserIds } from "../../../../common/organization/organization-actor";
import { runWithTenantContext } from "../../../../common/tenant/tenant-context";
import type { TenantTx } from "../../../../db/drizzle.types";
import type { Db } from "../../../../db/drizzle.module";

const ORG = "org-sp-provision";
const CREATOR = "user-creator";
const MEMBER = "user-member";

beforeEach(() => {
  jest.resetAllMocks();
  (resolveOrganizationActorsByUserIds as jest.Mock).mockResolvedValue(
    new Map([
      [CREATOR, { membershipId: 1, orgId: ORG, userId: CREATOR, role: "MEMBER", isOwner: false, resolvedVia: "user", organizationPersonId: null }],
      [MEMBER, { membershipId: 2, orgId: ORG, userId: MEMBER, role: "MEMBER", isOwner: false, resolvedVia: "user", organizationPersonId: null }],
    ]),
  );
});

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
  return { db };
}

function makeSvc(db: Db, dispatchEmit = jest.fn().mockResolvedValue(undefined)) {
  return new ProjectsProvisionService(
    db,
    { log: jest.fn() } as never,
    { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } as never,
    { emit: dispatchEmit } as never,
  );
}

describe("ProjectsProvisionService.createProject — withSavepoint wraps member notification (site 5, ticket 38)", () => {
  it("dispatch.emit for project member_added is wrapped in withSavepoint — outerTx.transaction called once when non-creator members are added", async () => {
    const savepointTx = {} as unknown as TenantTx;
    let txCallCount = 0;
    const outerTransaction = jest.fn().mockImplementation(
      async (fn: (sp: TenantTx) => Promise<unknown>) => {
        txCallCount++;
        return fn(savepointTx);
      },
    );
    const outerTx = { transaction: outerTransaction } as unknown as TenantTx;

    const { db } = makeDb();
    const svc = makeSvc(db);

    await runWithTenantContext(
      { orgId: ORG, audience: "INTERNAL" as const, tx: outerTx },
      () => svc.createProject(ORG, CREATOR, { name: "Test Project", memberIds: [CREATOR, MEMBER] }),
    );

    expect(txCallCount).toBe(1);
  });

  it("positive: dispatch.emit is called with build.project.member_added when non-creator members are included", async () => {
    const dispatchEmit = jest.fn().mockResolvedValue(undefined);
    const { db } = makeDb();
    const svc = makeSvc(db, dispatchEmit);

    await svc.createProject(ORG, CREATOR, { name: "Test Project", memberIds: [CREATOR, MEMBER] });

    expect(dispatchEmit).toHaveBeenCalledTimes(1);
    const call = dispatchEmit.mock.calls[0]?.[0] as { eventKey?: string; targetUserIds?: string[] };
    expect(call?.eventKey).toBe("build.project.member_added");
    expect(call?.targetUserIds).toContain(MEMBER);
    expect(call?.targetUserIds).not.toContain(CREATOR);
  });

  it("positive: no notification dispatched when only the creator is a member", async () => {
    const dispatchEmit = jest.fn().mockResolvedValue(undefined);
    const { db } = makeDb();
    const svc = makeSvc(db, dispatchEmit);

    await svc.createProject(ORG, CREATOR, { name: "Test Project" });

    expect(dispatchEmit).not.toHaveBeenCalled();
  });
});
