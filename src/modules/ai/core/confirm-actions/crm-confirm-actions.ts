import { BadRequestException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { crmOptions } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import { LeadsService } from "../../../leads/leads.service";
import { LeadsDetailService } from "../../../leads/leads-detail.service";
import { createSchema as createLeadSchema } from "../../../leads/dto/lead.schemas";
import {
  createLeadPayloadSchema,
  logLeadActivityPayloadSchema,
  updateLeadStatusPayloadSchema,
} from "../dto/confirm-action-payloads.schemas";
import { defineConfirmableAction } from "./confirmable-action.types";

const CRM_OPTION_CAP = 100;

export async function configuredLeadOptions(
  db: Db,
  orgId: string,
  optionType: "lead_status" | "lead_priority",
): Promise<string[]> {
  const rows = await db
    .select({ key: crmOptions.key })
    .from(crmOptions)
    .where(
      and(
        eq(crmOptions.orgId, orgId),
        eq(crmOptions.type, optionType),
        eq(crmOptions.isActive, true),
      ),
    )
    .limit(CRM_OPTION_CAP);
  return rows.map((row) => row.key);
}

async function assertConfiguredOption(
  db: Db,
  orgId: string,
  optionType: "lead_status" | "lead_priority",
  value: string,
): Promise<void> {
  const allowed = await configuredLeadOptions(db, orgId, optionType);
  if (allowed.length === 0) return;
  if (allowed.some((key) => key.toLowerCase() === value.toLowerCase())) return;
  throw new BadRequestException(
    `"${value}" is not a configured ${optionType.replace("lead_", "lead ")}. Configured: ${allowed.join(", ")}.`,
  );
}

export const CRM_CONFIRM_ACTIONS = [
  defineConfirmableAction({
    action: "crm.createLead",
    permission: "crm:leads:create",
    payload: createLeadPayloadSchema,
    resolve: (moduleRef) => moduleRef.get(LeadsService, { strict: false }),
    execute: async (payload, { actor }, leads) => {
      const input = createLeadSchema.parse(payload);
      const created = await leads.create(actor.orgId, actor.userId, input);
      if ("error" in created) throw new BadRequestException(created.error);
      return { result: { leadId: created.id }, summary: `Lead created: ${payload.name}` };
    },
  }),

  defineConfirmableAction({
    action: "crm.logActivity",
    permission: "crm:activities:manage",
    payload: logLeadActivityPayloadSchema,
    resolve: (moduleRef) => moduleRef.get(LeadsDetailService, { strict: false }),
    execute: async (payload, { actor }, details) => {
      const activity = await details.addActivity(actor.orgId, actor.userId, payload.leadIdentifier, {
        type: payload.type,
        date: payload.dueDate ?? new Date().toISOString(),
        notes: payload.notes,
      });
      return {
        result: { activityId: activity?.id },
        summary: `Activity logged on lead #${payload.leadIdentifier}`,
      };
    },
  }),

  defineConfirmableAction({
    action: "crm.updateLeadStatus",
    permission: "crm:leads:update",
    payload: updateLeadStatusPayloadSchema,
    resolve: (moduleRef) => moduleRef.get(LeadsService, { strict: false }),
    execute: async ({ leadId, leadName, status, priority }, { actor, db }, leads) => {
      if (status === undefined && priority === undefined)
        throw new BadRequestException("Provide a status or a priority to update.");
      if (status !== undefined) await assertConfiguredOption(db, actor.orgId, "lead_status", status);
      if (priority !== undefined)
        await assertConfiguredOption(db, actor.orgId, "lead_priority", priority);

      await leads.update(actor.orgId, actor.userId, leadId, {
        ...(status !== undefined && { status }),
        ...(priority !== undefined && { priority }),
      });

      const changed = [
        status !== undefined ? `status ${status}` : null,
        priority !== undefined ? `priority ${priority}` : null,
      ]
        .filter(Boolean)
        .join(" and ");
      return {
        result: { leadId, status, priority },
        summary: `Lead ${leadName ?? `#${leadId}`} updated to ${changed}`,
      };
    },
  }),
] as const;
