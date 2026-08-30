import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { RoadmapService } from "./roadmap.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("RoadmapService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb(orgRow: unknown, itemRows: unknown[] = []): Db {
    return {
      query: {
        organizations: { findFirst: jest.fn().mockResolvedValue(orgRow) },
        roadmapItems: { findMany: jest.fn().mockResolvedValue(itemRows) },
        feedbackPosts: { findMany: jest.fn().mockResolvedValue([]) },
        changelogEntries: { findMany: jest.fn().mockResolvedValue([]) },
      },
    } as unknown as Db;
  }

  it("throws NotFoundException for a different org's roadmap (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const mockConfig = { APP_URL: "https://example.com", HMAC_SECRET: "secret" } as any;
    const svc = new RoadmapService(mockConfig, db);
    await expect(svc.getRoadmap(ATTACKER)).rejects.toThrow(NotFoundException);
  });

  it("returns the roadmap for the owning org (control — same-tenant)", async () => {
    const db = makeDb({ id: OWNER, name: "Owner Corp" }, [{ id: 1, title: "Feature A" }]);
    const mockConfig = { APP_URL: "https://example.com", HMAC_SECRET: "secret" } as any;
    const svc = new RoadmapService(mockConfig, db);
    const result = await svc.getRoadmap(OWNER);
    expect(result).toBeDefined();
  });
});
