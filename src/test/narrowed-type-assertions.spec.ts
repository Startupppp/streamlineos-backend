/**
 * Runtime contracts for the six type assertions removed by ticket 25's
 * assertion sweep (`pnpm check:type-assertions`, rule 4).
 *
 * Every one of the six was narrowed rather than ledgered, so none of them is a
 * PRD-C031 exception and none needs an invariant written in the ledger. What
 * they DO need is proof that the narrowing behaves — because four of the six
 * were not merely cosmetic. `x!` and `x as T` compile away to nothing, so the
 * only way to know whether the code underneath them was correct is to drive the
 * case the assertion claimed could not happen:
 *
 *   - a workflow snapshot with no `steps` key, which the old
 *     `as { steps: ResolvedStep[] }` turned into a TypeError that took down the
 *     whole cron sweep for every organisation;
 *   - an `INSERT ... RETURNING` and an `UPDATE ... RETURNING` that come back
 *     empty, which the old `row!` / `updated!` turned into an audit-log entry
 *     for a record that does not exist plus an `undefined` handed to the caller;
 *   - a stored routing rule naming a priority the enum does not have, which the
 *     old hand-written `TICKET_PRIORITIES` list could disagree with.
 *
 * Each block therefore holds the negative case AND a positive control, so a
 * test that passes because the code does nothing at all fails here instead.
 *
 * This file lives beside `removed-speculative-request-fields.spec.ts` and
 * `removed-unread-request-fields.spec.ts`, which are cross-cutting release
 * hygiene specs of the same kind.
 */
import { InternalServerErrorException, NotFoundException } from "@nestjs/common";
import type { Db } from "../db/drizzle.module";
import { queryTimeline } from "../modules/activities/activities-timeline";
import { timelineQuerySchema } from "../modules/activities/dto/activity.schemas";
import type { HrAuditService } from "../modules/hr/core/hr-audit.service";
import { createLaborCase, updateLaborCase } from "../modules/hr/governance/labor/labor-cases";
import {
  definitionSnapshotSchema,
  sweepOverdueWorkflowSteps,
} from "../modules/hr/workflows/hr-workflow-overdue-sweep";
import { ticketPrioritySchema } from "../modules/support/core/dto/support-tickets.schemas";
import { isTicketPriority, resolveTicketRouting } from "../modules/support/core/support-ticket-routing";

/**
 * The one idiom this file borrows from the rest of the spec suite: a hand-built
 * stub standing where a full Drizzle client is declared. Specs are outside
 * `check-type-assertions` by design (see its rule 4 header) and every mocked
 * service in this repository is constructed the same way.
 */
const asDb = (stub: unknown): Db => stub as unknown as Db;
const asAudit = (stub: unknown): HrAuditService => stub as unknown as HrAuditService;

// ---------------------------------------------------------------------------
// src/modules/support/core/support-ticket-routing.ts:8
//   was: (TICKET_PRIORITIES as readonly string[]).includes(value)
//   now: ticketPrioritySchema.safeParse(value).success
// ---------------------------------------------------------------------------
describe("support ticket routing — the priority guard is the Zod enum, not a second list", () => {
  it("accepts exactly the priorities the schema declares, and no others", () => {
    for (const priority of ticketPrioritySchema.options) {
      expect(isTicketPriority(priority)).toBe(true);
    }

    // The negative half. `low` matters on its own: routing rules are stored
    // free text, and a case-insensitive guard would let one through as a
    // priority the database enum then rejects.
    for (const notAPriority of ["low", "Urgent", "CRITICAL", "P1", "", " HIGH"]) {
      expect(isTicketPriority(notAPriority)).toBe(false);
    }
  });

  it("has no list of its own to drift from the schema", () => {
    // A rewrite that reintroduces a hand-maintained array fails here the moment
    // the schema gains a fifth priority and the array does not.
    for (const priority of ticketPrioritySchema.options) {
      expect(ticketPrioritySchema.safeParse(priority).success).toBe(isTicketPriority(priority));
    }
    expect(ticketPrioritySchema.options.length).toBeGreaterThan(0);
  });

  it("ignores a routing rule that names a priority the enum does not have", async () => {
    const macros = {
      isVipClient: jest.fn().mockResolvedValue(false),
      applyRoutingRules: jest.fn().mockResolvedValue({ setPriority: "CRITICAL" }),
    };

    const decision = await resolveTicketRouting(macros, "org_1", { title: "printer on fire" });

    expect(decision.priority).toBe("MEDIUM");
  });

  it("positive control: a routing rule naming a real priority still applies", async () => {
    const macros = {
      isVipClient: jest.fn().mockResolvedValue(true),
      applyRoutingRules: jest.fn().mockResolvedValue({ setPriority: "URGENT", assigneeId: "user_9" }),
    };

    const decision = await resolveTicketRouting(macros, "org_1", { title: "printer on fire" });

    expect(decision).toEqual({ priority: "URGENT", assigneeId: "user_9" });
  });
});

// ---------------------------------------------------------------------------
// src/modules/hr/workflows/hr-workflow-overdue-sweep.ts:34
//   was: (instance.definitionSnapshot as { steps: ResolvedStep[] }).steps
//   now: definitionSnapshotSchema.safeParse(instance.definitionSnapshot)
// ---------------------------------------------------------------------------
describe("hr workflow overdue sweep — an unreadable definition snapshot is skipped, not fatal", () => {
  type SweepSink = { readonly inserted: unknown[][]; updates: number };

  const sweepDb = (instances: unknown[], sink: SweepSink) => {
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
      insert: () => ({
        values: (rows: unknown[]) => {
          sink.inserted.push(rows);
          return Promise.resolve();
        },
      }),
      update: () => ({
        set: () => ({
          where: () => {
            sink.updates += 1;
            return Promise.resolve();
          },
        }),
      }),
    };

    return asDb({
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(instances) }) }) }),
      transaction: (callback: (t: typeof tx) => Promise<void>) => callback(tx),
    });
  };

  let stderr: jest.SpyInstance;
  beforeEach(() => {
    // The sweep warns about every skipped instance, which is the point — this
    // only keeps the warning out of the test output.
    stderr = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => stderr.mockRestore());

  it("rejects a snapshot with no `steps` key rather than reading `.find` off undefined", () => {
    // The exact stored shape that made the old cast throw at runtime.
    expect(definitionSnapshotSchema.safeParse({}).success).toBe(false);
    expect(definitionSnapshotSchema.safeParse({ steps: null }).success).toBe(false);
    expect(definitionSnapshotSchema.safeParse({ steps: [{ stepOrder: "1" }] }).success).toBe(false);
  });

  it("keeps sweeping when one instance's snapshot is unreadable", async () => {
    const sink: SweepSink = { inserted: [], updates: 0 };
    const result = await sweepOverdueWorkflowSteps(
      sweepDb(
        [
          { id: 1, orgId: "org_1", currentStepOrder: 1, definitionSnapshot: {} },
          {
            id: 2,
            orgId: "org_1",
            currentStepOrder: 1,
            definitionSnapshot: {
              steps: [
                {
                  stepOrder: 1,
                  name: "Manager approval",
                  approverType: "user",
                  mode: "any",
                  escalationApproverType: "user",
                  escalationApproverValue: "user_7",
                },
              ],
            },
          },
        ],
        sink,
      ),
      "org_1",
    );

    // No throw, both instances examined, and the healthy one still escalated.
    expect(result).toEqual({ swept: 2 });
    expect(sink.inserted).toHaveLength(1);
    expect(sink.inserted[0]).toHaveLength(1);
    expect(sink.inserted[0]?.[0]).toMatchObject({ instanceId: 2, approverUserId: "user_7", action: "escalated" });
  });

  it("says so when it skips one — a silent skip means that workflow never escalates again", async () => {
    const sink: SweepSink = { inserted: [], updates: 0 };
    await sweepOverdueWorkflowSteps(
      sweepDb([{ id: 1, orgId: "org_1", currentStepOrder: 1, definitionSnapshot: {} }], sink),
      "org_1",
    );

    expect(sink.inserted).toHaveLength(0);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("unreadable definition snapshot"));
  });
});

// ---------------------------------------------------------------------------
// src/modules/hr/governance/labor/labor-cases.ts:55,57,77
//   was: String(row!.id) / return row! / return updated!
//   now: an explicit empty-RETURNING check before the audit write
// ---------------------------------------------------------------------------
describe("labor cases — an empty RETURNING fails instead of auditing a row that is not there", () => {
  const laborDb = (rows: { existing?: unknown[]; inserted?: unknown[]; updated?: unknown[] }) =>
    asDb({
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(rows.existing ?? []) }) }) }),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve(rows.inserted ?? []) }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve(rows.updated ?? []) }) }) }),
    });

  const input = { unionName: "UAW", subject: "Grievance", description: "Shift rota" };

  it("createLaborCase throws rather than logging an audit entry naming `undefined`", async () => {
    const audit = { log: jest.fn() };

    await expect(
      createLaborCase(laborDb({ inserted: [] }), asAudit(audit), "org_1", "user_1", input),
    ).rejects.toBeInstanceOf(InternalServerErrorException);

    expect(audit.log).not.toHaveBeenCalled();
  });

  it("positive control: createLaborCase returns the row and audits its real id", async () => {
    const audit = { log: jest.fn() };

    const created = await createLaborCase(
      laborDb({ inserted: [{ id: 42, subject: input.subject }] }),
      asAudit(audit),
      "org_1",
      "user_1",
      input,
    );

    expect(created).toEqual({ id: 42, subject: input.subject });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ entityId: "42" }));
  });

  it("updateLaborCase 404s when the row vanishes between the read and the write", async () => {
    const audit = { log: jest.fn() };

    await expect(
      updateLaborCase(
        // The read finds it; the UPDATE ... RETURNING comes back empty, which is
        // what a concurrent soft delete looks like from here.
        laborDb({ existing: [{ id: 7, status: "open" }], updated: [] }),
        asAudit(audit),
        "org_1",
        7,
        "user_1",
        { status: "resolved" },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(audit.log).not.toHaveBeenCalled();
  });

  it("positive control: updateLaborCase returns the updated row", async () => {
    const audit = { log: jest.fn() };

    const updated = await updateLaborCase(
      laborDb({ existing: [{ id: 7, status: "open" }], updated: [{ id: 7, status: "resolved" }] }),
      asAudit(audit),
      "org_1",
      7,
      "user_1",
      { status: "resolved" },
    );

    expect(updated).toEqual({ id: 7, status: "resolved" });
    expect(audit.log).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// src/modules/activities/activities-timeline.ts:66
//   was: buildTimelinePage(rows as TimelineEntry[], ...)
//   now: buildTimelinePage(rows, ...) — the compiler proves the conformance
// ---------------------------------------------------------------------------
describe("activity timeline — the projection names every field TimelineEntry declares", () => {
  /**
   * `tsc` now proves this, which is the whole point of removing the cast. It is
   * restated at runtime because the failure the cast used to hide — a column
   * dropped from the `select`, every read of it silently `undefined` — is worth
   * catching in two independent places, and because a future edit that
   * reintroduces a cast would make the compile-time half stop checking without
   * anything failing.
   */
  const TIMELINE_ENTRY_FIELDS = [
    "activityId",
    "actorKind",
    "actorLabel",
    "actorName",
    "body",
    "completedAt",
    "dueAt",
    "kind",
    "occurredAt",
    "source",
    "subject",
    "threadId",
  ];

  it("selects exactly those columns, no more and no fewer", async () => {
    let projection: Record<string, unknown> | undefined;

    const db = asDb({
      select: (selection: Record<string, unknown>) => {
        projection = selection;
        return {
          from: () => ({
            leftJoin: () => ({
              where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }),
            }),
          }),
        };
      },
    });

    const page = await queryTimeline(db, "org_1", timelineQuerySchema.parse({ partyId: "party_1", limit: 20 }));

    expect(Object.keys(projection ?? {}).sort()).toEqual(TIMELINE_ENTRY_FIELDS);
    expect(page).toEqual({ data: [], pagination: { limit: 20, hasMore: false, nextCursor: null } });
  });
});
