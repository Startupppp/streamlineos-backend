import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../../db/schema";
import {
  MEMBERSHIP_ARTIFACTS,
  MEMBERSHIP_ARTIFACT_IDS,
  MEMBERSHIP_ARTIFACT_TABLES,
  artifactsRequiringWriteOnRemoval,
  artifactsRequiringWriteOnSuspension,
} from "./membership-artifacts";

const MEMBERSHIP_COLUMN = /(^|_)membership_id$/;

const ATTRIBUTION_COLUMN =
  /(_by_membership_id$|^actor_membership_id$|^accepted_membership_id$|^inviter_membership_id$)/;

const PORTAL_COLUMN = /portal_membership_id$/;

const NOT_AN_ORG_MEMBERSHIP_GRANT: ReadonlyMap<string, string> = new Map([
  [
    "organizations.owner_membership_id",
    "the organization's own pointer at its owner, not a grant held by a membership",
  ],
]);

const KNOWN_EXCLUDED_COLUMNS: readonly string[] = [
  "ai_summary_snapshots.generated_by_membership_id",
  "audit_logs.actor_membership_id",
  "calendar_events.created_by_membership_id",
  "chat_channel_invite_links.created_by_membership_id",
  "chat_channels.created_by_membership_id",
  "chat_huddles.started_by_membership_id",
  "chat_org_settings.updated_by_membership_id",
  "chat_pinned_messages.pinned_by_membership_id",
  "client_onboarding_items.completed_by_membership_id",
  "client_onboarding_templates.created_by_membership_id",
  "client_opportunities.created_by_membership_id",
  "crm_contact_channel_consent.recorded_by_membership_id",
  "crm_contact_consent_events.recorded_by_membership_id",
  "crm_email_templates.created_by_membership_id",
  "crm_forecast_snapshots.created_by_membership_id",
  "crm_forecast_snapshots.overridden_by_membership_id",
  "csat_surveys.created_by_membership_id",
  "deal_approvals.approved_by_membership_id",
  "deal_approvals.requested_by_membership_id",
  "deal_meetings.created_by_membership_id",
  "expense_export_jobs.requested_by_membership_id",
  "health_score_config.updated_by_membership_id",
  "hr_audit_logs.actor_membership_id",
  "hr_cases.reported_by_membership_id",
  "hr_effective_dated_changes.approved_by_membership_id",
  "hr_effective_dated_changes.created_by_membership_id",
  "hr_employment_history.created_by_membership_id",
  "hr_employments.archived_by_membership_id",
  "hr_employments.updated_by_membership_id",
  "hr_people.archived_by_membership_id",
  "hr_people.updated_by_membership_id",
  "hr_workflow_step_actions.acted_by_membership_id",
  "incentive_config.created_by_membership_id",
  "incentives.approved_by_membership_id",
  "inv_audit_events.actor_membership_id",
  "inv_customer_returns.approved_by_membership_id",
  "inv_customer_returns.created_by_membership_id",
  "inv_cycle_counts.approved_by_membership_id",
  "inv_cycle_counts.created_by_membership_id",
  "inv_export_jobs.created_by_membership_id",
  "inv_grns.created_by_membership_id",
  "inv_import_jobs.created_by_membership_id",
  "inv_loads.created_by_membership_id",
  "inv_packages.created_by_membership_id",
  "inv_physical_audits.approved_by_membership_id",
  "inv_physical_audits.created_by_membership_id",
  "inv_pick_lists.created_by_membership_id",
  "inv_products.created_by_membership_id",
  "inv_purchase_orders.approved_by_membership_id",
  "inv_purchase_orders.created_by_membership_id",
  "inv_quality_holds.created_by_membership_id",
  "inv_quality_holds.released_by_membership_id",
  "inv_quality_inspections.created_by_membership_id",
  "inv_recall_events.created_by_membership_id",
  "inv_sales_orders.created_by_membership_id",
  "inv_shipments.approved_by_membership_id",
  "inv_shipments.created_by_membership_id",
  "inv_standard_costs.created_by_membership_id",
  "inv_stock_adjustments.approved_by_membership_id",
  "inv_stock_adjustments.created_by_membership_id",
  "inv_stock_adjustments.posted_by_membership_id",
  "inv_stock_transactions.created_by_membership_id",
  "inv_stock_transfers.created_by_membership_id",
  "inv_user_warehouses.granted_by_membership_id",
  "inv_vendor_returns.approved_by_membership_id",
  "inv_vendor_returns.created_by_membership_id",
  "inv_vendors.created_by_membership_id",
  "inv_warehouses.created_by_membership_id",
  "invitation_events.actor_membership_id",
  "invitations.accepted_membership_id",
  "invitations.inviter_membership_id",
  "invitations.revoked_by_membership_id",
  "invoices.created_by_membership_id",
  "kb_article_chunks.page_created_by_membership_id",
  "kb_events.actor_membership_id",
  "kb_page_reviews.requested_by_membership_id",
  "kb_pages.created_by_membership_id",
  "kb_pages.deleted_by_membership_id",
  "kb_pages.last_edited_by_membership_id",
  "kb_pages.verified_by_membership_id",
  "kb_spaces.created_by_membership_id",
  "lead_import_batches.created_by_membership_id",
  "leave_requests.created_by_membership_id",
  "leave_requests.updated_by_membership_id",
  "nps_surveys.created_by_membership_id",
  "okr_goals.created_by_membership_id",
  "onboarding_documents.updated_by_membership_id",
  "onboarding_tasks.created_by_membership_id",
  "onboarding_tasks.updated_by_membership_id",
  "org_units.archived_by_membership_id",
  "org_units.updated_by_membership_id",
  "organization_people.archived_by_membership_id",
  "organization_people.updated_by_membership_id",
  "organizations.owner_membership_id",
  "outbox_events.actor_membership_id",
  "ownership_transfers.initiated_by_membership_id",
  "payments.created_by_membership_id",
  "payroll_approvals.acted_by_membership_id",
  "payroll_journal_batches.created_by_membership_id",
  "payroll_journal_batches.exported_by_membership_id",
  "payroll_journal_batches.posted_by_membership_id",
  "payroll_journal_batches.reconciled_by_membership_id",
  "payroll_journal_batches.reversed_by_membership_id",
  "payroll_run_export_jobs.requested_by_membership_id",
  "payroll_runs.approved_by_membership_id",
  "payroll_runs.closed_by_membership_id",
  "payroll_runs.created_by_membership_id",
  "payroll_runs.locked_by_membership_id",
  "payroll_runs.paid_by_membership_id",
  "payroll_runs.published_by_membership_id",
  "payroll_runs.reopened_by_membership_id",
  "playbook_entries.created_by_membership_id",
  "portal_invitations.accepted_portal_membership_id",
  "portal_invitations.inviter_membership_id",
  "portal_memberships.portal_membership_id",
  "project_client_grants.portal_membership_id",
  "purchase_bills.approved_by_membership_id",
  "purchase_bills.created_by_membership_id",
  "quotes.approved_by_membership_id",
  "quotes.created_by_membership_id",
  "reimbursements.approved_by_membership_id",
  "role_assignments.assigned_by_membership_id",
  "sales_quotas.set_by_membership_id",
  "sign_documents.created_by_membership_id",
  "sign_envelopes.voided_by_membership_id",
  "sprint_scope_events.actor_membership_id",
  "support_macros.created_by_membership_id",
  "support_tickets.created_by_membership_id",
  "survey_forms.created_by_membership_id",
  "survey_versions.created_by_membership_id",
  "task_sequences.created_by_membership_id",
  "tasks.created_by_membership_id",
  "tenant_ai_credit_transactions.actor_membership_id",
  "territories.created_by_membership_id",
  "ticket_related_links.created_by_membership_id",
  "timesheet_audit_events.actor_membership_id",
  "timesheet_exceptions.resolved_by_membership_id",
  "timesheet_exports.ack_by_membership_id",
  "timesheet_exports.created_by_membership_id",
  "timesheet_periods.approved_by_membership_id",
  "timesheet_settings_history.changed_by_membership_id",
  "timesheets.approved_by_membership_id",
  "timesheets.locked_by_membership_id",
  "user_permission_grants.granted_by_membership_id",
  "vendor_payments.created_by_membership_id",
  "web_lead_forms.created_by_membership_id",
  "worker_engagements.archived_by_membership_id",
  "worker_engagements.created_by_membership_id",
  "worker_engagements.updated_by_membership_id",
  "workers.archived_by_membership_id",
  "workers.created_by_membership_id",
  "workers.updated_by_membership_id",
  "workflow_transitions.created_by_membership_id",
];

interface DiscoveredTable {
  table: string;
  columns: string[];
}

function discoverExcludedColumns(): string[] {
  const excluded: string[] = [];
  for (const exported of Object.values(schema)) {
    if (!(exported instanceof PgTable)) continue;
    const config = getTableConfig(exported);
    for (const column of config.columns) {
      if (!MEMBERSHIP_COLUMN.test(column.name)) continue;
      if (
        ATTRIBUTION_COLUMN.test(column.name) ||
        PORTAL_COLUMN.test(column.name) ||
        NOT_AN_ORG_MEMBERSHIP_GRANT.has(`${config.name}.${column.name}`)
      ) {
        excluded.push(`${config.name}.${column.name}`);
      }
    }
  }
  return excluded.sort();
}

function discoverMembershipKeyedTables(): DiscoveredTable[] {
  const found: DiscoveredTable[] = [];
  for (const exported of Object.values(schema)) {
    if (!(exported instanceof PgTable)) continue;
    const config = getTableConfig(exported);
    const columns = config.columns
      .map((column) => column.name)
      .filter((name) => MEMBERSHIP_COLUMN.test(name))
      .filter((name) => !ATTRIBUTION_COLUMN.test(name))
      .filter((name) => !PORTAL_COLUMN.test(name))
      .filter(
        (name) => !NOT_AN_ORG_MEMBERSHIP_GRANT.has(`${config.name}.${name}`),
      );
    if (columns.length > 0) found.push({ table: config.name, columns });
  }
  return found;
}

describe("the membership artifact inventory is derived from the schema", () => {
  const discovered = discoverMembershipKeyedTables();

  it("finds membership-keyed tables at all — a scan that finds none is broken, not clean", () => {
    expect(discovered.length).toBeGreaterThan(3);
  });

  it("separates an authority column from an audit-attribution one", () => {
    expect(ATTRIBUTION_COLUMN.test("granted_by_membership_id")).toBe(true);
    expect(ATTRIBUTION_COLUMN.test("actor_membership_id")).toBe(true);
    expect(ATTRIBUTION_COLUMN.test("inviter_membership_id")).toBe(true);
    expect(ATTRIBUTION_COLUMN.test("organization_membership_id")).toBe(false);
    expect(ATTRIBUTION_COLUMN.test("delegatee_membership_id")).toBe(false);
    expect(ATTRIBUTION_COLUMN.test("issuer_membership_id")).toBe(false);
    expect(ATTRIBUTION_COLUMN.test("owner_membership_id")).toBe(false);
  });

  it("names every membership-keyed table in the inventory", () => {
    const inventoried = new Set<string>(MEMBERSHIP_ARTIFACT_TABLES);
    const missing = discovered
      .map((entry) => entry.table)
      .filter((table) => !inventoried.has(table));

    expect(missing).toEqual([]);
  });

  it("pins every column the scan excludes, so a new one must be acknowledged", () => {
    expect(discoverExcludedColumns()).toEqual(KNOWN_EXCLUDED_COLUMNS);
  });

  it("does not inventory a table that no longer exists in the schema", () => {
    const realTables = new Set<string>();
    for (const exported of Object.values(schema)) {
      if (!(exported instanceof PgTable)) continue;
      realTables.add(getTableConfig(exported).name);
    }
    const phantom = MEMBERSHIP_ARTIFACT_TABLES.filter(
      (table) => table !== null && !realTables.has(table),
    );

    expect(phantom).toEqual([]);
  });
});

describe("the membership artifact inventory is well formed", () => {
  it("has no reason text that describes a pending FK change without the matching onRemoval", () => {
    for (const artifact of MEMBERSHIP_ARTIFACTS) {
      if (/fk must change to cascade/i.test(artifact.reason)) {
        expect(artifact.onRemoval).toBe("cascade");
      }
      if (/fk must change to set null/i.test(artifact.reason)) {
        expect(artifact.onRemoval).toBe("set-null");
      }
    }
  });

  it("has a unique id per artifact", () => {
    expect(new Set(MEMBERSHIP_ARTIFACT_IDS).size).toBe(
      MEMBERSHIP_ARTIFACT_IDS.length,
    );
  });

  it("records why every artifact is handled the way it is", () => {
    for (const artifact of MEMBERSHIP_ARTIFACTS) {
      expect(artifact.reason.trim().length).toBeGreaterThan(0);
      expect(artifact.keyedBy.trim().length).toBeGreaterThan(0);
    }
  });

  it("gives every non-table artifact a mechanism that is not a database one", () => {
    for (const artifact of MEMBERSHIP_ARTIFACTS) {
      if (artifact.table !== null) continue;
      expect(["session-store", "realtime", "provider", "cache"]).toContain(
        artifact.mechanism,
      );
    }
  });

  it("never claims a cascade for an artifact the database cannot cascade", () => {
    for (const artifact of MEMBERSHIP_ARTIFACTS) {
      if (artifact.onRemoval !== "cascade") continue;
      expect(artifact.table).not.toBeNull();
      expect(artifact.mechanism).not.toBe("realtime");
      expect(artifact.mechanism).not.toBe("provider");
      expect(artifact.mechanism).not.toBe("cache");
      expect(artifact.mechanism).not.toBe("session-store");
    }
  });

  it("revokes every credential and out-of-band capability on suspension", () => {
    const mustRevokeOnSuspension = [
      "agent_tokens",
      "user_delegations",
      "user_sessions",
      "realtime_capability",
      "user_integration_connections",
      "access_caches",
    ];
    const revoked = new Set(
      artifactsRequiringWriteOnSuspension().map((artifact) => artifact.id),
    );

    for (const id of mustRevokeOnSuspension) expect(revoked.has(id)).toBe(true);
  });

  it("lists the artifacts a removal path cannot leave to the database", () => {
    const ids = artifactsRequiringWriteOnRemoval().map((a) => a.id);

    expect(ids).toContain("resource_grants");
    expect(ids).toContain("kb_space_grants");
    expect(ids).toContain("realtime_capability");
    expect(ids).toContain("user_integration_connections");
    expect(ids).toContain("invitations");
    expect(ids).not.toContain("role_assignments");
  });
});
