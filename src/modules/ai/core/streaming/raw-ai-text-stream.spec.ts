import { createServer, type Server } from "node:http";
import { pipeAiTextStream } from "./ai-stream-response";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP listener");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe("raw AI text transport", () => {
  it("delivers the first chunk before completion and retains response metadata", async () => {
    let finish: (() => void) | undefined;
    const legacyPipe = jest.fn();
    const server = createServer((req, res) => {
      req.resume();
      const textStream = new ReadableStream<string>({
        start(controller) {
          controller.enqueue("first");
          finish = () => { controller.enqueue(" last"); controller.close(); };
        },
      });
      void pipeAiTextStream(res, { textStream, pipeTextStreamToResponse: legacyPipe }, {
        orgId: "org-test", feature: "test", headers: { "x-ai-sources": "sources" },
      });
    });
    const url = await listen(server);
    try {
      const response = await fetch(url);
      expect(response.headers.get("x-ai-sources")).toBe("sources");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const reader = response.body?.getReader();
      if (!reader || !finish) throw new Error("Stream did not open");
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
      finish();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(" last");
      expect((await reader.read()).done).toBe(true);
      expect(legacyPipe).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("makes a provider fault reject the browser reader instead of closing a partial answer successfully", async () => {
    let fail: (() => void) | undefined;
    const legacyPipe = jest.fn();
    const server = createServer((req, res) => {
      req.resume();
      const textStream = new ReadableStream<string>({
        start(controller) {
          controller.enqueue("partial");
          fail = () => controller.error(new Error("provider disconnected"));
        },
      });
      void pipeAiTextStream(res, { textStream, pipeTextStreamToResponse: legacyPipe }, {
        orgId: "org-test", feature: "test",
      });
    });
    const url = await listen(server);
    try {
      const response = await fetch(url);
      const reader = response.body?.getReader();
      if (!reader || !fail) throw new Error("Stream did not open");
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("partial");
      fail();
      await expect(reader.read()).rejects.toThrow();
      expect(legacyPipe).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });
});
