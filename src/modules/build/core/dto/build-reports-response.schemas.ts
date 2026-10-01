import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const projectBudgetSchema = z.object({
  projectId: z.number().int(),
  plannedBudget: z.number(),
  actualCost: z.number(),
  remaining: z.number(),
  utilizationPct: z.number().int(),
  currency: z.string().nullable(),
  totalHours: z.number(),
  unratedHours: z.number(),
  currencyMismatch: z.boolean(),
  excludedCurrencyHours: z.number(),
  memberBreakdown: z.array(z.object({
    userId: z.string(),
    hours: z.number(),
    cost: z.number(),
    unratedHours: z.number(),
  })),
});

export const projectBudgetUpdateSchema = z.object({
  id: z.number().int(),
  budget: z.number(),
  currency: z.string().nullable(),
});

export const customerListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  domain: z.string().nullable(),
  industry: z.string().nullable(),
  size: z.string().nullable(),
  website: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  description: z.string().nullable(),
  createdAt: wireDate(),
});

export const customerPageSchema = cursorPageSchema(customerListItemSchema);

export const analyticsSchema = z.object({
  stateDistribution: z.unknown(),
  priorityBreakdown: z.unknown(),
  assigneeCompletion: z.unknown(),
  volumeOverTime: z.unknown(),
  cycleVelocity: z.unknown(),
  estimateVsActual: z.unknown(),
  healthScore: z.number().int(),
  healthStatus: z.string(),
  healthBreakdown: z.object({
    completionPct: z.number().int(),
    onTimePct: z.number().int(),
    velocityScore: z.number().int(),
    overdueTickets: z.number().int(),
    totalTickets: z.number().int(),
    openTickets: z.number().int(),
  }),
});

export const burnupDataSchema = z.array(z.object({
  date: z.string(),
  scope: z.number(),
  completed: z.number(),
})).max(366);

export const cfdDataSchema = z.object({
  dates: z.array(z.string()),
  groups: z.array(z.string()),
  series: z.array(z.object({
    date: z.string(), backlog: z.number(), unstarted: z.number(),
    started: z.number(), completed: z.number(), cancelled: z.number(),
  })),
});

export const criticalPathSchema = z.object({
  criticalPath: z.array(z.object({
    ticketId: z.number().int(),
    title: z.string(),
    estimate: z.number(),
    earliestStart: z.number(),
    earliestFinish: z.number(),
  })),
  totalDuration: z.number(),
  nodeCount: z.number().int(),
  edgeCount: z.number().int(),
  hasCycle: z.boolean(),
});

export const velocitySchema = z.array(z.object({
  cycleId: z.number().int(),
  name: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  committedPoints: z.number().int(),
  completedPoints: z.number().int(),
  committedCount: z.number().int(),
  completedCount: z.number().int(),
})).max(100);

export const cycleTimeSchema = z.array(z.object({
  week: z.string(), avgDays: z.number(), count: z.number().int(),
}));

export const leadTimeSchema = z.array(z.object({
  week: z.string(), avgDays: z.number(), p50Days: z.number(),
  p90Days: z.number(), count: z.number().int(),
}));

export const snapshotResultSchema = z.object({
  captured: z.number().int(),
});
