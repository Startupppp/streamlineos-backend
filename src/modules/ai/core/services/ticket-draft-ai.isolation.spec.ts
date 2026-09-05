import { NotFoundException } from "@nestjs/common";
import { TicketDraftAiService } from "./ticket-draft-ai.service";
import type { Db } from "../../../../db/drizzle.module";
import type { AiGatewayService } from "../gateway/ai-gateway.service";
import type { AuditService } from "../../../../common/audit/audit.service";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";

jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(),
}));

const mockedRunInTenantTransaction = runInTenantTransaction as jest.MockedFunction<
  typeof runInTenantTransaction
>;

const ATTACKER_ORG = "org-attacker";
const VICTIM_ORG = "org-victim";

const mockGateway = { invokeStructured: jest.fn(), invokeText: jest.fn() } as unknown as AiGatewayService;
const mockAudit = { log: jest.fn() } as unknown as AuditService;

function makeDb(selectRows: unknown[] = []): Db {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.limit = jest.fn().mockResolvedValue(selectRows);
  return {
    select: jest.fn(() => chain),
    query: { ticketLabels: { findMany: jest.fn().mockResolvedValue([]) } },
  } as unknown as Db;
}

beforeEach(() => {
  jest.resetAllMocks();
  mockedRunInTenantTransaction.mockImplementation(
    (_db: unknown, fn: (tx: never) => Promise<unknown>) => fn(undefined as never),
  );
});

describe("TicketDraftAiService — cross-tenant isolation", () => {
  it("suggestTitleFromDraft throws NotFoundException when projectId belongs to a different org — cross-tenant DENY", async () => {
    const db = makeDb([]);
    const svc = new TicketDraftAiService(db, mockGateway, mockAudit);
    await expect(
      svc.suggestTitleFromDraft(ATTACKER_ORG, "user-1", 9999, { title: "my draft" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("improveDescriptionDraft throws NotFoundException when projectId belongs to a different org — cross-tenant DENY", async () => {
    const db = makeDb([]);
    const svc = new TicketDraftAiService(db, mockGateway, mockAudit);
    await expect(
      svc.improveDescriptionDraft(ATTACKER_ORG, "user-1", 9999, { description: "some text" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("assertProject scopes WHERE to the requesting orgId — cross-org isolation", async () => {
    const orgIdsSeen: string[] = [];
    const chain: Record<string, jest.Mock> = {};
    chain.from = jest.fn(() => chain);
    chain.where = jest.fn((cond: unknown) => {
      const vals: unknown[] = [];
      function walk(v: unknown, seen = new Set<object>()): void {
        if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") { vals.push(v); return; }
        if (Array.isArray(v)) { v.forEach((x) => walk(x, seen)); return; }
        if (typeof v !== "object" || seen.has(v as object)) return;
        seen.add(v as object);
        const rec = v as Record<string, unknown>;
        if (rec["queryChunks"]) walk(rec["queryChunks"], seen);
        if (Object.prototype.hasOwnProperty.call(rec, "value")) walk(rec["value"], seen);
      }
      walk(cond);
      vals.filter((x) => typeof x === "string").forEach((s) => orgIdsSeen.push(s as string));
      return chain;
    });
    chain.limit = jest.fn().mockResolvedValue([]);
    const db = {
      select: jest.fn(() => chain),
      query: {},
    } as unknown as Db;
    const svc = new TicketDraftAiService(db, mockGateway, mockAudit);
    await svc.suggestTitleFromDraft(ATTACKER_ORG, "user-1", 9999, { title: "my draft" }).catch(() => undefined);
    expect(orgIdsSeen).toContain(ATTACKER_ORG);
    expect(orgIdsSeen).not.toContain(VICTIM_ORG);
  });
});
