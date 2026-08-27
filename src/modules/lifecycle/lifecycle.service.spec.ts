import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.types";
import { LifecycleService, type ClosedWonDealRef } from "./lifecycle.service";

/**
 * A Drizzle chain that answers with a scripted result and records what it was
 * asked. Every method returns the same object and the object is thenable, so a
 * whole builder resolves to whatever was queued — enough to assert the shape of
 * the traffic without a database.
 */
interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

function chain(result: unknown[], log: Call[]): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then")
          return (resolve: (value: unknown[]) => void) => resolve(result);
        if (typeof property === "symbol") return undefined;
        return (...args: unknown[]) => {
          log.push({ method: String(property), args });
          return proxy;
        };
      },
    },
  );
  return proxy;
}

class FakeDb {
  readonly calls: Call[] = [];
  private readonly scripted: Record<string, unknown[][]> = {
    select: [],
    insert: [],
    update: [],
  };

  script(method: "select" | "insert" | "update", ...results: unknown[][]): this {
    this.scripted[method]!.push(...results);
    return this;
  }

  private next(method: string, args: unknown[]): unknown[] {
    this.calls.push({ method, args });
    return this.scripted[method]!.shift() ?? [];
  }

  select(...args: unknown[]) {
    return chain(this.next("select", args), this.calls);
  }

  insert(...args: unknown[]) {
    return chain(this.next("insert", args), this.calls);
  }

  update(...args: unknown[]) {
    return chain(this.next("update", args), this.calls);
  }

  count(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  argsOf(method: string): readonly unknown[] | undefined {
    return this.calls.find((call) => call.method === method)?.args;
  }

  asDb(): Db {
    // The paths under test touch only these three verbs; anything else is a bug
    // in the test rather than a gap in the fake, and would throw loudly.
    return this as unknown as Db;
  }
}

const NOW = new Date("2026-08-27T12:00:00.000Z");

const party = (over: Record<string, unknown> = {}) => ({
  partyId: "party-1",
  organizationId: "org-1",
  name: "Northwind",
  partyType: "ORGANISATION",
  status: "ACTIVE",
  deletedAt: null,
  ...over,
});

const wonDeal = (over: Partial<ClosedWonDealRef> = {}): ClosedWonDealRef => ({
  organizationId: "org-1",
  dealId: 42,
  partyId: null,
  leadPartyId: null,
  clientId: null,
  leadId: null,
  valueMinor: 1_200_00,
  actualCloseDate: "2026-08-27",
  customData: null,
  ...over,
});

describe("LifecycleService.recordClosedWon", () => {
  /**
   * The property the whole feature rests on. A deal moves out of a won stage and
   * back — a reversed approval, a corrected misclick — and a bulk stage change
   * can reach here twice concurrently. Without the conflict target the customer
   * appears in the renewal book twice for one contract, and nothing errors.
   */
  it("insists the database, not a prior read, is what stops a duplicate term", () => {
    const db = new FakeDb().script("select", [party()]).script("insert", [
      { customerLifecycleId: "lc-1" },
    ]);
    const service = new LifecycleService(new FakeDb().asDb());

    return service
      .recordClosedWon(db.asDb(), wonDeal({ partyId: "party-1" }), NOW)
      .then((outcome) => {
        expect(outcome).toEqual({ status: "opened", customerLifecycleId: "lc-1" });

        const conflict = db.calls.find((call) => call.method === "onConflictDoNothing");
        expect(conflict).toBeDefined();
        const target = (conflict!.args[0] as { target: { name: string }[] }).target;
        expect(target.map((column) => column.name)).toEqual([
          "organization_id",
          "source_deal_id",
        ]);
      });
  });

  /** The second arrival. Nothing inserted, and the caller is told plainly. */
  it("reports an existing term rather than pretending it opened one", async () => {
    const db = new FakeDb().script("select", [party()]).script("insert", []);
    const service = new LifecycleService(new FakeDb().asDb());

    expect(
      await service.recordClosedWon(db.asDb(), wonDeal({ partyId: "party-1" }), NOW),
    ).toEqual({ status: "already-open" });
  });

  /**
   * It writes through the transaction it was handed, never through its own
   * connection. A lifecycle written outside the transaction that moved the deal
   * survives that move being rolled back, which puts revenue in the book for a
   * sale that never closed.
   */
  it("writes through the caller's transaction and never through its own db", async () => {
    const own = new FakeDb();
    const tx = new FakeDb().script("select", [party()]).script("insert", [
      { customerLifecycleId: "lc-1" },
    ]);

    await new LifecycleService(own.asDb()).recordClosedWon(
      tx.asDb(),
      wonDeal({ partyId: "party-1" }),
      NOW,
    );

    expect(tx.count("insert")).toBe(1);
    expect(own.calls).toEqual([]);
  });

  /**
   * A deal won against an unconverted lead has no customer to hold a recurring
   * relationship with. The refusal is a returned value and nothing is written —
   * a throw here would roll back the transaction and leave a rep unable to close
   * a deal because the renewal record could not be opened.
   */
  it("refuses without writing when no identifier resolves to a party", async () => {
    const db = new FakeDb();

    const outcome = await new LifecycleService(new FakeDb().asDb()).recordClosedWon(
      db.asDb(),
      wonDeal({ partyId: "gone", clientId: 7, leadId: 9 }),
      NOW,
    );

    expect(outcome).toEqual({ status: "skipped", reason: "no-party" });
    expect(db.count("insert")).toBe(0);
  });

  /**
   * `deals.party_id` is what the CRM writes now; the legacy identifiers are a
   * fallback. If the order inverted, a deal carrying both would anchor its
   * revenue to whichever legacy row happened to answer first.
   */
  it("prefers the deal's own party over its legacy identifiers", async () => {
    const db = new FakeDb().script("select", [party({ partyId: "party-current" })]);
    db.script("insert", [{ customerLifecycleId: "lc-1" }]);

    await new LifecycleService(new FakeDb().asDb()).recordClosedWon(
      db.asDb(),
      wonDeal({ partyId: "party-current", clientId: 7, leadId: 9 }),
      NOW,
    );

    // One lookup, not three: the fallbacks were never consulted.
    expect(db.count("select")).toBe(1);
  });

  /**
   * Falls through to the legacy client map when the deal carries no party id —
   * the state most historical deals are in.
   */
  it("resolves a legacy client id through the party map", async () => {
    const db = new FakeDb()
      .script("select", [{ ...party({ partyId: "party-from-client" }), legacyId: 7 }])
      .script("insert", [{ customerLifecycleId: "lc-1" }]);

    const outcome = await new LifecycleService(new FakeDb().asDb()).recordClosedWon(
      db.asDb(),
      wonDeal({ clientId: 7 }),
      NOW,
    );

    expect(outcome.status).toBe("opened");
    const values = (db.argsOf("values")?.[0] ?? {}) as { partyId?: string };
    expect(values.partyId).toBe("party-from-client");
  });

  /**
   * The term reaches the row as the origin rule computed it. Asserted here as
   * well as in `lifecycle-origin.spec.ts` because the two could agree in
   * isolation and still be wired together wrongly.
   */
  it("writes the term the origin rule computed", async () => {
    const db = new FakeDb().script("select", [party()]).script("insert", [
      { customerLifecycleId: "lc-1" },
    ]);

    await new LifecycleService(new FakeDb().asDb()).recordClosedWon(
      db.asDb(),
      wonDeal({ partyId: "party-1", customData: { termMonths: 24 } }),
      NOW,
    );

    expect(db.argsOf("values")?.[0]).toMatchObject({
      organizationId: "org-1",
      partyId: "party-1",
      sourceDealId: 42,
      startedOn: "2026-08-27",
      termMonths: 24,
      renewalOn: "2028-08-27",
      contractValueMinor: 120000,
    });
  });
});

describe("LifecycleService.close", () => {
  const lifecycleRow = {
    customerLifecycleId: "lc-1",
    organizationId: "org-1",
    partyId: "party-1",
    status: "active",
    renewalOn: "2027-08-27",
    renewalCount: 0,
    termMonths: 12,
    contractValueMinor: 120000,
    riskScore: 74,
  };

  /**
   * The score answers "is this revenue at risk". Revenue that has already gone
   * is not at risk, and leaving the last live score behind would keep churned
   * customers permanently at the top of the triage list.
   */
  it("zeroes the risk score when a contract ends", async () => {
    const db = new FakeDb()
      .script("select", [lifecycleRow])
      .script("update", [{ ...lifecycleRow, status: "churned", riskScore: 0 }]);

    await new LifecycleService(db.asDb()).close("org-1", "lc-1", {
      status: "churned",
      reason: "Moved to a competitor",
    });

    expect(db.argsOf("set")?.[0]).toMatchObject({
      status: "churned",
      closedReason: "Moved to a competitor",
      riskScore: 0,
    });
  });

  /**
   * The UPDATE re-asserts `status = 'active'`, so a second close that raced the
   * first changes nothing and says so. 404 rather than a silent success: a
   * caller told "closed" twice would file two churn events for one customer.
   */
  it("refuses to close a contract that is already closed", async () => {
    const db = new FakeDb()
      .script("select", [{ ...lifecycleRow, status: "churned" }])
      .script("update", []);

    await expect(
      new LifecycleService(db.asDb()).close("org-1", "lc-1", {
        status: "cancelled",
        reason: "Duplicate",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  /**
   * Another tenant's identifier is a 404, never a 403: a 403 confirms the
   * contract exists, which is itself a disclosure about a competitor.
   */
  it("answers 404 for an identifier this organisation cannot see", async () => {
    const db = new FakeDb().script("select", []);

    await expect(
      new LifecycleService(db.asDb()).close("org-1", "someone-elses", {
        status: "churned",
        reason: "n/a",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(db.count("update")).toBe(0);
  });
});
