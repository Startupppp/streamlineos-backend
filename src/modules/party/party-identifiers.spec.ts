import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../../db/drizzle.types";
import {
  claimIdentifiers,
  claimsOfPatch,
  identifierClaimsOfColumns,
  resolvePartyByIdentifier,
  COLUMN_FOR_KIND,
  IDENTIFIER_KINDS,
  MATCHING_KINDS,
} from "./party-identifiers";

/**
 * The rules that decide who a message belongs to.
 *
 * Every one of them is a way the same person becomes two records, which is the
 * failure this table exists to end — so they are asserted rather than described.
 * The database half (does the backfill reach every row?) cannot be shown with a
 * fake, and lives in `party-identifiers.db.spec.ts`.
 */

interface Chain extends PromiseLike<unknown[]> {
  from(source?: unknown): Chain;
  where(...clauses: unknown[]): Chain;
  limit(count?: number): Chain;
  set(values: Record<string, unknown>): Chain;
  values(rows: unknown): Chain;
  onConflictDoNothing(): Chain;
  returning(columns?: unknown): Chain;
}

interface Recorder {
  readonly inserted: Record<string, unknown>[][];
  readonly deletes: number;
  readonly reads: number;
}

/**
 * A database stand-in that answers a scripted queue of reads.
 *
 * Deliberately not a query recorder: what matters here is which party comes
 * back and what gets written, not the SQL that asked.
 */
function makeDb(queue: unknown[][]): { db: Db; recorder: Recorder } {
  const recorder = { inserted: [] as Record<string, unknown>[][], deletes: 0, reads: 0 };
  let read = 0;

  const chain = (rows: () => unknown[]): Chain => {
    const self: Chain = {
      from: () => self,
      where: () => self,
      limit: () => self,
      set: () => self,
      values: (payload: unknown) => {
        recorder.inserted.push(
          (Array.isArray(payload) ? payload : [payload]) as Record<string, unknown>[],
        );
        return self;
      },
      onConflictDoNothing: () => self,
      returning: () => self,
      then: (resolve, reject) => Promise.resolve().then(rows).then(resolve, reject),
    };
    return self;
  };

  const db = {
    select: () =>
      chain(() => {
        recorder.reads += 1;
        read += 1;
        return queue[read - 1] ?? [];
      }),
    insert: () => chain(() => []),
    update: () => chain(() => []),
    delete: () =>
      chain(() => {
        recorder.deletes += 1;
        return [];
      }),
  } as unknown as Db;

  return { db, recorder };
}

describe("the identifier vocabulary is closed, in both places it is written", () => {
  const migration = readFileSync(
    join(__dirname, "..", "..", "..", "migrations", "0260_party_identifiers.sql"),
    "utf8",
  );

  /**
   * The kinds exist twice: once in TypeScript, once as a CHECK constraint. A
   * migration cannot import the constant, so the only defence against them
   * drifting is to fail here when they do — a kind added to one and not the
   * other is a write that passes review and then raises 23514 in production.
   */
  it("says the same four kinds in the migration as in the seam", () => {
    const listed = migration.match(/chk_party_identifiers_kind[\s\S]*?IN \(([^)]+)\)/)?.[1];
    expect(listed).toBeDefined();
    const kinds = [...(listed ?? "").matchAll(/'([a-z]+)'/g)].map((match) => match[1]);
    expect(kinds.sort()).toEqual([...IDENTIFIER_KINDS].sort());
  });

  /**
   * Uniqueness is the ticket's hard requirement — "impossible rather than
   * merely unlikely" — and it is a property of the index, not of the code.
   */
  it("makes two parties claiming one number impossible at the database", () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX[^;]*"uniq_party_identifiers_value"[\s\S]*?\("organization_id", "kind", "normalised_value"\)/,
    );
  });

  it("gives every kind a lookup order and a column decision", () => {
    for (const kind of IDENTIFIER_KINDS) {
      expect(MATCHING_KINDS[kind][0]).toBe(kind);
      expect(COLUMN_FOR_KIND).toHaveProperty(kind);
    }
    // A handle has no column, and inventing one is what this table replaced.
    expect(COLUMN_FOR_KIND.handle).toBeNull();
  });
});

describe("what a party's columns claim", () => {
  it("claims each contact column as the kind it names", () => {
    expect(
      identifierClaimsOfColumns({
        email: "Priya@Example.com",
        phone: "+44 20 7123 4567",
        whatsappPhone: "+44 7700 900123",
      }),
    ).toEqual([
      { kind: "email", value: "Priya@Example.com" },
      { kind: "phone", value: "+44 20 7123 4567" },
      { kind: "whatsapp", value: "+44 7700 900123" },
    ]);
  });

  it("claims nothing for blank columns", () => {
    expect(identifierClaimsOfColumns({ email: "   ", phone: null })).toEqual([]);
  });

  /**
   * The gate that keeps this off the writes that make up nearly all of them.
   * A patch that mentions no contact column cannot change what a party is
   * reachable at.
   */
  it("stays out of the way of a patch that touches no contact column", () => {
    expect(claimsOfPatch({})).toBeNull();
    expect(claimsOfPatch({ email: null })).toEqual([]);
    expect(claimsOfPatch({ phone: "+14155551212" })).toHaveLength(1);
  });
});

describe("claiming", () => {
  it("stores what arrived beside the value it is matched on", async () => {
    const { db, recorder } = makeDb([]);
    await claimIdentifiers(db, "org-1", "party-1", [
      { kind: "phone", value: " +1 (415) 555-1212 " },
    ]);

    expect(recorder.inserted[0]).toEqual([
      {
        organizationId: "org-1",
        partyId: "party-1",
        kind: "phone",
        value: "+1 (415) 555-1212",
        normalisedValue: "+14155551212",
      },
    ]);
  });

  /**
   * Two claims that reduce to one value cannot both be inserted: `ON CONFLICT
   * DO NOTHING` cannot resolve a conflict between two rows of the SAME
   * statement, and Postgres raises 21000 rather than dropping one.
   */
  it("collapses two spellings of one number into a single row", async () => {
    const { db, recorder } = makeDb([]);
    await claimIdentifiers(db, "org-1", "party-1", [
      { kind: "phone", value: "+1 (415) 555-1212" },
      { kind: "phone", value: "+14155551212" },
    ]);

    expect(recorder.inserted[0]).toHaveLength(1);
  });

  it("writes nothing at all when every claim reduces to nothing", async () => {
    const { db, recorder } = makeDb([]);
    await claimIdentifiers(db, "org-1", "party-1", [{ kind: "phone", value: "   " }]);
    expect(recorder.inserted).toHaveLength(0);
  });
});

describe("resolving a sender", () => {
  it("returns the party holding the identifier", async () => {
    const { db } = makeDb([[{ partyIdentifierId: "id-1", partyId: "party-1" }], [{ deletedAt: null }]]);
    expect(await resolvePartyByIdentifier(db, "org-1", "email", "Priya@Example.com")).toBe(
      "party-1",
    );
  });

  it("returns nothing for an address nobody has claimed", async () => {
    const { db } = makeDb([[]]);
    expect(await resolvePartyByIdentifier(db, "org-1", "phone", "+14155551212")).toBeNull();
  });

  it("asks nothing at all of an address that reduces to nothing", async () => {
    const { db, recorder } = makeDb([]);
    expect(await resolvePartyByIdentifier(db, "org-1", "phone", "  ")).toBeNull();
    expect(recorder.reads).toBe(0);
  });

  /**
   * A claim held by a soft-deleted record is released rather than honoured.
   *
   * Filing new contact against a record the organisation deleted hides the
   * message; refusing to create a party because a deleted one still holds the
   * address would make the deletion poison that address permanently. Releasing
   * it restores exactly the behaviour that existed before this table — a deleted
   * record is not matched, and the next contact starts a new one.
   */
  it("releases a claim held by a record that was deleted", async () => {
    const { db, recorder } = makeDb([
      [{ partyIdentifierId: "id-1", partyId: "party-gone" }],
      [{ deletedAt: new Date("2026-01-01T00:00:00.000Z") }],
    ]);

    expect(await resolvePartyByIdentifier(db, "org-1", "email", "priya@example.com")).toBeNull();
    expect(recorder.deletes).toBe(1);
  });
});
