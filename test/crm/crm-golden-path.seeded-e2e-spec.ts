import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  activities,
  autonomousDecisions,
  autonomyHolds,
  autonomySettings,
  businessParties,
  crmOutboundMessages,
  deals,
  orgModules,
  workflowRuns,
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
  deliveryBlock,
  signedDelivery,
  textMessage,
  webhookBody,
} from "src/modules/ingress/adapters/whatsapp-webhook.fixture";
import type { InboundCommunicationEvent } from "src/modules/ingress/inbound-event";

/**
 * G1 — the golden path, driven end to end with nothing stubbed.
 *
 * A stranger writes in; the CRM makes a person out of them, files the message,
 * reads it, and decides what to do next. A rep opens a deal. The system drafts
 * the follow-up and holds it. A human stops one, and lets the next one go.
 *
 * ## What this file does and does not claim
 *
 * `pending.md` specifies the path as:
 *
 *     inbound → party → deal opened → extract → quote drafted into hold
 *     → stop within window → no send → hold expires → send recorded
 *
 * Two of those legs have no production caller on this branch, and this file
 * asserts what is wired rather than pretending otherwise:
 *
 *   - **"deal opened"** — nothing opens a deal autonomously.
 *     `autonomy-actions.service.ts` implements exactly two actions,
 *     `applyNextStep` and `applyStageAdvance`, and the decision ledger records
 *     exactly two kinds, `task.extracted` and `stage.advanced`. Every insert
 *     into `deals` in the codebase is a human path, an import, or the demo seed.
 *     So the deal here is created the way one is created today — by the rep —
 *     and the autonomous half picks up from it.
 *
 *   - **"quote drafted into hold"** — `AutonomyHoldService.generateAndHoldQuote`
 *     has no caller anywhere in `src/`, and no test. It is unreached code. The
 *     hold machinery it would use is real and is exercised below through
 *     `composeAndHold`, which is wired to `POST /crm/autonomy/outbound` and does
 *     place, cancel and release holds. The hold contract is therefore proven;
 *     the quote-shaped entry into it does not exist to prove.
 *
 * Both are recorded in `docs/crm-final-handoff.md`. Neither is a gap this file
 * can close by testing harder.
 *
 * ## Why it is shaped like this
 *
 * Nothing is substituted. The payload is a real signed WhatsApp Cloud API
 * webhook read by the real reader and normalised by the real adapter; the event
 * enters over HTTP through the real guards; the durable workflow is advanced by
 * the production driver at `POST /cron/workflow-tick` rather than by calling a
 * handler; and every assertion reads rows back out of the database. A
 * substitute anywhere is a place the path could be broken with this still green.
 *
 * The hold window is set to its floor of ten seconds for this org, so the
 * release leg waits about twelve rather than sixty. `clampHoldWindow` will not
 * accept less.
 *
 * Run with (the 6 GB default cannot boot `AppModule`):
 *   NODE_OPTIONS=--max-old-space-size=12288 pnpm test:e2e:seeded \
 *     --testPathPattern="crm-golden-path"
 *
 * `organizations` cascades to everything this writes, so the fixture teardown
 * removes it all.
 */

const CRON_SECRET = process.env.CRON_SECRET;

/** The floor `clampHoldWindow` enforces. Anything lower is raised to this. */
const HOLD_WINDOW_SECONDS = 10;

interface TickResult {
  readonly ok: boolean;
  readonly claimed?: number;
}

describe(`${SEEDED_HARNESS} CRM golden path — stranger to held send`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let token: string;
  let dealId: number;

  beforeAll(async () => {
    if (!CRON_SECRET)
      throw new Error(
        "CRON_SECRET must be set: the durable runtime is driven by POST /cron/workflow-tick, " +
          "and advancing the workflow any other way would stop this being end-to-end.",
      );

    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      .addMember("rep", {
        permissionKeys: [
          "crm:ingress:submit",
          "crm:autonomy:manage",
          "crm:autonomy:view",
          "crm:autonomy:reverse",
        ],
      })
      .build();

    // The entitlement the permission does not carry: `PermissionGuard` answers
    // 402 on a `crm:` key with no `org_modules` row. Written before the first
    // request, because the module map is cached for 30 s.
    await seeded.seedDb
      .insert(orgModules)
      .values({ orgId: fixture.orgId, moduleKey: "crm", enabled: true });

    // Ten seconds instead of sixty, so the release leg is a wait and not a nap.
    await seeded.seedDb.insert(autonomySettings).values({
      organizationId: fixture.orgId,
      holdWindowSeconds: HOLD_WINDOW_SECONDS,
    });

    const rep = fixture.members["rep"];
    if (!rep) throw new Error("fixture member 'rep' missing");
    token = await signSeededToken(rep.userId, fixture.orgId);
  }, 180_000);

  afterAll(async () => {
    if (fixture) await fixture.teardown();
    if (seeded) await seeded.close();
  }, 60_000);

  /** A provider payload turned into the seam's event by the real adapter. */
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
      organizationId: fixture.orgId,
      provider: "whatsapp",
      businessNumber: FIXTURE_BUSINESS_NUMBER,
    });
    if (!normalised.ok) throw new Error(`adapter skipped the fixture: ${normalised.reason}`);

    return normalised.event;
  }

  async function tick(): Promise<TickResult> {
    const res = await request(seeded.app.getHttpServer())
      .post("/cron/workflow-tick")
      .set("Authorization", `Bearer ${CRON_SECRET ?? ""}`);
    expect(res.status).toBe(200);
    return res.body as TickResult;
  }

  /** Tick until a named run is terminal, following its own backoff. */
  async function settle(workflowRunId: string): Promise<string> {
    for (let pass = 0; pass < 8; pass += 1) {
      await tick();

      const [run] = await seeded.seedDb
        .select({ status: workflowRuns.status, runAfter: workflowRuns.runAfter })
        .from(workflowRuns)
        .where(eq(workflowRuns.workflowRunId, workflowRunId));
      if (!run) throw new Error(`workflow run ${workflowRunId} disappeared`);
      if (run.status === "COMPLETED" || run.status === "DEAD_LETTERED") return run.status;

      const waitMs = Math.min(Math.max(run.runAfter.getTime() - Date.now(), 0) + 250, 8_000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    return "STUCK";
  }

  it(
    "turns a stranger's message into a party, a filed activity and an extracted next step",
    async () => {
      const event = eventFromProviderPayload({ body: "Hi — can you send pricing for 40 seats?" });

      const res = await request(seeded.app.getHttpServer())
        .post("/crm/ingress/inbound")
        .set("Authorization", `Bearer ${token}`)
        .send(event as unknown as Record<string, unknown>);
      expect(res.status).toBe(202);

      const runId = (res.body as { workflowRunId?: string }).workflowRunId;
      if (!runId) throw new Error("ingress did not return a workflow run to drive");
      expect(await settle(runId)).toBe("COMPLETED");

      // A person now exists who did not before, made from an identifier rather
      // than from anything inferred about the text.
      const parties = await seeded.seedDb
        .select({ partyId: businessParties.partyId })
        .from(businessParties)
        .where(eq(businessParties.organizationId, fixture.orgId));
      expect(parties).toHaveLength(1);

      const filed = await seeded.seedDb
        .select({ activityId: activities.activityId })
        .from(activities)
        .where(
          and(
            eq(activities.organizationId, fixture.orgId),
            eq(activities.source, "whatsapp"),
          ),
        );
      expect(filed).toHaveLength(1);

      // The autonomous half ran and left a record of what it decided.
      const decisions = await seeded.seedDb
        .select({ kind: autonomousDecisions.kind })
        .from(autonomousDecisions)
        .where(eq(autonomousDecisions.organizationId, fixture.orgId));
      expect(decisions.length).toBeGreaterThan(0);
    },
    180_000,
  );

  it(
    "stops a held send inside the window, and nothing leaves",
    async () => {
      const [party] = await seeded.seedDb
        .select({ partyId: businessParties.partyId })
        .from(businessParties)
        .where(eq(businessParties.organizationId, fixture.orgId));
      if (!party) throw new Error("the first test did not leave a party to write to");

      // The rep opens the deal. Nothing opens one autonomously -- see the file
      // docblock; this is the leg `pending.md` specifies and the branch lacks.
      const [opened] = await seeded.seedDb
        .insert(deals)
        .values({
          orgId: fixture.orgId,
          name: "40 seats — inbound",
          partyId: party.partyId,
        })
        .returning({ id: deals.id });
      if (!opened) throw new Error("could not open the deal");
      dealId = opened.id;

      const composed = await request(seeded.app.getHttpServer())
        .post("/crm/autonomy/outbound")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", `golden-path-stop-${fixture.orgId}`)
        .send({ partyId: party.partyId, dealId: String(dealId) });
      expect(composed.status).toBe(201);

      const [held] = await seeded.seedDb
        .select({
          holdId: autonomyHolds.autonomyHoldId,
          status: autonomyHolds.status,
          messageId: autonomyHolds.outboundMessageId,
        })
        .from(autonomyHolds)
        .where(eq(autonomyHolds.organizationId, fixture.orgId));
      if (!held) throw new Error("composing did not place a hold");
      expect(held.status).toBe("held");

      // The stop, inside the window.
      const cancelled = await request(seeded.app.getHttpServer())
        .post(`/crm/autonomy/holds/${held.holdId}/cancel`)
        .set("Authorization", `Bearer ${token}`)
        .send({});
      expect(cancelled.status).toBeLessThan(300);

      // Let the window pass and drive the runtime anyway: a cancelled hold that
      // still sends when its timer fires is the failure worth testing for.
      await new Promise((resolve) => setTimeout(resolve, (HOLD_WINDOW_SECONDS + 3) * 1000));
      await tick();
      await tick();

      const [after] = await seeded.seedDb
        .select({ status: autonomyHolds.status, sentAt: autonomyHolds.sentAt })
        .from(autonomyHolds)
        .where(eq(autonomyHolds.autonomyHoldId, held.holdId));
      expect(after?.status).toBe("cancelled");
      expect(after?.sentAt).toBeNull();

      if (held.messageId) {
        const [message] = await seeded.seedDb
          .select({ status: crmOutboundMessages.status })
          .from(crmOutboundMessages)
          .where(eq(crmOutboundMessages.outboundMessageId, held.messageId));
        expect(message?.status).not.toBe("sent");
      }
    },
    180_000,
  );

  it(
    "lets the next one go when its window runs out, and records the send",
    async () => {
      const [party] = await seeded.seedDb
        .select({ partyId: businessParties.partyId })
        .from(businessParties)
        .where(eq(businessParties.organizationId, fixture.orgId));
      if (!party) throw new Error("no party to write to");

      const composed = await request(seeded.app.getHttpServer())
        .post("/crm/autonomy/outbound")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", `golden-path-release-${fixture.orgId}`)
        .send({ partyId: party.partyId, dealId: String(dealId) });
      expect(composed.status).toBe(201);

      const [held] = await seeded.seedDb
        .select({ holdId: autonomyHolds.autonomyHoldId, runId: autonomyHolds.workflowRunId })
        .from(autonomyHolds)
        .where(
          and(
            eq(autonomyHolds.organizationId, fixture.orgId),
            eq(autonomyHolds.status, "held"),
          ),
        );
      if (!held) throw new Error("composing did not place a second hold");

      await new Promise((resolve) => setTimeout(resolve, (HOLD_WINDOW_SECONDS + 3) * 1000));
      if (held.runId) await settle(held.runId);
      else {
        await tick();
        await tick();
      }

      const [after] = await seeded.seedDb
        .select({ status: autonomyHolds.status, sentAt: autonomyHolds.sentAt })
        .from(autonomyHolds)
        .where(eq(autonomyHolds.autonomyHoldId, held.holdId));

      // The send is recorded, and recorded once.
      expect(after?.status).toBe("sent");
      expect(after?.sentAt).not.toBeNull();

      // Driving the runtime again must not send it a second time.
      const sentAtFirst = after?.sentAt;
      await tick();
      const [again] = await seeded.seedDb
        .select({ status: autonomyHolds.status, sentAt: autonomyHolds.sentAt })
        .from(autonomyHolds)
        .where(eq(autonomyHolds.autonomyHoldId, held.holdId));
      expect(again?.status).toBe("sent");
      expect(again?.sentAt).toEqual(sentAtFirst);
    },
    180_000,
  );
});
