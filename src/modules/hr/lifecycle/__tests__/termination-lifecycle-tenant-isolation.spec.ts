import { NotFoundException } from "@nestjs/common";
import { TerminationLifecycleService } from "../termination-lifecycle.service";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { AutomationService } from "../../automation/automation.service";
import type { HrAutomationEngineService } from "../automations/hr-automation-engine.service";

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
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const ATTACKER_ORG = "org-attacker-term";
const VICTIM_ORG = "org-victim-term";

const audit = { log: jest.fn(), logCritical: jest.fn() } as unknown as AuditService;
const cache = { invalidate: jest.fn() } as unknown as CacheService;
const automation = { runAutomationsForEvent: jest.fn() } as unknown as AutomationService;
const hrAutomation = { emit: jest.fn() } as unknown as HrAutomationEngineService;

function makeDb(terminationRow?: Record<string, unknown>): { db: Db; findFirst: jest.Mock } {
  const findFirst = jest.fn().mockResolvedValue(terminationRow ?? null);
  const db = {
    query: {
      terminations: { findFirst },
      users: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
    transaction: jest.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ affected: 1 }]) }),
        }),
      }),
    ),
  } as unknown as Db;
  return { db, findFirst };
}

describe("TerminationLifecycleService — cross-tenant isolation", () => {
  it("submit throws NotFoundException when termination does not exist in the requesting org (cross-tenant probe returns 404)", async () => {
    const { db } = makeDb(null);
    const svc = new TerminationLifecycleService(db, audit, cache, automation, hrAutomation);

    await expect(svc.submit(ATTACKER_ORG, "actor-1", 999)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("submit scopes the lookup to requesting org — attacker org cannot access victim org termination (BOLA prevention)", async () => {
    const { db, findFirst } = makeDb(null);
    const svc = new TerminationLifecycleService(db, audit, cache, automation, hrAutomation);

    await expect(svc.submit(ATTACKER_ORG, "actor-1", 42)).rejects.toBeInstanceOf(NotFoundException);

    const whereArg = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    const vals = sqlValues(whereArg?.where);
    expect(vals).toContain(ATTACKER_ORG);
    expect(vals).not.toContain(VICTIM_ORG);
  });

  it("finalReview throws NotFoundException when termination not found for different org (tenant isolation: 404 not 403)", async () => {
    const { db } = makeDb(null);
    const svc = new TerminationLifecycleService(db, audit, cache, automation, hrAutomation);

    await expect(
      svc.finalReview(ATTACKER_ORG, "actor-1", 55, { decision: "approve" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("finalReview lookup scopes to the requesting org — WHERE clause includes orgId for cross-tenant isolation", async () => {
    const { db, findFirst } = makeDb(null);
    const svc = new TerminationLifecycleService(db, audit, cache, automation, hrAutomation);

    await expect(
      svc.finalReview(ATTACKER_ORG, "actor-1", 77, { decision: "approve" }),
    ).rejects.toBeInstanceOf(NotFoundException);

    const whereArg = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    const vals = sqlValues(whereArg?.where);
    expect(vals).toContain(ATTACKER_ORG);
  });
});
