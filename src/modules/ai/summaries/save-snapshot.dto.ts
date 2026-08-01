import { z } from "zod";
import type { SnapshotPayload } from "./ai-summaries.types";

const citationSchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string().min(1),
  href: z.string().optional(),
  snippet: z.string().optional(),
  freshness: z.string().optional(),
});

export const saveSnapshotSchema = z.object({
  summary: z.string().min(1),
  structured: z.object({
    highlights: z.array(z.string()),
    blockers: z.array(z.string()),
    nextActions: z.array(z.string()),
  }),
  citations: z.array(citationSchema).optional(),
  correlationId: z.string().optional(),
  confidence: z.number().optional(),
});

export const ALLOWED_ENTITY_TYPES = [
  "project",
  "ticket",
  "support_ticket",
  "crm_account",
  "crm_deal",
] as const;

export type AllowedEntityType = (typeof ALLOWED_ENTITY_TYPES)[number];

export function isAllowedEntityType(value: string): value is AllowedEntityType {
  return (ALLOWED_ENTITY_TYPES as readonly string[]).includes(value);
}
