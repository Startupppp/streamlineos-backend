import { z } from "zod";
import { personStatSchema } from "./crm-stat-shapes.schemas";

export const crmPersonDetailSchema = z.object({
  slug: z.string(),
  name: z.string(),
  initials: z.string(),
  role: z.string(),
  title: z.string().nullable(),
  department: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string(),
  location: z.string(),
  joinDate: z.string(),
  bio: z.string(),
  stats: z.array(personStatSchema),
  monthlyPerformance: z.array(z.object({ month: z.string(), value: z.number() })),
  deals: z.array(
    z.object({
      company: z.string().nullable(),
      value: z.number(),
      stage: z.string(),
      probability: z.number(),
      closeDate: z.string(),
    }),
  ),
  accounts: z.array(
    z.object({
      name: z.string(),
      revenue: z.number(),
      health: z.enum(["healthy", "at_risk", "critical"]),
      since: z.string(),
      renewalDate: z.string(),
    }),
  ),
  activities: z.array(
    z.object({
      type: z.string(),
      message: z.string(),
      time: z.string(),
    }),
  ),
  skills: z.array(z.string()),
});

export const crmPeopleSlugsSchema = z.record(z.string(), z.string());
