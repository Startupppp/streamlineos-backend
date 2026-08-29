import request from "supertest";
import { and, eq, isNull } from "drizzle-orm";
import {
  activities,
  autonomousDecisions,
  autonomyHolds,
  autonomySettings,
  businessParties,
  crmOutboundMessages,
  deals,
  organizations,
  orgModules,
  relationshipStates,
  users,
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
import { isWithinWorkingHours } from "src/modules/autonomy/working-hours";

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

/** The zone the working-hours rule is judged in for this fixture. */
const ORG_TIMEZONE = "Asia/Kolkata";

interface TickResult {
  readonly ok: boolean;
  readonly claimed?: number;
}

describe(`${SEEDED_HARNESS} CRM golden path — stranger to held send`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let token: string;
  let repUserId: string;
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

    /**
     * A known timezone, because the send window is judged in it.
     *
     * `send-guardrails` resolves the party's zone and falls back to the
     * organisation's; leaving it to a fallback would make which arm of the last
     * test runs depend on a default rather than on something this file states.
     */
    await seeded.seedDb
      .update(organizations)
      .set({ timezone: ORG_TIMEZONE })
      .where(eq(organizations.id, fixture.orgId));

    // Ten seconds instead of sixty, so the release leg is a wait and not a nap.
    await seeded.seedDb.insert(autonomySettings).values({
      organizationId: fixture.orgId,
      holdWindowSeconds: HOLD_WINDOW_SECONDS,
    });

    const rep = fixture.members["rep"];
    if (!rep) throw new Error("fixture member 'rep' missing");
    repUserId = rep.userId;

    /**
     * A name, because the draft is written as somebody.
     *
     * `composeAndHold` refuses before it spends anything when the deal has no
     * salesperson to write as — `judgeDraft`'s `no-sender-name`, checked early
     * so a sweep over unowned parties is not billed for drafts nobody may send.
     * `SeedBuilder` leaves `users.name` null, so without this the compose is a
     * refusal and the hold path is never reached.
     */
    await seeded.seedDb
      .update(users)
      .set({ name: "Riya Sharma" })
      .where(eq(users.id, rep.userId));

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

  /** A refusal is a 201 too, so the reason has to be the failure message. */
  function expectHeld(body: unknown): void {
    const outcome = body as { held?: boolean; stage?: string; reason?: string };
    if (!outcome.held)
      throw new Error(
        `composeAndHold refused at ${outcome.stage ?? "?"}: ${outcome.reason ?? JSON.stringify(body)}`,
      );
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

      /**
       * An address to reach them at.
       *
       * The party arrived over WhatsApp, so identity resolution gave it a phone
       * number and nothing else; outbound composes email, and `judgeOutbound`
       * refuses at eligibility without one rather than drafting a message it
       * cannot send. Filling it in is what the rep does on the record — the
       * inbound channel and the outbound channel are not obliged to be the same
       * one, and this file is about the hold, not about identity resolution.
       */
      await seeded.seedDb
        .update(businessParties)
        .set({ email: "ops@acme.example" })
        .where(
          and(
            eq(businessParties.organizationId, fixture.orgId),
            eq(businessParties.partyId, party.partyId),
          ),
        );

      /**
       * The rep does the thing, and says so.
       *
       * `judgeOutbound` refuses while the outstanding next step is ours — "the
       * outstanding next step is ours, so chasing them would be wrong", which is
       * the rule working, not an obstacle. The first test's extraction filed
       * exactly such a task ("send pricing"), so without closing it this file
       * would be asking the system to nag a customer it owes an answer.
       *
       * Closed here rather than never created, because the sequence is the
       * point: the message arrives, a task comes out of it, somebody does the
       * task, and only then does the follow-up loop have anything to say.
       */
      await seeded.seedDb
        .update(activities)
        .set({ completedAt: new Date() })
        .where(
          and(
            eq(activities.organizationId, fixture.orgId),
            eq(activities.kind, "task"),
            isNull(activities.completedAt),
          ),
        );

      /**
       * The relationship the follow-up loop is for: we spoke last, and they have
       * gone quiet.
       *
       * `judgeOutbound` refuses everything else, and each refusal is the rule
       * working. It will not write while the ball is ours (`awaiting_reply_since`
       * null), will not chase somebody who has just replied
       * (`last_inbound_at > last_outbound_at`), and will not nudge an open deal
       * that has been quiet for less than ten days. So the state is set to the
       * one the ticket describes — a fortnight of silence on an open deal after
       * our own last message — rather than to whatever the inbound fixture
       * happened to leave.
       *
       * Set directly because this file is about the hold contract. That the
       * judgement itself is right is `outbound-eligibility.spec.ts`, which is
       * pure and covers every branch of it.
       */
      const day = 86_400_000;
      const [tuned] = await seeded.seedDb
        .update(relationshipStates)
        .set({
          lastInboundAt: new Date(Date.now() - 20 * day),
          lastOutboundAt: new Date(Date.now() - 15 * day),
          awaitingReplySince: new Date(Date.now() - 15 * day),
        })
        .where(
          and(
            eq(relationshipStates.organizationId, fixture.orgId),
            eq(relationshipStates.partyId, party.partyId),
          ),
        )
        .returning({ id: relationshipStates.relationshipStateId });
      if (!tuned)
        throw new Error("the inbound run did not materialise a relationship to tune");

      // The rep opens the deal. Nothing opens one autonomously -- see the file
      // docblock; this is the leg `pending.md` specifies and the branch lacks.
      const [opened] = await seeded.seedDb
        .insert(deals)
        .values({
          orgId: fixture.orgId,
          name: "40 seats — inbound",
          partyId: party.partyId,
          // Owned, so there is somebody to write as. See the note in `beforeAll`.
          assignedToId: repUserId,
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
      // Asserted on the body, not only the status: a refusal is also a 201, and
      // `reason` is the difference between "the hold path is broken" and "the
      // fixture gave it nothing to write". Thrown rather than `expect`ed so the
      // reason itself is the failure message.
      expectHeld(composed.body);

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
        // `@Idempotent`: a retried stop must not become a second cancellation.
        .set("Idempotency-Key", `golden-path-cancel-${held.holdId}`)
        .send({ reason: "Not while we owe them a proposal." });
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
      expectHeld(composed.body);

      const [held] = await seeded.seedDb
        .select({
          holdId: autonomyHolds.autonomyHoldId,
          runId: autonomyHolds.workflowRunId,
          holdUntil: autonomyHolds.holdUntil,
        })
        .from(autonomyHolds)
        .where(
          and(
            eq(autonomyHolds.organizationId, fixture.orgId),
            eq(autonomyHolds.status, "held"),
          ),
        );
      if (!held) throw new Error("composing did not place a second hold");

      /**
       * Waited out against the hold's own `hold_until`, not against the number
       * this file asked for.
       *
       * `resolveHold` refuses to send before the window is up — correctly, since
       * a send cannot be taken back — so a test that guessed short would read a
       * still-sleeping run as a failure to send. Reading the deadline the server
       * actually stamped is both shorter to wait for when the setting applied and
       * correct when it did not.
       */
      const waitMs = held.holdUntil.getTime() - Date.now() + 2_000;
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      if (!held.runId) throw new Error("the hold was placed without a workflow run to release it");

      const outcome = await settle(held.runId);

      /**
       * Which of the two right answers this is depends on the clock, and both
       * are asserted.
       *
       * `OUTBOUND_WORKING_HOURS` is a constant and explicitly "not a setting" —
       * a tenant cannot ask to mail its customers at midnight. So a run whose
       * window elapses outside 09:00–17:00 local, Monday to Friday, is deferred
       * to the next opening rather than sent, and a test that only asserted the
       * send would fail every evening and every weekend for a reason that is the
       * product working.
       *
       * Asserting both arms is what makes this deterministic, and the second arm
       * is the one `pending.md` asks for in as many words: "3am local is not
       * sent". Nothing else in the seeded suite covers it.
       */
      const sendable = isWithinWorkingHours(new Date(), ORG_TIMEZONE);

      const [after] = await seeded.seedDb
        .select({ status: autonomyHolds.status, sentAt: autonomyHolds.sentAt })
        .from(autonomyHolds)
        .where(eq(autonomyHolds.autonomyHoldId, held.holdId));

      if (!sendable) {
        // Deferred, not dropped: still held, nothing sent, and the run is asleep
        // waiting for the window rather than finished.
        expect(after?.status).toBe("held");
        expect(after?.sentAt).toBeNull();

        const [run] = await seeded.seedDb
          .select({ status: workflowRuns.status, runAfter: workflowRuns.runAfter })
          .from(workflowRuns)
          .where(eq(workflowRuns.workflowRunId, held.runId));
        expect(run?.status).toBe("SLEEPING");
        // It wakes inside working hours, which is the whole point of deferring.
        expect(isWithinWorkingHours(run?.runAfter ?? new Date(0), ORG_TIMEZONE)).toBe(true);
        return;
      }

      if (outcome !== "COMPLETED") {
        const [run] = await seeded.seedDb
          .select({ status: workflowRuns.status, lastError: workflowRuns.lastError })
          .from(workflowRuns)
          .where(eq(workflowRuns.workflowRunId, held.runId));
        throw new Error(
          `the hold's run did not complete: settle=${outcome} status=${run?.status ?? "GONE"} — ${run?.lastError ?? "no error recorded"}`,
        );
      }

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
