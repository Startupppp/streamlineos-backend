import express, { type Express } from "express";
import request from "supertest";
import { shutdownGate } from "./shutdown-gate";
import { shutdownState } from "./shutdown-state";

function buildApp(): { app: Express; finish: () => void } {
  const pending: (() => void)[] = [];
  const app = express();
  app.use(shutdownGate);
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });
  app.get("/slow", (_req, res) => {
    pending.push(() => res.status(200).json({ done: true }));
  });
  app.get("/fast", (_req, res) => {
    res.status(200).json({ done: true });
  });
  return {
    app,
    finish: () => {
      for (const respond of pending.splice(0)) respond();
    },
  };
}

describe("graceful shutdown over HTTP", () => {
  afterEach(() => {
    shutdownState.reset();
  });

  it("serves normally and leaves nothing in flight once a request completes", async () => {
    const { app } = buildApp();

    await request(app).get("/fast").expect(200);

    expect(shutdownState.snapshot().inFlight).toBe(0);
  });

  it("refuses new requests with 503 and Retry-After after the drain closes", async () => {
    const { app } = buildApp();
    shutdownState.beginDrain();
    shutdownState.stopAccepting();

    const response = await request(app).get("/fast").expect(503);

    expect(response.headers["retry-after"]).toBe("5");
    expect(response.body).toMatchObject({ error: "Service Unavailable" });
  });

  it("still answers liveness while refusing everything else", async () => {
    const { app } = buildApp();
    shutdownState.beginDrain();
    shutdownState.stopAccepting();

    await request(app).get("/health").expect(200);
    await request(app).get("/fast").expect(503);
  });

  it("finishes an in-flight request that started before the drain, and only then reports drained", async () => {
    const { app, finish } = buildApp();

    let inFlightStatus: number | null = null;
    const inFlight = request(app)
      .get("/slow")
      .then((response) => {
        inFlightStatus = response.status;
      });
    await waitFor(() => shutdownState.snapshot().inFlight === 1);

    shutdownState.beginDrain();
    shutdownState.stopAccepting();

    let drained: boolean | null = null;
    const quiescence = shutdownState.awaitQuiescence(5_000).then((result) => {
      drained = result.drained;
    });

    await request(app).get("/fast").expect(503);
    expect(drained).toBeNull();

    finish();
    await inFlight;
    await quiescence;

    expect(inFlightStatus).toBe(200);
    expect(drained).toBe(true);
    expect(shutdownState.snapshot()).toMatchObject({ inFlight: 0, rejected: 1 });
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was never met");
}
