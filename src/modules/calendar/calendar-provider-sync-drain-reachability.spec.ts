/**
 * The regression net for the P0 that left `calendar_provider_sync_queue` with no drain.
 *
 * `CalendarService.createEvent` (calendar.service.ts:185) writes a PENDING queue row inside
 * the same transaction as the event — local-first with an atomic sync intent, exactly as
 * PRD-C129 requires. `CalendarProviderSyncSweepService.run()` is the code that drains it, and
 * at journal head NOTHING CALLED IT. Grepping the class across `src` returned the module
 * registration and nine spec files, and nothing else. `CalendarModule.exports` did not list
 * it, so `CronModule` could not have injected it even if a route had wanted to; and there was
 * no `/cron/calendar-provider-sync-sweep` among the cron routes.
 *
 * The user-visible outcome was total: every provider-synced event sat at `status: "pending"`
 * forever, `POST /events/:id/sync-retry` matched only `state='FAILED'` and returned
 * `{requeued: 0}` for ever, and the event never reached Google or Outlook. That is precisely
 * the "permanent local/external divergence" C129 forbids, for 100% of synced events.
 *
 * WHY THIS SPEC IS SHAPED THIS WAY. Nine specs already drive `run()` directly by constructing
 * the service with a fake db, and all nine were green while the queue never drained — because
 * "does run() work" and "does anything CALL run()" are different questions, and only the
 * second one was broken. So this spec never calls `run()` on a fake. It asks the three
 * questions that together make the drain REACHABLE in a booted process, reading Nest's own
 * metadata rather than the source text:
 *
 *   1. `CalendarModule` exports the sweep, so another module can inject it.
 *   2. `CronModule` imports `CalendarModule`, so the injection actually resolves.
 *   3. `CronCalendarController` declares GET and POST routes for it, and the handler really
 *      calls `run()` under `cronLease.withLease`.
 *
 * ANTI-VACUITY. Every probe below is also run against `calendar-reminder-sweep`, which was
 * wired correctly at head. If a probe cannot tell the wired sweep from the unwired one it
 * proves nothing, so the reminder-sweep assertions are what make the sync-sweep assertions
 * meaningful — and they are written as the same helper calls, not as a separate reading.
 */
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { CalendarModule } from "./calendar.module";
import { CalendarProviderSyncSweepService } from "./calendar-provider-sync-sweep.service";
import { CalendarReminderSweepService } from "./calendar-reminder-sweep.service";
import { CronModule } from "../cron/cron.module";
import { CronCalendarController } from "../cron/cron-calendar.controller";
import { calendarProviderSyncSweepResponseSchema } from "./dto/provider-sync.schemas";

type Ctor = abstract new (...args: never[]) => unknown;

function moduleExports(module: Ctor): readonly Ctor[] {
  return (Reflect.getMetadata("exports", module) as Ctor[] | undefined) ?? [];
}

function moduleImports(module: Ctor): readonly Ctor[] {
  return (Reflect.getMetadata("imports", module) as Ctor[] | undefined) ?? [];
}

interface CronRoute {
  handlerName: string;
  method: RequestMethod;
  path: string;
}

/** Every routed handler on the controller, read from Nest's own route metadata. */
function cronRoutes(): CronRoute[] {
  const proto = CronCalendarController.prototype as unknown as Record<string, unknown>;
  const routes: CronRoute[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === "constructor") continue;
    const handler = proto[name];
    if (typeof handler !== "function") continue;
    const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);
    const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
    if (typeof path !== "string" || typeof method !== "number") continue;
    routes.push({ handlerName: name, method, path });
  }
  return routes;
}

function methodsFor(path: string): RequestMethod[] {
  return cronRoutes()
    .filter((route) => route.path === path)
    .map((route) => route.method)
    .sort((a, b) => a - b);
}

/**
 * Drives one cron handler with stub collaborators and reports the lease key it took and
 * whether the sweep it is supposed to own actually ran. `sweepKey` names the constructor
 * parameter position by property name, so the stub lands on the right dependency without
 * this spec having to know the full 15-argument constructor.
 */
async function invokeCronHandler(
  handlerName: string,
  sweepProperty: string,
): Promise<{ leaseKey: string | null; leaseSeconds: number | null; sweepRan: boolean }> {
  let leaseKey: string | null = null;
  let leaseSeconds: number | null = null;
  let sweepRan = false;

  const cronLease = {
    withLease: async (key: string, seconds: number, fn: () => Promise<unknown>) => {
      leaseKey = key;
      leaseSeconds = seconds;
      return { ran: true, result: await fn() };
    },
  };
  const sweep = {
    run: async () => {
      sweepRan = true;
      return { organizations: { organizations: 0, succeeded: 0, failed: 0 }, claimed: 0, processed: 0, retried: 0, failed: 0 };
    },
  };

  // Nest injects by constructor position; this spec only needs two of the collaborators to be
  // real stubs, so the controller is built empty and the two are assigned onto the instance.
  const controller = Object.create(CronCalendarController.prototype) as CronCalendarController &
    Record<string, unknown>;
  controller.cronLease = cronLease;
  controller[sweepProperty] = sweep;

  const handler = (CronCalendarController.prototype as unknown as Record<string, unknown>)[
    handlerName
  ] as (this: unknown, authorization?: string) => Promise<unknown>;
  await handler.call(controller, "Bearer test-cron-secret");

  return { leaseKey, leaseSeconds, sweepRan };
}

beforeAll(() => {
  // assertCronSecret reads this; unset it would throw before the handler body runs.
  process.env.CRON_SECRET = "test-cron-secret";
});

describe("calendar provider-sync queue — the drain is reachable from a booted process", () => {
  it("CalendarModule exports the sweep, so CronModule can inject it", () => {
    const exported = moduleExports(CalendarModule);
    // Anti-vacuity: the same probe over the sweep that WAS wired at head must pass, or a
    // green result below would only mean the probe cannot see exports at all.
    expect(exported).toContain(CalendarReminderSweepService);
    expect(exported).toContain(CalendarProviderSyncSweepService);
  });

  it("CronModule imports CalendarModule, so that injection actually resolves", () => {
    expect(moduleImports(CronModule)).toContain(CalendarModule);
  });

  it("the cron calendar controller is registered on CronModule, so its routes exist", () => {
    const controllers = (Reflect.getMetadata("controllers", CronModule) as Ctor[] | undefined) ?? [];
    expect(controllers).toContain(CronCalendarController);
  });

  it("CronCalendarController exposes GET and POST /cron/calendar-provider-sync-sweep", () => {
    // Anti-vacuity first: the reminder sweep's pair is what a correctly wired route looks like.
    expect(methodsFor("calendar-reminder-sweep")).toEqual([RequestMethod.GET, RequestMethod.POST]);
    expect(methodsFor("calendar-provider-sync-sweep")).toEqual([
      RequestMethod.GET,
      RequestMethod.POST,
    ]);
  });

  it("the handler runs the sweep under its own 120s lease, not the reminder sweep's", async () => {
    const reminder = await invokeCronHandler(
      "postCalendarReminderSweep",
      "calendarReminderSweep",
    );
    expect(reminder).toEqual({
      leaseKey: "calendar-reminder-sweep",
      leaseSeconds: 120,
      sweepRan: true,
    });

    const providerSync = await invokeCronHandler(
      "postCalendarProviderSyncSweep",
      "calendarProviderSyncSweep",
    );
    expect(providerSync).toEqual({
      leaseKey: "calendar-provider-sync-sweep",
      leaseSeconds: 120,
      sweepRan: true,
    });
  });

  it("the GET twin runs the same sweep, so a scheduler that only issues GET still drains", async () => {
    const viaGet = await invokeCronHandler(
      "getCalendarProviderSyncSweep",
      "calendarProviderSyncSweep",
    );
    expect(viaGet.sweepRan).toBe(true);
    expect(viaGet.leaseKey).toBe("calendar-provider-sync-sweep");
  });
});

describe("calendar provider-sync sweep — per-tenant fairness", () => {
  /**
   * F15 in the same audit, and it only becomes reachable once the route above exists: the
   * claim budget was one global `BATCH_LIMIT = 20` consumed in `forEachOrg`'s `order by id`
   * sequence, so the alphabetically-first organisations with 20+ pending rows took the whole
   * tick's budget on every tick and every later tenant claimed zero, permanently. A per-org
   * allowance is what makes the sweep's progress a property of the queue rather than of the
   * tenant's id.
   */
  it("claims per organisation, so one busy tenant cannot take the whole tick", async () => {
    const { PER_ORG_CLAIM_LIMIT, GLOBAL_CLAIM_LIMIT } = (await import(
      "./calendar-provider-sync-sweep.service"
    )) as unknown as { PER_ORG_CLAIM_LIMIT: number; GLOBAL_CLAIM_LIMIT: number };

    expect(PER_ORG_CLAIM_LIMIT).toBeGreaterThan(0);
    // A global ceiling still exists (an unbounded tick is its own defect), but it must leave
    // room for many tenants, not one.
    expect(GLOBAL_CLAIM_LIMIT).toBeGreaterThanOrEqual(PER_ORG_CLAIM_LIMIT * 5);
  });
});

describe("the route's declared response contract matches what the handler returns", () => {
  /**
   * `@ResponseSchema` is not documentation here: `ResponseContractInterceptor` compares
   * the declared shape against the value the handler produced, and under NODE_ENV=test a
   * mismatch THROWS. A schema written beside a handler and never compared against it is
   * how a contracted route 500s the first time anything drives it, so both arms of the
   * union are driven against the real handler rather than read.
   */
  async function runHandler(outcome: { ran: boolean; result?: unknown }) {
    const controller = Object.create(CronCalendarController.prototype) as CronCalendarController &
      Record<string, unknown>;
    controller.cronLease = { withLease: async () => outcome };
    controller.calendarProviderSyncSweep = { run: async () => outcome.result };
    const handler = (CronCalendarController.prototype as unknown as Record<string, unknown>)
      .postCalendarProviderSyncSweep as (this: unknown, authorization?: string) => Promise<unknown>;
    return handler.call(controller, "Bearer test-cron-secret");
  }

  it("accepts the counters arm the sweep really returns", async () => {
    const result = {
      organizations: { organizations: 3, succeeded: 3, failed: 0 },
      claimed: 5,
      processed: 4,
      retried: 1,
      failed: 0,
    };

    const parsed = calendarProviderSyncSweepResponseSchema.safeParse(
      await runHandler({ ran: true, result }),
    );

    expect(parsed.success).toBe(true);
  });

  it("accepts the skipped arm taken when another worker holds the lease", async () => {
    const parsed = calendarProviderSyncSweepResponseSchema.safeParse(
      await runHandler({ ran: false }),
    );

    expect(parsed.success).toBe(true);
  });

  it("rejects a return that has lost a counter — the contract is an assertion, not prose", async () => {
    // Anti-vacuity: a union loose enough to accept anything proves nothing about the wire.
    const parsed = calendarProviderSyncSweepResponseSchema.safeParse({
      success: true,
      message: "Calendar provider sync: 0 claimed",
      organizations: { organizations: 1, succeeded: 1, failed: 0 },
      claimed: 0,
      processed: 0,
      retried: 0,
    });

    expect(parsed.success).toBe(false);
  });
});
