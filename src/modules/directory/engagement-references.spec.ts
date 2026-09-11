/**
 * The engagement reference guard.
 *
 * `assertUpdateReferences` is the only thing proving that the org unit, manager
 * engagement, job role and job level an update patch names belong to the
 * CALLER's organization and are live. Neutering it to `return;` left all 147
 * directory tests green, so nothing observed it at all — this file does.
 */
const mockAssertActiveOrgUnit = jest.fn();

jest.mock("../../common/org/sync-org-unit-placement", () => ({
  assertActiveOrgUnit: (...args: unknown[]) => mockAssertActiveOrgUnit(...args),
}));

import { BadRequestException } from "@nestjs/common";
import { assertUpdateReferences } from "./lib/engagement-references";
import type { EngagementReferenceDeps } from "./lib/engagement-references";
import type { Db } from "../../db/drizzle.module";
import type { UpdateEngagementInput } from "./dto/directory.schemas";

const ORG = "org-caller";
const OTHER_ORG = "org-attacker";
const ENGAGEMENT_ID = "eng-1";
const WORKER_ID = "wrk-1";

/** Pull every bound literal out of a drizzle SQL tree, however nested. */
function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((v) => sqlValues(v, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : []),
  ];
}

/** Each `select(...).from(...).where(...).limit(1)` consumes one queued result. */
function makeDeps(results: unknown[][]) {
  const queue = [...results];
  const whereArgs: unknown[] = [];
  const db = {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((cond: unknown) => {
          whereArgs.push(cond);
          return { limit: jest.fn().mockResolvedValue(queue.shift() ?? []) };
        }),
      }),
    })),
  } as unknown as Db;
  return { deps: { db } satisfies EngagementReferenceDeps, whereArgs };
}

function patch(over: Partial<UpdateEngagementInput>): UpdateEngagementInput {
  return { expectedVersion: 1, ...over } as UpdateEngagementInput;
}

describe("assertUpdateReferences", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertActiveOrgUnit.mockResolvedValue(undefined);
  });

  it("passes a patch that references nothing", async () => {
    const { deps } = makeDeps([]);
    await expect(
      assertUpdateReferences(deps, ORG, ENGAGEMENT_ID, WORKER_ID, patch({ workerType: "PART_TIME" })),
    ).resolves.toBeUndefined();
    expect(mockAssertActiveOrgUnit).not.toHaveBeenCalled();
  });

  it("checks each named org unit against the caller's org, and skips the unset ones", async () => {
    const { deps } = makeDeps([]);
    await assertUpdateReferences(
      deps,
      ORG,
      ENGAGEMENT_ID,
      WORKER_ID,
      patch({ departmentId: 11, teamId: 12 }),
    );

    expect(mockAssertActiveOrgUnit).toHaveBeenCalledTimes(2);
    const kinds = mockAssertActiveOrgUnit.mock.calls.map((c) => c[3]);
    expect(kinds.sort()).toEqual(["DEPARTMENT", "TEAM"]);
    for (const call of mockAssertActiveOrgUnit.mock.calls) {
      expect(call[1]).toBe(ORG);
    }
  });

  it("refuses an engagement that names itself as its own manager", async () => {
    const { deps } = makeDeps([]);
    await expect(
      assertUpdateReferences(
        deps,
        ORG,
        ENGAGEMENT_ID,
        WORKER_ID,
        patch({ managerEngagementId: ENGAGEMENT_ID }),
      ),
    ).rejects.toThrow(/cannot manage itself/);
  });

  it("refuses a manager engagement that does not resolve inside the caller's org", async () => {
    // Empty result: the row exists in OTHER_ORG, so the org-scoped lookup misses.
    const { deps, whereArgs } = makeDeps([[]]);
    await expect(
      assertUpdateReferences(
        deps,
        ORG,
        ENGAGEMENT_ID,
        WORKER_ID,
        patch({ managerEngagementId: "eng-in-other-org" }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    // The lookup must be scoped to the caller, not to the attacker's org.
    expect(sqlValues(whereArgs[0])).toContain(ORG);
    expect(sqlValues(whereArgs[0])).not.toContain(OTHER_ORG);
  });

  it("refuses a manager engagement belonging to the same worker", async () => {
    const { deps } = makeDeps([[{ workerId: WORKER_ID }]]);
    await expect(
      assertUpdateReferences(
        deps,
        ORG,
        ENGAGEMENT_ID,
        WORKER_ID,
        patch({ managerEngagementId: "eng-2" }),
      ),
    ).rejects.toThrow(/Invalid manager engagement/);
  });

  it("accepts a manager engagement on a different worker in the same org", async () => {
    const { deps } = makeDeps([[{ workerId: "wrk-other" }]]);
    await expect(
      assertUpdateReferences(
        deps,
        ORG,
        ENGAGEMENT_ID,
        WORKER_ID,
        patch({ managerEngagementId: "eng-2" }),
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses a job role that does not resolve in the caller's org", async () => {
    const { deps, whereArgs } = makeDeps([[]]);
    await expect(
      assertUpdateReferences(deps, ORG, ENGAGEMENT_ID, WORKER_ID, patch({ jobRoleId: 42 })),
    ).rejects.toThrow(/Invalid job role/);
    expect(sqlValues(whereArgs[0])).toContain(ORG);
  });

  it("refuses a job level that does not resolve in the caller's org", async () => {
    const { deps, whereArgs } = makeDeps([[]]);
    await expect(
      assertUpdateReferences(deps, ORG, ENGAGEMENT_ID, WORKER_ID, patch({ jobLevelId: 7 })),
    ).rejects.toThrow(/Invalid job level/);
    expect(sqlValues(whereArgs[0])).toContain(ORG);
  });

  it("refuses employmentTypeId, which the current catalog does not back", async () => {
    const { deps } = makeDeps([]);
    await expect(
      assertUpdateReferences(deps, ORG, ENGAGEMENT_ID, WORKER_ID, patch({ employmentTypeId: 3 })),
    ).rejects.toThrow(/Employment type IDs are not supported/);
  });
});
