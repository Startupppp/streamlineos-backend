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
  }),
});

export const resourceAllocationItemSchema = z.object({
  userId: z.string().optional(),
  name: z.string().optional(),
  projectId: z.number().int().optional(),
  projectName: z.string().optional(),
  assignedTickets: z.number().int().optional(),
}).passthrough();

export const burnupDataSchema = z.object({
  dates: z.array(z.string()),
  completed: z.array(z.number().int()),
  added: z.array(z.number().int()),
  total: z.array(z.number().int()).optional(),
  scope: z.array(z.number().int()).optional(),
}).passthrough();

export const cfdDataSchema = z.object({
  dates: z.array(z.string()),
  statuses: z.array(z.string()),
  data: z.array(z.array(z.number().int())),
}).passthrough();

export const criticalPathSchema = z.object({
  tasks: z.array(z.object({
    id: z.number().int(),
    title: z.string(),
    duration: z.number().int(),
    earlyStart: z.number().int(),
    earlyFinish: z.number().int(),
    lateStart: z.number().int(),
    lateFinish: z.number().int(),
    slack: z.number().int(),
    isCritical: z.boolean(),
  })).optional(),
  criticalPath: z.array(z.number().int()).optional(),
}).passthrough();

export const velocitySchema = z.object({
  sprints: z.array(z.object({
    sprintId: z.number().int(),
    sprintName: z.string(),
    committed: z.number().int(),
    completed: z.number().int(),
  })).optional(),
  avgVelocity: z.number().optional(),
}).passthrough();

export const cycleTimeSchema = z.object({
  statuses: z.array(z.string()).optional(),
  avgDays: z.array(z.number()).optional(),
  medianDays: z.array(z.number()).optional(),
}).passthrough();

export const leadTimeSchema = z.object({
  avgLeadDays: z.number().optional(),
  medianLeadDays: z.number().optional(),
  tickets: z.array(z.object({
    id: z.number().int(),
    leadDays: z.number(),
  })).optional(),
}).passthrough();

export const snapshotResultSchema = z.object({
  captured: z.number().int(),
});
