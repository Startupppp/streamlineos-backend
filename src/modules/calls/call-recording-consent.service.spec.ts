import type { Db } from "../../db/drizzle.types";
import { activities } from "../../db/schema";
import { callRecordingConsent } from "../../db/schema/crm/call-analysis";
import { crmContactChannelConsent } from "../../db/schema/crm/consent";
import { CallRecordingConsentService } from "./call-recording-consent.service";

/**
 * The rule is fed from two stores, and this is what proves it.
 *
 * `call-recording-consent.spec.ts` decides cases from facts handed to it.
 * Nothing there would notice if this service read only its own table and never
 * consulted the CRM's existing consent machinery — the rule would still be
 * correct and the product would still refuse every call whose only evidence is a
 * standing PHONE opt-in, which is most of them.
 *
 * The other half is the direction the two stores disagree in. A customer who has
 * opted out of phone contact and an attestation that says they consented is not
 * a tie: the opt-out is the more recent statement by the person the rule
 * protects, and a service that let the attestation win would let one form filled
 * in by an employee override what the customer actually said.
 */

const ORG = "org-1";
const OTHER_ORG = "org-2";
const ACTIVITY = "act-1";
const PARTY = "party-1";
const USER = "user-1";

const CALL_AT = new Date("2026-06-10T10:00:00.000Z");
const BEFORE = new Date("2026-05-01T00:00:00.000Z");
const AFTER = new Date("2026-06-20T00:00:00.000Z");

/**
 * The bound values inside a Drizzle `and(eq(...))` clause.
 *
 * The predicates are honoured rather than ignored, which is the difference
 * between a double and a lie: a double that returned its rows whatever it was
 * asked would have reported tenant isolation working for a query that had none.
 */
function paramValues(clause: unknown): unknown[] {
  const found: unknown[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record["queryChunks"])) {
      for (const chunk of record["queryChunks"]) walk(chunk);
      return;
    }
    if ("value" in record && "encoder" in record) found.push(record["value"]);
  };
  walk(clause);
  return found;
}

interface Fixture {
  readonly calls?: Array<{ activityId: string; occurredAt: Date; partyId: string | null }>;
  readonly attestations?: Array<Record<string, unknown>>;
  readonly standing?: Array<{
    contactPartyId: string | null;
    status: "OPTED_IN" | "OPTED_OUT" | "UNKNOWN";
    capturedAt: Date;
    expiresAt: Date | null;
  }>;
}

function makeDb(fixture: Fixture) {
  const clauses: unknown[] = [];
  const tablesRead: string[] = [];
  const writes: Array<Record<string, unknown>> = [];

  const rowsFor = (table: unknown): unknown[] => {
    if (table === activities) {
      tablesRead.push("activities");
      return fixture.calls ?? [];
    }
    if (table === callRecordingConsent) {
      tablesRead.push("crm_call_recording_consent");
      return fixture.attestations ?? [];
    }
    if (table === crmContactChannelConsent) {
      tablesRead.push("crm_contact_channel_consent");
      return fixture.standing ?? [];
    }
    throw new Error("the service read a table this double does not know about");
  };

  const db = {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockImplementation((table: unknown) => {
        const rows = rowsFor(table);
        return {
          where: jest.fn().mockImplementation(async (clause: unknown) => {
            clauses.push(clause);
            // The organisation predicate is honoured, so a fixture belonging to
            // one tenant cannot answer another tenant's read.
            const bound = paramValues(clause);
            return bound.includes(ORG) ? rows : [];
          }),
        };
      }),
    })),
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockImplementation((row: Record<string, unknown>) => ({
        onConflictDoUpdate: jest.fn().mockImplementation(async () => {
          writes.push(row);
        }),
      })),
    })),
  } as unknown as Db;

  return { db, clauses, tablesRead, writes };
}

/** `attest` uses `.limit(1)` on its existence check; `decideMany` does not. */
function withLimit(base: ReturnType<typeof makeDb>) {
  const db = base.db as unknown as { select: jest.Mock };
  const inner = db.select.getMockImplementation()!;
  db.select.mockImplementation(() => {
    const built = inner() as { from: jest.Mock };
    const from = built.from.getMockImplementation()!;
    built.from = jest.fn().mockImplementation((table: unknown) => {
      const where = (from(table) as { where: jest.Mock }).where;
      return {
        where: jest.fn().mockImplementation((clause: unknown) => {
          const promise = where(clause) as Promise<unknown[]>;
          return Object.assign(promise, { limit: async () => promise });
        }),
      };
    });
    return built;
  });
  return base;
}

const call = () => [{ activityId: ACTIVITY, occurredAt: CALL_AT, partyId: PARTY }];

const attestation = (over: Record<string, unknown> = {}) => [
  {
    activityId: ACTIVITY,
    jurisdiction: "US-CA",
    orgPartyConsentedAt: BEFORE,
    orgPartyMethod: "own-recording",
    counterpartyConsentedAt: null,
    counterpartyMethod: null,
    counterpartyWithdrawnAt: null,
    ...over,
  },
];

const reasonOf = async (fixture: Fixture, org = ORG) => {
  const { db } = makeDb(fixture);
  const decision = await new CallRecordingConsentService(db).decide(org, ACTIVITY);
  return decision.verdict.allowed ? "allowed" : decision.verdict.reason;
};

describe("the rule is fed from both consent stores", () => {
  it("reads the call, the attestation and the CRM's standing consent", async () => {
    const { db, tablesRead } = makeDb({
      calls: call(),
      attestations: attestation(),
      standing: [
        { contactPartyId: PARTY, status: "OPTED_IN", capturedAt: BEFORE, expiresAt: null },
      ],
    });

    await new CallRecordingConsentService(db).decide(ORG, ACTIVITY);

    // A service that read only its own table would refuse every call whose only
    // evidence is a standing opt-in, which is most of them, and no case in
    // `call-recording-consent.spec.ts` would notice.
    expect(new Set(tablesRead)).toEqual(
      new Set(["activities", "crm_call_recording_consent", "crm_contact_channel_consent"]),
    );
  });

  it("accepts a standing PHONE opt-in as the customer's consent", async () => {
    expect(
      await reasonOf({
        calls: call(),
        attestations: attestation(),
        standing: [
          { contactPartyId: PARTY, status: "OPTED_IN", capturedAt: BEFORE, expiresAt: null },
        ],
      }),
    ).toBe("allowed");
  });

  it("does not treat UNKNOWN as a quiet yes", async () => {
    /**
     * `UNKNOWN` is the status every contact starts on.
     * `CrmConsentService.filterSendable` treats it as non-blocking for outbound,
     * because a legal basis other than consent may cover a phone call — and that
     * reasoning does not carry over here, because nothing but consent makes a
     * recording lawful in an all-party jurisdiction. Reusing the outbound
     * reading would have unlocked every contact nobody has ever asked.
     */
    expect(
      await reasonOf({
        calls: call(),
        attestations: attestation(),
        standing: [
          { contactPartyId: PARTY, status: "UNKNOWN", capturedAt: BEFORE, expiresAt: null },
        ],
      }),
    ).toBe("counterparty-consent-missing");
  });

  it("lets a channel opt-out beat an attestation that says they consented", async () => {
    // Not a tie. The opt-out is the customer's own statement; the attestation is
    // a form an employee filled in.
    expect(
      await reasonOf({
        calls: call(),
        attestations: attestation({
          counterpartyConsentedAt: BEFORE,
          counterpartyMethod: "announced-and-acknowledged",
        }),
        standing: [
          { contactPartyId: PARTY, status: "OPTED_OUT", capturedAt: AFTER, expiresAt: null },
        ],
      }),
    ).toBe("counterparty-consent-withdrawn");
  });

  it("picks the opt-out when one party has two consent rows", async () => {
    /**
     * A party can carry more than one row: the unique index on
     * `crm_contact_channel_consent` is per contact, and two contacts can map to
     * one party. Keeping whichever the planner returned last would make the
     * verdict depend on row order and would sometimes drop an opt-out — the
     * exact failure that is invisible in production and reproducible nowhere.
     */
    const standing = [
      { contactPartyId: PARTY, status: "OPTED_IN" as const, capturedAt: BEFORE, expiresAt: null },
      { contactPartyId: PARTY, status: "OPTED_OUT" as const, capturedAt: AFTER, expiresAt: null },
    ];

    expect(await reasonOf({ calls: call(), attestations: attestation(), standing })).toBe(
      "counterparty-consent-withdrawn",
    );
    expect(
      await reasonOf({
        calls: call(),
        attestations: attestation(),
        standing: [...standing].reverse(),
      }),
    ).toBe("counterparty-consent-withdrawn");
  });
});

describe("what a call with no attestation gets", () => {
  it("refuses for want of a jurisdiction, not for want of consent", async () => {
    // Different fixes, different people: an unrecorded jurisdiction is a
    // data-entry gap the team closes for every call at once, and missing consent
    // is a conversation with a customer.
    expect(
      await reasonOf({
        calls: call(),
        standing: [
          { contactPartyId: PARTY, status: "OPTED_IN", capturedAt: BEFORE, expiresAt: null },
        ],
      }),
    ).toBe("jurisdiction-unrecorded");
  });

  it("refuses a call that is not on this organisation's timeline", async () => {
    // Falls through the rule rather than around it, so a refusal has one shape
    // however it was reached.
    expect(await reasonOf({ calls: call(), attestations: attestation() }, OTHER_ORG)).toBe(
      "jurisdiction-unrecorded",
    );
  });

  it("carries the organisation predicate on every read", async () => {
    const { db, clauses } = makeDb({ calls: call(), attestations: attestation() });
    await new CallRecordingConsentService(db).decide(ORG, ACTIVITY);

    // A tenant-scoped table queried without one leaves RLS as the only thing
    // between two customers' compliance records.
    expect(clauses.length).toBeGreaterThanOrEqual(2);
    for (const clause of clauses) expect(paramValues(clause)).toContain(ORG);
  });
});

describe("attesting", () => {
  it("refuses a jurisdiction that is not an ISO code, rather than storing it", async () => {
    const { db, writes } = withLimit(makeDb({ calls: call() }));
    const outcome = await new CallRecordingConsentService(db).attest(ORG, USER, ACTIVITY, {
      jurisdiction: "California",
      orgPartyConsented: true,
      counterpartyConsented: false,
      counterpartyMethod: null,
      counterpartyWithdrawn: false,
      note: null,
    });

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe("bad-jurisdiction");
    // A stored "California" matches no register entry and resolves to all-party
    // — the right answer by accident.
    expect(writes).toEqual([]);
  });

  it("refuses a call that is not on this organisation's timeline", async () => {
    const { db, writes } = withLimit(makeDb({ calls: [] }));
    const outcome = await new CallRecordingConsentService(db).attest(ORG, USER, ACTIVITY, {
      jurisdiction: "US-CA",
      orgPartyConsented: true,
      counterpartyConsented: false,
      counterpartyMethod: null,
      counterpartyWithdrawn: false,
      note: null,
    });

    expect(!outcome.ok && outcome.reason).toBe("not-found");
    expect(writes).toEqual([]);
  });

  it("stamps the server's clock, so nothing can be back-dated to before the call", async () => {
    /**
     * The one edit that would turn this route into a way of retroactively
     * legalising a recording. There is no `consentedAt` on the DTO and none in
     * the write below; a consent that postdates the call refuses, which is what
     * makes `counterparty-consent-after-the-call` trustworthy.
     */
    const { db, writes } = withLimit(makeDb({ calls: call() }));
    await new CallRecordingConsentService(db).attest(ORG, USER, ACTIVITY, {
      jurisdiction: "us-ca",
      orgPartyConsented: true,
      counterpartyConsented: true,
      counterpartyMethod: "announced-and-acknowledged",
      counterpartyWithdrawn: false,
      note: "notice played at the top of the call",
    });

    expect(writes).toHaveLength(1);
    const written = writes[0]!;
    expect(written["jurisdiction"]).toBe("US-CA");
    expect(written["attestedByUserId"]).toBe(USER);
    const consentedAt = written["counterpartyConsentedAt"] as Date;
    expect(consentedAt.getTime()).toBeGreaterThan(CALL_AT.getTime());
  });
});
