import { runWithTenantContext } from "../../common/tenant/tenant-context";
import { createTenantAwareDb, type DbWithClient } from "../../common/tenant/tenant-db";
import type { Db, TenantTx } from "../../db/drizzle.types";
import { autonomousDecisions, autonomySwitches } from "../../db/schema";
import type { DealsService } from "../deals/deals.service";
import { AutonomyActionsService } from "./autonomy-actions.service";
import type { Extraction } from "./extraction.schemas";
import type { ThreadWindow } from "./thread-window";

function query<T>(rows: T[]) {
  const chain = {
    then: (resolve: (value: T[]) => unknown, reject?: (error: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
    limit: async () => rows,
    orderBy: () => chain,
  };
  return chain;
}

function handle(label: string, sink: string[]) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          sink.push(`${label}:select`);
          return query(
            table === autonomySwitches
              ? [{ organizationId: null, kind: "*", enabled: true, reason: null }]
              : [],
          );
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: () => {
        sink.push(`${label}:insert:${table === autonomousDecisions ? "decision" : "task"}`);
        if (table === autonomousDecisions) return Promise.resolve(undefined);
        return { returning: async () => [{ activityId: "task-new" }] };
      },
    }),
  };
}

const WINDOW: ThreadWindow = {
  messages: [],
  conversation: "please send the revised pricing",
  alreadyDone: [],
  dropped: 0,
};

const EXTRACTION: Extraction = {
  nextStep: { description: "Send the revised pricing", dueDate: null, owner: "us" },
  stage: { suggestedStage: null, evidence: null },
  confidence: 0.95,
  summary: "They asked for pricing.",
};

/**
 * The one thing the split could have broken with nothing to show for it.
 *
 * What `applyNextStep` and `applyStageAdvance` decide is covered where it always
 * was — through `processActivity`, in `autonomy.service.spec.ts`, because that
 * is the only door the decisions come through. What moving them to their own
 * class could have changed is invisible from there: `this.db` is a proxy that
 * resolves per access to the request's ambient transaction, so a write in the
 * wrong class still writes, just outside the tenant transaction and with no
 * `app.organization_id` GUC set. Every assertion in the behaviour spec would
 * still pass. This is the case that would not.
 */
describe("the write half reaches the request's transaction", () => {
  const run = async (inContext: boolean) => {
    const calls: string[] = [];
    const pool = Object.assign(handle("pool", calls), {
      __client: { end: async () => undefined },
    }) as unknown as DbWithClient;
    const tx = handle("tx", calls) as unknown as TenantTx;
    const db = createTenantAwareDb(pool) as unknown as Db;

    const actions = new AutonomyActionsService(db, {
      updateDeal: jest.fn(),
    } as unknown as DealsService);

    const work = () =>
      actions.applyNextStep(
        "org-1",
        "activity-1",
        { partyId: null, dealId: null, threadId: "thread-1" },
        WINDOW,
        EXTRACTION,
        "fast-1",
        {},
      );

    if (inContext)
      await runWithTenantContext({ orgId: "org-1", audience: "INTERNAL", tx }, work);
    else await work();

    return calls;
  };

  it("routes every read and write through the ambient tx, not the pool", async () => {
    const calls = await run(true);
    expect(calls).toEqual(["tx:select", "tx:insert:task", "tx:insert:decision"]);
  });

  it("falls through to the pool when no request transaction is in flight", async () => {
    const calls = await run(false);
    expect(calls).toEqual(["pool:select", "pool:insert:task", "pool:insert:decision"]);
  });
});
