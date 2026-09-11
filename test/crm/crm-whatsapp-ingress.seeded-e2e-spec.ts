import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import {
  activities,
  businessParties,
  crmWhatsappChannels,
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
import { signPayload } from "src/modules/ingress/adapters/mailbox-push";
import {
  deliveryBlock,
  textMessage,
  webhookBody,
} from "src/modules/ingress/adapters/whatsapp-webhook.fixture";

/**
 * The WhatsApp channel, against a real database, under real row-level security.
 *
 * The controller suite proves the HTTP contract against substitutes. This one
 * exists for the single claim substitutes structurally cannot check: that an
 * unauthenticated delivery, carrying no session and no organisation, finds its
 * tenant.
 *
 * That claim rests on something invisible to every other test in the repo.
 * `crm_whatsapp_channels` is behind `tenant_isolation`, so the lookup that
 * finds which secret to verify against runs with no tenant context — and a
 * context-less read of a tenant-owned table returns **nothing**, silently. The
 * mailbox push endpoint next door resolves its tenant with a plain
 * `this.db.select()` and is, for that reason, believed not to work under RLS at
 * all. Nothing catches it, because no seeded spec drives it.
 *
 * So the resolver here is a SECURITY DEFINER function (0657), and this file is
 * the only place that difference is visible. Run it against the application
 * role, never the owner:
 *
 *   NODE_OPTIONS=--max-old-space-size=12288 \
 *   APP_DATABASE_URL=postgres://streamline_app:...@host/db \
 *   pnpm test:e2e:seeded --testPathPattern="crm-whatsapp-ingress"
 *
 * With `DATABASE_URL` pointing at an owner that has BYPASSRLS, every policy is
 * inert and this file proves nothing — which is why it refuses to run that way.
 */

const CRON_SECRET = process.env.CRON_SECRET;

/** The customer's number as `normalisePhoneNumber` writes it. */
const CUSTOMER_E164 = "+919876543210";

const APP_SECRET = "seeded-whatsapp-app-secret-32ch";

describe(`${SEEDED_HARNESS} WhatsApp ingress — an unauthenticated delivery finds its tenant`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let neighbour: SeededFixture;
  let channelId: string;
  let neighbourChannelId: string;
  let line: string;
  let neighbourLine: string;

  beforeAll(async () => {
    if (!CRON_SECRET)
      throw new Error(
        "CRON_SECRET must be set: the durable runtime is driven by POST /cron/workflow-tick, and " +
          "advancing the workflow any other way would stop this being an end-to-end test.",
      );

    /**
     * `rawBody` for the same reason the controller reads it: the signature
     * covers the bytes as sent. Without it the handler verifies the empty
     * string, refuses every delivery, and this file would report a dead
     * endpoint as a working one.
     */
    seeded = await createSeededE2eApp({ rawBody: true });

    /**
     * Two organisations, because the interesting failure is not "does it
     * work" — it is "does it work for the wrong tenant". A resolver that
     * returned the first row it found would pass every single-org test ever
     * written.
     */
    fixture = await seedOrg(seeded.seedDb)
      .addMember("rep", { permissionKeys: ["crm:ingress:submit"] })
      .build();
    neighbour = await seedOrg(seeded.seedDb)
      .addMember("rep", { permissionKeys: ["crm:ingress:submit"] })
      .build();

    for (const org of [fixture, neighbour])
      await seeded.seedDb
        .insert(orgModules)
        .values({ orgId: org.orgId, moduleKey: "crm", enabled: true });

    // Unique per run, so repeated runs do not collide on the global unique index.
    const stamp = randomUUID().replace(/\D/g, "").slice(0, 9).padEnd(9, "0");
    line = `1${stamp}`;
    neighbourLine = `2${stamp}`;

    channelId = await bindLine(fixture, line, "15550001111");
    neighbourChannelId = await bindLine(neighbour, neighbourLine, "15550002222");
  }, 180_000);

  afterAll(async () => {
    if (fixture) await fixture.teardown();
    if (neighbour) await neighbour.teardown();
    if (seeded) await seeded.close();
  }, 60_000);

  /** Binds a line through the real management API, as a real member would. */
  async function bindLine(
    org: SeededFixture,
    phoneNumberId: string,
    businessNumber: string,
  ): Promise<string> {
    const member = org.members["rep"];
    if (!member) throw new Error("fixture member 'rep' missing");
    const token = await signSeededToken(seeded, member.userId, org.orgId);

    const res = await request(seeded.app.getHttpServer())
      .post("/crm/ingress/whatsapp-channels")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `bind-${phoneNumberId}`)
      .send({ businessPhoneNumberId: phoneNumberId, businessNumber, appSecret: APP_SECRET });

    if (res.status !== 201)
      throw new Error(`could not bind ${phoneNumberId}: ${res.status} ${JSON.stringify(res.body)}`);

    return (res.body as { crmWhatsappChannelId: string }).crmWhatsappChannelId;
  }

  /** A delivery for a line, signed the way the provider signs one. */
  function delivery(phoneNumberId: string, body?: string) {
    const raw =
      body ??
      JSON.stringify(
        webhookBody([
          deliveryBlock({
            messages: [textMessage({ id: `wamid.${randomUUID()}` })],
            phoneNumberId,
          }),
        ]),
      );
    return { raw, signature: `sha256=${signPayload(APP_SECRET, raw)}` };
  }

  function deliver(path: string, raw: string, signature?: string) {
    const req = request(seeded.app.getHttpServer())
      .post(path)
      .set("Content-Type", "application/json");
    return signature ? req.set("x-hub-signature-256", signature).send(raw) : req.send(raw);
  }

  async function tick(): Promise<void> {
    const res = await request(seeded.app.getHttpServer())
      .post("/cron/workflow-tick")
      .set("Authorization", `Bearer ${CRON_SECRET ?? ""}`);
    expect(res.status).toBe(200);
  }

  /** Ticks until the run this delivery started reaches a terminal state. */
  async function settle(orgId: string): Promise<string> {
    for (let pass = 0; pass < 6; pass += 1) {
      await tick();
      const [run] = await seeded.seedDb
        .select({ status: workflowRuns.status, lastError: workflowRuns.lastError })
        .from(workflowRuns)
        .where(eq(workflowRuns.organizationId, orgId))
        .orderBy(sql`${workflowRuns.createdAt} DESC`)
        .limit(1);

      if (run?.status === "COMPLETED") return "COMPLETED";
      if (run?.status === "DEAD_LETTERED")
        throw new Error(`the run dead-lettered: ${run.lastError ?? "no error recorded"}`);
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    return "STUCK";
  }

  const partiesIn = (orgId: string) =>
    seeded.seedDb
      .select({ partyId: businessParties.partyId, whatsappPhone: businessParties.whatsappPhone })
      .from(businessParties)
      .where(eq(businessParties.organizationId, orgId));

  const whatsappActivitiesIn = (orgId: string) =>
    seeded.seedDb
      .select({ activityId: activities.activityId, body: activities.body })
      .from(activities)
      .where(and(eq(activities.organizationId, orgId), eq(activities.source, "whatsapp")));

  const channelRow = (crmWhatsappChannelId: string) =>
    seeded.seedDb
      .select({
        organizationId: crmWhatsappChannels.organizationId,
        appSecret: crmWhatsappChannels.appSecret,
        verifyToken: crmWhatsappChannels.verifyToken,
        lastDeliveryAt: crmWhatsappChannels.lastDeliveryAt,
        lastAcceptedAt: crmWhatsappChannels.lastAcceptedAt,
        lastNote: crmWhatsappChannels.lastNote,
      })
      .from(crmWhatsappChannels)
      .where(eq(crmWhatsappChannels.crmWhatsappChannelId, crmWhatsappChannelId));

  it(
    "stores the provider's secret as ciphertext, in the column",
    async () => {
      const [row] = await channelRow(channelId);

      expect(row?.appSecret).toEqual(expect.stringMatching(/^enc:v1:/));
      expect(row?.appSecret).not.toContain(APP_SECRET);
      expect(row?.verifyToken).toEqual(expect.stringMatching(/^enc:v1:/));
    },
    60_000,
  );

  it(
    "a signed delivery with no session becomes a party and an activity",
    async () => {
      expect(await partiesIn(fixture.orgId)).toHaveLength(0);

      const { raw, signature } = delivery(line);
      const res = await deliver(`/crm/ingress/whatsapp/${channelId}`, raw, signature);

      expect({ status: res.status, body: res.body as unknown }).toMatchObject({
        status: 200,
        body: { received: 1, delivered: 1, foreign: 0, note: null },
      });

      expect(await settle(fixture.orgId)).toBe("COMPLETED");

      const parties = await partiesIn(fixture.orgId);
      expect(parties).toHaveLength(1);
      expect(parties[0]?.whatsappPhone).toBe(CUSTOMER_E164);
      expect(await whatsappActivitiesIn(fixture.orgId)).toHaveLength(1);
    },
    180_000,
  );

  it(
    "records what the delivery came to, on the channel",
    async () => {
      const [row] = await channelRow(channelId);

      expect(row?.lastDeliveryAt).toBeInstanceOf(Date);
      expect(row?.lastAcceptedAt).toBeInstanceOf(Date);
      expect(row?.lastNote).toBeNull();
    },
    60_000,
  );

  it(
    "refuses a tampered signature and writes nothing",
    async () => {
      const before = (await whatsappActivitiesIn(fixture.orgId)).length;
      const { raw } = delivery(line);

      const res = await deliver(
        `/crm/ingress/whatsapp/${channelId}`,
        raw,
        `sha256=${"0".repeat(64)}`,
      );

      expect(res.status).toBe(401);
      await tick();
      expect(await whatsappActivitiesIn(fixture.orgId)).toHaveLength(before);

      const [row] = await channelRow(channelId);
      expect(row?.lastNote).toBe("delivery refused: bad-signature");
    },
    120_000,
  );

  /**
   * The one that only two organisations can ask.
   *
   * A correctly signed delivery, on a real channel, for a line that belongs to
   * somebody else. Every signature check passes — on a shared provider app the
   * secret would genuinely be the same — and the delivery must still file
   * nothing, because matching the line is what decides the tenant.
   */
  it(
    "will not file one organisation's line against another's channel",
    async () => {
      const before = (await whatsappActivitiesIn(neighbour.orgId)).length;
      const { raw, signature } = delivery(line);

      const res = await deliver(`/crm/ingress/whatsapp/${neighbourChannelId}`, raw, signature);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ received: 0, delivered: 0, foreign: 1 });
      expect(String((res.body as { note: string }).note)).toContain("different business line");

      await tick();
      expect(await whatsappActivitiesIn(neighbour.orgId)).toHaveLength(before);
    },
    120_000,
  );

  /**
   * The shared callback URL, where the tenant comes only from the body. This is
   * the path with no channel id to lean on, so it is the one that actually
   * exercises `app.resolve_whatsapp_channel_org_id` — and it must land in the
   * neighbour's organisation, not in the first one the table happens to hold.
   */
  it(
    "routes a shared-url delivery to the organisation that owns the line",
    async () => {
      expect(await partiesIn(neighbour.orgId)).toHaveLength(0);

      const { raw, signature } = delivery(neighbourLine);
      const res = await deliver("/crm/ingress/whatsapp", raw, signature);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ received: 1, delivered: 1 });

      expect(await settle(neighbour.orgId)).toBe("COMPLETED");
      expect(await partiesIn(neighbour.orgId)).toHaveLength(1);
      expect(await whatsappActivitiesIn(neighbour.orgId)).toHaveLength(1);
    },
    180_000,
  );

  it(
    "refuses a line nobody has bound, the same way it refuses a forgery",
    async () => {
      const { raw, signature } = delivery("400000000000000");

      const unknown = await deliver("/crm/ingress/whatsapp", raw, signature);
      const forged = await deliver(
        "/crm/ingress/whatsapp",
        delivery(line).raw,
        `sha256=${"0".repeat(64)}`,
      );

      expect(unknown.status).toBe(401);
      expect(unknown.status).toBe(forged.status);
      expect(unknown.body).toEqual(forged.body);
    },
    120_000,
  );

  /**
   * A disabled channel is off. Both resolvers filter on `enabled`, so this is
   * the difference between pausing a feed and having to give the number up.
   */
  it(
    "stops delivering once the channel is disabled",
    async () => {
      const member = fixture.members["rep"];
      if (!member) throw new Error("fixture member 'rep' missing");
      const token = await signSeededToken(seeded, member.userId, fixture.orgId);

      const patched = await request(seeded.app.getHttpServer())
        .patch(`/crm/ingress/whatsapp-channels/${channelId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ enabled: false });
      expect(patched.status).toBe(200);

      const before = (await whatsappActivitiesIn(fixture.orgId)).length;
      const { raw, signature } = delivery(line);

      const res = await deliver(`/crm/ingress/whatsapp/${channelId}`, raw, signature);

      expect(res.status).toBe(401);
      await tick();
      expect(await whatsappActivitiesIn(fixture.orgId)).toHaveLength(before);
    },
    120_000,
  );
});
