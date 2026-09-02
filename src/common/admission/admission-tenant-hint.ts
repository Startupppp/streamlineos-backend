import { SetMetadata, type Type } from "@nestjs/common";

export const ADMISSION_TENANT_HINT_KEY = "admission:tenant_hint";

export const PUBLIC_ADMISSION_BUCKET = "__public__";

const HINTED_BUCKET_PREFIX = "hint:";

const SAFE_BUCKET_ID = /^[A-Za-z0-9_-]{1,64}$/;

// A bucketing HINT, never an authentication result. A provider answers "which tenant would this
// request belong to if it authenticates", and the guard uses that answer for one purpose only:
// choosing which concurrency counter the request is charged to. It never reaches `req.user`, never
// grants access and never reaches an authorization decision. A provider that cannot answer returns
// undefined and the request buckets as public, exactly as an unhinted public route does.
export interface AdmissionTenantHintProvider {
  resolveAdmissionTenantOrgId(req: unknown): string | undefined;
}

export const UseAdmissionTenantHint = (provider: Type<AdmissionTenantHintProvider>) =>
  SetMetadata(ADMISSION_TENANT_HINT_KEY, provider);

// Route metadata is `unknown` at the guard, so the declared provider is narrowed to a class token
// before it is handed to the container rather than asserted into one.
export function isAdmissionHintToken(value: unknown): value is Type<AdmissionTenantHintProvider> {
  return typeof value === "function";
}

export function isAdmissionTenantHintProvider(
  value: unknown,
): value is AdmissionTenantHintProvider {
  if (typeof value !== "object" || value === null) return false;
  const candidate: { resolveAdmissionTenantOrgId?: unknown } = value;
  return typeof candidate.resolveAdmissionTenantOrgId === "function";
}

// A hinted bucket is namespaced so it can never name an authenticated org's bucket. Two properties
// follow: a hinted request can never release a slot held by an authenticated request of the same
// org, and a stream that holds its slot for hours cannot eat the per-org headroom that the same
// org's ordinary requests need.
export function hintedBucket(orgId: string): string {
  return `${HINTED_BUCKET_PREFIX}${orgId}`;
}

// Fail closed: anything that is not a plain, bounded identifier is discarded rather than trusted,
// which caps the bucket keyspace and degrades to today's public bucket instead of erroring.
export function sanitiseTenantHint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!SAFE_BUCKET_ID.test(value)) return undefined;
  return value;
}
