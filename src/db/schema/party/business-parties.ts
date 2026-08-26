import {
  pgTable,
  jsonb,
  text,
  integer,
  decimal,
  timestamp,
  index,
  unique,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { organizations } from "../common/auth";
import { crmCampaigns } from "../crm/campaigns";
import { crmHealthEnum, orgSizeEnum, partyKindEnum, partyTypeEnum } from "../common/enums";

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
    /**
     * Person or company — and nullable, where every other classification here is
     * not.
     *
     * Null means nobody has said, which is the truth for every party 0241
     * backfilled: `leads`, `clients` and `contacts` record no such distinction
     * anywhere, and a NOT NULL default of PERSON would assert something false
     * about every client that is a limited company. 0264 sets ORGANISATION on
     * exactly the parties minted from `crm_organizations`, which is the one set
     * the data actually knows about.
     */
    partyKind: partyKindEnum("party_kind"),
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
     * Superseded by `employerPartyId` for anyone whose employer is a record, and
     * kept for everyone whose is not: a lead who typed "Acme" into a web form has
     * no company row behind them, and inventing one to hold the string would fill
     * the Companies list with unverified names. The two are not redundant — this
     * is what someone said, that is what we have on file.
     */
    companyName: text("company_name"),
    /**
     * The employer, as another party.
     *
     * The structured half of the same question, and the reason ticket 25 exists:
     * `companyName` cannot answer "who else works here", which is the entire
     * point of an employer relation. `contacts.organization_id` pointed at
     * `crm_organizations` because Party had nothing to point at; 0264 converged
     * that table into this one and re-pointed the link here.
     *
     * Composite `(organization_id, employer_party_id)` foreign key, declared out
     * in the table extras — a single-column FK is the cross-tenant hole the
     * issues table deliberately avoided, and there is no reason to reopen it for
     * a self-reference.
     *
     * `ON DELETE CASCADE`, where the instinct is SET NULL: a composite SET NULL
     * nulls *both* columns, and `organization_id` is NOT NULL, so the delete
     * would simply fail. CASCADE is safe here as a fact rather than a hope —
     * nothing in this repository hard-deletes a party, the app soft-deletes
     * through `deletedAt`, so the only DELETE that ever reaches this table is the
     * tenant cascade, where the employees are going with it anyway.
     */
    employerPartyId: text("employer_party_id"),
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

    // --- Company-shaped fields, from `crm_organizations` ---

    /**
     * The company's own internet domain, which is not its `website`.
     *
     * Both exist on `crm_organizations` and are set independently: the website is
     * `https://www.acme.com/en/`, the domain is `acme.com`, and only the second
     * one is a matching key — it is what the duplicate report and the create-time
     * warning have always compared. Kept as a column rather than a
     * `party_identifiers` row because the identifier vocabulary is closed by a
     * CHECK in 0260 and pinned to `IDENTIFIER_KINDS` in the ingress seam; a
     * domain is not something an inbound message arrives from, so widening that
     * vocabulary would buy nothing and cost the ingress contract.
     */
    domain: text("domain"),
    /** The sector, as `crm_organizations` recorded it: free text, tenant-open. */
    industry: text("industry"),
    /** `crm_organizations.size`, on the existing `org_size` enum rather than a second one. */
    companySize: orgSizeEnum("company_size"),
    /**
     * What the company is, as opposed to `notes`, which is what we think of them.
     *
     * `crm_organizations` carries both and they are not the same field — one goes
     * on a customer-facing profile and the other does not — so folding them
     * together would lose the distinction in the direction that matters.
     */
    description: text("description"),

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
    /*
     * "Who else works here", and the cascade's own lookup when a tenant goes.
     * Partial because almost no party has an employer -- a company does not, and
     * neither does a lead who only ever typed a company name.
     */
    index("idx_business_parties_employer")
      .on(table.organizationId, table.employerPartyId)
      .where(sql`employer_party_id is not null`),
    // The Companies list: every organisation in the tenant, newest first.
    index("idx_business_parties_org_kind")
      .on(table.organizationId, table.partyKind)
      .where(sql`deleted_at is null`),
    // Duplicate detection by domain, which is the strongest signal a company has.
    index("idx_business_parties_org_domain")
      .on(table.organizationId, table.domain)
      .where(sql`domain is not null`),
    // Declared out here, and named, so the constraint Drizzle expects is the one
    // migration 0240 creates. An inline `.references()` would be auto-named and
    // a reconciliation would try to add a second, identical foreign key.
    foreignKey({
      columns: [table.acquisitionCampaignId],
      foreignColumns: [crmCampaigns.id],
      name: "fk_business_parties_acquisition_campaign",
    }).onDelete("set null"),
    // The tenant travels with the reference, so an employer in another
    // organisation is not merely unlikely but unrepresentable. See the column.
    foreignKey({
      columns: [table.organizationId, table.employerPartyId],
      foreignColumns: [table.organizationId, table.partyId],
      name: "fk_business_parties_employer",
    }).onDelete("cascade"),
    // Nobody employs themselves. A one-hop cycle is the only one a constraint can
    // see; deeper ones are the application's problem, as they are for
    // `crm_organizations.parent_id`.
    check("chk_business_parties_employer_not_self", sql`employer_party_id is null or employer_party_id <> party_id`),
  ],
);
