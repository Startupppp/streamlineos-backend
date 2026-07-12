import { eq, and, isNull } from "drizzle-orm";
import { leads, tasks, crmSlaBreachLog } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import type { SlaResolverService } from "./sla-resolver.service";

interface LeadLike {
  id: number;
  source?: string;
  priority?: string;
  score?: number;
  city?: string;
  state?: string;
}

export async function applySlaPolicyToLead(
  db: Db,
  orgId: string,
  lead: LeadLike,
  slaResolver: SlaResolverService,
): Promise<{ policyId: number; deadline: Date } | null> {
  const policy = await slaResolver.resolve(orgId, {
    source: lead.source,
    priorityKey: lead.priority,
    score: lead.score,
    appliesTo: "lead",
  });

  if (!policy) return null;

  const minutes = policy.targetMinutes ?? policy.firstResponseHours * 60;
  const deadline = new Date(Date.now() + minutes * 60_000);

  await db
    .update(leads)
    .set({ slaDeadline: deadline })
    .where(and(eq(leads.id, lead.id), eq(leads.orgId, orgId)));

  return { policyId: policy.id, deadline };
}

export async function checkAndRecordSlaBreach(
  db: Db,
  orgId: string,
  leadId: number,
  policyId: number | null,
): Promise<{ recorded: boolean }> {
  const existing = await db
    .select({ id: crmSlaBreachLog.id })
    .from(crmSlaBreachLog)
    .where(
      and(
        eq(crmSlaBreachLog.leadId, leadId),
        policyId !== null
          ? eq(crmSlaBreachLog.policyId, policyId)
          : isNull(crmSlaBreachLog.policyId),
      ),
    )
    .limit(1);

  if (existing.length > 0) return { recorded: false };

  await db.insert(crmSlaBreachLog).values({
    orgId,
    leadId,
    policyId: policyId ?? undefined,
    taskCreated: true,
    notified: false,
  });

  const dueDate = new Date(Date.now() + 24 * 60 * 60_000);

  await db.insert(tasks).values({
    orgId,
    title: `SLA breach follow-up for lead #${leadId}`,
    notes: `Lead #${leadId} breached SLA policy${policyId ? ` #${policyId}` : ""}`,
    entityType: "LEAD",
    entityId: leadId,
    type: "CUSTOM",
    status: "pending",
    dueDate,
  });

  return { recorded: true };
}
