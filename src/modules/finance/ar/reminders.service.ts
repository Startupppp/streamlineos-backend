import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { finReminderPolicies, finReminderLog, invoices, organizationMembers } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { buildListResponse, paginateOffset } from "../../../common/pagination/pagination";
import { buildIdCursorPage } from "../../../common/pagination/cursor";
import type { CreateReminderPolicyInput, UpdateReminderPolicyInput, ListReminderPoliciesQuery, ListReminderLogQuery } from "./dto/finance-ar.schemas";
import { logSideEffectFailure } from "../../../common/logger/side-effect";

@Injectable()
export class RemindersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
    private readonly audit: AuditService,
  ) {}

  async listPolicies(orgId: string, query: ListReminderPoliciesQuery) {
    const page = query.page ?? 1;
    const pageSize = query.limit ?? query.pageSize ?? 50;
    const conditions = [eq(finReminderPolicies.orgId, orgId), isNull(finReminderPolicies.archivedAt)];
    if (query.cursor !== undefined) conditions.push(gt(finReminderPolicies.id, query.cursor));
    const where = and(...conditions);
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
    if (query.cursor !== undefined || query.limit !== undefined) {
      const rows = await this.db.select(projection).from(finReminderPolicies).where(where).orderBy(asc(finReminderPolicies.id)).limit(pageSize + 1);
      const result = buildIdCursorPage(rows, pageSize, (row) => row.id);
      return { items: result.data, pagination: { limit: pageSize, hasMore: result.hasMore, nextCursor: result.nextCursor === undefined ? null : String(result.nextCursor) } };
    }
    const { limit, offset } = paginateOffset({ page, pageSize });
    const [rows, [{ count }]] = await Promise.all([
      this.db.select(projection).from(finReminderPolicies).where(where).orderBy(desc(finReminderPolicies.createdAt), desc(finReminderPolicies.id)).limit(limit).offset(offset),
      this.db.select({ count: sql<number>`count(*)::int` }).from(finReminderPolicies).where(where),
    ]);
    return buildListResponse(rows, count, { page, pageSize });
  }

  async createPolicy(orgId: string, input: CreateReminderPolicyInput) {
    const [policy] = await this.db
      .insert(finReminderPolicies)
      .values({
        orgId,
        name: input.name,
        offsets: input.offsets,
        channel: input.channel,
        template: input.template ?? null,
      })
      .returning();
    if (!policy) throw new Error("Policy insert returned no rows");
    this.audit.log({ action: "accounting.reminder_policy.created", userId: "system", orgId, resourceType: "fin_reminder_policy", resourceId: String(policy.id), result: "SUCCESS" });
    return policy;
  }

  async updatePolicy(orgId: string, id: number, input: UpdateReminderPolicyInput) {
    const existing = await this.db.query.finReminderPolicies.findFirst({ where: and(eq(finReminderPolicies.id, id), eq(finReminderPolicies.orgId, orgId)) });
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
      .where(and(eq(finReminderPolicies.id, id), eq(finReminderPolicies.orgId, orgId)))
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
    const page = query.page ?? 1;
    const pageSize = query.limit ?? query.pageSize ?? 50;
    const conditions = [eq(finReminderLog.orgId, orgId), isNull(finReminderLog.archivedAt)];
    if (query.invoiceId) conditions.push(eq(finReminderLog.invoiceId, query.invoiceId));
    if (query.cursor !== undefined) conditions.push(gt(finReminderLog.id, query.cursor));
    const where = and(...conditions);
    const projection = {
      id: finReminderLog.id,
      orgId: finReminderLog.orgId,
      invoiceId: finReminderLog.invoiceId,
      sentAt: finReminderLog.sentAt,
      channel: finReminderLog.channel,
      offsetDays: finReminderLog.offsetDays,
      status: finReminderLog.status,
    };
    if (query.cursor !== undefined || query.limit !== undefined) {
      const rows = await this.db.select(projection).from(finReminderLog).where(where).orderBy(asc(finReminderLog.id)).limit(pageSize + 1);
      const result = buildIdCursorPage(rows, pageSize, (row) => row.id);
      return { items: result.data, pagination: { limit: pageSize, hasMore: result.hasMore, nextCursor: result.nextCursor === undefined ? null : String(result.nextCursor) } };
    }
    const { limit, offset } = paginateOffset({ page, pageSize });
    const [rows, [{ count }]] = await Promise.all([
      this.db.select(projection).from(finReminderLog).where(where).orderBy(desc(finReminderLog.sentAt), desc(finReminderLog.id)).limit(limit).offset(offset),
      this.db.select({ count: sql<number>`count(*)::int` }).from(finReminderLog).where(where),
    ]);
    return buildListResponse(rows, count, { page, pageSize });
  }

  async processDueReminders(orgId?: string) {
    const today = new Date().toISOString().slice(0, 10);
    const todayMs = new Date(`${today}T00:00:00Z`).getTime();

    const policyWhere = orgId ? and(eq(finReminderPolicies.isActive, true), eq(finReminderPolicies.orgId, orgId)) : eq(finReminderPolicies.isActive, true);
    const policies = await this.db.select({ id: finReminderPolicies.id, orgId: finReminderPolicies.orgId, offsets: finReminderPolicies.offsets, channel: finReminderPolicies.channel }).from(finReminderPolicies).where(and(policyWhere, isNull(finReminderPolicies.archivedAt))).limit(1000).orderBy(asc(finReminderPolicies.id));
    if (policies.length === 0) return { sent: 0 };

    const invWhere = and(
      inArray(invoices.status, ["ISSUED", "PARTIALLY_PAID", "OVERDUE"]),
      isNotNull(invoices.dueDate),
      ...(orgId ? [eq(invoices.orgId, orgId)] : []),
    );
    const memberRows = await this.db
      .select({ orgId: organizationMembers.orgId, userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.status, "ACTIVE"), orgId ? eq(organizationMembers.orgId, orgId) : sql`true`));
    const membersByOrg = new Map<string, string[]>();
    for (const member of memberRows) {
      const members = membersByOrg.get(member.orgId) ?? [];
      if (members.length < 5) members.push(member.userId);
      membersByOrg.set(member.orgId, members);
    }
    let invoiceCursor = 0;
    const batchSize = 500;
    let sent = 0;
    for (;;) {
      const batch = await this.db
        .select({ id: invoices.id, orgId: invoices.orgId, invoiceNumber: invoices.invoiceNumber, dueDate: invoices.dueDate, collectionOwnerId: invoices.collectionOwnerId })
        .from(invoices)
        .where(and(invWhere, gt(invoices.id, invoiceCursor)))
        .limit(batchSize)
        .orderBy(asc(invoices.id));
      sent += await this.processInvoiceBatch(batch, policies, membersByOrg, todayMs);
      const last = batch[batch.length - 1];
      if (!last || batch.length < batchSize) break;
      invoiceCursor = last.id;
    }

    return { sent };
  }

  private async processInvoiceBatch(
    invoicesBatch: Array<{ id: number; orgId: string; invoiceNumber: string; dueDate: string | null; collectionOwnerId: string | null }>,
    policies: Array<{ id: number; orgId: string; offsets: number[]; channel: "EMAIL" | "WHATSAPP" }>,
    membersByOrg: Map<string, string[]>,
    todayMs: number,
  ): Promise<number> {
    let sent = 0;
    for (const policy of policies) {
      for (const inv of invoicesBatch) {
        if (policy.orgId !== inv.orgId) continue;
        if (!inv.dueDate) continue;
        for (const offsetDays of policy.offsets) {
          const dueMs = new Date(`${inv.dueDate}T00:00:00Z`).getTime();
          const targetMs = dueMs + offsetDays * 86400000;
          if (Math.abs(targetMs - todayMs) >= 43200000) continue;

          const insertResult = await this.db
            .insert(finReminderLog)
            .values({
              orgId: inv.orgId,
              invoiceId: inv.id,
              channel: policy.channel,
              offsetDays,
              status: "PENDING",
            })
            .onConflictDoUpdate({
              target: [finReminderLog.orgId, finReminderLog.invoiceId, finReminderLog.offsetDays],
              set: { status: "PENDING" },
              where: inArray(finReminderLog.status, ["FAILED", "PENDING"]),
            })
            .returning({ id: finReminderLog.id });
          if (insertResult.length === 0) continue;

          const targetUserIds = inv.collectionOwnerId ? [inv.collectionOwnerId] : (membersByOrg.get(inv.orgId) ?? []);

          if (targetUserIds.length === 0) {
            await this.db.update(finReminderLog).set({ status: "FAILED" }).where(eq(finReminderLog.id, insertResult[0]!.id));
            continue;
          }

          let delivered = false;
          await this.dispatch.emit({
              eventKey: "accounting.invoice.overdue",
              orgId: inv.orgId,
              dedupeKey: `invoice-reminder:${inv.orgId}:${inv.id}:${policy.id}:${offsetDays}`,
              targetUserIds,
              entityType: "invoice",
              entityId: String(inv.id),
              title: "Invoice payment reminder",
              message: `Reminder: Invoice ${inv.invoiceNumber} ${offsetDays >= 0 ? `is due in ${offsetDays} days` : `was due ${Math.abs(offsetDays)} days ago`}`,
          }).then(async () => {
            await this.db.update(finReminderLog).set({ status: "SENT" }).where(eq(finReminderLog.id, insertResult[0]!.id));
            delivered = true;
          }).catch(async (error: unknown) => {
            await this.db.update(finReminderLog).set({ status: "FAILED" }).where(eq(finReminderLog.id, insertResult[0]!.id));
            logSideEffectFailure("invoice reminder notification dispatch", { orgId: inv.orgId, invoiceId: inv.id })(error);
          });
          if (delivered) sent++;
        }
      }
    }
    return sent;
  }
}
