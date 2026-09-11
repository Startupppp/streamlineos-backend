import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { createHash } from "node:crypto";
import { AvScanner, type AvScanResult } from "./av-scan";
import { vtFileReportSchema, type VtStats } from "./virustotal-av-scanner.schema";

const VT_BASE = "https://www.virustotal.com/api/v3";

/**
 * Node's `fetch` has no default request timeout, so a VirusTotal endpoint that
 * accepts the connection and then stops writing holds this call — and the upload
 * request that is waiting on it — for as long as the socket stays open. The one
 * request here goes through `vtFetch`, which takes the deadline as a required
 * argument, so a second endpoint added later cannot omit one by writing a bare
 * `fetch`.
 */
const VT_REPORT_TIMEOUT_MS = 10_000;

@Injectable()
export class VirusTotalScanner extends AvScanner implements OnModuleInit {
  private readonly logger = new Logger(VirusTotalScanner.name);

  constructor(private readonly apiKey: string) {
    super();
  }

  private vtFetch(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: { "x-apikey": this.apiKey, ...init?.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  onModuleInit(): void {
    this.logger.log("VirusTotal scanner active (fail-closed on error)");
  }

  /**
   * Hash lookup only. Submitting the bytes was the previous behaviour and it
   * shipped every first-seen tenant document — payslips, signed contracts,
   * candidate identity documents — to a third party that publishes what it is
   * sent, which is the opposite of the tenant-private guarantee this scanner
   * exists to defend. A hash carries no content, so the lookup is safe; a hash
   * VirusTotal has never seen returns `error`, and every caller treats `error`
   * as a refusal, so the unknown file is rejected rather than exported.
   */
  async scan(buffer: Buffer, filename: string, _mimeType: string): Promise<AvScanResult> {
    try {
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const cached = await this.lookupHash(sha256);
      if (cached !== null) return cached;

      this.logger.warn("VirusTotal has no report for this file; refusing rather than submitting its bytes", { filename });
      return { status: "error", reason: "vt-unknown-hash" };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`VirusTotal scan failed: ${message}`, { filename });
      return { status: "error", reason: `vt-api-error: ${message}` };
    }
  }

  private async lookupHash(sha256: string): Promise<AvScanResult | null> {
    const res = await this.vtFetch(`${VT_BASE}/files/${sha256}`, VT_REPORT_TIMEOUT_MS);
    if (res.status === 404) return null;
    if (!res.ok) return null;

    const parsed = vtFileReportSchema.safeParse(await res.json());
    if (!parsed.success) {
      this.logger.error(`Malformed VirusTotal file-report response: ${parsed.error.message}`);
      return { status: "error", reason: "vt-malformed-file-report" };
    }
    return this.parseStats(parsed.data.data?.attributes?.last_analysis_stats ?? null);
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
