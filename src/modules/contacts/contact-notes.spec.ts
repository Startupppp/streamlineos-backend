import { and } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { CONTACT_MIRROR } from "../party/party-legacy-mirror";
import { CONTACT_PARTY_COLUMNS, contactPartyScope } from "./contact-party-reader";
import type { PartyRow } from "../party/party-legacy-mirror";

const dialect = new PgDialect();

function render(condition: Parameters<PgDialect["sqlToQuery"]>[0]): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(condition);
}

const PARTY: PartyRow = {
  partyId: "party-contact-1",
  organizationId: "org-1",
  timezone: null,
  partyType: "CUSTOMER",
  partyKind: "ORGANISATION",
  name: "Jane Doe",
  legalName: null,
  displayName: null,
  taxNumber: null,
  website: null,
  email: "jane@example.com",
  phone: null,
  status: "active",
  customFields: null,
  notes: "Met her at the conference.",
  jobTitle: "Engineer",
  department: "Engineering",
  companyName: "Acme",
  employerPartyId: null,
  whatsappPhone: null,
  avatarUrl: null,
  linkedinUrl: null,
  socialProfiles: null,
  city: null,
  state: null,
  domain: null,
  industry: null,
  companySize: null,
  description: null,
  parentPartyId: null,
  lifecycleStage: null,
  priority: null,
  qualificationScore: 0,
  convertedAt: null,
  convertedFromPartyId: null,
  primaryDealId: null,
  lostReason: null,
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
  deletedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe("contact notes — write path routes notes to business_parties", () => {
  it("CONTACT_MIRROR.derive includes notes from the party row", () => {
    const derived = CONTACT_MIRROR.derive(PARTY);
    expect(derived).toHaveProperty("notes", "Met her at the conference.");
  });

  it("CONTACT_MIRROR.derive produces null notes when party.notes is null", () => {
    const derived = CONTACT_MIRROR.derive({ ...PARTY, notes: null });
    expect(derived).toHaveProperty("notes", null);
  });

  it("CONTACT_MIRROR.split routes a notes patch to partyPatch, not legacyOwnedPatch", () => {
    const { partyPatch, legacyOwnedPatch } = CONTACT_MIRROR.split(
      { notes: "New meeting notes." },
      PARTY,
    );
    expect(partyPatch).toHaveProperty("notes", "New meeting notes.");
    expect(legacyOwnedPatch).not.toHaveProperty("notes");
  });

  it("CONTACT_MIRROR.split routes a null notes patch to partyPatch to clear the field", () => {
    const { partyPatch, legacyOwnedPatch } = CONTACT_MIRROR.split(
      { notes: null },
      PARTY,
    );
    expect(partyPatch).toHaveProperty("notes", null);
    expect(legacyOwnedPatch).not.toHaveProperty("notes");
  });

  it("CONTACT_MIRROR.split ignores undefined notes, not touching the party", () => {
    const { partyPatch } = CONTACT_MIRROR.split({ notes: undefined }, PARTY);
    expect(partyPatch).not.toHaveProperty("notes");
  });
});

describe("contact notes — read path projects notes from business_parties", () => {
  it("CONTACT_PARTY_COLUMNS exposes a notes column", () => {
    expect(CONTACT_PARTY_COLUMNS).toHaveProperty("notes");
  });
});

describe("contact notes — org_id is bound in every contact scope predicate", () => {
  it("contactPartyScope SQL binds org_id, not an inline literal", () => {
    const { sql, params } = render(and(...contactPartyScope("org-abc"))!);
    expect(params).toContain("org-abc");
    expect(sql).toMatch(/\$\d/);
  });
});
