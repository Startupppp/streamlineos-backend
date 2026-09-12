import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  autonomousDecisions,
  autonomyHolds,
  businessParties,
  deals,
  orgModules,
  quotes,
  workflowRuns,
} from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.types";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { AutonomyHoldService } from "src/modules/autonomy/autonomy-hold.service";
import { readWhatsAppWebhook } from "src/modules/ingress/adapters/whatsapp-webhook";
import {
  whatsAppToInboundEvent,
  type WhatsAppMessageForIngress,
} from "src/modules/ingress/adapters/whatsapp-to-inbound-event";
import {
  FIXTURE_APP_SECRET,
  FIXTURE_BUSINESS_NUMBER,
  deliveryBlock,
  signedDelivery,
  textMessage,
  webhookBody,
} from "src/modules/ingress/adapters/whatsapp-webhook.fixture";
import type { InboundCommunicationEvent } from "src/modules/ingress/inbound-event";

/**
 * The hold: what stands between an autonomous decision and a customer's inbox.
 *
 * `crm-inbound-ingress` already owns the seam from signed payload to rows, and
 * `crm-tenant-isolation` owns RLS. Neither touches the half this file is for —
 * a decision is placed, a person stops it inside the window, and the ledger
 * ends up saying who stopped it. Those are the claims the branch adds and the
 * ones nothing else can see.
 *
 * **The hold is triggered by calling the service, not over HTTP, and that is a
 * finding rather than a shortcut.** `generateAndHoldQuote` and `holdQuoteSend`
 * have no production caller anywhere in `src/`: `AutonomyHoldService` is
 * injected only into the review controller, and the `crm.inbound-communication`
 * workflow's steps are extract-and-act, log-activity, mark-processed,
 * record-participants, resolve-party, resolve-region and shadow-score. An
 * inbound message asking for a quote therefore places no hold today, so a test
 * that drove the whole lifecycle from `POST /crm/ingress/inbound` would be
 * asserting a wiring that does not exist. What is real is asserted the way it
 * is reached: ingress over HTTP, the decision through the service inside a
 * tenant transaction, and the cancel — the half a person actually performs —
 * back over HTTP through the real guards.
 *
 * Run with (the 6 GB default cannot boot `AppModule`):
 *   NODE_OPTIONS=--max-old-space-size=12288 pnpm test:e2e:seeded \
 *     --testPathPattern="crm-golden-path-hold"
 */

const CRON_SECRET = process.env.CRON_SECRET;

/** The window a hold waits before sending, from `AUTONOMY_SETTINGS_DEFAULTS`. */
const DEFAULT_HOLD_WINDOW_SECONDS = 60;

interface TickResult {
  readonly ok: boolean;
  readonly claimed?: number;
  readonly skipped?: boolean;
}

describe(`${SEEDED_HARNESS} autonomy holds — decide, show, and stop before it sends`, () => {
  let seeded: SeededE2eApp;
  let appDb: Db;
  let holdService: AutonomyHoldService;

  /** The tenant under test, and a neighbour that must stay invisible to it. */
  let org: SeededFixture;
  let neighbour: SeededFixture;

  /** Holds every CRM key this file needs, and nothing outside CRM. */
  let crmToken: string;
  let crmUserId: string;
  /** An active member of the same org carrying no permission grants at all. */
  let plainToken: string;

  beforeAll(async () => {
    if (!CRON_SECRET)
      throw new Error(
        "CRON_SECRET must be set: the durable runtime is driven by POST /cron/workflow-tick, and " +
          "advancing the workflow any other way would stop this being an end-to-end test.",
      );

    seeded = await createSeededE2eApp();
    appDb = seeded.app.get<Db>(DRIZZLE);
    holdService = seeded.app.get(AutonomyHoldService);

    org = await seedOrg(seeded.seedDb)
      .addMember("rep", {
        permissionKeys: [
          "crm:ingress:submit",
          "crm:quotes:create",
          "crm:settings:view",
          "crm:autonomy:view",
          "crm:autonomy:reverse",
          "crm:autonomy:manage",
        ],
      })
      .addMember("plain")
      .build();

    neighbour = await seedOrg(seeded.seedDb).addMember("rep").build();

    /**
     * CRM and only CRM.
     *
     * The entitlement the permission does not carry: `PermissionGuard` answers
     * a `crm:` key with 402 MODULE_NOT_ENABLED when the tenant has no
     * `org_modules` row, and `SeedBuilder` writes none. Leaving payroll,
     * accounting and inventory unwritten is deliberate — it is the shape the
     * cross-module audit below is about.
     *
     * Written before the first request because the module map is cached for
     * 30 s, so enabling it afterwards would be invisible for the rest of the run.
     */
    for (const fixture of [org, neighbour])
      await seeded.seedDb
        .insert(orgModules)
        .values({ orgId: fixture.orgId, moduleKey: "crm", enabled: true });

    const rep = org.members["rep"];
    const plain = org.members["plain"];
    if (!rep || !plain) throw new Error("fixture members missing");
    crmUserId = rep.userId;
    crmToken = await signSeededToken(seeded, rep.userId, org.orgId);
    plainToken = await signSeededToken(seeded, plain.userId, org.orgId);
  }, 180_000);

  afterAll(async () => {
    // Ordered: the fixtures' rows go before the connections that delete them.
    if (org) await org.teardown();
    if (neighbour) await neighbour.teardown();
    if (seeded) await seeded.close();
  }, 60_000);

  // ── helpers ───────────────────────────────────────────────────────────────

  /**
   * Every mutating route here carries `@Idempotent`, and
   * `IdempotencyInterceptor` answers 400 when the `Idempotency-Key` header is
   * absent — so the header is not optional decoration on the calls below.
   */
  const http = () => request(seeded.app.getHttpServer());

  /**
   * The provider's payload, turned into the seam's event by the real adapter.
   *
   * Signed and verified rather than hand-built: the signature covers the bytes
   * as sent. Both unions are narrowed on their `ok` arm and throw with the
   * refusal's own reason, so a fixture the reader or the adapter rejects names
   * why instead of surfacing as an empty body four assertions later.
   */
  function eventFromProviderPayload(
    over: Record<string, unknown> = {},
  ): InboundCommunicationEvent {
    const delivery = signedDelivery(
      webhookBody([deliveryBlock({ messages: [textMessage(over)] })]),
    );

    const verdict = readWhatsAppWebhook(
      delivery.rawBody,
      delivery.signature,
      FIXTURE_APP_SECRET,
      delivery.parsed,
    );
    if (!verdict.ok) throw new Error(`fixture did not verify: ${verdict.reason}`);

    const message: WhatsAppMessageForIngress | undefined = verdict.deliveries[0]?.messages[0];
    if (!message) throw new Error("fixture carried no message");

    const normalised = whatsAppToInboundEvent(message, {
      organizationId: org.orgId,
      provider: "whatsapp",
      businessNumber: FIXTURE_BUSINESS_NUMBER,
    });
    if (!normalised.ok) throw new Error(`adapter skipped the fixture: ${normalised.reason}`);

    return normalised.event;
  }

  /** The real driver. Nothing else advances a run. */
  async function tick(): Promise<TickResult> {
    const res = await http()
      .post("/cron/workflow-tick")
      .set("Authorization", `Bearer ${CRON_SECRET ?? ""}`);
    // Asserted, not discarded: `assertCronSecret` reads CRON_SECRET itself, so
    // a wrong or missing one is 401/503 here and a missing row much later.
    expect(res.status).toBe(200);
    return res.body as TickResult;
  }

  /**
   * Ticks until this run reaches a terminal state, then reports what it was.
   *
   * One tick is not enough: a failed attempt reschedules itself with a backoff,
   * so the wait follows `run_after`, and `lastError` comes back so a failure
   * names the step that broke rather than only the row that is missing.
   */
  async function settle(
    workflowRunId: string,
  ): Promise<{ status: string; lastError: string | null }> {
    for (let pass = 0; pass < 6; pass += 1) {
      await tick();

      const [run] = await seeded.seedDb
        .select({
          status: workflowRuns.status,
          lastError: workflowRuns.lastError,
          runAfter: workflowRuns.runAfter,
        })
        .from(workflowRuns)
        .where(eq(workflowRuns.workflowRunId, workflowRunId));
      if (!run) throw new Error(`workflow run ${workflowRunId} disappeared`);

      if (run.status === "COMPLETED" || run.status === "DEAD_LETTERED")
        return { status: run.status, lastError: run.lastError };

      const waitMs = Math.min(Math.max(run.runAfter.getTime() - Date.now(), 0) + 250, 8_000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    const [stuck] = await seeded.seedDb
      .select({ status: workflowRuns.status, lastError: workflowRuns.lastError })
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowRunId, workflowRunId));
    return { status: stuck?.status ?? "GONE", lastError: stuck?.lastError ?? null };
  }

  /** A deal worth quoting, owned by whoever is named. */
  async function seedDeal(
    fixture: SeededFixture,
    assignedToId: string | null,
  ): Promise<number> {
    const [row] = await seeded.seedDb
      .insert(deals)
      .values({
        orgId: fixture.orgId,
        name: `Deal ${randomUUID().slice(0, 8)}`,
        valueMinor: 250_000,
        assignedToId,
      })
      .returning({ id: deals.id });
    if (!row) throw new Error("seed: deal insert produced no row");
    return row.id;
  }

  /**
   * The decision, taken the only way the code allows it to be taken.
   *
   * Wrapped in a tenant transaction because `AutonomyHoldService` reads and
   * writes through the ambient-context proxy: called with no context its
   * statements carry no `app.current_org_id()` GUC and every RLS policy on
   * `autonomy_holds`, `autonomous_decisions`, `quotes` and `deals` fails closed
   * with 42501. That is the same wrapper any real background caller would need.
   */
  function decideToSendAQuote(fixture: SeededFixture, dealId: number) {
    return runInNewTenantTransaction(appDb, fixture.orgId, () =>
      holdService.generateAndHoldQuote({
        organizationId: fixture.orgId,
        dealId,
        confidence: 0.95,
      }),
    );
  }

  const holdRow = (autonomyHoldId: string) =>
    seeded.seedDb
      .select()
      .from(autonomyHolds)
      .where(eq(autonomyHolds.autonomyHoldId, autonomyHoldId))
      .then((rows) => rows[0]);

  const decisionRow = (autonomousDecisionId: string) =>
    seeded.seedDb
      .select()
      .from(autonomousDecisions)
      .where(eq(autonomousDecisions.autonomousDecisionId, autonomousDecisionId))
      .then((rows) => rows[0]);

  // ── the path ──────────────────────────────────────────────────────────────

  it(
    "a signed inbound delivery settles into a party, over HTTP and the real driver",
    async () => {
      const accepted = await http()
        .post("/crm/ingress/inbound")
        .set("Authorization", `Bearer ${crmToken}`)
        .send(eventFromProviderPayload() as unknown as Record<string, unknown>);

      expect({ status: accepted.status, body: accepted.body as unknown }).toMatchObject({
        status: 202,
        body: { status: "accepted" },
      });
      const { workflowRunId } = accepted.body as { workflowRunId: string };

      expect(await settle(workflowRunId)).toMatchObject({
        status: "COMPLETED",
        lastError: null,
      });

      const parties = await seeded.seedDb
        .select({ partyId: businessParties.partyId })
        .from(businessParties)
        .where(eq(businessParties.organizationId, org.orgId));
      expect(parties).toHaveLength(1);
    },
    180_000,
  );

  it(
    "an autonomous decision drafts a quote and waits, without anybody approving it",
    async () => {
      const dealId = await seedDeal(org, crmUserId);
      const held = await decideToSendAQuote(org, dealId);

      expect(held).toMatchObject({ held: true });
      if (!held.held) throw new Error(`the decision refused to draft: ${held.reason}`);

      // The money is real and belongs to the tenant.
      const [quote] = await seeded.seedDb
        .select({ id: quotes.id, orgId: quotes.orgId, createdById: quotes.createdById })
        .from(quotes)
        .where(and(eq(quotes.orgId, org.orgId), eq(quotes.id, held.quoteId)));
      expect(quote).toMatchObject({ orgId: org.orgId, createdById: crmUserId });

      // Waiting, not sent — the distinction the whole feature exists for.
      expect(await holdRow(held.autonomyHoldId)).toMatchObject({
        organizationId: org.orgId,
        kind: "quote.sent",
        status: "held",
        quoteId: held.quoteId,
      });

      // And the ledger says `held`, not `applied`: it has not left yet.
      expect(await decisionRow(held.decisionId)).toMatchObject({
        kind: "quote.sent",
        outcome: "held",
      });

      // Visible to a reader who could stop it, with time left on the clock.
      const feed = await http()
        .get("/crm/autonomy/holds")
        .set("Authorization", `Bearer ${crmToken}`);
      expect(feed.status).toBe(200);
      const live = feed.body as { autonomyHoldId: string; secondsRemaining: number }[];
      const mine = live.find((row) => row.autonomyHoldId === held.autonomyHoldId);
      expect(mine).toBeDefined();
      expect(mine!.secondsRemaining).toBeGreaterThan(0);
      expect(mine!.secondsRemaining).toBeLessThanOrEqual(DEFAULT_HOLD_WINDOW_SECONDS);
    },
    180_000,
  );

  it(
    "cancelling inside the window reverses the decision and names who did it",
    async () => {
      const dealId = await seedDeal(org, crmUserId);
      const held = await decideToSendAQuote(org, dealId);
      if (!held.held) throw new Error(`the decision refused to draft: ${held.reason}`);

      /**
       * `cancel`, not `release`.
       *
       * There is no release route and no `released` status: `HOLD_STATUSES` is
       * `held | sent | cancelled | failed`, and the module's stated design is
       * that nobody ever approves, they only cancel.
       */
      const cancelled = await http()
        .post(`/crm/autonomy/holds/${held.autonomyHoldId}/cancel`)
        .set("Authorization", `Bearer ${crmToken}`)
        .set("Idempotency-Key", randomUUID())
        .send({ reason: "The address on file is stale." });
      // Nest answers a POST 201 unless the handler says otherwise.
      expect([200, 201]).toContain(cancelled.status);

      expect(await holdRow(held.autonomyHoldId)).toMatchObject({
        status: "cancelled",
        cancelledByUserId: crmUserId,
        cancelReason: "The address on file is stale.",
      });

      // The feed stops claiming it will happen, and says who stopped it.
      expect(await decisionRow(held.decisionId)).toMatchObject({
        outcome: "reversed",
        reversedByUserId: crmUserId,
        reversedReason: "The address on file is stale.",
      });

      // And it is gone from the list of things still waiting.
      const feed = await http()
        .get("/crm/autonomy/holds")
        .set("Authorization", `Bearer ${crmToken}`);
      expect(
        (feed.body as { autonomyHoldId: string }[]).map((row) => row.autonomyHoldId),
      ).not.toContain(held.autonomyHoldId);
    },
    180_000,
  );

  it(
    "a hold in another organisation is absent, never forbidden",
    async () => {
      const neighbourRep = neighbour.members["rep"];
      if (!neighbourRep) throw new Error("fixture members missing");
      // Owned: a deal nobody owns is skipped, because there is nobody to quote as.
      const dealId = await seedDeal(neighbour, neighbourRep.userId);
      const theirs = await decideToSendAQuote(neighbour, dealId);
      if (!theirs.held) throw new Error(`the decision refused to draft: ${theirs.reason}`);

      const res = await http()
        .post(`/crm/autonomy/holds/${theirs.autonomyHoldId}/cancel`)
        .set("Authorization", `Bearer ${crmToken}`)
        .set("Idempotency-Key", randomUUID())
        .send({ reason: "probing" });

      // A 403 would confirm the id exists and turn this into an existence oracle.
      expect(res.status).toBe(404);

      // And nothing about it moved.
      expect(await holdRow(theirs.autonomyHoldId)).toMatchObject({
        status: "held",
        cancelledByUserId: null,
      });
    },
    180_000,
  );

  it(
    "a CRM-scoped identity cannot reach payroll or accounting, and a member with no grants cannot reach CRM",
    async () => {
      const get = (path: string, token: string) =>
        http().get(path).set("Authorization", `Bearer ${token}`);

      // Inside its own module, with the key for it.
      expect((await get("/crm/pipelines", crmToken)).status).toBe(200);

      /**
       * Denied, but 402 rather than the 403 the handoff document claims.
       *
       * `authorize()` checks module availability before scope, and
       * `PermissionGuard` maps `NO_MODULE` to `ModuleDisabledException` so the
       * frontend's EntitlementGate can offer to enable the module instead of
       * showing an access-denied dead end. The security property — a CRM token
       * reads nothing outside CRM — holds either way, and is asserted first.
       */
      for (const path of ["/payroll/components", "/accounting/accounts"]) {
        const res = await get(path, crmToken);
        expect(res.status).not.toBe(200);
        expect([402, 403]).toContain(res.status);
        expect(res.status).toBe(402);
      }

      // Inside the enabled module, without the key: this one really is 403.
      expect((await get("/crm/pipelines", plainToken)).status).toBe(403);
      expect((await get("/crm/autonomy/holds", plainToken)).status).toBe(403);
    },
    180_000,
  );

  it(
    "the kill switch cancels what was already decided, not just what comes next",
    async () => {
      const dealId = await seedDeal(org, crmUserId);
      const held = await decideToSendAQuote(org, dealId);
      if (!held.held) throw new Error(`the decision refused to draft: ${held.reason}`);
      expect((await holdRow(held.autonomyHoldId))?.status).toBe("held");

      /**
       * There is no `POST /crm/autonomy/cancel-in-flight`.
       *
       * `cancelInFlight` exists on the service but has exactly one caller:
       * turning the action type off through this route. Blocking new holds
       * alone would leave the more dangerous half running — the messages the
       * system has already committed to and is merely waiting to send.
       */
      const off = await http()
        .patch("/crm/autonomy/switches")
        .set("Authorization", `Bearer ${crmToken}`)
        .set("Idempotency-Key", randomUUID())
        .send({ kind: "quote.sent", enabled: false, reason: "Stopping everything." });
      expect(off.status).toBe(200);

      expect(await holdRow(held.autonomyHoldId)).toMatchObject({
        status: "cancelled",
        cancelledByUserId: crmUserId,
        cancelReason: "Autonomous sending was switched off",
      });

      expect(await decisionRow(held.decisionId)).toMatchObject({
        outcome: "reversed",
        reversedByUserId: crmUserId,
      });
    },
    180_000,
  );
});
