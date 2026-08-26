import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, or, type SQL } from "drizzle-orm";
import { users } from "../../db/schema";
import { businessParties, leadPartyMap } from "../../db/schema/party";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { logSideEffectFailure } from "../../common/logger/side-effect";
import { AccessService } from "../access/access.service";
import { CrmValidationService } from "../crm/metadata/crm-validation.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import type { ImportInput } from "./dto/lead-mutations.schemas";
import { createMirroredLeads, updateMirroredLeads } from "../party/party-legacy-leads";
import {
  INCLUDE_DELETED,
  LEAD_PARTY_COLUMNS,
  LEAD_PARTY_JOIN,
  leadPartyScope,
} from "./lead-party-reader";

/**
 * Bringing a spreadsheet of leads in.
 *
 * Split out of `leads-ops.service.ts` when this batch pushed that file past the
 * review threshold. The seam is the one the module already had: an import is a
 * chunked, validating, deduplicating pipeline with its own failure report, where
 * everything left behind is a bulk edit of records the user already has.
 */
@Injectable()
export class LeadsImportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly crmValidation: CrmValidationService,
    private readonly planLimits: PlanLimitsService,
    private readonly access: AccessService,
  ) {}

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
      dedupeParts.push(inArray(LEAD_PARTY_COLUMNS.email, importEmails));
    if (importPhones.length > 0)
      dedupeParts.push(inArray(LEAD_PARTY_COLUMNS.phone, importPhones));

    const existingLeads =
      dedupeParts.length > 0
        ? await this.db
            .select({
              id: LEAD_PARTY_COLUMNS.id,
              email: LEAD_PARTY_COLUMNS.email,
              phone: LEAD_PARTY_COLUMNS.phone,
            })
            .from(leadPartyMap)
            .innerJoin(businessParties, LEAD_PARTY_JOIN)
            .where(and(...leadPartyScope(orgId, INCLUDE_DELETED), or(...dedupeParts)))
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
                ? eq(LEAD_PARTY_COLUMNS.email, lead.email)
                : lead.phone
                  ? eq(LEAD_PARTY_COLUMNS.phone, lead.phone)
                  : undefined;
            if (!matchField) {
              errors.push({
                row: rowNum,
                message: "Failed to update duplicate",
              });
              continue;
            }
            try {
              // Resolved to ids first: the mirror is written per record, and a
              // predicate match cannot say which parties to move.
              const matches = await this.db
                .select({ id: LEAD_PARTY_COLUMNS.id })
                .from(leadPartyMap)
                .innerJoin(businessParties, LEAD_PARTY_JOIN)
                .where(and(...leadPartyScope(orgId, INCLUDE_DELETED), matchField));
              await updateMirroredLeads(
                this.db,
                orgId,
                matches.map((row) => row.id),
                {
                  name: lead.name,
                  company: lead.company || null,
                  notes: lead.notes || null,
                  updatedAt: new Date(),
                },
              );
              updated++;
            } catch (err) {
              logSideEffectFailure("leads-import: duplicate update", { row: rowNum })(err);
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
          const result = await createMirroredLeads(this.db, orgId, values, {
            linkedBy: "leads:import",
          });
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
            await updateMirroredLeads(this.db, orgId, leadIds, {
              assignedToId: salesPersonId,
              assignedById: userId,
              assignedAt: now,
              updatedAt: now,
            });
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
}

