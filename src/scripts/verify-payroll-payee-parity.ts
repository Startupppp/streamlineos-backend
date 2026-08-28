import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { eq, inArray, isNotNull, sql } from "drizzle-orm";
import { EmploymentBackfillContextModule } from "./employment-backfill-context";
import { EmploymentBackfillService } from "../modules/hr/core/employment-backfill.service";
import { EmploymentFactsService } from "../modules/directory/employment-facts.service";
import { loadRunEmployeePayees } from "../modules/payroll/lib/payroll-run-payee";
import { DRIZZLE } from "../db/drizzle.constants";
import type { Db } from "../db/drizzle.module";
import {
  hrEmployeeSensitiveFields,
  hrEmployments,
  hrPeople,
  organizationMembers,
  organizationPeople,
  organizations,
  payrollRunEmployees,
  payrollRuns,
  users,
} from "../db/schema";
import { runInNewTenantTransaction } from "../common/tenant/run-in-tenant-transaction";
import {
  resetEmploymentFallbacks,
  snapshotEmploymentFallbacks,
} from "../modules/directory/employment-fallback-counter";
import {
  encryptBankDetails,
  encrypt,
  decrypt,
  decryptBankDetails,
  type BankDetails,
} from "../modules/hr/onboarding/core/crypto.helpers";

const USER_ID = `payee-parity-user-${process.pid}`;
let ORG_ID = "";

const BANK: BankDetails = {
  accountNumber: "000123456789",
  bankName: "Fixture Bank",
  branch: "Fixture Branch",
  ifsc: "FIXT0000123",
  accountHolder: "Parity Fixture",
  pfUanNumber: "100200300400",
  esiIpNumber: "3300123456",
};

type LegacyPayee = {
  employeeId: string | null;
  designation: string | null;
  joiningDate: string | null;
  bankDetails: BankDetails | null;
  taxId: string | null;
};

async function pickFixtureOrg(db: Db): Promise<string> {
  const explicit = process.argv[2];
  if (explicit) return explicit;
  const [row] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(isNotNull(organizations.region))
    .limit(1);
  if (!row) throw new Error("no placed organisation available to host the fixture");
  return row.id;
}

async function seed(db: Db): Promise<number> {
  await db.insert(users).values({
    id: USER_ID,
    email: `${USER_ID}@fixture.invalid`,
    name: "Parity Fixture",
    firstName: "Parity",
    lastName: "Fixture",
    employeeId: `EMP-PARITY-${process.pid}`,
    designation: "Senior Engineer",
    joiningDate: "2024-04-01",
    monthlySalary: "125000.00",
    bankDetails: encryptBankDetails(BANK),
    taxId: encrypt("ABCDE1234F"),
  });

  return runInNewTenantTransaction(db, ORG_ID, async (tx) => {
    await tx.insert(organizationMembers).values({
      userId: USER_ID,
      orgId: ORG_ID,
      role: "MEMBER",
      status: "ACTIVE",
    });

    const [run] = await tx
      .insert(payrollRuns)
      .values({ orgId: ORG_ID, month: "2026-08", status: "PREPARING" })
      .returning({ id: payrollRuns.id });
    if (!run) throw new Error("fixture run insert failed");

    await tx.insert(payrollRunEmployees).values({
      orgId: ORG_ID,
      runId: run.id,
      userId: USER_ID,
      gross: "125000.00",
      net: "125000.00",
    });
    return run.id;
  });
}

async function legacyPayee(db: Db): Promise<LegacyPayee> {
  const [row] = await db
    .select({
      employeeId: users.employeeId,
      designation: users.designation,
      joiningDate: users.joiningDate,
      bankDetails: users.bankDetails,
      taxId: users.taxId,
    })
    .from(users)
    .where(eq(users.id, USER_ID))
    .limit(1);
  if (!row) throw new Error("fixture user vanished");
  return {
    employeeId: row.employeeId,
    designation: row.designation,
    joiningDate: row.joiningDate,
    bankDetails: decryptBankDetails(row.bankDetails),
    taxId: row.taxId ? decrypt(row.taxId) : null,
  };
}

async function cleanup(db: Db, runId: number | null): Promise<void> {
  await runInNewTenantTransaction(db, ORG_ID, async (tx) => {
    if (runId !== null) {
      await tx.delete(payrollRunEmployees).where(eq(payrollRunEmployees.runId, runId));
      await tx.delete(payrollRuns).where(eq(payrollRuns.id, runId));
    }
    await tx.delete(hrEmployeeSensitiveFields).where(
      inArray(
        hrEmployeeSensitiveFields.employmentId,
        tx.select({ id: hrEmployments.id }).from(hrEmployments).where(
          inArray(
            hrEmployments.personId,
            tx.select({ id: hrPeople.id }).from(hrPeople).where(eq(hrPeople.userId, USER_ID)),
          ),
        ),
      ),
    );
    await tx.delete(hrEmployments).where(
      inArray(
        hrEmployments.personId,
        tx.select({ id: hrPeople.id }).from(hrPeople).where(eq(hrPeople.userId, USER_ID)),
      ),
    );
    await tx.delete(hrPeople).where(eq(hrPeople.userId, USER_ID));
    await tx.delete(organizationPeople).where(eq(organizationPeople.userId, USER_ID));
    await tx.delete(organizationMembers).where(eq(organizationMembers.userId, USER_ID));
  });
  await db.delete(users).where(eq(users.id, USER_ID));
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(EmploymentBackfillContextModule, {
    logger: ["error"],
  });
  const db = app.get<Db>(DRIZZLE);
  const facts = app.get(EmploymentFactsService);
  const backfill = app.get(EmploymentBackfillService);

  let runId: number | null = null;
  try {
    ORG_ID = await pickFixtureOrg(db);
    const seededRunId = await seed(db);
    runId = seededRunId;

    const before = await legacyPayee(db);

    await backfill.backfillOrg(ORG_ID, null);

    resetEmploymentFallbacks();
    const after = await runInNewTenantTransaction(db, ORG_ID, (tx) =>
      loadRunEmployeePayees(tx, ORG_ID, seededRunId, facts),
    );
    const payee = after[0];
    if (!payee) throw new Error("the migrated loader returned no payee for the fixture run");

    const diffs: string[] = [];
    const compare = (field: string, left: unknown, right: unknown): void => {
      if (JSON.stringify(left) !== JSON.stringify(right))
        diffs.push(`${field}: before=${JSON.stringify(left)} after=${JSON.stringify(right)}`);
    };

    compare("employeeId", before.employeeId, payee.employeeId);
    compare("designation", before.designation, payee.designation);
    compare("joiningDate", before.joiningDate, payee.joiningDate);
    compare("bankDetails", before.bankDetails, payee.bankDetails);
    compare("taxId", before.taxId, payee.taxId);

    console.log(
      JSON.stringify(
        {
          fixtureOrg: ORG_ID,
          before,
          after: {
            employeeId: payee.employeeId,
            designation: payee.designation,
            joiningDate: payee.joiningDate,
            bankDetails: payee.bankDetails,
            taxId: payee.taxId,
          },
          identical: diffs.length === 0,
          diffs,
          fallbacksDuringLoad: snapshotEmploymentFallbacks(),
        },
        null,
        2,
      ),
    );
    const fallbacks = snapshotEmploymentFallbacks();
    process.exitCode = diffs.length === 0 && fallbacks.total === 0 ? 0 : 1;
  } finally {
    await cleanup(db, runId).catch((err: unknown) => console.error("cleanup failed", err));
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
