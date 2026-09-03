import {
  CanActivate,
  Controller,
  ExecutionContext,
  Injectable,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { Server } from "http";
import { ChatOpenAI } from "@langchain/openai";
import { DRIZZLE } from "../../../../../db/drizzle.constants";
import { TenantContextInterceptor } from "../../../../../common/tenant/tenant-context.interceptor";
import { TenantContextService } from "../../../../../common/tenant/tenant-context";
import { primeRelocationTrafficTracker } from "../../../../../common/relocation/relocation-traffic-tracker";
import { AuditService } from "../../../../../common/audit/audit.service";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
import { AiConcurrencyLimiter } from "../../gateway/ai-concurrency-limiter";
import { AiResponseCacheService } from "../../gateway/ai-response-cache.service";
import { LlmService } from "../../providers/llm.service";
import { EmbeddingsService } from "../../providers/embeddings.service";
import { AiUsageService } from "../../services/ai-usage.service";
import type { AiCreditLedger } from "../../gateway/credit-ledger.interface";

jest.mock("@langchain/openai");

const ORG_ID = "org_probe";
const RESERVATION_ID = 77;
const PROVIDER_LATENCY_MS = 400;

const providerCalls: Array<{ signal: AbortSignal | undefined }> = [];
let ledger: jest.Mocked<AiCreditLedger>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Answers only if nobody hung up, exactly as the provider's own fetch does. A
 * call handed no signal at all therefore answers in full — which is the spend
 * this spec exists to detect, and it is invisible to the client that left.
 */
function stubProvider(): void {
  jest.mocked(ChatOpenAI).mockImplementation(() => {
    const client = {
      invoke: (_messages: unknown, options?: { signal?: AbortSignal }) => {
        providerCalls.push({ signal: options?.signal });
        return new Promise((resolve, reject) => {
          const signal = options?.signal;
          const timer = setTimeout(
            () =>
              resolve({
                content: "answer",
                usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
              }),
            PROVIDER_LATENCY_MS,
          );
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("Aborted"));
            },
            { once: true },
          );
        });
      },
      withStructuredOutput: () => client,
    };
    return client as unknown as ChatOpenAI;
  });
}

@Injectable()
class StubTenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest().user = { orgId: ORG_ID, userId: "user_probe" };
    return true;
  }
}

/**
 * Shaped like the metered controllers outside the AI module — authenticated,
 * inside the request tenant transaction, calling the gateway with no signal of
 * its own and never opting into `AiRequestAbortInterceptor`. That is the whole
 * defect: the interceptor is the AI module's own convention and the other
 * nineteen controllers that spend credits never adopted it.
 */
@Controller("metered-probe")
@UseGuards(StubTenantGuard)
class MeteredProbeController {
  constructor(private readonly gateway: AiGatewayService) {}

  @Post("summarise")
  async summarise(): Promise<{ ok: boolean }> {
    const result = await this.gateway.invokeText({
      actor: { orgId: ORG_ID, userId: "user_probe" },
      feature: "mail.summarize",
      prompt: { system: "sys", user: "user" },
      charge: true,
    });
    return { ok: result.ok };
  }
}

function fakeDb() {
  const tx = { execute: async () => [{ placement_fence_held: 1 }] };
  return {
    transaction: async <T>(cb: (t: unknown) => Promise<T>): Promise<T> => cb(tx),
    select: () => ({ from: () => ({ where: async () => [] }) }),
  };
}

jest.setTimeout(30_000);

describe("a metered route outside the AI module still stops the spend when the client leaves", () => {
  let app: INestApplication;
  let baseUrl: string;
  const previousKey = process.env.OPENAI_API_KEY;

  beforeAll(async () => {
    process.env.OPENAI_API_KEY = "test-key";
    primeRelocationTrafficTracker([], Date.now());
    ledger = {
      reserve: jest.fn().mockResolvedValue({ reservationId: RESERVATION_ID }),
      settle: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AiCreditLedger>;

    const moduleRef = await Test.createTestingModule({
      controllers: [MeteredProbeController],
      providers: [
        Reflector,
        TenantContextService,
        StubTenantGuard,
        { provide: DRIZZLE, useValue: fakeDb() },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
        {
          provide: AiGatewayService,
          useFactory: () =>
            new AiGatewayService(
              new LlmService(),
              new EmbeddingsService(),
              { track: jest.fn().mockResolvedValue(undefined) } as unknown as AiUsageService,
              { log: jest.fn() } as unknown as AuditService,
              ledger,
              {
                cachedInvoke: jest.fn(),
                invalidate: jest.fn(),
              } as unknown as AiResponseCacheService,
              new AiConcurrencyLimiter(),
            ),
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    const server: Server = app.getHttpServer();
    server.closeAllConnections();
    await app.close();
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });

  beforeEach(() => {
    providerCalls.length = 0;
    ledger.reserve.mockClear();
    ledger.settle.mockClear();
    ledger.release.mockClear();
    stubProvider();
  });

  it("hands the provider adapter a cancellation signal at all", async () => {
    const response = await fetch(`${baseUrl}/metered-probe/summarise`, { method: "POST" });
    await response.json();

    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]?.signal).toBeDefined();
  });

  it("aborts the in-flight provider call when a real client hangs up", async () => {
    const controller = new AbortController();
    const pending = fetch(`${baseUrl}/metered-probe/summarise`, {
      method: "POST",
      signal: controller.signal,
    }).catch(() => undefined);

    await sleep(80);
    controller.abort();
    await pending;
    await sleep(PROVIDER_LATENCY_MS + 200);

    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]?.signal?.aborted).toBe(true);
  });

  it("releases the reservation and settles nothing for the abandoned call", async () => {
    const controller = new AbortController();
    const pending = fetch(`${baseUrl}/metered-probe/summarise`, {
      method: "POST",
      signal: controller.signal,
    }).catch(() => undefined);

    await sleep(80);
    controller.abort();
    await pending;
    await sleep(PROVIDER_LATENCY_MS + 200);

    expect(ledger.reserve).toHaveBeenCalledTimes(1);
    expect(ledger.settle).not.toHaveBeenCalled();
    expect(ledger.release).toHaveBeenCalledWith(RESERVATION_ID, "cancelled", ORG_ID);
  });

  /**
   * Without this the three above are free: a route that never reached the
   * provider, or one that cancels everything, would satisfy all of them.
   */
  it("(anti-vacuous) a request nobody abandons is not cancelled and settles", async () => {
    const response = await fetch(`${baseUrl}/metered-probe/summarise`, { method: "POST" });
    await response.json();
    await sleep(100);

    expect(providerCalls[0]?.signal?.aborted).toBe(false);
    expect(ledger.settle).toHaveBeenCalledTimes(1);
    expect(ledger.release).not.toHaveBeenCalled();
  });
});
