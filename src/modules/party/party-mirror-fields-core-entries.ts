import {
  noLegacyColumn,
  withKey,
  type PartyFieldMirror,
  type PartyRow,
} from "./party-mirror-fields-types";

export const PARTY_FIELD_MIRROR_CORE_ENTRIES = {
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
  timezone: noLegacyColumn(
    "CRM-P1-09 added it to the Party after the legacy shapes were frozen, and no legacy table ever had a zone. It is read at send time from the Party row, so there is nothing for a mirror to carry.",
  ),
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
} satisfies Partial<Record<keyof PartyRow, PartyFieldMirror>>;
