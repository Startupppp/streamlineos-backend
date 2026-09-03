/**
 * A mid-stream provider fault must not reach the client as a completed answer.
 *
 * THE DEFECT. Once the 200 and the headers are on the wire, a provider that
 * 503s mid-answer cannot be reported as a status code. `pipeAiTextStream`
 * handled that by logging the fault and calling `res.end()` — which sends the
 * terminating zero-length chunk, i.e. tells the client the answer finished. The
 * browser read loop in `frontend/hooks/api/ai-text-stream.ts` therefore sees an
 * ordinary `done` and returns `{ status: "completed", text: <partial> }`;
 * `AiActionResultBody` renders the truncated paragraph as the finished draft
 * with an Apply button, and clicking Apply pastes half a sentence into the page.
 * None of the nine AI failure states can fire, because the transport reported
 * success. Faults BEFORE the first byte were always handled correctly — a 402
 * stays 402, a 503 stays 503 — which is what made this one invisible.
 *
 * THE FIX is `res.destroy()`: the chunked body ends without its terminator, so
 * the read loop rejects instead of completing and `classifyAiError` puts the
 * surface into a real, retryable failure state. No wire-format change, so all
 * 26 `respondWithAiTextStream` routes keep their contract, and a non-browser
 * client sees the same truncation.
 *
 * This has to run over a real socket. A mocked `ServerResponse` can record that
 * `end` or `destroy` was called, but only a real client can show what those two
 * mean to the thing reading the body — which is the entire finding.
 */
import { Controller, Post, Res } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import type { Response } from "express";
import type { ServerResponse } from "http";
import { Test } from "@nestjs/testing";
import { pipeAiTextStream, type PipeableAiTextStream } from "./ai-stream-response";

const PREFIX = "the first half of the answer ";

/** Writes a real prefix, then fails the way a provider 503 mid-answer does. */
function faultingStream(): PipeableAiTextStream {
  return {
    async pipeTextStreamToResponse(res: ServerResponse): Promise<void> {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.write(PREFIX);
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error("upstream 503");
    },
  };
}

function completingStream(): PipeableAiTextStream {
  return {
    async pipeTextStreamToResponse(res: ServerResponse): Promise<void> {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.write(PREFIX);
      res.write("and the second half.");
      res.end();
    },
  };
}

@Controller("fault-probe")
class FaultProbeController {
  @Post("faulting")
  async faulting(@Res() res: Response): Promise<void> {
    await pipeAiTextStream(res, faultingStream(), { feature: "f", orgId: "org_probe" });
  }

  @Post("completing")
  async completing(@Res() res: Response): Promise<void> {
    await pipeAiTextStream(res, completingStream(), { feature: "f", orgId: "org_probe" });
  }
}

interface ReadOutcome {
  text: string;
  ended: "done" | "error";
}

async function readToEnd(url: string): Promise<{ status: number } & ReadOutcome> {
  const response = await fetch(url, { method: "POST" });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no readable body");

  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return { status: response.status, text, ended: "done" };
  } catch {
    return { status: response.status, text, ended: "error" };
  }
}

describe("a mid-stream AI fault over a real socket", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FaultProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    baseUrl = await app.getUrl();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it("reaches the client as a truncated body, not a clean end", async () => {
    const outcome = await readToEnd(`${baseUrl}/fault-probe/faulting`);

    // The status was already 200 before the fault; that is the premise, not the bug.
    expect(outcome.status).toBe(200);
    expect(outcome.text).toContain(PREFIX.trim());
    // `done` here is what let the frontend report `{ status: "completed" }`.
    expect(outcome.ended).toBe("error");
  }, 30_000);

  it("still ends cleanly when the stream really did finish", async () => {
    const outcome = await readToEnd(`${baseUrl}/fault-probe/completing`);

    expect(outcome.status).toBe(200);
    expect(outcome.text).toBe(`${PREFIX}and the second half.`);
    expect(outcome.ended).toBe("done");
  }, 30_000);
});
