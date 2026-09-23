import {
  noLegacyColumn,
  withKey,
  type PartyFieldMirror,
  type PartyRow,
} from "./party-mirror-fields-types";

export const PARTY_FIELD_MIRROR_LEAD_ENTRIES = {
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
  tier: noLegacyColumn(
    "1160 added tier to the party row itself; no legacy table ever carried a plan or segment column, so there is nothing to mirror it to or absorb it from.",
  ),
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
} satisfies Partial<Record<keyof PartyRow, PartyFieldMirror>>;
