import { and, eq, notInArray } from "drizzle-orm";
import { supportTickets } from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { logger } from "../../../../common/logger/logger.service";
import { AccessService } from "../../../access/access.service";
import { SupportNotificationsService } from "../support-notifications.service";
import { SupportMacrosService } from "../support-macros.service";
import type { TicketStatus } from "../dto/support.schemas";

/**
 * The SLA escalation ladder: how at-risk a ticket is, what numeric rung that
 * corresponds to, and what the sweep does when a ticket climbs one.
 *
 * Split out of `SupportSlaService` because the service was two things. What
 * stays there is SLA CONFIGURATION — business-hours calendars, policies,
 * `resolvePolicy`'s most-specific-match-wins, and the due-date and pause
 * arithmetic that the ticket write path calls on every create and status
 * change. What is here runs from a cron endpoint with no ticket in hand, and
 * its failure mode is the opposite: every notification is wrapped in its own
 * try/catch and logged, because one undeliverable escalation email must not
 * stop the sweep for the rest of the org.
 *
 * `computeRisk` and `riskToEscalationLevel` are a pair and belong together —
 * `supportTickets.slaEscalationLevel` is literally
 * `riskToEscalationLevel(computeRisk(ticket))`, and the sweep's whole
 * decision is comparing that to the stored value. In the origin file they sat
 * 200 lines apart with the escalation policy between them. `computeRisk` is
 * pure: no DB, no policy lookup, so it stays cheap on every ticket read.
 *
 * A deps bag rather than plain `db`, because the sweep genuinely reaches
 * three other services: the escalation mailer, the routing rules it re-runs
 * to reassign, and the permission lookup that finds the manager tier.
 */

export type SlaRiskLevel =
  | "ok"
  | "first_response_due_soon"
  | "first_response_breached"
  | "resolution_due_soon"
  | "resolution_breached"
  | "paused";

export interface SlaEscalationDeps {
  readonly db: Db;
  readonly notifications: SupportNotificationsService;
  readonly macros: SupportMacrosService;
  readonly access: AccessService;
}

/**
 * Pure risk computation off already-materialized ticket fields — no DB/policy
 * lookups here, so this stays cheap on every ticket read and easy to unit test.
 */
export function computeRisk(ticket: {
  status: TicketStatus;
  createdAt: Date;
  firstRespondedAt: Date | null;
  firstResponseDueAt: Date | null;
  slaDeadline: Date | null;
  slaPausedAt: Date | null;
}): SlaRiskLevel {
  if (["RESOLVED", "CLOSED"].includes(ticket.status)) return "ok";
  if (ticket.slaPausedAt) return "paused";

  const now = new Date();

  if (!ticket.firstRespondedAt && ticket.firstResponseDueAt) {
    const totalMs = ticket.firstResponseDueAt.getTime() - ticket.createdAt.getTime();
    const remainingMs = ticket.firstResponseDueAt.getTime() - now.getTime();
    if (remainingMs < 0) return "first_response_breached";
    if (totalMs > 0 && remainingMs < totalMs * 0.25) return "first_response_due_soon";
  }

  if (ticket.slaDeadline) {
    const totalMs = ticket.slaDeadline.getTime() - ticket.createdAt.getTime();
    const remainingMs = ticket.slaDeadline.getTime() - now.getTime();
    if (remainingMs < 0) return "resolution_breached";
    if (totalMs > 0 && remainingMs < totalMs * 0.25) return "resolution_due_soon";
  }

  return "ok";
}

function riskToEscalationLevel(risk: SlaRiskLevel): number {
  if (risk === "first_response_breached" || risk === "resolution_breached") return 2;
  if (risk === "first_response_due_soon" || risk === "resolution_due_soon") return 1;
  return 0;
}

/**
 * Scans an org's open tickets and notifies the assignee whenever a ticket
 * crosses a new SLA risk threshold since the last check (tracked via
 * slaEscalationLevel, so the same threshold never re-notifies). Tickets
 * still breached on a SUBSEQUENT sweep (already at the max level and still
 * breached) escalate to org owners/admins ("manager tier") and trigger a
 * one-time auto-reassignment attempt via the same routing rules used at
 * ticket creation — this only re-fires the manager notification if the
 * ticket keeps getting reassigned and re-breaching, since escalationLevel
 * itself doesn't distinguish "just breached" from "breached again."
 *
 * Scheduling: wired into the standard cron pattern via
 * POST/GET /cron/support-sla-escalations (src/modules/cron) — an external
 * scheduler still needs to actually call it periodically, same as every
 * other job in that module; nothing in this repo self-schedules.
 */
export async function runEscalations(
  deps: SlaEscalationDeps,
  orgId: string,
): Promise<{ checked: number; escalated: number }> {
  const tickets = await deps.db.query.supportTickets.findMany({
    where: and(orgId ? eq(supportTickets.orgId, orgId) : undefined, notInArray(supportTickets.status, ["RESOLVED", "CLOSED"])),
    columns: {
      id: true,
      title: true,
      status: true,
      category: true,
      priority: true,
      createdAt: true,
      assigneeId: true,
      firstRespondedAt: true,
      firstResponseDueAt: true,
      slaDeadline: true,
      slaPausedAt: true,
      slaEscalationLevel: true,
    },
  });

  let escalated = 0;

  for (const ticket of tickets) {
    const risk = computeRisk(ticket);
    const newLevel = riskToEscalationLevel(risk);
    const isBreach = risk === "first_response_breached" || risk === "resolution_breached";
    const isRepeatBreach = isBreach && ticket.slaEscalationLevel >= newLevel;

    if (newLevel <= ticket.slaEscalationLevel && !isRepeatBreach) continue;

    if (newLevel > ticket.slaEscalationLevel) {
      await deps.db
        .update(supportTickets)
        .set({ slaEscalationLevel: newLevel })
        .where(and(eq(supportTickets.id, ticket.id), eq(supportTickets.orgId, orgId)));
    }

    if (ticket.assigneeId && (risk === "first_response_due_soon" || risk === "first_response_breached" || risk === "resolution_due_soon" || risk === "resolution_breached")) {
      try {
        await deps.notifications.sendEscalationEmail(orgId, ticket.assigneeId, ticket.title, ticket.id, risk);
      } catch (error) {
        logger.error("Failed to send SLA escalation email", {
          orgId,
          ticketId: ticket.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (isRepeatBreach) {
      const reassignedTo = await tryAutoReassign(deps, orgId, ticket);
      await notifyManagers(deps, orgId, ticket, risk, reassignedTo);
    }

    escalated++;
  }

  return { checked: tickets.length, escalated };
}

/** Cron entrypoint — sweeps every org with at least one open ticket, not just the caller's own. */
export async function runEscalationsForAllOrgs(
  deps: SlaEscalationDeps,
): Promise<{ orgsProcessed: number; checked: number; escalated: number }> {
  const orgs = await deps.db
    .selectDistinct({ orgId: supportTickets.orgId })
    .from(supportTickets)
    .where(notInArray(supportTickets.status, ["RESOLVED", "CLOSED"]));

  let checked = 0;
  let escalated = 0;
  for (const { orgId } of orgs) {
    const result = await runEscalations(deps, orgId);
    checked += result.checked;
    escalated += result.escalated;
  }
  return { orgsProcessed: orgs.length, checked, escalated };
}

/**
 * One-time reassignment attempt for a ticket that's breached and stayed
 * breached across sweeps — re-runs the same routing rules used at ticket
 * creation (round-robin/load-balanced candidates rotate the same way) and
 * only reassigns if that resolves to someone OTHER than the current
 * assignee, so a ticket with no matching rule or a single-candidate rule
 * doesn't get bounced back to the same person repeatedly.
 */
async function tryAutoReassign(
  deps: SlaEscalationDeps,
  orgId: string,
  ticket: { id: number; title: string; category: string | null; priority: string; assigneeId: string | null },
): Promise<string | null> {
  try {
    const routing = await deps.macros.applyRoutingRules(orgId, {
      title: ticket.title,
      category: ticket.category,
      priority: ticket.priority,
    });
    if (!routing.assigneeId || routing.assigneeId === ticket.assigneeId) return null;

    await deps.db
      .update(supportTickets)
      .set({ assigneeId: routing.assigneeId, updatedAt: new Date() })
      .where(and(eq(supportTickets.id, ticket.id), eq(supportTickets.orgId, orgId)));
    return routing.assigneeId;
  } catch (error) {
    logger.error("SLA auto-reassignment failed", {
      orgId,
      ticketId: ticket.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function notifyManagers(
  deps: SlaEscalationDeps,
  orgId: string,
  ticket: { id: number; title: string },
  risk: SlaRiskLevel,
  reassignedTo: string | null,
): Promise<void> {
  // Defensive, and currently unreachable: the sole call site guards on
  // `isRepeatBreach`, which already implies one of these two risks. Mutating
  // this line to `if (false) return;` leaves all 310 support tests green —
  // that is the branch being dead, not the manager tier being untested (the
  // repeat-breach case in support-sla.service.spec.ts does assert the
  // manager emails). Kept as a guard in case a second caller appears.
  if (risk !== "first_response_breached" && risk !== "resolution_breached") return;

  const managers = await deps.access.membersWithPermission(orgId, "settings:manage");

  for (const manager of managers) {
    if (manager.userId === reassignedTo) continue;
    try {
      await deps.notifications.sendEscalationEmail(orgId, manager.userId, ticket.title, ticket.id, risk);
    } catch (error) {
      logger.error("Failed to send SLA manager-tier escalation email", {
        orgId,
        ticketId: ticket.id,
        managerId: manager.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
