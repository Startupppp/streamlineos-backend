import type { AuditService } from "../../common/audit/audit.service";
import type { Db } from "../../db/drizzle.types";
import {
  businessParties,
  clientPartyMap,
  contactPartyMap,
  leadPartyMap,
  partyMerges,
} from "../../db/schema/party";
import { PartyMergeService } from "./party-merge.service";
import { PartyRevertService } from "./party-revert.service";

/**
 * The two things a merge has to get right, over one database double.
 *
 * **Legacy identifiers.** Merging two records that turn out to be one person has
 * to leave *both* legacy identifiers resolving — to the survivor. Phase 1's
 * merge is the only mechanism for that, so the map rows move with everything
 * else the merge moves, and the snapshot carries them back on a revert. The
 * alternative, walking the merge ledger at resolution time, is a second
 * mechanism that has to agree with the first forever. These tests are what says
 * we did not build it.
 *
 * **Which record survives.** The default keeps the older one; a caller who was
 * asked may name the survivor instead. That distinction is load-bearing on a
 * destructive action and is easy to lose in a refactor — ticket 25 lost it once
 * already, by routing a dialog that asks the user to pick through a service that
 * ignored the answer.
 */

interface Write {
  table: unknown;
  values: Record<string, unknown>;
}

interface Recorded {
  updates: Write[];
  inserts: Write[];
  deletes: unknown[];
}

function fakeDb(queue: Record<string, unknown>[][], recorded: Recorded): Db {
  let next = 0;

  const select = () => {
    const chain: Record<string, unknown> = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      limit: () => chain,
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve(queue[next++] ?? []).then(resolve),
    };
    return chain;
  };

  const db: Record<string, unknown> = {
    select,
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        // Thenable *and* `.returning()`: a party write now reads back the row it
        // produced, because the legacy mirror is derived from what the party
        // became rather than from what the caller asked for.
        where: () => {
          recorded.updates.push({ table, values });
          const rows = [{ partyId: "party-old", organizationId: "org-1", ...values }];
          return Object.assign(Promise.resolve(rows), { returning: async () => rows });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        recorded.inserts.push({ table, values });
        return {
          onConflictDoNothing: async () => undefined,
          returning: async () => [{ partyMergeId: "merge-1" }],
        };
      },
    }),
    delete: (table: unknown) => ({
      where: async () => {
        recorded.deletes.push(table);
      },
    }),
  };
  // The savepoint the party writer opens so a row and its mirror move together.
  // It must run its callback, or every write inside it disappears from `recorded`.
  db.transaction = (fn: (tx: unknown) => Promise<unknown>) => fn(db);
  return db as unknown as Db;
}

const audit = { logCritical: jest.fn() } as unknown as AuditService;

const survivor = {
  partyId: "party-old",
  organizationId: "org-1",
  name: "Acme",
  createdAt: new Date("2026-01-01T00:00:00Z"),
};
const loser = {
  partyId: "party-new",
  organizationId: "org-1",
  name: "Acme Ltd",
  createdAt: new Date("2026-02-01T00:00:00Z"),
};

function updatesTo(recorded: Recorded, table: unknown): Write[] {
  return recorded.updates.filter((write) => write.table === table);
}

describe("PartyMergeService and legacy identifiers", () => {
  let recorded: Recorded;

  beforeEach(() => {
    recorded = { updates: [], inserts: [], deletes: [] };
    (audit.logCritical as unknown as jest.Mock).mockReset();
  });

  it("re-points every legacy id the loser answered for onto the survivor", async () => {
    const db = fakeDb(
      [
        [survivor], // load(left)
        [loser], // load(right)
        [], // survivor roles
        [], // loser roles
        [], // loser contacts
        [{ id: 7 }], // loser's lead ids
        [], // loser's client ids
        [{ id: 9 }], // loser's contact ids
        // Read before the identifiers move, which is the last moment the two
        // sides still hold their own.
        [], // survivor identifiers
        [], // loser identifiers
      ],
      recorded,
    );

    await new PartyMergeService(db, audit).merge("org-1", {
      leftPartyId: "party-old",
      rightPartyId: "party-new",
      decidedBy: "USER",
      userId: "u-1",
    });

    expect(updatesTo(recorded, leadPartyMap)).toEqual([
      { table: leadPartyMap, values: { partyId: "party-old" } },
    ]);
    expect(updatesTo(recorded, contactPartyMap)).toEqual([
      { table: contactPartyMap, values: { partyId: "party-old" } },
    ]);
    // Nothing was mapped for clients, so nothing is written for them.
    expect(updatesTo(recorded, clientPartyMap)).toEqual([]);
  });

  it("records what moved, so the revert has something to put back", async () => {
    const db = fakeDb(
      [[survivor], [loser], [], [], [], [{ id: 7 }], [{ id: 8 }], [], [], []],
      recorded,
    );

    await new PartyMergeService(db, audit).merge("org-1", {
      leftPartyId: "party-old",
      rightPartyId: "party-new",
      decidedBy: "SYSTEM",
    });

    const [mergeRecord] = recorded.inserts.filter((write) => write.table === partyMerges);
    expect(mergeRecord.values.snapshot).toMatchObject({
      movedLegacyIds: { lead: [7], client: [8], contact: [] },
    });
  });

  it("writes nothing to the maps when the loser answered for no legacy id", async () => {
    const db = fakeDb([[survivor], [loser], [], [], [], [], [], [], [], []], recorded);

    await new PartyMergeService(db, audit).merge("org-1", {
      leftPartyId: "party-old",
      rightPartyId: "party-new",
      decidedBy: "SYSTEM",
    });

    expect(updatesTo(recorded, leadPartyMap)).toEqual([]);
    expect(updatesTo(recorded, clientPartyMap)).toEqual([]);
    expect(updatesTo(recorded, contactPartyMap)).toEqual([]);
    // The merge itself still happened.
    expect(updatesTo(recorded, businessParties).at(-1)?.values).toHaveProperty("deletedAt");
  });

  it("gives the legacy ids back to the restored record on a revert", async () => {
    const db = fakeDb(
      [
        [
          {
            partyMergeId: "merge-1",
            organizationId: "org-1",
            survivorPartyId: "party-old",
            mergedPartyId: "party-new",
            decidedBy: "USER",
            snapshot: {
              survivorBefore: { ...survivor },
              mergedBefore: { ...loser },
              movedContactIds: [],
              addedRoles: [],
              movedLegacyIds: { lead: [7], client: [], contact: [9] },
            },
          },
        ],
      ],
      recorded,
    );

    await new PartyRevertService(db, audit).revert("org-1", "merge-1", "u-1");

    expect(updatesTo(recorded, leadPartyMap)).toEqual([
      { table: leadPartyMap, values: { partyId: "party-new" } },
    ]);
    expect(updatesTo(recorded, contactPartyMap)).toEqual([
      { table: contactPartyMap, values: { partyId: "party-new" } },
    ]);
  });

  it("reverts a merge recorded before the expand, whose snapshot has no legacy ids", async () => {
    const db = fakeDb(
      [
        [
          {
            partyMergeId: "merge-0",
            organizationId: "org-1",
            survivorPartyId: "party-old",
            mergedPartyId: "party-new",
            decidedBy: "SYSTEM",
            snapshot: {
              survivorBefore: { ...survivor },
              mergedBefore: { ...loser },
              movedContactIds: [],
              addedRoles: [],
            },
          },
        ],
      ],
      recorded,
    );

    await expect(
      new PartyRevertService(db, audit).revert("org-1", "merge-0"),
    ).resolves.toMatchObject({ restoredPartyId: "party-new" });
    expect(updatesTo(recorded, leadPartyMap)).toEqual([]);
  });
});

describe("PartyMergeService and which record survives", () => {
  let recorded: Recorded;

  beforeEach(() => {
    recorded = { updates: [], inserts: [], deletes: [] };
    (audit.logCritical as unknown as jest.Mock).mockReset();
  });

  /** The one row that records the decision, whichever way it went. */
  const mergeRecordIn = (recorded: Recorded): Record<string, unknown> =>
    recorded.inserts.filter((write) => write.table === partyMerges)[0]?.values ?? {};

  const queue = (): Record<string, unknown>[][] => [
    [survivor],
    [loser],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
  ];

  it("keeps the older record when nobody was asked", async () => {
    const db = fakeDb(queue(), recorded);

    const outcome = await new PartyMergeService(db, audit).merge("org-1", {
      leftPartyId: "party-old",
      rightPartyId: "party-new",
      decidedBy: "SYSTEM",
    });

    expect(outcome.survivorPartyId).toBe("party-old");
    expect(mergeRecordIn(recorded).survivorPartyId).toBe("party-old");
  });

  /**
   * The regression this file is named for. `party-new` is the *younger* record,
   * so `chooseSurvivor` would discard it — and `planMerge` resolves every field
   * conflict in the survivor's favour, so discarding it means handing the older
   * stub's name and domain to the record the user was looking straight at, and
   * reporting success.
   */
  it("keeps the record the caller nominated, even when it is the younger one", async () => {
    const db = fakeDb(queue(), recorded);

    const outcome = await new PartyMergeService(db, audit).merge("org-1", {
      leftPartyId: "party-old",
      rightPartyId: "party-new",
      decidedBy: "USER",
      userId: "u-1",
      preferSurvivorPartyId: "party-new",
    });

    expect(outcome.survivorPartyId).toBe("party-new");
    expect(mergeRecordIn(recorded).survivorPartyId).toBe("party-new");
  });

  /**
   * Rejected rather than ignored. A nomination naming neither side is a caller
   * bug, and the merge is destructive — falling back to the default here would
   * carry out a different merge than the one that was asked for, which is the
   * exact failure the option exists to prevent.
   */
  it("refuses a nomination that names neither party", async () => {
    const db = fakeDb(queue(), recorded);

    await expect(
      new PartyMergeService(db, audit).merge("org-1", {
        leftPartyId: "party-old",
        rightPartyId: "party-new",
        decidedBy: "USER",
        preferSurvivorPartyId: "party-somewhere-else",
      }),
    ).rejects.toThrow(/must name one of the two parties/);

    expect(recorded.inserts.filter((write) => write.table === partyMerges)).toEqual([]);
  });
});
