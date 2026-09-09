const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Folders whose keys carry the owning organisation in segment two rather than
 * segment one. Without this the owner of such a key cannot be read off the key
 * at all, and the cross-tenant check silently degrades to "allow".
 */
export const ORG_NAMESPACED_KEY_FOLDERS: ReadonlySet<string> = new Set([
  "kb-media",
  "kb-sources",
]);

// KB uploads target R2_KB_BUCKET_NAME, so a read that omits the override looks in the wrong bucket.
export const KB_BUCKET_KEY_FOLDERS: ReadonlySet<string> = new Set(["kb-media", "kb-sources"]);

const SENSITIVE_FOLDER_ROOTS: ReadonlySet<string> = new Set([
  "payroll",
  "payroll-exports",
  "payslips",
  "hr",
  "hr-documents",
  "hr-exports",
  "documents",
  "onboarding",
  "onboarding-docs",
  "resignations",
  "candidates",
  "candidate-vault",
  "esign",
  "e-sign",
  "signos",
  "signatures",
  "bank-batches",
  "gdpr-exports",
  "expense-exports",
  "fin-report-exports",
]);

export interface ParsedStorageKey {
  readonly ownerOrgId: string | null;
  readonly folderRoot: string;
}

/**
 * Reads the owning organisation and the folder root off an object key.
 *
 * Three key shapes are live. Everything minted since organisation scoping is
 * `<orgId>/<folder>/…`; a region that sets `R2_KEY_PREFIX` shifts that one
 * segment right to `<keyPrefix>/<orgId>/<folder>/…` (`StoragePlacement.objectKey`
 * prepends the prefix); legacy rows still hold `<folder>/…` with no organisation
 * at all. `ownerOrgId` is null only for the legacy shape — a key that names an
 * organisation always reports it, so the caller can refuse a foreign one.
 */
export function parseStorageKey(
  key: string,
  callerOrgId: string,
): ParsedStorageKey {
  const segments = key.replace(/^\/+/, "").split("/");
  const first = segments[0] ?? "";
  const second = segments[1];

  if (segments.length === 1) return { ownerOrgId: null, folderRoot: first };

  if (first === callerOrgId)
    return { ownerOrgId: callerOrgId, folderRoot: second ?? "" };

  if (ORG_NAMESPACED_KEY_FOLDERS.has(first))
    return { ownerOrgId: second ?? null, folderRoot: first };

  if (UUID_PATTERN.test(first))
    return { ownerOrgId: first, folderRoot: second ?? "" };

  /**
   * Region-prefixed shapes. `objectKey` writes the region key prefix AHEAD of the
   * organisation, so under any region that sets `R2_KEY_PREFIX` the organisation
   * is in segment two and the folder root in segment three. Reading segment one
   * only — as this function did — reported the prefix itself as the folder root
   * and the owner as unknown, which silently disables BOTH guards built on this:
   * `isForeignOrgKey` returns false for a foreign tenant's key, and the folder
   * root ("eu") is not in SENSITIVE_FOLDER_ROOTS, so `assertKeyReadable`'s
   * unresolved-sensitive-key denial does not fire either. A caller could then
   * mint a signed URL for another tenant's `documents/` object.
   */
  if (second !== undefined) {
    if (second === callerOrgId || UUID_PATTERN.test(second))
      return { ownerOrgId: second, folderRoot: segments[2] ?? "" };

    if (ORG_NAMESPACED_KEY_FOLDERS.has(second))
      return { ownerOrgId: segments[2] ?? null, folderRoot: second };
  }

  return { ownerOrgId: null, folderRoot: first };
}

export function isSensitiveFolderRoot(folderRoot: string): boolean {
  return SENSITIVE_FOLDER_ROOTS.has(folderRoot.toLowerCase());
}

export function isSensitiveStorageKey(
  key: string,
  callerOrgId: string,
): boolean {
  return isSensitiveFolderRoot(parseStorageKey(key, callerOrgId).folderRoot);
}

/**
 * A key naming an organisation other than the caller's is refused here rather
 * than trusted and handed to the object store, which would read a foreign
 * tenant's bytes out of the caller's own bucket.
 */
export function isForeignOrgKey(key: string, callerOrgId: string): boolean {
  const { ownerOrgId } = parseStorageKey(key, callerOrgId);
  return ownerOrgId !== null && ownerOrgId !== callerOrgId;
}

/**
 * Shape check for an object key, independent of any storage client. It lives
 * beside the tenant predicates because every ingestion route that stores a key
 * the client chose has to run both, and a route that can only reach the check
 * through `StorageService` ends up skipping it.
 */
export function isWellFormedStorageKey(key: string): boolean {
  if (!key || key.length > 1024) return false;
  if (key.includes("..") || key.includes("\\") || key.startsWith("/")) return false;
  if (key.includes("\0")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(key) || key.includes("?") || key.includes("#"))
    return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(key);
}

/**
 * The predicate every key-ingestion route owes its tenant: a stored key must be
 * well formed AND name the caller's own organisation. Storing an unconstrained
 * client string turns the row into a pointer at whatever object the client
 * spelled, and the read path then authorises the ROW and signs the key.
 *
 * `parseStorageKey` rather than a bare `startsWith` because a region that sets
 * `R2_KEY_PREFIX` shifts the organisation one segment right, and a prefix check
 * would reject that tenant's own legitimate keys.
 */
export function isOwnOrgStorageKey(key: string, orgId: string): boolean {
  if (!isWellFormedStorageKey(key)) return false;
  return parseStorageKey(key, orgId).ownerOrgId === orgId;
}

export function sanitizeFileName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(/[^a-zA-Z0-9.-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[.\-]+/, "")
    .replace(/[.\-]+$/, "")
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : "file";
}

/**
 * A client-chosen folder stays one segment. Letting a slash through would let
 * the caller pick where in the tenant's prefix its object lands, and the folder
 * root is what the sensitive-folder permission gate reads.
 */
export function sanitizeFolder(folder: string): string {
  const cleaned = folder
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.\-]+/, "")
    .replace(/[.\-]+$/, "")
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : "uploads";
}
