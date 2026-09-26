# HRM-15 — Rollout note, operations and support article

Branches: `hrms/hrm-15-reporting-managers` in `streamlineos-backend` and `streamlineos-frontend`
(worktrees `hrm15-backend`, `hrm15-frontend`). Not pushed, not merged.

## 1. What changes on deploy

| Area | Before | After |
|---|---|---|
| Single onboarding | Manager required unless top-level | Manager optional; blank is resolved by the org policy (D2) or the request fails with `NO_DEFAULT_REPORTING_MANAGER` |
| Bulk onboarding | `reportingManagerEmail`; no preview; in-file managers refused by the approver acceptance rule | `primaryManagerEmail` (+ legacy aliases for one release), `secondaryManagerEmail1..3`, `effectiveFrom`; server preview with READY/WARNING/ERROR/SKIPPED; in-file managers work |
| Staged HR import | `managerEmail`, half-open line close, own cycle CTE | same columns and engine as bulk; blank = no change for existing employees; commit requires `Idempotency-Key` |
| Reporting lines | primary only; no source/reason; no DB guard for one current primary | primary + 0–3 secondary (org cap), source/reason/label, fallback visibility, partial unique + exclusion constraints, history archived never deleted |
| Approvals | primary current line | unchanged — primary only; secondary never routes approvals (pinned by `approval-routing-primary-only.db.spec.ts`) |
| Employee self-service | none | `/settings` → Reporting line: see managers, report an issue, history |
| HR | coverage page only | policy page, line editor, review queue, bulk reporting change wizard, coverage fallback/pending/policy-missing states |

Existing lines are **not** reassigned. Migration 1234 marks every existing line `source = MIGRATED`;
1235 normalises legacy half-open ends to inclusive ends and archives zero-length legacy rows into
`hr_reporting_lines_superseded` (never deletes). Employees without a manager stay in the Manager
Coverage "without manager" queue for HR remediation (bulk wizard). No automatic historical assignment.

## 2. Pre-deploy audit (run on each production database BEFORE applying 1231–1237)

```sql
-- a) overlapping primary lines under inclusive semantics — 1235 RAISES if any remain after normalisation
SELECT a.org_id, a.employment_id, a.id, b.id FROM hr_reporting_lines a
JOIN hr_reporting_lines b ON b.org_id = a.org_id AND b.employment_id = a.employment_id
  AND b.id > a.id AND a.line_type = 'primary' AND b.line_type = 'primary'
  AND daterange(a.effective_from, a.effective_to, '[]') && daterange(b.effective_from, b.effective_to, '[]');

-- b) legacy half-open closes that 1235 will normalise (count only)
SELECT count(*) FROM hr_reporting_lines a JOIN hr_reporting_lines b
  ON b.org_id = a.org_id AND b.employment_id = a.employment_id AND b.line_type = a.line_type
 AND b.effective_from = a.effective_to AND b.id <> a.id WHERE a.line_type = 'primary';

-- c) active employees without a current primary manager, per org (remediation queue size)
SELECT emp.org_id, count(*) FROM hr_employments emp
JOIN hr_people p ON p.id = emp.person_id AND p.org_id = emp.org_id AND p.deleted_at IS NULL
WHERE emp.is_primary AND emp.deleted_at IS NULL
  AND emp.lifecycle_status NOT IN ('CANDIDATE','EXITED','ALUMNI')
  AND NOT EXISTS (SELECT 1 FROM hr_reporting_lines rl WHERE rl.org_id = emp.org_id
    AND rl.employment_id = emp.id AND rl.line_type = 'primary'
    AND rl.effective_from <= CURRENT_DATE AND rl.effective_to >= CURRENT_DATE)
GROUP BY emp.org_id ORDER BY 2 DESC;
```

Local evidence (`scratch_hrm15`, a copy of dev data, not production): (a) 0, (b) 0, 1,100 lines
marked MIGRATED, 4,002 of 5,102 active employees without a current primary manager, 0 top-level
backfill candidates. A planted legacy pair on the replay copy proved normalisation (1 end fixed,
1 empty row archived). All six rollbacks were run and re-applied on the replay copy.

## 3. Feature flag recommendation

**No new flag.** Reasoning:
- The migrations are additive and do not change any existing assignment; the only data rewrite is
  the half-open → inclusive normalisation, which fixes an existing double-current-day bug and
  RAISES rather than guesses if any overlap remains.
- Approval routing is unchanged (primary only).
- The behaviour change users see is that a blank manager no longer blocks onboarding. It is
  visible (badge "Temporarily assigned by onboarding policy", Coverage "fallback" state) and
  correctable in one click.

**Gate instead on the pre-deploy audit:** if query (a) returns rows after 1235's normalisation on
any production database, 1235 will refuse to apply. Fix those rows by hand (they are genuine
conflicting history) before deploying — do not add a flag to work around them. If query (c) shows
an org with a large remediation queue, tell that org's HR before release; nothing breaks, but
Coverage will show the backlog.

Per-org rollout checks (PRD §14 — deployment settings, not blockers): default reporting manager
and its owner, secondary cap (0–3), remediation list, fallback order, outgoing-manager notices.

## 4. Deploy order

1. Backend migrations 1231–1237 (journal idx 1102–1108). 1237 adds `app.org_business_date(org)`,
   which every current-line reader now uses instead of the session's `CURRENT_DATE` (UTC for the
   app role) — before it, a line written on the org's "today" was invisible to approval routing,
   /me/team and the org chart until UTC midnight. Numbered after main's
   KB migrations (up to 1230, idx 1101). Uncommitted `1213_hr_employments_designation_provisional`
   in another checkout has no journal slot yet; when it lands it needs idx > 1108 and a `when`
   above 1803050410725, appended after these entries.
2. Backend deploy (catalog sync adds `hr:reporting-lines:manage|review|override`; the role
   reconciler converges HR_ADMIN/BRANCH_HR at boot — no grant migration).
3. Frontend deploy (vendored `contracts/openapi.json` and `contracts/permission-catalog.json`
   regenerated from this backend).

Rollback: frontend first, then backend, then the `.down.sql` files 1237 → 1231 (1237's rollback
requires the application build from before the org-business-date readers). 1235's rollback
refuses if the application has already archived `REPLACED` rows (restoring would recreate overlaps).

## 5. Monitoring — metrics, dashboards and alert thresholds

No metrics library exists in the backend; every metric is derived from durable rows or from the
two structured warn events added for HRM-15.

| Metric (PRD §10.12) | Source | Alert threshold |
|---|---|---|
| Fallback assignment rate | `hr_reporting_lines.source = 'ONBOARDING_FALLBACK'` ÷ lines with source in (`ONBOARDING_*`,`BULK_ONBOARDING`,`STAGED_IMPORT`) per org, 7d | > 25% for an org over 7d (policy/default manager likely wrong) |
| Unconfirmed fallbacks (backlog) | `source='ONBOARDING_FALLBACK' AND fallback_confirmed_at IS NULL` open primary lines | > 20 per org, or any older than 30 days |
| No-default failures | log event `hr.reporting_manager.no_default` (counts preview + commit attempts) | > 10/day per org → policy missing; page HR admin |
| Correction request volume / age | `hr_reporting_manager_requests` status PENDING/MORE_INFO_REQUIRED, `created_at` | any PENDING older than 5 business days; > 20 open per org |
| Changes per employee | primary lines created per employment in 24h (the D4 counter) | any employee ≥ 4 in 24h (already warns in UI; alert = audit review) |
| Bulk job failure rate | `hr_reporting_line_bulk_jobs.error_count / row_count`, status FAILED | FAILED job, or > 20% rows ERROR |
| Cycle rejections | log event `hr.reporting_line.refused` with `code = PRIMARY_CYCLE`; bulk rows with codes containing `PRIMARY_CYCLE` | > 5/day per org |
| Emergency overrides | `audit_logs.action = 'hr.reporting_line.emergency_override'` | every occurrence → notify security/HR lead |
| Legacy header usage | `audit_logs` `hr.employees_bulk_onboarded` / import jobs with `metadata.legacyManagerHeader = true` | none — track to zero; remove aliases after 30 consecutive days at zero |

## 6. Known limits (deliberate, documented)

- Staged-import **rollback does not revert reporting-line changes** on rows that UPDATED existing
  employees. Rollback now works for employees the job created (the pre-existing 23503 is fixed).
- Relationship changes are per employee (`setRelationships` takes one subject); bulk jobs and the
  legacy users bulk-update loop issue one savepoint per employee. Bounded by the 500-row job cap;
  preview is constant-query.
- `hr:reporting-lines:review` is not scopable; the HR queue is filtered by the caller's employees scope.
- Notifications use `NotificationDispatchService.emit` (recorded in-tx, deduped); no outbox events.

---

# Support article — "Primary and additional reporting managers"

**Every employee has one primary reporting manager.** This is the person who approves leave,
work-from-home, expenses and other requests, runs probation and performance reviews, and owns exit
handover. Top-level roles (for example the CEO) are the only exception, and HR records a reason.

**Additional reporting managers are optional.** If your organisation allows them (up to three per
employee, set by HR), they show a dotted-line, functional or project relationship. They appear on
the profile and in organisation views but **never approve requests** and get no HR permissions.

**If no manager is chosen during onboarding**, the system assigns one using your organisation's
Reporting Manager Policy (HR → Settings → Reporting managers): either the configured default
manager or the HR administrator who onboarded the person, in the order HR chose. The profile then
shows "Temporarily assigned by onboarding policy" until HR confirms or replaces it. If no eligible
person exists, onboarding stops and asks for a manager — the system never picks an arbitrary admin.

**Think your manager is wrong?** Go to Settings → Reporting line → Report an issue. Explain what is
wrong (at least 20 characters) and optionally suggest the right person. HR reviews it; your
manager is not told unless HR approves a change. You can cancel the request or answer HR's
questions from the same page.

**Spreadsheet change (bulk onboarding and employee import):** the column is now
`primaryManagerEmail`. The old `reportingManagerEmail`, `reportsTo` and `managerEmail` headers still
work for one release. New optional columns: `secondaryManagerEmail1`–`3`, `topLevelRoleReason`,
`effectiveFrom`. A row may name a manager who is another row of the same file. For an existing
employee in the import, a blank manager cell means "no change". Download a fresh template — it has
an Instructions sheet with examples.

**Frequent changes:** the first three primary-manager changes for one person within 24 hours work
normally. From the fourth, HR must give a reason and needs admin authority. Bulk changes of 10 or
more people require a job reason, a preview and typing a confirmation phrase.

**Changes are effective-dated.** Requests already waiting for approval stay with the approver they
were assigned to; only new requests follow the new manager.
