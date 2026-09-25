import { KbEventsService } from "./kb-events.service";
import { runWithTenantContext, type AfterCommitHook } from "../../../common/tenant/tenant-context";
import type { TenantTx } from "../../../common/tenant/with-tenant";
import type { Db } from "../../../db/drizzle.module";


interface Recorded {
  inserts: number;
  hooks: AfterCommitHook[];
}

function makeService(): { service: KbEventsService; recorded: Recorded; tx: TenantTx } {
  const recorded: Recorded = { inserts: 0, hooks: [] };
  const tx = {
    insert: () => ({
      values: async () => {
        recorded.inserts += 1;
        return [];
      },
    }),
    execute: async () => [],
  };
  const db = {
    transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    ...tx,
  } as unknown as Db;
  return { service: new KbEventsService(db), recorded, tx: tx as unknown as TenantTx };
}

function withRequestTransaction<T>(
  recorded: Recorded,
  tx: TenantTx,
  fn: () => Promise<T>,
): Promise<T> {
  return runWithTenantContext(
    { orgId: "org-1", audience: "INTERNAL", tx, afterCommit: recorded.hooks },
    fn,
  );
}

describe("KbEventsService.recordDetached", () => {
  it("issues no statement on the request transaction — it registers an after-commit hook", async () => {
    const { service, recorded, tx } = makeService();

    await withRequestTransaction(recorded, tx, () =>
      service.recordDetached("org-1", "view", { articleId: 7 }),
    );

    expect(recorded.inserts).toBe(0);
    expect(recorded.hooks).toHaveLength(1);
  });

  it("still writes the event — the hook, when drained, does the insert", async () => {
    const { service, recorded, tx } = makeService();

    await withRequestTransaction(recorded, tx, () =>
      service.recordDetached("org-1", "search", { query: "leave policy" }),
    );
    const [hook] = recorded.hooks;
    if (!hook) throw new Error("no after-commit hook was registered");
    await hook();

    expect(recorded.inserts).toBe(1);
  });

  it("falls back to writing inline when there is no request transaction to defer to", async () => {
    const { service, recorded } = makeService();

    await service.recordDetached("org-1", "view", { articleId: 7 });

    expect(recorded.inserts).toBe(1);
    expect(recorded.hooks).toHaveLength(0);
  });

  it("does not fail the read when the inline fallback write fails", async () => {
    const db = {
      transaction: async () => {
        throw new Error("42501: no tenant context");
      },
    } as unknown as Db;

    await expect(
      new KbEventsService(db).recordDetached("org-1", "view", { articleId: 7 }),
    ).resolves.toBeUndefined();
  });

  it("leaves record() writing on the ambient transaction", async () => {
    const { service, recorded, tx } = makeService();

    await withRequestTransaction(recorded, tx, () =>
      service.record("org-1", "ai_answer", { query: "q" }),
    );

    expect(recorded.inserts).toBe(1);
    expect(recorded.hooks).toHaveLength(0);
  });
});
