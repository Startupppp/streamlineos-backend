import { activation } from "./activation";
import { DEMO_SOURCE, demoDataset } from "./demo-dataset";
import { seedDemoDataset } from "./seed-demo-dataset";

const ORG = "org-1";
const OWNER = "user-1";
const NOW = new Date("2026-08-27T09:00:00.000Z");

interface Written {
  table: string;
  rows: Record<string, unknown>[];
}

/**
 * Records what was written and hands back plausible `RETURNING` rows, so the
 * assertions can be about the rows themselves rather than about which mock was
 * reached.
 */
function buildTx(existingDemoParty = false) {
  const written: Written[] = [];
  let nextDealId = 100;

  const insert = jest.fn().mockImplementation((table: unknown) => {
    const name = tableNameOf(table);
    let captured: Record<string, unknown>[] = [];
    const chain: Record<string, unknown> = {};

    chain.values = jest.fn().mockImplementation((rows: unknown) => {
      captured = (Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[];
      written.push({ table: name, rows: captured });
      return chain;
    });
    chain.returning = jest
      .fn()
      .mockImplementation(async () =>
        captured.map((row) => ({ id: nextDealId++, name: row["name"] })),
      );
    return chain;
  });

  const tx = {
    insert,
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest
            .fn()
            .mockResolvedValue(existingDemoParty ? [{ partyId: "already-there" }] : []),
        }),
      }),
    }),
  };

  const rowsOf = (table: string): Record<string, unknown>[] =>
    written.filter((entry) => entry.table === table).flatMap((entry) => entry.rows);

  return { tx, written, rowsOf };
}

function tableNameOf(table: unknown): string {
  for (const symbol of Object.getOwnPropertySymbols(table as object)) {
    if (!symbol.description?.includes("Name")) continue;
    const value = (table as Record<symbol, unknown>)[symbol];
    if (typeof value === "string") return value;
  }
  return "unknown";
}

describe("the demo dataset", () => {
  it("is big enough that counting it would make every new workspace look activated", () => {
    // The reason the exclusion has to exist at all. If this ever stops being
    // true the dataset has shrunk below the point of seeding one, and the
    // decision to keep it should be taken deliberately rather than by drift.
    const dataset = demoDataset();

    const asIfItCounted = activation({
      realParties: dataset.parties.length,
      realDeals: dataset.deals.length,
      realActivities: dataset.activities.length,
      activeMembers: 1,
      hasCompletedImport: false,
      hasConnectedChannel: false,
    });

    expect(asIfItCounted.isActivated).toBe(true);
  });

  it("puts a pipeline in front of the prospect, not one row", () => {
    const dataset = demoDataset();

    expect(dataset.deals.length).toBeGreaterThanOrEqual(4);
    expect(new Set(dataset.deals.map((deal) => deal.stage)).size).toBeGreaterThanOrEqual(4);
    expect(dataset.parties.some((party) => party.partyKind === "PERSON")).toBe(true);
    expect(dataset.parties.some((party) => party.partyKind === "ORGANISATION")).toBe(true);
  });

  it("anchors every activity to exactly one thing", () => {
    for (const activity of demoDataset().activities) {
      const anchors = ("party" in activity.anchor ? 1 : 0) + ("deal" in activity.anchor ? 1 : 0);
      expect(anchors).toBe(1);
    }
  });
});

describe("seeding it", () => {
  it("marks every party it writes, so none of them can be mistaken for the tenant's", async () => {
    const { tx, rowsOf } = buildTx();

    await seedDemoDataset(tx as never, ORG, OWNER, NOW);

    const parties = rowsOf("business_parties");
    expect(parties).toHaveLength(demoDataset().parties.length);
    expect(parties.every((row) => row["acquisitionSource"] === DEMO_SOURCE)).toBe(true);
    expect(parties.every((row) => row["organizationId"] === ORG)).toBe(true);
  });

  it("marks every activity it writes", async () => {
    const { tx, rowsOf } = buildTx();

    await seedDemoDataset(tx as never, ORG, OWNER, NOW);

    const activities = rowsOf("activities");
    expect(activities).toHaveLength(demoDataset().activities.length);
    expect(activities.every((row) => row["source"] === DEMO_SOURCE)).toBe(true);
  });

  /**
   * `deals` has no provenance column, so the exclusion reads through the party.
   * A seeded deal that reached a party outside the dataset -- or none at all --
   * would count as the tenant's own the moment it landed.
   */
  it("attaches every deal it writes to a marked party, because that is how deals are recognised", async () => {
    const { tx, rowsOf } = buildTx();

    await seedDemoDataset(tx as never, ORG, OWNER, NOW);

    const seededPartyIds = new Set(rowsOf("business_parties").map((row) => row["partyId"]));
    const deals = rowsOf("deals");

    expect(deals).toHaveLength(demoDataset().deals.length);
    expect(deals.every((row) => seededPartyIds.has(row["partyId"]))).toBe(true);
  });

  it("gives every party a role, so the CRM's role filters find them", async () => {
    const { tx, rowsOf } = buildTx();

    await seedDemoDataset(tx as never, ORG, OWNER, NOW);

    expect(rowsOf("party_roles")).toHaveLength(demoDataset().parties.length);
  });

  it("puts a due date only on a task", async () => {
    const { tx, rowsOf } = buildTx();

    await seedDemoDataset(tx as never, ORG, OWNER, NOW);

    for (const row of rowsOf("activities")) {
      if (row["kind"] === "task") expect(row["dueAt"]).toBeInstanceOf(Date);
      else expect(row["dueAt"]).toBeUndefined();
    }
  });

  it("writes each activity against exactly one anchor", async () => {
    const { tx, rowsOf } = buildTx();

    await seedDemoDataset(tx as never, ORG, OWNER, NOW);

    for (const row of rowsOf("activities")) {
      const anchors =
        (row["partyId"] === null ? 0 : 1) +
        (row["dealId"] === null ? 0 : 1) +
        (row["subjectId"] === null || row["subjectId"] === undefined ? 0 : 1);
      expect(anchors).toBe(1);
    }
  });

  it("does nothing a second time, so a retried claim does not double the pipeline", async () => {
    const { tx, written } = buildTx(true);

    const result = await seedDemoDataset(tx as never, ORG, OWNER, NOW);

    expect(result).toEqual({ seeded: false });
    expect(written).toHaveLength(0);
  });

  it("never touches the tables behind the other activation signals", async () => {
    const { tx, written } = buildTx();

    await seedDemoDataset(tx as never, ORG, OWNER, NOW);

    const touched = new Set(written.map((entry) => entry.table));
    expect(touched.has("crm_imports")).toBe(false);
    expect(touched.has("inbound_events")).toBe(false);
    expect(touched.has("organization_members")).toBe(false);
  });
});
