import { Controller, Post, Req, Res, UseInterceptors } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import type { Request, Response } from "express";
import type { ServerResponse } from "http";
import { Test } from "@nestjs/testing";
import type { Server } from "http";
import { AiRequestAbortInterceptor } from "./ai-request-abort.interceptor";
import { respondWithAiTextStream } from "./ai-text-stream-route";
import type { PipeableAiTextStream } from "./ai-stream-response";
import { getAiStreamBudget } from "../telemetry/ai-stream-budgets";

const FIRST_BYTE_BUDGET = getAiStreamBudget("ai.stream.first-byte.app");
const SAMPLES = 30;
const CHUNK_INTERVAL_MS = 10;
const CHUNKS = 40;

interface ProviderRecord {
  signalPresent: boolean;
  aborted: boolean;
  settled: boolean;
  released: boolean;
}

const provider: ProviderRecord[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Stands in for `streamText`: it writes its first chunk with no provider delay,
 * so what the client measures is the application's own share of the first
 * visible state, and it stops the moment the signal aborts, so a disconnect that
 * never reaches here shows up as a stream that kept producing.
 */
function fakeProviderStream(signal: AbortSignal, record: ProviderRecord): PipeableAiTextStream {
  return {
    async pipeTextStreamToResponse(res: ServerResponse): Promise<void> {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.write("first ");
      for (let i = 0; i < CHUNKS; i += 1) {
        if (signal.aborted) {
          record.aborted = true;
          record.released = true;
          if (!res.writableEnded) res.end();
          return;
        }
        await sleep(CHUNK_INTERVAL_MS);
        if (!res.writableEnded) res.write(`chunk-${i} `);
      }
      record.settled = true;
      if (!res.writableEnded) res.end();
    },
  };
}

@Controller("stream-probe")
@UseInterceptors(AiRequestAbortInterceptor)
class StreamProbeController {
  @Post("brief")
  async brief(@Req() req: Request, @Res() res: Response): Promise<void> {
    return respondWithAiTextStream(
      req,
      res,
      { feature: "crm.account-summary", orgId: "org_probe", route: "POST /stream-probe/brief" },
      async (signal) => {
        const record: ProviderRecord = {
          signalPresent: true,
          aborted: false,
          settled: false,
          released: false,
        };
        provider.push(record);
        signal.addEventListener("abort", () => {
          record.aborted = true;
        });
        return { stream: fakeProviderStream(signal, record) };
      },
    );
  }
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

async function timeToFirstByte(baseUrl: string): Promise<number> {
  const startedAt = process.hrtime.bigint();
  const response = await fetch(`${baseUrl}/stream-probe/brief`, { method: "POST" });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no readable body");
  await reader.read();
  const elapsed = Number(process.hrtime.bigint() - startedAt) / 1e6;
  await reader.cancel();
  return elapsed;
}

/**
 * A mocked controller spec never builds a socket, so it cannot see either of the
 * two things this proves: that the first byte reaches a real client before the
 * whole answer exists, and that a real hang-up reaches the object that is
 * spending money.
 */
describe("a streamed AI surface over a real socket", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [StreamProbeController],
      providers: [AiRequestAbortInterceptor],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    // A hung-up client leaves a keep-alive socket behind, and `close()` waits for
    // it forever — the suite would pass and then never exit.
    const server: Server = app.getHttpServer();
    server.closeAllConnections();
    await app.close();
  });

  beforeEach(() => {
    provider.length = 0;
  });

  it("streams rather than buffers — the first byte arrives long before the last", async () => {
    const startedAt = process.hrtime.bigint();
    const response = await fetch(`${baseUrl}/stream-probe/brief`, { method: "POST" });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;

    const first = await reader.read();
    const firstByteMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    while (!(await reader.read()).done);
    const completeMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    expect(first.done).toBe(false);
    expect(completeMs).toBeGreaterThan(CHUNK_INTERVAL_MS * CHUNKS * 0.5);
    expect(firstByteMs).toBeLessThan(completeMs / 2);
  });

  it(`first visible streamed state lands inside the ${FIRST_BYTE_BUDGET.budgetMs} ms application budget`, async () => {
    const samples: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) samples.push(await timeToFirstByte(baseUrl));

    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    process.stdout.write(
      `ai.stream.first-byte.app n=${SAMPLES} p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms ` +
        `budget=${FIRST_BYTE_BUDGET.budgetMs}ms threshold=${FIRST_BYTE_BUDGET.thresholdMs}ms\n`,
    );

    expect(samples).toHaveLength(SAMPLES);
    expect(p95).toBeLessThanOrEqual(FIRST_BYTE_BUDGET.budgetMs);
  });

  it("a real client hang-up aborts the provider call, so the spend stops with the response", async () => {
    const controller = new AbortController();
    const pending = fetch(`${baseUrl}/stream-probe/brief`, {
      method: "POST",
      signal: controller.signal,
    }).catch(() => undefined);

    await sleep(60);
    controller.abort();
    await pending;
    await sleep(150);

    expect(provider).toHaveLength(1);
    expect(provider[0]?.aborted).toBe(true);
    expect(provider[0]?.settled).toBe(false);
    expect(provider[0]?.released).toBe(true);
  });

  it("(anti-vacuous) a healthy request never aborts, so the abort assertion is not free", async () => {
    const response = await fetch(`${baseUrl}/stream-probe/brief`, { method: "POST" });
    await response.text();

    expect(provider).toHaveLength(1);
    expect(provider[0]?.aborted).toBe(false);
    expect(provider[0]?.settled).toBe(true);
  });
});
