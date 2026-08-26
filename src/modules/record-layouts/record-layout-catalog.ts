/**
 * What a tenant is allowed to arrange, and what they are allowed to name.
 *
 * The renderer's descriptions live in the frontend today
 * (`frontend/lib/renderer/registry.ts`), which is why this file exists rather
 * than being derived: a server that trusted the client's field list would let a
 * direct API call store an arrangement naming anything at all. What is stored
 * outlives the description it was written against, so the published set is the
 * boundary, and it is checked here.
 *
 * THE TWO CATALOGUES MUST NOT DRIFT. `record-layout-catalog.spec.ts` asserts the
 * shape of this one; keeping it equal to the frontend's is a review obligation
 * until the descriptions themselves move into the database, at which point this
 * becomes the seed list and the check becomes a join. `singular` is carried only
 * so an error message can name the record type in the words the screen uses.
 *
 * `required` and `titleField` mirror `hidableFields` in
 * `frontend/lib/renderer/layout-adjustment.ts`, and neither is a policy choice.
 * Hiding the title field produces an untitled record; hiding a required field
 * produces a create form that cannot succeed. A tenant doing either would not
 * have removed a column, they would have removed the ability to add a record —
 * so the server refuses both, and does not rely on the form having refused
 * first.
 *
 * Nothing here consults a permission, and nothing here may ever start to.
 * Hiding is display-only: the value keeps arriving and keeps being stored, and
 * revealing a field cannot make a denied read succeed. An arrangement names only
 * field names the description already publishes to everybody who can see the
 * record at all.
 */

/** Where a layout's usage sample is counted. Every identifier here is a literal. */
export interface RecordLayoutUsageSource {
  /** The table the rows live in. */
  readonly table: string;
  /** Its tenant column — `org_id` on some tables, `organization_id` on others. */
  readonly orgColumn: string;
  /** A stable descending sort, so "the sample" means "the most recent N". */
  readonly orderColumn: string;
  /** Predicates every counted row must satisfy — soft deletes, role filters. */
  readonly filters: readonly string[];
  /**
   * Field name to the SQL expression whose presence decides whether the field
   * renders a value. A field absent from this map has nothing behind it and is
   * reported as uncountable rather than as empty — see `usage()`.
   */
  readonly columns: Readonly<Record<string, string>>;
}

export interface RecordLayoutDescription {
  readonly singular: string;
  readonly titleField: string;
  readonly fields: readonly string[];
  readonly required: readonly string[];
  readonly usage: RecordLayoutUsageSource | null;
}

export const RECORD_LAYOUTS: Readonly<Record<string, RecordLayoutDescription>> = {
  "crm:lead": {
    singular: "Lead",
    titleField: "name",
    fields: ["name", "status", "priority", "source", "referredBy", "email", "phone", "whatsappNumber", "company", "designation", "city", "website", "potentialValue", "investmentInterest", "score", "tags", "campaignName", "assignedToName", "assignedAt", "convertedAt", "slaDeadline", "createdAt", "lostReason", "notes"],
    required: ["name", "priority", "source"],
    /**
     * A lead is a party with a `lead_party_map` row, which is what
     * `lead-party-reader.ts` joins on. `status`, `priority` and `source` are
     * counted RAW rather than through the `coalesce` the reader renders them
     * with: a coalesced default is the system answering, not the tenant, and
     * this endpoint's question is which fields the tenant fills in.
     */
    usage: {
      table: "business_parties",
      orgColumn: "organization_id",
      orderColumn: "created_at",
      filters: [
        "business_parties.deleted_at IS NULL",
        "EXISTS (SELECT 1 FROM lead_party_map m WHERE m.party_id = business_parties.party_id AND m.organization_id = business_parties.organization_id)",
      ],
      columns: {
        name: "business_parties.name",
        status: "business_parties.lifecycle_stage",
        priority: "business_parties.priority",
        source: "business_parties.acquisition_source",
        referredBy: "business_parties.referred_by",
        email: "business_parties.email",
        phone: "business_parties.phone",
        whatsappNumber: "business_parties.whatsapp_phone",
        company: "business_parties.company_name",
        designation: "business_parties.job_title",
        city: "business_parties.city",
        website: "business_parties.website",
        potentialValue: "business_parties.expected_value",
        investmentInterest: "business_parties.stated_budget",
        score: "business_parties.qualification_score",
        tags: "business_parties.tags",
        campaignName: "business_parties.acquisition_campaign_id",
        assignedToName: "business_parties.owner_user_id",
        assignedAt: "business_parties.assigned_at",
        convertedAt: "business_parties.converted_at",
        slaDeadline: "business_parties.sla_due_at",
        createdAt: "business_parties.created_at",
        lostReason: "business_parties.lost_reason",
        notes: "business_parties.notes",
      },
    },
  },
  "crm:deal": {
    singular: "Deal",
    titleField: "name",
    fields: ["name", "reference", "stage", "value", "probability", "expectedCloseDate", "actualCloseDate", "contactPerson", "contactEmail", "contactPhone", "lostReason", "notes", "assignedToName", "createdAt"],
    required: ["name", "stage"],
    /**
     * `reference` is absent because it has no column: the screen formats it
     * from `deals.id`, so it renders on every row and is never dead. Reporting
     * it as zero would propose hiding a field nobody can empty.
     */
    usage: {
      table: "deals",
      orgColumn: "org_id",
      orderColumn: "created_at",
      filters: [
        "deals.deleted_at IS NULL",
      ],
      columns: {
        name: "deals.name",
        stage: "deals.stage",
        value: "deals.value",
        probability: "deals.probability",
        expectedCloseDate: "deals.expected_close_date",
        actualCloseDate: "deals.actual_close_date",
        contactPerson: "deals.contact_person",
        contactEmail: "deals.contact_email",
        contactPhone: "deals.contact_phone",
        lostReason: "deals.lost_reason",
        notes: "deals.notes",
        assignedToName: "deals.assigned_to_id",
        createdAt: "deals.created_at",
      },
    },
  },
  "crm:contact": {
    singular: "Contact",
    titleField: "name",
    fields: ["name", "title", "department", "company", "organizationName", "email", "phone", "linkedinUrl", "twitterUrl", "websiteUrl", "tags", "createdAt"],
    required: ["name"],
    /**
     * `organizationName` is the employer party's name flattened at the
     * surface, so what decides whether it renders is the link, not a column of
     * its own. `twitterUrl` is one key of the social-profiles bag, read with the
     * same expression the mirror derives it with.
     */
    usage: {
      table: "business_parties",
      orgColumn: "organization_id",
      orderColumn: "created_at",
      filters: [
        "business_parties.deleted_at IS NULL",
        "EXISTS (SELECT 1 FROM contact_party_map m WHERE m.party_id = business_parties.party_id AND m.organization_id = business_parties.organization_id)",
      ],
      columns: {
        name: "business_parties.name",
        title: "business_parties.job_title",
        department: "business_parties.department",
        company: "business_parties.company_name",
        organizationName: "business_parties.employer_party_id",
        email: "business_parties.email",
        phone: "business_parties.phone",
        linkedinUrl: "business_parties.linkedin_url",
        twitterUrl: "business_parties.social_profiles ->> 'twitter'",
        websiteUrl: "business_parties.website",
        tags: "business_parties.tags",
        createdAt: "business_parties.created_at",
      },
    },
  },
  "crm:company": {
    singular: "Company",
    titleField: "name",
    fields: ["name", "industry", "size", "domain", "website", "linkedinUrl", "description", "healthScore", "createdAt"],
    required: ["name"],
    /**
     * `health_score` is counted from the column even though
     * `crm-organizations.service.ts` does not currently project it onto the list
     * response — the data is there, the read is what is missing. See the note in
     * the ticket report.
     */
    usage: {
      table: "business_parties",
      orgColumn: "organization_id",
      orderColumn: "created_at",
      filters: [
        "business_parties.deleted_at IS NULL",
        "business_parties.party_kind = 'ORGANISATION'",
        "EXISTS (SELECT 1 FROM crm_org_party_map m WHERE m.party_id = business_parties.party_id AND m.organization_id = business_parties.organization_id)",
      ],
      columns: {
        name: "business_parties.name",
        industry: "business_parties.industry",
        size: "business_parties.company_size",
        domain: "business_parties.domain",
        website: "business_parties.website",
        linkedinUrl: "business_parties.linkedin_url",
        description: "business_parties.description",
        healthScore: "business_parties.health_score",
        createdAt: "business_parties.created_at",
      },
    },
  },
  "crm:client": {
    singular: "Client",
    titleField: "clientName",
    fields: ["clientName", "clientEmail", "clientPhone", "clientWhatsapp", "status", "salesRepName", "assignedCrmName", "planName", "investmentAmount", "estimatedInvestment", "investmentDate", "transactionRef", "convertedAt", "investedAt", "renewalStage", "renewalDate", "conversionNotes", "renewalNotes"],
    required: [],
    /**
     * `client_accounts`, NOT the party-migrated `clients` mirror. The two are
     * different surfaces: every field this layout names — the investment, the
     * renewal stage, the transaction reference — exists only on
     * `client_accounts`, which is what `GET /clients` reads. It has no
     * `deleted_at`, so there is no soft-delete filter to apply.
     */
    usage: {
      table: "client_accounts",
      orgColumn: "org_id",
      orderColumn: "created_at",
      filters: [],
      columns: {
        clientName: "client_accounts.client_name",
        clientEmail: "client_accounts.client_email",
        clientPhone: "client_accounts.client_phone",
        clientWhatsapp: "client_accounts.client_whatsapp",
        status: "client_accounts.status",
        salesRepName: "client_accounts.sales_rep_id",
        assignedCrmName: "client_accounts.assigned_crm_id",
        planName: "client_accounts.plan_name",
        investmentAmount: "client_accounts.investment_amount",
        estimatedInvestment: "client_accounts.estimated_investment",
        investmentDate: "client_accounts.investment_date",
        transactionRef: "client_accounts.transaction_ref",
        convertedAt: "client_accounts.converted_at",
        investedAt: "client_accounts.invested_at",
        renewalStage: "client_accounts.renewal_stage",
        renewalDate: "client_accounts.renewal_date",
        conversionNotes: "client_accounts.conversion_notes",
        renewalNotes: "client_accounts.renewal_notes",
      },
    },
  },
  "crm:quote": {
    singular: "Quote",
    titleField: "quoteNumber",
    fields: ["quoteNumber", "subject", "dealName", "clientName", "status", "currency", "netAmount", "totalAmount", "validUntil", "sentAt", "acceptedAt", "createdAt"],
    required: ["subject"],
    /**
     * `dealName` and `clientName` are joined names, so the link decides
     * whether they render.
     */
    usage: {
      table: "quotes",
      orgColumn: "org_id",
      orderColumn: "created_at",
      filters: [
        "quotes.deleted_at IS NULL",
      ],
      columns: {
        quoteNumber: "quotes.quote_number",
        subject: "quotes.subject",
        dealName: "quotes.deal_id",
        clientName: "quotes.client_id",
        status: "quotes.status",
        currency: "quotes.currency",
        netAmount: "quotes.net_amount",
        totalAmount: "quotes.total_amount",
        validUntil: "quotes.valid_until",
        sentAt: "quotes.sent_at",
        acceptedAt: "quotes.accepted_at",
        createdAt: "quotes.created_at",
      },
    },
  },
  "crm:campaign": {
    singular: "Campaign",
    titleField: "name",
    fields: ["name", "status", "channel", "budgetAllocated", "spend", "leads", "roi", "startDate", "endDate", "utmCampaignKey", "targetAudience", "description", "createdAt"],
    required: ["name"],
    usage: {
      table: "crm_campaigns",
      orgColumn: "org_id",
      orderColumn: "created_at",
      filters: [
        "crm_campaigns.deleted_at IS NULL",
      ],
      columns: {
        name: "crm_campaigns.name",
        status: "crm_campaigns.status",
        channel: "crm_campaigns.channel",
        budgetAllocated: "crm_campaigns.budget_allocated",
        spend: "crm_campaigns.spend",
        leads: "crm_campaigns.leads",
        roi: "crm_campaigns.roi",
        startDate: "crm_campaigns.start_date",
        endDate: "crm_campaigns.end_date",
        utmCampaignKey: "crm_campaigns.utm_campaign_key",
        targetAudience: "crm_campaigns.target_audience",
        description: "crm_campaigns.description",
        createdAt: "crm_campaigns.created_at",
      },
    },
  },
  "crm:task": {
    singular: "Task",
    titleField: "title",
    fields: ["title", "type", "entityType", "entityId", "assigneeId", "dueDate", "notes", "status", "createdAt"],
    required: ["title"],
    /**
     * `tasks` has no `deleted_at`; a task is completed, never soft-deleted.
     */
    usage: {
      table: "tasks",
      orgColumn: "org_id",
      orderColumn: "created_at",
      filters: [],
      columns: {
        title: "tasks.title",
        type: "tasks.type",
        entityType: "tasks.entity_type",
        entityId: "tasks.entity_id",
        assigneeId: "tasks.assignee_id",
        dueDate: "tasks.due_date",
        notes: "tasks.notes",
        status: "tasks.status",
        createdAt: "tasks.created_at",
      },
    },
  },
  "crm:activity": {
    singular: "Activity",
    titleField: "title",
    fields: ["title", "type", "entityType", "entityId", "dueDate", "notes", "createdAt"],
    required: ["title"],
    /**
     * The same `tasks` table `crm:task` reads. The activities screen calls
     * `GET /tasks` — `crm_activities` is a different, newer table that nothing
     * on this layout reads yet.
     */
    usage: {
      table: "tasks",
      orgColumn: "org_id",
      orderColumn: "created_at",
      filters: [],
      columns: {
        title: "tasks.title",
        type: "tasks.type",
        entityType: "tasks.entity_type",
        entityId: "tasks.entity_id",
        dueDate: "tasks.due_date",
        notes: "tasks.notes",
        createdAt: "tasks.created_at",
      },
    },
  },
  "crm:lead-activity": {
    singular: "Interaction",
    titleField: "subject",
    fields: ["activityType", "subject", "duration", "outcome", "location", "activityNotes"],
    required: ["activityType"],
    usage: {
      table: "lead_activities",
      orgColumn: "org_id",
      orderColumn: "created_at",
      filters: [],
      columns: {
        activityType: "lead_activities.type",
        subject: "lead_activities.subject",
        duration: "lead_activities.duration",
        outcome: "lead_activities.outcome",
        location: "lead_activities.location",
        activityNotes: "lead_activities.notes",
      },
    },
  },
  "crm:call-log": {
    singular: "Call",
    titleField: "outcome",
    fields: ["direction", "outcome", "durationMinutes", "calledAt", "notes"],
    required: ["direction", "outcome"],
    /**
     * Nothing to count. A call is a `tasks` row of type CALL with its direction,
     * outcome, duration and time folded into the title and the notes as prose —
     * "the platform has no call table", as the layout file itself says. Four of
     * its five fields therefore have no column, including the one the record is
     * titled by, and a sample that reported them all as never filled would
     * propose hiding the entire record type. Null until a call has columns.
     */
    usage: null,
  },
  "party": {
    singular: "Party",
    titleField: "name",
    fields: ["name", "legalName", "displayName", "partyType", "status", "email", "phone", "website", "taxNumber", "notes", "createdAt"],
    required: ["name"],
    usage: {
      table: "business_parties",
      orgColumn: "organization_id",
      orderColumn: "created_at",
      filters: [
        "business_parties.deleted_at IS NULL",
      ],
      columns: {
        name: "business_parties.name",
        legalName: "business_parties.legal_name",
        displayName: "business_parties.display_name",
        partyType: "business_parties.party_type",
        status: "business_parties.status",
        email: "business_parties.email",
        phone: "business_parties.phone",
        website: "business_parties.website",
        taxNumber: "business_parties.tax_number",
        notes: "business_parties.notes",
        createdAt: "business_parties.created_at",
      },
    },
  },
};

/** Every key a tenant may arrange. Anything else is refused before a row is written. */
export const RECORD_LAYOUT_KEYS: readonly string[] = Object.keys(RECORD_LAYOUTS);

export function layoutByKey(key: string): RecordLayoutDescription | undefined {
  return RECORD_LAYOUTS[key];
}

/**
 * The fields a tenant may hide, which is not the same as the fields they may name.
 *
 * A required field or the title field may appear in `order` and in a `group` —
 * moving it is ordinary — but hiding it is refused.
 */
export function isHidable(layout: RecordLayoutDescription, field: string): boolean {
  return (
    layout.fields.includes(field) &&
    field !== layout.titleField &&
    !layout.required.includes(field)
  );
}
