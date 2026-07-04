import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq, inArray, count } from 'drizzle-orm';
import * as schema from '../../../db/schema';
import {
  organizations,
  users,
  auditLogs,
  payrollPolicies,
  payrollPolicyVersions,
  payrollRuns,
  payrollRunEmployees,
  payrollLineItems,
  payrollExceptions,
  payrollApprovals,
  payrollBankBatches,
  payrollBankBatchItems,
  payrollRunEvents,
  employeeSalaryProfiles,
} from '../../../db/schema';
import { encryptBankDetails } from '../../onboarding/crypto.helpers';
import { DEFAULT_PAYROLL_TOGGLES } from '../payroll.types';
import { PayoutBatchesService } from '../payout/payout-batches.service';
import { AuditService } from '../../../common/audit/audit.service';
import { StorageService } from '../../storage/storage.service';

type TestDb = PostgresJsDatabase<typeof schema>;

const P = 'e2e-payroll-iso-';
const ORG_A = `${P}org-a`;
const ORG_B = `${P}org-b`;
const USER_A = `${P}user-a`;
const USER_B = `${P}user-b`;

function normalizeDatabaseUrl(url: string): string {
  if (!/\.neon\.tech/i.test(url)) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('channel_binding');
    return parsed.toString();
  } catch {
    return url.replace(/[&?]channel_binding=[^&]*/g, '').replace(/\?&/, '?');
  }
}

function triggerErrorMsg(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const causeMsg = err.cause instanceof Error ? err.cause.message : '';
  return `${err.message} ${causeMsg}`;
}

async function assertTriggerRejects(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  if (caught === undefined) throw new Error('Expected query to be rejected by trigger');
  expect(triggerErrorMsg(caught)).toMatch(/immutable/i);
}

async function cleanupStaleData(db: TestDb): Promise<void> {
  const orgIds = [ORG_A, ORG_B];
  const userIds = [USER_A, USER_B];
  await db
    .update(payrollRuns)
    .set({ status: 'DRAFT' })
    .where(inArray(payrollRuns.orgId, orgIds));
  await db.delete(payrollBankBatchItems).where(inArray(payrollBankBatchItems.orgId, orgIds));
  await db.delete(payrollBankBatches).where(inArray(payrollBankBatches.orgId, orgIds));
  await db.delete(payrollRunEvents).where(inArray(payrollRunEvents.orgId, orgIds));
  await db.delete(payrollExceptions).where(inArray(payrollExceptions.orgId, orgIds));
  await db.delete(payrollApprovals).where(inArray(payrollApprovals.orgId, orgIds));
  await db.delete(payrollLineItems).where(inArray(payrollLineItems.orgId, orgIds));
  await db.delete(payrollRunEmployees).where(inArray(payrollRunEmployees.orgId, orgIds));
  await db.delete(payrollRuns).where(inArray(payrollRuns.orgId, orgIds));
  await db.delete(payrollPolicyVersions).where(inArray(payrollPolicyVersions.orgId, orgIds));
  await db.delete(payrollPolicies).where(inArray(payrollPolicies.orgId, orgIds));
  await db.delete(employeeSalaryProfiles).where(inArray(employeeSalaryProfiles.orgId, orgIds));
  await db.delete(auditLogs).where(inArray(auditLogs.userId, userIds));
  await db.delete(users).where(inArray(users.id, userIds));
  await db.delete(organizations).where(inArray(organizations.id, orgIds));
}

const d = process.env.DATABASE_URL ? describe : describe.skip;

d('Payroll DB Integration', () => {
  let sql: ReturnType<typeof postgres>;
  let db: TestDb;
  let lockedRunId: number;
  let draftRunId: number;
  let orgBRunId: number;
  let lockedEmpId: number;
  let draftEmpId: number;
  let lockedLineItemId: number;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL required');

    sql = postgres(normalizeDatabaseUrl(url), {
      prepare: false,
      ssl: 'require' as const,
      max: 3,
    });
    db = drizzle(sql, { schema });

    await cleanupStaleData(db);

    const encryptedBank = encryptBankDetails({
      accountNumber: '1234567890',
      bankName: 'Test Bank',
      branch: 'Main Branch',
      ifsc: 'TEST0001234',
      accountHolder: 'User A Test',
    });

    await db.insert(organizations).values([
      { id: ORG_A, name: `E2E Org A`, slug: `${P}slug-a` },
      { id: ORG_B, name: `E2E Org B`, slug: `${P}slug-b` },
    ]);

    await db.insert(users).values([
      { id: USER_A, email: `${P}user-a@example.com`, bankDetails: encryptedBank },
      { id: USER_B, email: `${P}user-b@example.com` },
    ]);

    const [policy] = await db
      .insert(payrollPolicies)
      .values({ orgId: ORG_A, country: 'IN', startMonth: '2025-01' })
      .returning({ id: payrollPolicies.id });
    if (!policy) throw new Error('Policy insert failed');

    const toggles: Record<string, unknown> = DEFAULT_PAYROLL_TOGGLES;
    const config: Record<string, unknown> = {
      components: [],
      rounding: { mode: 'NEAREST', precision: 2 },
      approvalChain: [],
      payslipLayout: 'CLASSIC',
      calendar: {
        attendanceCutoffDay: 25,
        reimbursementCutoffDay: 25,
        declarationCutoffDay: 25,
        previewDay: 26,
        approvalDeadlineDay: 27,
        publishOffsetDays: 1,
      },
      statutory: {
        pfEmployeePercent: '12',
        pfEmployerPercent: '12',
        pfWageCeiling: null,
        esiEmployeePercent: '0.75',
        esiEmployerPercent: '3.25',
        esiWageCeiling: null,
        professionalTaxMonthly: '0',
        tdsMode: 'NONE',
        tdsFlatPercent: null,
      },
      overtime: { multiplier: '1.5', basis: 'BASIC' },
      varianceThresholdPercent: 10,
    };

    await db.insert(payrollPolicyVersions).values({
      orgId: ORG_A,
      policyId: policy.id,
      version: 1,
      toggles,
      config,
      status: 'ACTIVE',
      effectiveFrom: '2025-01-01',
    });

    const [lr] = await db
      .insert(payrollRuns)
      .values({ orgId: ORG_A, month: '2025-06', status: 'DRAFT', createdBy: USER_A })
      .returning({ id: payrollRuns.id });
    if (!lr) throw new Error('Locked run insert failed');
    lockedRunId = lr.id;

    const [dr] = await db
      .insert(payrollRuns)
      .values({ orgId: ORG_A, month: '2025-07', status: 'DRAFT', createdBy: USER_A })
      .returning({ id: payrollRuns.id });
    if (!dr) throw new Error('Draft run insert failed');
    draftRunId = dr.id;

    const snapshot: Record<string, unknown> = {
      computedAt: new Date().toISOString(),
      lines: [],
      totals: {
        gross: '50000.00',
        deductions: '0.00',
        employerContributions: '0.00',
        net: '50000.00',
      },
    };

    const [le] = await db
      .insert(payrollRunEmployees)
      .values({
        orgId: ORG_A,
        runId: lockedRunId,
        userId: USER_A,
        net: '50000.00',
        gross: '50000.00',
        currency: 'INR',
        calculationSnapshot: snapshot,
      })
      .returning({ id: payrollRunEmployees.id });
    if (!le) throw new Error('Locked emp insert failed');
    lockedEmpId = le.id;

    const [de] = await db
      .insert(payrollRunEmployees)
      .values({
        orgId: ORG_A,
        runId: draftRunId,
        userId: USER_A,
        net: '50000.00',
        gross: '50000.00',
        currency: 'INR',
        calculationSnapshot: snapshot,
      })
      .returning({ id: payrollRunEmployees.id });
    if (!de) throw new Error('Draft emp insert failed');
    draftEmpId = de.id;

    const calcExplain: Record<string, unknown> = { method: 'FIXED', inputs: {}, steps: [] };

    const [li] = await db
      .insert(payrollLineItems)
      .values({
        orgId: ORG_A,
        runId: lockedRunId,
        runEmployeeId: lockedEmpId,
        code: 'BASIC',
        name: 'Basic Salary',
        category: 'EARNING',
        amount: '50000.00',
        calcMethod: 'FIXED',
        calcExplain,
      })
      .returning({ id: payrollLineItems.id });
    if (!li) throw new Error('Line item insert failed');
    lockedLineItemId = li.id;

    await db
      .update(payrollRuns)
      .set({ status: 'LOCKED' })
      .where(eq(payrollRuns.id, lockedRunId));

    const [br] = await db
      .insert(payrollRuns)
      .values({ orgId: ORG_B, month: '2025-06', status: 'DRAFT', createdBy: USER_B })
      .returning({ id: payrollRuns.id });
    if (!br) throw new Error('Org B run insert failed');
    orgBRunId = br.id;

    await db.insert(employeeSalaryProfiles).values({
      orgId: ORG_B,
      userId: USER_B,
      annualCtc: '1200000.00',
      effectiveFrom: '2025-01-01',
    });
  }, 30_000);

  afterAll(async () => {
    await cleanupStaleData(db);

    const [remaining] = await db
      .select({ n: count() })
      .from(payrollRuns)
      .where(inArray(payrollRuns.orgId, [ORG_A, ORG_B]));
    expect(remaining?.n).toBe(0);

    await sql.end({ timeout: 5 });
  }, 30_000);

  describe('Scenario 1 — Idempotency replay', () => {
    it('returns the same batch on a second call with an identical idempotency key', async () => {
      const auditSvc = new AuditService(db);
      const storageSvc = new StorageService();
      const svc = new PayoutBatchesService(db, auditSvc, storageSvc);

      const idemKey = `${P}idem-key-001`;

      const first = await svc.createBatch(ORG_A, lockedRunId, USER_A, idemKey, undefined);
      const second = await svc.createBatch(ORG_A, lockedRunId, USER_A, idemKey, undefined);

      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.batch.id).toBe(first.batch.id);

      const [countRow] = await db
        .select({ n: count() })
        .from(payrollBankBatches)
        .where(and(
          eq(payrollBankBatches.orgId, ORG_A),
          eq(payrollBankBatches.runId, lockedRunId),
        ));
      expect(countRow?.n).toBe(1);
    }, 20_000);
  });

  describe('Scenario 2 — Snapshot immutability triggers', () => {
    it('rejects UPDATE of calculation_snapshot on a LOCKED run employee', async () => {
      await assertTriggerRejects(
        db
          .update(payrollRunEmployees)
          .set({ calculationSnapshot: { blocked: true } })
          .where(eq(payrollRunEmployees.id, lockedEmpId)),
      );
    });

    it('rejects UPDATE of net on a LOCKED run employee', async () => {
      await assertTriggerRejects(
        db
          .update(payrollRunEmployees)
          .set({ net: '99999.00' })
          .where(eq(payrollRunEmployees.id, lockedEmpId)),
      );
    });

    it('rejects INSERT of a line item on a LOCKED run', async () => {
      const calcExplain: Record<string, unknown> = { method: 'FIXED', inputs: {}, steps: [] };
      await assertTriggerRejects(
        db.insert(payrollLineItems).values({
          orgId: ORG_A,
          runId: lockedRunId,
          runEmployeeId: lockedEmpId,
          code: 'HRA',
          name: 'HRA',
          category: 'EARNING',
          amount: '10000.00',
          calcMethod: 'FIXED',
          calcExplain,
        }),
      );
    });

    it('rejects DELETE of a line item on a LOCKED run', async () => {
      await assertTriggerRejects(
        db.delete(payrollLineItems).where(eq(payrollLineItems.id, lockedLineItemId)),
      );
    });

    it('allows UPDATE of hold_reason (non-guarded column) on a LOCKED run employee', async () => {
      const result = await db
        .update(payrollRunEmployees)
        .set({ holdReason: 'on-hold for compliance review' })
        .where(eq(payrollRunEmployees.id, lockedEmpId));
      expect(result).toBeDefined();
    });

    it('allows UPDATE of calculation_snapshot on a DRAFT run employee', async () => {
      const result = await db
        .update(payrollRunEmployees)
        .set({ calculationSnapshot: { recalculated: true } })
        .where(eq(payrollRunEmployees.id, draftEmpId));
      expect(result).toBeDefined();
    });
  });

  describe('Scenario 3 — Cross-tenant isolation', () => {
    it('returns no rows for org B run queried with org A orgId', async () => {
      const rows = await db
        .select({ id: payrollRuns.id })
        .from(payrollRuns)
        .where(and(eq(payrollRuns.id, orgBRunId), eq(payrollRuns.orgId, ORG_A)));
      expect(rows).toHaveLength(0);
    });

    it('returns no run employees when org B runId is scoped to org A', async () => {
      const rows = await db
        .select({ id: payrollRunEmployees.id })
        .from(payrollRunEmployees)
        .where(and(
          eq(payrollRunEmployees.runId, orgBRunId),
          eq(payrollRunEmployees.orgId, ORG_A),
        ));
      expect(rows).toHaveLength(0);
    });

    it('returns no bank batches when org B runId is scoped to org A', async () => {
      const rows = await db
        .select({ id: payrollBankBatches.id })
        .from(payrollBankBatches)
        .where(and(
          eq(payrollBankBatches.runId, orgBRunId),
          eq(payrollBankBatches.orgId, ORG_A),
        ));
      expect(rows).toHaveLength(0);
    });

    it('returns no salary profiles for org B employee queried with org A orgId', async () => {
      const rows = await db
        .select({ id: employeeSalaryProfiles.id })
        .from(employeeSalaryProfiles)
        .where(and(
          eq(employeeSalaryProfiles.userId, USER_B),
          eq(employeeSalaryProfiles.orgId, ORG_A),
        ));
      expect(rows).toHaveLength(0);
    });
  });
});
