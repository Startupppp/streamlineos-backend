import {
  pgTable,
  jsonb,
  text,
  integer,
  decimal,
  timestamp,
  index,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { organizations } from "../common/auth";
import { crmCampaigns } from "../crm/campaigns";
import { crmHealthEnum, partyTypeEnum } from "../common/enums";

/**
 * Who the organisation deals with.
 *
 * Phase 2's expand step widened this table to carry everything `leads`,
 * `clients` and `contacts` carry, so that Party can replace them rather than sit
 * beside them. The names below are the merged model's, not the name whichever
 * legacy table happened to introduce the field first — `clients.gstin` is a tax
 * number, `leads.designation` and `contacts.title` are the same job title, and
 * `leads.assigned_to_id` and `clients.account_manager_id` are the same person
 * wearing the label the lifecycle stage happened to give them.
 *
 * Nothing reads the new columns yet. `lead_party_map` and its siblings are how
 * a legacy identifier finds its way here in the meantime.
 */
export const businessParties = pgTable(
  "business_parties",
  {
    partyId: text("party_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    partyType: partyTypeEnum("party_type").notNull().default("CUSTOMER"),
    name: text("name").notNull(),
    legalName: text("legal_name"),
    displayName: text("display_name"),
    taxNumber: text("tax_number"),
    website: text("website"),
    email: text("email"),
    phone: text("phone"),
    /**
     * Whether the record itself is live — active · inactive · archived.
     *
     * Deliberately not the pipeline position: `leads.status` holds NEW/QUALIFIED
     * and `clients.status` holds active, and collapsing the two would make
     * "active" and "CONTACTED" values of one column. The pipeline lives in
     * `lifecycleStage`.
     */
    status: text("status").default("active").notNull(),
    customFields: jsonb("custom_fields").$type<Record<string, unknown>>(),
    notes: text("notes"),

    // --- Person-shaped fields, from `contacts`, `leads` and `clients` ---

    /** `leads.designation`, `clients.designation`, `contacts.title`. */
    jobTitle: text("job_title"),
    department: text("department"),
    /**
     * The employer as free text, which is all three legacy tables ever had.
     *
     * `contacts.organization_id` is a real link to `crm_organizations` and has no
     * home here: a party's employer should be another party, and nothing yet
     * gives `crm_organizations` parties to point at. The structured link stays on
     * the legacy row until that converges.
     */
    companyName: text("company_name"),
    /** `leads.whatsapp_number`, kept apart from `phone` because it is a channel. */
    whatsappPhone: text("whatsapp_phone"),
    avatarUrl: text("avatar_url"),
    /** First class because it is also a duplicate-detection signal, not just a link. */
    linkedinUrl: text("linkedin_url"),
    /**
     * Everything else someone can be found on, `contacts.twitter_url` included.
     *
     * A column per network ages badly — the one we have is already named after a
     * site that renamed itself — and none of them is ever queried.
     */
    socialProfiles: jsonb("social_profiles").$type<Record<string, string>>(),
    city: text("city"),
    state: text("state"),

    // --- Lifecycle, from `leads` ---

    /** `leads.status`: NEW · CONTACTED · QUALIFIED · CUSTOMER · LOST, tenant-open. */
    lifecycleStage: text("lifecycle_stage"),
    /** `leads.priority`: HOT · WARM · COLD. */
    priority: text("priority"),
    /**
     * `leads.score`, the scoring rules' output.
     *
     * Named for what it measures, because `healthScore` and `churnRiskScore` sit
     * next to it and a bare `score` would not say which question it answers.
     */
    qualificationScore: integer("qualification_score").default(0).notNull(),
    convertedAt: timestamp("converted_at"),
    lostReason: text("lost_reason"),
    slaDueAt: timestamp("sla_due_at"),
    nextFollowUpAt: timestamp("next_follow_up_at"),
    followUpNotes: text("follow_up_notes"),

    // --- Where the relationship came from, from `leads` ---

    acquisitionSource: text("acquisition_source"),
    acquisitionSubSource: text("acquisition_sub_source"),
    /**
     * Single-column FK, where the house style prefers the composite tenant key.
     *
     * `ON DELETE SET NULL` on a composite `(organization_id, campaign_id)` would
     * null both columns, and `organization_id` is NOT NULL — deleting a campaign
     * would fail outright. The alternatives are worse: RESTRICT would start
     * blocking campaign deletion the moment the backfill runs, which is a
     * behaviour change the expand is not allowed to make. This mirrors
     * `leads.campaign_id` exactly, cross-tenant gap included.
     */
    acquisitionCampaignId: integer("acquisition_campaign_id"),
    /**
     * First-touch capture context: the UTM set, the IP and the referrer.
     *
     * One column rather than seven, because these describe the *event* that
     * created the record and not the person — the same party arrives again next
     * quarter under a different campaign. `crm_attribution` is where the full
     * touch history belongs; this is only what the legacy row carried.
     */
    acquisitionContext: jsonb("acquisition_context").$type<Record<string, string>>(),
    referredBy: text("referred_by"),

    // --- Ownership. Plain text, never a foreign key to `users`: see 0223. ---

    /** `leads.assigned_to_id` and `clients.account_manager_id` — one role, two labels. */
    ownerUserId: text("owner_user_id"),
    assignedByUserId: text("assigned_by_user_id"),
    assignedAt: timestamp("assigned_at"),
    verifiedByUserId: text("verified_by_user_id"),

    // --- Money ---

    /** `leads.investment_interest`: what they said they would spend. */
    statedBudget: decimal("stated_budget", { precision: 15, scale: 2 }),
    /** `leads.potential_value`: what we think the relationship is worth. */
    expectedValue: decimal("expected_value", { precision: 15, scale: 2 }),
    /** `clients.investment_value`: what it actually became. */
    lifetimeValue: decimal("lifetime_value", { precision: 15, scale: 2 }),

    // --- Account health, from `clients` ---

    /**
     * Nullable, where `clients.health_score` defaults to 50 and is not null.
     *
     * A party that has never been a customer has no health, and defaulting it to
     * "50, healthy" would put every lead in the org onto the health dashboard
     * looking deliberately scored.
     */
    healthScore: integer("health_score"),
    healthStatus: crmHealthEnum("health_status"),
    healthCheckedAt: timestamp("health_checked_at"),
    churnRiskScore: integer("churn_risk_score"),
    churnRiskReasoning: text("churn_risk_reasoning"),

    /**
     * `text[]` rather than `contacts`' jsonb array: tags are a set of scalars,
     * and the array type is the one that can carry a GIN index for "filter by tag".
     */
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uniq_business_parties_org_party").on(
      table.organizationId,
      table.partyId,
    ),
    index("idx_business_parties_org_type").on(
      table.organizationId,
      table.partyType,
    ),
    // The two reads the expand adds: my open pipeline, and my book of accounts.
    index("idx_business_parties_org_owner")
      .on(table.organizationId, table.ownerUserId, table.lifecycleStage)
      .where(sql`deleted_at is null`),
    index("idx_business_parties_org_stage")
      .on(table.organizationId, table.lifecycleStage)
      .where(sql`deleted_at is null`),
    /*
     * Leads with the campaign, not with organization_id, which is the one place
     * the house rule does not apply: this index exists for the foreign key's own
     * delete-time lookup, and `ON DELETE SET NULL` searches on the campaign alone
     * with no tenant predicate to lead with. Partial because almost every party
     * has no campaign, so the index stays a fraction of the table.
     */
    index("idx_business_parties_campaign")
      .on(table.acquisitionCampaignId)
      .where(sql`acquisition_campaign_id is not null`),
    // Declared out here, and named, so the constraint Drizzle expects is the one
    // migration 0240 creates. An inline `.references()` would be auto-named and
    // a reconciliation would try to add a second, identical foreign key.
    foreignKey({
      columns: [table.acquisitionCampaignId],
      foreignColumns: [crmCampaigns.id],
      name: "fk_business_parties_acquisition_campaign",
    }).onDelete("set null"),
  ],
);
