jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(_db),
}));

import { NotFoundException } from "@nestjs/common";
import { CrmCopilotLeadService } from "./crm-copilot-lead.service";
import type { AiGatewayService } from "../gateway/ai-gateway.service";
import type { OrgFeaturesService } from "./org-features.service";
import type { CrmScoringService } from "./crm-scoring.service";
import type { Db } from "../../../../db/drizzle.module";

const ATTACKER_ORG = "org-attacker";

const ALL_FLAGS_ON = {
  aiLeadScoring: true,
  aiChat: false,
  aiEmailDraft: false,
  aiSmartNotifications: false,
  aiWeeklyRecap: false,
  supportAi: false,
};

function makeChain(resolved: unknown[], whereCalls?: unknown[]) {
  const promise = Promise.resolve(resolved);
  const chain: Record<string, unknown> = {};
  chain.from = jest.fn(() => chain);
  chain.innerJoin = jest.fn(() => chain);
  chain.leftJoin = jest.fn(() => chain);
  chain.where = jest.fn((cond: unknown) => {
    whereCalls?.push(cond);
    return chain;
  });
  chain.orderBy = jest.fn(() => chain);
  chain.limit = jest.fn(() => promise);
  chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => promise.then(res, rej);
  chain.catch = (rej: (e: unknown) => unknown) => promise.catch(rej);
  chain.finally = (cb: () => void) => promise.finally(cb);
  return chain;
}

function makeDb(whereCalls?: unknown[]): Db {
  return {
    select: jest.fn(() => makeChain([], whereCalls)),
    insert: jest.fn(() => ({ values: jest.fn().mockResolvedValue(undefined) })),
    query: {},
  } as unknown as Db;
}

function makeOrgFeatures() {
  return { getFlags: jest.fn().mockResolvedValue(ALL_FLAGS_ON) } as unknown as OrgFeaturesService;
}

const mockGateway = {} as unknown as AiGatewayService;
const mockScoring = {
  nextBestActionWithEvidence: jest.fn().mockResolvedValue(null),
} as unknown as CrmScoringService;

beforeEach(() => jest.resetAllMocks());

describe("CrmCopilotLeadService — cross-tenant isolation", () => {
  it("leadSummary throws NotFoundException when lead belongs to a different org (DENY)", async () => {
    const db = makeDb();
    const svc = new CrmCopilotLeadService(db, mockGateway, makeOrgFeatures(), mockScoring);
    await expect(svc.leadSummary(ATTACKER_ORG, 1, "user-1")).rejects.toThrow(NotFoundException);
  });

  it("leadSummary scopes the WHERE predicate to the requesting orgId — cross-org isolation", async () => {
    const whereCalls: unknown[] = [];
    const db = makeDb(whereCalls);
    const svc = new CrmCopilotLeadService(db, mockGateway, makeOrgFeatures(), mockScoring);
    await expect(svc.leadSummary(ATTACKER_ORG, 999, "user-1")).rejects.toThrow(NotFoundException);

    const flatValues: unknown[] = [];
    function walk(val: unknown, seen = new Set<object>()): void {
      if (val === null || val === undefined || typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
        flatValues.push(val);
        return;
      }
      if (Array.isArray(val)) { val.forEach((v) => walk(v, seen)); return; }
      if (typeof val !== "object" || seen.has(val as object)) return;
      seen.add(val as object);
      const rec = val as Record<string, unknown>;
      if (rec["queryChunks"]) walk(rec["queryChunks"], seen);
      if (Object.prototype.hasOwnProperty.call(rec, "value")) walk(rec["value"], seen);
    }
    whereCalls.forEach((w) => walk(w));
    expect(flatValues).toContain(ATTACKER_ORG);
  });

  it("nextBestActionsAcrossPipeline returns empty when no leads exist for the org — cross-org isolation by absence", async () => {
    const db = makeDb();
    const svc = new CrmCopilotLeadService(db, mockGateway, makeOrgFeatures(), mockScoring);
    const result = await svc.nextBestActionsAcrossPipeline(ATTACKER_ORG, "user-1", 5);
    expect(result.actions).toHaveLength(0);
  });
});
