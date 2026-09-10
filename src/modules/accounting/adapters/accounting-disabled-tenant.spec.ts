import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PostingCommandService } from "./posting-command.service";
import { AdapterRejection } from "./posting-command.types";

/**
 * ACC-16. An organisation that never enabled accounting keeps working exactly
 * as it did, and no journal is invented for it.
 *
 * This is the ticket ACC-05 could have broken. Moving each GL post inside the
 * stock movement's own transaction means the opt-out rejection is now raised
 * *inside* that transaction, and a rejection raised inside a transaction is
 * usually fatal to it — Postgres marks the whole transaction aborted the moment
 * a statement fails, and every statement after that answers
 * "current transaction is aborted". A goods receipt that caught the rejection
 * and carried on would then fail on its next write, for a reason with nothing
 * to do with accounting.
 *
 * It is safe, and not by luck: `BOOK_NOT_ENABLED` is raised from the result of
 * a SELECT that succeeded. No statement failed, so nothing is aborted and the
 * caller's transaction is still usable. That property is what these tests pin
 * — it is invisible in the code and one refactor away from being untrue.
 */

function serviceWithoutABook() {
  const ledger = {
    post: () => {
      throw new Error("the ledger must not be reached for an org with no book");
    },
    reverse: () => {
      throw new Error("the ledger must not be reached for an org with no book");
    },
  } as never;
  const books = { findDefault: async () => null } as never;
  const db = {
    transaction: () => {
      throw new Error("no transaction should be opened when a tx was handed in");
    },
  } as never;

  const audit = { logCriticalOutsideTransaction: async () => undefined } as never;
  return new PostingCommandService(db, books, ledger, audit);
}

/** A caller's transaction. Every use is recorded so "untouched" can be asserted. */
function spyTransaction() {
  const statements: string[] = [];
  const tx = new Proxy(
    {},
    {
      get(_target, prop) {
        return (...args: unknown[]) => {
          statements.push(String(prop));
          void args;
          throw new Error(`the adapter issued ${String(prop)} against the caller's transaction`);
        };
      },
    },
  );
  return { tx: tx as never, statements };
}

describe("an organisation with no book", () => {
  it("is refused with the opt-out code and nothing else", async () => {
    const service = serviceWithoutABook();
    const { tx } = spyTransaction();

    await expect(
      service.submit(
        "org-1",
        "user-1",
        {
          sourceType: "stock_move",
          sourceId: "1",
          purpose: "receive",
          journalDate: "2026-09-01",
          lines: [{ accountTag: "inventory", debitMinor: 100 }],
        },
        tx,
      ),
    ).rejects.toMatchObject({ code: "BOOK_NOT_ENABLED" });
  });

  it("touches the caller's transaction not at all before refusing", async () => {
    /*
      The property the whole ticket rests on. `BOOK_NOT_ENABLED` comes out of a
      SELECT that succeeded, so Postgres has not aborted anything and the goods
      receipt that catches it can carry on writing. If the adapter ever issued a
      statement on the caller's transaction before deciding, catching this
      rejection would leave the caller holding a dead transaction — and the
      failure would surface as an unrelated write failing later, which is close
      to undiagnosable.
    */
    const service = serviceWithoutABook();
    const { tx, statements } = spyTransaction();

    await expect(
      service.submit(
        "org-1",
        "user-1",
        {
          sourceType: "stock_move",
          sourceId: "1",
          purpose: "receive",
          journalDate: "2026-09-01",
          lines: [{ accountTag: "inventory", debitMinor: 100 }],
        },
        tx,
      ),
    ).rejects.toThrow(AdapterRejection);

    expect(statements).toEqual([]);
  });

  it("gets no journal, not an empty one and not a draft", async () => {
    /*
      The ledger stub throws if reached, so reaching the rejection at all is the
      proof. An org that opted out must have no `gl_journals` row of any kind —
      a placeholder would make its trial balance a lie the day it enables
      accounting.
    */
    const service = serviceWithoutABook();
    const { tx } = spyTransaction();

    await expect(
      service.submit(
        "org-1",
        "user-1",
        {
          sourceType: "sales_invoice",
          sourceId: "9",
          purpose: "issue",
          journalDate: "2026-09-01",
          lines: [{ accountTag: "ar_control", debitMinor: 500 }],
        },
        tx,
      ),
    ).rejects.toMatchObject({ code: "BOOK_NOT_ENABLED" });
  });

  it("returns null from a reversal rather than refusing it", async () => {
    /*
      Asymmetric on purpose, and correct. Reversing something that was never
      posted is a no-op, not an error: an org that disables accounting after
      posting must still be able to void the document that produced the journal.
    */
    const service = serviceWithoutABook();
    const { tx } = spyTransaction();

    await expect(
      service.reverse(
        "org-1",
        "user-1",
        { sourceType: "stock_move", sourceId: "1", purpose: "receive" },
        "2026-09-02",
        tx,
      ),
    ).resolves.toBeNull();
  });
});

describe("the bridge keeps the golden path open", () => {
  const bridge = join(__dirname, "../../..", "modules/inventory");

  const CALL_SITES = [
    "purchase-orders/grn.service.ts",
    "sales-orders/so-fulfillment.service.ts",
    "sales-orders/so-lifecycle.service.ts",
  ];

  it.each(CALL_SITES)("%s swallows the opt-out and rethrows everything else", (file) => {
    const source = readFileSync(join(bridge, file), "utf8");

    /*
      Enumerated rather than spot-checked. A second swallowed code would be a
      real journal quietly not written on a tenant that IS paying for
      accounting, which is the failure ACC-06 exists to prevent — and it would
      look exactly like this code does.
    */
    const swallowed = [...source.matchAll(/error\.code === "([A-Z_]+)"/g)].map((m) => m[1]);
    expect(swallowed.length).toBeGreaterThan(0);
    expect(new Set(swallowed)).toEqual(new Set(["BOOK_NOT_ENABLED"]));
  });

  it.each(CALL_SITES)("%s logs the skip at debug rather than warning about it", (file) => {
    /*
      An opted-out org is not in an error state and must not fill anyone's logs
      as though it were. `warn` here would make every goods receipt on every
      accounting-free tenant look like a problem, and the real problems would
      be lost in it.
    */
    const source = readFileSync(join(bridge, file), "utf8");
    const skip = source.slice(source.indexOf("Accounting is not enabled for org"));
    expect(source).toContain("logger.debug");
    expect(skip.slice(0, 200)).not.toContain("logger.warn");
  });

  it("leaves the period guard inert without a book", () => {
    /*
      The other half of the golden path. `assertPeriodOpen` returns before it
      looks at a period when no book exists, so a tenant with no accounting can
      backdate a movement as freely as it always could.
      `stock-engine.spec.ts` exercises the behaviour; this pins the shape it
      depends on, because the early return is one deleted line.
    */
    const engine = readFileSync(
      join(__dirname, "../../..", "modules/inventory/stock-engine/stock-engine.service.ts"),
      "utf8",
    );
    const guard = engine.slice(engine.indexOf("private async assertPeriodOpen"));
    const body = guard.slice(0, guard.indexOf("\n  }"));

    expect(body).toContain("if (!book) return;");
    /* And the refusal is still there, or the guard would be inert for everyone. */
    expect(body).toContain('period?.status === "LOCKED"');
  });
});
