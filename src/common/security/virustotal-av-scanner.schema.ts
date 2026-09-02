import { z } from "zod";

const vtStatsSchema = z.object({
  malicious: z.number().optional(),
  suspicious: z.number().optional(),
});

export const vtFileReportSchema = z.object({
  data: z
    .object({
      attributes: z
        .object({
          last_analysis_stats: vtStatsSchema.optional(),
        })
        .optional(),
    })
    .optional(),
});

export const vtUploadResponseSchema = z.object({
  data: z
    .object({
      id: z.string().optional(),
    })
    .optional(),
});

export const vtAnalysisReportSchema = z.object({
  data: z
    .object({
      attributes: z
        .object({
          status: z.string().optional(),
          stats: vtStatsSchema.optional(),
        })
        .optional(),
    })
    .optional(),
});

export type VtStats = z.infer<typeof vtStatsSchema>;
type VtFileReport = z.infer<typeof vtFileReportSchema>;
type VtUploadResponse = z.infer<typeof vtUploadResponseSchema>;
type VtAnalysisReport = z.infer<typeof vtAnalysisReportSchema>;
