import { Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { blogInvalidationReceipts, blogPosts } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import { publishedPostPredicate } from "./blog-public.projection";
import type { InvalidationBody } from "./dto/blog.schemas";

export const BLOG_SIGNATURE_MAX_SKEW_SECS = 300;

export interface SignedHeaders {
  eventId: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

/** `v1=` + hex HMAC-SHA256 over `${timestamp}.${eventId}.${rawBody}`. Shared with the admin repo. */
export function signBlogEvent(secret: string, timestamp: string, eventId: string, rawBody: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${eventId}.${rawBody}`).digest("hex")}`;
}

function sameSignature(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Receives the blog admin's signed "publication changed" notification. The public read path has no
 * cache to purge — every public read is an authoritative database read under the publication
 * predicate — so the receipt's job is dedupe, acknowledgement, and telling the admin which revision
 * this backend now serves. If a public cache is ever added, its purge belongs here, keyed by the
 * post id and the publication generation, never by a caller-supplied URL.
 */
@Injectable()
export class BlogInvalidationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  verify(headers: SignedHeaders, rawBody: string, nowSecs = Math.floor(Date.now() / 1000)): void {
    const secrets = [this.config.BLOG_INVALIDATION_SECRET, this.config.BLOG_INVALIDATION_SECRET_PREVIOUS]
      .filter((s): s is string => Boolean(s));
    if (secrets.length === 0) throw new ServiceUnavailableException("Blog invalidation is not configured");

    const { eventId, timestamp, signature } = headers;
    if (!eventId || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (Math.abs(nowSecs - Number(timestamp)) > BLOG_SIGNATURE_MAX_SKEW_SECS) {
      throw new UnauthorizedException("Unauthorized");
    }
    const valid = secrets.some((secret) => sameSignature(signBlogEvent(secret, timestamp, eventId, rawBody), signature));
    if (!valid) throw new UnauthorizedException("Unauthorized");
  }

  async receive(headerEventId: string, body: InvalidationBody) {
    if (body.eventId !== headerEventId) throw new UnauthorizedException("Unauthorized");

    const inserted = await this.db
      .insert(blogInvalidationReceipts)
      .values({ eventId: body.eventId, postId: body.postId, generation: body.generation })
      .onConflictDoNothing({ target: blogInvalidationReceipts.eventId })
      .returning({ eventId: blogInvalidationReceipts.eventId });

    const [current] = await this.db
      .select({ publishedRevisionId: blogPosts.publishedRevisionId })
      .from(blogPosts)
      .where(and(eq(blogPosts.id, body.postId), publishedPostPredicate()))
      .limit(1);

    return {
      acknowledged: true as const,
      duplicate: inserted.length === 0,
      publishedRevisionId: current?.publishedRevisionId ?? null,
    };
  }
}
