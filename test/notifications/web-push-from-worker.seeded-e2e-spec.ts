import { execFileSync } from "node:child_process";
import { globalAgent, createServer as createTlsServer, type Server as TlsServer } from "node:https";
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  notifications,
  orgModules,
  pushSubscriptions,
  signBulkSendJobs,
  signTemplates,
} from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * Web push raised from a background worker.
 *
 * `NotificationsService.pushToDevice` is fire-and-forget, and the tenant
 * context is async-local — so the continuation inherited whatever transaction
 * was open at the call site. Called from an outbox consumer that transaction
 * has already committed, and `push_subscriptions` is behind `tenant_isolation`
 * with the *raising* accessor `app.current_org_id()`. Against a closed
 * postgres.js handle the lookup does not throw, it never settles: the `.catch`
 * never ran and nothing was logged. Where the ambient was absent rather than
 * dead it failed faster and just as quietly, with a 42501 into the same
 * `.catch`. Either way a subscribed device was simply never pushed to, behind
 * a green request.
 *
 * So this asserts the fan-out's effects, not that `sendToUser` was called:
 *
 *   - the sink was reached, on the subscribed org's endpoint and no other
 *   - the expired subscription was reaped afterwards
 *
 * The second one matters as much as the first. The reap is a database write
 * that happens *after* the network sends, so it is the part that proves the
 * tenant scope is alive for the whole body rather than just long enough to
 * resolve the subscriptions.
 *
 * `sign.bulk_send.completed` is the vehicle because bulk send already
 * finishes on the outbox worker (SIGN-P1-06), so the notification it raises
 * is genuinely worker-raised rather than a request pretending to be one.
 *
 * The sink is TLS because `web-push` speaks TLS whatever the endpoint scheme
 * says — a plain http endpoint fails the handshake before any request is made.
 * Its certificate is generated per run and trusted by relaxing
 * `https.globalAgent` for the duration, restored in `afterAll`. That, and not
 * `NODE_TLS_REJECT_UNAUTHORIZED`: jest hands each test file its own copy of
 * `process.env`, so setting that variable here never reaches the TLS layer and
 * the handshake fails with "self-signed certificate". `web-push` issues its
 * request through `https.request` with no agent of its own, so the global one
 * is the seam it actually goes through.
 *
 * The sink answers 410 Gone, which is a real `WebPushError` and the branch
 * that reaps the subscription.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=web-push-from-worker
 */

interface SinkHit {
  path: string;
  encrypted: boolean;
}

/** A subscription keypair shaped like the one a browser hands to `pushManager`. */
function browserSubscriptionKeys(): { p256dh: string; auth: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  };
}

describe(`${SEEDED_HARNESS} web push raised from a background worker`, () => {
  let seeded: SeededE2eApp;
  let subscribed: SeededFixture;
  let otherTenant: SeededFixture;
  let token = "";
  let templateId = 0;
  let jobId = 0;

  let certDir = "";
  let sink: TlsServer | undefined;
  let sinkPort = 0;
  const hits: SinkHit[] = [];
  let priorRejectUnauthorized: unknown;

  const endpointFor = (path: string) => `https://127.0.0.1:${String(sinkPort)}${path}`;
  const SUBSCRIBED_PATH = "/push/subscribed-org";
  const OTHER_TENANT_PATH = "/push/other-tenant";

  beforeAll(async () => {
    /**
     * Self-signed, generated here rather than committed: a checked-in
     * certificate is a private key in the repository and an expiry date that
     * eventually fails a test for a reason that has nothing to do with push.
     */
    certDir = mkdtempSync(join(tmpdir(), "push-sink-"));
    const keyPath = join(certDir, "key.pem");
    const certPath = join(certDir, "cert.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1",
    ], { stdio: "ignore" });

    priorRejectUnauthorized = globalAgent.options.rejectUnauthorized;
    globalAgent.options.rejectUnauthorized = false;

    sink = createTlsServer(
      { key: readFileSync(keyPath), cert: readFileSync(certPath) },
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          hits.push({
            path: req.url ?? "",
            /** RT-001: the body is an encrypted envelope, never the title or message. */
            encrypted: req.headers["content-encoding"] === "aes128gcm" && Buffer.concat(chunks).length > 0,
          });
          res.writeHead(410, { "Content-Type": "text/plain" });
          res.end("Gone");
        });
      },
    );
    await new Promise<void>((resolve) => sink!.listen(0, "127.0.0.1", resolve));
    const address = sink.address();
    if (!address || typeof address === "string") throw new Error("push sink did not bind a port");
    sinkPort = address.port;

    seeded = await createSeededE2eApp();

    subscribed = await seedOrg(seeded.seedDb)
      .addMember("sender", { permissionKeys: ["sign:bulk_send:run", "sign:template:manage"] })
      .build();
    otherTenant = await seedOrg(seeded.seedDb).addMember("bystander").build();

    await seeded.seedDb
      .insert(orgModules)
      .values({ orgId: subscribed.orgId, moduleKey: "sign", enabled: true })
      .onConflictDoNothing();

    const senderUserId = subscribed.members["sender"]!.userId;
    token = await signSeededToken(senderUserId, subscribed.orgId);

    /**
     * Two subscriptions for the *same user*, in two organisations.
     *
     * `sendToUser` filters on the user alone — the organisation comes from
     * `tenant_isolation` and nothing else, so the second row is the only thing
     * that can tell a live tenant scope apart from an absent one. A fan-out
     * that reached both endpoints would be resolving subscriptions with no
     * tenant scope at all, which is the failure this is here to catch; one
     * that reached neither is the hang.
     */
    await seeded.seedDb.insert(pushSubscriptions).values([
      {
        orgId: subscribed.orgId,
        userId: senderUserId,
        endpoint: endpointFor(SUBSCRIBED_PATH),
        ...browserSubscriptionKeys(),
      },
      {
        orgId: otherTenant.orgId,
        userId: senderUserId,
        endpoint: endpointFor(OTHER_TENANT_PATH),
        ...browserSubscriptionKeys(),
      },
    ]);

    const [template] = await seeded.seedDb
      .insert(signTemplates)
      .values({
        orgId: subscribed.orgId,
        name: "Push fan-out probe",
        status: "published",
        ownerMembershipId: subscribed.members["sender"]!.membershipId,
        templateJson: {
          roles: [{ roleName: "Signer", recipientType: "signer", routingOrder: 1, authMethod: "email_link" }],
          documents: [],
          fields: [],
        },
      })
      .returning({ id: signTemplates.id });
    templateId = template!.id;
  }, 240_000);

  afterAll(async () => {
    if (seeded?.seedDb) {
      for (const fixture of [subscribed, otherTenant]) {
        if (!fixture) continue;
        await seeded.seedDb.delete(pushSubscriptions).where(eq(pushSubscriptions.orgId, fixture.orgId));
        await seeded.seedDb.delete(notifications).where(eq(notifications.orgId, fixture.orgId));
      }
      if (subscribed) {
        await seeded.seedDb.delete(signBulkSendJobs).where(eq(signBulkSendJobs.orgId, subscribed.orgId));
        await seeded.seedDb.delete(signTemplates).where(eq(signTemplates.orgId, subscribed.orgId));
      }
    }
    await subscribed?.teardown();
    await otherTenant?.teardown();
    await seeded?.close();

    if (sink) await new Promise<void>((resolve) => sink!.close(() => resolve()));
    globalAgent.options.rejectUnauthorized = priorRejectUnauthorized as boolean | undefined;
    if (certDir) rmSync(certDir, { recursive: true, force: true });
  }, 60_000);

  const drainOutbox = async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await request(seeded.app.getHttpServer())
        .post("/cron/outbox-events-worker")
        .set("Authorization", `Bearer ${process.env.CRON_SECRET ?? ""}`)
        .send({});
      expect(res.status).toBe(200);
      if (res.body?.skipped !== true) return;
      await new Promise((r) => setTimeout(r, 3_000));
    }
  };

  /**
   * The worker does not await the fan-out, so the cron call returning says
   * nothing about whether the push has happened yet. Poll rather than sleep a
   * fixed amount: a fixed sleep is either flaky or slow, usually both.
   */
  const waitFor = async (done: () => Promise<boolean>, seconds = 20): Promise<void> => {
    for (let attempt = 0; attempt < seconds * 2; attempt++) {
      if (await done()) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  it("finishes the bulk send on the worker", async () => {
    const res = await request(seeded.app.getHttpServer())
      .post("/sign/bulk-send/jobs")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `push-fanout-${randomUUID()}`)
      .send({
        templateId,
        columnMapping: { name: "name", email: "email" },
        rows: [{ name: "", email: "" }],
      });

    expect(res.status).toBe(201);
    jobId = res.body.job.id;

    await drainOutbox();

    const [job] = await seeded.seedDb
      .select({ status: signBulkSendJobs.status })
      .from(signBulkSendJobs)
      .where(eq(signBulkSendJobs.id, jobId));
    expect(job?.status).toBe("completed");
  }, 120_000);

  it("records the notification the worker raised", async () => {
    await waitFor(async () =>
      (await seeded.seedDb
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(
          eq(notifications.orgId, subscribed.orgId),
          eq(notifications.eventKey, "sign.bulk_send.completed"),
        ))).length > 0,
    );

    const rows = await seeded.seedDb
      .select({ userId: notifications.userId, entityId: notifications.entityId })
      .from(notifications)
      .where(and(
        eq(notifications.orgId, subscribed.orgId),
        eq(notifications.eventKey, "sign.bulk_send.completed"),
      ));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(subscribed.members["sender"]!.userId);
    expect(rows[0]!.entityId).toBe(String(jobId));
  }, 60_000);

  it("pushes to the subscribed org's device, and to no other tenant's", async () => {
    await waitFor(async () => hits.length > 0);

    expect(hits.map((hit) => hit.path)).toEqual([SUBSCRIBED_PATH]);
    /** A real encrypted envelope, so the payload was built from a resolved row. */
    expect(hits[0]!.encrypted).toBe(true);
  }, 60_000);

  it("reaps the subscription the sink retired, leaving the other tenant's alone", async () => {
    await waitFor(async () =>
      (await seeded.seedDb
        .select({ id: pushSubscriptions.id })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.orgId, subscribed.orgId))).length === 0,
    );

    const surviving = await seeded.seedDb
      .select({ orgId: pushSubscriptions.orgId, endpoint: pushSubscriptions.endpoint })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, subscribed.members["sender"]!.userId));

    /**
     * The 410 reap runs after the network sends, so a scope that only lasted
     * long enough to resolve the subscriptions leaves this row behind.
     */
    expect(surviving).toHaveLength(1);
    expect(surviving[0]!.orgId).toBe(otherTenant.orgId);
    expect(surviving[0]!.endpoint).toBe(endpointFor(OTHER_TENANT_PATH));
  }, 60_000);
});
