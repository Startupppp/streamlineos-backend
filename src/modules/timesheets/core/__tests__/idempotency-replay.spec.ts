import {
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
  type CallHandler,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { defer, firstValueFrom } from "rxjs";
import {
  IDEMPOTENCY_COMMAND,
  IDEMPOTENCY_OPTIONAL,
} from "../../../../common/idempotency/idempotency.constants";
import { IdempotencyInterceptor } from "../../../../common/idempotency/idempotency.interceptor";
import { DrizzleCommandFenceStore } from "../../../../common/idempotency/command-fence-store";
import { TimesheetApprovalsController as ApprovalsController } from "../approvals.controller";
import { EntriesController } from "../entries.controller";
import { TimesheetPeriodsController as PeriodsController } from "../periods.controller";
import { TimerController } from "../timer.controller";
import type { AttendanceDraftService } from "../attendance/attendance-draft.service";
import type { EntriesService } from "../entries.service";
import type { TimerService } from "../timer.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.module";
import type { CreateEntryInput } from "../dto/entries.schemas";

const ORG = "org-ts17";

const USER = {
  userId: "usr-worker",
  orgId: ORG,
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
} as unknown as CurrentUserContext;

const ENTRY_BODY = {
  date: "2026-09-07",
  hours: "3.5",
  description: "Wrote the spec that was missing",
} as unknown as CreateEntryInput;

interface FenceRow {
  commandFenceId: number;
  organizationId: string;
  audience: string;
  idempotencyKey: string;
  commandName: string;
  requestHash: string;
  principalId: string;
  status: string;
  responseBody: unknown;
  responseStatus: number | null;
  leaseExpiresAt: Date;
  expiresAt: Date;
  createdAt: Date;
}

function makeFenceStore() {
  const rows: FenceRow[] = [];
  let nextId = 1;
  let lookup: Pick<
    FenceRow,
    "organizationId" | "audience" | "idempotencyKey"
  > | null = null;

  const find = () =>
    lookup
      ? rows.find(
          (r) =>
            r.organizationId === lookup!.organizationId &&
            r.audience === lookup!.audience &&
            r.idempotencyKey === lookup!.idempotencyKey,
        )
      : undefined;

  const db: Record<string, unknown> = {
    transaction: (body: (handle: unknown) => Promise<unknown>) => body(db),
    execute: () => Promise.resolve([]),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        lookup = {
          organizationId: v.organizationId as string,
          audience: v.audience as string,
          idempotencyKey: v.idempotencyKey as string,
        };
        return {
          onConflictDoNothing: () => ({
            returning: () => {
              if (find()) return Promise.resolve([]);
              const row = { commandFenceId: nextId++, createdAt: new Date(), ...v } as FenceRow;
              row.responseBody = row.responseBody ?? null;
              row.responseStatus = row.responseStatus ?? null;
              rows.push(row);
              return Promise.resolve([{ fenceId: row.commandFenceId }]);
            },
          }),
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            const row = find();
            return Promise.resolve(row ? [row] : []);
          },
        }),
      }),
    }),
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: () => {
          const row = find();
          if (row) Object.assign(row, vals);
          const result: Promise<undefined> & {
            returning?: () => Promise<Array<{ fenceId: number }>>;
          } = Promise.resolve(undefined);
          result.returning = () =>
            Promise.resolve(row ? [{ fenceId: row.commandFenceId }] : []);
          return result;
        },
      }),
    }),
  };

  return { db: db as unknown as Db, rows };
}

function makeCtx(
  handler: (...args: never[]) => unknown,
  controllerClass: unknown,
  req: unknown,
  res: unknown = { statusCode: 200, status: jest.fn() },
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => controllerClass,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

function request(
  key: string | undefined,
  body: unknown,
  params: Record<string, string> = {},
) {
  return {
    headers: key === undefined ? {} : { "idempotency-key": key },
    params,
    body,
    user: USER,
  };
}

function callHandler(run: () => Promise<unknown>): CallHandler {
  const handle = jest.fn(() => defer(run));
  return { handle } as unknown as CallHandler;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function entriesControllerWithStore() {
  const created: CreateEntryInput[] = [];
  const entries = {
    createEntry: (_u: CurrentUserContext, input: CreateEntryInput) => {
      created.push(input);
      return Promise.resolve({ id: created.length, date: input.date });
    },
  } as unknown as EntriesService;
  const drafts = {} as unknown as AttendanceDraftService;
  return { controller: new EntriesController(entries, drafts), created };
}

describe("TS-17 timesheets idempotency", () => {
  describe("what is fenced, and by which mechanism", () => {
    const reflector = new Reflector();

    const fenceOn = (handler: unknown, cls: unknown) => ({
      command: reflector.getAllAndOverride<string | undefined>(
        IDEMPOTENCY_COMMAND,
        [handler, cls] as never,
      ),
      optional: reflector.getAllAndOverride<boolean | undefined>(
        IDEMPOTENCY_OPTIONAL,
        [handler, cls] as never,
      ),
    });

    it("fences all seven entry and timer writes, every one of them optional", () => {
      const entries = EntriesController.prototype;
      const timer = TimerController.prototype;

      const fenced = [
        [entries.create, EntriesController, "timesheets.entry.create"],
        [entries.void, EntriesController, "timesheets.entry.void"],
        [
          entries.draftFromAttendance,
          EntriesController,
          "timesheets.entries.from_attendance",
        ],
        [timer.start, TimerController, "timesheets.timer.start"],
        [timer.stop, TimerController, "timesheets.timer.stop"],
        [timer.discard, TimerController, "timesheets.timer.discard"],
        [timer.convert, TimerController, "timesheets.timer.convert"],
      ] as const;

      for (const [handler, cls, name] of fenced) {
        expect(fenceOn(handler, cls)).toEqual({ command: name, optional: true });
      }
    });

    it("leaves pause and resume unfenced", () => {
      expect(
        fenceOn(TimerController.prototype.pause, TimerController).command,
      ).toBeUndefined();
      expect(
        fenceOn(TimerController.prototype.resume, TimerController).command,
      ).toBeUndefined();
    });

    it("requires the header on period submit and on all four approval commands", () => {
      const approvals = ApprovalsController.prototype;
      const required = [
        [PeriodsController.prototype.submit, PeriodsController, "timesheets.period.submit"],
        [approvals.approve, ApprovalsController, "timesheets.approval.approve"],
        [approvals.reject, ApprovalsController, "timesheets.approval.reject"],
        [approvals.bulkApprove, ApprovalsController, "timesheets.approval.bulk_approve"],
        [approvals.bulkReject, ApprovalsController, "timesheets.approval.bulk_reject"],
      ] as const;

      for (const [handler, cls, name] of required) {
        expect(fenceOn(handler, cls)).toEqual({ command: name, optional: false });
      }
    });
  });

  describe("replaying POST /timesheets/entries", () => {
    it("returns the first stored result and does not create a second entry", async () => {
      const { db, rows } = makeFenceStore();
      const { controller, created } = entriesControllerWithStore();
      const interceptor = new IdempotencyInterceptor(new Reflector(), new DrizzleCommandFenceStore(db));
      const ctx = () =>
        makeCtx(
          EntriesController.prototype.create,
          EntriesController,
          request("retry-me", ENTRY_BODY),
          { statusCode: 201, status: jest.fn() },
        );

      const first = callHandler(() => controller.create(ENTRY_BODY, USER));
      const firstResult = await firstValueFrom(
        await interceptor.intercept(ctx(), first),
      );
      await settle();

      const second = callHandler(() => controller.create(ENTRY_BODY, USER));
      const secondResult = await firstValueFrom(
        await interceptor.intercept(ctx(), second),
      );

      expect(firstResult).toEqual({ id: 1, date: ENTRY_BODY.date });
      expect(secondResult).toEqual(firstResult);
      expect(second.handle).not.toHaveBeenCalled();
      expect(created).toHaveLength(1);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        commandName: "timesheets.entry.create",
        status: "COMPLETED",
        responseStatus: 201,
      });
    });

    it("replays the stored 201 rather than the retry's own status", async () => {
      const { db } = makeFenceStore();
      const { controller } = entriesControllerWithStore();
      const interceptor = new IdempotencyInterceptor(new Reflector(), new DrizzleCommandFenceStore(db));

      await firstValueFrom(
        await interceptor.intercept(
          makeCtx(
            EntriesController.prototype.create,
            EntriesController,
            request("k-201", ENTRY_BODY),
            { statusCode: 201, status: jest.fn() },
          ),
          callHandler(() => controller.create(ENTRY_BODY, USER)),
        ),
      );
      await settle();

      const status = jest.fn();
      await firstValueFrom(
        await interceptor.intercept(
          makeCtx(
            EntriesController.prototype.create,
            EntriesController,
            request("k-201", ENTRY_BODY),
            { statusCode: 200, status },
          ),
          callHandler(() => controller.create(ENTRY_BODY, USER)),
        ),
      );

      expect(status).toHaveBeenCalledWith(201);
    });

    it("rejects a duplicate that arrives while the first is still running", async () => {
      const { db } = makeFenceStore();
      const { controller, created } = entriesControllerWithStore();
      const interceptor = new IdempotencyInterceptor(new Reflector(), new DrizzleCommandFenceStore(db));
      const ctx = () =>
        makeCtx(
          EntriesController.prototype.create,
          EntriesController,
          request("double-tap", ENTRY_BODY),
          { statusCode: 201, status: jest.fn() },
        );

      await interceptor.intercept(
        ctx(),
        callHandler(() => controller.create(ENTRY_BODY, USER)),
      );

      await expect(
        interceptor.intercept(
          ctx(),
          callHandler(() => controller.create(ENTRY_BODY, USER)),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(created).toHaveLength(0);
    });

    it("refuses the same key with a different body", async () => {
      const { db } = makeFenceStore();
      const { controller, created } = entriesControllerWithStore();
      const interceptor = new IdempotencyInterceptor(new Reflector(), new DrizzleCommandFenceStore(db));

      await firstValueFrom(
        await interceptor.intercept(
          makeCtx(
            EntriesController.prototype.create,
            EntriesController,
            request("reused", ENTRY_BODY),
            { statusCode: 201, status: jest.fn() },
          ),
          callHandler(() => controller.create(ENTRY_BODY, USER)),
        ),
      );
      await settle();

      const changed = { ...ENTRY_BODY, hours: "8" } as unknown as CreateEntryInput;
      await expect(
        interceptor.intercept(
          makeCtx(
            EntriesController.prototype.create,
            EntriesController,
            request("reused", changed),
            { statusCode: 201, status: jest.fn() },
          ),
          callHandler(() => controller.create(changed, USER)),
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(created).toHaveLength(1);
    });
  });

  describe("the header, present and absent", () => {
    it("lets an entry create through with no header at all", async () => {
      const { db, rows } = makeFenceStore();
      const { controller, created } = entriesControllerWithStore();
      const interceptor = new IdempotencyInterceptor(new Reflector(), new DrizzleCommandFenceStore(db));
      const handler = callHandler(() => controller.create(ENTRY_BODY, USER));

      const result = await firstValueFrom(
        await interceptor.intercept(
          makeCtx(
            EntriesController.prototype.create,
            EntriesController,
            request(undefined, ENTRY_BODY),
          ),
          handler,
        ),
      );

      expect(result).toEqual({ id: 1, date: ENTRY_BODY.date });
      expect(created).toHaveLength(1);
      expect(rows).toHaveLength(0);
    });

    it("400s a period submit sent without the header", async () => {
      const { db } = makeFenceStore();
      const interceptor = new IdempotencyInterceptor(new Reflector(), new DrizzleCommandFenceStore(db));

      const attempt = interceptor.intercept(
        makeCtx(
          PeriodsController.prototype.submit,
          PeriodsController,
          request(undefined, {}),
        ),
        callHandler(() => Promise.resolve("SHOULD NOT RUN")),
      );

      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow(/Idempotency-Key header is required/);
    });
  });

  describe("one key, two timers", () => {
    function stopFixture() {
      const stopped: number[] = [];
      const timer = {
        stopTimer: (_u: CurrentUserContext, timerId: number) => {
          stopped.push(timerId);
          return Promise.resolve({ timerId, status: "STOPPED" });
        },
      } as unknown as TimerService;
      return { controller: new TimerController(timer), stopped };
    }

    const stopCtx = (key: string, timerId: string) =>
      makeCtx(
        TimerController.prototype.stop,
        TimerController,
        request(key, undefined, { timerId }),
      );

    it("refuses the second timer instead of replaying the first", async () => {
      const { db } = makeFenceStore();
      const { controller, stopped } = stopFixture();
      const interceptor = new IdempotencyInterceptor(new Reflector(), new DrizzleCommandFenceStore(db));

      const first = await firstValueFrom(
        await interceptor.intercept(
          stopCtx("one-key-per-session", "11"),
          callHandler(() => controller.stop(11, USER)),
        ),
      );
      await settle();

      const second = interceptor.intercept(
        stopCtx("one-key-per-session", "22"),
        callHandler(() => controller.stop(22, USER)),
      );

      expect(first).toEqual({ timerId: 11, status: "STOPPED" });
      await expect(second).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(stopped).toEqual([11]);
    });

    it("still replays a genuine retry of the same timer", async () => {
      const { db, rows } = makeFenceStore();
      const { controller, stopped } = stopFixture();
      const interceptor = new IdempotencyInterceptor(new Reflector(), new DrizzleCommandFenceStore(db));

      const first = await firstValueFrom(
        await interceptor.intercept(
          stopCtx("retry-same-timer", "11"),
          callHandler(() => controller.stop(11, USER)),
        ),
      );
      await settle();

      const retry = callHandler(() => controller.stop(11, USER));
      const second = await firstValueFrom(
        await interceptor.intercept(stopCtx("retry-same-timer", "11"), retry),
      );

      expect(second).toEqual(first);
      expect(retry.handle).not.toHaveBeenCalled();
      expect(stopped).toEqual([11]);
      expect(rows).toHaveLength(1);
    });
  });
});
