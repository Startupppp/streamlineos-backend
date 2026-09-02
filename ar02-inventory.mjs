import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import postgres from "postgres";

const BACKEND = "D:/projects/personal/Streamlineos/backend";
const env = fs.readFileSync(path.join(BACKEND, ".env"), "utf8");
const base = (env.match(/^DATABASE_URL=(.*)$/m)?.[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
const url = base.replace(/\/neondb(\?|$)/, "/scratch_boot_a$1");

const CRM = new Set([
  "clients", "leads", "deals", "contacts", "quotes", "pipelines", "pipeline_stages",
  "activities", "campaigns", "campaign_recipients", "quote_items", "contact_notes",
  "contact_tags", "deal_activities", "deal_approvals", "deal_meetings",
  "lead_activities", "lead_emails", "lead_notes", "lead_tasks",
  "enterprise_quotes", "client_accounts", "client_onboarding_items",
  "client_opportunities", "commissions", "csat_surveys", "quote_line_items",
  "vendor_credits", "credit_notes",
]);
const MIGRATED = new Set([
  "tickets_epic_id_tickets_id_fk", "tickets_parent_ticket_id_tickets_id_fk",
  "tickets_recurrence_parent_id_tickets_id_fk", "okr_goals_parent_goal_id_okr_goals_id_fk",
  "pages_parent_page_id_pages_id_fk", "ticket_comments_parent_comment_id_ticket_comments_id_fk",
  "billing_invoice_snapshots_subscription_id_subscriptions_id_fk",
  "billing_invoice_line_snapshots_snapshot_id_billing_invoice_snapshots_id_fk",
  "billing_invoice_line_snapshots_proration_line_id_billing_proration_lines_id_fk",
  "billing_invoice_line_snapshots_usage_rollup_id_billing_usage_rollups_id_fk",
  "billing_credit_notes_original_snapshot_id_billing_invoice_snapshots_id_fk",
  "billing_credit_note_lines_credit_note_id_billing_credit_notes_id_fk",
  "subscription_items_subscription_id_subscriptions_id_fk",
  "billing_proration_lines_subscription_id_subscriptions_id_fk",
  "subscription_payments_subscription_id_subscriptions_id_fk",
  "ledger_accounts_parent_account_id_ledger_accounts_id_fk",
  "journal_entries_reversed_entry_id_journal_entries_id_fk",
  "documents_parent_document_id_documents_id_fk", "goals_parent_goal_id_goals_id_fk",
  "fk_kb_article_comments_parent", "fk_kb_pages_parent", "fk_kb_page_comments_parent",
  "chat_messages_reply_to_id_chat_messages_id_fk", "fk_kb_categories_parent",
  "fk_tickets_customer", "fk_business_parties_acquisition_campaign",
]);
const isCrm = (n) => n.startsWith("crm_") || CRM.has(n);
const isInv = (n) => n.startsWith("inv_") || n === "inv_items";

const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {}, connect_timeout: 30 });

const rows = await sql`
  WITH tenant AS (
    SELECT c.oid, c.relname, n.nspname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'org_id'
                    AND a.attnum > 0 AND NOT a.attisdropped)
  )
  SELECT
    ct.nspname AS child_schema, ct.relname AS child,
    pt.nspname AS parent_schema, pt.relname AS parent,
    con.conname AS constraint_name,
    con.confdeltype AS on_delete, con.confupdtype AS on_update,
    (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attnum = con.conkey[1]) AS child_col,
    (SELECT a.attnotnull FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attnum = con.conkey[1]) AS child_col_notnull,
    (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = con.confrelid AND a.attnum = con.confkey[1]) AS parent_col,
    (SELECT a.attnotnull FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attname = 'org_id') AS child_org_notnull,
    (SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attname = 'org_id') AS child_org_type,
    (SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = con.confrelid AND a.attname = 'org_id') AS parent_org_type,
    (SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attnum = con.conkey[1]) AS child_col_type,
    (SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = con.confrelid AND a.attnum = con.confkey[1]) AS parent_col_type,
    EXISTS (
      SELECT 1 FROM pg_constraint u
      WHERE u.conrelid = con.confrelid AND u.contype IN ('u','p')
        AND u.conkey @> ARRAY[
              (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = con.confrelid AND a.attname='org_id'),
              con.confkey[1]]::smallint[]
        AND array_length(u.conkey,1) = 2
    ) AS parent_has_org_unique,
    (SELECT string_agg(u.conname, ',') FROM pg_constraint u
      WHERE u.conrelid = con.confrelid AND u.contype IN ('u','p')
        AND u.conkey @> ARRAY[
              (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = con.confrelid AND a.attname='org_id'),
              con.confkey[1]]::smallint[]
        AND array_length(u.conkey,1) = 2) AS parent_org_unique_name,
    EXISTS (
      SELECT 1 FROM pg_constraint x
      WHERE x.conrelid = con.conrelid AND x.contype='f' AND x.confrelid = con.confrelid
        AND array_length(x.conkey,1)=2
        AND x.conkey @> ARRAY[
              (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attname='org_id'),
              con.conkey[1]]::smallint[]
    ) AS composite_already_exists,
    (SELECT string_agg(x.conname, ',') FROM pg_constraint x
      WHERE x.conrelid = con.conrelid AND x.contype='f' AND x.confrelid = con.confrelid
        AND array_length(x.conkey,1)=2
        AND x.conkey @> ARRAY[
              (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attname='org_id'),
              con.conkey[1]]::smallint[]) AS composite_name
  FROM pg_constraint con
  JOIN tenant ct ON ct.oid = con.conrelid
  JOIN tenant pt ON pt.oid = con.confrelid
  WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1
  ORDER BY 1,2,5
`;

const actionable = rows.filter(
  (r) => !MIGRATED.has(r.constraint_name) && !isCrm(r.child) && !isCrm(r.parent) && !isInv(r.child) && !isInv(r.parent),
);

const out = {
  totalSingleCol: rows.length,
  actionable: actionable.length,
  rows: actionable,
};
fs.writeFileSync("C:/Users/Aditya_Lappy/AppData/Local/Temp/ar02-inventory.json", JSON.stringify(out, null, 1));

const parents = new Map();
for (const r of actionable) {
  const k = `${r.parent_schema}.${r.parent}`;
  if (!parents.has(k)) parents.set(k, { has: r.parent_has_org_unique, name: r.parent_org_unique_name, cols: new Set() });
  parents.get(k).cols.add(r.parent_col);
}
console.log("total single-col tenant FKs:", rows.length);
console.log("actionable:", actionable.length);
console.log("child org_id NULLABLE:", actionable.filter((r) => !r.child_org_notnull).length);
console.log("composite already exists:", actionable.filter((r) => r.composite_already_exists).length);
console.log("parent NOT referencing id:", actionable.filter((r) => r.parent_col !== "id").length);
console.log("org type mismatch:", actionable.filter((r) => r.child_org_type !== r.parent_org_type).length);
console.log("col type mismatch:", actionable.filter((r) => r.child_col_type !== r.parent_col_type).length);
console.log("on_delete distribution:", JSON.stringify(actionable.reduce((a, r) => ((a[r.on_delete] = (a[r.on_delete] ?? 0) + 1), a), {})));
console.log("on_update distribution:", JSON.stringify(actionable.reduce((a, r) => ((a[r.on_update] = (a[r.on_update] ?? 0) + 1), a), {})));
console.log("distinct parents:", parents.size);
console.log("parents MISSING (org_id,col) unique:", [...parents.entries()].filter(([, v]) => !v.has).length);
for (const [k, v] of [...parents.entries()].filter(([, v]) => !v.has))
  console.log("   need unique:", k, "cols:", [...v.cols].join("|"));

await sql.end();
