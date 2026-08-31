jest.mock("../../../common/tenant", () => ({
  forEachOrg: async (
    _db: unknown,
    _name: string,
    fn: (tx: unknown, orgId: string) => Promise<void>,
  ) => {
    await fn((globalThis as Record<string, unknown>).__cronKbChatTx, "org-1");
    return { organizations: 1, succeeded: 1, failed: 0 };
  },
}));

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { CronKbChatRetentionService } from "../cron-kb-chat-retention.service";

const dialect = new PgDialect();

interface CapturedCalls {
  settingsWhere: SQL | null;
  conversationsWhere: SQL | null;
  deleteWhere: SQL | null;
}

function makeTx(opts: {
  settingsRow?: { chatHistoryRetentionDays: number | null };
  conversationBatches?: Array<Array<{ id: number }>>;
}): { captured: CapturedCalls } {
  const captured: CapturedCalls = {
    settingsWhere: null,
    conversationsWhere: null,
    deleteWhere: null,
  };

  let selectIdx = 0;
  let batchIdx = 0;
  const batches = opts.conversationBatches ?? [[]];

  const tx = {
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (cond: SQL) => {
          const idx = selectIdx++;
          if (idx === 0) {
            captured.settingsWhere = cond;
          } else if (captured.conversationsWhere === null) {
            captured.conversationsWhere = cond;
          }
          const rows =
            idx === 0
              ? opts.settingsRow !== undefined
                ? [opts.settingsRow]
                : []
              : (batches[batchIdx++] ?? []);
          return { limit: (_n: unknown) => Promise.resolve(rows) };
        },
      }),
    }),
    delete: (_table: unknown) => ({
      where: (cond: SQL) => {
        captured.deleteWhere = cond;
        return Promise.resolve([]);
      },
    }),
  };

  (globalThis as Record<string, unknown>).__cronKbChatTx = tx;
  return { captured };
}

async function buildSvc(): Promise<CronKbChatRetentionService> {
  const mod = await Test.createTestingModule({
    providers: [
      CronKbChatRetentionService,
      { provide: DRIZZLE, useValue: {} },
    ],
  }).compile();
  return mod.get(CronKbChatRetentionService);
}

describe("CronKbChatRetentionService — cutoff is scoped to updated_at", () => {
  it("includes updated_at < cutoff in the conversations where clause", async () => {
    const { captured } = makeTx({
      settingsRow: { chatHistoryRetentionDays: 30 },
      conversationBatches: [[]],
    });
    const svc = await buildSvc();

    await svc.purgeExpiredConversations();

    expect(captured.conversationsWhere).not.toBeNull();
    const rendered = dialect.sqlToQuery(captured.conversationsWhere!);
    expect(rendered.sql).toContain('"updated_at" <');
    const timestamps = rendered.params.filter(
      (p) => typeof p === "string" && !Number.isNaN(Date.parse(String(p))) && String(p).includes("T"),
    );
    expect(timestamps).toHaveLength(1);
  });

  it("uses the org-configured retention days as the cutoff (30 days)", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-31T12:00:00.000Z"));

    const { captured } = makeTx({
      settingsRow: { chatHistoryRetentionDays: 30 },
      conversationBatches: [[]],
    });
    const svc = await buildSvc();

    await svc.purgeExpiredConversations();

    const rendered = dialect.sqlToQuery(captured.conversationsWhere!);
    const cutoffParam = rendered.params.find(
      (p) => typeof p === "string" && !Number.isNaN(Date.parse(String(p))) && String(p).includes("T"),
    );
    expect(cutoffParam).toBeDefined();
    const cutoffMs = new Date(String(cutoffParam)).getTime();
    const expectedMs = new Date("2026-01-31T12:00:00.000Z").getTime() - 30 * 86_400_000;
    expect(Math.abs(cutoffMs - expectedMs)).toBeLessThan(2000);

    jest.useRealTimers();
  });

  it("falls back to the 90-day default when no settings row exists", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-31T12:00:00.000Z"));

    const { captured } = makeTx({ conversationBatches: [[]] });
    const svc = await buildSvc();

    await svc.purgeExpiredConversations();

    const rendered = dialect.sqlToQuery(captured.conversationsWhere!);
    const cutoffParam = rendered.params.find(
      (p) => typeof p === "string" && !Number.isNaN(Date.parse(String(p))) && String(p).includes("T"),
    );
    expect(cutoffParam).toBeDefined();
    const cutoffMs = new Date(String(cutoffParam)).getTime();
    const expectedMs = new Date("2026-01-31T12:00:00.000Z").getTime() - 90 * 86_400_000;
    expect(Math.abs(cutoffMs - expectedMs)).toBeLessThan(2000);

    jest.useRealTimers();
  });
});

describe("CronKbChatRetentionService — tenant isolation", () => {
  it("scopes conversation purge to the requesting org (isolation — deny)", async () => {
    const { captured } = makeTx({
      settingsRow: { chatHistoryRetentionDays: 90 },
      conversationBatches: [[{ id: 1 }], []],
    });
    const svc = await buildSvc();

    await svc.purgeExpiredConversations();

    expect(captured.conversationsWhere).not.toBeNull();
    const rendered = dialect.sqlToQuery(captured.conversationsWhere!);
    expect(rendered.params).toContain("org-1");
  });

  it("does not include a different org's id in the conversations query (isolation — control)", async () => {
    const { captured } = makeTx({
      settingsRow: { chatHistoryRetentionDays: 90 },
      conversationBatches: [[]],
    });
    const svc = await buildSvc();

    await svc.purgeExpiredConversations();

    const rendered = dialect.sqlToQuery(captured.conversationsWhere!);
    expect(rendered.params).not.toContain("org-attacker");
  });
});

describe("CronKbChatRetentionService — deletion and counting", () => {
  it("deletes found conversations and returns the correct count", async () => {
    const { captured } = makeTx({
      settingsRow: { chatHistoryRetentionDays: 90 },
      conversationBatches: [[{ id: 10 }, { id: 11 }], []],
    });
    const svc = await buildSvc();

    const result = await svc.purgeExpiredConversations();

    expect(captured.deleteWhere).not.toBeNull();
    expect(result.conversationsDeleted).toBe(2);
    expect(result.orgsProcessed).toBe(1);
  });

  it("returns zero deletions when no expired conversations exist", async () => {
    makeTx({ conversationBatches: [[]] });
    const svc = await buildSvc();

    const result = await svc.purgeExpiredConversations();

    expect(result.conversationsDeleted).toBe(0);
  });

  it("does not call delete when the conversations query returns nothing", async () => {
    const { captured } = makeTx({ conversationBatches: [[]] });
    const svc = await buildSvc();

    await svc.purgeExpiredConversations();

    expect(captured.deleteWhere).toBeNull();
  });
});
