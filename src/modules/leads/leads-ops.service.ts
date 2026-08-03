import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { eq, and, or, inArray, lte, gte, type SQL } from "drizzle-orm";
import { AccessService } from "../access/access.service";
import {
  leads,
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
import { CrmValidationService } from "../crm/metadata/crm-validation.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import type {
  BulkDeleteInput,
  BulkUpdateInput,
  DistributeInput,
  ImportInput,
  TopMergeInput,
} from "./dto/lead-mutations.schemas";

type LeadRow = typeof leads.$inferSelect;

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
    private readonly crmValidation: CrmValidationService,
    private readonly planLimits: PlanLimitsService,
    private readonly access: AccessService,
  ) {}

  private async sendDistributionEmails(
    actorId: string,
    salesPeople: { id: string; name: string | null; email: string | null }[],
    assignments: Map<string, LeadRow[]>,
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
        leadsUrl: `${appUrl}/crm/leads`,
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
    const setData: Partial<typeof leads.$inferInsert> = {
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

    await this.db
      .update(leads)
      .set(setData)
      .where(and(eq(leads.orgId, orgId), inArray(leads.id, leadIds)));

    return { updated: leadIds.length };
  }

  async bulkDelete(orgId: string, input: BulkDeleteInput) {
    await this.db
      .delete(leads)
      .where(and(eq(leads.orgId, orgId), inArray(leads.id, input.leadIds)));

    return { deleted: input.leadIds.length };
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

    const [winner, loser] = await Promise.all([
      this.db.query.leads.findFirst({
        where: and(eq(leads.id, winnerId), eq(leads.orgId, orgId)),
      }),
      this.db.query.leads.findFirst({
        where: and(eq(leads.id, loserId), eq(leads.orgId, orgId)),
      }),
    ]);

    if (!winner) return { ok: false, reason: "winner_not_found" };
    if (!loser) return { ok: false, reason: "loser_not_found" };

    const pick = <T>(field: OverrideField, winVal: T, loseVal: T): T =>
      overrides[field] === "loser" ? loseVal : winVal;

    const mergedFields: Partial<typeof leads.$inferInsert> = {
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

    await this.db.transaction(async (tx) => {
      await tx
        .update(leads)
        .set(mergedFields)
        .where(and(eq(leads.id, winnerId), eq(leads.orgId, orgId)));
      await tx
        .update(leads)
        .set({
          deletedAt: new Date(),
          mergedIntoId: winnerId,
          updatedAt: new Date(),
        })
        .where(and(eq(leads.id, loserId), eq(leads.orgId, orgId)));
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

    const updatedWinner = await this.db.query.leads.findFirst({
      where: eq(leads.id, winnerId),
    });

    return { ok: true, winner: updatedWinner };
  }

  async importLeads(orgId: string, userId: string, input: ImportInput) {
    await this.planLimits.assertWithinLimit(
      orgId,
      "crmLeads",
      input.leads.length,
    );

    const CHUNK_SIZE = 100;

    const importEmails = input.leads
      .map((l) => l.email)
      .filter((e): e is string => !!e && e !== "");
    const importPhones = input.leads
      .map((l) => l.phone)
      .filter((p): p is string => !!p);

    const dedupeParts: SQL[] = [];
    if (importEmails.length > 0)
      dedupeParts.push(inArray(leads.email, importEmails));
    if (importPhones.length > 0)
      dedupeParts.push(inArray(leads.phone, importPhones));

    const existingLeads =
      dedupeParts.length > 0
        ? await this.db.query.leads.findMany({
            where: and(eq(leads.orgId, orgId), or(...dedupeParts)),
            columns: { id: true, email: true, phone: true },
          })
        : [];

    const dupEmails = new Set(
      existingLeads
        .map((l) => l.email?.toLowerCase())
        .filter((e): e is string => !!e),
    );
    const dupPhones = new Set(
      existingLeads.map((l) => l.phone).filter((p): p is string => !!p),
    );

    let imported = 0;
    let skipped = 0;
    let updated = 0;
    const importedLeadIds: number[] = [];
    const errors: { row: number; message: string }[] = [];

    for (let i = 0; i < input.leads.length; i += CHUNK_SIZE) {
      const chunk = input.leads.slice(i, i + CHUNK_SIZE);
      const toInsert: typeof chunk = [];

      for (let j = 0; j < chunk.length; j++) {
        const lead = chunk[j];
        const rowNum = i + j + 2;
        const isDuplicate =
          (lead.email && dupEmails.has(lead.email.toLowerCase())) ||
          (lead.phone && dupPhones.has(lead.phone));

        if (isDuplicate) {
          if (input.duplicateAction === "skip") {
            skipped++;
            errors.push({
              row: rowNum,
              message: `Duplicate (${lead.email || lead.phone})`,
            });
            continue;
          } else if (input.duplicateAction === "update") {
            const matchField =
              lead.email && dupEmails.has(lead.email.toLowerCase())
                ? eq(leads.email, lead.email)
                : lead.phone
                  ? eq(leads.phone, lead.phone)
                  : undefined;
            if (!matchField) {
              errors.push({
                row: rowNum,
                message: "Failed to update duplicate",
              });
              continue;
            }
            try {
              await this.db
                .update(leads)
                .set({
                  name: lead.name,
                  company: lead.company || null,
                  notes: lead.notes || null,
                  updatedAt: new Date(),
                })
                .where(and(eq(leads.orgId, orgId), matchField));
              updated++;
            } catch {
              errors.push({
                row: rowNum,
                message: "Failed to update duplicate",
              });
            }
            continue;
          }
        }
        const rowRecord: Record<string, unknown> = {
          name: lead.name,
          email: lead.email ?? null,
          phone: lead.phone ?? null,
          source: lead.source ?? "other",
          priority: lead.priority ?? "WARM",
        };
        const rowValidation = await this.crmValidation.evaluate(
          orgId,
          "lead",
          rowRecord,
          {
            sourceKey: lead.source ?? "other",
          },
        );
        if (!rowValidation.valid) {
          errors.push({
            row: rowNum,
            message: rowValidation.errors.map((e) => e.message).join("; "),
          });
          skipped++;
          continue;
        }

        toInsert.push(lead);
      }

      if (toInsert.length > 0) {
        try {
          const values = toInsert.map((lead) => ({
            orgId,
            name: lead.name,
            email: lead.email || null,
            phone: lead.phone || null,
            company: lead.company || null,
            source: lead.source || ("other" as const),
            notes: lead.notes || null,
            city: lead.city || null,
            designation: lead.designation || null,
            referredBy: lead.referredBy || null,
            potentialValue: lead.potentialValue || null,
            investmentInterest: lead.investmentInterest || null,
            whatsappNumber: lead.whatsappNumber || null,
            website: lead.website || null,
            priority: lead.priority || ("WARM" as const),
            tags: lead.tags || null,
            status: "NEW" as const,
            assignedById: userId,
          }));
          const result = await this.db
            .insert(leads)
            .values(values)
            .returning({ id: leads.id });
          imported += result.length;
          importedLeadIds.push(...result.map((r) => r.id));
        } catch (insertErr) {
          errors.push({
            row: i + 2,
            message: `Chunk insert failed: ${insertErr instanceof Error ? insertErr.message : "unknown error"}`,
          });
        }
      }
    }

    let distributed = 0;
    let salesPeopleCount = 0;

    if (input.autoDistribute && importedLeadIds.length > 0) {
      try {
        const permittedMembers = await this.access.membersWithPermission(orgId, "crm:leads:assign", { limit: 500 });
        const permittedUserIds = permittedMembers.map((m) => m.userId);
        const salesPeople = permittedUserIds.length > 0
          ? await this.db
              .select({ id: users.id, name: users.name })
              .from(users)
              .where(and(
                inArray(users.id, permittedUserIds),
                eq(users.isActive, true),
              ))
          : [];

        if (salesPeople.length > 0) {
          salesPeopleCount = salesPeople.length;
          const now = new Date();
          const assignmentMap = new Map<string, number[]>();
          for (const sp of salesPeople) assignmentMap.set(sp.id, []);
          for (let k = 0; k < importedLeadIds.length; k++) {
            const sp = salesPeople[k % salesPeople.length];
            const bucket = assignmentMap.get(sp.id);
            if (bucket) bucket.push(importedLeadIds[k]);
          }
          for (const [salesPersonId, leadIds] of assignmentMap) {
            if (leadIds.length === 0) continue;
            await this.db
              .update(leads)
              .set({
                assignedToId: salesPersonId,
                assignedById: userId,
                assignedAt: now,
                updatedAt: now,
              })
              .where(and(inArray(leads.id, leadIds), eq(leads.orgId, orgId)));
            distributed += leadIds.length;
          }
        }
      } catch (distErr) {
        logger.error("Auto-distribute failed after bulk import", {
          error: distErr,
        });
      }
    }

    return {
      imported,
      skipped,
      updated,
      errors,
      duplicatesFound: existingLeads.length,
      distributed,
      salesPeopleCount,
    };
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

    const leadsToDistribute = await this.db.query.leads.findMany({
      where: and(inArray(leads.id, input.leadIds), eq(leads.orgId, orgId)),
    });

    if (leadsToDistribute.length === 0) {
      return { ok: false, reason: "no_leads" };
    }

    const assignments = new Map<string, LeadRow[]>();
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
      await this.db
        .update(leads)
        .set({
          assignedToId: salesPersonId,
          assignedById: userId,
          assignedAt: now,
          updatedAt: now,
        })
        .where(and(inArray(leads.id, leadIds), eq(leads.orgId, orgId)));
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
