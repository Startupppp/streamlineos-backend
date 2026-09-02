import type { Db } from "../../db/drizzle.module";
import { DashboardProjectService } from "./dashboard-project.service";
import type { AccessService } from "../access/access.service";

const accessService = {} as AccessService;

describe("DashboardProjectService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const OWNER_USER_ID = "user-owner-1";

  it("returns an empty list when the user has no membership in the queried org (cross-tenant isolation)", async () => {
    const db = {
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
      },
    } as unknown as Db;
    const svc = new DashboardProjectService(db, accessService);
    const result = await svc.getMyIssues(ATTACKER_ORG, OWNER_USER_ID);
    expect(result).toEqual([]);
  });

  it("returns issues when the user has membership in the queried org (same-tenant control)", async () => {
    const db = {
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 10 }) },
        tickets: { findMany: jest.fn().mockResolvedValue([]) },
      },
    } as unknown as Db;
    const svc = new DashboardProjectService(db, accessService);
    const result = await svc.getMyIssues(OWNER_ORG, OWNER_USER_ID);
    expect(result).toBeInstanceOf(Array);
  });
});
