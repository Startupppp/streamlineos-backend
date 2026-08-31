import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { createConnection } from "node:net";
import { AvScanner, type AvScanResult } from "./av-scan";

const CONNECT_TIMEOUT_MS = 5_000;
const SCAN_TIMEOUT_MS = 30_000;

@Injectable()
export class ClamAvScanner extends AvScanner implements OnModuleInit {
  private readonly logger = new Logger(ClamAvScanner.name);

  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {
    super();
  }

  onModuleInit(): void {
    this.logger.log(`ClamAV scanner active → ${this.host}:${this.port} (fail-closed on error)`);
  }

  scan(buffer: Buffer, filename: string, _mimeType: string): Promise<AvScanResult> {
    return new Promise<AvScanResult>((resolve) => {
      const socket = createConnection({ host: this.host, port: this.port });
      const chunks: Buffer[] = [];
      let settled = false;

      const settle = (result: AvScanResult): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(result);
      };

      const scanTimer = setTimeout(() => {
        this.logger.warn(`ClamAV scan timed out for "${filename}"`);
        settle({ status: "error", reason: "scan-timeout" });
      }, SCAN_TIMEOUT_MS);

      socket.setTimeout(CONNECT_TIMEOUT_MS);

      socket.on("connect", () => {
        socket.setTimeout(SCAN_TIMEOUT_MS);
        socket.write("nINSTREAM\n");
        const lenBuf = Buffer.allocUnsafe(4);
        lenBuf.writeUInt32BE(buffer.length, 0);
        socket.write(lenBuf);
        socket.write(buffer);
        const terminator = Buffer.allocUnsafe(4);
        terminator.writeUInt32BE(0, 0);
        socket.write(terminator);
      });

      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      socket.on("end", () => {
        clearTimeout(scanTimer);
        const response = Buffer.concat(chunks).toString("utf8").trim();
        if (response.endsWith("OK")) {
          settle({ status: "clean" });
          return;
        }
        const match = /stream:\s+(.+)\s+FOUND$/i.exec(response);
        settle({
          status: "infected",
          threat: match?.[1] ?? response,
        });
      });

      socket.on("error", (err: Error) => {
        clearTimeout(scanTimer);
        this.logger.error(`ClamAV connection error for "${filename}": ${err.message}`);
        settle({ status: "error", reason: `clamd-unreachable: ${err.message}` });
      });

      socket.on("timeout", () => {
        this.logger.warn(`ClamAV socket timeout for "${filename}"`);
        settle({ status: "error", reason: "scan-timeout" });
      });
    });
  }
}
