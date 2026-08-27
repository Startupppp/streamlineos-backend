import { getTableColumns } from "drizzle-orm";
import { businessParties } from "../../db/schema/party";
import { LEGACY_COLUMNS } from "./legacy-shapes";
import {
  CLIENT_MIRROR,
  CONTACT_MIRROR,
  diffLegacyMirror,
  LEAD_MIRROR,
  LEGACY_OWNED_COLUMNS,
  ORGANISATION_MIRROR,
  mirroredColumns,
  PARTY_FIELD_MIRROR,
  valuesAgree,
  type PartyRow,
} from "./party-legacy-mirror";
import { MAPPED_LEGACY_KINDS, type MappedLegacyKind } from "./party-legacy-seam";

/**
 * The mirror's one claim, tested: a legacy row is a function of its Party, and a
 * field cannot fall out of that function by being forgotten.
 *
 * The claim has two halves and each needs its own kind of proof. That every
 * Party column has been decided about is a *coverage* property, and the first
 * test below is the runtime twin of the `Record<keyof PartyRow, …>` annotation
 * on the map — the annotation stops the build, this says why. That the
 * derivation and the check agree is a *behaviour* property, and it is proved by
 * feeding `diff` the output of `derive`: they cannot disagree, because they are
 * the same function.
 *
 * `PARTY` below is exhaustive on purpose. It is the third gate on a new column:
 * the map's annotation, the module's own probe, and this literal all stop
 * compiling until somebody says what the new field means to `leads`.
 */

const PARTY: PartyRow = {
  partyId: "party-1",
  organizationId: "org-1",
  partyType: "CUSTOMER",
  name: "Ada Lovelace",
  legalName: "Lovelace Analytical Ltd",
  displayName: "Ada",
  taxNumber: "29ABCDE1234F1Z5",
  website: "https://lovelace.test",
  email: "ada@lovelace.test",
  phone: "+44 20 7946 0000",
  status: "active",
  customFields: { tier: "gold" },
  notes: "Met at the Analytical Engine demo.",
  jobTitle: "Head of Computation",
  department: "Engineering",
  companyName: "Analytical Engines",
  whatsappPhone: "+44 7700 900000",
  avatarUrl: "https://cdn.test/ada.png",
  linkedinUrl: "https://linkedin.test/in/ada",
  socialProfiles: { twitter: "https://x.test/ada" },
  city: "London",
  state: "Greater London",
  lifecycleStage: "QUALIFIED",
  priority: "HOT",
  qualificationScore: 71,
  convertedAt: new Date("2026-02-01T10:00:00.000Z"),
  lostReason: null,
  slaDueAt: new Date("2026-02-02T10:00:00.000Z"),
  nextFollowUpAt: new Date("2026-02-03T10:00:00.000Z"),
  followUpNotes: "Call after the board meeting.",
  acquisitionSource: "referral",
  acquisitionSubSource: "partner-network",
  acquisitionCampaignId: 42,
  acquisitionContext: { utmSource: "newsletter", ipAddress: "203.0.113.7" },
  referredBy: "Charles Babbage",
  ownerUserId: "user-owner",
  assignedByUserId: "user-manager",
  assignedAt: new Date("2026-01-30T09:00:00.000Z"),
  verifiedByUserId: "user-verifier",
  statedBudget: "50000.00",
  expectedValue: "75000.00",
  lifetimeValue: "125000.00",
  healthScore: 82,
  healthStatus: "healthy",
  healthCheckedAt: new Date("2026-02-04T10:00:00.000Z"),
  churnRiskScore: 18,
  churnRiskReasoning: "Renewed twice without discount.",
  tags: ["vip", "beta"],
  partyKind: "ORGANISATION",
  employerPartyId: null,
  // The three links 0265 gave Party. `primaryDealId` is a real value because it
  // is the one of the three the mirror derives -- `contacts.deal_id` needs no
  // translation -- so the round trip below actually proves something about it.
  convertedFromPartyId: "party-lead-9",
  parentPartyId: "party-parent-9",
  primaryDealId: 4242,
  domain: "acme.example",
  industry: "Manufacturing",
  companySize: "51-200",
  description: "Makes things out of other things.",
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-02-05T00:00:00.000Z"),
};

/** Everything nullable left null, to prove the NOT NULL fallbacks carry. */
const SPARSE_PARTY: PartyRow = {
  ...PARTY,
  legalName: null,
  displayName: null,
  taxNumber: null,
  website: null,
  email: null,
  phone: null,
  customFields: null,
  notes: null,
  jobTitle: null,
  department: null,
  companyName: null,
  whatsappPhone: null,
  avatarUrl: null,
  linkedinUrl: null,
  socialProfiles: null,
  city: null,
  state: null,
  lifecycleStage: null,
  priority: null,
  qualificationScore: 0,
  convertedAt: null,
  slaDueAt: null,
  nextFollowUpAt: null,
  followUpNotes: null,
  acquisitionSource: null,
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
};

const BLANK_PARTY: PartyRow = { ...SPARSE_PARTY, name: "", partyType: "CUSTOMER", status: "active" };

const ENGINE = {
  LEAD: LEAD_MIRROR,
  CLIENT: CLIENT_MIRROR,
  CONTACT: CONTACT_MIRROR,
  ORGANISATION: ORGANISATION_MIRROR,
};

function derived(kind: MappedLegacyKind, party: PartyRow): Record<string, unknown> {
  if (kind === "LEAD") return LEAD_MIRROR.derive(party);
  if (kind === "CLIENT") return CLIENT_MIRROR.derive(party);
  if (kind === "CONTACT") return CONTACT_MIRROR.derive(party);
  return ORGANISATION_MIRROR.derive(party);
}

describe("party-legacy-mirror — a new Party field cannot be forgotten", () => {
  it("decides every column of business_parties, and invents none", () => {
    expect(Object.keys(PARTY_FIELD_MIRROR).sort()).toEqual(
      Object.keys(getTableColumns(businessParties)).sort(),
    );
  });

  it("leaves no column present-but-undecided", () => {
    const undecided: string[] = [];
    for (const [column, entry] of Object.entries(PARTY_FIELD_MIRROR)) {
      if ("legacyHasNoColumn" in entry) {
        if (!entry.legacyHasNoColumn.trim()) undecided.push(column);
        continue;
      }
      if (
        !("LEAD" in entry) &&
        !("CLIENT" in entry) &&
        !("CONTACT" in entry) &&
        !("ORGANISATION" in entry)
      )
        undecided.push(column);
    }
    expect(undecided).toEqual([]);
  });

  it.each(MAPPED_LEGACY_KINDS)(
    "%s: every legacy column is either mirrored or declared legacy-owned",
    (kind) => {
      const mirrored = new Set(mirroredColumns(kind));
      const owned = new Set(Object.keys(LEGACY_OWNED_COLUMNS[kind]));
      const actual = LEGACY_COLUMNS[kind];

      expect([...mirrored].filter((column) => owned.has(column))).toEqual([]);
      expect([...new Set([...mirrored, ...owned])].sort()).toEqual([...actual].sort());
    },
  );

  it.each(MAPPED_LEGACY_KINDS)(
    "%s: every legacy-owned column carries a reason, not just an exemption",
    (kind) => {
      for (const [column, reason] of Object.entries(LEGACY_OWNED_COLUMNS[kind]))
        expect(`${column}: ${reason}`.length).toBeGreaterThan(column.length + 20);
    },
  );
});

describe("party-legacy-mirror — derivation", () => {
  it.each(MAPPED_LEGACY_KINDS)("%s: derives the same columns whatever the values", (kind) => {
    const full = Object.keys(derived(kind, PARTY)).sort();
    const sparse = Object.keys(derived(kind, SPARSE_PARTY)).sort();
    expect(full).toEqual([...mirroredColumns(kind)].sort());
    expect(sparse).toEqual(full);
  });

  it("carries the merged model's renames", () => {
    const lead = LEAD_MIRROR.derive(PARTY);
    expect(lead.designation).toBe("Head of Computation");
    expect(lead.assignedToId).toBe("user-owner");
    expect(lead.whatsappNumber).toBe("+44 7700 900000");
    expect(lead.investmentInterest).toBe("50000.00");
    expect(lead.potentialValue).toBe("75000.00");
    expect(lead.subSource).toBe("partner-network");
    expect(lead.slaDeadline).toEqual(PARTY.slaDueAt);
    expect(lead.followUpDate).toEqual(PARTY.nextFollowUpAt);

    const client = CLIENT_MIRROR.derive(PARTY);
    expect(client.gstin).toBe("29ABCDE1234F1Z5");
    expect(client.accountManagerId).toBe("user-owner");
    expect(client.investmentValue).toBe("125000.00");
    expect(client.lastHealthCheck).toEqual(PARTY.healthCheckedAt);

    const contact = CONTACT_MIRROR.derive(PARTY);
    expect(contact.title).toBe("Head of Computation");
    expect(contact.websiteUrl).toBe("https://lovelace.test");
    expect(contact.twitterUrl).toBe("https://x.test/ada");
  });

  it("unpacks the acquisition context into the columns leads keeps it in", () => {
    const lead = LEAD_MIRROR.derive(PARTY);
    expect(lead.utmSource).toBe("newsletter");
    expect(lead.ipAddress).toBe("203.0.113.7");
    // Absent keys become explicit nulls rather than being left off, or an update
    // would leave the previous campaign's UTM on the row.
    expect(lead.utmMedium).toBeNull();
    expect(lead.referrerUrl).toBeNull();
  });

  it("supplies the legacy NOT NULL columns the party is allowed to leave null", () => {
    const lead = LEAD_MIRROR.derive(SPARSE_PARTY);
    expect(lead.status).toBe("NEW");
    expect(lead.priority).toBe("WARM");
    expect(lead.source).toBe("other");

    const client = CLIENT_MIRROR.derive(SPARSE_PARTY);
    expect(client.healthScore).toBe(50);
    expect(client.healthStatus).toBe("healthy");
    expect(client.status).toBe("active");
  });

  it("shadows the party type onto is_vendor rather than a second client record", () => {
    expect(CLIENT_MIRROR.derive({ ...PARTY, partyType: "CUSTOMER" }).isVendor).toBe(false);
    expect(CLIENT_MIRROR.derive({ ...PARTY, partyType: "VENDOR" }).isVendor).toBe(true);
    expect(CLIENT_MIRROR.derive({ ...PARTY, partyType: "BOTH" }).isVendor).toBe(true);
  });

  it("carries the tenant, so a mirror cannot land in another organisation", () => {
    for (const kind of MAPPED_LEGACY_KINDS)
      expect(derived(kind, PARTY).orgId).toBe("org-1");
  });

  it("carries the company fields onto crm_organizations", () => {
    const company = ORGANISATION_MIRROR.derive(PARTY);
    expect(company.domain).toBe("acme.example");
    expect(company.industry).toBe("Manufacturing");
    // Renamed: Party calls it `companySize` because `size` beside `healthScore`
    // and `qualificationScore` would not say what it measures.
    expect(company.size).toBe("51-200");
    expect(company.description).toBe("Makes things out of other things.");
    // Nullable here, where `clients.health_score` forces a 50 the party never had.
    expect(ORGANISATION_MIRROR.derive(SPARSE_PARTY).healthScore).toBeNull();
  });
});

describe("party-legacy-mirror — the divergence check is the derivation", () => {
  it.each(MAPPED_LEGACY_KINDS)("%s: a row derived from a party agrees with it", (kind) => {
    expect(diffLegacyMirror(kind, PARTY, derived(kind, PARTY))).toEqual([]);
    expect(diffLegacyMirror(kind, SPARSE_PARTY, derived(kind, SPARSE_PARTY))).toEqual([]);
  });

  it("names the party column behind the legacy column that disagrees", () => {
    const stored = { ...LEAD_MIRROR.derive(PARTY), designation: "Something else" };
    const [divergence, ...rest] = diffLegacyMirror("LEAD", PARTY, stored);
    expect(rest).toEqual([]);
    expect(divergence).toEqual({
      column: "designation",
      partyColumn: "jobTitle",
      expected: "Head of Computation",
      actual: "Something else",
    });
  });

  it("reports a missing column as a divergence rather than skipping it", () => {
    const stored: Record<string, unknown> = { ...CONTACT_MIRROR.derive(PARTY) };
    delete stored.title;
    expect(diffLegacyMirror("CONTACT", PARTY, stored).map((d) => d.column)).toEqual(["title"]);
  });

  it("renders dates as ISO strings, because the report is JSON somebody reads", () => {
    const stored = { ...LEAD_MIRROR.derive(PARTY), slaDeadline: new Date("2030-01-01T00:00:00Z") };
    const [divergence] = diffLegacyMirror("LEAD", PARTY, stored);
    expect(divergence?.expected).toBe("2026-02-02T10:00:00.000Z");
    expect(divergence?.actual).toBe("2030-01-01T00:00:00.000Z");
  });
});

describe("party-legacy-mirror — value comparison across the driver's type gap", () => {
  it("treats the same money written two ways as agreement", () => {
    expect(valuesAgree("1000", "1000.00")).toBe(true);
    expect(valuesAgree("1000.00", "1000.01")).toBe(false);
  });

  it("treats a Date and its ISO string as agreement", () => {
    const when = new Date("2026-02-02T10:00:00.000Z");
    expect(valuesAgree(when, "2026-02-02T10:00:00.000Z")).toBe(true);
    expect(valuesAgree(when, "2026-02-02T10:00:01.000Z")).toBe(false);
  });

  it("compares arrays and jsonb bags by value", () => {
    expect(valuesAgree(["a", "b"], ["a", "b"])).toBe(true);
    expect(valuesAgree(["a", "b"], ["b", "a"])).toBe(false);
    expect(valuesAgree({ x: "1" }, { x: "1" })).toBe(true);
    expect(valuesAgree({ x: "1" }, { x: "2" })).toBe(false);
  });

  it("does not confuse null with an empty value", () => {
    expect(valuesAgree(null, "")).toBe(false);
    expect(valuesAgree(null, 0)).toBe(false);
    expect(valuesAgree(null, null)).toBe(true);
  });

  it("does not treat two unrelated strings as numbers", () => {
    expect(valuesAgree("QUALIFIED", "NEW")).toBe(false);
  });
});

describe("party-legacy-mirror — absorbing a legacy-shaped patch", () => {
  /**
   * The lossy pair, named rather than skipped silently.
   *
   * `organizationId` deliberately absorbs nothing: the tenant comes from the
   * party, and letting a legacy patch move it is the one divergence the check
   * could never find. `partyType` survives only as far as `is_vendor` can carry
   * it — PARTNER and CUSTOMER are both "not a vendor", so folding back a boolean
   * cannot recover which one it was.
   */
  const LOSSY = new Set(["organizationId", "partyType"]);

  it.each(MAPPED_LEGACY_KINDS)("%s: derive then absorb returns the party's values", (kind) => {
    const legacyRow = derived(kind, PARTY);
    const { partyPatch } = ENGINE[kind].split(legacyRow, BLANK_PARTY);

    const roundTripped: Record<string, unknown> = { ...PARTY, ...partyPatch };
    for (const [column, entry] of Object.entries(PARTY_FIELD_MIRROR)) {
      if ("legacyHasNoColumn" in entry || !(kind in entry) || LOSSY.has(column)) continue;
      const expected: Record<string, unknown> = { ...PARTY };
      expect([column, roundTripped[column]]).toEqual([column, expected[column]]);
    }
  });

  it("folds the seven UTM columns back into one bag", () => {
    const { partyPatch } = LEAD_MIRROR.split(
      { utmSource: "newsletter", ipAddress: "203.0.113.7" },
      BLANK_PARTY,
    );
    expect(partyPatch.acquisitionContext).toEqual({
      utmSource: "newsletter",
      ipAddress: "203.0.113.7",
    });
  });

  it("clears a jsonb key rather than storing an empty bag", () => {
    const { partyPatch } = CONTACT_MIRROR.split({ twitterUrl: null }, PARTY);
    expect(partyPatch.socialProfiles).toBeNull();
  });

  it("routes a column the party does not own onto the legacy row", () => {
    const { partyPatch, legacyOwnedPatch } = CONTACT_MIRROR.split(
      { organizationId: 7, name: "Ada" },
      BLANK_PARTY,
    );
    expect(legacyOwnedPatch).toEqual({ organizationId: 7 });
    expect(partyPatch).toEqual({ name: "Ada" });
  });

  it("ignores a key the caller left undefined", () => {
    const { partyPatch } = LEAD_MIRROR.split({ notes: undefined }, PARTY);
    expect(partyPatch).toEqual({});
  });

  it("refuses a legacy column nobody has decided about", () => {
    // A literal would not compile -- `split` takes `Partial<LeadInsert>` and the
    // compiler already rejects an invented column. The runtime guard is for the
    // dynamic keys that get past it: the automation runner sets `[field]` from
    // stored configuration, and a silent skip there would start a divergence.
    const dynamicField = { name: "Ada", inventedColumn: "x" };
    expect(() => LEAD_MIRROR.split(dynamicField, PARTY)).toThrow(
      /neither mirrored .* nor declared legacy-owned/,
    );
  });
});
