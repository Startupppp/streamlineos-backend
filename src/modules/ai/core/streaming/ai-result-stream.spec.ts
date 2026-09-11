import { Test } from "@nestjs/testing";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { createAiResultStream } from "./ai-result-stream";

async function generation(finishReason = "stop") {
  const module = await Test.createTestingModule({ providers: [{
    provide: AiGatewayService,
    useValue: { streamTextWithUsage: jest.fn().mockResolvedValue({
      model: "gpt-4o-mini", correlationId: "test-call",
      stream: {
        textStream: new ReadableStream<string>({ start(controller) {
          controller.enqueue("first ");
          controller.enqueue("last");
          controller.close();
        } }),
        text: Promise.resolve("first last"),
        finishReason: Promise.resolve(finishReason),
        totalUsage: Promise.resolve({ inputTokens: 20, outputTokens: 10, totalTokens: 30 }),
      },
    }) },
  }] }).compile();
  return module.get(AiGatewayService).streamTextWithUsage({
    actor: { orgId: "org-test", userId: "user-test" }, feature: "test",
    prompt: { system: "test", user: "test" },
  });
}

async function read(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  const frames: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return frames.join("");
      frames.push(value);
    }
  } finally { reader.releaseLock(); }
}

describe("AI result stream", () => {
  it("emits incremental text and the durable terminal result with metered usage", async () => {
    const complete = jest.fn(async (text: string, usage: unknown) => ({ answer: text, aiUsage: usage, conversationId: 42 }));
    const product = createAiResultStream({ generation: await generation(), signal: new AbortController().signal, complete });
    const frames = await read(product.stream.textStream);
    expect(frames.split("\n").filter(Boolean)).toHaveLength(3);
    expect(frames).toContain('"type":"text","text":"first "');
    expect(frames).toContain('"type":"result","data":{"answer":"first last"');
    expect(frames).toContain('"conversationId":42');
    expect(complete).toHaveBeenCalledWith("first last", expect.objectContaining({
      model: "gpt-4o-mini", promptTokens: 20, completionTokens: 10, totalTokens: 30,
      credits: expect.any(Number),
    }));
  });

  it("never emits a result or persists a provider-truncated answer", async () => {
    const complete = jest.fn();
    const product = createAiResultStream({ generation: await generation("length"), signal: new AbortController().signal, complete });
    const frames = await read(product.stream.textStream);
    expect(frames).toContain('"type":"error"');
    expect(frames).not.toContain('"type":"result"');
    expect(complete).not.toHaveBeenCalled();
  });

  it("reports persistence failure safely instead of returning a successful result", async () => {
    const complete = jest.fn().mockRejectedValue(new Error("sensitive database details"));
    const product = createAiResultStream({ generation: await generation(), signal: new AbortController().signal, complete });
    const frames = await read(product.stream.textStream);
    expect(frames).toContain('"type":"error"');
    expect(frames).not.toContain('"type":"result"');
    expect(frames).not.toContain("sensitive database details");
  });

  it("does not persist or return success after cancellation", async () => {
    const complete = jest.fn();
    const abort = new AbortController();
    abort.abort();
    const product = createAiResultStream({ generation: await generation(), signal: abort.signal, complete });
    const frames = await read(product.stream.textStream);
    expect(frames).toContain('"type":"error"');
    expect(complete).not.toHaveBeenCalled();
  });
});
