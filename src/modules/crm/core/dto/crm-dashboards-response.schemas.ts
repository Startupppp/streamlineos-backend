import { z } from "zod";
import { statWithTrendSchema } from "./crm-stat-shapes.schemas";

export const salesDashboardSchema = z.object({
  salesStats: z.object({
    pipeline: statWithTrendSchema,
    dealsWon: statWithTrendSchema,
    conversionRate: statWithTrendSchema,
    avgDealSize: statWithTrendSchema,
  }),
  revenueTimeline: z.array(z.object({ month: z.string(), value: z.number() })),
  salesFunnel: z.array(
    z.object({ stage: z.string(), value: z.number(), color: z.string() }),
  ),
  topDeals: z.array(
    z.object({
      company: z.string(),
      value: z.number(),
      stage: z.string(),
      rep: z.string(),
      probability: z.number(),
    }),
  ),
  salesLeaderboard: z.array(
    z.object({
      name: z.string(),
      deals: z.number().int(),
      revenue: z.number(),
      avatar: z.string(),
    }),
  ),
  salesActivity: z.array(
    z.object({
      type: z.string(),
      message: z.string(),
      time: z.string(),
      person: z.string(),
    }),
  ),
  dealsByStage: z.array(
    z.object({
      stage: z.string(),
      count: z.number().int(),
      value: z.number(),
      color: z.string(),
    }),
  ),
  enhancedMetrics: z.object({
    activeClients: z.number().int(),
    inactiveClients: z.number().int(),
    totalCalls: z.number().int(),
    totalMeetings: z.number().int(),
    totalEmails: z.number().int(),
    totalSiteVisits: z.number().int(),
    followUpNeeded: z.number().int(),
  }),
});

export const supportDashboardSchema = z.object({
  supportDashboardStats: z.object({
    openTickets: statWithTrendSchema,
    avgResolution: statWithTrendSchema,
    csatScore: statWithTrendSchema,
    responseRate: statWithTrendSchema,
  }),
  ticketStatusBreakdown: z.array(
    z.object({ label: z.string(), value: z.number().int(), color: z.string() }),
  ),
  ticketVolumeTimeline: z.array(
    z.object({ month: z.string(), value: z.number() }),
  ),
  supportActivityFeed: z.array(
    z.object({ type: z.string(), message: z.string(), time: z.string(), person: z.string() }),
  ),
  supportTeamMembers: z.array(
    z.object({
      name: z.string(),
      role: z.string(),
      access: z.string(),
      avatar: z.string(),
      status: z.literal("online"),
    }),
  ),
  ticketsByPriority: z.array(
    z.object({ label: z.string(), value: z.number().int(), color: z.string() }),
  ),
});

export const ceDashboardSchema = z.object({
  customerStats: z.object({
    totalClients: statWithTrendSchema,
    nps: statWithTrendSchema,
    csat: statWithTrendSchema,
    retention: statWithTrendSchema,
  }),
  clientHealth: z.array(
    z.object({ label: z.string(), value: z.number().int(), color: z.string() }),
  ),
  upcomingRenewals: z.array(
    z.object({
      client: z.string(),
      value: z.number(),
      date: z.string(),
      health: z.enum(["healthy", "at_risk", "critical"]),
    }),
  ),
  keyAccounts: z.array(
    z.object({
      name: z.string(),
      revenue: z.number(),
      health: z.string(),
      csm: z.string(),
      since: z.string(),
    }),
  ),
  customerInteractions: z.array(
    z.object({ type: z.string(), message: z.string(), time: z.string(), person: z.string() }),
  ),
  supportStats: z.object({
    openTickets: z.number().int(),
    avgResolution: z.number(),
    firstResponse: z.number(),
    satisfaction: z.number(),
  }),
  retentionTimeline: z.array(z.object({ month: z.string(), value: z.number() })),
  csatTimeline: z.array(z.object({ month: z.string(), value: z.number() })),
});
