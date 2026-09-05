import { Injectable, Logger, OnModuleInit } from "@nestjs/common";

export type AvScanResult =
  | { status: "clean" }
  | { status: "infected"; threat: string }
  | { status: "error"; reason: string };

export abstract class AvScanner {
  abstract scan(buffer: Buffer, filename: string, mimeType: string): Promise<AvScanResult>;
}

@Injectable()
export class NoopAvScanner extends AvScanner implements OnModuleInit {
  private readonly logger = new Logger(NoopAvScanner.name);

  onModuleInit(): void {
    if (process.env.NODE_ENV === "production") {
      this.logger.warn(
        "MALWARE SCANNING DISABLED — set AV_SCANNER=clamav|virustotal to enable real scanning (uploads are rejected)",
      );
    } else {
      this.logger.log("AV scanner: noop/disabled (development mode — not suitable for production)");
    }
  }

  async scan(_buffer: Buffer, filename: string, _mimeType: string): Promise<AvScanResult> {
    if (process.env.NODE_ENV === "production") {
      this.logger.warn("File uploaded without malware scan — scanning is disabled", { filename });
      return { status: "error", reason: "malware-scanning-disabled" };
    }
    return { status: "clean" };
  }
}

