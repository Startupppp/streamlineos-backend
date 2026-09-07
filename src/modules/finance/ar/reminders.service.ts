import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { finReminderPolicies, finReminderLog, organizationMembers } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { randomUUID } from "node:crypto";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import type { OutboxEventInput } from "../../../common/outbox/outbox-event-schema";
import { INVOICE_REMINDER_EVENT, invoiceReminderPayloadSchema } from "./dto/reminder-outbox.schemas";
import { buildIdCursorPage } from "../../../common/pagination/cursor";
import type { CreateReminderPolicyInput, UpdateReminderPolicyInput, ListReminderPoliciesQuery, ListReminderLogQuery } from "./dto/finance-ar.schemas";
import { forEachOrg } from "../../../common/tenant";

const CANDIDATE_CAP = 1000;
const RECIPIENT_CAP = 10;
const REMINDER_CLAIM_CHUNK = 500;

@Injectable()
export class RemindersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async listPolicies(orgId: string, query: ListReminderPoliciesQuery) {
    const pageLimit = Math.min(query.limit, 100);
    const conditions = [eq(finReminderPolicies.orgId, orgId), isNull(finReminderPolicies.archivedAt)];
    if (query.cursor) conditions.push(sql`${finReminderPolicies.id} > ${query.cursor}`);
    const projection = {
      id: finReminderPolicies.id,
      orgId: finReminderPolicies.orgId,
      name: finReminderPolicies.name,
      offsets: finReminderPolicies.offsets,
      channel: finReminderPolicies.channel,
      template: finReminderPolicies.template,
      isActive: finReminderPolicies.isActive,
      archivedAt: finReminderPolicies.archivedAt,
      createdAt: finReminderPolicies.createdAt,
      updatedAt: finReminderPolicies.updatedAt,
    };
    const rows = await this.db.select(projection).from(finReminderPolicies).where(and(...conditions)).orderBy(asc(finReminderPolicies.id)).limit(pageLimit + 1);
    const result = buildIdCursorPage(rows, pageLimit, (row) => row.id);
    return { items: result.data, pagination: { limit: pageLimit, hasMore: result.hasMore, nextCursor: result.nextCursor } };
  }

  async createPolicy(orgId: string, input: CreateReminderPolicyInput) {
    const [policy] = await this.db
      .insert(finReminderPolicies)
      .values({ orgId, name: input.name, offsets: input.offsets, channel: input.channel, template: input.template ?? null })
      .returning();
    if (!policy) throw new Error("Policy insert returned no rows");
    this.audit.log({ action: "accounting.reminder_policy.created", userId: "system", orgId, resourceType: "fin_reminder_policy", resourceId: String(policy.id), result: "SUCCESS" });
    return policy;
  }

  async updatePolicy(orgId: string, id: number, input: UpdateReminderPolicyInput) {
    const existing = await this.db.query.finReminderPolicies.findFirst({ columns: { id: true }, where: and(eq(finReminderPolicies.id, id), eq(finReminderPolicies.orgId, orgId), isNull(finReminderPolicies.archivedAt)) });
    if (!existing) throw new NotFoundException("Reminder policy not found");
    const [updated] = await this.db
      .update(finReminderPolicies)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.offsets !== undefined ? { offsets: input.offsets } : {}),
        ...(input.channel !== undefined ? { channel: input.channel } : {}),
        ...(input.template !== undefined ? { template: input.template } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(finReminderPolicies.id, id), eq(finReminderPolicies.orgId, orgId), isNull(finReminderPolicies.archivedAt)))
      .returning();
    this.audit.log({ action: "accounting.reminder_policy.updated", userId: "system", orgId, resourceType: "fin_reminder_policy", resourceId: String(id), result: "SUCCESS" });
    return updated;
  }

  async deletePolicy(orgId: string, id: number) {
    const existing = await this.db.query.finReminderPolicies.findFirst({ columns: { id: true }, where: and(eq(finReminderPolicies.id, id), eq(finReminderPolicies.orgId, orgId)) });
    if (!existing) throw new NotFoundException("Reminder policy not found");
    await this.db.update(finReminderPolicies).set({ isActive: false, archivedAt: new Date(), updatedAt: new Date() }).where(and(eq(finReminderPolicies.id, id), eq(finReminderPolicies.orgId, orgId), isNull(finReminderPolicies.archivedAt)));
    this.audit.log({ action: "accounting.reminder_policy.deleted", userId: "system", orgId, resourceType: "fin_reminder_policy", resourceId: String(id), result: "SUCCESS" });
    return { success: true };
  }

  async listLog(orgId: string, query: ListReminderLogQuery) {
    const pageLimit = Math.min(query.limit, 100);
    const conditions = [eq(finReminderLog.orgId, orgId), isNull(finReminderLog.archivedAt)];
    if (query.invoiceId) conditions.push(eq(finReminderLog.invoiceId, query.invoiceId));
    if (query.cursor) conditions.push(sql`${finReminderLog.id} > ${query.cursor}`);
    const projection = {
      id: finReminderLog.id,
      orgId: finReminderLog.orgId,
      invoiceId: finReminderLog.invoiceId,
      scheduledAt: finReminderLog.scheduledAt,
      sentAt: finReminderLog.sentAt,
      paidAt: finReminderLog.paidAt,
      channel: finReminderLog.channel,
      offsetDays: finReminderLog.offsetDays,
      status: finReminderLog.status,
    };
    const rows = await this.db.select(projection).from(finReminderLog).where(and(...conditions)).orderBy(asc(finReminderLog.id)).limit(pageLimit + 1);
    const result = buildIdCursorPage(rows, pageLimit, (row) => row.id);
    return { items: result.data, pagination: { limit: pageLimit, hasMore: result.hasMore, nextCursor: result.nextCursor } };
  }

  async effectiveness(orgId: string): Promise<{ sent: number; paidAfterReminder: number; effectivenessRate: number }> {
    const rows = await this.db.select({
      sent: sql<number>`count(*) filter (where ${finReminderLog.status} = 'SENT')`,
      paidAfterReminder: sql<number>`count(*) filter (where ${finReminderLog.status} = 'SENT' and ${finReminderLog.paidAt} is not null and ${finReminderLog.paidAt} > ${finReminderLog.sentAt})`,
    }).from(finReminderLog).where(eq(finReminderLog.orgId, orgId));
    const row = rows[0];
    const sent = Number(row?.sent ?? 0);
    const paidAfterReminder = Number(row?.paidAfterReminder ?? 0);
    return { sent, paidAfterReminder, effectivenessRate: sent > 0 ? paidAfterReminder / sent : 0 };
  }

  async processDueReminders(orgId?: string): Promise<{ sent: number }> {
    if (orgId !== undefined) {
      let sent = 0;
      let cursor: number | undefined;
      for (;;) {
        const result = await this.sweepOrg(orgId, cursor);
        sent += result.sent;
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }
      return { sent };
    }
    let sent = 0;
    await forEachOrg(this.db, "finance:invoice-reminders", async (_tx, oid) => {
      let cursor: number | undefined;
      for (;;) {
        const result = await this.sweepOrg(oid, cursor);
        sent += result.sent;
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }
    });
    return { sent };
  }

  private async sweepOrg(orgId: string, afterInvoiceId?: number): Promise<{ sent: number; nextCursor: number | null }> {
    const cursorClause = afterInvoiceId !== undefined ? sql` AND i.id > ${afterInvoiceId}` : sql``;
    const rawCandidates = await this.db.execute(sql`
      SELECT
        i.id                  AS invoice_id,
        i.invoice_number,
        i.collection_owner_id,
        p.channel,
        t.offset_day::int     AS offset_days
      FROM fin_reminder_policies p
      CROSS JOIN LATERAL unnest(p.offsets::int[]) AS t(offset_day)
      JOIN invoices i
        ON  i.org_id   = p.org_id
        AND i.due_date = (CURRENT_DATE - t.offset_day * INTERVAL '1 day')::date
        AND i.status   IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE')
        AND i.due_date IS NOT NULL
      WHERE p.org_id     = ${orgId}
        AND p.is_active  = true
        AND p.archived_at IS NULL
        ${cursorClause}
      ORDER BY i.id, p.id, t.offset_day
      LIMIT ${CANDIDATE_CAP}
    `);

    const lastCandidate = rawCandidates.at(-1);
    const nextCursor = rawCandidates.length === CANDIDATE_CAP && lastCandidate
      ? Number(lastCandidate["invoice_id"])
      : null;

    if (rawCandidates.length === 0) return { sent: 0, nextCursor: null };

    const ownerIds = [
      ...new Set(
        rawCandidates
          .map((r) => r["collection_owner_id"])
          .filter((id): id is string => typeof id === "string"),
      ),
    ];
    const activeOwnerSet = new Set<string>();
    if (ownerIds.length > 0) {
      const rows = await this.db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.status, "ACTIVE"), inArray(organizationMembers.userId, ownerIds)));
      for (const row of rows) activeOwnerSet.add(row.userId);
    }

    const hasUnowned = rawCandidates.some((r) => {
      const ownerId = r["collection_owner_id"];
      return typeof ownerId !== "string" || !activeOwnerSet.has(ownerId);
    });
    let fallbackRecipients: string[] = [];
    if (hasUnowned) {
      const members = await this.db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.status, "ACTIVE")))
        .orderBy(asc(organizationMembers.userId))
        .limit(RECIPIENT_CAP);
      fallbackRecipients = members.map((m) => m.userId);
    }

    const now = new Date();
    const seen = new Set<string>();
    const claims: {
      key: string;
      invoiceId: number;
      offsetDays: number;
      channel: "EMAIL" | "WHATSAPP";
      invoiceNumber: string;
      targetUserIds: string[];
    }[] = [];

    for (const r of rawCandidates) {
      const ownerId = typeof r["collection_owner_id"] === "string" ? r["collection_owner_id"] : null;
      const targetUserIds = ownerId && activeOwnerSet.has(ownerId) ? [ownerId] : fallbackRecipients;
      if (targetUserIds.length === 0) continue;

      const invoiceId = Number(r["invoice_id"]);
      const offsetDays = Number(r["offset_days"]);
      const key = `${invoiceId}:${offsetDays}`;
      if (seen.has(key)) continue;
      seen.add(key);

      claims.push({
        key,
        invoiceId,
        offsetDays,
        channel: r["channel"] === "WHATSAPP" ? "WHATSAPP" : "EMAIL",
        invoiceNumber: String(r["invoice_number"] ?? ""),
        targetUserIds,
      });
    }

    let sent = 0;
    await this.db.transaction(async (tx) => {
      for (let offset = 0; offset < claims.length; offset += REMINDER_CLAIM_CHUNK) {
        const chunk = claims.slice(offset, offset + REMINDER_CLAIM_CHUNK);

        const claimed = await tx
          .insert(finReminderLog)
          .values(
            chunk.map((claim) => ({
              orgId,
              invoiceId: claim.invoiceId,
              channel: claim.channel,
              offsetDays: claim.offsetDays,
              status: "PENDING" as const,
              scheduledAt: now,
            })),
          )
          .onConflictDoUpdate({
            target: [finReminderLog.orgId, finReminderLog.invoiceId, finReminderLog.offsetDays],
            set: { status: "PENDING", scheduledAt: now },
            where: inArray(finReminderLog.status, ["FAILED", "PENDING"]),
          })
          .returning({
            id: finReminderLog.id,
            invoiceId: finReminderLog.invoiceId,
            offsetDays: finReminderLog.offsetDays,
          });

        const claimedIds = new Map(
          claimed.map((row) => [`${row.invoiceId}:${row.offsetDays}`, row.id]),
        );

        const events: OutboxEventInput[] = [];
        for (const claim of chunk) {
          const reminderLogId = claimedIds.get(claim.key);
          if (reminderLogId === undefined) continue;

          const payload = invoiceReminderPayloadSchema.parse({
            orgId,
            reminderLogId,
            invoiceId: claim.invoiceId,
            invoiceNumber: claim.invoiceNumber,
            channel: claim.channel,
            offsetDays: claim.offsetDays,
            targetUserIds: claim.targetUserIds,
          });
          events.push({
            eventId: randomUUID(),
            organizationId: orgId,
            aggregateType: "fin_reminder_log",
            aggregateId: String(reminderLogId),
            aggregateVersion: 1,
            eventType: INVOICE_REMINDER_EVENT,
            payload,
            occurredAt: now,
          });
        }

        await OutboxWriter.emitMany(tx, events);
        sent += events.length;
      }
    });

    return { sent, nextCursor };
  }
}
