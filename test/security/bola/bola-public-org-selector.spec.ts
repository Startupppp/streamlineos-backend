import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKEND_ROOT, loadRouteSurface, type HandlerRoute } from "./route-surface";

/**
 * A `@Public()` route whose tenant comes from a path `:orgId` is permitted by the
 * boundary rules, but only because the route is expected to authenticate the
 * caller some other way — a provider signature or a capability token. Without
 * one, the org id is not a weak identifier, it is the whole authorization
 * decision, chosen by the caller.
 *
 * This is a blind spot the data-layer sweep cannot see on its own: these
 * handlers DO reach `eq(table.orgId, orgId)`, so they classify as tenant-bound.
 * Binding a caller-supplied org id is not isolation, so the credential has to be
 * asserted separately — which is what this spec does.
 */

const ORG_PARAM_RE = /^(orgId|organizationId)$/i;

/** Evidence that the handler authenticates the caller before trusting the path org id. */
const CREDENTIAL_RE =
  /@Headers\(|rawBody|signature|sessionToken|verifyInboundSecret|webhook-secret|RawBodyRequest/;

const read = (rel: string): string => readFileSync(join(BACKEND_ROOT, rel), "utf8");

export function publicOrgSelectorRoutes(): HandlerRoute[] {
  return loadRouteSurface().filter(
    (r) => r.classification === "public" && r.pathParams.some((p) => ORG_PARAM_RE.test(p)),
  );
}

/**
 * Routes that deliberately carry no credential. Each must be harmless on its own
 * terms: it either reads nothing tenant-owned, or it is a visitor-facing surface
 * the organization opted into by enabling a channel.
 */
const NO_CREDENTIAL_BY_DESIGN: ReadonlyMap<string, string> = new Map([
  ["GET /public/kb/widget/:orgId", "returns a static embed descriptor; reads no tenant data"],
  ["GET /public/kb/widget/:orgId/script", "emits a static JS snippet; reads no tenant data"],
  ["GET /public/org/:orgId", "public organization profile, the tenant's own chosen public face"],
  ["GET /public/hr-forms/:orgId/:slug", "public job/HR form the org published deliberately"],
  ["POST /public/hr-forms/:orgId/:slug/submit", "anonymous submission into a published form"],
  [
    "POST /support/chat/:orgId/start",
    "visitor chat widget; refuses unless the org has an ACTIVE chat channel with a valid owner",
  ],
  [
    "GET /support/chat/:orgId/:sessionToken/messages",
    "the 192-bit sessionToken minted at start is the credential",
  ],
  [
    "POST /support/chat/:orgId/:sessionToken/messages",
    "the 192-bit sessionToken minted at start is the credential",
  ],
]);

describe("BOLA sweep — public routes whose tenant selector is a path :orgId", () => {
  const routes = publicOrgSelectorRoutes();
  const key = (r: HandlerRoute): string => `${r.verb} ${r.path}`;

  it("ANTI-VACUITY: the shape exists and is enumerated", () => {
    expect(routes.length).toBeGreaterThan(5);
    expect(routes.every((r) => r.classification === "public")).toBe(true);
  });

  it("NO-NEW-UNCREDENTIALED: each such route presents a credential or is named as needing none", () => {
    const uncredentialed = routes
      .filter((r) => !CREDENTIAL_RE.test(r.signature) && !CREDENTIAL_RE.test(r.body))
      .map(key)
      .filter((k) => !NO_CREDENTIAL_BY_DESIGN.has(k));
    expect(uncredentialed).toEqual([]);
  });

  it("WRITES: every public write keyed on a path org id carries a credential or is named", () => {
    const writes = routes.filter((r) => r.verb !== "GET").map(key);
    for (const routeKey of writes) {
      const route = routes.find((r) => key(r) === routeKey);
      const credentialed =
        CREDENTIAL_RE.test(route?.signature ?? "") || CREDENTIAL_RE.test(route?.body ?? "");
      expect(credentialed || NO_CREDENTIAL_BY_DESIGN.has(routeKey)).toBe(true);
    }
  });
});

describe("BOLA sweep — payment webhooks verify a signature over the raw body", () => {
  it("the application preserves the raw body, so an HMAC can be computed over what was sent", () => {
    expect(read("src/main.ts")).toContain("rawBody: true");
  });

  it("the razorpay webhook reads req.rawBody, never the re-serialised parsed body", () => {
    const controller = read("src/modules/billing/core/razorpay-webhook.controller.ts");
    expect(controller).toContain("RawBodyRequest<Request>");
    expect(controller).toContain("req.rawBody");
    expect(controller).toContain("x-razorpay-signature");
  });

  it("the signature is an HMAC over that raw body, compared in constant time", () => {
    const adapter = read("src/modules/billing/payments/adapters/razorpay.adapter.ts");
    expect(adapter).toContain("timingSafeEqual");
    expect(adapter).toMatch(/createHmac\("sha256", webhookSecret\)\s*\.update\(params\.rawBody\)/);
  });
});

describe("BOLA sweep — support inbound webhooks", () => {
  const service = read("src/modules/support/core/support-channels.service.ts");
  const controller = read("src/modules/support/core/support-channels.controller.ts");

  it("every inbound write is gated on a per-org shared secret before it reaches the database", () => {
    for (const channel of ["email", "whatsapp", "sms"])
      expect(controller).toContain(`verifyInboundSecret(orgId, "${channel}", secret)`);
    expect(service).toContain("eq(supportChannels.orgId, orgId)");
  });

  it("a wrong secret and an unknown organization are indistinguishable", () => {
    expect(service).toContain(
      "const matches = inboundSecretMatches(channel?.inboundSecret, providedSecret);",
    );
    expect(service).toContain("if (!channel || !matches) {");
    expect(service).toContain('throw new UnauthorizedException("Invalid inbound webhook secret")');
  });

  /**
   * `!==` on a secret short-circuits at the first differing byte. Fixed: the
   * comparison now goes through `inboundSecretMatches`, which reduces both sides
   * to a fixed-width digest and compares with `timingSafeEqual` — the same
   * primitive `razorpay.adapter.ts` already used. Behaviour is proved in
   * `bola-support-inbound-secret.spec.ts`; this is the regression guard.
   */
  it("FIXED: the secret comparison is constant-time", () => {
    expect(service).not.toContain("channel.inboundSecret !== providedSecret");
    expect(read("src/modules/support/core/support-inbound-secret.ts")).toContain(
      "timingSafeEqual",
    );
  });

  /** FIXED: the secret is a digest at rest, and the plaintext is handed back once. */
  it("FIXED: the inbound secret is hashed at rest", () => {
    expect(service).toContain("inboundSecret === null ? null : hashInboundSecret(inboundSecret)");
    expect(service).toContain("columns: { inboundSecret: false }");
  });

  /**
   * The rate limiter runs before the secret check, so keying it on the
   * caller-supplied org id let an anonymous caller who knows an organization's id
   * exhaust that organization's inbound quota. Fixed: the pre-auth limit is keyed
   * on the client address and the per-org quota moved after the credential check.
   */
  it("FIXED: the pre-auth rate limit is keyed on the caller's own address", () => {
    for (const channel of ["email", "whatsapp", "sms"]) {
      const preAuthAt = controller.indexOf(`"support:inbound-${channel}", clientIp(req)`);
      const verifyAt = controller.indexOf(`verifyInboundSecret(orgId, "${channel}"`);
      const perOrgAt = controller.indexOf(`"support:inbound-${channel}", orgId`);
      expect(preAuthAt).toBeGreaterThan(-1);
      expect(verifyAt).toBeGreaterThan(preAuthAt);
      expect(perOrgAt).toBeGreaterThan(verifyAt);
    }
    expect(controller).toContain('this.rateLimit.check("support:chat-widget", clientIp(req))');
  });
});

describe("BOLA sweep — KB widget routes: stateless, no tenant data", () => {
  const controller = read("src/modules/kb/help-centre/kb-widget.controller.ts");

  it("the controller injects no database provider", () => {
    expect(controller).not.toContain("DRIZZLE");
    expect(controller).not.toContain("private readonly db");
  });

  it("the config handler returns only static fields — orgId echoed back and APP_URL-derived URLs", () => {
    expect(controller).toContain('return {');
    expect(controller).toContain('orgId,');
    expect(controller).toContain('helpCenterUrl:');
    expect(controller).toContain('buttonLabel:');
    expect(controller).toContain('primaryColor:');
    expect(controller).toContain('position:');
  });

  it("neither handler calls any service or executes any query", () => {
    expect(controller).not.toContain("await ");
    expect(controller).not.toContain(".query(");
    expect(controller).not.toContain(".select(");
    expect(controller).not.toContain(".from(");
  });
});

describe("BOLA sweep — GET /public/org/:orgId returns only org name, 404 for missing", () => {
  const service = read("src/modules/public/org.service.ts");

  // Asserting a projection OMITS named columns is vacuous for any name the table lacks; count the keys instead.
  it("the query projects exactly one column", () => {
    const projection = /\.select\(\{([^}]*)\}\)/.exec(service)?.[1];
    expect(projection).toBeDefined();
    const keys = (projection ?? "").split(",").map((k) => k.trim()).filter((k) => k.length > 0);
    expect(keys).toEqual(["name: organizations.name"]);
  });

  it("a missing org throws NotFoundException, not a silent 200 with null", () => {
    expect(service).toContain('throw new NotFoundException("Organization not found")');
  });

  it("the service never accepts an orgId from anything other than its single parameter", () => {
    const body = service.slice(service.indexOf("async getOrgName"));
    expect(body.slice(0, 400)).toContain("eq(organizations.id, orgId)");
  });
});

describe("BOLA sweep — public whiteboard share token", () => {
  const service = read("src/modules/build/execution/whiteboard-sharing.service.ts");

  it("the token is high entropy", () => {
    expect(service).toMatch(/randomBytes\(24\)\.toString\("base64url"\)/);
  });

  it("a miss, a non-public board and an expired link are all 404, never 403", () => {
    const update = service.slice(service.indexOf("async updatePublicByToken"));
    expect(update.slice(0, 700)).toContain('throw new NotFoundException("Not found")');
  });

  it("the write is capability-limited: a viewer token cannot edit", () => {
    expect(service).toContain('board.publicAccess !== "editor"');
    expect(service).toContain('throw new ForbiddenException("Link is view-only")');
  });

  it("the token is scope-limited to the one board it names", () => {
    const update = service.slice(service.indexOf("async updatePublicByToken"));
    expect(update.slice(0, 700)).toContain("eq(projectWhiteboards.shareToken, token)");
    expect(update.slice(0, 700)).toContain("withPublicToken(this.db, token");
  });
});
