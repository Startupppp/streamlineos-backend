import { createHmac } from "node:crypto";
import request from "supertest";
import { and, desc, eq } from "drizzle-orm";
import { orgModules, webhookLogs } from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";
import { WebhooksDispatchService } from "src/modules/webhooks/webhooks-dispatch.service";

/**
 * Outbound webhooks, end to end, against a real database under RLS.
 *
 * The unit spec next door owns the signature arithmetic. This file owns the
 * question arithmetic cannot answer: does a dispatch that happens **after** the
 * request is over still reach the database?
 *
 * `WebhooksDispatchService.dispatch` returns `void` and continues in the
 * background — `void this.run(...).catch(() => undefined)`. So by the time it
 * reads `webhook_endpoints` and writes `webhook_logs`, the request's tenant
 * transaction has committed and gone. Under the application role those tables
 * are behind `tenant_isolation`, and a read with no tenant context does not
 * come back empty — it raises. The `.catch(() => undefined)` then swallows it,
 * which means a completely dead outbound-webhook system reports nothing at all,
 * to anybody, ever.
 *
 * That is the same failure the WhatsApp channel had, and it is invisible to
 * every test that supplies its own `Db`. So this file calls `dispatch` the way
 * production calls it — from outside any tenant transaction — and then looks in
 * the table.
 *
 * The network is the one thing substituted: `fetch` is replaced so no packet
 * leaves, and the request the dispatcher *would* have made is captured and its
 * signature verified against the secret the API handed back. The URL is
 * 198.18.0.1 — RFC 2544 benchmark space, which the SSRF guard permits and which
 * routes nowhere, so even a failure of the stub cannot reach a real host.
 *
 * Run with:
 *   NODE_OPTIONS=--max-old-space-size=12288 \
 *   APP_DATABASE_URL=postgres://streamline_app:...@host/db \
 *   pnpm test:e2e:seeded --testPathPattern="crm-outbound-webhooks"
 */

/**
 * RFC 2544 benchmark space: allowed by the SSRF guard, routable nowhere.
 *
 * A distinct path per endpoint, because every endpoint in the organisation
 * that subscribes to an event receives it — so a capture is only attributable
 * to the endpoint that made it if the URLs differ.
 */
const SINK_HOST = "http://198.18.0.1";
const sink = (name: string) => `${SINK_HOST}/hooks/${name}`;

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

describe(`${SEEDED_HARNESS} outbound webhooks — a dispatch after the request still lands`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let token: string;
  let captured: CapturedCall[];
  let realFetch: typeof globalThis.fetch;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      .addMember("admin", { permissionKeys: ["settings:webhooks:manage"] })
      .build();
    await seeded.seedDb
      .insert(orgModules)
      .values({ orgId: fixture.orgId, moduleKey: "crm", enabled: true });

    const admin = fixture.members["admin"];
    if (!admin) throw new Error("fixture member 'admin' missing");
    token = await signSeededToken(admin.userId, fixture.orgId);

    /**
     * Only this suite's own targets are intercepted.
     *
     * A blanket stub also swallows Redis — the app's cache and membership
     * lookups go out over `fetch` to Upstash — and answering those with `{}`
     * breaks the guard chain in ways that look like webhook failures. Anything
     * that is not aimed at the sink goes to the real implementation.
     */
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith(SINK_HOST)) return realFetch(input as RequestInfo, init);

      captured.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body ?? ""),
      });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof globalThis.fetch;
  }, 180_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (fixture) await fixture.teardown();
    if (seeded) await seeded.close();
  }, 60_000);

  beforeEach(() => {
    captured = [];
  });

  const api = () => request(seeded.app.getHttpServer());
  const auth = <T extends { set: (k: string, v: string) => T }>(req: T) =>
    req.set("Authorization", `Bearer ${token}`);

  /** Captures aimed at one endpoint's own path. */
  const capturedFor = (name: string) => captured.filter((c) => c.url === sink(name));

  async function createEndpoint(events: string[], url: string) {
    const res = await auth(api().post("/webhooks")).send({ url, events, description: "seeded" });
    if (res.status !== 201)
      throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: number; secret: string; secretHint: string };
  }

  /** The dispatch is fire-and-forget, so the row arrives after the call returns. */
  async function logsFor(endpointId: number, event: string, expected = 1) {
    for (let pass = 0; pass < 20; pass += 1) {
      const rows = await seeded.seedDb
        .select({
          id: webhookLogs.id,
          event: webhookLogs.event,
          success: webhookLogs.success,
          statusCode: webhookLogs.statusCode,
          responseBody: webhookLogs.responseBody,
        })
        .from(webhookLogs)
        .where(and(eq(webhookLogs.endpointId, endpointId), eq(webhookLogs.event, event)))
        .orderBy(desc(webhookLogs.id));
      if (rows.length >= expected) return rows;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return [];
  }

  function dispatchAsProductionDoes(event: string, payload: Record<string, unknown>) {
    /**
     * Straight off the container, called from outside any request. This is not
     * a shortcut around the HTTP layer — it is the exact condition the real
     * caller creates, because `dispatch` returns immediately and its work
     * continues after the request's transaction has closed.
     */
    seeded.app.get(WebhooksDispatchService).dispatch(fixture.orgId, event, payload);
  }

  describe("the secret", () => {
    it("comes back once on create, and never again", async () => {
      const created = await createEndpoint(["deal.won"], sink("secret-once"));

      expect(created.secret).toEqual(expect.any(String));
      expect(created.secret.length).toBeGreaterThanOrEqual(32);

      const read = await auth(api().get(`/webhooks/${created.id}`));
      expect(read.status).toBe(200);
      expect(read.body).not.toHaveProperty("secret");

      const listed = await auth(api().get("/webhooks"));
      expect(listed.status).toBe(200);
      expect(JSON.stringify(listed.body)).not.toContain(created.secret);
    });

    it("rotates, and the old one stops being the answer", async () => {
      const created = await createEndpoint(["deal.won"], sink("rotate"));

      const rotated = await auth(api().post(`/webhooks/${created.id}/rotate-secret`)).send({});
      expect(rotated.status).toBe(200);

      const next = (rotated.body as { secret: string }).secret;
      expect(next).toEqual(expect.any(String));
      expect(next).not.toBe(created.secret);
    });
  });

  describe("dispatching a CRM event", () => {
    it(
      "signs the body with the secret the caller was given, and records the delivery",
      async () => {
        const endpoint = await createEndpoint(["deal.won"], sink("signed"));

        dispatchAsProductionDoes("deal.won", { id: 4242, name: "Renewal — Acme", value: "120000" });

        const rows = await logsFor(endpoint.id, "deal.won");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ success: true, statusCode: 200 });

        const mine = capturedFor("signed");
        expect(mine).toHaveLength(1);
        const call = mine[0];
        if (!call) throw new Error("no outbound call was captured");

        expect(call.headers["X-Webhook-Event"]).toBe("deal.won");

        /**
         * The consumer's side of the contract, computed the way a consumer
         * would: over the exact bytes received, with the secret handed over at
         * create time. A dispatcher that signed the parsed object, or signed
         * the ciphertext of its own secret, fails here and nowhere else.
         */
        const expected = createHmac("sha256", endpoint.secret).update(call.body).digest("hex");
        expect(call.headers["X-StreamlineOS-Signature"]).toBe(`sha256=${expected}`);

        expect(JSON.parse(call.body)).toMatchObject({
          event: "deal.won",
          data: { id: 4242, name: "Renewal — Acme" },
        });
      },
      120_000,
    );

    it(
      "delivers only to endpoints subscribed to the event",
      async () => {
        const subscribed = await createEndpoint(["deal.lost"], sink("subscribed"));
        const wildcard = await createEndpoint(["*"], sink("wildcard"));

        dispatchAsProductionDoes("deal.lost", { id: 7 });

        expect(await logsFor(subscribed.id, "deal.lost")).toHaveLength(1);
        expect(await logsFor(wildcard.id, "deal.lost")).toHaveLength(1);

        const uninterested = await createEndpoint(["lead.created"], sink("uninterested"));
        captured = [];
        dispatchAsProductionDoes("deal.lost", { id: 8 });
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(await logsFor(uninterested.id, "deal.lost", 1)).toEqual([]);
      },
      120_000,
    );
  });

  describe("the SSRF fence", () => {
    /**
     * The create endpoint refuses a private target outright, which is the
     * cheaper of the two checks and the one a person sees.
     */
    it("refuses to store a loopback target", async () => {
      const res = await auth(api().post("/webhooks")).send({
        url: "http://127.0.0.1:8080/steal",
        events: ["deal.won"],
      });

      expect(res.status).toBe(400);
    });

    it("refuses a cloud metadata address", async () => {
      const res = await auth(api().post("/webhooks")).send({
        url: "http://169.254.169.254/latest/meta-data/",
        events: ["deal.won"],
      });

      expect(res.status).toBe(400);
    });

    /**
     * The second fence, at dispatch time, for a target that became internal
     * after it was stored — a hostname re-pointed at private space is the whole
     * reason `checkWebhookUrl` resolves rather than trusting the string.
     *
     * Driven by updating a stored row past the create-time check, which is
     * exactly the state a re-pointed DNS name produces.
     */
    it(
      "does not egress to a target that turned internal, and says why in the log",
      async () => {
        const endpoint = await createEndpoint(["deal.won"], sink("turned-internal"));
        await seeded.seedDb.execute(
          `UPDATE webhook_endpoints SET url = 'http://127.0.0.1:9/steal' WHERE id = ${endpoint.id}`,
        );

        captured = [];
        dispatchAsProductionDoes("deal.won", { id: 99 });

        const rows = await logsFor(endpoint.id, "deal.won");
        expect(rows).toHaveLength(1);
        expect(rows[0]?.success).toBe(false);
        expect(rows[0]?.statusCode).toBeNull();
        expect(rows[0]?.responseBody).toContain("Blocked");

        /**
         * Nothing was sent to this endpoint's own target, and nothing was sent
         * to the loopback address it was re-pointed at. Other endpoints in the
         * organisation are subscribed to the same event and do fire, which is
         * correct — so the assertion is about this target, not about silence.
         */
        expect(capturedFor("turned-internal")).toEqual([]);
        expect(captured.filter((c) => c.url.includes("127.0.0.1"))).toEqual([]);
      },
      120_000,
    );
  });
});
