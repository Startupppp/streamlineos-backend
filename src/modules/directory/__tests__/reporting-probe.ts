import postgres from "postgres";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import { createProbeOrg, dropProbeOrg, type ProbeOrg } from "../../../../test/helpers/probe-org";

export interface ProbePerson {
  userId: string;
  email: string;
  membershipId: number;
  employmentId: number;
}

/** Tables a reporting-line probe writes, in the order teardown must clear them. */
export const REPORTING_PROBE_TABLES = [
  "hr_reporting_lines_superseded",
  "hr_top_level_roles",
  "hr_reporting_manager_requests",
  "hr_reporting_lines",
  "hr_reporting_line_bulk_job_rows",
  "hr_reporting_line_bulk_jobs",
  "hr_reporting_manager_policies",
  "hr_employments",
  "hr_people",
];

export function connectProbe(spec: string) {
  const raw = requireApprovedDatabaseUrl({ spec, vars: ["HR_PROBE_DATABASE_URL", "DATABASE_URL"] });
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return postgres(url.toString(), { prepare: false, max: 2, ssl: local ? false : "require", connect_timeout: 30, onnotice: () => {} });
}

/** A disposable org whose owner has accepted their invite and is employed, so they can be a manager. */
export class ReportingProbe {
  readonly extraUserIds: string[] = [];
  owner: ProbePerson = { userId: "", email: "", membershipId: 0, employmentId: 0 };
  private counter = 0;

  constructor(
    readonly sql: postgres.Sql,
    readonly org: ProbeOrg,
  ) {}

  static async create(sql: postgres.Sql, label: string): Promise<ReportingProbe> {
    const probe = new ReportingProbe(sql, await createProbeOrg(sql, label));
    await sql`UPDATE users SET email_verified = now() WHERE id = ${probe.org.userId}`;
    const employmentId = await probe.employ(probe.org.userId, "owner");
    probe.owner = { userId: probe.org.userId, email: `${probe.org.userId}@synthetic.invalid`, membershipId: probe.org.membershipId, employmentId };
    return probe;
  }

  get orgId(): string {
    return this.org.orgId;
  }

  async person(
    label: string,
    options: { lifecycle?: string; joiningDate?: string; lastWorkingDay?: string | null; accepted?: boolean } = {},
  ): Promise<ProbePerson> {
    this.counter += 1;
    const userId = `${this.org.userId}-${label}-${this.counter}`;
    const email = `${userId}@synthetic.invalid`;
    this.extraUserIds.push(userId);
    await this.sql`
      INSERT INTO users (id, email, name, is_active, email_verified)
      VALUES (${userId}, ${email}, ${label}, true, ${options.accepted === false ? null : new Date()})`;
    const [member] = await this.sql<{ id: number }[]>`
      INSERT INTO organization_members (user_id, org_id, role, is_owner, status, joined_at)
      VALUES (${userId}, ${this.org.orgId}, 'MEMBER', false, 'ACTIVE', now())
      RETURNING id`;
    const employmentId = await this.employ(userId, label, options);
    return { userId, email, membershipId: member.id, employmentId };
  }

  async line(subject: ProbePerson, manager: ProbePerson, from: string, to = "infinity", lineType = "primary"): Promise<number> {
    const [row] = await this.sql<{ id: number }[]>`
      INSERT INTO hr_reporting_lines (org_id, employment_id, manager_employment_id, line_type, effective_from, effective_to)
      VALUES (${this.org.orgId}, ${subject.employmentId}, ${manager.employmentId}, ${lineType}, ${from}::text::date, ${to}::text::date)
      RETURNING id`;
    return row.id;
  }

  async policy(values: { max?: number; defaultManager?: string | null; order?: string; threshold?: number; allowTopLevel?: boolean }): Promise<void> {
    await this.sql`
      INSERT INTO hr_reporting_manager_policies
        (org_id, max_secondary_managers_per_employee, default_primary_manager_user_id, fallback_order, require_reason_after_changes, allow_top_level_without_manager)
      VALUES (${this.org.orgId}, ${values.max ?? 0}, ${values.defaultManager ?? null}, ${values.order ?? "CONFIGURED_MANAGER_THEN_UPLOADER"},
              ${values.threshold ?? 3}, ${values.allowTopLevel ?? true})
      ON CONFLICT (org_id) DO UPDATE SET
        max_secondary_managers_per_employee = EXCLUDED.max_secondary_managers_per_employee,
        default_primary_manager_user_id = EXCLUDED.default_primary_manager_user_id,
        fallback_order = EXCLUDED.fallback_order,
        require_reason_after_changes = EXCLUDED.require_reason_after_changes,
        allow_top_level_without_manager = EXCLUDED.allow_top_level_without_manager`;
  }

  async drop(): Promise<void> {
    await this.sql`DELETE FROM outbox_events WHERE organization_id = ${this.org.orgId}`;
    await dropProbeOrg(this.sql, this.org, REPORTING_PROBE_TABLES);
    for (const userId of this.extraUserIds) await this.sql`DELETE FROM users WHERE id = ${userId}`;
  }

  private async employ(userId: string, label: string, options: { lifecycle?: string; joiningDate?: string; lastWorkingDay?: string | null } = {}): Promise<number> {
    const [person] = await this.sql<{ id: number }[]>`
      INSERT INTO hr_people (org_id, user_id) VALUES (${this.org.orgId}, ${userId}) RETURNING id`;
    const [employment] = await this.sql<{ id: number }[]>`
      INSERT INTO hr_employments (org_id, person_id, employee_number, lifecycle_status, is_primary, joining_date, last_working_day)
      VALUES (${this.org.orgId}, ${person.id}, ${`EMP-${label}-${this.counter}-${person.id}`}, ${options.lifecycle ?? "ACTIVE"}, true,
              ${options.joiningDate ?? "2025-01-01"}::text::date, ${options.lastWorkingDay ?? null}::text::date)
      RETURNING id`;
    return employment.id;
  }
}
