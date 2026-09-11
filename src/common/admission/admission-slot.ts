export interface AdmissionScopedRequest {
  _admissionOrgId?: string;
  _admissionRelease?: () => void;
}

interface ResponseLifecycle {
  on: (event: string, listener: () => void) => unknown;
}

function hasResponseLifecycle(res: unknown): res is ResponseLifecycle {
  if (typeof res !== "object" || res === null) return false;
  const candidate: { on?: unknown } = res;
  return typeof candidate.on === "function";
}

// Nest runs every guard before any interceptor, so a downstream guard's rejection never reaches
// the interceptor's `finalize`. The response lifecycle is the only edge that fires for every
// terminated request, whichever phase ended it; the one-shot keeps that from double-releasing.
export function attachAdmissionSlot(
  req: AdmissionScopedRequest,
  res: unknown,
  release: () => void,
): void {
  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    release();
  };

  req._admissionRelease = releaseOnce;

  if (!hasResponseLifecycle(res)) return;
  res.on("close", releaseOnce);
  res.on("finish", releaseOnce);
}
