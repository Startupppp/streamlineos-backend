import { loadRouteSurface, isObjectAddressable, type HandlerRoute } from "../route-surface";

/**
 * A live BOLA probe needs a real object id, and the id has to come from a table. Nothing in a
 * NestJS route declaration says which table `:projectId` addresses, so this resolves it from the
 * two signals the route itself carries — the collection segment in front of the parameter, and the
 * parameter's own name — and then confirms the guess by REQUESTING THE OBJECT AS ITS OWNER.
 *
 * The guess is never trusted. `bola-live-cross-tenant.seeded-e2e-spec.ts` scores a route only when
 * that owner request answered 2xx, so a wrong table produces an unprobeable route with a recorded
 * reason, never a green one. That is the whole reason a heuristic is admissible here.
 */

export interface TableRef {
  readonly schema: string;
  readonly name: string;
  readonly pk: string;
  /** `org_id` on most tables, `organization_id` on 81 of them. */
  readonly orgColumn: string;
  /**
   * The primary key's Postgres type name, when the catalog was read from a live database.
   *
   * It is what lets a candidate table be ruled out before a request is spent: `openapi.json`
   * declares 1,685 of the 2,245 path parameters as `integer`/`number` and 44 as `format: uuid`, and
   * a table whose key is the other kind can only ever answer 400 "Invalid UUID" / "expected number,
   * received NaN". Optional because the offline specs build a `TableRef` by hand and the filter is
   * simply not applied when the type is unknown.
   */
  readonly pkType?: string;
}

const SUFFIX_STRIP = /(Id|Key|Slug|Token)$/;

/** `projectId` -> `project`; `ticketId` -> `ticket`. */
export function paramStem(param: string): string {
  const withoutSuffix = param.replace(SUFFIX_STRIP, "");
  return withoutSuffix.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** English plural forms a table name is likely to use. */
export function pluralCandidates(stem: string): string[] {
  if (stem.length === 0) return [];
  const out = new Set<string>([stem, `${stem}s`]);
  if (/(s|x|z|ch|sh)$/.test(stem)) out.add(`${stem}es`);
  if (/[^aeiou]y$/.test(stem)) out.add(`${stem.slice(0, -1)}ies`);
  if (/y$/.test(stem)) out.add(stem.replace(/y$/, "ies"));
  if (/person$/.test(stem)) out.add(stem.replace(/person$/, "people"));
  if (/s$/.test(stem)) out.add(stem.slice(0, -1));
  return [...out];
}

/** `/build/:projectId/tickets/:ticketId` -> the segment in front of each parameter. */
export function precedingSegment(path: string, param: string): string | null {
  const parts = path.split("/").filter((p) => p.length > 0);
  const at = parts.indexOf(`:${param}`);
  if (at <= 0) return null;
  const before = parts[at - 1];
  if (before === undefined || before.startsWith(":")) return null;
  return before.replace(/-/g, "_");
}

/**
 * Names a table might be found under, most specific first.
 *
 * The prefixes are the module namespaces this schema actually uses (`inv_products`, `hr_people`,
 * `kb_articles`), so `products` has to be able to match `inv_products` — an exact-name-only lookup
 * resolves almost nothing here.
 */
export const TABLE_PREFIXES = [
  "",
  "inv_",
  "hr_",
  "kb_",
  "acc_",
  "fin_",
  "gl_",
  "crm_",
  "ai_",
  "chat_",
  "mail_",
  "sign_",
  "support_",
  "payroll_",
  "org_",
  "organization_",
  "build_",
  "pm_",
  "helpdesk_",
  "project_",
  "projects_",
  "ticket_",
  "candidate_",
  "job_",
  "lead_",
  "deal_",
  "team_",
  "user_",
  "employee_",
  "vendor_",
  "notification_",
  "automation_",
  "workflow_",
  "interview_",
  "offer_",
  "okr_",
  "git_",
  "form_",
  "release_",
  "portfolio_",
  "program_",
  "feedbucket_",
  "timer_",
  "nps_",
  "csat_",
  "pulse_",
  "survey_",
  "principal_",
  "biometric_",
  "calibration_",
  "commission_",
  "ownership_",
  "one_on_one_",
  "group_",
] as const;

/**
 * Aliases the two structural signals cannot produce.
 *
 * Every entry is a name the route uses for something the schema calls something else. They are
 * still only candidates — the owner control decides.
 */
export const PARAM_ALIASES: Readonly<Record<string, readonly string[]>> = {
  orgId: ["organizations"],
  organizationId: ["organizations"],
  membershipId: ["organization_members"],
  employeeId: ["hr_employments", "hr_people"],
  personId: ["organization_people", "hr_people"],
  /**
   * MEASURED. Without this the preceding segment wins — `/payroll/people/:organizationPersonId`
   * and `/directory/people/:organizationPersonId` both offer the candidate `people`, which the
   * prefix pass resolves to the populated `hr_people` — and the sweep then borrows an `hr_people.id`
   * for a parameter the handler resolves through `organization_people.organization_person_id`.
   * Three of the four routes answered their OWN tenant 404 and were filed unprobeable; the fourth
   * (`GET /payroll/people/:organizationPersonId/eligibility`) answered 200 with `unknown-person`
   * for every id, which read as a probed route and was not one. `organization_people` is what the
   * parameter names.
   */
  organizationPersonId: ["organization_people"],
  workerId: ["workers"],
  userId: ["users"],
  supportTicketId: ["support_tickets"],
  ticketId: ["tickets", "support_tickets", "helpdesk_tickets"],
  articleId: ["kb_articles"],
  pageId: ["kb_pages", "pages"],
  spaceId: ["kb_spaces"],
  channelId: ["chat_channels"],
  messageId: ["chat_messages", "mail_message_metadata"],
  runId: ["payroll_runs", "workflow_runs", "automation_runs"],
  periodId: ["payroll_periods", "acc_periods"],
  partyId: ["business_parties"],
  clientId: ["clients"],
  vendorId: ["inv_vendors", "vendors"],
  soId: ["inv_sales_orders"],
  poId: ["inv_purchase_orders"],
  billId: ["purchase_bills"],
  invoiceId: ["invoices"],
  entryId: ["gl_journal_entries", "hr_leave_ledger", "timesheet_entries"],
  journalId: ["gl_journals"],
  levelId: ["inv_stock_levels"],
  variantId: ["inv_product_variants"],
  productId: ["inv_products", "managed_products"],
  locationId: ["inv_locations", "locations"],
  warehouseId: ["inv_warehouses"],
  eventId: ["calendar_events", "notification_events"],
  notificationId: ["notifications"],
  roleId: ["roles"],
  projectId: ["projects"],
  sprintId: ["sprints"],
  statusId: ["project_statuses"],
  postId: ["feedback_posts", "blog_posts"],
  reviewId: ["performance_reviews"],
  requestId: ["leave_requests"],
  balanceId: ["leave_balances"],
  typeId: ["leave_types"],
  policyId: ["fin_reminder_policies", "policies"],
  attendanceId: ["attendance"],
  timesheetId: ["timesheets"],
  contactId: ["contacts"],
  leadId: ["leads"],
  dealId: ["deals"],
  announcementId: ["announcements"],
  itemId: ["roadmap_items", "module_setup_checklist_items", "intake_items"],
  checklistId: ["module_setup_checklists"],
  visitId: ["kb_page_visits"],
  assigneeId: ["ticket_assignees"],
  attendeeId: ["event_attendees"],
  memberId: ["project_members", "chat_channel_members", "organization_members"],
  transactionId: ["inv_stock_transactions"],
  paymentId: ["acc_tax_payments", "payments"],
  lineItemId: ["payroll_line_items"],
  reportingLineId: ["hr_reporting_lines"],
  changelogId: ["changelog_entries"],
  savedMessageId: ["chat_saved_messages"],
  watermarkId: ["notification_read_watermarks"],
  exceptionId: ["calendar_event_exceptions"],
  grantId: ["role_permission_grants", "user_permission_grants"],
  assignmentId: ["role_assignments"],

  // The organization hierarchy is one table with a `kind`, so five route nouns share it.
  branchId: ["org_units"],
  departmentId: ["org_units"],
  businessUnitId: ["org_units"],
  costCenterId: ["org_units"],
  unitId: ["org_units"],
  divisionId: ["org_units"],

  subjectId: ["subjects"],
  subjectTypeId: ["subject_types"],
  subjectPartyLinkId: ["subject_party_links"],
  workerEngagementId: ["worker_engagements"],
  findingId: ["data_quality_findings"],
  crmMailboxSyncId: ["crm_mailbox_sync"],
  crmConnectorSyncId: ["crm_connector_syncs"],
  issueRecordId: ["issue_records"],
  threadId: ["relationship_threads", "mail_threads"],
  leaveId: ["leave_requests"],
  blackoutId: ["leave_blackout_dates"],
  timerId: ["timer_sessions"],
  quarantineId: ["file_quarantine_records"],
  accommodationId: ["hr_accommodation_requests"],
  successionId: ["hr_succession_plans"],
  handbookId: ["handbook_versions"],
  kpiId: ["kpi_definitions"],
  docId: ["documents"],
  epicId: ["tickets"],
  zoneId: ["geofences"],
  shiftId: ["shift_templates"],
  recallId: ["inv_recalls", "inv_recall_events"],
  variableId: ["workflow_variables"],
  serialId: ["inv_serial_numbers"],
  snapshotId: ["crm_forecast_snapshots"],
  appId: ["marketplace_apps", "apps"],

  // Parameters whose names give no structural signal — the handler uses a noun the route omits.
  webhookId: ["webhook_endpoints"],
  invitationId: ["invitations"],
  publicationId: ["payslip_publications"],
  providerId: ["notification_provider_accounts"],
  suppressionId: ["notification_suppression_rules"],
  tagId: ["kb_tags", "support_tags"],
  groupId: ["principal_groups"],
  approvalId: ["workflow_approvals"],
  arrearId: ["hr_arrears_adjustments"],
  varianceId: ["hr_payroll_variance_approvals"],
  pipId: ["performance_improvement_plans"],
  swapId: ["shift_swap_requests"],
};

/**
 * Aliases that depend on WHERE the parameter appears, not only on its name.
 *
 * `:jobId` means `job_postings` under `/hr/recruitment`, `sign_bulk_send_jobs` under
 * `/sign/bulk-send`, `inv_export_jobs` under `/inventory/export` and `payroll_jobs` under
 * `/payroll/jobs` — one parameter, seven tables, and neither the parameter name nor the preceding
 * segment can tell them apart. Without this the module-prefix pass resolves every one of them to
 * `public.ai_jobs`, which holds an unrelated row, and all 13 routes answer their OWN tenant 404.
 *
 * Each entry was read out of the handler's service, not guessed: the `match` is a literal path
 * fragment, and the first matching entry wins.
 */
export const PATH_PARAM_ALIASES: readonly {
  readonly match: string;
  readonly param: string;
  readonly tables: readonly string[];
}[] = [
  { match: "/hr/recruitment/jobs", param: "jobId", tables: ["job_postings"] },
  { match: "/hr/recruitment/internal-jobs", param: "jobId", tables: ["job_postings"] },
  { match: "/careers/", param: "jobId", tables: ["job_postings"] },
  { match: "/sign/bulk-send", param: "jobId", tables: ["sign_bulk_send_jobs"] },
  { match: "/inventory/export", param: "jobId", tables: ["inv_export_jobs"] },
  { match: "/inventory/import", param: "jobId", tables: ["inv_import_jobs"] },
  { match: "/hr/import/jobs", param: "jobId", tables: ["hr_import_jobs"] },
  { match: "/hr/export", param: "jobId", tables: ["hr_export_jobs"] },
  { match: "/finance/reports", param: "jobId", tables: ["finance_report_export_jobs"] },
  { match: "/payroll/runs", param: "jobId", tables: ["payroll_run_export_jobs"] },
  { match: "/payroll/filings", param: "jobId", tables: ["payroll_run_export_jobs"] },
  { match: "/payroll/jobs", param: "jobId", tables: ["payroll_jobs"] },
  { match: "/expenses/export", param: "jobId", tables: ["expense_export_jobs"] },
  { match: "/gdpr/export-async", param: "jobId", tables: ["gdpr_export_jobs"] },
  { match: "/accounting/recurring-bills", param: "templateId", tables: ["fin_recurring_bill_templates"] },
  { match: "/accounting/recurring-invoices", param: "templateId", tables: ["fin_recurring_invoice_templates"] },
  { match: "/payroll/templates", param: "templateId", tables: ["payroll_templates"] },
  { match: "/hr/recruitment/offer-templates", param: "templateId", tables: ["offer_letter_templates"] },
  { match: "/hr/webhooks", param: "subscriptionId", tables: ["hr_webhook_subscriptions"] },
  { match: "/crm/automations", param: "ruleId", tables: ["crm_automation_rules"] },
  { match: "/tasks", param: "taskId", tables: ["tasks"] },
  { match: "/tasks/sequences", param: "sequenceId", tables: ["task_sequences"] },
  { match: "/settings/custom-fields", param: "fieldId", tables: ["custom_field_definitions"] },
  { match: "/crm/settings/custom-fields", param: "fieldId", tables: ["custom_field_definitions"] },
  { match: "/kb/page-templates", param: "templateId", tables: ["kb_page_templates"] },
  { match: "/workflows/approvals", param: "approvalId", tables: ["workflow_approvals"] },
  { match: "/kb/tags", param: "tagId", tables: ["kb_tags"] },
  { match: "/organization/members", param: "memberId", tables: ["organization_members"] },
  { match: "/kb/spaces", param: "memberId", tables: ["kb_space_members"] },
];

/**
 * A table name worth trying, and whether it came from the curated alias table.
 *
 * The distinction is load-bearing: an alias is measured knowledge about one parameter, while the
 * two structural signals are guesses that a module prefix can send badly wrong — `:jobId` on
 * `/hr/recruitment/jobs/:jobId` matches `public.hr_export_jobs` on both the `hr` path hint and the
 * `jobs` stem, and neither signal can see that the route means `job_requisitions`.
 */
export interface CandidateName {
  readonly name: string;
  readonly alias: boolean;
}

export function candidateTableNames(route: HandlerRoute, param: string): CandidateName[] {
  const out: CandidateName[] = [];
  const push = (name: string, alias: boolean): void => {
    if (name.length > 0 && !out.some((entry) => entry.name === name)) out.push({ name, alias });
  };
  const scoped = PATH_PARAM_ALIASES.find((entry) => entry.param === param && route.path.includes(entry.match));
  if (scoped) for (const alias of scoped.tables) push(alias, true);
  for (const alias of PARAM_ALIASES[param] ?? []) push(alias, true);
  const segment = precedingSegment(route.path, param);
  if (segment !== null) for (const candidate of pluralCandidates(segment)) push(candidate, false);
  for (const candidate of pluralCandidates(paramStem(param))) push(candidate, false);
  return out;
}

/** Every object-addressable route in the tree, in a stable order. */
export function objectAddressableRoutes(): HandlerRoute[] {
  return loadRouteSurface()
    .filter(isObjectAddressable)
    .sort((a, b) => `${a.verb} ${a.path} ${a.file}`.localeCompare(`${b.verb} ${b.path} ${b.file}`));
}

/** The literal (non-parameter) segments of a route path, used to break a tie between tables. */
export function pathHints(path: string): string[] {
  return path
    .split("/")
    .filter((part) => part.length > 0 && !part.startsWith(":"))
    .map((part) => part.replace(/-/g, "_"));
}

/**
 * Ranks the tables a candidate name matched.
 *
 * `surveys` matches `nps_surveys`, `csat_surveys` and `pulse_surveys`; nothing in the parameter
 * name says which. Four signals decide, in order:
 *
 *   alias       a name from `PARAM_ALIASES` is measured, curated knowledge about this parameter and
 *               outranks anything the two structural heuristics produce;
 *   hint        how many of the route's own literal segments appear in the table's name, so
 *               `/build/:projectId/whiteboards/:id` prefers `build.project_whiteboards`;
 *   populated   a table with no row for the source tenant cannot produce a probe on its own, so a
 *               populated match outranks an empty one at equal hint strength;
 *   length      the shortest remaining name, which is the least-qualified and usually the base
 *               entity rather than a join or history table.
 *
 * ⚠ **The hint used to sit BELOW `populated`, and that ordering produced wrong bindings the sweep
 * could not recover from.** `populated` scored 10,000 and a hint 100, so a table holding one
 * unrelated row beat a table the route's own path names: `GET /csat/:surveyId` bound
 * `public.pulse_surveys` because `public.csat_surveys` was empty, `/tasks/:taskId` bound
 * `public.lead_tasks` and `/crm/automations/:ruleId` bound `build.project_automations`. Measured on
 * the previous full run, 252 of the 355 own-tenant control-404s addressed a table holding exactly
 * ONE row for the tenant — the signature of a table chosen because it had a row rather than because
 * it was the right one. Emptiness is now recovered differently (`resolveTables` returns
 * alternatives, the sweep tries the next one, and `fixture-seeder.ts` can create the missing
 * object), so `populated` no longer needs to dominate.
 */
type MatchKind = "exact" | "suffix" | "prefix";

const MATCH_BONUS: Readonly<Record<MatchKind, number>> = { exact: 60, suffix: 40, prefix: 20 };

interface Match {
  readonly table: TableRef;
  readonly candidate: CandidateName;
  readonly order: number;
  readonly kind: MatchKind;
}

function scoreMatch(match: Match, populated: ReadonlySet<string>, hints: readonly string[]): number {
  const full = `${match.table.schema}_${match.table.name}`;
  let score = match.candidate.alias ? 5_000 : 0;
  for (const hint of hints) if (full.includes(hint)) score += 1_000;
  if (populated.has(`${match.table.schema}.${match.table.name}`)) score += 500;
  score += match.order * 10;
  score += MATCH_BONUS[match.kind];
  return score - match.table.name.length;
}

export function resolveTable(
  candidates: readonly (string | CandidateName)[],
  known: ReadonlyMap<string, TableRef>,
  populated: ReadonlySet<string> = new Set<string>(),
  hints: readonly string[] = [],
): TableRef | null {
  return resolveTables(candidates, known, populated, hints)[0] ?? null;
}

/**
 * How many tables one parameter may be tried against before the route is filed unprobeable.
 *
 * A single answer is what the sweep used to take, and a wrong one is unrecoverable: the control
 * answers 404 and the route is filed as unreachable with no record that the table was the problem.
 * Four is enough for every ambiguity measured here (`surveys` matches three tables, `jobs` several,
 * `templates` five) and is bounded, so the attempt schedule cannot blow up.
 */
export const MAX_TABLE_CANDIDATES = 4;

/**
 * Every table a parameter might address, best first.
 *
 * The sweep tries them in order and stops at the first whose own-tenant control answers 2xx, so an
 * ambiguous parameter name costs extra requests rather than costing the route. The list is still
 * only a set of candidates — the owner control decides, exactly as it did when this returned one.
 *
 * Three passes find the matches, and all three are ranked TOGETHER rather than in sequence: a
 * module prefix in front of the name (`inv_products` for `products`), the name as a suffix
 * (`build.project_whiteboards` for `whiteboards`) and the name as a prefix (`job_requisitions` for
 * `job`). The third exists because the qualifier often follows the entity rather than preceding it,
 * and no prefix list can enumerate that direction.
 */
export function resolveTables(
  candidates: readonly (string | CandidateName)[],
  known: ReadonlyMap<string, TableRef>,
  populated: ReadonlySet<string> = new Set<string>(),
  hints: readonly string[] = [],
  limit: number = MAX_TABLE_CANDIDATES,
): TableRef[] {
  const normalized: CandidateName[] = candidates.map((candidate) =>
    typeof candidate === "string" ? { name: candidate, alias: false } : candidate,
  );
  const matches: Match[] = [];
  const seen = new Set<string>();
  const collect = (table: TableRef, candidate: CandidateName, order: number, kind: MatchKind): void => {
    const key = `${table.schema}.${table.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    matches.push({ table, candidate, order, kind });
  };
  normalized.forEach((candidate, index) => {
    const order = normalized.length - index;
    for (const prefix of TABLE_PREFIXES)
      for (const schema of ["public", "build"]) {
        const hit = known.get(`${schema}.${prefix}${candidate.name}`);
        if (hit) collect(hit, candidate, order, "exact");
      }
    for (const table of known.values()) {
      if (table.name.endsWith(`_${candidate.name}`)) collect(table, candidate, order, "suffix");
      else if (table.name.startsWith(`${candidate.name}_`)) collect(table, candidate, order, "prefix");
    }
  });
  return matches
    .map((match) => ({ match, score: scoreMatch(match, populated, hints) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.match.table);
}
