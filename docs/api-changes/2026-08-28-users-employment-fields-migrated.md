# 2026-08-28 — Employment facts move off `users.*` onto the organization's records

Tickets 09–14 of `c28`. The global `users` row stops carrying what a person is *to an organization*.
Nine columns are removed from `users`: `designation`, `employee_id`, `joining_date`,
`org_department_id`, `branch_id`, `reporting_to`, `monthly_salary`, `bank_details`, `tax_id`.

Every read now goes through one accessor, `EmploymentFactsService`
(`src/modules/directory/employment-facts.service.ts`), which answers from `hr_employments`,
`hr_reporting_lines` and `hr_employee_sensitive_fields`, scoped by `orgId`.

## Where each fact now lives

| Was on `users` | Is now |
|---|---|
| `designation` | `hr_employments.designation` |
| `employee_id` | `hr_employments.employee_number` |
| `joining_date` | `hr_employments.joining_date` |
| `org_department_id` | `hr_employments.department_id` |
| `branch_id` | `hr_employments.location_id` |
| `reporting_to` | `hr_reporting_lines` (effective-dated, not a flat column) |
| `monthly_salary` | `hr_employee_sensitive_fields.salary_amount_cents` (integer cents) |
| `bank_details` | `hr_employee_sensitive_fields.bank_details` — **envelope-encrypted** |
| `tax_id` | `hr_employee_sensitive_fields.tax_id` — **envelope-encrypted** |

## Behaviour changes callers can observe

**Employment facts are now per-organization.** A person with memberships in two organizations
returns a different designation, department, manager and pay in each. Previously both organizations
read one global row and the last writer won. Any client that cached an employment fact against a
bare `userId` must key it by `(orgId, userId)`.

**The manager is effective-dated.** `reporting_to` was a column that was overwritten. A manager
change now closes the open `hr_reporting_lines` row and inserts a new one, so history survives.
Reads resolve the line whose `effective_to = 'infinity'`.

**Bank details and tax id fail closed.** They are stored under per-record envelope encryption with
an auditable key reference (`enc:v2:<keyId>:…`, plus `hr_employee_sensitive_fields.encryption_key_ref`).
An unavailable or unknown key now **throws** rather than returning ciphertext, plaintext or a silent
`null`. A caller that previously received `null` on a decryption failure will now see an error — that
is deliberate.

**Worker-only payees resolve by person, not by user.** A payable worker with no login has no
`userId`; their bank details resolve through `getSensitiveFactsByPersonBatch(orgId, organizationPersonIds)`.

## Response shapes

**No response key was removed or renamed.** Endpoints that returned `designation`, `employeeId`,
`joiningDate`, `departmentId`, `branchId` or `reportingTo` still return them at the same keys, now
resolved from the organization's employment record rather than the global account.

This is a deliberate deviation from ticket 13's literal wording ("responses that carried employment
on a user payload no longer do"). The defect that criterion targets — one person's two employers
overwriting each other — is closed by the values being organization-scoped. Removing the keys would
force a second round trip for data an already organization-scoped endpoint holds, and would strip the
people directory, which root `CLAUDE.md` §8 designates platform core. Recorded here rather than
silently ticked; see ticket 13.

Endpoints still carrying employment on a user-shaped payload:

- `GET /users` and `GET /users/:userId` (`modules/users/organization-users.reader.ts`)
- `GET /dashboard/hr/birthdays`, `/dashboard/hr/team-attendance`, `/dashboard/leaves/today`
- `GET /rbac/roles/simulate/candidates`

## Not versioned

The API carries no versioning today — `main.ts` calls no `enableVersioning`, and introducing it is
ticket 18 in another session. The break is instead enforced by types: backend DTO and frontend type
change in the same commit, so a missed consumer is a compile error rather than an empty column.
Fold this entry into `/v1` when ticket 18 lands.
