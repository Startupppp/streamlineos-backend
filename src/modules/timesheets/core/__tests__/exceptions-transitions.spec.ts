import { ConflictException, NotFoundException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { REQUIRE_PERMISSION } from "../../../access/require-permission.decorator";
import { organizationMembers, timerSessions, timesheetExceptions, timesheetPeriods, timesheetSettings, timesheets } from "../../../../db/schema";
import { ExceptionsDetectorService } from "../exceptions-detector.service";
import { ExceptionsService } from "../exceptions.service";
import { TimesheetExceptionsController } from "../exceptions.controller";
import type { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.module";
import type { TimesheetsAuditService } from "../timesheets-audit.service";

/**
 * TS-21. Resolve, dismiss, and run-detection.
 *
 * The exception *detector's* window arithmetic has had a spec since TS-11
 * (`lib/exception-window.spec.ts`) and the queue's filters are exercised by the
 * scope spec. What nothing touched is the three things an approver actually
 * does to an exception, and each of them has a way of going wrong that is
 * invisible from the endpoint:
 *
 *   - **What changes on the row.** `resolvedBy` is the actor, not the person
 *     the exception is about — `timesheet_exceptions` carries both `user_id`
 *     and `owner_user_id`, and writing the wrong one produces an audit trail
 *     that says the worker cleared their own flag.
 *   - **Who is allowed.** `PermissionGuard` is not a global guard in this
 *     codebase, so `@RequirePermission` on a handler whose controller does not
 *     mount the guard is decoration. Both halves are asserted, on the real
 *     class.
 *   - **An already-resolved exception.** The status is checked twice, and the
 *     second check is the one that matters: the UPDATE re-asserts
 *     `status = 'OPEN'` in its own predicate, so two approvers clicking at once
 *     produce one resolution and one 409 rather than a silent last-writer-wins
 *     that overwrites the first reason.
 */

const ACTOR = {
  userId: "usr-approver",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
} as unknown as CurrentUserContext;

const OPEN_ROW = {
  id: 7,
  orgId: "org-1",
  userId: "usr-worker",
  ownerUserId: "usr-worker",
  rule: "MISSING_TIMESHEET",
  severity: "ERROR",
  status: "OPEN",
  resolutionReason: null,
  resolvedBy: null,
  resolvedAt: null,
};

/**
 * Walks a Drizzle `SQL` tree and collects the column names it references.
 *
 * Used for one assertion only: that the tenant predicate is present on both the
 * read and the write. It fails closed — if the internal shape ever changes,
 * this returns nothing and the expectation fails rather than quietly passing.
 */
function columnsIn(node: unknown, found: string[] = []): string[] {
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const child of node) columnsIn(child, found);
    return found;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.name === "string" && obj.table !== undefined) found.push(obj.name);
  if (obj.queryChunks) columnsIn(obj.queryChunks, found);
  return found;
}

interface TransitionDouble {
  db: Db;
  audit: TimesheetsAuditService;
  auditCalls: Record<string, unknown>[];
  updates: Record<string, unknown>[];
  selectWhere: unknown[];
  updateWhere: unknown[];
}

function transitionDouble(opts: {
  existing?: Record<string, unknown>[];
  updated?: Record<string, unknown>[];
}): TransitionDouble {
  const updates: Record<string, unknown>[] = [];
  const selectWhere: unknown[] = [];
  const updateWhere: unknown[] = [];
  const auditCalls: Record<string, unknown>[] = [];

  const db = {
    select: () => ({
      from: () => ({
        where: (w: unknown) => {
          selectWhere.push(w);
          return { limit: () => Promise.resolve(opts.existing ?? []) };
        },
      }),
    }),
    update: () => ({
      set: (vals: Record<string, unknown>) => {
        updates.push(vals);
        return {
          where: (w: unknown) => {
            updateWhere.push(w);
            return { returning: () => Promise.resolve(opts.updated ?? []) };
          },
        };
      },
    }),
  } as unknown as Db;

  const audit = {
    recordWithDb: (params: Record<string, unknown>) => {
      auditCalls.push(params);
      return Promise.resolve();
    },
  } as unknown as TimesheetsAuditService;

  return { db, audit, auditCalls, updates, selectWhere, updateWhere };
}

const access = {} as unknown as AccessService;

describe("TS-21 exception transitions", () => {
  describe("resolve", () => {
    it("stamps the actor, the reason and the time onto the row", async () => {
      const d = transitionDouble({
        existing: [OPEN_ROW],
        updated: [{ ...OPEN_ROW, status: "RESOLVED" }],
      });
      const service = new ExceptionsService(d.db, access, d.audit);

      const result = await service.resolveException(ACTOR, 7, {
        reason: "Worker was on approved leave",
      });

      expect(result).toMatchObject({ status: "RESOLVED" });
      expect(d.updates).toHaveLength(1);
      expect(d.updates[0]).toMatchObject({
        status: "RESOLVED",
        resolutionReason: "Worker was on approved leave",
        /** The approver clearing it, never `OPEN_ROW.userId`. */
        resolvedBy: "usr-approver",
      });
      expect(d.updates[0].resolvedAt).toBeInstanceOf(Date);
      expect(d.updates[0].updatedAt).toBeInstanceOf(Date);
    });

    it("records the transition in the timesheets audit chain", async () => {
      const d = transitionDouble({
        existing: [OPEN_ROW],
        updated: [{ ...OPEN_ROW, status: "RESOLVED" }],
      });
      const service = new ExceptionsService(d.db, access, d.audit);

      await service.resolveException(ACTOR, 7, { reason: "Corrected upstream" });

      expect(d.auditCalls).toHaveLength(1);
      expect(d.auditCalls[0]).toEqual({
        orgId: "org-1",
        actorUserId: "usr-approver",
        entityType: "exception",
        entityId: "7",
        action: "exception.resolved",
        reason: "Corrected upstream",
        before: { status: "OPEN" },
        after: { status: "RESOLVED" },
      });
    });
  });

  describe("dismiss", () => {
    it("is a distinct terminal status with its own audit action", async () => {
      const d = transitionDouble({
        existing: [OPEN_ROW],
        updated: [{ ...OPEN_ROW, status: "DISMISSED" }],
      });
      const service = new ExceptionsService(d.db, access, d.audit);

      await service.dismissException(ACTOR, 7, { reason: "Not a real gap" });

      expect(d.updates[0]).toMatchObject({
        status: "DISMISSED",
        resolutionReason: "Not a real gap",
        resolvedBy: "usr-approver",
      });
      expect(d.auditCalls[0]).toMatchObject({ action: "exception.dismissed" });
    });
  });

  describe("an exception that is not open", () => {
    /**
     * The read-side check. A resolved exception is not resolvable again, and
     * the verb in the message follows the transition being attempted so the
     * caller is told what they tried to do.
     */
    it("409s a resolve on an already-resolved exception, and writes nothing", async () => {
      const d = transitionDouble({
        existing: [{ ...OPEN_ROW, status: "RESOLVED" }],
      });
      const service = new ExceptionsService(d.db, access, d.audit);

      const attempt = service.resolveException(ACTOR, 7, { reason: "again" });

      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toThrow("Only open exceptions can be resolved");
      expect(d.updates).toHaveLength(0);
      expect(d.auditCalls).toHaveLength(0);
    });

    it("409s a dismiss on a dismissed exception with the dismissing verb", async () => {
      const d = transitionDouble({
        existing: [{ ...OPEN_ROW, status: "DISMISSED" }],
      });
      const service = new ExceptionsService(d.db, access, d.audit);

      await expect(
        service.dismissException(ACTOR, 7, { reason: "again" }),
      ).rejects.toThrow("Only open exceptions can be dismissed");
    });

    /**
     * The write-side check, which is the one a race reaches. The row read as
     * OPEN, another approver resolved it, and the UPDATE's own
     * `status = 'OPEN'` predicate matches nothing — so this must 409 rather
     * than return an undefined row or overwrite the first approver's reason.
     */
    it("409s when the row is resolved between the read and the update", async () => {
      const d = transitionDouble({ existing: [OPEN_ROW], updated: [] });
      const service = new ExceptionsService(d.db, access, d.audit);

      await expect(
        service.resolveException(ACTOR, 7, { reason: "lost the race" }),
      ).rejects.toBeInstanceOf(ConflictException);
      /** The UPDATE ran; the audit row must not, or history gains a lie. */
      expect(d.updates).toHaveLength(1);
      expect(d.auditCalls).toHaveLength(0);
    });
  });

  describe("tenancy", () => {
    /**
     * Another organisation's exception id is a miss, and a miss is 404. A 403
     * here would confirm the row exists and turn the endpoint into an existence
     * oracle for every other tenant's exception ids.
     */
    it("404s rather than 403s when the id belongs to another organisation", async () => {
      const d = transitionDouble({ existing: [] });
      const service = new ExceptionsService(d.db, access, d.audit);

      await expect(
        service.resolveException(ACTOR, 999, { reason: "probe" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(d.updates).toHaveLength(0);
    });

    /** And the reason that miss happens: `org_id` is in both predicates. */
    it("scopes both the read and the write by org_id", async () => {
      const d = transitionDouble({
        existing: [OPEN_ROW],
        updated: [{ ...OPEN_ROW, status: "RESOLVED" }],
      });
      const service = new ExceptionsService(d.db, access, d.audit);

      await service.resolveException(ACTOR, 7, { reason: "fine" });

      expect(columnsIn(d.selectWhere[0])).toContain("org_id");
      expect(columnsIn(d.updateWhere[0])).toContain("org_id");
      /** And the status guard that makes the race above a 409. */
      expect(columnsIn(d.updateWhere[0])).toContain("status");
    });
  });

  describe("who is allowed", () => {
    const permissionOn = (handler: unknown) =>
      Reflect.getMetadata(REQUIRE_PERMISSION, handler as object) as string | undefined;

    /**
     * `PermissionGuard` is not a global `APP_GUARD`. Without it on the class,
     * every `@RequirePermission` below is a comment.
     */
    it("mounts both guards on the controller", () => {
      const guards: unknown[] =
        Reflect.getMetadata(GUARDS_METADATA, TimesheetExceptionsController) ?? [];
      expect(guards).toContain(JwtAuthGuard);
      expect(guards).toContain(PermissionGuard);
    });

    it("gates the three write transitions on exceptions:manage", () => {
      const c = TimesheetExceptionsController.prototype;
      expect(permissionOn(c.resolve)).toBe("timesheets:exceptions:manage");
      expect(permissionOn(c.dismiss)).toBe("timesheets:exceptions:manage");
      expect(permissionOn(c.runDetection)).toBe("timesheets:exceptions:manage");
    });

    /** Reading the queue is a weaker standing than clearing something off it. */
    it("gates the reads on the view key instead", () => {
      const c = TimesheetExceptionsController.prototype;
      expect(permissionOn(c.list)).toBe("timesheets:exceptions:view");
      expect(permissionOn(c.summary)).toBe("timesheets:exceptions:view");
    });
  });

  describe("run-detection", () => {
    /**
     * The route takes no body and no org. It scans the caller's organisation
     * because that is the only organisation it can name — there is nothing a
     * client could send that would point it at another tenant.
     */
    it("scans the caller's own organisation and nothing else", async () => {
      const scanned: string[] = [];
      const detector = {
        detectForOrg: (orgId: string) => {
          scanned.push(orgId);
          return Promise.resolve({ week: { start: "", end: "" }, candidates: 0, created: 0 });
        },
      } as unknown as ExceptionsDetectorService;
      const controller = new TimesheetExceptionsController(
        {} as unknown as ExceptionsService,
        detector,
      );

      await controller.runDetection(ACTOR);

      expect(scanned).toEqual(["org-1"]);
    });
  });

  /**
   * The half of run-detection that makes it safe to press twice.
   *
   * The route is a button an approver can hit repeatedly, and the only thing
   * standing between that and a queue full of duplicates is a partial unique
   * index on (org, user, rule, period, entry) WHERE status = 'OPEN' plus
   * `onConflictDoNothing()`. Two properties follow, and both are asserted from
   * the outside because neither is visible in the response otherwise:
   * the batch is deduped on the *same* key before it is sent, so a multi-row
   * insert cannot conflict with itself; and `created` counts the rows the
   * database actually returned, not the candidates offered to it.
   */
  describe("detector idempotence", () => {
    function detectorDouble(insertReturning: unknown[]) {
      const inserted: unknown[][] = [];
      const queues = new Map<unknown, unknown[][]>([
        [timesheetSettings, [[]]],
        [timesheetPeriods, [[]]],
        [
          timesheets,
          [
            [], // entry counts
            [], // daily totals
            [], // missing-rate entries
          ],
        ],
        [
          organizationMembers,
          [[{ userId: "usr-a" }, { userId: "usr-b" }, { userId: "usr-a" }]],
        ],
        [timerSessions, [[]]],
      ]);

      const chain = () => {
        let table: unknown = null;
        const node: Record<string, unknown> = {};
        for (const m of ["leftJoin", "innerJoin", "where", "groupBy", "orderBy", "limit", "offset"]) {
          node[m] = () => node;
        }
        node.from = (t: unknown) => {
          table = t;
          return node;
        };
        node.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => {
          const q = queues.get(table) ?? [];
          const rows = q.length > 1 ? q.shift()! : (q[0] ?? []);
          return Promise.resolve(rows).then(ok, err);
        };
        return node;
      };

      const db = {
        select: () => chain(),
        insert: () => ({
          values: (rows: unknown[]) => {
            inserted.push(rows);
            return {
              onConflictDoNothing: () => ({
                returning: () => Promise.resolve(insertReturning),
              }),
            };
          },
        }),
      } as unknown as Db;

      return { db, inserted };
    }

    it("dedupes the batch on the unique index's own key before inserting", async () => {
      /** `usr-a` appears twice in the member list; one candidate must survive. */
      const { db, inserted } = detectorDouble([{ id: 1 }, { id: 2 }]);
      const service = new ExceptionsDetectorService(db);

      const result = await service.detectForOrg("org-1");

      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toHaveLength(2);
      expect(result.candidates).toBe(2);
    });

    /**
     * The second press. Every candidate collides with an open exception, the
     * insert returns nothing, and the honest answer is `created: 0` — not the
     * candidate count, which would report work that never happened.
     */
    it("reports created from what the insert returned, so a re-run creates nothing", async () => {
      const { db } = detectorDouble([]);
      const service = new ExceptionsDetectorService(db);

      const result = await service.detectForOrg("org-1");

      expect(result.candidates).toBe(2);
      expect(result.created).toBe(0);
    });
  });
});
