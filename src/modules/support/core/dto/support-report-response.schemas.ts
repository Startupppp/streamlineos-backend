import { z } from "zod";

export const supportOverviewSchema = z.object({
  newTickets: z.number().int(),
  openTickets: z.number().int(),
  backlog: z.number().int(),
  avgFirstResponseMinutes: z.number().int().nullable(),
  avgResolutionMinutes: z.number().int().nullable(),
  slaBreachCount: z.number().int(),
  slaCompliancePct: z.number().nullable(),
  reopenRate: z.number(),
  ticketsByChannel: z.array(z.object({ channel: z.string(), count: z.number().int() })),
  ticketsByPriority: z.array(z.object({ priority: z.string(), count: z.number().int() })),
  ticketsByCategory: z.array(z.object({ category: z.string(), count: z.number().int() })),
});

export const agentPerformanceListSchema = z.array(
  z.object({
    agentId: z.string().nullable(),
    ticketsHandled: z.number().int(),
    ticketsResolved: z.number().int(),
    avgFirstResponseMinutes: z.number().nullable(),
    avgResolutionMinutes: z.number().nullable(),
  }),
);

export const queuePerformanceListSchema = z.array(
  z.object({
    queueId: z.number().int().nullable(),
    queueName: z.string(),
    ticketsHandled: z.number().int(),
    openTickets: z.number().int(),
    avgResolutionMinutes: z.number().nullable(),
  }),
);

export const channelPerformanceListSchema = z.array(
  z.object({
    channel: z.string(),
    ticketsHandled: z.number().int(),
    avgFirstResponseMinutes: z.number().nullable(),
    avgResolutionMinutes: z.number().nullable(),
  }),
);

export const automationPerformanceListSchema = z.array(
  z.object({
    ruleId: z.number().int().nullable(),
    ruleName: z.string(),
    total: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
  }),
);
