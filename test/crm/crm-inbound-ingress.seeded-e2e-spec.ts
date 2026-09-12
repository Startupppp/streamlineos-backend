import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  activities,
  activityParticipants,
  businessParties,
  inboundEvents,
  orgModules,
  partyIdentifiers,
  workflowRuns,
  workflowSteps,
} from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";
import { readWhatsAppWebhook } from "src/modules/ingress/adapters/whatsapp-webhook";
import {
  whatsAppToInboundEvent,
  type WhatsAppMessageForIngress,
} from "src/modules/ingress/adapters/whatsapp-to-inbound-event";
import {
  FIXTURE_APP_SECRET,
  FIXTURE_BUSINESS_NUMBER,
  FIXTURE_CUSTOMER_NAME,
  deliveryBlock,
  signedDelivery,
  textMessage,
  webhookBody,
} from "src/modules/ingress/adapters/whatsapp-webhook.fixture";
import type { InboundCommunicationEvent } from "src/modules/ingress/inbound-event";

/**
 * Ticket 10's last criterion: the full path, driven from a fixture, with no
 * provider SDK mocked anywhere.
 *
 * Everything the other ingress specs prove, they prove against substitutes — a
 * fake `Db`, a hand-rolled step store, a workflow invoked by calling its
 * handler. That is the right shape for the rules those files own, and it is the
 * wrong shape for this one claim, because every substitute is a place the path
 * could be broken and the test would still pass. The seam is only a seam if a
 * delivery that nobody helped comes out the far end as rows.
 *
 * So nothing here is stubbed:
 *
 *   - The payload is a real WhatsApp Cloud API webhook envelope, signed with
 *     HMAC-SHA256 the way the provider signs one, read by the real
 *     `readWhatsAppWebhook` and normalised by the real
 *     `whatsAppToInboundEvent`. No provider SDK is involved because inbound
 *     WhatsApp *has* no SDK — it is a signed HTTP body, and a body is a
 *     fixture. That is the whole argument for driving this channel here rather
 *     than the mail one, whose sweep genuinely does reach `@composio/core`.
 *   - The event enters over HTTP at `POST /crm/ingress/inbound`, through the
 *     real guards, with a real signed token and a real permission grant.
 *   - The durable workflow is advanced by the real production driver,
 *     `POST /cron/workflow-tick` — not by calling the handler. If the runtime
 *     is unregistered, unclaimable or dead-lettering, this file fails, which is
 *     the failure the unit tests structurally cannot see.
 *   - The assertions read rows back out of Neon.
 *
 * Run with (the 6 GB default in `test:e2e:seeded` cannot boot `AppModule`):
 *   NODE_OPTIONS=--max-old-space-size=12288 pnpm test:e2e:seeded \
 *     --testPathPattern="crm-inbound-ingress"
 *
 * Every fixture is torn down in `afterAll`. `organizations` cascades to
 * business_parties, party_identifiers, activities, activity_participants,
 * inbound_events, autonomous_decisions, workflow_runs and workflow_steps, so
 * deleting the org removes everything this file wrote.
 */

const CRON_SECRET = process.env.CRON_SECRET;

/** The customer's number as `normalisePhoneNumber` writes it. */
const CUSTOMER_E164 = "+919876543210";

interface TickResult {
  readonly ok: boolean;
  readonly claimed?: number;
  readonly skipped?: boolean;
  readonly outcomes?: Record<string, number>;
}

describe(`${SEEDED_HARNESS} inbound ingress — fixture to rows, no provider SDK`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let token: string;

  beforeAll(async () => {
    if (!CRON_SECRET)
      throw new Error(
        "CRON_SECRET must be set: the durable runtime is driven by POST /cron/workflow-tick, and " +
          "advancing the workflow any other way would stop this being an end-to-end test.",
      );

    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      .addMember("rep", { permissionKeys: ["crm:ingress:submit"] })
      .build();

    /**
     * The plan entitlement, which the permission alone does not carry.
     *
     * `PermissionGuard` refuses a `crm:` key with 402 MODULE_NOT_ENABLED when
     * the tenant has no `org_modules` row, and `SeedBuilder` writes none — so a
     * seeded org holds every CRM permission and can reach no CRM route. The
     * other CRM seeded specs never met this because they call services directly;
     * this is the first one to arrive over HTTP.
     *
     * Written before the first request on purpose: the module map is cached for
     * 30 s, so enabling it afterwards would be invisible for the rest of the run.
     */
    await seeded.seedDb.insert(orgModules).values({
      orgId: fixture.orgId,
      moduleKey: "crm",
      enabled: true,
    });

    const rep = fixture.members["rep"];
    if (!rep) throw new Error("fixture member 'rep' missing");
    token = await signSeededToken(seeded, rep.userId, fixture.orgId);
  }, 180_000);

  afterAll(async () => {
    // Ordered: the fixture's rows go before the connections that delete them.
    if (fixture) await fixture.teardown();
    if (seeded) await seeded.close();
  }, 60_000);

  /**
   * The provider's payload, turned into the seam's event by the real adapter.
   *
   * Signed and verified rather than hand-built: the signature covers the bytes
   * as sent, so a fixture that skipped it would not be exercising the one check
   * that makes an unauthenticated push safe to trust.
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

    const block = verdict.deliveries[0];
    const message: WhatsAppMessageForIngress | undefined = block?.messages[0];
    if (!message) throw new Error("fixture carried no message");

    const normalised = whatsAppToInboundEvent(message, {
      organizationId: fixture.orgId,
      provider: "whatsapp",
      businessNumber: FIXTURE_BUSINESS_NUMBER,
    });
    if (!normalised.ok) throw new Error(`adapter skipped the fixture: ${normalised.reason}`);

    return normalised.event;
  }

  function post(event: InboundCommunicationEvent) {
    return request(seeded.app.getHttpServer())
      .post("/crm/ingress/inbound")
      .set("Authorization", `Bearer ${token}`)
      .send(event as unknown as Record<string, unknown>);
  }

  /** The real driver. Nothing else advances a run. */
  async function tick(): Promise<TickResult> {
    const res = await request(seeded.app.getHttpServer())
      .post("/cron/workflow-tick")
      .set("Authorization", `Bearer ${CRON_SECRET ?? ""}`);
    expect(res.status).toBe(200);
    return res.body as TickResult;
  }

  /**
   * Ticks until this run reaches a terminal state, then reports what it was.
   *
   * Polling one named run rather than trusting the tick's `claimed` count,
   * which counts every tenant's runs and would be satisfied by somebody else's
   * work while this one sat untouched. A failed attempt schedules itself into
   * the future with a backoff, so the wait follows `run_after` rather than a
   * guessed sleep — and `lastError` is returned so that a failure here names
   * the step that broke instead of only the row that is missing.
   */
  async function settle(
    workflowRunId: string,
  ): Promise<{ status: string; lastError: string | null; attempt: number }> {
    for (let pass = 0; pass < 6; pass += 1) {
      await tick();

      const [run] = await seeded.seedDb
        .select({
          status: workflowRuns.status,
          lastError: workflowRuns.lastError,
          attempt: workflowRuns.attempt,
          runAfter: workflowRuns.runAfter,
        })
        .from(workflowRuns)
        .where(eq(workflowRuns.workflowRunId, workflowRunId));
      if (!run) throw new Error(`workflow run ${workflowRunId} disappeared`);

      if (run.status === "COMPLETED" || run.status === "DEAD_LETTERED")
        return { status: run.status, lastError: run.lastError, attempt: run.attempt };

      const waitMs = Math.min(Math.max(run.runAfter.getTime() - Date.now(), 0) + 250, 8_000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    const [stuck] = await seeded.seedDb
      .select({ status: workflowRuns.status, lastError: workflowRuns.lastError, attempt: workflowRuns.attempt })
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowRunId, workflowRunId));
    return {
      status: stuck?.status ?? "GONE",
      lastError: stuck?.lastError ?? null,
      attempt: stuck?.attempt ?? -1,
    };
  }

  const partiesInOrg = () =>
    seeded.seedDb
      .select({
        partyId: businessParties.partyId,
        name: businessParties.name,
        whatsappPhone: businessParties.whatsappPhone,
        email: businessParties.email,
      })
      .from(businessParties)
      .where(eq(businessParties.organizationId, fixture.orgId));

  /**
   * The activities this seam filed, and not the ones reasoning about them made.
   *
   * Scoped to `source = 'whatsapp'` — the opaque provider label the seam stamps
   * on — because `extract-and-act` runs for real here and writes task
   * activities of its own (`source = 'extraction'`). Counting every row in the
   * organisation would make this file fail whenever ticket 12 changed what it
   * extracts, which is a fact about a different ticket. What ticket 10 owns is
   * that the message itself is filed exactly once.
   */
  const ingressActivities = () =>
    seeded.seedDb
      .select({
        activityId: activities.activityId,
        kind: activities.kind,
        body: activities.body,
        threadId: activities.threadId,
        partyId: activities.partyId,
        actorKind: activities.actorKind,
        actorLabel: activities.actorLabel,
        source: activities.source,
      })
      .from(activities)
      .where(and(eq(activities.organizationId, fixture.orgId), eq(activities.source, "whatsapp")));

  it(
    "a signed provider payload becomes a party, an activity and its participants",
    async () => {
      const event = eventFromProviderPayload();

      /**
       * The seam accepted it. Nothing is filed yet — the receipt and the run
       * are all that exist at 202, which is the point of the hand-off.
       */
      const accepted = await post(event);
      expect({ status: accepted.status, body: accepted.body as unknown }).toMatchObject({
        status: 202,
        body: { status: "accepted" },
      });
      const { inboundEventId, workflowRunId } = accepted.body as {
        inboundEventId: string;
        workflowRunId: string;
      };
      expect(typeof inboundEventId).toBe("string");
      expect(typeof workflowRunId).toBe("string");

      expect(await partiesInOrg()).toHaveLength(0);

      // The production driver, over HTTP, exactly as the scheduler calls it.
      // A dead-lettered or stuck run fails here with the step's own error.
      expect(await settle(workflowRunId)).toMatchObject({
        status: "COMPLETED",
        lastError: null,
      });

      /**
       * The far end.
       *
       * An unknown sender became a party — named from the WhatsApp profile
       * rather than from the number, which is the thing the envelope reader's
       * extra pass over `contacts` exists to make possible.
       */
      const parties = await partiesInOrg();
      expect(parties).toHaveLength(1);
      expect(parties[0]).toMatchObject({
        name: FIXTURE_CUSTOMER_NAME,
        whatsappPhone: CUSTOMER_E164,
        // A phone number is not an email address. This column staying null is
        // the regression the identifier kinds were introduced for.
        email: null,
      });
      const partyId = parties[0]?.partyId;

      /** Claimed as an identifier, or the next message becomes a second party. */
      const identifiers = await seeded.seedDb
        .select({
          kind: partyIdentifiers.kind,
          value: partyIdentifiers.value,
          normalisedValue: partyIdentifiers.normalisedValue,
          partyId: partyIdentifiers.partyId,
        })
        .from(partyIdentifiers)
        .where(eq(partyIdentifiers.organizationId, fixture.orgId));
      expect(identifiers).toHaveLength(1);
      expect(identifiers[0]).toMatchObject({
        kind: "whatsapp",
        normalisedValue: CUSTOMER_E164,
        partyId,
      });

      /** The message itself, attributed to the system and to its channel. */
      const logged = await ingressActivities();
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        // `message` maps to `note`; there is no WhatsApp activity kind and the
        // seam is not allowed to invent one.
        kind: "note",
        body: "Can you resend the quote? The last one had the old address.",
        partyId,
        actorKind: "system",
        actorLabel: "ingress:message",
        // The opaque label, used as the source and nothing else.
        source: "whatsapp",
      });
      // Threaded on the number pair, so the next message joins this conversation.
      expect(logged[0]?.threadId).toBe(
        `${fixture.orgId}:message:${[CUSTOMER_E164, "+15550001111"].sort().join("|")}`,
      );

      const participants = await seeded.seedDb
        .select({
          address: activityParticipants.address,
          role: activityParticipants.role,
          partyId: activityParticipants.partyId,
        })
        .from(activityParticipants)
        .where(
          and(
            eq(activityParticipants.organizationId, fixture.orgId),
            eq(activityParticipants.activityId, logged[0]?.activityId ?? ""),
          ),
        );
      expect(participants).toHaveLength(2);
      expect(participants).toEqual(
        expect.arrayContaining([
          // The sender is resolved to the party.
          { address: CUSTOMER_E164, role: "from", partyId },
          // The business's own line keeps its address and no party, which is
          // what the nullable column is for.
          { address: "+15550001111", role: "to", partyId: null },
        ]),
      );

      /** The receipt is closed and points at what it produced. */
      const [receipt] = await seeded.seedDb
        .select({
          status: inboundEvents.status,
          partyId: inboundEvents.partyId,
          activityId: inboundEvents.activityId,
        })
        .from(inboundEvents)
        .where(eq(inboundEvents.inboundEventId, inboundEventId));
      expect(receipt).toMatchObject({
        status: "PROCESSED",
        partyId,
        activityId: logged[0]?.activityId,
      });

      /** And it ran as a workflow, one checkpoint per stage. */
      const [run] = await seeded.seedDb
        .select({ status: workflowRuns.status, name: workflowRuns.workflowName })
        .from(workflowRuns)
        .where(eq(workflowRuns.workflowRunId, workflowRunId));
      expect(run).toMatchObject({ status: "COMPLETED", name: "crm.inbound-communication" });

      const steps = await seeded.seedDb
        .select({ stepName: workflowSteps.stepName, status: workflowSteps.status })
        .from(workflowSteps)
        .where(eq(workflowSteps.workflowRunId, workflowRunId));
      expect(steps.map((s) => s.stepName).sort()).toEqual(
        [
          "extract-and-act",
          "log-activity",
          "mark-processed",
          // P4-in. The relationship materialiser was added to the workflow and
          // this list was not updated with it, so the assertion has been failing
          // since — which nobody saw, because the suite it lives in could not be
          // run. An exact set rather than a subset is the point: a step that
          // stops running is as much a defect as one that appears unannounced.
          "materialise-relationship",
          "record-participants",
          "resolve-party",
          "resolve-region",
          "shadow-score",
        ].sort(),
      );
      expect(steps.every((s) => s.status === "COMPLETED")).toBe(true);
    },
    180_000,
  );

  it(
    "the same delivery twice produces exactly one set of consequences",
    async () => {
      // Byte-for-byte the delivery already filed above.
      const event = eventFromProviderPayload();

      const again = await post(event);
      expect({ status: again.status, body: again.body as unknown }).toMatchObject({
        status: 202,
        body: { status: "duplicate" },
      });

      await tick();

      expect(await partiesInOrg()).toHaveLength(1);
      expect(await ingressActivities()).toHaveLength(1);
    },
    120_000,
  );

  it(
    "a second message from a known sender matches the party instead of duplicating it",
    async () => {
      const event = eventFromProviderPayload({
        id: `wamid.${randomUUID().replace(/-/g, "")}`,
        text: { body: "Also, can you confirm the delivery date for the revised order?" },
      });

      const accepted = await post(event);
      expect(accepted.status).toBe(202);
      expect(accepted.body as unknown).toMatchObject({ status: "accepted" });
      const { workflowRunId } = accepted.body as { workflowRunId: string };

      expect(await settle(workflowRunId)).toMatchObject({
        status: "COMPLETED",
        lastError: null,
      });

      // Two messages, one customer — which is the whole reason
      // `party_identifiers` is matched on the normalised value.
      expect(await partiesInOrg()).toHaveLength(1);
      const logged = await ingressActivities();
      expect(logged).toHaveLength(2);
      // Both on the same thread, both against the same party.
      expect(new Set(logged.map((a) => a.threadId)).size).toBe(1);
      expect(new Set(logged.map((a) => a.partyId)).size).toBe(1);
    },
    120_000,
  );

  it(
    "an event for an unknown organisation is 404 and creates nothing",
    async () => {
      const stranger = randomUUID();
      const event = { ...eventFromProviderPayload(), organizationId: stranger };

      const res = await post(event as InboundCommunicationEvent);
      // A tenant the caller cannot see is absent, never forbidden.
      expect(res.status).toBe(404);

      const [orphan] = await seeded.seedDb
        .select({ inboundEventId: inboundEvents.inboundEventId })
        .from(inboundEvents)
        .where(eq(inboundEvents.organizationId, stranger));
      expect(orphan).toBeUndefined();

      const [orphanRun] = await seeded.seedDb
        .select({ workflowRunId: workflowRuns.workflowRunId })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.organizationId, stranger),
            eq(workflowRuns.workflowName, "crm.inbound-communication"),
          ),
        );
      expect(orphanRun).toBeUndefined();
    },
    120_000,
  );
});
