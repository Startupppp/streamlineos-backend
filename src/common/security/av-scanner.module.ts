import { Module } from "@nestjs/common";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import { AvScanner, NoopAvScanner } from "./av-scan";
import { ClamAvScanner } from "./clamd-av-scanner";
import { VirusTotalScanner } from "./virustotal-av-scanner";

const CLAMD_PORT_DEFAULT = 3310;

@Module({
  providers: [
    {
      provide: AvScanner,
      useFactory: (config: AppConfig): AvScanner => {
        if (config.AV_SCANNER === "clamav") {
          const host = config.CLAMAV_HOST ?? "127.0.0.1";
          const port = config.CLAMAV_PORT ?? CLAMD_PORT_DEFAULT;
          return new ClamAvScanner(host, port);
        }
        if (config.AV_SCANNER === "virustotal") {
          const key = config.VIRUSTOTAL_API_KEY;
          if (!key) throw new Error("AV_SCANNER=virustotal requires VIRUSTOTAL_API_KEY");
          return new VirusTotalScanner(key);
        }
        return new NoopAvScanner();
      },
      inject: [APP_CONFIG],
    },
  ],
  exports: [AvScanner],
})
export class AvScannerModule {}
