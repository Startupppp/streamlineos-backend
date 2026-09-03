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
}

const SUFFIX_STRIP = /(Id|Key|Slug|Token)$/;

/** `pmWorkspaceId` -> `pm_workspace`; `projectId` -> `project`. */
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
  workspaceId: ["pm_workspaces"],
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
  zoneId: ["geofence_zones", "hr_geofence_zones"],
  shiftId: ["shift_templates"],
  recallId: ["inv_recalls", "inv_recall_events"],
  variableId: ["workflow_variables"],
  serialId: ["inv_serial_numbers"],
  snapshotId: ["crm_forecast_snapshots"],
  appId: ["marketplace_apps", "apps"],
};

export function candidateTableNames(route: HandlerRoute, param: string): string[] {
  const out: string[] = [];
  const push = (name: string): void => {
    if (name.length > 0 && !out.includes(name)) out.push(name);
  };
  for (const alias of PARAM_ALIASES[param] ?? []) push(alias);
  const segment = precedingSegment(route.path, param);
  if (segment !== null) for (const candidate of pluralCandidates(segment)) push(candidate);
  for (const candidate of pluralCandidates(paramStem(param))) push(candidate);
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
 * name says which. Three signals decide, in order:
 *
 *   populated   a table with no row for the source tenant can never produce a probe, so a
 *               populated match is always preferred over an empty one;
 *   hint        how many of the route's own literal segments appear in the table's name, so
 *               `/build/:projectId/whiteboards/:id` prefers `build.project_whiteboards`;
 *   length      the shortest remaining name, which is the least-qualified and usually the base
 *               entity rather than a join or history table.
 *
 * A wrong guess is not a false pass: the sweep's own-tenant control has to answer 2xx before any
 * cross-tenant answer is scored, so a mis-resolved table produces an UNPROBEABLE route with a
 * recorded reason.
 */
function rank(
  matches: readonly TableRef[],
  populated: ReadonlySet<string>,
  hints: readonly string[],
): TableRef | null {
  let best: TableRef | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const table of matches) {
    const full = `${table.schema}_${table.name}`;
    let score = populated.has(`${table.schema}.${table.name}`) ? 10_000 : 0;
    for (const hint of hints) if (full.includes(hint)) score += 100;
    score -= table.name.length;
    if (score > bestScore) {
      bestScore = score;
      best = table;
    }
  }
  return best;
}

/**
 * Resolves each candidate name against the tables that actually exist, trying every module prefix
 * and then any table whose name ENDS with the candidate. `known` is keyed `schema.table`.
 *
 * The suffix pass is what reaches `build.project_whiteboards` from `:whiteboardId` and
 * `public.job_requisitions` from `:requisitionId` — names no prefix list can enumerate, because the
 * qualifier belongs to the entity rather than to a module namespace.
 */
export function resolveTable(
  candidates: readonly string[],
  known: ReadonlyMap<string, TableRef>,
  populated: ReadonlySet<string> = new Set<string>(),
  hints: readonly string[] = [],
): TableRef | null {
  for (const candidate of candidates) {
    const exact: TableRef[] = [];
    for (const prefix of TABLE_PREFIXES)
      for (const schema of ["public", "build"]) {
        const hit = known.get(`${schema}.${prefix}${candidate}`);
        if (hit) exact.push(hit);
      }
    const chosen = rank(exact, populated, hints);
    if (chosen) return chosen;

    const suffix: TableRef[] = [];
    for (const table of known.values()) if (table.name.endsWith(`_${candidate}`)) suffix.push(table);
    const bySuffix = rank(suffix, populated, hints);
    if (bySuffix) return bySuffix;
  }
  return null;
}
