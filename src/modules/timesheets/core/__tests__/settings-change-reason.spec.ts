import { BadRequestException } from "@nestjs/common";
import { SettingsService } from "../settings.service";
import type { Db } from "../../../../db/drizzle.module";
import type { CacheService } from "../../../../common/cache/cache.service";
import type { TimesheetsAuditService } from "../timesheets-audit.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { updateCoreSettingsSchema, type UpdateCoreSettingsInput } from "../dto/settings.schemas";

/**
 * TS-16. When a settings change has to be justified, and when demanding a
 * justification would be noise.
 *
 * The history table has carried a nullable `change_reason` since it shipped and
 * nothing ever required it, so it is full of nulls for changes nobody can now
 * explain. Requiring a reason is easy; requiring it *only when it means
 * something* is the part worth testing, because a rule that fires on every save
 * teaches people to type a full stop, and then the column is full of full stops
 * instead of nulls.
 */

const STORED = {
  orgId: "org-1",
  workWeekStart: 1,
  maxHoursPerDay: "24.00",
  expectedDailyHours: "8.00",
  lockAfterApproval: true,
  approvalMode: "MANAGER",
  submissionGraceDays: 5,
  autoDraftFromAttendance: false,
  reminderRules: { enabled: true, remindBeforeDueDays: [2], remindAfterDueDays: [1] },
  requiredFields: ["description"],
};

/**
 * Answers both chains `updateSettings` builds. The awkward part is that
 * `.limit(1)` is awaited directly in one place and has `.for("update")` called
 * on it in another, so the stub returns a thenable that is also chainable —
 * which is exactly what the query builder is.
 */
function stubDb() {
  const updates: Array<Record<string, unknown>> = [];

  function thenableRows<T>(rows: T[]) {
    const p = Promise.resolve(rows) as Promise<T[]> & { for: () => Promise<T[]> };
    p.for = async () => rows;
    return p;
  }

  function reader() {
    return {
      from: () => ({
        where: () => ({
          limit: () => thenableRows([STORED]),
          orderBy: () => ({ limit: () => thenableRows([{ version: 3 }]) }),
        }),
      }),
    };
  }

  const tx = {
    select: reader,
    insert: () => ({ values: async () => undefined }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push(values);
        },
      }),
    }),
  };

  const db = {
    select: reader,
    insert: () => ({ values: () => ({ returning: async () => [STORED] }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push(values);
        },
      }),
    }),
    transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as Db;

  return { db, updates };
}

const cache = {
  cachedVersioned: async (_ns: string, _k: string, fn: () => Promise<unknown>) => fn(),
  invalidateNamespace: async () => undefined,
} as unknown as CacheService;

const audit = { record: async () => undefined } as unknown as TimesheetsAuditService;

const USER = { orgId: "org-1", userId: "usr-1" } as unknown as CurrentUserContext;

function service() {
  const { db, updates } = stubDb();
  return { svc: new SettingsService(db, cache, audit), updates };
}

const update = (input: Partial<UpdateCoreSettingsInput>) => input as UpdateCoreSettingsInput;

describe("SettingsService material-change reason", () => {
  it("refuses a material change with no reason, and names the field", async () => {
    const { svc } = service();

    await expect(svc.updateSettings(USER, update({ maxHoursPerDay: 12 }))).rejects.toThrow(
      BadRequestException,
    );
    await expect(svc.updateSettings(USER, update({ maxHoursPerDay: 12 }))).rejects.toThrow(
      /maxHoursPerDay/,
    );
  });

  it("names every material field that changed, so the dialog can say which", async () => {
    const { svc } = service();

    await expect(
      svc.updateSettings(USER, update({ maxHoursPerDay: 12, lockAfterApproval: false })),
    ).rejects.toThrow(/lockAfterApproval, maxHoursPerDay/);
  });

  it("accepts a material change that carries a reason", async () => {
    const { svc } = service();

    await expect(
      svc.updateSettings(USER, update({ maxHoursPerDay: 12, changeReason: "Site policy change" })),
    ).resolves.toBeDefined();
  });

  it("rejects whitespace as a reason", async () => {
    const { svc } = service();

    await expect(
      svc.updateSettings(USER, update({ maxHoursPerDay: 12, changeReason: "   " })),
    ).rejects.toThrow(BadRequestException);
  });

  /**
   * The case that decides whether the requirement is respected or worked
   * around. A settings screen PATCHes the whole form, so most saves resend
   * values that did not change — demanding a reason for those would make the
   * dialog appear on every save, including ones that alter nothing.
   */
  it("allows a save that resends a material field at its stored value", async () => {
    const { svc } = service();

    await expect(svc.updateSettings(USER, update({ maxHoursPerDay: 24 }))).resolves.toBeDefined();
  });

  /**
   * `expectedDailyHours` is a `decimal`, so it comes back "8.00" while the
   * client sends `8`. A string comparison would call that a change and demand a
   * justification for a no-op.
   */
  it("does not mistake a decimal column's string form for a change", async () => {
    const { svc } = service();

    await expect(svc.updateSettings(USER, update({ expectedDailyHours: 8 }))).resolves.toBeDefined();
  });

  it("lets a reminder-cadence change through without a reason", async () => {
    const { svc } = service();

    await expect(
      svc.updateSettings(
        USER,
        update({
          reminderRules: { enabled: true, remindBeforeDueDays: [3], remindAfterDueDays: [1, 5] },
        }),
      ),
    ).resolves.toBeDefined();
  });

  /**
   * Turning this on starts writing rows into other people's timesheets, which
   * is as material as a policy change gets.
   */
  it("treats the attendance auto-draft flag as material", async () => {
    const { svc } = service();

    await expect(
      svc.updateSettings(USER, update({ autoDraftFromAttendance: true })),
    ).rejects.toThrow(/autoDraftFromAttendance/);
  });

  it("treats who approves timesheets as material", async () => {
    const { svc } = service();

    await expect(
      svc.updateSettings(USER, update({ approverSource: "PROJECT_MANAGER" })),
    ).rejects.toThrow(/approverSource/);
  });
});

describe("updateCoreSettingsSchema approval fields", () => {
  it("offers only the two approval modes the product has, so multi-level cannot be switched on before it exists", () => {
    expect(updateCoreSettingsSchema.safeParse({ approvalMode: "MULTI_LEVEL" }).success).toBe(false);
    expect(updateCoreSettingsSchema.safeParse({ approvalMode: "MANAGER" }).success).toBe(true);
    expect(updateCoreSettingsSchema.safeParse({ approvalMode: "AUTO" }).success).toBe(true);
  });

  it("accepts the reporting-manager default and the project-manager override, nothing else", () => {
    expect(updateCoreSettingsSchema.safeParse({ approverSource: "REPORTING_MANAGER" }).success).toBe(true);
    expect(updateCoreSettingsSchema.safeParse({ approverSource: "PROJECT_MANAGER" }).success).toBe(true);
    expect(updateCoreSettingsSchema.safeParse({ approverSource: "TEAM_LEAD" }).success).toBe(false);
  });
});
