import type { Db } from "../../db/drizzle.types";
import { LEAD_MIRROR, mirroredColumns, type PartyRow } from "./party-legacy-mirror";
import { PartyDivergenceService } from "./party-divergence.service";

/**
 * The check reports; it never repairs.
 *
 * Every test here also asserts that nothing was written, because the failure
 * mode worth guarding against is not a missed divergence — it is a check that
 * quietly fixes one. A repaired row looks identical to a row that never
 * diverged, so the evidence of which write path produced it, and in which
 * direction, is gone at exactly the moment somebody needs it.
 */

jest.mock("./party-legacy-seam", () => ({
  ...jest.requireActual("./party-legacy-seam"),
  // Its own query builds a `NOT EXISTS` correlated subquery, which a chain fake
  // cannot stand in for. Its behaviour is covered by `party-legacy-seam.spec.ts`.
  countUnmappedLegacyRows: jest
    .fn()
    .mockResolvedValue({ LEAD: 2, CLIENT: 0, CONTACT: 0, ORGANISATION: 0 }),
}));

const ORG = "org-1";

const PARTY: PartyRow = {
  partyId: "party-1",
  organizationId: ORG,
  partyType: "CUSTOMER",
  name: "Ada Lovelace",
  legalName: null,
  displayName: null,
  taxNumber: null,
  website: null,
  email: "ada@lovelace.test",
  phone: null,
  status: "active",
  customFields: null,
  notes: null,
  jobTitle: "Head of Computation",
  department: null,
  companyName: null,
  whatsappPhone: null,
  avatarUrl: null,
  linkedinUrl: null,
  socialProfiles: null,
  city: null,
  state: null,
  lifecycleStage: "QUALIFIED",
  priority: "HOT",
  qualificationScore: 71,
  convertedAt: null,
  lostReason: null,
  slaDueAt: null,
  nextFollowUpAt: null,
  followUpNotes: null,
  acquisitionSource: "referral",
  acquisitionSubSource: null,
  acquisitionCampaignId: null,
  acquisitionContext: null,
  referredBy: null,
  ownerUserId: null,
  assignedByUserId: null,
  assignedAt: null,
  verifiedByUserId: null,
  statedBudget: null,
  expectedValue: null,
  lifetimeValue: null,
  healthScore: null,
  healthStatus: null,
  healthCheckedAt: null,
  churnRiskScore: null,
  churnRiskReasoning: null,
  tags: [],
  partyKind: null,
  employerPartyId: null,
  convertedFromPartyId: null,
  parentPartyId: null,
  primaryDealId: null,
  domain: null,
  industry: null,
  companySize: null,
  description: null,
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

interface Fake {
  db: Db;
  writes: jest.Mock;
}

/**
 * One queued answer per terminal `.limit(...)`: the LEAD, CLIENT, CONTACT and
 * ORGANISATION scans in that order, then the deleted-client sweep, then the
 * employer check.
 */
function fakeDb(answers: unknown[][]): Fake {
  let next = 0;
  const writes = jest.fn();
  const chain: Record<string, unknown> = {};
  for (const step of ["from", "innerJoin", "where", "orderBy"]) chain[step] = () => chain;
  chain.limit = () => Promise.resolve(answers[next++] ?? []);

  const db = {
    select: () => chain,
    update: writes,
    insert: writes,
    delete: writes,
    transaction: writes,
  } as unknown as Db;

  return { db, writes };
}

function leadRow(overrides: Record<string, unknown> = {}) {
  return { legacyId: 7, party: PARTY, legacy: { ...LEAD_MIRROR.derive(PARTY), ...overrides } };
}

describe("PartyDivergenceService", () => {
  it("reports a legacy row that disagrees, and names the party column behind it", async () => {
    const { db, writes } = fakeDb([[leadRow({ designation: "Stale Title" })], [], [], [], [], []]);

    const report = await new PartyDivergenceService(db).report(ORG);

    expect(report.divergentCount).toEqual({ LEAD: 1, CLIENT: 0, CONTACT: 0, ORGANISATION: 0 });
    expect(report.divergent).toEqual([
      {
        kind: "LEAD",
        legacyId: 7,
        partyId: "party-1",
        fields: [
          {
            column: "designation",
            partyColumn: "jobTitle",
            expected: "Head of Computation",
            actual: "Stale Title",
          },
        ],
      },
    ]);
    expect(writes).not.toHaveBeenCalled();
  });

  it("reports nothing when the mirror still derives from its party", async () => {
    const { db, writes } = fakeDb([[leadRow()], [], [], [], [], []]);

    const report = await new PartyDivergenceService(db).report(ORG);

    expect(report.divergent).toEqual([]);
    expect(report.scanned).toEqual({ LEAD: 1, CLIENT: 0, CONTACT: 0, ORGANISATION: 0 });
    expect(writes).not.toHaveBeenCalled();
  });

  it("carries the unmapped counts, which are a different failure from divergence", async () => {
    const { db } = fakeDb([[], [], [], [], [], []]);

    const report = await new PartyDivergenceService(db).report(ORG);

    // A row with no party at all is not a stale mirror; 0241 made that
    // impossible for everything that existed, so a count here means rows
    // arrived out of band.
    expect(report.unmapped).toEqual({ LEAD: 2, CLIENT: 0, CONTACT: 0, ORGANISATION: 0 });
  });

  it("lists a deleted party's client mirror separately, because no write can fix it", async () => {
    const { db, writes } = fakeDb([[], [], [], [], [{ legacyId: 3, partyId: "party-1" }], []]);

    const report = await new PartyDivergenceService(db).report(ORG);

    expect(report.divergent).toEqual([]);
    expect(report.unexpressibleDeletions).toEqual([
      {
        kind: "CLIENT",
        legacyId: 3,
        partyId: "party-1",
        reason: expect.stringContaining("deleted_at"),
      },
    ]);
    expect(writes).not.toHaveBeenCalled();
  });

  it("says where to resume when a kind fills the scan window", async () => {
    const { db } = fakeDb([[leadRow()], [], [], [], [], []]);

    const report = await new PartyDivergenceService(db).report(ORG, { limit: 1 });

    expect(report.truncated).toBe(true);
    expect(report.nextAfter).toEqual({
      LEAD: 7,
      CLIENT: null,
      CONTACT: null,
      ORGANISATION: null,
    });
  });

  it("scans only the kind it was asked for", async () => {
    const { db } = fakeDb([[leadRow({ designation: "Stale" })]]);

    const report = await new PartyDivergenceService(db).report(ORG, { kinds: ["LEAD"] });

    expect(report.scanned).toEqual({ LEAD: 1, CLIENT: 0, CONTACT: 0, ORGANISATION: 0 });
    expect(report.divergentCount.LEAD).toBe(1);
  });

  it("describes the mirror from the derivation, not from a documented copy", async () => {
    const { db } = fakeDb([]);

    expect(new PartyDivergenceService(db).describeMirror()).toEqual({
      LEAD: mirroredColumns("LEAD"),
      CLIENT: mirroredColumns("CLIENT"),
      CONTACT: mirroredColumns("CONTACT"),
      ORGANISATION: mirroredColumns("ORGANISATION"),
    });
  });

  /**
   * The one mirrored value the offline diff cannot check.
   *
   * `contacts.organization_id` is an integer company id and `employer_party_id`
   * is a party id, so settling them needs `crm_org_party_map` -- a query, which a
   * `MirrorCell` deliberately is not. Leaving it unchecked would put the blind
   * spot exactly where drift is most likely: every other mirrored column is a
   * copy and this one is a conversion.
   */
  it("reports an employer the legacy column disagrees with, and still writes nothing", async () => {
    const { db, writes } = fakeDb([
      [],
      [],
      [],
      [],
      [],
      [
        {
          contactId: 11,
          partyId: "party-1",
          employerPartyId: "party-acme",
          legacyOrganizationId: 4,
          expectedOrganizationId: 9,
        },
      ],
    ]);

    const report = await new PartyDivergenceService(db).report(ORG);

    expect(report.employerDisagreements).toEqual([
      {
        contactId: 11,
        partyId: "party-1",
        employerPartyId: "party-acme",
        legacyOrganizationId: 4,
        expectedOrganizationId: 9,
        reason: expect.stringContaining("crm_org_party_map"),
      },
    ]);
    expect(writes).not.toHaveBeenCalled();
  });

  it("says so when the employer is a party the legacy column cannot name", async () => {
    const { db } = fakeDb([
      [],
      [],
      [],
      [],
      [],
      [
        {
          contactId: 12,
          partyId: "party-2",
          employerPartyId: "party-native-company",
          legacyOrganizationId: null,
          expectedOrganizationId: null,
        },
      ],
    ]);

    const report = await new PartyDivergenceService(db).report(ORG);

    expect(report.employerDisagreements[0]?.reason).toContain("no crm_organizations row");
  });
});
