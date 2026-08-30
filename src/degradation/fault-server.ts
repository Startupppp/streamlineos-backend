import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type FaultMode = "blackhole" | "error" | "slow";

export interface FaultServerConfig {
  mode: FaultMode;
  statusCode?: number;
  body?: string;
  delayMs?: number;
}

export class FaultServer {
  private server: Server;
  private _port = 0;

  mode: FaultMode;
  statusCode: number;
  body: string;
  delayMs: number;

  constructor(config: FaultServerConfig) {
    this.mode = config.mode;
    this.statusCode = config.statusCode ?? 503;
    this.body = config.body ?? "fault server";
    this.delayMs = config.delayMs ?? 5_000;
    this.server = createServer((req, res) => this.handle(req, res));
  }

  get port(): number {
    return this._port;
  }

  get url(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server.address();
        if (addr && typeof addr === "object") this._port = addr.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    req.resume();
    switch (this.mode) {
      case "blackhole":
        break;
      case "error":
        res.writeHead(this.statusCode, { "Content-Type": "text/plain" });
        res.end(this.body);
        break;
      case "slow":
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200);
            res.end("ok");
          }
        }, this.delayMs);
        break;
    }
  }
}

export async function refusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}
