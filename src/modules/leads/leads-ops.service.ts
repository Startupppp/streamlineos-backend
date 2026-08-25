import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { AccessService } from "../access/access.service";
import {
  leadActivities,
  leadNotes,
  leadTasks,
  leadEmails,
  users,
  organizationMembers,
  leaveRequests,
  leadImportBatches,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { logger } from "../../common/logger/logger.service";
import { EmailService } from "../email/email.service";
import { appUrl } from "../email/app-url";
import { getLeadDistributionEmailTemplate } from "../email/templates/crm";
import type {
  BulkDeleteInput,
  BulkUpdateInput,
  DistributeInput,
  TopMergeInput,
} from "./dto/lead-mutations.schemas";
import { softDeleteMirroredLeads, updateMirroredLeads } from "../party/party-legacy-leads";
import type { LeadInsert, LeadRow } from "../party/party-legacy-writer";
import { INCLUDE_DELETED, loadLeadViews, type LeadView } from "./lead-party-reader";

type OverrideField = keyof TopMergeInput["overrides"];

export type MergeLeadsResult =
  | { ok: true; winner: LeadRow | undefined }
  | { ok: false; reason: "self" | "winner_not_found" | "loser_not_found" };

export type DistributeResult =
  | { ok: true; data: Record<string, unknown> }
  | {
      ok: false;
      reason: "no_members" | "no_sales" | "all_on_leave" | "no_leads";
    };

@Injectable()
export class LeadsOpsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly access: AccessService,
  ) {}

  private async sendDistributionEmails(
    actorId: string,
    salesPeople: { id: string; name: string | null; email: string | null }[],
    assignments: Map<string, LeadView[]>,
  ): Promise<void> {
    const actor = await this.db.query.users.findFirst({
      where: eq(users.id, actorId),
      columns: { name: true },
    });
    const assignerName = actor?.name ?? "A manager";

    for (const sp of salesPeople) {
      const assignedLeads = assignments.get(sp.id) ?? [];
      if (assignedLeads.length === 0 || !sp.email) continue;
      const { subject, html } = getLeadDistributionEmailTemplate({
        recipientName: sp.name ?? "Team Member",
        assignerName,
        leadCount: assignedLeads.length,
        leadsUrl: `${appUrl()}/crm/leads`,
      });
      try {
        await this.email.sendEmail({ to: sp.email, subject, html });
      } catch (error) {
        logger.error("Failed to send lead distribution email", {
          salesPersonId: sp.id,
          error,
        });
      }
    }
  }

  getImportBatch(orgId: string, batchId: number) {
    return this.db.query.leadImportBatches.findFirst({
      where: and(
        eq(leadImportBatches.id, batchId),
        eq(leadImportBatches.orgId, orgId),
      ),
    });
  }

  async bulkUpdate(orgId: string, userId: string, input: BulkUpdateInput) {
    const { leadIds, update } = input;
    const setData: Partial<LeadInsert> = {
      updatedAt: new Date(),
    };

    if (update.status) setData.status = update.status;
    if (update.priority) setData.priority = update.priority;
    if (update.assignedToId) {
      const member = await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.userId, update.assignedToId),
          eq(organizationMembers.orgId, orgId),
        ),
        columns: { id: true },
      });
      if (!member)
        throw new BadRequestException("Assignee not found in organization");
      setData.assignedToId = update.assignedToId;
      setData.assignedAt = new Date();
      setData.assignedById = userId;
    }

    await updateMirroredLeads(this.db, orgId, leadIds, setData);

    return { updated: leadIds.length };
  }

  /**
   * Soft delete, batched into a single UPDATE. The count comes from
   * `.returning()`, not `input.leadIds.length` — the old version reported the
   * requested count, so passing ids from another tenant (or already-deleted
   * ones) reported success for rows it never touched.
   */
  async bulkDelete(orgId: string, input: BulkDeleteInput) {
    const deleted = await softDeleteMirroredLeads(this.db, orgId, input.leadIds);

    return { deleted: deleted.length, requested: input.leadIds.length };
  }

  async mergeLeads(
    orgId: string,
    userId: string,
    input: TopMergeInput,
  ): Promise<MergeLeadsResult> {
    const { winnerId, loserId, overrides } = input;

    if (winnerId === loserId) {
      return { ok: false, reason: "self" };
    }

    const pair = new Map(
      (await loadLeadViews(this.db, orgId, [winnerId, loserId], INCLUDE_DELETED)).map(
        (lead) => [lead.id, lead],
      ),
    );
    const winner = pair.get(winnerId);
    const loser = pair.get(loserId);

    if (!winner) return { ok: false, reason: "winner_not_found" };
    if (!loser) return { ok: false, reason: "loser_not_found" };

    const pick = <T>(field: OverrideField, winVal: T, loseVal: T): T =>
      overrides[field] === "loser" ? loseVal : winVal;

    const mergedFields: Partial<LeadInsert> = {
      name: pick("name", winner.name, loser.name),
      email: pick("email", winner.email, loser.email),
      phone: pick("phone", winner.phone, loser.phone),
      company: pick("company", winner.company, loser.company),
      city: pick("city", winner.city, loser.city),
      source: pick("source", winner.source, loser.source),
      notes: pick("notes", winner.notes, loser.notes),
      priority: pick("priority", winner.priority, loser.priority),
      assignedToId: pick(
        "assignedToId",
        winner.assignedToId,
        loser.assignedToId,
      ),
      tags: pick("tags", winner.tags, loser.tags),
      updatedAt: new Date(),
    };

    if (loser.score != null && (winner.score ?? 0) < loser.score) {
      mergedFields.score = loser.score;
    }

    const merged = await this.db.transaction(async (tx) => {
      const [winnerRow] = await updateMirroredLeads(tx, orgId, [winnerId], mergedFields);
      await updateMirroredLeads(tx, orgId, [loserId], {
        deletedAt: new Date(),
        mergedIntoId: winnerId,
        updatedAt: new Date(),
      });
      await tx
        .update(leadActivities)
        .set({ leadId: winnerId })
        .where(eq(leadActivities.leadId, loserId));
      await tx
        .update(leadNotes)
        .set({ leadId: winnerId })
        .where(eq(leadNotes.leadId, loserId));
      await tx
        .update(leadTasks)
        .set({ leadId: winnerId })
        .where(eq(leadTasks.leadId, loserId));
      await tx
        .update(leadEmails)
        .set({ leadId: winnerId })
        .where(eq(leadEmails.leadId, loserId));
      return winnerRow;
    });

    this.audit.log({
      action: "LEAD_MERGED",
      userId,
      orgId,
      targetId: String(winnerId),
      targetType: "lead",
      metadata: {
        winnerId,
        loserId,
        winnerName: winner.name,
        loserName: loser.name,
        overrides,
      },
    });

    // The winner comes back from the write that produced it rather than from a
    // read afterwards. The read it replaces was `WHERE id = winnerId` with no
    // organisation predicate at all, and re-reading a row the transaction just
    // returned only widens the window in which it can disagree.
    return { ok: true, winner: merged };
  }

  async distribute(
    orgId: string,
    userId: string,
    input: DistributeInput,
  ): Promise<DistributeResult> {
    const [firstMember] = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, orgId))
      .limit(1);

    if (!firstMember) return { ok: false, reason: "no_members" };

    const permittedForDistribute = await this.access.membersWithPermission(orgId, "crm:leads:assign", { limit: 500 });
    const permittedDistributeIds = permittedForDistribute.map((m) => m.userId);
    const salesPeople = permittedDistributeIds.length > 0
      ? await this.db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(and(
            inArray(users.id, permittedDistributeIds),
            eq(users.isActive, true),
          ))
      : [];

    if (salesPeople.length === 0) {
      return { ok: false, reason: "no_sales" };
    }

    const today = new Date().toISOString().slice(0, 10);
    const approvedLeaves = await this.db.query.leaveRequests.findMany({
      where: and(
        eq(leaveRequests.orgId, orgId),
        eq(leaveRequests.status, "APPROVED"),
        lte(leaveRequests.startDate, today),
        gte(leaveRequests.endDate, today),
      ),
      columns: { userId: true },
    });
    const absentUserIds = new Set(approvedLeaves.map((l) => l.userId));
    const absentSalesPeople = salesPeople.filter((sp) =>
      absentUserIds.has(sp.id),
    );

    let availableSalesPeople = salesPeople;
    if (input.skipAbsent && absentSalesPeople.length > 0) {
      availableSalesPeople = salesPeople.filter(
        (sp) => !absentUserIds.has(sp.id),
      );
      if (availableSalesPeople.length === 0) {
        return { ok: false, reason: "all_on_leave" };
      }
    }

    const leadsToDistribute = await loadLeadViews(this.db, orgId, input.leadIds);

    if (leadsToDistribute.length === 0) {
      return { ok: false, reason: "no_leads" };
    }

    const assignments = new Map<string, LeadView[]>();
    for (const sp of availableSalesPeople) assignments.set(sp.id, []);

    for (let i = 0; i < leadsToDistribute.length; i++) {
      const sp = availableSalesPeople[i % availableSalesPeople.length];
      const bucket = assignments.get(sp.id);
      if (bucket) bucket.push(leadsToDistribute[i]);
    }

    const now = new Date();
    for (const [salesPersonId, assignedLeads] of assignments) {
      if (assignedLeads.length === 0) continue;
      const leadIds = assignedLeads.map((l) => l.id);
      await updateMirroredLeads(this.db, orgId, leadIds, {
        assignedToId: salesPersonId,
        assignedById: userId,
        assignedAt: now,
        updatedAt: now,
      });
    }

    void this.sendDistributionEmails(userId, salesPeople, assignments).catch(
      () => undefined,
    );

    return {
      ok: true,
      data: {
        distributed: leadsToDistribute.length,
        salesPeople: availableSalesPeople.length,
        totalSalesPeople: salesPeople.length,
        absentCount: absentSalesPeople.length,
        absentNames: absentSalesPeople.map((sp) => sp.name || "Unknown"),
        summary: [...assignments.entries()].map(([id, assignedLeads]) => ({
          userId: id,
          name:
            availableSalesPeople.find((sp) => sp.id === id)?.name || "Unknown",
          count: assignedLeads.length,
        })),
      },
    };
  }
}
