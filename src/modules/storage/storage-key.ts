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
 * Two key shapes are live. Everything minted since organisation scoping is
 * `<orgId>/<folder>/…`; legacy rows still hold `<folder>/…` with no organisation
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
