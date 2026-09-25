import { NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { UIMessageChunk } from "ai";
import type { Db } from "../../../db/drizzle.module";
import { KbPageAiService } from "./kb-page-ai.service";
import {
  buildSourcesEventStream,
  makeSourcesEventPipe,
  type ModelStreamSource,
} from "../../ai/core/streaming/ai-stream-response";

function makeTextChunks(text: string): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "text-start" as const, id: "t1" });
      controller.enqueue({ type: "text-delta" as const, id: "t1", delta: text });
      controller.enqueue({ type: "text-end" as const, id: "t1" });
      controller.close();
    },
  });
}

function makeModelStream(text: string): ModelStreamSource {
  return { toUIMessageStream: () => makeTextChunks(text) };
}

async function collectChunks(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return chunks;
}

const authMock = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  assertPageAccess: jest.fn().mockResolvedValue({ orgId: "o1", pageId: 1, action: "view", via: "admin" }),
};

const PAGE_ID = 5;
const OWNER = "org-owner";
const ATTACKER = "org-attacker";
const PAGE_ROW = { id: PAGE_ID, orgId: OWNER, title: "Onboarding Guide", contentText: "content", icon: "📋" };

function makeUser(orgId: string) {
  return { orgId, userId: "user-1", isOrgOwner: false } as never;
}

function makeDb(pageRow: unknown) {
  const surface = {
    query: {
      kbPages: {
        findFirst: jest.fn().mockResolvedValue(pageRow),
      },
    },
    execute: jest.fn().mockResolvedValue([{ placement_fence_held: 1 }]),
  };
  return {
    db: {
      ...surface,
      transaction: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(surface),
    } as unknown as Db,
  };
}

describe("buildSourcesEventStream — sources event precedes text", () => {
  it("emits the sources data event before any text-delta chunk so chips have data while the answer streams", async () => {
    const sources = [{ id: 1, title: "Guide", icon: null }];
    const stream = buildSourcesEventStream(makeModelStream("answer text"), "data-kb-page-sources", sources);
    const chunks = await collectChunks(stream);

    const sourcesIdx = chunks.findIndex((c) => c.type === "data-kb-page-sources");
    const textIdx = chunks.findIndex((c) => c.type === "text-delta");

    expect(sourcesIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(sourcesIdx).toBeLessThan(textIdx);
  });

  it("carries the sources payload on the data event so the chip receives id, title and icon", async () => {
    const sources = [{ id: 7, title: "Leave Policy", icon: "📋" }];
    const stream = buildSourcesEventStream(makeModelStream("text"), "data-kb-page-sources", sources);
    const chunks = await collectChunks(stream);

    const part = chunks.find((c) => c.type === "data-kb-page-sources");
    expect(part).toMatchObject({ type: "data-kb-page-sources", data: sources, transient: true });
  });

  it("emits no sources event when the sources array is empty so an ungrounded answer gets no chip row", async () => {
    const stream = buildSourcesEventStream(makeModelStream("text"), "data-kb-page-sources", []);
    const chunks = await collectChunks(stream);

    expect(chunks.filter((c) => c.type === "data-kb-page-sources")).toHaveLength(0);
  });

  it("makeSourcesEventPipe returns a pipe with pipeUIMessageStreamToResponse", () => {
    const pipe = makeSourcesEventPipe(makeModelStream("hello"), "data-kb-page-sources", []);
    expect(typeof pipe.pipeUIMessageStreamToResponse).toBe("function");
  });
});

describe("KbPageAiService — stream emits sources, buffered path returns citations", () => {
  beforeEach(() => {
    authMock.visiblePagePredicate.mockClear();
  });

  const fakeUiStream = makeTextChunks("generated text");
  const fakeAiTextStream = {
    stream: { toUIMessageStream: () => fakeUiStream },
    model: "claude-3-haiku",
    correlationId: "corr-1",
  };

  const gatewayStream = {
    streamTextWithUsage: jest.fn().mockResolvedValue(fakeAiTextStream),
  } as never;

  const gatewayBuffered = {
    invokeTextWithUsage: jest.fn().mockResolvedValue({ ok: true, data: "summary text", aiUsage: undefined }),
  } as never;

  const audit = { log: jest.fn() } as never;

  it("stream returns a pipe with pipeUIMessageStreamToResponse so the controller can switch to the UI message format", async () => {
    const { db } = makeDb(PAGE_ROW);
    const svc = new KbPageAiService(db, gatewayStream, audit, authMock as never);

    const result = await svc.stream(makeUser(OWNER), PAGE_ID, "summarize");

    expect(typeof result.pipeUIMessageStreamToResponse).toBe("function");
  });

  it("stream throws NotFoundException for a cross-tenant page so retrieval leaks no existence signal", async () => {
    const { db } = makeDb(null);
    const svc = new KbPageAiService(db, gatewayStream, audit, authMock as never);

    await expect(svc.stream(makeUser(ATTACKER), PAGE_ID, "summarize")).rejects.toThrow(NotFoundException);
  });

  it("buffered summarize includes citations with the page id, title and icon so chips render after generation", async () => {
    const { db } = makeDb(PAGE_ROW);
    const svc = new KbPageAiService(db, gatewayBuffered, audit, authMock as never);

    const result = await svc.summarize(makeUser(OWNER), PAGE_ID);

    expect(result.citations).toEqual([{ id: PAGE_ID, title: PAGE_ROW.title, icon: PAGE_ROW.icon }]);
  });

  it("buffered summarize returns text alongside citations so the existing text contract is preserved", async () => {
    const { db } = makeDb(PAGE_ROW);
    const svc = new KbPageAiService(db, gatewayBuffered, audit, authMock as never);

    const result = await svc.summarize(makeUser(OWNER), PAGE_ID);

    expect(result).toHaveProperty("text", "summary text");
  });
});
