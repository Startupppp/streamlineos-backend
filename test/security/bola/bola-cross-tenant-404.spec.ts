import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { RecruitmentJobsService } from "src/modules/hr/recruitment/recruitment-jobs.service";
import type { CacheService } from "src/common/cache/cache.service";
import type { PlanLimitsService } from "src/modules/billing/core/plan-limits.service";
import type { Db } from "src/db/drizzle.module";

/**
 * A cross-tenant miss returns 404. A 403 on another organization's id confirms
 * the record exists and turns the probe into an existence oracle, so these
 * assert the type of the thrown exception, not merely that one was thrown.
 */

const stub = <T,>() => ({}) as T;

const ORG_ATTACKER = "org-b-attacker";
const ORG_VICTIM = "org-a-victim";
const VICTIM_JOB_ID = 4242;
const TARGET_RECRUITER = "recruiter-in-org-a";

/** Every value bound into a Drizzle SQL fragment, however deeply nested. */
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

interface Probe {
  readonly service: RecruitmentJobsService;
  readonly lookupWhere: unknown[];
  readonly deleteWhere: unknown[];
}

/**
 * `jobRow` is what the ownership lookup returns. `null` models the cross-tenant
 * case: the job exists, but not in the caller's organization, so an org-bound
 * lookup finds nothing.
 */
function makeProbe(jobRow: { id: number } | undefined): Probe {
  const lookupWhere: unknown[] = [];
  const deleteWhere: unknown[] = [];
  const db = {
    query: {
      jobPostings: {
        findFirst: jest.fn().mockImplementation((opts: unknown) => {
          const where = (opts as { where?: unknown } | undefined)?.where;
          if (where !== undefined) lookupWhere.push(where);
          return Promise.resolve(jobRow);
        }),
      },
    },
    delete: jest.fn().mockReturnValue({
      where: jest.fn().mockImplementation((w: unknown) => {
        deleteWhere.push(w);
        return Promise.resolve(undefined);
      }),
    }),
  } as unknown as Db;

  const cache = {
    cachedVersioned: jest.fn(),
    invalidateNamespace: jest.fn().mockResolvedValue(undefined),
  } as unknown as CacheService;
  const planLimits = {
    assertWithinLimit: jest.fn().mockResolvedValue(undefined),
  } as unknown as PlanLimitsService;

  return {
    service: new RecruitmentJobsService(db, cache, planLimits, stub<ConstructorParameters<typeof RecruitmentJobsService>[3]>(), stub<ConstructorParameters<typeof RecruitmentJobsService>[4]>()),
    lookupWhere,
    deleteWhere,
  };
}

describe("BOLA probe — DELETE /hr/recruitment/jobs/:jobId/recruiters", () => {
  beforeEach(() => jest.clearAllMocks());

  it("CROSS-TENANT-MISS: org-B removing a recruiter from org-A's job is refused", async () => {
    const { service } = makeProbe(undefined);
    await expect(
      service.removeRecruiter(ORG_ATTACKER, VICTIM_JOB_ID, { userId: TARGET_RECRUITER }),
    ).rejects.toThrow(NotFoundException);
  });

  it("EXISTENCE-ORACLE-GUARD: the refusal is NotFound, never Forbidden", async () => {
    const { service } = makeProbe(undefined);
    const thrown = await service
      .removeRecruiter(ORG_ATTACKER, VICTIM_JOB_ID, { userId: TARGET_RECRUITER })
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect(thrown).not.toBeInstanceOf(ForbiddenException);
  });

  it("NO-WRITE-ON-MISS: nothing is deleted when the job is not the caller's", async () => {
    const { service, deleteWhere } = makeProbe(undefined);
    await service
      .removeRecruiter(ORG_ATTACKER, VICTIM_JOB_ID, { userId: TARGET_RECRUITER })
      .catch(() => undefined);
    expect(deleteWhere).toEqual([]);
  });

  it("PREDICATE-SCOPE: the ownership lookup binds the caller's org and the job id", async () => {
    const { service, lookupWhere } = makeProbe(undefined);
    await service
      .removeRecruiter(ORG_ATTACKER, VICTIM_JOB_ID, { userId: TARGET_RECRUITER })
      .catch(() => undefined);
    expect(lookupWhere).toHaveLength(1);
    const bound = sqlValues(lookupWhere[0]);
    expect(bound).toContain(ORG_ATTACKER);
    expect(bound).toContain(VICTIM_JOB_ID);
    expect(bound).not.toContain(ORG_VICTIM);
  });

  it("SAME-TENANT: the owner's own job still deletes, so the guard is not a blanket denial", async () => {
    const { service, deleteWhere } = makeProbe({ id: VICTIM_JOB_ID });
    await expect(
      service.removeRecruiter(ORG_VICTIM, VICTIM_JOB_ID, { userId: TARGET_RECRUITER }),
    ).resolves.toEqual({ success: true });
    expect(deleteWhere).toHaveLength(1);
    const bound = sqlValues(deleteWhere[0]);
    expect(bound).toContain(VICTIM_JOB_ID);
    expect(bound).toContain(TARGET_RECRUITER);
  });
});
