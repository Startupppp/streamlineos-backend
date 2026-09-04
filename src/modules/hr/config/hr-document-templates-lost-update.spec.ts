import { ConflictException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { HrDocumentTemplatesService } from "./hr-document-templates.service";
import type { Db } from "../../../db/drizzle.module";

/**
 * PRD-C076 — "Verify concurrent counters, unread state, seats, balances, ordering and
 * idempotency use atomic SQL/upsert/locking semantics without read-then-write races."
 *
 * `updateVersion` set `version: existing.version + 1` inside a transaction whose UPDATE
 * matched on `(org_id, id)` only. `existing` is read by the CONTROLLER, outside that
 * transaction, so two concurrent edits both read version N, both wrote N + 1, and one
 * edit was lost silently — no conflict, no error, and the caller was told it succeeded.
 * Worse, the archive row in `document_template_versions` was inserted before the update
 * and the failure check sat AFTER the transaction, so a lost update also committed an
 * orphaned version snapshot.
 *
 * The store double below implements exactly what Postgres does with the compare-and-swap
 * predicate: the UPDATE matches only while the row still holds the version the edit was
 * based on, and the enclosing transaction discards its writes when the callback throws.
 */
const dialect = new PgDialect();
const ORG = "org-tpl-a";

const BASE = {
  id: 41,
  orgId: ORG,
  title: "Offer letter",
  type: "OFFER" as const,
  htmlContent: "<p>hi</p>",
  variables: [],
  version: 3,
};

/** The value bound to the `version` column in a compiled WHERE, or null when absent. */
function versionPredicateOf(cond: unknown): number | null {
  const query = dialect.sqlToQuery(cond as SQL);
  const match = query.sql.match(/"version"\s*=\s*\$(\d+)/);
  if (!match) return null;
  const value = query.params[Number(match[1]) - 1];
  return typeof value === "number" ? value : null;
}

interface Store {
  version: number;
  html: string;
  archived: { version: number }[];
}

/**
 * A drizzle double over one row. `update().set().where().returning()` returns the row
 * only when the WHERE's version predicate still matches the stored version — which is
 * what makes a lost update observable instead of silent.
 */
function makeDb(store: Store) {
  const capturedWheres: unknown[] = [];

  const makeTx = () => {
    const staged: { version: number }[] = [];
    let committedUpdate: { version: number; html: string } | null = null;

    const tx = {
      insert: () => ({
        values: async (row: { version: number }) => {
          staged.push({ version: row.version });
        },
      }),
      update: () => {
        const pending: { html?: string } = {};
        const chain: Record<string, unknown> = {};
        chain["set"] = (values: { htmlContent?: string }) => {
          pending.html = values.htmlContent;
          return chain;
        };
        chain["where"] = (cond: unknown) => {
          capturedWheres.push(cond);
          const expected = versionPredicateOf(cond);
          const matches = expected === null || expected === store.version;
          const row = matches
            ? { ...BASE, version: store.version + 1, htmlContent: pending.html ?? store.html }
            : undefined;
          if (matches) committedUpdate = { version: store.version + 1, html: pending.html ?? store.html };
          return {
            returning: async () => (row ? [row] : []),
            then: (resolve: (v: unknown) => unknown) => Promise.resolve(row ? [row] : []).then(resolve),
          };
        };
        return chain;
      },
    };

    return {
      tx,
      commit: () => {
        for (const a of staged) store.archived.push(a);
        if (committedUpdate) {
          store.version = committedUpdate.version;
          store.html = committedUpdate.html;
        }
      },
    };
  };

  const db = {
    transaction: async (cb: (t: unknown) => Promise<unknown>) => {
      const { tx, commit } = makeTx();
      const result = await cb(tx);
      commit();
      return result;
    },
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
  } as unknown as Db;

  return { db, capturedWheres };
}

describe("HrDocumentTemplatesService — concurrent edits (PRD-C076)", () => {
  it("carries the version the edit was based on into the UPDATE's WHERE", async () => {
    const store: Store = { version: 3, html: "<p>hi</p>", archived: [] };
    const { db, capturedWheres } = makeDb(store);
    const service = new HrDocumentTemplatesService(db);

    await service.updateVersion("user-1", BASE as never, { htmlContent: "<p>a</p>" } as never);

    const last = capturedWheres[capturedWheres.length - 1];
    expect(versionPredicateOf(last)).toBe(3);
  });

  it("the SECOND of two edits from the same snapshot is REJECTED, not silently lost", async () => {
    const store: Store = { version: 3, html: "<p>hi</p>", archived: [] };
    const { db } = makeDb(store);
    const service = new HrDocumentTemplatesService(db);

    const first = await service.updateVersion("user-1", BASE as never, {
      htmlContent: "<p>edit-A</p>",
    } as never);
    expect(first.version).toBe(4);
    expect(store.version).toBe(4);
    expect(store.html).toBe("<p>edit-A</p>");

    // user-2 is still holding the snapshot they read at version 3.
    await expect(
      service.updateVersion("user-2", BASE as never, { htmlContent: "<p>edit-B</p>" } as never),
    ).rejects.toBeInstanceOf(ConflictException);

    // edit-A survives, and the version advanced exactly once.
    expect(store.version).toBe(4);
    expect(store.html).toBe("<p>edit-A</p>");
  });

  it("a rejected edit archives nothing — the version snapshot rolls back with it", async () => {
    const store: Store = { version: 3, html: "<p>hi</p>", archived: [] };
    const { db } = makeDb(store);
    const service = new HrDocumentTemplatesService(db);

    await service.updateVersion("user-1", BASE as never, { htmlContent: "<p>edit-A</p>" } as never);
    expect(store.archived).toEqual([{ version: 3 }]);

    await expect(
      service.updateVersion("user-2", BASE as never, { htmlContent: "<p>edit-B</p>" } as never),
    ).rejects.toBeInstanceOf(ConflictException);

    // Without the throw INSIDE the transaction the losing edit would still have committed
    // an orphaned snapshot of version 3.
    expect(store.archived).toEqual([{ version: 3 }]);
  });

  it("versionPredicateOf sees nothing when the predicate is absent — the checks above are not vacuous", () => {
    const { and, eq } = jest.requireActual<typeof import("drizzle-orm")>("drizzle-orm");
    const { documentTemplates } = jest.requireActual<typeof import("../../../db/schema")>(
      "../../../db/schema",
    );
    expect(
      versionPredicateOf(and(eq(documentTemplates.orgId, ORG), eq(documentTemplates.id, 41))),
    ).toBeNull();
    expect(
      versionPredicateOf(
        and(
          eq(documentTemplates.orgId, ORG),
          eq(documentTemplates.id, 41),
          eq(documentTemplates.version, 3),
        ),
      ),
    ).toBe(3);
  });
});
