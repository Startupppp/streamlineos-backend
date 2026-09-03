import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../../db/schema";
import {
  MEMBERSHIP_ARTIFACTS,
  type RemovalAction,
} from "./membership-artifacts";
import { departureBlockMessage } from "./org-member-departure.service";
import { DrizzleQueryError } from "drizzle-orm";

interface MembershipForeignKey {
  readonly table: string;
  readonly column: string;
  readonly constraint: string;
  readonly onDelete: string;
  readonly notNull: boolean;
}

const MEMBER_TABLE = "organization_members";

function discoverMembershipForeignKeys(): MembershipForeignKey[] {
  const found: MembershipForeignKey[] = [];
  for (const exported of Object.values(schema)) {
    if (!(exported instanceof PgTable)) continue;
    const config = getTableConfig(exported);
    const notNullByName = new Map<string, boolean>(
      config.columns.map((column) => [column.name, column.notNull]),
    );
    for (const foreignKey of config.foreignKeys) {
      const reference = foreignKey.reference();
      const target = reference.foreignTable;
      if (!(target instanceof PgTable)) continue;
      if (getTableConfig(target).name !== MEMBER_TABLE) continue;

      const local = reference.columns.map((column) => column.name);
      const foreign = reference.foreignColumns.map((column) => column.name);
      const position = foreign.indexOf("id");
      const column = position === -1 ? undefined : local[position];
      if (column === undefined) continue;

      found.push({
        table: config.name,
        column,
        constraint: foreignKey.getName(),
        onDelete: foreignKey.onDelete ?? "no action",
        notNull: notNullByName.get(column) === true,
      });
    }
  }
  return found.sort((a, b) =>
    `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`),
  );
}

function rulingImpliedByForeignKey(onDelete: string): RemovalAction {
  if (onDelete === "cascade") return "cascade";
  if (onDelete === "set null") return "set-null";
  return "blocks-removal";
}

function isDatabaseDelivered(ruling: RemovalAction): boolean {
  return (
    ruling === "cascade" || ruling === "set-null" || ruling === "blocks-removal"
  );
}

function rulingsFor(table: string, column: string): RemovalAction[] {
  return MEMBERSHIP_ARTIFACTS.filter(
    (artifact) =>
      artifact.table === table &&
      artifact.keyedBy
        .split("/")
        .map((key) => key.trim())
        .includes(column),
  ).map((artifact) => artifact.onRemoval);
}

/**
 * Pairs where the ruling and the Drizzle table's declared referential action
 * disagree. Each was adjudicated against a scratch database bootstrapped from
 * the migration chain: some are stale rulings, some are stale Drizzle
 * declarations, and six name a foreign key the migrated schema does not have.
 * Pinned so the set cannot grow unnoticed while it is worked through.
 *
 * Shrunk from 72 to 40 on 2026-09-03 (ticket 03, PRD-C053). Thirty-two entries went
 * away because the RULING was corrected, not the schema: for all of them the Drizzle
 * declaration and pg_catalog already agreed on CASCADE and only MEMBERSHIP_ARTIFACTS
 * claimed set-null. Two more went away because migration 1051 moved the catalog and
 * the declaration together (performance_reviews.reviewer_membership_id and
 * hr_mood_checkins.user_membership_id were RESTRICT and blocked member removal
 * outright). calendar_events.created_by_membership_id left this list by being ruled
 * blocks-removal, which is what migration 0839 actually left in the catalog.
 *
 * This list can only shrink. A new entry means a ruling and a declaration were
 * allowed to diverge in the same change.
 */
const RULING_DISAGREES_WITH_DRIZZLE: readonly string[] = [
  "audit_logs.actor_membership_id",
  "chat_channel_members.membership_id",
  "chat_message_reactions.membership_id",
  "helpdesk_tickets.assignee_membership_id",
  "hr_employments.archived_by_membership_id",
  "hr_employments.updated_by_membership_id",
  "hr_people.archived_by_membership_id",
  "hr_people.updated_by_membership_id",
  "kb_page_favorites.membership_id",
  "kb_page_visits.membership_id",
  "kb_pages.created_by_membership_id",
  "kb_pages.deleted_by_membership_id",
  "kb_pages.last_edited_by_membership_id",
  "kb_pages.owner_membership_id",
  "kb_pages.verified_by_membership_id",
  "leave_requests.approver_membership_id",
  "leave_requests.created_by_membership_id",
  "leave_requests.updated_by_membership_id",
  "onboarding_documents.updated_by_membership_id",
  "onboarding_tasks.created_by_membership_id",
  "onboarding_tasks.updated_by_membership_id",
  "org_units.archived_by_membership_id",
  "org_units.updated_by_membership_id",
  "organization_people.archived_by_membership_id",
  "organization_people.updated_by_membership_id",
  "project_approvals.approver_membership_id",
  "project_members.membership_id",
  "role_assignments.assigned_by_membership_id",
  "ticket_activity_log.user_membership_id",
  "ticket_assignees.membership_id",
  "ticket_comment_mentions.mentioned_user_membership_id",
  "tickets.assignee_membership_id",
  "tickets.reporter_membership_id",
  "user_permission_grants.granted_by_membership_id",
  "wfh_requests.approver_membership_id",
  "worker_engagements.archived_by_membership_id",
  "worker_engagements.updated_by_membership_id",
  "workers.archived_by_membership_id",
  "workers.created_by_membership_id",
  "workers.updated_by_membership_id",
];

const NOT_NULL_BLOCKERS: readonly string[] = [
  "calendar_events.created_by_membership_id",
  "chat_channel_members.membership_id",
  "chat_message_reactions.membership_id",
  "module_ownerships.owner_membership_id",
  "ownership_transfers.from_membership_id",
  "ownership_transfers.initiated_by_membership_id",
  "ownership_transfers.to_membership_id",
  "project_members.membership_id",
  "support_tickets.created_by_membership_id",
  "ticket_assignees.membership_id",
];

describe("every membership foreign key is ruled in MEMBERSHIP_ARTIFACTS", () => {
  const foreignKeys = discoverMembershipForeignKeys();

  it("finds membership foreign keys at all — an empty scan is broken, not clean", () => {
    expect(foreignKeys.length).toBeGreaterThan(100);
  });

  it("rules the column each foreign key actually keys on, not merely its table", () => {
    const unruled = foreignKeys
      .filter((fk) => rulingsFor(fk.table, fk.column).length === 0)
      .map(
        (fk) => `${fk.table}.${fk.column} (${fk.onDelete}, ${fk.constraint})`,
      );

    expect(unruled).toEqual([]);
  });

  it("names every ruling that disagrees with the declared referential action", () => {
    const disagreements = foreignKeys
      .filter((fk) => {
        const rulings = rulingsFor(fk.table, fk.column).filter(
          isDatabaseDelivered,
        );
        if (rulings.length === 0) return false;
        return !rulings.includes(rulingImpliedByForeignKey(fk.onDelete));
      })
      .map((fk) => `${fk.table}.${fk.column}`);

    expect([...new Set(disagreements)].sort()).toEqual(
      RULING_DISAGREES_WITH_DRIZZLE,
    );
  });

  it("pins every blocking foreign key whose column cannot be nulled", () => {
    const notNullBlockers = foreignKeys
      .filter(
        (fk) =>
          fk.notNull &&
          rulingImpliedByForeignKey(fk.onDelete) === "blocks-removal",
      )
      .map((fk) => `${fk.table}.${fk.column}`);

    expect([...new Set(notNullBlockers)].sort()).toEqual(NOT_NULL_BLOCKERS);
  });
});

/**
 * postgres-js reports `constraint_name` / `table_name` / `column_name` on a
 * `PostgresError` that Drizzle wraps, so the classifier only sees these fields
 * one `cause` link down. A bare `{ code, table, constraint }` is a shape the
 * driver never produces and would pass whether or not the classifier worked.
 */
function driverFailure(fields: Record<string, string>): Error {
  return new DrizzleQueryError("delete from organization_members", [], Object.assign(new Error("blocked"), fields));
}

describe("a blocked departure is classified, not surfaced as a 500", () => {
  it("names the constraint behind the support-ticket authorship block", () => {
    const message = departureBlockMessage(
      driverFailure({
        code: "23503",
        table_name: "support_tickets",
        constraint_name: "fk_support_tickets_created_actor",
      }),
    );

    expect(message).toContain("fk_support_tickets_created_actor");
  });

  it("names the column behind an unreachable SET NULL", () => {
    const message = departureBlockMessage(
      driverFailure({
        code: "23502",
        table_name: "support_tickets",
        column_name: "created_by_membership_id",
      }),
    );

    expect(message).toContain("support_tickets.created_by_membership_id");
  });
});
