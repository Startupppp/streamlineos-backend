import { sql } from "drizzle-orm";
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
import type { Db } from "../../../db/drizzle.module";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { NO_TENANT_TRANSACTION } from "../../../common/tenant/no-tenant-transaction.decorator";
import { TenantContextInterceptor } from "../../../common/tenant/tenant-context.interceptor";
import { TenantContextService } from "../../../common/tenant/tenant-context";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { primeRelocationTrafficTracker } from "../../../common/relocation/relocation-traffic-tracker";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { getAiRequestAbortSignal } from "../../ai/core/streaming/ai-request-abort";
import { KbArticleAiController } from "../help-centre/kb-article-ai.controller";
import { KbArticleAiService } from "../help-centre/kb-article-ai.service";
import { KbPageAiController } from "../wiki/kb-page-ai.controller";
import { KbPageAiService } from "../wiki/kb-page-ai.service";
import type { KbDocAiAction } from "../retrieval/dto/kb-ai.schemas";

const ORG_ID = "org-owner";
const OTHER_ORG = "org-attacker";
const DOC_ID = 7;
const ACTIONS: KbDocAiAction[] = ["summarize", "ask", "improve", "suggest-related"];

const DOC_ROW = {
  id: DOC_ID,
  orgId: ORG_ID,
  spaceId: 1,
  title: "Onboarding",
  contentText: "the body",
};

function user(orgId: string) {
  return { orgId, userId: "user-1", isOrgOwner: false } as never;
}

function trackingDb(row: unknown) {
  const state = { open: 0, opened: 0 };
  const findFirst = jest.fn().mockImplementation(async () => row);
  const emptyJoinChain: Record<string, unknown> = { where: jest.fn().mockResolvedValue([]) };
  emptyJoinChain.innerJoin = jest.fn().mockReturnValue(emptyJoinChain);
  emptyJoinChain.leftJoin = jest.fn().mockReturnValue(emptyJoinChain);

  const surface = {
    query: { kbPages: { findFirst } },
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockReturnValue(emptyJoinChain),
    })),
    execute: jest.fn().mockResolvedValue([{ placement_fence_held: 1 }]),
  };

  const db = {
    ...surface,
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => {
      state.opened += 1;
      state.open += 1;
      try {
        return await cb(surface);
      } finally {
        state.open -= 1;
      }
    },
  };

  return { db: db as unknown as Db, state, findFirst };
}

interface ProviderProbe {
  invokeTextWithUsage: jest.Mock;
  streamTextWithUsage: jest.Mock;
  openWhenProviderCalled: number[];
}

function providerProbe(state: { open: number }): ProviderProbe {
  const probe: ProviderProbe = {
    openWhenProviderCalled: [],
    invokeTextWithUsage: jest.fn(),
    streamTextWithUsage: jest.fn(),
  };
  probe.invokeTextWithUsage.mockImplementation(async () => {
    probe.openWhenProviderCalled.push(state.open);
    return { ok: true, data: "answer", aiUsage: undefined };
  });
  probe.streamTextWithUsage.mockImplementation(async () => {
    probe.openWhenProviderCalled.push(state.open);
    return { stream: { pipeTextStreamToResponse: jest.fn() } };
  });
  return probe;
}

interface Surface {
  name: string;
  build(db: Db, gateway: ProviderProbe): KbArticleAiService | KbPageAiService;
}

const kbPageAiAuth = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  assertPageAccess: jest.fn().mockResolvedValue({ orgId: ORG_ID, pageId: DOC_ID, action: "view", via: "admin" }),
};

const SURFACES: Surface[] = [
  {
    name: "KbArticleAiService",
    build: (db, gateway) =>
      new KbArticleAiService(
        db,
        { assertCanViewArticle: jest.fn().mockResolvedValue(undefined) } as never,
        gateway as never,
        { log: jest.fn() } as never,
      ),
  },
  {
    name: "KbPageAiService",
    build: (db, gateway) => new KbPageAiService(db, gateway as never, { log: jest.fn() } as never, kbPageAiAuth as never),
  },
];

function runBuffered(
  svc: KbArticleAiService | KbPageAiService,
  action: KbDocAiAction,
  orgId = ORG_ID,
): Promise<unknown> {
  const u = user(orgId);
  if (action === "summarize") return svc.summarize(u, DOC_ID);
  if (action === "ask") return svc.ask(u, DOC_ID, "What are the prerequisites?");
  if (action === "improve") return svc.improve(u, DOC_ID);
  return svc.suggestRelated(u, DOC_ID);
}

describe.each(SURFACES)("$name — the buffered actions release the connection", (surface) => {
  it.each(ACTIONS)(
    "%s: no transaction is open when the provider call is made",
    async (action) => {
      const { db, state } = trackingDb(DOC_ROW);
      const gateway = providerProbe(state);

      await runBuffered(surface.build(db, gateway), action);

      expect(gateway.invokeTextWithUsage).toHaveBeenCalledTimes(1);
      expect(gateway.openWhenProviderCalled).toEqual([0]);
    },
  );

  it.each(ACTIONS)("%s: the tenant-scoped read still happens inside a transaction", async (action) => {
    const { db, state, findFirst } = trackingDb(DOC_ROW);

    await runBuffered(surface.build(db, providerProbe(state)), action);

    expect(state.opened).toBe(1);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it("the document the transaction read is the one the provider is asked about", async () => {
    const { db, state } = trackingDb(DOC_ROW);
    const gateway = providerProbe(state);

    await runBuffered(surface.build(db, gateway), "summarize");

    const opts = gateway.invokeTextWithUsage.mock.calls[0]?.[0] as {
      prompt: { user: string };
    };
    expect(opts.prompt.user).toContain("Onboarding");
    expect(opts.prompt.user).toContain("the body");
  });

  it("a cross-tenant document id is a 404 and no paid call is dispatched", async () => {
    const { db, state } = trackingDb(null);
    const gateway = providerProbe(state);

    await expect(runBuffered(surface.build(db, gateway), "summarize", OTHER_ORG)).rejects.toThrow(
      /not found/i,
    );
    expect(gateway.invokeTextWithUsage).not.toHaveBeenCalled();
    expect(state.open).toBe(0);
  });

  it("reproduces the defect when the route keeps the request transaction", async () => {
    const { db, state } = trackingDb(DOC_ROW);
    const gateway = providerProbe(state);
    const svc = surface.build(db, gateway);

    await runInTenantTransaction(db, () => runBuffered(svc, "summarize"), { orgId: ORG_ID });

    expect(gateway.openWhenProviderCalled).toEqual([1]);
  });

  it("the streamed sibling has the same release shape, so the two cannot drift", async () => {
    const { db, state } = trackingDb(DOC_ROW);
    const gateway = providerProbe(state);

    await surface.build(db, gateway).stream(user(ORG_ID), DOC_ID, "summarize");

    expect(gateway.openWhenProviderCalled).toEqual([0]);
  });
});

const ROUTE_HANDLERS = [
  "summarize",
  "summarizeStream",
  "ask",
  "askStream",
  "improve",
  "improveStream",
  "suggestRelated",
  "suggestRelatedStream",
] as const;

describe.each([
  ["KbArticleAiController", KbArticleAiController],
  ["KbPageAiController", KbPageAiController],
])("%s — every route declares the opt-out", (_name, controller) => {
  it.each(ROUTE_HANDLERS)("%s carries @NoTenantTransaction()", (handler) => {
    const target: unknown = Reflect.get(controller.prototype, handler);
    expect(typeof target).toBe("function");
    expect(Reflect.getMetadata(NO_TENANT_TRANSACTION, Object(target))).toBe(true);
  });

  it("declares AiRequestAbortInterceptor, which is what replaces the tenant context's signal", () => {
    const interceptors = Reflect.getMetadata("__interceptors__", controller) as unknown[];
    expect(
      (interceptors ?? []).some((i) => {
        const name = typeof i === "function" ? i.name : i?.constructor?.name;
        return name === "AiRequestAbortInterceptor";
      }),
    ).toBe(true);
  });
});


@Injectable()
class StubAuth implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest().user = { orgId: ORG_ID, userId: "user-1" };
    return true;
  }
}

@Controller("in-transaction-probe")
@UseGuards(StubAuth)
class InTransactionProbeController {
  @Post("run")
  run(): { ok: boolean } {
    return { ok: true };
  }
}

describe("the buffered KB AI routes, end to end through the real interceptor stack", () => {
  let app: INestApplication;
  let baseUrl: string;
  let opened: { count: number };
  let seenSignals: Array<AbortSignal | undefined>;

  beforeAll(async () => {
    primeRelocationTrafficTracker([], Date.now());
    opened = { count: 0 };
    seenSignals = [];

    const tx = { execute: async () => [{ placement_fence_held: 1 }] };
    const db = {
      transaction: async <T>(cb: (t: unknown) => Promise<T>): Promise<T> => {
        opened.count += 1;
        return cb(tx);
      },
      select: () => ({ from: () => ({ where: async () => [] }) }),
    };

    const stubService = {
      summarize: async () => {
        seenSignals.push(getAiRequestAbortSignal());
        return { text: "answer" };
      },
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [KbArticleAiController, KbPageAiController, InTransactionProbeController],
      providers: [
        Reflector,
        TenantContextService,
        StubAuth,
        { provide: DRIZZLE, useValue: db },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
        { provide: KbArticleAiService, useValue: stubService },
        { provide: KbPageAiService, useValue: stubService },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(StubAuth)
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    const server: Server = app.getHttpServer();
    server.closeAllConnections();
    await app.close();
  });

  beforeEach(() => {
    opened.count = 0;
    seenSignals.length = 0;
  });

  it("(anti-vacuous) a route without the opt-out DOES open a request transaction", async () => {
    const res = await fetch(`${baseUrl}/in-transaction-probe/run`, { method: "POST" });
    expect(res.status).toBe(201);
    expect(opened.count).toBe(1);
  });

  it.each([
    ["article", "kb/articles/7/ai/summarize"],
    ["page", "kb/pages/7/ai/summarize"],
  ])("the buffered %s summarize route opens no request transaction", async (_kind, path) => {
    const res = await fetch(`${baseUrl}/${path}`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(opened.count).toBe(0);
  });

  it.each([
    ["article", "kb/articles/7/ai/summarize"],
    ["page", "kb/pages/7/ai/summarize"],
  ])("the %s route still arms a cancellation signal for the provider call", async (_kind, path) => {
    await fetch(`${baseUrl}/${path}`, { method: "POST" });

    expect(seenSignals).toHaveLength(1);
    expect(seenSignals[0]).toBeInstanceOf(AbortSignal);
    expect(seenSignals[0]?.aborted).toBe(false);
  });
});
