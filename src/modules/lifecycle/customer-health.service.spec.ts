import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.types";
import { CustomerHealthService } from "./customer-health.service";
import { HEALTH_FACTOR_KEYS } from "../../db/schema/crm/lifecycle";

/**
 * What the service is responsible for is TRAFFIC — which sources it consults,
 * and what it writes down. The judgement it delegates is covered by
 * `health-score.spec.ts` and `health-factors.spec.ts`; duplicating it here
 * against a fake database would only assert that the fake returns what it was
 * scripted to.
 *
 * So these tests hold the two things only this layer can get wrong: that a
 * customer the model could not score is written down as unscored rather than as
 * a number, and that the stored decomposition never contains a value for an
 * input that was missing — the row-level twin of
 * `chk_customer_health_factors_evidence`.
 */

interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** See `lifecycle.service.spec.ts`: a thenable Drizzle chain that records itself. */
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
    delete: [],
  };

  script(method: "select" | "insert" | "update" | "delete", ...results: unknown[][]): this {
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
  delete(...args: unknown[]) {
    return chain(this.next("delete", args), this.calls);
  }

  async transaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
    this.calls.push({ method: "transaction", args: [] });
    return work(this);
  }

  /** Every `.values(...)` payload, in the order the service wrote them. */
  valuePayloads(): unknown[] {
    return this.calls.filter((call) => call.method === "values").map((call) => call.args[0]);
  }

  setPayloads(): unknown[] {
    return this.calls.filter((call) => call.method === "set").map((call) => call.args[0]);
  }

  asDb(): Db {
    return this as unknown as Db;
  }
}

const ORG = "org_1";
const PARTY = "party_1";
const AS_OF = new Date("2026-08-27T12:00:00.000Z");

const PARTY_ROW = [{ partyId: PARTY, name: "Northwind Trading" }];
const ASSESSMENT_ROW = [
  { customerHealthAssessmentId: "cha_1", computedAt: AS_OF },
];

/** The nine reads an assessment makes, in the order it makes them. */
function scriptAssessment(
  db: FakeDb,
  opts: {
    sources: readonly [boolean, boolean, boolean, boolean];
    engagement?: unknown;
    support?: unknown;
    sentiment?: unknown;
    usage?: unknown;
  },
): FakeDb {
  const probe = (present: boolean) => (present ? [{ present: 1 }] : []);
  return db
    .script("select", PARTY_ROW)
    .script(
      "select",
      probe(opts.sources[0]),
      probe(opts.sources[1]),
      probe(opts.sources[2]),
      probe(opts.sources[3]),
    )
    .script(
      "select",
      [opts.engagement ?? { activityCount: 0, contactDays: 0, lastActivityAt: null }],
      [opts.support ?? { opened: 0, urgent: 0, slaBreached: 0, openNow: 0 }],
      [opts.sentiment ?? { positive: 0, neutral: 0, negative: 0, everCount: 0 }],
      [opts.usage ?? { observationCount: 0, declineImpact: 0, everCount: 0 }],
    )
    .script("insert", ASSESSMENT_ROW, [])
    .script("delete", [])
    .script("update", []);
}

interface FactorRow {
  factorKey: string;
  status: string;
  value: number | null;
  missingReason: string | null;
  effectiveWeightBps: number;
  contributionBps: number;
  observations: number;
  windowDays: number;
}

describe("CustomerHealthService.assess", () => {
  /**
   * A tenant that records none of the four sources gets no score. The failure
   * this prevents is the one that matters most on day one of an installation:
   * every customer of a tenant that has adopted nothing being written down as
   * `critical`, which is both wrong and the fastest way to make the whole
   * feature ignored.
   */
  it("writes a customer it cannot score as unscored, not as zero", async () => {
    const db = scriptAssessment(new FakeDb(), { sources: [false, false, false, false] });
    const service = new CustomerHealthService(db.asDb());

    const { data } = await service.assess(ORG, PARTY, AS_OF);

    expect(data.score).toBeNull();
    expect(data.band).toBeNull();
    expect(data.coverageBps).toBe(0);
    expect(data.unscored?.reason).toBe("insufficient-coverage");

    /** And the projection onto the party carries the null out, not a stand-in. */
    const [partySet] = db.setPayloads() as [Record<string, unknown>];
    expect(partySet.healthScore).toBeNull();
    expect(partySet.healthStatus).toBeNull();
    expect(partySet.healthCheckedAt).toEqual(AS_OF);
  });

  /**
   * The row-level twin of `chk_customer_health_factors_evidence`. A stored
   * factor that is missing but carries a value — or carries weight — is the
   * score silently treating an unmeasured input as a measured zero, which is
   * the defect this whole ticket exists to remove.
   */
  it("never stores a value, a weight or an observation for a missing input", async () => {
    const db = scriptAssessment(new FakeDb(), { sources: [false, false, false, false] });
    const service = new CustomerHealthService(db.asDb());

    await service.assess(ORG, PARTY, AS_OF);

    const [, factorRows] = db.valuePayloads() as [unknown, FactorRow[]];
    expect(factorRows).toHaveLength(HEALTH_FACTOR_KEYS.length);

    for (const row of factorRows) {
      expect(row.status).toBe("missing");
      expect(row.value).toBeNull();
      expect(row.missingReason).not.toBeNull();
      expect(row.effectiveWeightBps).toBe(0);
      expect(row.contributionBps).toBe(0);
      expect(row.observations).toBe(0);
    }
  });

  /**
   * Every input is written down, present or not. Storing only the measured ones
   * would make "which customers are unscored because nobody records their
   * activity" unanswerable — the question the coverage number exists to make
   * askable.
   */
  it("stores a row for every input in the vocabulary, with its own window", async () => {
    const db = scriptAssessment(new FakeDb(), { sources: [true, true, false, false] });
    const service = new CustomerHealthService(db.asDb());

    await service.assess(ORG, PARTY, AS_OF);

    const [, factorRows] = db.valuePayloads() as [unknown, FactorRow[]];
    expect(factorRows.map((row) => row.factorKey).sort()).toEqual(
      [...HEALTH_FACTOR_KEYS].sort(),
    );
    /** Not one shared window: support reaches back further than engagement. */
    const byKey = new Map(factorRows.map((row) => [row.factorKey, row]));
    expect(byKey.get("support")!.windowDays).toBeGreaterThan(
      byKey.get("engagement")!.windowDays,
    );
  });

  /**
   * With enough of the model measured the score is stored and projected. The
   * coverage travels with it, because 100 from two of four inputs is not the
   * same claim as 100 from four.
   */
  it("scores from the inputs it did measure and reports how many that was", async () => {
    const db = scriptAssessment(new FakeDb(), {
      sources: [true, true, false, false],
      engagement: {
        activityCount: 8,
        contactDays: 6,
        lastActivityAt: new Date(AS_OF.getTime() - 24 * 60 * 60 * 1000),
      },
      support: { opened: 0, urgent: 0, slaBreached: 0, openNow: 0 },
    });
    const service = new CustomerHealthService(db.asDb());

    const { data } = await service.assess(ORG, PARTY, AS_OF);

    expect(data.score).toBe(100);
    expect(data.band).toBe("healthy");
    expect(data.coverageBps).toBe(5000);

    const [partySet] = db.setPayloads() as [Record<string, unknown>];
    expect(partySet.healthScore).toBe(100);
    expect(partySet.healthStatus).toBe("healthy");
  });

  /**
   * `max(occurred_at)` arrives as a string on some driver paths. Unparsed, the
   * subtraction against a `Date` yields `NaN`, `Math.floor(NaN)` is `NaN`, and
   * every comparison against it is false — so recency silently falls through to
   * its most forgiving branch on exactly the customers who have gone quiet.
   */
  it("parses a timestamp the driver handed back as a string", async () => {
    const db = scriptAssessment(new FakeDb(), {
      sources: [true, false, false, false],
      engagement: {
        activityCount: 1,
        contactDays: 1,
        lastActivityAt: "2026-04-01T00:00:00.000Z",
      },
    });
    const service = new CustomerHealthService(db.asDb());

    const { data } = await service.assess(ORG, PARTY, AS_OF);
    const engagement = data.factors.find((factor) => factor.key === "engagement");

    expect(engagement?.detail.daysSinceLastActivity).toBe(148);
  });

  /** Another tenant's customer is a 404, never a 403 that confirms it exists. */
  it("refuses a party the organisation does not hold", async () => {
    const db = new FakeDb().script("select", []);
    const service = new CustomerHealthService(db.asDb());

    await expect(service.assess(ORG, PARTY, AS_OF)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    /** And stops there: no source is consulted for a customer that is not ours. */
    expect(db.calls.filter((call) => call.method === "select")).toHaveLength(1);
  });
});

describe("CustomerHealthService.get", () => {
  /**
   * A GET that computed on the way past would let a refresh loop become a write
   * loop, and would mean two people reading the same customer this afternoon
   * could see different numbers with nothing recording why.
   */
  it("does not compute an assessment that has never been made", async () => {
    const db = new FakeDb().script("select", []);
    const service = new CustomerHealthService(db.asDb());

    await expect(service.get(ORG, PARTY)).rejects.toBeInstanceOf(NotFoundException);
    expect(db.calls.filter((call) => call.method === "insert")).toHaveLength(0);
    expect(db.calls.filter((call) => call.method === "update")).toHaveLength(0);
  });

  it("returns the stored score with the inputs it decomposes into", async () => {
    const db = new FakeDb()
      .script("select", [
        {
          customerHealthAssessmentId: "cha_1",
          partyId: PARTY,
          partyName: "Northwind Trading",
          score: 61,
          healthStatus: "at_risk",
          coverageBps: 6500,
          weightsVersion: 1,
          computedAt: AS_OF,
        },
      ])
      .script("select", [
        { factorKey: "engagement", status: "measured", value: 70 },
        { factorKey: "usage", status: "missing", value: null },
      ]);
    const service = new CustomerHealthService(db.asDb());

    const { data } = await service.get(ORG, PARTY);

    expect(data.score).toBe(61);
    expect(data.factors).toHaveLength(2);
  });
});
