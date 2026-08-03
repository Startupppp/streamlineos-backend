import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { finReminderPolicies, finReminderLog, invoices, organizationMembers } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { buildListResponse, paginateOffset } from "../../../common/pagination/pagination";
import type { CreateReminderPolicyInput, UpdateReminderPolicyInput, ListReminderPoliciesQuery, ListReminderLogQuery } from "./dto/finance-ar.schemas";

@Injectable()
export class RemindersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
    private readonly audit: AuditService,
  ) {}

  async listPolicies(orgId: string, query: ListReminderPoliciesQuery) {
    const { limit, offset } = paginateOffset(query);
    const where = eq(finReminderPolicies.orgId, orgId);
    const [rows, [{ count }]] = await Promise.all([
      this.db.select().from(finReminderPolicies).where(where).orderBy(desc(finReminderPolicies.createdAt)).limit(limit).offset(offset),
      this.db.select({ count: sql<number>`count(*)::int` }).from(finReminderPolicies).where(where),
    ]);
    return buildListResponse(rows, count, query);
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
    await this.db.delete(finReminderPolicies).where(and(eq(finReminderPolicies.id, id), eq(finReminderPolicies.orgId, orgId)));
    this.audit.log({ action: "accounting.reminder_policy.deleted", userId: "system", orgId, resourceType: "fin_reminder_policy", resourceId: String(id), result: "SUCCESS" });
    return { success: true };
  }

  async listLog(orgId: string, query: ListReminderLogQuery) {
    const { limit, offset } = paginateOffset(query);
    const conditions = [eq(finReminderLog.orgId, orgId)];
    if (query.invoiceId) conditions.push(eq(finReminderLog.invoiceId, query.invoiceId));
    const [rows, [{ count }]] = await Promise.all([
      this.db.select().from(finReminderLog).where(and(...conditions)).orderBy(desc(finReminderLog.sentAt)).limit(limit).offset(offset),
      this.db.select({ count: sql<number>`count(*)::int` }).from(finReminderLog).where(and(...conditions)),
    ]);
    return buildListResponse(rows, count, query);
  }

  async processDueReminders(orgId?: string) {
    const today = new Date().toISOString().slice(0, 10);
    const todayMs = new Date(`${today}T00:00:00Z`).getTime();

    const policyWhere = orgId ? and(eq(finReminderPolicies.isActive, true), eq(finReminderPolicies.orgId, orgId)) : eq(finReminderPolicies.isActive, true);
    const policies = await this.db.select().from(finReminderPolicies).where(policyWhere).limit(1000).orderBy(asc(finReminderPolicies.id));
    if (policies.length === 0) return { sent: 0 };

    const invWhere = and(
      inArray(invoices.status, ["ISSUED", "PARTIALLY_PAID", "OVERDUE"]),
      isNotNull(invoices.dueDate),
      ...(orgId ? [eq(invoices.orgId, orgId)] : []),
    );
    const openInvoices = await this.db
      .select({ id: invoices.id, orgId: invoices.orgId, invoiceNumber: invoices.invoiceNumber, dueDate: invoices.dueDate, collectionOwnerId: invoices.collectionOwnerId })
      .from(invoices)
      .where(invWhere)
      .limit(2000)
      .orderBy(asc(invoices.id));

    let sent = 0;
    for (const policy of policies) {
      for (const inv of openInvoices) {
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
              status: "sent",
            })
            .onConflictDoNothing()
            .returning({ id: finReminderLog.id });
          if (insertResult.length === 0) continue;

          let targetUserIds: string[];
          if (inv.collectionOwnerId) {
            targetUserIds = [inv.collectionOwnerId];
          } else {
            const members = await this.db.select({ userId: organizationMembers.userId }).from(organizationMembers).where(eq(organizationMembers.orgId, inv.orgId)).limit(5);
            targetUserIds = members.map((m) => m.userId);
          }

          if (targetUserIds.length > 0) {
            void this.dispatch.emit({
              eventKey: "accounting.invoice.overdue",
              orgId: inv.orgId,
              targetUserIds,
              entityType: "invoice",
              entityId: String(inv.id),
              title: "Invoice payment reminder",
              message: `Reminder: Invoice ${inv.invoiceNumber} ${offsetDays >= 0 ? `is due in ${offsetDays} days` : `was due ${Math.abs(offsetDays)} days ago`}`,
            }).catch(() => undefined);
          }
          sent++;
        }
      }
    }
    return { sent };
  }
}
