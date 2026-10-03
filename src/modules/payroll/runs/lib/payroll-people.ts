import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import {
  employeeSalaryProfiles,
  hrEmployments,
  hrPeople,
  organizationMembers,
  organizationPeople,
  users,
  workers,
} from "../../../../db/schema";

export type PayrollPersonEligibility = "eligible" | "has-salary" | "needs-payee-link" | "exited";

export type PayrollPersonPayee = { kind: "user"; userId: string } | { kind: "worker"; workerId: string } | null;

export const PAYROLL_PEOPLE_SAMPLE_SIZE = 10;

function eligibilityCase(hasSalary: SQL, exited: SQL, payeeKind: SQL): SQL<PayrollPersonEligibility> {
  return sql<PayrollPersonEligibility>`case when ${hasSalary} then 'has-salary' when ${exited} then 'exited' when ${payeeKind} is null then 'needs-payee-link' else 'eligible' end`;
}

function employmentField(field: typeof hrEmployments.employeeNumber | typeof hrEmployments.lifecycleStatus): SQL {
  return sql`(select ${field} from ${hrEmployments} inner join ${hrPeople} on ${hrPeople.id} = ${hrEmployments.personId} and ${hrPeople.orgId} = ${hrEmployments.orgId} where ${hrEmployments.orgId} = ${organizationPeople.organizationId} and ${hrPeople.organizationPersonId} = ${organizationPeople.organizationPersonId} and ${hrEmployments.deletedAt} is null and ${hrPeople.deletedAt} is null order by ${hrEmployments.isPrimary} desc, ${hrEmployments.id} desc limit 1)`;
}

function personBranch(db: Db, orgId: string) {
  const member = sql`${organizationMembers.id} is not null`;
  const payeeKind = sql`case when ${member} then 'user' when ${workers.isPayee} then 'worker' end`;
  const hasSalary = sql`exists (select 1 from ${employeeSalaryProfiles} where ${employeeSalaryProfiles.orgId} = ${organizationPeople.organizationId} and ${employeeSalaryProfiles.status} = 'ACTIVE' and (${employeeSalaryProfiles.userId} = ${organizationPeople.userId} or ${employeeSalaryProfiles.workerId} = ${workers.workerId}))`;
  const exited = sql`(coalesce(${workers.status} = 'EXITED', false) or coalesce(${employmentField(hrEmployments.lifecycleStatus)} in ('EXITED', 'ALUMNI'), false))`;
  const displayName = sql`coalesce(${organizationPeople.displayName}, nullif(trim(concat_ws(' ', ${organizationPeople.firstName}, ${organizationPeople.lastName})), ''), ${users.name}, ${organizationPeople.workEmail}, ${users.email}, ${organizationPeople.organizationPersonId})`;

  return db
    .select({
      organizationPersonId: sql<string | null>`${organizationPeople.organizationPersonId}`.as("organization_person_id"),
      rowKey: sql<string>`'p:' || ${organizationPeople.organizationPersonId}`.as("row_key"),
      displayName: sql<string>`${displayName}`.as("display_name"),
      email: sql<string | null>`coalesce(${organizationPeople.workEmail}, ${users.email})`.as("email"),
      employeeNumber: sql<string | null>`${employmentField(hrEmployments.employeeNumber)}`.as("employee_number"),
      payeeKind: sql<"user" | "worker" | null>`${payeeKind}`.as("payee_kind"),
      payeeId: sql<string | null>`case when ${member} then ${organizationPeople.userId} when ${workers.isPayee} then ${workers.workerId} end`.as("payee_id"),
      hasSalary: sql<boolean>`${hasSalary}`.as("has_salary"),
      exited: sql<boolean>`${exited}`.as("exited"),
      eligibility: sql<PayrollPersonEligibility>`${eligibilityCase(hasSalary, exited, payeeKind)}`.as("eligibility"),
    })
    .from(organizationPeople)
    .leftJoin(users, eq(users.id, organizationPeople.userId))
    .leftJoin(
      organizationMembers,
      and(
        eq(organizationMembers.orgId, organizationPeople.organizationId),
        eq(organizationMembers.userId, organizationPeople.userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
    )
    .leftJoin(
      workers,
      and(
        eq(workers.organizationId, organizationPeople.organizationId),
        eq(workers.organizationPersonId, organizationPeople.organizationPersonId),
        isNull(workers.deletedAt),
      ),
    )
    .where(and(eq(organizationPeople.organizationId, orgId), isNull(organizationPeople.deletedAt)));
}

function memberOnlyBranch(db: Db, orgId: string) {
  const payeeKind = sql`'user'`;
  const hasSalary = sql`exists (select 1 from ${employeeSalaryProfiles} where ${employeeSalaryProfiles.orgId} = ${organizationMembers.orgId} and ${employeeSalaryProfiles.status} = 'ACTIVE' and ${employeeSalaryProfiles.userId} = ${organizationMembers.userId})`;
  const exited = sql`false`;

  return db
    .select({
      organizationPersonId: sql<string | null>`null::text`.as("organization_person_id"),
      rowKey: sql<string>`'u:' || ${organizationMembers.userId}`.as("row_key"),
      displayName: sql<string>`coalesce(${users.name}, nullif(trim(concat_ws(' ', ${users.firstName}, ${users.lastName})), ''), ${users.email})`.as("display_name"),
      email: sql<string | null>`${users.email}`.as("email"),
      employeeNumber: sql<string | null>`null::text`.as("employee_number"),
      payeeKind: sql<"user" | "worker" | null>`${payeeKind}`.as("payee_kind"),
      payeeId: sql<string | null>`${organizationMembers.userId}`.as("payee_id"),
      hasSalary: sql<boolean>`${hasSalary}`.as("has_salary"),
      exited: sql<boolean>`${exited}`.as("exited"),
      eligibility: sql<PayrollPersonEligibility>`${eligibilityCase(hasSalary, exited, payeeKind)}`.as("eligibility"),
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.status, "ACTIVE"),
        sql`not exists (select 1 from ${organizationPeople} where ${organizationPeople.organizationId} = ${organizationMembers.orgId} and ${organizationPeople.userId} = ${organizationMembers.userId} and ${organizationPeople.deletedAt} is null)`,
      ),
    );
}

export function payrollPeopleSource(db: Db, orgId: string) {
  return personBranch(db, orgId).unionAll(memberOnlyBranch(db, orgId)).as("payroll_people");
}


export function toPayee(payeeKind: "user" | "worker" | null, payeeId: string | null): PayrollPersonPayee {
  if (payeeKind === "user" && payeeId) return { kind: "user", userId: payeeId };
  if (payeeKind === "worker" && payeeId) return { kind: "worker", workerId: payeeId };
  return null;
}

export async function summarizePayrollPeople(db: Db, orgId: string) {
  const source = payrollPeopleSource(db, orgId);
  const [counts, samples] = await Promise.all([
    db
      .select({
        payable: sql<number>`(count(*) filter (where ${source.payeeKind} is not null and not ${source.exited}))::int`,
        withSalary: sql<number>`(count(*) filter (where ${source.hasSalary}))::int`,
        payableWithoutSalary: sql<number>`(count(*) filter (where ${source.eligibility} = 'eligible'))::int`,
        needsPayeeLink: sql<number>`(count(*) filter (where ${source.eligibility} = 'needs-payee-link'))::int`,
      })
      .from(source),
    db
      .select({
        organizationPersonId: source.organizationPersonId,
        displayName: source.displayName,
        payeeKind: source.payeeKind,
        payeeId: source.payeeId,
      })
      .from(source)
      .where(sql`${source.eligibility} = 'eligible'`)
      .orderBy(asc(source.displayName), asc(source.rowKey))
      .limit(PAYROLL_PEOPLE_SAMPLE_SIZE),
  ]);
  const row = counts[0];
  return {
    payable: Number(row?.payable ?? 0),
    withSalary: Number(row?.withSalary ?? 0),
    payableWithoutSalary: Number(row?.payableWithoutSalary ?? 0),
    needsPayeeLink: Number(row?.needsPayeeLink ?? 0),
    payableWithoutSalarySample: samples.map((sample) => ({
      organizationPersonId: sample.organizationPersonId,
      displayName: sample.displayName,
      payee: toPayee(sample.payeeKind, sample.payeeId),
    })),
  };
}
