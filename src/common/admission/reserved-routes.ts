import { posix } from "node:path";
import { API_VERSIONS } from "../http/api-version";
import type { WorkClass } from "./work-class";

export interface ReservedRoute {
  readonly prefix: string;
  readonly workClass: WorkClass;
}

export const RESERVED_ROUTES: readonly ReservedRoute[] = [
  { prefix: "auth", workClass: "authentication" },
  { prefix: "sessions", workClass: "authorization-revocation" },
  { prefix: "access", workClass: "authorization-revocation" },
  // The access snapshot every authenticated page waits on. Shed as an ordinary
  // write, one 503 walled the whole app behind "Syncing organization"
  // (BUG-HRMS-014); it is the read that carries a revocation to the client.
  { prefix: "me/access", workClass: "authorization-revocation" },
  { prefix: "module-access", workClass: "authorization-revocation" },
  { prefix: "ownership", workClass: "ownership" },
  { prefix: "billing", workClass: "billing-ledger" },
  { prefix: "payments", workClass: "billing-ledger" },
  { prefix: "webhooks/razorpay", workClass: "billing-ledger" },
  { prefix: "webhooks/payments", workClass: "billing-ledger" },
  { prefix: "payroll/runs", workClass: "payroll-posting" },
  { prefix: "internal/audit", workClass: "audit" },
];

const VERSION_SEGMENTS: readonly string[] = API_VERSIONS.map((version) => `v${version}`);

/**
 * `main.ts` enables `VersioningType.URI`, so every `@Controller("auth")` is
 * mounted at `/auth/...` AND `/v1/auth/...`. Without stripping the version
 * segment the versioned spelling classified as `ordinary-write` and shed at the
 * ordinary ceiling instead of being protected to the reserved one — the same
 * login, one prefix apart, with different availability.
 *
 * Measured 2026-09-03: the frontend does not reach this. `NEXT_PUBLIC_API_URL`
 * carries no path segment and `lib/api-client.ts` concatenates an unversioned
 * path, so every `/v1/` in that repo is either a literal controller prefix
 * (`agent/v1`, `portal/v1`, which are second segments and unaffected) or
 * Razorpay's CDN. It is still reachable by any direct API consumer, which is
 * what the OpenAPI document advertises.
 *
 * Stripped after normalisation, so traversal is resolved before the segment is
 * read, and only for versions the API actually declares — a controller whose
 * own first segment happened to start with `v` is left alone.
 */
export function normalisePath(path: string): string {
  const withoutQuery = path.split("?")[0] ?? "";
  const resolved = posix.normalize(`/${withoutQuery}`);
  if (resolved.startsWith("/..")) return "";
  const normalised = resolved.replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
  return stripVersionSegment(normalised);
}

function stripVersionSegment(normalised: string): string {
  for (const segment of VERSION_SEGMENTS) {
    if (normalised === segment) return "";
    if (normalised.startsWith(`${segment}/`)) return normalised.slice(segment.length + 1);
  }
  return normalised;
}

export function reservedClassForPath(path: string): WorkClass | undefined {
  const normalised = normalisePath(path);

  for (const route of RESERVED_ROUTES)
    if (normalised === route.prefix || normalised.startsWith(`${route.prefix}/`))
      return route.workClass;

  return undefined;
}
