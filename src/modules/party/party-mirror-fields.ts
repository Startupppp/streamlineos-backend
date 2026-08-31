import { businessParties } from "../../db/schema/party";
import { clients, contacts, crmOrganizations } from "../../db/schema/crm/contacts";
import { leads } from "../../db/schema/crm/leads";
import type { MappedLegacyKind } from "./party-legacy-seam";

/**
 * What every Party column means to `leads`, `clients` and `contacts`.
 *
 * The catalog half of the mirror: which legacy column each Party column
 * produces, how, and how the same columns fold back for a caller still holding a
 * legacy-shaped patch. `party-legacy-mirror.ts` is the engine that applies it,
 * and the only thing that ever should — nothing else derives a legacy row.
 *
 * The map is keyed by Party column and annotated `Record<keyof PartyRow, …>`, so
 * adding a column to `business_parties` fails to compile here until somebody
 * says where it lands. That is the guarantee that matters: a mirror drifts by
 * omission far more often than by disagreement, and omission is the half a
 * compiler can catch.
 *
 * Each cell is a pair. `derive` produces the legacy columns this Party column
 * owns — always all of them, nulls included, so the column set never depends on
 * the value. `absorb` folds those same columns back, so a write path that still
 * speaks `leads` does not have to learn Party's vocabulary at its call site.
 * `absorb` is the inverse of `derive`, declared beside it and round-tripped in
 * the spec; it is an input adapter, not a second mirror.
 *
 * The column names differ on purpose. `clients.gstin` is a tax number,
 * `leads.designation` and `contacts.title` are one job title, and
 * `leads.assigned_to_id` and `clients.account_manager_id` are one owner wearing
 * whichever label the lifecycle stage gave them. See 0240 for why the merged
 * model refused to carry three names for one field.
 */

export type PartyRow = typeof businessParties.$inferSelect;
export type PartyPatch = Partial<typeof businessParties.$inferInsert>;

export type LeadInsert = typeof leads.$inferInsert;
export type ClientInsert = typeof clients.$inferInsert;
export type ContactInsert = typeof contacts.$inferInsert;
export type CrmOrgInsert = typeof crmOrganizations.$inferInsert;

/**
 * One Party column's contribution to one legacy table.
 *
 * `derive` receives the whole Party row rather than just its own column because
 * a few legacy columns are a function of more than one Party field —
 * `clients.is_vendor` reads `party_type`, and the NOT NULL columns need a
 * fallback the Party side is allowed to leave null.
 */
export interface MirrorCell<TInsert> {
  readonly derive: (party: PartyRow) => Partial<TInsert>;
  readonly absorb: (legacy: Partial<TInsert>, current: PartyRow) => PartyPatch;
}

interface MirrorTargets {
  readonly LEAD?: MirrorCell<LeadInsert>;
  readonly CLIENT?: MirrorCell<ClientInsert>;
  readonly CONTACT?: MirrorCell<ContactInsert>;
  readonly ORGANISATION?: MirrorCell<CrmOrgInsert>;
}

/**
 * At least one target, or a reason there is none.
 *
 * Without this an entry could be spelled `{}` — present in the map, mapped
 * nowhere, and indistinguishable from a deliberate decision. The whole point of
 * the map is that every Party column has been thought about once.
 */
type AtLeastOneTarget = {
  [K in keyof MirrorTargets]-?: Required<Pick<MirrorTargets, K>> & Partial<Omit<MirrorTargets, K>>;
}[keyof MirrorTargets];

type PartyFieldMirror = AtLeastOneTarget | { readonly legacyHasNoColumn: string };

const noLegacyColumn = (because: string): PartyFieldMirror => ({ legacyHasNoColumn: because });

/** A row as Postgres hands it back, before anything knows which table it is. */
export type ErasedRow = Record<string, unknown>;


export const PARTY_FIELD_MIRROR: Record<keyof PartyRow, PartyFieldMirror> = {
  partyId: noLegacyColumn(
    "A legacy row's identity is its own serial id; `*_party_map` joins the two.",
  ),
  organizationId: {
    // Mirrored rather than left to the caller: a mirror row written into the
    // wrong tenant is the one divergence that cannot be reported after the fact,
    // because the check that would find it is itself tenant-scoped.
    LEAD: { derive: (p) => ({ orgId: p.organizationId }), absorb: () => ({}) },
    CLIENT: { derive: (p) => ({ orgId: p.organizationId }), absorb: () => ({}) },
    CONTACT: { derive: (p) => ({ orgId: p.organizationId }), absorb: () => ({}) },
    ORGANISATION: { derive: (p) => ({ orgId: p.organizationId }), absorb: () => ({}) },
  },
  partyType: {
    // Phase 1 models "customer and supplier" as two `party_roles` rows so that
    // one business needs one record; the enum carries the same fact as far as it
    // can express it, and `clients.is_vendor` is the boolean shadow of that.
    CLIENT: {
      derive: (p) => ({ isVendor: p.partyType === "VENDOR" || p.partyType === "BOTH" }),
      absorb: (l, p) => {
        if (l.isVendor === undefined) return {};
        if (l.isVendor)
          return { partyType: p.partyType === "VENDOR" ? "VENDOR" : "BOTH" };
        return {
          partyType: p.partyType === "VENDOR" || p.partyType === "BOTH" ? "CUSTOMER" : p.partyType,
        };
      },
    },
  },
  partyKind: noLegacyColumn(
    "No legacy table records whether a record is a person or a company -- `crm_organizations` implies it by existing, and 0264 sets it there rather than deriving it from a column that is not on the row.",
  ),
  name: {
    LEAD: { derive: (p) => ({ name: p.name }), absorb: (l) => ({ name: l.name }) },
    CLIENT: { derive: (p) => ({ name: p.name }), absorb: (l) => ({ name: l.name }) },
    CONTACT: { derive: (p) => ({ name: p.name }), absorb: (l) => ({ name: l.name }) },
    ORGANISATION: { derive: (p) => ({ name: p.name }), absorb: (l) => ({ name: l.name }) },
  },
  legalName: noLegacyColumn(
    "`clients.name` is the only name the legacy tables carry; the registered name is new here.",
  ),
  displayName: noLegacyColumn("New in the merged model; no legacy table ever had one."),
  taxNumber: {
    CLIENT: { derive: (p) => ({ gstin: p.taxNumber }), absorb: (l) => ({ taxNumber: l.gstin }) },
  },
  website: {
    LEAD: { derive: (p) => ({ website: p.website }), absorb: (l) => ({ website: l.website }) },
    CONTACT: {
      derive: (p) => ({ websiteUrl: p.website }),
      absorb: (l) => ({ website: l.websiteUrl }),
    },
    ORGANISATION: {
      derive: (p) => ({ website: p.website }),
      absorb: (l) => ({ website: l.website }),
    },
  },
  email: {
    LEAD: { derive: (p) => ({ email: p.email }), absorb: (l) => ({ email: l.email }) },
    CLIENT: { derive: (p) => ({ email: p.email }), absorb: (l) => ({ email: l.email }) },
    CONTACT: { derive: (p) => ({ email: p.email }), absorb: (l) => ({ email: l.email }) },
  },
  phone: {
    LEAD: { derive: (p) => ({ phone: p.phone }), absorb: (l) => ({ phone: l.phone }) },
    CLIENT: { derive: (p) => ({ phone: p.phone }), absorb: (l) => ({ phone: l.phone }) },
    CONTACT: { derive: (p) => ({ phone: p.phone }), absorb: (l) => ({ phone: l.phone }) },
  },
  status: {
    // `leads.status` is the pipeline position and mirrors `lifecycleStage`, not
    // this. Collapsing the two would make "active" and "CONTACTED" values of one
    // column; see the comment on `businessParties.status`.
    CLIENT: { derive: (p) => ({ status: p.status }), absorb: (l) => ({ status: l.status }) },
  },
  customFields: {
    LEAD: {
      derive: (p) => ({ customData: p.customFields }),
      absorb: (l) => ({ customFields: l.customData }),
    },
  },
  notes: {
    LEAD: { derive: (p) => ({ notes: p.notes }), absorb: (l) => ({ notes: l.notes }) },
    CLIENT: { derive: (p) => ({ notes: p.notes }), absorb: (l) => ({ notes: l.notes }) },
    CONTACT: { derive: (p) => ({ notes: p.notes }), absorb: (l) => ({ notes: l.notes }) },
    ORGANISATION: { derive: (p) => ({ notes: p.notes }), absorb: (l) => ({ notes: l.notes }) },
  },
  jobTitle: {
    LEAD: {
      derive: (p) => ({ designation: p.jobTitle }),
      absorb: (l) => ({ jobTitle: l.designation }),
    },
    CLIENT: {
      derive: (p) => ({ designation: p.jobTitle }),
      absorb: (l) => ({ jobTitle: l.designation }),
    },
    CONTACT: { derive: (p) => ({ title: p.jobTitle }), absorb: (l) => ({ jobTitle: l.title }) },
  },
  department: {
    CONTACT: {
      derive: (p) => ({ department: p.department }),
      absorb: (l) => ({ department: l.department }),
    },
  },
  companyName: {
    LEAD: { derive: (p) => ({ company: p.companyName }), absorb: (l) => ({ companyName: l.company }) },
    CLIENT: {
      derive: (p) => ({ company: p.companyName }),
      absorb: (l) => ({ companyName: l.company }),
    },
    CONTACT: {
      derive: (p) => ({ company: p.companyName }),
      absorb: (l) => ({ companyName: l.company }),
    },
  },
  employerPartyId: noLegacyColumn(
    "`contacts.organization_id` is an integer `crm_organizations` id and this is a party id; translating between them needs `crm_org_party_map`, and a cell here is a pure function of one row with no database. `party-legacy-employer.ts` does it inside the writer instead, and `PartyDivergenceService.findEmployerDisagreements` is the check that would otherwise have been lost with it.",
  ),
  domain: {
    ORGANISATION: { derive: (p) => ({ domain: p.domain }), absorb: (l) => ({ domain: l.domain }) },
  },
  industry: {
    ORGANISATION: {
      derive: (p) => ({ industry: p.industry }),
      absorb: (l) => ({ industry: l.industry }),
    },
  },
  companySize: {
    ORGANISATION: {
      derive: (p) => ({ size: p.companySize }),
      absorb: (l) => ({ companySize: l.size }),
    },
  },
  description: {
    ORGANISATION: {
      derive: (p) => ({ description: p.description }),
      absorb: (l) => ({ description: l.description }),
    },
  },
  parentPartyId: noLegacyColumn(
    "`crm_organizations.parent_id` is an integer company id and this is a party id; translating between them needs `crm_org_party_map`, and a cell here is a pure function of one row with no database. `party-legacy-associations.ts` does it inside the writer instead, the same way `party-legacy-employer.ts` does for `employer_party_id`.",
  ),
  whatsappPhone: {
    LEAD: {
      derive: (p) => ({ whatsappNumber: p.whatsappPhone }),
      absorb: (l) => ({ whatsappPhone: l.whatsappNumber }),
    },
  },
  avatarUrl: {
    CONTACT: {
      derive: (p) => ({ avatarUrl: p.avatarUrl }),
      absorb: (l) => ({ avatarUrl: l.avatarUrl }),
    },
  },
  linkedinUrl: {
    CONTACT: {
      derive: (p) => ({ linkedinUrl: p.linkedinUrl }),
      absorb: (l) => ({ linkedinUrl: l.linkedinUrl }),
    },
    ORGANISATION: {
      derive: (p) => ({ linkedinUrl: p.linkedinUrl }),
      absorb: (l) => ({ linkedinUrl: l.linkedinUrl }),
    },
  },
  socialProfiles: {
    // A column per network ages badly -- the one we have is named after a site
    // that renamed itself -- so Party keeps a bag and the mirror unpacks the one
    // key `contacts` has a column for.
    CONTACT: {
      derive: (p) => ({ twitterUrl: p.socialProfiles?.twitter ?? null }),
      absorb: (l, p) => ({
        socialProfiles: withKey(p.socialProfiles, "twitter", l.twitterUrl),
      }),
    },
  },
  city: {
    LEAD: { derive: (p) => ({ city: p.city }), absorb: (l) => ({ city: l.city }) },
    CLIENT: { derive: (p) => ({ city: p.city }), absorb: (l) => ({ city: l.city }) },
  },
  state: {
    CLIENT: { derive: (p) => ({ state: p.state }), absorb: (l) => ({ state: l.state }) },
  },
  lifecycleStage: {
    // NOT NULL on the legacy side, nullable here: a party that has never entered
    // the pipeline has no stage, and "NEW" is what the legacy table would have
    // defaulted to anyway.
    LEAD: {
      derive: (p) => ({ status: p.lifecycleStage ?? "NEW" }),
      absorb: (l) => ({ lifecycleStage: l.status }),
    },
  },
  priority: {
    LEAD: {
      derive: (p) => ({ priority: p.priority ?? "WARM" }),
      absorb: (l) => ({ priority: l.priority }),
    },
  },
  qualificationScore: {
    LEAD: { derive: (p) => ({ score: p.qualificationScore }), absorb: (l) => ({ qualificationScore: l.score }) },
  },
  convertedAt: {
    LEAD: {
      derive: (p) => ({ convertedAt: p.convertedAt }),
      absorb: (l) => ({ convertedAt: l.convertedAt }),
    },
    CLIENT: {
      derive: (p) => ({ convertedAt: p.convertedAt }),
      absorb: (l) => ({ convertedAt: l.convertedAt }),
    },
  },
  convertedFromPartyId: noLegacyColumn(
    "`clients.lead_id` and `contacts.lead_id` are integer lead ids and this is a party id; translating between them needs `lead_party_map`, which a `MirrorCell` deliberately cannot reach. `party-legacy-associations.ts` does it inside the writer, and it maintains BOTH legacy columns from this one Party column -- they are one relation, per 0265.",
  ),
  primaryDealId: {
    // The one association that needs no translation: `contacts.deal_id` and
    // `primary_deal_id` are the same integer `deals` id in the same id space, so
    // this stays a pure cell rather than joining `party-legacy-associations.ts`
    // out of symmetry. Party carries a composite tenant foreign key the legacy
    // column never had; the mirror still copies whatever survived it.
    CONTACT: {
      derive: (p) => ({ dealId: p.primaryDealId }),
      absorb: (l) => ({ primaryDealId: l.dealId }),
    },
  },
  lostReason: {
    LEAD: {
      derive: (p) => ({ lostReason: p.lostReason }),
      absorb: (l) => ({ lostReason: l.lostReason }),
    },
  },
  slaDueAt: {
    LEAD: {
      derive: (p) => ({ slaDeadline: p.slaDueAt }),
      absorb: (l) => ({ slaDueAt: l.slaDeadline }),
    },
  },
  nextFollowUpAt: {
    LEAD: {
      derive: (p) => ({ followUpDate: p.nextFollowUpAt }),
      absorb: (l) => ({ nextFollowUpAt: l.followUpDate }),
    },
  },
  followUpNotes: {
    LEAD: {
      derive: (p) => ({ followUpNotes: p.followUpNotes }),
      absorb: (l) => ({ followUpNotes: l.followUpNotes }),
    },
  },
  acquisitionSource: {
    LEAD: {
      derive: (p) => ({ source: p.acquisitionSource ?? "other" }),
      absorb: (l) => ({ acquisitionSource: l.source }),
    },
  },
  acquisitionSubSource: {
    LEAD: {
      derive: (p) => ({ subSource: p.acquisitionSubSource }),
      absorb: (l) => ({ acquisitionSubSource: l.subSource }),
    },
  },
  acquisitionCampaignId: {
    LEAD: {
      derive: (p) => ({ campaignId: p.acquisitionCampaignId }),
      absorb: (l) => ({ acquisitionCampaignId: l.campaignId }),
    },
  },
  acquisitionContext: {
    // Seven legacy columns, one Party column: these describe the *event* that
    // created the record and not the person. `crm_attribution` owns the full
    // touch history; this is only what the legacy row carried.
    LEAD: {
      derive: (p) => ({
        utmSource: p.acquisitionContext?.utmSource ?? null,
        utmMedium: p.acquisitionContext?.utmMedium ?? null,
        utmCampaign: p.acquisitionContext?.utmCampaign ?? null,
        utmContent: p.acquisitionContext?.utmContent ?? null,
        utmTerm: p.acquisitionContext?.utmTerm ?? null,
        ipAddress: p.acquisitionContext?.ipAddress ?? null,
        referrerUrl: p.acquisitionContext?.referrerUrl ?? null,
      }),
      absorb: (l, p) => {
        let context = p.acquisitionContext;
        context = withKey(context, "utmSource", l.utmSource);
        context = withKey(context, "utmMedium", l.utmMedium);
        context = withKey(context, "utmCampaign", l.utmCampaign);
        context = withKey(context, "utmContent", l.utmContent);
        context = withKey(context, "utmTerm", l.utmTerm);
        context = withKey(context, "ipAddress", l.ipAddress);
        context = withKey(context, "referrerUrl", l.referrerUrl);
        return { acquisitionContext: context };
      },
    },
  },
  referredBy: {
    LEAD: {
      derive: (p) => ({ referredBy: p.referredBy }),
      absorb: (l) => ({ referredBy: l.referredBy }),
    },
  },
  ownerUserId: {
    LEAD: {
      derive: (p) => ({ assignedToId: p.ownerUserId }),
      absorb: (l) => ({ ownerUserId: l.assignedToId }),
    },
    CLIENT: {
      derive: (p) => ({ accountManagerId: p.ownerUserId }),
      absorb: (l) => ({ ownerUserId: l.accountManagerId }),
    },
  },
  assignedByUserId: {
    LEAD: {
      derive: (p) => ({ assignedById: p.assignedByUserId }),
      absorb: (l) => ({ assignedByUserId: l.assignedById }),
    },
  },
  assignedAt: {
    LEAD: {
      derive: (p) => ({ assignedAt: p.assignedAt }),
      absorb: (l) => ({ assignedAt: l.assignedAt }),
    },
  },
  verifiedByUserId: {
    LEAD: {
      derive: (p) => ({ verifiedById: p.verifiedByUserId }),
      absorb: (l) => ({ verifiedByUserId: l.verifiedById }),
    },
  },
  statedBudget: {
    LEAD: {
      derive: (p) => ({ investmentInterest: p.statedBudget }),
      absorb: (l) => ({ statedBudget: l.investmentInterest }),
    },
  },
  expectedValue: {
    LEAD: {
      derive: (p) => ({ potentialValue: p.expectedValue }),
      absorb: (l) => ({ expectedValue: l.potentialValue }),
    },
  },
  lifetimeValue: {
    CLIENT: {
      derive: (p) => ({ investmentValue: p.lifetimeValue }),
      absorb: (l) => ({ lifetimeValue: l.investmentValue }),
    },
  },
  healthScore: {
    // NOT NULL default 50 on the legacy side. Party leaves it null for anyone who
    // has never been a customer, because defaulting a lead to "50, healthy" puts
    // it on the health dashboard looking deliberately scored.
    CLIENT: {
      derive: (p) => ({ healthScore: p.healthScore ?? 50 }),
      absorb: (l) => ({ healthScore: l.healthScore }),
    },
    // `crm_organizations.health_score` is nullable, so this one carries the
    // absence rather than inventing a 50 the way `clients` forces.
    ORGANISATION: {
      derive: (p) => ({ healthScore: p.healthScore }),
      absorb: (l) => ({ healthScore: l.healthScore }),
    },
  },
  healthStatus: {
    CLIENT: {
      derive: (p) => ({ healthStatus: p.healthStatus ?? "healthy" }),
      absorb: (l) => ({ healthStatus: l.healthStatus }),
    },
  },
  healthCheckedAt: {
    CLIENT: {
      derive: (p) => ({ lastHealthCheck: p.healthCheckedAt }),
      absorb: (l) => ({ healthCheckedAt: l.lastHealthCheck }),
    },
  },
  churnRiskScore: {
    CLIENT: {
      derive: (p) => ({ churnRiskScore: p.churnRiskScore }),
      absorb: (l) => ({ churnRiskScore: l.churnRiskScore }),
    },
  },
  churnRiskReasoning: {
    CLIENT: {
      derive: (p) => ({ churnRiskReasoning: p.churnRiskReasoning }),
      absorb: (l) => ({ churnRiskReasoning: l.churnRiskReasoning }),
    },
  },
  tags: {
    LEAD: { derive: (p) => ({ tags: p.tags }), absorb: (l) => ({ tags: l.tags ?? [] }) },
    CONTACT: { derive: (p) => ({ tags: p.tags }), absorb: (l) => ({ tags: l.tags ?? [] }) },
  },
  deletedAt: {
    // `clients` has no `deleted_at`, so a soft-deleted client-shaped party has
    // nowhere to record the deletion. That is a real blind spot, reported by
    // `findUnexpressibleDeletions` rather than papered over by inventing a
    // meaning for `clients.status`: the legacy surface has never offered a client
    // delete, and giving it one here would be a behaviour change this ticket is
    // not allowed to make.
    LEAD: { derive: (p) => ({ deletedAt: p.deletedAt }), absorb: (l) => ({ deletedAt: l.deletedAt }) },
    CONTACT: {
      derive: (p) => ({ deletedAt: p.deletedAt }),
      absorb: (l) => ({ deletedAt: l.deletedAt }),
    },
    ORGANISATION: {
      derive: (p) => ({ deletedAt: p.deletedAt }),
      absorb: (l) => ({ deletedAt: l.deletedAt }),
    },
  },
  createdAt: noLegacyColumn(
    "Both tables stamp their own; 0241 carried the legacy value across, and a mirror write must never move a creation date.",
  ),
  updatedAt: noLegacyColumn("Both tables maintain their own through `$onUpdate`."),
};

/**
 * Sets, clears or leaves one key of a Party jsonb bag.
 *
 * `undefined` means the legacy patch did not mention the column, so the bag is
 * untouched; `null` means it was explicitly cleared. An empty bag becomes null
 * rather than `{}`, matching what 0241's `NULLIF(jsonb_strip_nulls(...))` left
 * behind, so a round trip through here does not turn a null column into an empty
 * object and report itself as divergence forever.
 */
function withKey(
  bag: Record<string, string> | null,
  key: string,
  value: string | null | undefined,
): Record<string, string> | null {
  if (value === undefined) return bag;
  const next: Record<string, string> = { ...bag };
  if (value === null) delete next[key];
  else next[key] = value;
  return Object.keys(next).length === 0 ? null : next;
}

export const LEGACY_OWNED_COLUMNS: Record<MappedLegacyKind, Readonly<Record<string, string>>> = {
  LEAD: {
    id: "The legacy identity itself; `lead_party_map` is how it reaches a Party.",
    dmLeadId: "An id in the upstream DM system. Party has no home for another system's key.",
    mergedIntoId:
      "The legacy merge pointer. `party_merges` is the Party mechanism, and re-pointing the map row is how a merge reaches this table.",
    createdAt: "Stamped by the table.",
    updatedAt: "Stamped by the table.",
  },
  CLIENT: {
    id: "The legacy identity itself.",
    leadId:
      "Which lead this client converted from, which Party now owns as `converted_from_party_id`. Listed here because the two speak different id spaces -- an integer `leads` id against a party id -- so the column is maintained by `party-legacy-associations.ts` through `lead_party_map` rather than by a pure cell above. Legacy-owned in shape only; nothing outside the writer sets it.",
    createdAt: "Stamped by the table.",
    updatedAt: "Stamped by the table.",
  },
  CONTACT: {
    id: "The legacy identity itself.",
    organizationId:
      "The employer, which Party now owns as `employer_party_id`. Listed here because the two speak different id spaces -- an integer `crm_organizations` id against a party id -- so the column is maintained by `party-legacy-employer.ts` through `crm_org_party_map` rather than by a pure cell above. Legacy-owned in shape only; nothing outside the writer sets it.",
    leadId:
      "Which lead this contact was raised against -- the same relation `clients.lead_id` names, and the same Party column, `converted_from_party_id`. Maintained by `party-legacy-associations.ts` for the reason recorded on `clients.leadId`. Legacy-owned in shape only; nothing outside the writer sets it.",
    mergedIntoId: "The legacy merge pointer; see `leads.mergedIntoId`.",
    createdAt: "Stamped by the table.",
    updatedAt: "Stamped by the table.",
  },
  ORGANISATION: {
    id: "The legacy identity itself; `crm_org_party_map` is how it reaches a Party.",
    parentId:
      "The account hierarchy -- which company owns which. Party owns it as `parent_party_id` from 0265: a party-to-party link like `employer_party_id`, and deliberately not folded into it, because a subsidiary's parent is not its employer and one column serving both would make the name a lie. Ticket 25 converged the identity and left the hierarchy; the contract step could not drop the table while the hierarchy reads still joined it. Maintained by `party-legacy-associations.ts` through `crm_org_party_map`; legacy-owned in shape only.",
    mergedIntoId: "The legacy merge pointer; see `leads.mergedIntoId`.",
    createdAt: "Stamped by the table.",
    updatedAt: "Stamped by the table.",
  },
};
