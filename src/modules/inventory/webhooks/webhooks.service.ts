import { Injectable, Inject, BadRequestException, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { invWebhookEventSubscriptions, invWebhooks, invWebhookEvents } from "../../../db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { createHmac, randomBytes } from "crypto";
import { lookup } from "dns/promises";
import type { CreateWebhookInput, UpdateWebhookInput, ListEventsQueryInput } from "./dto/webhooks.schemas";

// ---------------------------------------------------------------------------
// IP-range predicate — covers all RFC-1918/loopback/link-local/CGNAT/reserved
// ranges for both IPv4 and IPv6 (including IPv4-mapped IPv6 ::ffff:x.x.x.x).
// Returns a human-readable reason string when the address is blocked, or null
// when it is safe to contact.
// ---------------------------------------------------------------------------

function blockedIpReason(address: string): string | null {
  // Strip IPv6 zone ID (e.g. "fe80::1%eth0") and brackets used in URL hostnames.
  const raw = address.replace(/^\[/, "").replace(/\]$/, "").replace(/%.*$/, "");

  // ---- IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:0xAABBCCDD) ----------------
  const v4MappedFull = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(raw);
  if (v4MappedFull) {
    const [, a, b, c, d] = v4MappedFull;
    return blockedIpv4Reason(Number(a), Number(b), Number(c), Number(d));
  }
  // Hex-notation ::ffff:c0a8:0101 → treat as IPv4
  const v4MappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(raw);
  if (v4MappedHex) {
    const hi = parseInt(v4MappedHex[1] ?? "0", 16);
    const lo = parseInt(v4MappedHex[2] ?? "0", 16);
    const a = (hi >> 8) & 0xff;
    const b = hi & 0xff;
    const c = (lo >> 8) & 0xff;
    const d = lo & 0xff;
    return blockedIpv4Reason(a, b, c, d);
  }

  // ---- Pure IPv6 checks -------------------------------------------------------
  if (raw.includes(":")) {
    return blockedIpv6Reason(raw);
  }

  // ---- IPv4 -------------------------------------------------------------------
  const parts = raw.split(".");
  if (parts.length === 4) {
    const [a, b, c, d] = parts.map(Number);
    if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return blockedIpv4Reason(a ?? 0, b ?? 0, c ?? 0, d ?? 0);
  }

  return null;
}

function blockedIpv4Reason(a: number, b: number, c: number, d: number): string | null {
  // 0.0.0.0/8 — unspecified / "this" network
  if (a === 0) return "Unspecified address not allowed";
  // 127.0.0.0/8 — loopback
  if (a === 127) return "Loopback address not allowed";
  // 10.0.0.0/8 — RFC-1918 class A private
  if (a === 10) return "Private IP range not allowed";
  // 172.16.0.0/12 — RFC-1918 class B private
  if (a === 172 && b >= 16 && b <= 31) return "Private IP range not allowed";
  // 192.168.0.0/16 — RFC-1918 class C private
  if (a === 192 && b === 168) return "Private IP range not allowed";
  // 169.254.0.0/16 — link-local (includes 169.254.169.254 AWS/GCP metadata)
  if (a === 169 && b === 254) return "Link-local / metadata address not allowed";
  // 100.64.0.0/10 — CGNAT shared address space (RFC 6598)
  if (a === 100 && b >= 64 && b <= 127) return "CGNAT address range not allowed";
  // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 — TEST-NET (RFC 5737)
  if (a === 192 && b === 0 && c === 2) return "Reserved test address not allowed";
  if (a === 198 && b === 51 && c === 100) return "Reserved test address not allowed";
  if (a === 203 && b === 0 && c === 113) return "Reserved test address not allowed";
  // 240.0.0.0/4 — reserved / future use
  if (a >= 240) return "Reserved address not allowed";
  // 255.255.255.255
  if (a === 255 && b === 255 && c === 255 && d === 255) return "Broadcast address not allowed";
  return null;
}

function blockedIpv6Reason(addr: string): string | null {
  const lower = addr.toLowerCase();
  // ::1 — loopback
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return "Loopback address not allowed";
  // :: — unspecified
  if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return "Unspecified address not allowed";
  // fe80::/10 — link-local
  if (/^fe[89ab][0-9a-f]:/i.test(lower)) return "Link-local address not allowed";
  // fc00::/7 — unique local (fc and fd prefix)
  if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return "Unique-local (ULA) address not allowed";
  return null;
}

// ---------------------------------------------------------------------------
// Sync guard — literal hostname/IP checks only (no DNS). Used by the existing
// `validateWebhookUrl` export so the spec keeps passing.
// ---------------------------------------------------------------------------

function checkUrlSync(url: string, isProd: boolean): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "Invalid URL"; }
  if (isProd && parsed.protocol !== "https:") return "Only HTTPS URLs allowed in production";
  if (!["http:", "https:"].includes(parsed.protocol)) return "Only HTTP/HTTPS URLs allowed";

  const host = parsed.hostname;

  // Reject *.localhost (including bare "localhost")
  if (host === "localhost" || host.endsWith(".localhost")) return "Localhost URLs not allowed";

  // Check literal IP addresses (IPv4 and IPv6)
  const ipReason = blockedIpReason(host);
  if (ipReason !== null) return ipReason;

  return null;
}

// Backward-compatible export — the existing spec imports this.
export function validateWebhookUrl(url: string, isProd: boolean): string | null {
  return checkUrlSync(url, isProd);
}

// ---------------------------------------------------------------------------
// Async guard — sync checks PLUS DNS resolution of every returned address.
// Must be called at registration time AND immediately before every outbound
// fetch to prevent DNS-rebinding attacks.
// ---------------------------------------------------------------------------

export async function assertSafeWebhookUrl(url: string, isProd: boolean): Promise<void> {
  const syncError = checkUrlSync(url, isProd);
  if (syncError !== null) throw new BadRequestException(syncError);

  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new BadRequestException("Invalid URL"); }

  const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");

  // Skip DNS lookup when the hostname is already a literal IP (already checked above).
  const isLiteralIp =
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ||
    /^[0-9a-f:]+$/i.test(hostname);

  if (!isLiteralIp) {
    let addresses: { address: string }[];
    try {
      addresses = await lookup(hostname, { all: true });
    } catch {
      throw new BadRequestException("Webhook hostname could not be resolved");
    }
    for (const { address } of addresses) {
      const reason = blockedIpReason(address);
      if (reason !== null) {
        throw new BadRequestException(`Webhook URL resolves to a blocked address: ${reason}`);
      }
    }
  }
}

type WebhookRow = typeof invWebhooks.$inferSelect;
type EventRow = typeof invWebhookEvents.$inferSelect;

@Injectable()
export class WebhooksService {
  private readonly isProd = process.env.NODE_ENV === "production";

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: InventoryAuditService,
  ) {}

  async list(orgId: string): Promise<Omit<WebhookRow, "secret">[]> {
    const rows = await this.db
      .select()
      .from(invWebhooks)
      .where(eq(invWebhooks.orgId, orgId))
      .orderBy(desc(invWebhooks.createdAt));
    return rows.map(({ secret: _, ...safe }) => safe);
  }

  /**
   * Keeps inv_webhook_event_subscriptions in step with the retained jsonb
   * column. Replace-in-place inside the caller's transaction, so the row and its
   * subscriptions can never disagree.
   */
  private async syncSubscriptions(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    orgId: string,
    webhookId: number,
    events: readonly string[],
  ): Promise<void> {
    await tx
      .delete(invWebhookEventSubscriptions)
      .where(
        and(
          eq(invWebhookEventSubscriptions.orgId, orgId),
          eq(invWebhookEventSubscriptions.webhookId, webhookId),
        ),
      );
    const unique = Array.from(new Set(events));
    if (unique.length === 0) return;
    await tx
      .insert(invWebhookEventSubscriptions)
      .values(unique.map((eventType) => ({ orgId, webhookId, eventType })))
      .onConflictDoNothing();
  }

  async create(orgId: string, userId: string, input: CreateWebhookInput): Promise<WebhookRow> {
    await assertSafeWebhookUrl(input.url, this.isProd);

    const secret = randomBytes(32).toString("hex");
    const created = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(invWebhooks)
        .values({ orgId, url: input.url, events: input.events, secret, isActive: input.isActive })
        .returning();
      if (!row) return undefined;
      await this.syncSubscriptions(tx, orgId, row.id, input.events);
      return row;
    });

    if (!created) throw new BadRequestException("Failed to create webhook");

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "webhook.created",
      resourceType: "webhook",
      resourceId: String(created.id),
      after: { url: created.url, events: created.events },
    });

    return created;
  }

  async update(
    orgId: string,
    userId: string,
    webhookId: number,
    input: UpdateWebhookInput,
  ): Promise<Omit<WebhookRow, "secret">> {
    const existing = await this.db
      .select()
      .from(invWebhooks)
      .where(and(eq(invWebhooks.id, webhookId), eq(invWebhooks.orgId, orgId)))
      .limit(1);
    if (!existing[0]) throw new NotFoundException("Webhook not found");

    if (input.url) {
      await assertSafeWebhookUrl(input.url, this.isProd);
    }

    const updated = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(invWebhooks)
        .set({
          ...(input.url !== undefined && { url: input.url }),
          ...(input.events !== undefined && { events: input.events }),
          ...(input.isActive !== undefined && { isActive: input.isActive }),
        })
        .where(and(eq(invWebhooks.id, webhookId), eq(invWebhooks.orgId, orgId)))
        .returning();
      if (!row) return undefined;
      if (input.events !== undefined)
        await this.syncSubscriptions(tx, orgId, webhookId, input.events);
      return row;
    });

    if (!updated) throw new NotFoundException("Webhook not found");

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "webhook.updated",
      resourceType: "webhook",
      resourceId: String(webhookId),
      before: { url: existing[0].url, events: existing[0].events, isActive: existing[0].isActive },
      after: { url: updated.url, events: updated.events, isActive: updated.isActive },
    });

    const { secret: _, ...safe } = updated;
    return safe;
  }

  async remove(orgId: string, userId: string, webhookId: number): Promise<{ deleted: boolean }> {
    const existing = await this.db
      .select()
      .from(invWebhooks)
      .where(and(eq(invWebhooks.id, webhookId), eq(invWebhooks.orgId, orgId)))
      .limit(1);
    if (!existing[0]) throw new NotFoundException("Webhook not found");

    await this.db
      .delete(invWebhooks)
      .where(and(eq(invWebhooks.id, webhookId), eq(invWebhooks.orgId, orgId)));

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "webhook.deleted",
      resourceType: "webhook",
      resourceId: String(webhookId),
      before: { url: existing[0].url },
    });

    return { deleted: true };
  }

  async listEvents(
    orgId: string,
    webhookId: number,
    query: ListEventsQueryInput,
  ): Promise<{ items: EventRow[]; total: number; page: number; totalPages: number }> {
    const webhookCheck = await this.db
      .select({ id: invWebhooks.id })
      .from(invWebhooks)
      .where(and(eq(invWebhooks.id, webhookId), eq(invWebhooks.orgId, orgId)))
      .limit(1);
    if (!webhookCheck[0]) throw new NotFoundException("Webhook not found");

    const conditions = [
      eq(invWebhookEvents.orgId, orgId),
      eq(invWebhookEvents.webhookId, webhookId),
      ...(query.status ? [eq(invWebhookEvents.status, query.status)] : []),
    ];

    const [countRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(invWebhookEvents)
      .where(and(...conditions));

    const total = countRow?.count ?? 0;
    const offset = (query.page - 1) * query.limit;

    const items = await this.db
      .select()
      .from(invWebhookEvents)
      .where(and(...conditions))
      .orderBy(desc(invWebhookEvents.createdAt))
      .limit(query.limit)
      .offset(offset);

    return {
      items,
      total,
      page: query.page,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async retryEvent(orgId: string, userId: string, eventId: number): Promise<EventRow> {
    const eventRows = await this.db
      .select()
      .from(invWebhookEvents)
      .where(and(eq(invWebhookEvents.id, eventId), eq(invWebhookEvents.orgId, orgId)))
      .limit(1);
    const event = eventRows[0];
    if (!event) throw new NotFoundException("Event not found");

    if (event.status === "DELIVERED") return event;

    if (event.webhookId === null) throw new NotFoundException("Webhook no longer exists");

    const webhookRows = await this.db
      .select()
      .from(invWebhooks)
      .where(and(eq(invWebhooks.id, event.webhookId), eq(invWebhooks.orgId, orgId)))
      .limit(1);
    const webhook = webhookRows[0];
    if (!webhook) throw new NotFoundException("Webhook no longer exists");

    const status = await this.deliverEvent(webhook, event);

    const [updatedEvent] = await this.db
      .update(invWebhookEvents)
      .set({
        status,
        attempts: event.attempts + 1,
        ...(status === "DELIVERED" && { deliveredAt: new Date() }),
      })
      .where(eq(invWebhookEvents.id, eventId))
      .returning();

    await this.db
      .update(invWebhooks)
      .set({ lastDeliveryAt: new Date(), lastDeliveryStatus: status })
      .where(eq(invWebhooks.id, webhook.id));

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "webhook.event.retried",
      resourceType: "webhook_event",
      resourceId: String(eventId),
      after: { status, attempts: event.attempts + 1 },
    });

    return updatedEvent ?? event;
  }

  private async deliverEvent(
    webhook: WebhookRow,
    event: EventRow,
  ): Promise<"DELIVERED" | "FAILED"> {
    // Re-validate at delivery time to close the DNS-rebinding / TOCTOU window.
    // Any violation (URL changed in DB, DNS now resolves differently) → FAILED.
    try {
      await assertSafeWebhookUrl(webhook.url, this.isProd);
    } catch {
      return "FAILED";
    }

    const payloadStr = JSON.stringify({
      id: event.id,
      type: event.eventType,
      data: event.payload,
      timestamp: event.createdAt,
    });
    const sig = createHmac("sha256", webhook.secret).update(payloadStr).digest("hex");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Inventory-Signature": `sha256=${sig}`,
        },
        body: payloadStr,
        signal: controller.signal,
        redirect: "manual",
      });
      clearTimeout(timeout);
      // Treat any redirect (3xx) as a failed delivery — we do not chase redirects
      // because the redirect target may point at an internal address.
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        return "FAILED";
      }
      return res.ok ? "DELIVERED" : "FAILED";
    } catch {
      clearTimeout(timeout);
      return "FAILED";
    }
  }
}
