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
    expect(service).toMatch(
      /!channel\?\.inboundSecret \|\| !providedSecret \|\| channel\.inboundSecret !== providedSecret/,
    );
    expect(service).toContain('throw new UnauthorizedException("Invalid inbound webhook secret")');
  });

  /**
   * `!==` on a secret short-circuits at the first differing byte. The same
   * repository already compares a webhook secret correctly, in
   * `razorpay.adapter.ts`, with `timingSafeEqual`.
   */
  it("KNOWN-OPEN: the secret comparison is not constant-time", () => {
    expect(service).toContain("channel.inboundSecret !== providedSecret");
    const sliceAroundCompare = service.slice(
      service.indexOf("verifyInboundSecret"),
      service.indexOf("verifyInboundSecret") + 800,
    );
    expect(sliceAroundCompare).not.toContain("timingSafeEqual");
  });

  /**
   * The rate limiter runs before the secret check and is keyed on the
   * caller-supplied org id, so an anonymous caller who knows an organization's
   * id can exhaust that organization's inbound quota and stop its real support
   * mail from being delivered.
   */
  it("KNOWN-OPEN: the pre-auth rate limit is keyed on the caller-supplied org id", () => {
    for (const channel of ["email", "whatsapp", "sms"]) {
      const limitAt = controller.indexOf(`"support:inbound-${channel}", orgId`);
      const verifyAt = controller.indexOf(`verifyInboundSecret(orgId, "${channel}"`);
      expect(limitAt).toBeGreaterThan(-1);
      expect(verifyAt).toBeGreaterThan(limitAt);
    }
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
