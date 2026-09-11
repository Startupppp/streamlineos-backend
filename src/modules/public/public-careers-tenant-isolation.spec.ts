import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { PublicCareersService } from "./public-careers.service";

const OWNER_ORG = "org-owner";
const OWNER_SLUG = "owner-co";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? sqlValues(record.value, seen)
      : []),
  ];
}

describe("PublicCareersService — cross-tenant isolation (getOrgJob)", () => {
  it("throws NotFoundException for a job belonging to a different org slug (isolation)", async () => {
    const db = {
      query: {
        organizations: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      },
    } as unknown as Db;

    const svc = new PublicCareersService(db, {} as never);
    await expect(svc.getOrgJob("unknown-org", 99)).rejects.toThrow(NotFoundException);
  });

  it("returns the job for the owning org slug (same-tenant control)", async () => {
    const org = { id: OWNER_ORG, name: "Owner Co", logo: null };
    const job = {
      id: 1,
      orgId: OWNER_ORG,
      title: "Engineer",
      status: "OPEN",
    };
    const db = {
      query: {
        organizations: { findFirst: jest.fn().mockResolvedValue(org) },
        jobPostings: { findFirst: jest.fn().mockResolvedValue(job) },
      },
    } as unknown as Db;

    const svc = new PublicCareersService(db, {} as never);
    const result = await svc.getOrgJob(OWNER_SLUG, 1);
    expect(result).toMatchObject({ job: { id: 1 } });
  });
});

describe("PublicCareersService.listOrgJobs — cross-tenant isolation", () => {
  it("scopes job listing to the resolved org (isolation)", async () => {
    const org = { id: OWNER_ORG, name: "Owner Co", logo: null, industry: null };
    const where = jest.fn().mockReturnValue({
      orderBy: jest.fn().mockResolvedValue([]),
    });
    const db = {
      query: {
        organizations: { findFirst: jest.fn().mockResolvedValue(org) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where }),
      }),
    } as unknown as Db;

    const svc = new PublicCareersService(db, {} as never);
    const result = await svc.listOrgJobs(OWNER_SLUG);

    expect(result.jobs).toHaveLength(0);
    if (where.mock.calls[0]) {
      const leafValues = sqlValues(where.mock.calls[0][0]);
      expect(leafValues).toContain(OWNER_ORG);
    }
  });
});
