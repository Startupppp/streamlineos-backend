import { z } from "zod";

/**
 * D1. The caps are the feature.
 *
 * A genealogy walk fans out through documents: a lot received on a GRN reaches
 * every other lot on that GRN, each of which reaches every shipment it left on,
 * and so on. Two or three hops into a busy tenant that is the whole ledger, and
 * an uncapped walk is a denial of service a customer can trigger from a URL.
 *
 * `nodes` is capped at 100 to match the hard page cap every list endpoint
 * carries (backend §3) — a graph is not a list, but the reason for the number
 * is the same and a second number would only invite a third.
 */
export const GENEALOGY_CAPS = {
  /** Edges followed from the anchor. One item->document step is one hop. */
  maxDepth: { default: 4, max: 8 },
  /** Total nodes, anchor included, that may appear in one answer. */
  maxNodes: { default: 100, max: 100 },
  /** Edges expanded out of any single node, enforced by a per-node SQL LIMIT. */
  maxFanout: { default: 25, max: 50 },
} as const;

export const genealogyQuerySchema = z
  .object({
    lotId: z.coerce.number().int().positive().optional(),
    serialId: z.coerce.number().int().positive().optional(),
    /**
     * `backward` answers "where did this come from", `forward` answers "where
     * did it go". A recall wants both, which is the default.
     */
    direction: z.enum(["forward", "backward", "both"]).default("both"),
    maxDepth: z.coerce
      .number()
      .int()
      .min(1)
      .max(GENEALOGY_CAPS.maxDepth.max)
      .default(GENEALOGY_CAPS.maxDepth.default),
    maxNodes: z.coerce
      .number()
      .int()
      .min(1)
      .max(GENEALOGY_CAPS.maxNodes.max)
      .default(GENEALOGY_CAPS.maxNodes.default),
    maxFanout: z.coerce
      .number()
      .int()
      .min(1)
      .max(GENEALOGY_CAPS.maxFanout.max)
      .default(GENEALOGY_CAPS.maxFanout.default),
    /**
     * A2 corrections. A movement that has been reversed, and the reversal that
     * reversed it, describe goods that never moved — included by default they
     * show a recalled lot as having shipped. Off unless explicitly asked for,
     * and the count of what was suppressed is always reported.
     */
    includeReversed: z
      .union([z.literal("true"), z.literal("false")])
      .optional()
      .transform((v) => v === "true"),
  })
  .strict()
  .refine((d) => d.lotId != null || d.serialId != null, {
    message: "lotId or serialId is required",
  })
  .refine((d) => !(d.lotId != null && d.serialId != null), {
    message: "Pass lotId or serialId, not both",
  });
export type GenealogyQueryInput = z.infer<typeof genealogyQuerySchema>;
