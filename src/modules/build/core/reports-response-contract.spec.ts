import type { Db } from "../../../db/drizzle.module";
import { ProjectsAnalyticsService } from "./projects-analytics.service";
import { CacheService } from "../../../common/cache/cache.service";
import { resourceAllocationItemSchema } from "./dto/build-reports-response.schemas";

function passThroughCache() {
  return {
    cachedVersioned: <T>(_namespace: string, _key: string, fetcher: () => Promise<T>) => fetcher(),
  } as unknown as CacheService;
}


function makeAllocationDb(): Db {
  return {
    execute: jest.fn().mockResolvedValue([
      { assigneeId: "user-1", projectId: 1, open: "4" },
      { assigneeId: "user-1", projectId: 2, open: "2" },
    ]),
    query: {
      projects: {
        findMany: jest.fn().mockResolvedValue([
          { id: 1, name: "Payments", key: "PAY" },
          { id: 2, name: "Ledger", key: "LED" },
        ]),
      },
      users: {
        findMany: jest.fn().mockResolvedValue([
          { id: "user-1", name: null, email: "priya@example.com", image: null },
        ]),
      },
    },
  } as unknown as Db;
}

describe("resourceAllocation contract", () => {
  it("parses the object the service actually returns, where the previous all-optional schema declared five keys the service never emits", async () => {
    const svc = new ProjectsAnalyticsService(makeAllocationDb(), passThroughCache());

    const [item] = await svc.resourceAllocation("org-1");

    expect(() => resourceAllocationItemSchema.parse(item)).not.toThrow();
  });

  it("keeps user, totalOpen and byProject, the three keys a passthrough-only schema would have stripped the moment passthrough was removed", async () => {
    const svc = new ProjectsAnalyticsService(makeAllocationDb(), passThroughCache());

    const [item] = await svc.resourceAllocation("org-1");
    const parsed = resourceAllocationItemSchema.parse(item);

    expect(parsed.user.id).toBe("user-1");
    expect(parsed.totalOpen).toBe(6);
    expect(parsed.byProject).toHaveLength(2);
    expect(parsed.byProject[0]?.projectKey).toBe("PAY");
  });

  it("allows a null display name and image, because both columns on users are nullable", async () => {
    const svc = new ProjectsAnalyticsService(makeAllocationDb(), passThroughCache());

    const [item] = await svc.resourceAllocation("org-1");

    expect(resourceAllocationItemSchema.parse(item).user.name).toBeNull();
  });

  it("rejects an open count arriving as the string postgres returns for COUNT, so an uncoerced aggregate cannot reach the client", () => {
    expect(() =>
      resourceAllocationItemSchema.parse({
        user: { id: "user-1", name: null, email: "priya@example.com", image: null },
        totalOpen: 6,
        byProject: [{ projectId: 1, projectName: "Payments", projectKey: "PAY", open: "4" }],
      }),
    ).toThrow();
  });
});
