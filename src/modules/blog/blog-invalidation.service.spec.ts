import { ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import type { AppConfig } from "../../config/env.validation";
import { BlogInvalidationService, signBlogEvent } from "./blog-invalidation.service";

const SECRET = "s".repeat(48);
const OLD_SECRET = "o".repeat(48);
const EVENT = "11111111-1111-4111-8111-111111111111";
const BODY = JSON.stringify({ eventId: EVENT, postId: "22222222-2222-4222-8222-222222222222", generation: 3, reason: "publish" });
const NOW = 1_800_000_000;

function service(config: Partial<AppConfig>) {
  return new BlogInvalidationService({} as Db, config as AppConfig);
}

describe("blog invalidation signature", () => {
  const svc = service({ BLOG_INVALIDATION_SECRET: SECRET, BLOG_INVALIDATION_SECRET_PREVIOUS: OLD_SECRET });
  const ts = String(NOW);

  it("accepts a fresh signature over the exact body", () => {
    expect(() => svc.verify({ eventId: EVENT, timestamp: ts, signature: signBlogEvent(SECRET, ts, EVENT, BODY) }, BODY, NOW)).not.toThrow();
  });

  it("accepts the previous secret during a rotation", () => {
    expect(() => svc.verify({ eventId: EVENT, timestamp: ts, signature: signBlogEvent(OLD_SECRET, ts, EVENT, BODY) }, BODY, NOW)).not.toThrow();
  });

  it("rejects a body changed after signing", () => {
    const sig = signBlogEvent(SECRET, ts, EVENT, BODY);
    expect(() => svc.verify({ eventId: EVENT, timestamp: ts, signature: sig }, BODY.replace("publish", "delete"), NOW)).toThrow(UnauthorizedException);
  });

  it("rejects a replay outside the freshness window", () => {
    const sig = signBlogEvent(SECRET, ts, EVENT, BODY);
    expect(() => svc.verify({ eventId: EVENT, timestamp: ts, signature: sig }, BODY, NOW + 301)).toThrow(UnauthorizedException);
  });

  it("rejects a signature made for another event id", () => {
    const sig = signBlogEvent(SECRET, ts, "33333333-3333-4333-8333-333333333333", BODY);
    expect(() => svc.verify({ eventId: EVENT, timestamp: ts, signature: sig }, BODY, NOW)).toThrow(UnauthorizedException);
  });

  it("refuses every delivery when no secret is configured", () => {
    const unconfigured = service({});
    expect(() => unconfigured.verify({ eventId: EVENT, timestamp: ts, signature: signBlogEvent(SECRET, ts, EVENT, BODY) }, BODY, NOW)).toThrow(ServiceUnavailableException);
  });
});
