jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, fn: () => Promise<unknown>) => fn(),
}));

import { NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbPageAiService } from "./kb-page-ai.service";
import { KbArticleAiService } from "../help-centre/kb-article-ai.service";
import type { KbDocAiAction } from "../retrieval/dto/kb-ai.schemas";

const ACTIONS: KbDocAiAction[] = ["summarize", "ask", "improve", "suggest-related"];
const OWNER = "org-owner";
const ATTACKER = "org-attacker";
const DOC_ID = 3;
const QUESTION = "What are the prerequisites?";

interface GatewayDouble {
  invokeTextWithUsage: jest.Mock;
  streamTextWithUsage: jest.Mock;
}

function makeGateway(): GatewayDouble {
  return {
    invokeTextWithUsage: jest.fn().mockResolvedValue({ ok: true, data: "answer", aiUsage: undefined }),
    streamTextWithUsage: jest.fn().mockResolvedValue({
      stream: { pipeTextStreamToResponse: jest.fn().mockResolvedValue(undefined) },
      model: "gpt-4o-mini",
      correlationId: "corr-kb-1",
    }),
  };
}

function makeUser(orgId: string) {
  return { orgId, userId: "user-1", isOrgOwner: false } as never;
}

function joinChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = { where: jest.fn().mockResolvedValue([]) };
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  chain.leftJoin = jest.fn().mockReturnValue(chain);
  return chain;
}

function makeDb(table: "kbPages", row: unknown): Db {
  return {
    query: { [table]: { findFirst: jest.fn().mockResolvedValue(row) } },
    select: jest.fn().mockImplementation(() => ({ from: jest.fn().mockReturnValue(joinChain()) })),
  } as unknown as Db;
}

const DOC_ROW = { id: DOC_ID, orgId: OWNER, spaceId: 1, title: "Onboarding", contentText: "the body" };

const authMock = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  assertPageAccess: jest.fn().mockResolvedValue({ orgId: "o1", pageId: 1, action: "view", via: "admin" }),
};

interface Surface {
  name: string;
  keyPrefix: string;
  build(gateway: GatewayDouble, row: unknown): KbPageAiService | KbArticleAiService;
}

const SURFACES: Surface[] = [
  {
    name: "KbPageAiService",
    keyPrefix: "kb.page-",
    build: (gateway, row) =>
      new KbPageAiService(makeDb("kbPages", row), gateway as never, { log: jest.fn() } as never, authMock as never),
  },
  {
    name: "KbArticleAiService",
    keyPrefix: "kb.article-",
    build: (gateway, row) =>
      new KbArticleAiService(
        makeDb("kbPages", row),
        { assertCanViewArticle: jest.fn().mockResolvedValue(undefined) } as never,
        gateway as never,
        { log: jest.fn() } as never,
      ),
  },
];

describe.each(SURFACES)("$name.stream — the KB document panel actually streams", (surface) => {
  beforeEach(() => {
    authMock.visiblePagePredicate.mockClear();
    authMock.assertPageAccess.mockClear();
  });

  it.each(ACTIONS)("dispatches ONE paid streaming call for %s with the caller's real actor", async (action) => {
    const gateway = makeGateway();
    const svc = surface.build(gateway, DOC_ROW);

    await svc.stream(makeUser(OWNER), DOC_ID, action, QUESTION);

    expect(gateway.streamTextWithUsage).toHaveBeenCalledTimes(1);
    expect(gateway.streamTextWithUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        charge: true,
        feature: `${surface.keyPrefix}${action}`,
        actor: { orgId: OWNER, userId: "user-1" },
      }),
    );
    expect(gateway.invokeTextWithUsage).not.toHaveBeenCalled();
  });

  it.each(ACTIONS)(
    "%s bills the same feature key, charge flag and output ceiling as its buffered sibling",
    async (action) => {
      const streamed = makeGateway();
      const buffered = makeGateway();
      const question = action === "ask" ? QUESTION : undefined;

      await surface.build(streamed, DOC_ROW).stream(makeUser(OWNER), DOC_ID, action, question);
      await runBuffered(surface.build(buffered, DOC_ROW), action);

      const s = streamed.streamTextWithUsage.mock.calls[0]?.[0] as Record<string, unknown>;
      const b = buffered.invokeTextWithUsage.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(s.feature).toBe(b.feature);
      expect(s.charge).toBe(b.charge);
      expect(s.maxTokens).toBe(b.maxTokens);
    },
  );

  it.each(ACTIONS)("%s sends the buffered sibling's prompt verbatim, so the two answers agree", async (action) => {
    const streamed = makeGateway();
    const buffered = makeGateway();
    const question = action === "ask" ? QUESTION : undefined;

    await surface.build(streamed, DOC_ROW).stream(makeUser(OWNER), DOC_ID, action, question);
    await runBuffered(surface.build(buffered, DOC_ROW), action);

    const s = streamed.streamTextWithUsage.mock.calls[0]?.[0] as { prompt: { system: string; user: string } };
    const b = buffered.invokeTextWithUsage.mock.calls[0]?.[0] as { prompt: { system: string; user: string } };
    expect(s.prompt.system).toBe(b.prompt.system);
    expect(s.prompt.user).toBe(b.prompt.user);
  });

  it("hands the route's abort signal to the provider call, so a hang-up stops the spend", async () => {
    const gateway = makeGateway();
    const svc = surface.build(gateway, DOC_ROW);
    const controller = new AbortController();

    await svc.stream(makeUser(OWNER), DOC_ID, "improve", undefined, controller.signal);

    const opts = gateway.streamTextWithUsage.mock.calls[0]?.[0] as { signal?: AbortSignal };
    expect(opts.signal).toBe(controller.signal);
  });

  it("carries the question into the streamed ask prompt", async () => {
    const gateway = makeGateway();
    const svc = surface.build(gateway, DOC_ROW);

    await svc.stream(makeUser(OWNER), DOC_ID, "ask", QUESTION);

    const opts = gateway.streamTextWithUsage.mock.calls[0]?.[0] as { prompt: { user: string } };
    expect(opts.prompt.user).toContain(QUESTION);
  });

  it("a cross-tenant document id is a 404 and dispatches no paid call", async () => {
    const gateway = makeGateway();
    const svc = surface.build(gateway, null);

    await expect(svc.stream(makeUser(ATTACKER), DOC_ID, "summarize")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(gateway.streamTextWithUsage).not.toHaveBeenCalled();
  });

  it("the improve action is the one that needed streaming most — it still declares a 1024-token ceiling", async () => {
    const gateway = makeGateway();
    await surface.build(gateway, DOC_ROW).stream(makeUser(OWNER), DOC_ID, "improve");

    const opts = gateway.streamTextWithUsage.mock.calls[0]?.[0] as { maxTokens: number };
    expect(opts.maxTokens).toBe(1024);
  });
});

function runBuffered(svc: KbPageAiService | KbArticleAiService, action: KbDocAiAction): Promise<unknown> {
  const user = makeUser(OWNER);
  if (action === "summarize") return svc.summarize(user, DOC_ID);
  if (action === "ask") return svc.ask(user, DOC_ID, QUESTION);
  if (action === "improve") return svc.improve(user, DOC_ID);
  return svc.suggestRelated(user, DOC_ID);
}
