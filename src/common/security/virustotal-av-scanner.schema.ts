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
export type VtFileReport = z.infer<typeof vtFileReportSchema>;
export type VtUploadResponse = z.infer<typeof vtUploadResponseSchema>;
export type VtAnalysisReport = z.infer<typeof vtAnalysisReportSchema>;
