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
import { ApprovalsController } from "../approvals.controller";
import { EntriesController } from "../entries.controller";
import { PeriodsController } from "../periods.controller";
import { TimerController } from "../timer.controller";
import type { AttendanceDraftService } from "../attendance/attendance-draft.service";
import type { EntriesService } from "../entries.service";
import type { TimerService } from "../timer.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.module";
import type { CreateEntryInput } from "../dto/entries.schemas";

/**
 * TS-17. The replay contract, exercised through the timesheets routes that
 * actually carry it.
 *
 * `idempotency.interceptor.spec.ts` already proves the interceptor's own state
 * machine against a synthetic command name. What it cannot say is whether any
 * timesheets route is fenced at all, or which of the two idempotency mechanisms
 * in this repository it is fenced by — and those are the two facts a retrying
 * mobile client depends on. So every case below reads the metadata off the real
 * handler function with the real `Reflector`, exactly as the interceptor does at
 * request time. Delete `@Idempotent` from `EntriesController.create` and this
 * file fails; rename the command and it fails; swap it for the other mechanism
 * and it fails.
 *
 * **Which mechanism.** This branch has two, and they are not interchangeable:
 *
 *   - `@Idempotent(name, opts)` (`common/idempotency/idempotent.decorator.ts`)
 *     — a *method* decorator that installs `IdempotencyInterceptor` and the
 *     platform-wide `command_fences` contract: claim, store, replay, 409, 422.
 *     Nothing in the handler knows it is there.
 *   - Inventory's own, which is not a decorator at all: the controller reads
 *     the header by hand (`requireIdempotencyKey` in
 *     `inv-purchase-orders.controller.ts`) and the service claims a row in
 *     `inv_idempotency_keys` via `stock-engine/idempotency.ts`. Its 400 lives
 *     in the controller, its replay lives in the engine, and it never touches
 *     `command_fences`.
 *
 * Every fenced timesheets route uses the first. A check that grepped for
 * inventory's shape would report this module as unfenced; a check that read
 * only the decorator would report inventory as unfenced. Hence the metadata
 * assertions below, which name the mechanism explicitly.
 *
 * **Two corrections to the ticket text, both load-bearing.** The entry/timer
 * surface is *seven* routes, not six — `from-attendance` (TS-09) landed after
 * the ticket was written. And `@Idempotent` does **not** make the header
 * required on any of them: all seven pass `{ required: false }`, deliberately
 * (see the comment on `EntriesController.create`), so a caller that omits the
 * header is executed rather than answered 400. The 400 is real, but it lives on
 * the other six fenced timesheets routes — period submit, the four approval
 * commands and the payroll export. It is asserted below on
 * `PeriodsController.submit`, where it bites.
 */

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

/* ------------------------------------------------------------------ *
 * A `command_fences` table, in memory.
 *
 * Not a `jest.fn()` per call: the whole subject here is what the *second*
 * request sees of the first, so the double has to carry state across both. It
 * enforces the one thing the real table enforces and the contract rests on —
 * the unique index on (organization_id, audience, idempotency_key).
 *
 * `transaction` runs the body against the same handle rather than being a bare
 * `jest.fn()`, because every fence write goes through `runInNewTenantTransaction`
 * and a transaction double that never invokes its callback would void every
 * assertion in this file while still reporting green.
 * ------------------------------------------------------------------ */

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
}

function makeFenceStore() {
  const rows: FenceRow[] = [];
  let nextId = 1;
  /** The (org, audience, key) triple of the claim currently being served. */
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
              const row = { commandFenceId: nextId++, ...v } as FenceRow;
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

/** The real `Reflector`, so the metadata read is the one the interceptor does. */
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

/**
 * `params` is what Express hands the interceptor after routing, so the values
 * are the raw path strings — `"11"`, not `11`. The fence hashes them as they
 * arrive, and a test that passed numbers here would be hashing something no
 * request ever produces.
 */
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

/** `defer`, so the handler runs on subscribe and its promise is unwrapped. */
function callHandler(run: () => Promise<unknown>): CallHandler {
  const handle = jest.fn(() => defer(run));
  return { handle } as unknown as CallHandler;
}

/** `complete()` is fired with `void`; let its writes land before asserting. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** An `EntriesController` whose service appends a row we can count. */
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

    /**
     * The other half of "optional". `pause` and `resume` set a state that is
     * already its own idempotent target, so they carry no fence at all — and an
     * unfenced route must read as unfenced rather than as a fence that silently
     * lets everything past.
     */
    it("leaves pause and resume unfenced", () => {
      expect(
        fenceOn(TimerController.prototype.pause, TimerController).command,
      ).toBeUndefined();
      expect(
        fenceOn(TimerController.prototype.resume, TimerController).command,
      ).toBeUndefined();
    });

    /**
     * Where the required fence actually lives. A state transition that must not
     * run twice does not get to opt out by omitting a header.
     */
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
    /**
     * The ticket in one test: same key, same body, one row.
     *
     * The row count is the assertion that matters. A fence that returned the
     * right JSON while still running the handler would look identical to a
     * caller and would have written the afternoon twice.
     */
    it("returns the first stored result and does not create a second entry", async () => {
      const { db, rows } = makeFenceStore();
      const { controller, created } = entriesControllerWithStore();
      const interceptor = new IdempotencyInterceptor(new Reflector(), db);
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

    /** The replay carries the first response's status, not the retry's. */
    it("replays the stored 201 rather than the retry's own status", async () => {
      const { db } = makeFenceStore();
      const { controller } = entriesControllerWithStore();
      const interceptor = new IdempotencyInterceptor(new Reflector(), db);

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

    /**
     * The in-flight case is what a double-tap on a slow connection produces.
     * The first request is intercepted and never subscribed, so its fence is
     * claimed and never completed — which is precisely the state a request
     * still executing is in.
     */
    it("rejects a duplicate that arrives while the first is still running", async () => {
      const { db } = makeFenceStore();
      const { controller, created } = entriesControllerWithStore();
      const interceptor = new IdempotencyInterceptor(new Reflector(), db);
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

    /**
     * A reused key with a changed body is a client bug, and answering it with
     * the *old* entry would be the worst of the three options — the caller
     * would believe the edit landed.
     */
    it("refuses the same key with a different body", async () => {
      const { db } = makeFenceStore();
      const { controller, created } = entriesControllerWithStore();
      const interceptor = new IdempotencyInterceptor(new Reflector(), db);

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
    /**
     * The ticket says `@Idempotent` makes the header required and that a
     * request without one 400s. On these seven routes that is not what happens,
     * and the difference is the point of `{ required: false }`: the mobile
     * client and every `source: "API"` integration predate the fence and have
     * never sent the header. They keep working.
     */
    it("lets an entry create through with no header at all", async () => {
      const { db, rows } = makeFenceStore();
      const { controller, created } = entriesControllerWithStore();
      const interceptor = new IdempotencyInterceptor(new Reflector(), db);
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
      /** Unfenced means unfenced: no row, so no replay protection either. */
      expect(rows).toHaveLength(0);
    });

    /**
     * And the required half. This is the failure the ticket warns about: a POST
     * with a perfectly valid body answered 400, which at the call site is
     * indistinguishable from a Zod rejection. The message is the only thing
     * that says otherwise, so it is asserted.
     */
    it("400s a period submit sent without the header", async () => {
      const { db } = makeFenceStore();
      const interceptor = new IdempotencyInterceptor(new Reflector(), db);

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

  /**
   * The collision this file used to record as observed behaviour.
   *
   * The request hash covered `{ commandName, body }` and nothing else.
   * `POST /timesheets/timer/:timerId/stop` takes no body, so two stops of two
   * *different* timers under one key hashed identically and the second replayed
   * the first: timer 22 kept running and the caller was told it had stopped.
   * The caveat is now an assertion, because the hash covers the route params
   * too — see `IdempotencyInterceptor.hashRequest`.
   *
   * It was never a timesheets quirk. Sixty-nine fenced routes across the
   * platform are param-carrying with no body and every one shared the defect:
   * posting two AR invoices, approving two purchase orders, accepting two
   * enterprise quotes. This route is simply the cheapest place to pin it.
   *
   * Reusing one key across two resources is still the caller misusing it. The
   * change is in *which* answer that earns — a 422 that names the misuse rather
   * than a 200 describing the wrong timer.
   */
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
      const interceptor = new IdempotencyInterceptor(new Reflector(), db);

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
      /**
       * The assertion that would have caught the original bug. A fence that
       * answered `{ timerId: 11 }` to the second call looked plausible; what
       * made it a bug is that timer 22 was never stopped — and the mirror of
       * that is that timer 11 must not be stopped twice either.
       */
      expect(stopped).toEqual([11]);
    });

    /**
     * The other half, and the reason this could not be fixed by hashing the URL
     * blindly: a genuine retry is the same request to the same URL, so its
     * params are identical to the original's and it must still replay. Without
     * this case, an implementation that simply salted every hash with something
     * unique would pass the test above while destroying the fence.
     */
    it("still replays a genuine retry of the same timer", async () => {
      const { db, rows } = makeFenceStore();
      const { controller, stopped } = stopFixture();
      const interceptor = new IdempotencyInterceptor(new Reflector(), db);

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
