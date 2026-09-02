import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { createHash } from "node:crypto";
import { AvScanner, type AvScanResult } from "./av-scan";
import {
  vtFileReportSchema,
  vtUploadResponseSchema,
  vtAnalysisReportSchema,
  type VtStats,
} from "./virustotal-av-scanner.schema";

const VT_BASE = "https://www.virustotal.com/api/v3";
const POLL_INTERVAL_MS = 15_000;
const MAX_POLLS = 6;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class VirusTotalScanner extends AvScanner implements OnModuleInit {
  private readonly logger = new Logger(VirusTotalScanner.name);

  constructor(private readonly apiKey: string) {
    super();
  }

  onModuleInit(): void {
    this.logger.log("VirusTotal scanner active (fail-closed on error)");
  }

  async scan(buffer: Buffer, filename: string, mimeType: string): Promise<AvScanResult> {
    try {
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const cached = await this.lookupHash(sha256);
      if (cached !== null) return cached;

      const analysisId = await this.uploadFile(buffer, filename, mimeType);
      if (!analysisId) return { status: "error", reason: "vt-upload-failed" };

      return await this.pollAnalysis(analysisId, filename);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`VirusTotal scan failed: ${message}`, { filename });
      return { status: "error", reason: `vt-api-error: ${message}` };
    }
  }

  private async lookupHash(sha256: string): Promise<AvScanResult | null> {
    const res = await fetch(`${VT_BASE}/files/${sha256}`, {
      headers: { "x-apikey": this.apiKey },
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;

    const parsed = vtFileReportSchema.safeParse(await res.json());
    if (!parsed.success) {
      this.logger.error(`Malformed VirusTotal file-report response: ${parsed.error.message}`);
      return { status: "error", reason: "vt-malformed-file-report" };
    }
    return this.parseStats(parsed.data.data?.attributes?.last_analysis_stats ?? null);
  }

  private async uploadFile(buffer: Buffer, filename: string, mimeType: string): Promise<string | null> {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
    form.append("file", blob, filename);
    const res = await fetch(`${VT_BASE}/files`, {
      method: "POST",
      headers: { "x-apikey": this.apiKey },
      body: form,
    });
    if (!res.ok) return null;

    const parsed = vtUploadResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      this.logger.error(`Malformed VirusTotal upload response: ${parsed.error.message}`);
      return null;
    }
    return parsed.data.data?.id ?? null;
  }

  private async pollAnalysis(analysisId: string, filename: string): Promise<AvScanResult> {
    for (let i = 0; i < MAX_POLLS; i++) {
      await sleep(POLL_INTERVAL_MS);
      const res = await fetch(`${VT_BASE}/analyses/${analysisId}`, {
        headers: { "x-apikey": this.apiKey },
      });
      if (!res.ok) continue;

      const parsed = vtAnalysisReportSchema.safeParse(await res.json());
      if (!parsed.success) {
        this.logger.error(`Malformed VirusTotal analysis response: ${parsed.error.message}`);
        return { status: "error", reason: "vt-malformed-analysis-report" };
      }
      if (parsed.data.data?.attributes?.status !== "completed") continue;
      return this.parseStats(parsed.data.data.attributes.stats ?? null);
    }
    this.logger.warn("VirusTotal analysis timed out", { filename });
    return { status: "error", reason: "vt-analysis-timeout" };
  }

  private parseStats(stats: VtStats | null): AvScanResult {
    if (!stats) return { status: "error", reason: "vt-no-stats" };
    if ((stats.malicious ?? 0) > 0 || (stats.suspicious ?? 0) > 0)
      return {
        status: "infected",
        threat: `${stats.malicious ?? 0} malicious, ${stats.suspicious ?? 0} suspicious`,
      };
    return { status: "clean" };
  }
}
