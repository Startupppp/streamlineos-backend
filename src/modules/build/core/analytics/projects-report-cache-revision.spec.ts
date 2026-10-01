import { Test } from "@nestjs/testing";
import { CacheService } from "../../../../common/cache/cache.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { ProjectsReportsService } from "./projects-reports.service";
import { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { projects } from "../../../../db/schema";
import { projectAccessRow } from "../project-crud/__tests__/project-access-doubles";

describe("Build report cache revision", () => {
  it("reuses an unchanged report but refetches after a committed project revision", async () => {
    let reportRevision = 0;
    let rows: Array<{ id: number; title: string; points: number }> = [];
    const entries = new Map<string, unknown>();
    const cached = jest.fn(async (key: string, fetcher: () => Promise<unknown>) => {
      if (entries.has(key)) return entries.get(key);
      const value = await fetcher();
      entries.set(key, value);
      return value;
    });
    const where = jest.fn(async () => rows);
    const query = { where, innerJoin: jest.fn(), limit: jest.fn() };
    query.innerJoin.mockReturnValue(query);
    query.limit.mockReturnValue(query);
    const module = await Test.createTestingModule({
      providers: [
        ProjectsReportsService,
        { provide: DRIZZLE, useValue: {
          query: { projects: { findFirst: async () => ({ id: 1, reportRevision }) } },
          select: () => ({
            from: (table: unknown) =>
              table === projects
                ? { where: () => ({ limit: async () => [projectAccessRow()] }) }
                : query,
          }),
        } },
        { provide: CacheService, useValue: { cached } },
        { provide: AccessService, useValue: { scopeFor: async () => "all" } },
      ],
    }).compile();
    const reports = module.get(ProjectsReportsService);
    const actor: CurrentUserContext = {
      orgId: "org-a", userId: "user-a", isOrgOwner: true, role: "OWNER",
      sessionId: "session-a", tokenScopes: null,
      principal: { kind: "human-session", membershipId: 1, isOrgOwner: true },
    };
    expect((await reports.criticalPath(actor, 1)).nodeCount).toBe(0);
    await reports.criticalPath(actor, 1);
    expect(where).toHaveBeenCalledTimes(1);
    rows = [{ id: 7, title: "Committed ticket", points: 3 }];
    reportRevision++;
    expect((await reports.criticalPath(actor, 1)).nodeCount).toBe(1);
    expect(cached.mock.calls[2]?.[0]).not.toBe(cached.mock.calls[0]?.[0]);
    await module.close();
  });
});
