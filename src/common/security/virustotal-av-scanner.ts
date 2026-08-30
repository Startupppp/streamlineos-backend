import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { createHash } from "node:crypto";
import { AvScanner, type AvScanResult } from "./av-scan";

const VT_BASE = "https://www.virustotal.com/api/v3";
const POLL_INTERVAL_MS = 15_000;
const MAX_POLLS = 6;

interface VtStats {
  malicious?: number;
  suspicious?: number;
}

interface VtFileReport {
  data?: { attributes?: { last_analysis_stats?: VtStats } };
}

interface VtUploadResponse {
  data?: { id?: string };
}

interface VtAnalysisReport {
  data?: { attributes?: { status?: string; stats?: VtStats } };
}

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
      this.logger.error(`VirusTotal scan failed for "${filename}": ${message}`);
      return { status: "error", reason: `vt-api-error: ${message}` };
    }
  }

  private async lookupHash(sha256: string): Promise<AvScanResult | null> {
    const res = await fetch(`${VT_BASE}/files/${sha256}`, {
      headers: { "x-apikey": this.apiKey },
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const body = (await res.json()) as VtFileReport;
    return this.parseStats(body.data?.attributes?.last_analysis_stats ?? null);
  }

  private async uploadFile(buffer: Buffer, filename: string, mimeType: string): Promise<string | null> {
    const form = new FormData();
    const blob = new Blob([buffer], { type: mimeType });
    form.append("file", blob, filename);
    const res = await fetch(`${VT_BASE}/files`, {
      method: "POST",
      headers: { "x-apikey": this.apiKey },
      body: form,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as VtUploadResponse;
    return body.data?.id ?? null;
  }

  private async pollAnalysis(analysisId: string, filename: string): Promise<AvScanResult> {
    for (let i = 0; i < MAX_POLLS; i++) {
      await sleep(POLL_INTERVAL_MS);
      const res = await fetch(`${VT_BASE}/analyses/${analysisId}`, {
        headers: { "x-apikey": this.apiKey },
      });
      if (!res.ok) continue;
      const body = (await res.json()) as VtAnalysisReport;
      if (body.data?.attributes?.status !== "completed") continue;
      return this.parseStats(body.data.attributes.stats ?? null);
    }
    this.logger.warn(`VirusTotal analysis timed out for "${filename}"`);
    return { status: "error", reason: "vt-analysis-timeout" };
  }

  private parseStats(stats: VtStats | null): AvScanResult {
    if (!stats) return { status: "error", reason: "vt-no-stats" };
    if ((stats.malicious ?? 0) > 0 || (stats.suspicious ?? 0) > 0)
      return { status: "infected", threat: `${stats.malicious ?? 0} malicious, ${stats.suspicious ?? 0} suspicious` };
    return { status: "clean" };
  }
}
