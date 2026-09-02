import type { NextFunction, Request, Response } from "express";
import { shutdownState } from "./shutdown-state";

const HEALTH_PATH = /^\/(?:v\d+\/)?health(?:\/|$)/;

const RETRY_AFTER_SECONDS = "5";

/**
 * Refuses new requests once the process has stopped accepting work, and counts
 * the ones still running so shutdown can wait for them.
 *
 * Installed ahead of routing in `main.ts`: a request that reaches a controller
 * during shutdown has already acquired a connection and a tenant transaction,
 * and killing it there is the drop this gate exists to prevent. Health routes
 * stay open throughout — liveness must keep answering or the orchestrator
 * SIGKILLs the process mid-drain, and readiness must be reachable to report the
 * 503 that takes it out of rotation.
 */
export function shutdownGate(req: Request, res: Response, next: NextFunction): void {
  if (HEALTH_PATH.test(req.path)) {
    next();
    return;
  }

  if (!shutdownState.enter()) {
    res.setHeader("Retry-After", RETRY_AFTER_SECONDS);
    res.setHeader("Connection", "close");
    res.status(503).json({
      statusCode: 503,
      error: "Service Unavailable",
      message: "Server is shutting down and is no longer accepting requests",
    });
    return;
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    shutdownState.leave();
  };
  res.on("close", release);
  res.on("finish", release);

  next();
}
