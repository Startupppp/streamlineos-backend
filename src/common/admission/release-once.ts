import type { Response } from "express";
import type { AdmissionService } from "./admission.service";

/**
 * The request fields admission writes, and the one it reads back to stay
 * idempotent.
 */
export type AdmittedRequest = {
  _admissionOrgId?: string;
  _admissionReleased?: boolean;
};

/**
 * Give an admitted slot back exactly once, however the request ends.
 *
 * Two callers reach this — the response's own completion listener and
 * `AdmissionInterceptor` — because neither covers the other's cases. The
 * interceptor cannot see a request refused by a guard that runs after admission
 * (Nest runs interceptors only once every guard has passed), and the listener
 * fires on a timing the interceptor's `finalize` does not always beat. Both
 * calling this is the design, so the flag is what makes it safe: a double
 * release would hand back a slot the request never held, and the count would
 * drift DOWN until an organisation had more capacity than the config allows.
 */
export function releaseAdmissionOnce(
  req: AdmittedRequest | undefined,
  admissionService: AdmissionService,
): void {
  const orgId = req?._admissionOrgId;
  if (orgId === undefined) return;
  if (req?._admissionReleased === true) return;
  if (req) req._admissionReleased = true;
  admissionService.release(orgId);
}

/**
 * Return the slot when the RESPONSE ends, which is the only event that happens
 * for every outcome: a handler that succeeded, a later guard that threw, the
 * exception filter answering, or a client that hung up mid-flight.
 */
export function releaseWhenResponseEnds(
  req: AdmittedRequest,
  res: Partial<Pick<Response, "on">> | undefined,
  admissionService: AdmissionService,
): void {
  /*
    A response that cannot tell us when it ends leaves `AdmissionInterceptor` as
    the only path back, which is exactly the pre-fix behaviour — degraded, but
    not worse than before, and far better than throwing from inside a guard and
    500-ing every request on an adapter that shapes `res` differently.
  */
  if (typeof res?.on !== "function") return;

  const give = (): void => {
    releaseAdmissionOnce(req, admissionService);
  };
  res.on("finish", give);
  res.on("close", give);
}
