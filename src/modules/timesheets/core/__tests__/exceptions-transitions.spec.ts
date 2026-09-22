import { ConflictException, NotFoundException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { REQUIRE_PERMISSION } from "../../../access/require-permission.decorator";
import { organizationMembers, timerSessions, timesheetExceptions, timesheetPeriods, timesheetSettings, timesheets } from "../../../../db/schema";
import { ExceptionsDetectorService } from "../exceptions-detector.service";
import { TimesheetExceptionsService } from "../exceptions.service";
import { TimesheetExceptionsController } from "../exceptions.controller";
import type { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { Db } from "../../../../db/drizzle.module";
import type { TimesheetsAuditService } from "../timesheets-audit.service";

const ACTOR = {
  userId: "usr-approver",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(7, false),
} as unknown as CurrentUserContext;

const OPEN_ROW = {
  id: 7,
  orgId: "org-1",
  userMembershipId: 21,
  ownerMembershipId: 21,
  rule: "MISSING_TIMESHEET",
  severity: "ERROR",
  status: "OPEN",
  resolutionReason: null,
  resolvedByMembershipId: null,
  resolvedAt: null,
};

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
      const service = new TimesheetExceptionsService(d.db, access, d.audit);

      const result = await service.resolveException(ACTOR, 7, {
        reason: "Worker was on approved leave",
      });

      expect(result).toMatchObject({ status: "RESOLVED" });
      expect(d.updates).toHaveLength(1);
      expect(d.updates[0]).toMatchObject({
        status: "RESOLVED",
        resolutionReason: "Worker was on approved leave",
        resolvedByMembershipId: 7,
      });
      expect(d.updates[0].resolvedAt).toBeInstanceOf(Date);
      expect(d.updates[0].updatedAt).toBeInstanceOf(Date);
    });

    it("records the transition in the timesheets audit chain", async () => {
      const d = transitionDouble({
        existing: [OPEN_ROW],
        updated: [{ ...OPEN_ROW, status: "RESOLVED" }],
      });
      const service = new TimesheetExceptionsService(d.db, access, d.audit);

      await service.resolveException(ACTOR, 7, { reason: "Corrected upstream" });

      expect(d.auditCalls).toHaveLength(1);
      expect(d.auditCalls[0]).toEqual({
        orgId: "org-1",
        actorMembershipId: 7,
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
      const service = new TimesheetExceptionsService(d.db, access, d.audit);

      await service.dismissException(ACTOR, 7, { reason: "Not a real gap" });

      expect(d.updates[0]).toMatchObject({
        status: "DISMISSED",
        resolutionReason: "Not a real gap",
        resolvedByMembershipId: 7,
      });
      expect(d.auditCalls[0]).toMatchObject({ action: "exception.dismissed" });
    });
  });

  describe("an exception that is not open", () => {
    it("409s a resolve on an already-resolved exception, and writes nothing", async () => {
      const d = transitionDouble({
        existing: [{ ...OPEN_ROW, status: "RESOLVED" }],
      });
      const service = new TimesheetExceptionsService(d.db, access, d.audit);

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
      const service = new TimesheetExceptionsService(d.db, access, d.audit);

      await expect(
        service.dismissException(ACTOR, 7, { reason: "again" }),
      ).rejects.toThrow("Only open exceptions can be dismissed");
    });

    it("409s when the row is resolved between the read and the update", async () => {
      const d = transitionDouble({ existing: [OPEN_ROW], updated: [] });
      const service = new TimesheetExceptionsService(d.db, access, d.audit);

      await expect(
        service.resolveException(ACTOR, 7, { reason: "lost the race" }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(d.updates).toHaveLength(1);
      expect(d.auditCalls).toHaveLength(0);
    });
  });

  describe("tenancy", () => {
    it("404s rather than 403s when the id belongs to another organisation", async () => {
      const d = transitionDouble({ existing: [] });
      const service = new TimesheetExceptionsService(d.db, access, d.audit);

      await expect(
        service.resolveException(ACTOR, 999, { reason: "probe" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(d.updates).toHaveLength(0);
    });

    it("scopes both the read and the write by org_id", async () => {
      const d = transitionDouble({
        existing: [OPEN_ROW],
        updated: [{ ...OPEN_ROW, status: "RESOLVED" }],
      });
      const service = new TimesheetExceptionsService(d.db, access, d.audit);

      await service.resolveException(ACTOR, 7, { reason: "fine" });

      expect(columnsIn(d.selectWhere[0])).toContain("org_id");
      expect(columnsIn(d.updateWhere[0])).toContain("org_id");
      expect(columnsIn(d.updateWhere[0])).toContain("status");
    });
  });

  describe("who is allowed", () => {
    const permissionOn = (handler: unknown) =>
      Reflect.getMetadata(REQUIRE_PERMISSION, handler as object) as string | undefined;

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

    it("gates the reads on the view key instead", () => {
      const c = TimesheetExceptionsController.prototype;
      expect(permissionOn(c.list)).toBe("timesheets:exceptions:view");
      expect(permissionOn(c.summary)).toBe("timesheets:exceptions:view");
    });
  });

  describe("run-detection", () => {
    it("scans the caller's own organisation and nothing else", async () => {
      const scanned: string[] = [];
      const detector = {
        detectForOrg: (orgId: string) => {
          scanned.push(orgId);
          return Promise.resolve({ week: { start: "", end: "" }, candidates: 0, created: 0 });
        },
      } as unknown as ExceptionsDetectorService;
      const controller = new TimesheetExceptionsController(
        {} as unknown as TimesheetExceptionsService,
        detector,
      );

      await controller.runDetection(ACTOR);

      expect(scanned).toEqual(["org-1"]);
    });
  });

  describe("detector idempotence", () => {
    function detectorDouble(insertReturning: unknown[]) {
      const inserted: unknown[][] = [];
      const queues = new Map<unknown, unknown[][]>([
        [timesheetSettings, [[]]],
        [timesheetPeriods, [[]]],
        [
          timesheets,
          [
            [],
            [],
            [],
          ],
        ],
        [
          organizationMembers,
          [[{ id: 1, userId: "usr-a" }, { id: 2, userId: "usr-b" }, { id: 1, userId: "usr-a" }]],
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
      const { db, inserted } = detectorDouble([{ id: 1 }, { id: 2 }]);
      const service = new ExceptionsDetectorService(db);

      const result = await service.detectForOrg("org-1");

      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toHaveLength(2);
      expect(result.candidates).toBe(2);
    });

    it("reports created from what the insert returned, so a re-run creates nothing", async () => {
      const { db } = detectorDouble([]);
      const service = new ExceptionsDetectorService(db);

      const result = await service.detectForOrg("org-1");

      expect(result.candidates).toBe(2);
      expect(result.created).toBe(0);
    });
  });
});
