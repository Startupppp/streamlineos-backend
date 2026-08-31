import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { finReminderPolicies, finReminderLog, invoices, organizationMembers } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { randomUUID } from "node:crypto";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { INVOICE_REMINDER_EVENT, invoiceReminderPayloadSchema } from "./dto/reminder-outbox.schemas";
import { buildIdCursorPage } from "../../../common/pagination/cursor";
import type { CreateReminderPolicyInput, UpdateReminderPolicyInput, ListReminderPoliciesQuery, ListReminderLogQuery } from "./dto/finance-ar.schemas";
import { boundedMap } from "../../../common/async/bounded-map";
import { forEachOrg } from "../../../common/tenant";

const REMINDER_BATCH_SIZE = 100;
const RECIPIENT_CAP = 10;
const POLICY_CAP = 100;

type PolicyRow = { id: number; offsets: number[]; channel: "EMAIL" | "WHATSAPP" };
type InvoiceRow = { id: number; invoiceNumber: string; dueDate: string | null; collectionOwnerId: string | null };

@Injectable()
export class RemindersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async listPolicies(orgId: string, query: ListReminderPoliciesQuery) {
    const pageLimit = Math.min(query.limit, 100);
    const conditions = [eq(finReminderPolicies.orgId, orgId), isNull(finReminderPolicies.archivedAt)];
    if (query.cursor) conditions.push(gt(finReminderPolicies.id, query.cursor));
    const projection = {
      id: finReminderPolicies.id,
      orgId: finReminderPolicies.orgId,
      name: finReminderPolicies.name,
      offsets: finReminderPolicies.offsets,
      channel: finReminderPolicies.channel,
      template: finReminderPolicies.template,
      isActive: finReminderPolicies.isActive,
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
    const existing = await this.db.query.finReminderPolicies.findFirst({ where: and(eq(finReminderPolicies.id, id), eq(finReminderPolicies.orgId, orgId), isNull(finReminderPolicies.archivedAt)) });
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
    const existing = await this.db.query.finReminderPolicies.findFirst({ where: and(eq(finReminderPolicies.id, id), eq(finReminderPolicies.orgId, orgId)) });
    if (!existing) throw new NotFoundException("Reminder policy not found");
    await this.db.update(finReminderPolicies).set({ isActive: false, archivedAt: new Date(), updatedAt: new Date() }).where(and(eq(finReminderPolicies.id, id), eq(finReminderPolicies.orgId, orgId), isNull(finReminderPolicies.archivedAt)));
    this.audit.log({ action: "accounting.reminder_policy.deleted", userId: "system", orgId, resourceType: "fin_reminder_policy", resourceId: String(id), result: "SUCCESS" });
    return { success: true };
  }

  async listLog(orgId: string, query: ListReminderLogQuery) {
    const pageLimit = Math.min(query.limit, 100);
    const conditions = [eq(finReminderLog.orgId, orgId), isNull(finReminderLog.archivedAt)];
    if (query.invoiceId) conditions.push(eq(finReminderLog.invoiceId, query.invoiceId));
    if (query.cursor) conditions.push(gt(finReminderLog.id, query.cursor));
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
    if (orgId !== undefined) return this.sweepOrg(orgId);
    let sent = 0;
    await forEachOrg(this.db, "finance:invoice-reminders", async (_tx, oid) => {
      const result = await this.sweepOrg(oid);
      sent += result.sent;
    });
    return { sent };
  }

  private async sweepOrg(orgId: string): Promise<{ sent: number }> {
    const today = new Date().toISOString().slice(0, 10);
    const todayMs = new Date(`${today}T00:00:00Z`).getTime();

    const policies = await this.db
      .select({ id: finReminderPolicies.id, offsets: finReminderPolicies.offsets, channel: finReminderPolicies.channel })
      .from(finReminderPolicies)
      .where(and(eq(finReminderPolicies.orgId, orgId), eq(finReminderPolicies.isActive, true), isNull(finReminderPolicies.archivedAt)))
      .orderBy(asc(finReminderPolicies.id))
      .limit(POLICY_CAP);

    if (policies.length === 0) return { sent: 0 };

    const dueDateSet = new Set<string>();
    for (const policy of policies) {
      for (const offsetDays of policy.offsets) {
        const target = new Date(todayMs - offsetDays * 86400000);
        dueDateSet.add(target.toISOString().slice(0, 10));
      }
    }
    const dueDates = [...dueDateSet];
    if (dueDates.length === 0) return { sent: 0 };

    let afterId: number | undefined;
    let sent = 0;

    for (;;) {
      const conditions = [
        eq(invoices.orgId, orgId),
        inArray(invoices.status, ["ISSUED", "PARTIALLY_PAID", "OVERDUE"]),
        isNotNull(invoices.dueDate),
        inArray(invoices.dueDate, dueDates),
      ];
      if (afterId !== undefined) conditions.push(gt(invoices.id, afterId));

      const batch = await this.db
        .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber, dueDate: invoices.dueDate, collectionOwnerId: invoices.collectionOwnerId })
        .from(invoices)
        .where(and(...conditions))
        .orderBy(asc(invoices.id))
        .limit(REMINDER_BATCH_SIZE);

      if (batch.length === 0) break;

      sent += await this.processBatch(orgId, batch, policies, todayMs);

      const last = batch[batch.length - 1];
      if (batch.length < REMINDER_BATCH_SIZE || last === undefined) break;
      afterId = last.id;
    }

    return { sent };
  }

  private async processBatch(
    orgId: string,
    batch: InvoiceRow[],
    policies: PolicyRow[],
    todayMs: number,
  ): Promise<number> {
    const ownerIds = [...new Set(batch.map((inv) => inv.collectionOwnerId).filter((id): id is string => id !== null))];
    const activeOwnerSet = new Set<string>();

    if (ownerIds.length > 0) {
      const rows = await this.db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.status, "ACTIVE"), inArray(organizationMembers.userId, ownerIds)));
      for (const row of rows) activeOwnerSet.add(row.userId);
    }

    const needsFallback = batch.some((inv) => !inv.collectionOwnerId || !activeOwnerSet.has(inv.collectionOwnerId));
    let fallbackRecipients: string[] = [];
    if (needsFallback) {
      const members = await this.db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.status, "ACTIVE")))
        .orderBy(asc(organizationMembers.userId))
        .limit(RECIPIENT_CAP);
      fallbackRecipients = members.map((m) => m.userId);
    }

    const work: Array<{ inv: InvoiceRow; policy: PolicyRow; offsetDays: number }> = [];
    for (const inv of batch) {
      if (!inv.dueDate) continue;
      const invMs = new Date(`${inv.dueDate}T00:00:00Z`).getTime();
      for (const policy of policies) {
        for (const offsetDays of policy.offsets) {
          const targetMs = invMs + offsetDays * 86400000;
          if (Math.abs(targetMs - todayMs) < 43200000) work.push({ inv, policy, offsetDays });
        }
      }
    }

    if (work.length === 0) return 0;

    const results = await boundedMap(work, 8, async ({ inv, policy, offsetDays }) => {
      const targetUserIds = inv.collectionOwnerId && activeOwnerSet.has(inv.collectionOwnerId)
        ? [inv.collectionOwnerId]
        : fallbackRecipients;
      if (targetUserIds.length === 0) return 0;

      const queued = await this.db.transaction(async (tx) => {
        const now = new Date();
        const insertResult = await tx
          .insert(finReminderLog)
          .values({ orgId, invoiceId: inv.id, channel: policy.channel, offsetDays, status: "PENDING", scheduledAt: now })
          .onConflictDoUpdate({
            target: [finReminderLog.orgId, finReminderLog.invoiceId, finReminderLog.offsetDays],
            set: { status: "PENDING", scheduledAt: now },
            where: inArray(finReminderLog.status, ["FAILED", "PENDING"]),
          })
          .returning({ id: finReminderLog.id });
        const reminderLogId = insertResult[0]?.id;
        if (reminderLogId === undefined) return false;
        const payload = invoiceReminderPayloadSchema.parse({
          orgId,
          reminderLogId,
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          channel: policy.channel,
          offsetDays,
          targetUserIds,
        });
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "fin_reminder_log",
          aggregateId: String(reminderLogId),
          aggregateVersion: 1,
          eventType: INVOICE_REMINDER_EVENT,
          payload,
          occurredAt: new Date(),
        });
        return true;
      });

      return queued ? 1 : 0;
    });

    return results.reduce((t, r) => t + (r.status === "fulfilled" ? r.value : 0), 0);
  }
}
