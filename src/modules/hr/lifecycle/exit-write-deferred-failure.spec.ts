process.env.APP_URL ??= "http://localhost:1000";

import { Logger } from "@nestjs/common";
import { ExitWriteService } from "./exit-write.service";
import { TenantContextService, registerAfterCommit } from "../../../common/tenant/tenant-context";
import type { AfterCommitHook } from "../../../common/tenant/tenant-context";

/**
 * Every exit-lifecycle side effect used to be `void (async () => …)().catch(() => undefined)`:
 * it ran on `this.db` while the request transaction was still open, and its rejection was
 * discarded. A resignation notification that never reached the employee, an automation that
 * never fired, and an exit checklist that was never seeded all left no trace anywhere — the
 * exact shape CLAUDE.md §4 records as having produced zero notification rows platform-wide.
 *
 * Two properties are asserted: the work is deferred through `registerAfterCommit` when there
 * is an ambient tenant context, and its failure is reported — never swallowed — on the
 * inline path taken when there is not.
 */

const ORG_ID = "org-exit";
const RESIGNATION_ID = 42;

function buildDb() {
  const tx = {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ rowVersion: 2 }]),
        }),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockResolvedValue([]),
      }),
    }),
  };
  return {
    query: {
      resignations: {
        findFirst: jest.fn().mockResolvedValue({
          id: RESIGNATION_ID,
          orgId: ORG_ID,
          userId: "user-1",
          status: "HR_APPROVED",
          lastWorkingDate: "2026-08-01",
          rowVersion: 1,
        }),
      },
      users: { findFirst: jest.fn().mockResolvedValue({ name: "Test Employee" }) },
    },
    ...tx,
    transaction: jest.fn(async (callback: (t: typeof tx) => Promise<unknown>) => callback(tx)),
  };
}

function build(seedChecklist: jest.Mock) {
  const db = buildDb();
  return new ExitWriteService(
    db as never,
    { emit: jest.fn().mockResolvedValue(undefined) } as never,
    { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) } as never,
    { emit: jest.fn().mockResolvedValue(undefined) } as never,
    { notifyFinalDecision: jest.fn(), notifyHrApproved: jest.fn() } as never,
    { seedChecklistFromTemplate: seedChecklist } as never,
    undefined as never,
    undefined as never,
    { membersWithPermission: jest.fn().mockResolvedValue([]) } as never,
  );
}

function approve(service: ExitWriteService) {
  return service.update(
    ORG_ID,
    { userId: "actor-1", membershipId: 1, role: "ADMIN", isApprover: true },
    RESIGNATION_ID,
    { status: "FINAL_APPROVED", remarks: "ok" },
  );
}

describe("ExitWriteService deferred side effects", () => {
  it("defers exit-checklist seeding to after commit instead of racing the open transaction", async () => {
    const seedChecklist = jest.fn().mockResolvedValue(undefined);
    const service = build(seedChecklist);
    const hooks: AfterCommitHook[] = [];
    const tenant = new TenantContextService();

    await tenant.run({ orgId: ORG_ID, afterCommit: hooks } as never, async () => {
      expect(registerAfterCommit(() => Promise.resolve())).toBe(true);
      hooks.length = 0;
      await approve(service);
    });

    expect(seedChecklist).not.toHaveBeenCalled();
    expect(hooks.length).toBeGreaterThanOrEqual(1);

    for (const hook of hooks) await hook();
    expect(seedChecklist).toHaveBeenCalledWith(ORG_ID, RESIGNATION_ID);
  });

  it("reports a deferred failure on the inline path rather than discarding it", async () => {
    const seedChecklist = jest.fn().mockRejectedValue(new Error("checklist template missing"));
    const service = build(seedChecklist);
    const reported = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    try {
      await approve(service);
      await new Promise((resolve) => setImmediate(resolve));

      expect(seedChecklist).toHaveBeenCalledWith(ORG_ID, RESIGNATION_ID);
      const messages = reported.mock.calls.map((call) => String(call[0]));
      expect(messages.some((m) => m.includes("checklist template missing"))).toBe(true);
      expect(messages.some((m) => m.includes(ORG_ID))).toBe(true);
    } finally {
      reported.mockRestore();
    }
  });
});
