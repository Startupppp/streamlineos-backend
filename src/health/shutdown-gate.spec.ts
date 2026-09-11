import type { NextFunction, Request, Response } from "express";
import { shutdownGate } from "./shutdown-gate";
import { shutdownState } from "./shutdown-state";

interface FakeResponse {
  response: Response;
  statusCode: number | null;
  body: unknown;
  headers: Record<string, string>;
  emit: (event: "finish" | "close") => void;
}

function makeResponse(): FakeResponse {
  const listeners = new Map<string, (() => void)[]>();
  const state: FakeResponse = {
    statusCode: null,
    body: null,
    headers: {},
    emit: (event) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    response: {
      setHeader(name: string, value: string) {
        state.headers[name] = value;
        return this as unknown as Response;
      },
      status(code: number) {
        state.statusCode = code;
        return this as unknown as Response;
      },
      json(payload: unknown) {
        state.body = payload;
        return this as unknown as Response;
      },
      on(event: string, listener: () => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return this as unknown as Response;
      },
    } as unknown as Response,
  };
  return state;
}

function makeRequest(path: string): Request {
  return { path } as Request;
}

describe("shutdownGate", () => {
  afterEach(() => {
    shutdownState.reset();
  });

  it("passes a normal request through and counts it as in flight until the response finishes", () => {
    const next = jest.fn<void, []>() as unknown as NextFunction;
    const res = makeResponse();

    shutdownGate(makeRequest("/hr/employees"), res.response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(shutdownState.snapshot().inFlight).toBe(1);

    res.emit("finish");
    expect(shutdownState.snapshot().inFlight).toBe(0);
  });

  it("releases the in-flight slot exactly once when both finish and close fire", () => {
    const next = jest.fn<void, []>() as unknown as NextFunction;
    const res = makeResponse();
    shutdownState.enter();

    shutdownGate(makeRequest("/hr/employees"), res.response, next);
    res.emit("finish");
    res.emit("close");

    expect(shutdownState.snapshot().inFlight).toBe(1);
  });

  it("refuses new requests with 503 and Retry-After once accepting has stopped", () => {
    const next = jest.fn<void, []>() as unknown as NextFunction;
    const res = makeResponse();
    shutdownState.beginDrain();
    shutdownState.stopAccepting();

    shutdownGate(makeRequest("/hr/employees"), res.response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.headers["Retry-After"]).toBe("5");
    expect(res.headers.Connection).toBe("close");
  });

  it("keeps health routes open during shutdown, versioned or not", () => {
    shutdownState.beginDrain();
    shutdownState.stopAccepting();

    for (const path of ["/health", "/health/ready", "/v1/health", "/v1/health/db"]) {
      const next = jest.fn<void, []>() as unknown as NextFunction;
      const res = makeResponse();

      shutdownGate(makeRequest(path), res.response, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBeNull();
    }
  });

  it("does not treat a route that merely starts with the word health as a probe", () => {
    const next = jest.fn<void, []>() as unknown as NextFunction;
    const res = makeResponse();
    shutdownState.beginDrain();
    shutdownState.stopAccepting();

    shutdownGate(makeRequest("/healthcheck-admin"), res.response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
  });
});
