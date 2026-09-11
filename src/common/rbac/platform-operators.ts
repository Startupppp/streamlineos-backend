/**
 * Who the vendor's own staff are, as far as authorization is concerned.
 *
 * `blog_posts` and `blog_categories` are deliberately global — the vendor's
 * marketing site, one row set for the whole platform, no `org_id` column. Their
 * permission keys nonetheless sat in the per-organization catalog, and
 * `computeUserPermissions` short-circuits every org OWNER and ORG_ADMIN to the
 * whole catalog, so each customer's administrator could rewrite and hard-delete
 * the vendor's published posts. The predicate was never the problem: a global
 * table has no tenant to bind. The gate was.
 *
 * So these keys leave the per-organization catalog entirely
 * (`PLATFORM_ONLY_PERMISSION_KEYS` in `grantability.ts` makes them
 * non-delegable, which drops them from every grant, delegation and ownership
 * expansion) and are conferred only by standing that no tenant role can reach:
 * membership of this allowlist, which is deployment configuration rather than
 * organization data.
 *
 * Unset means nobody, which is the correct default for a surface only the
 * vendor should hold.
 */
export function parsePlatformAdminUserIds(raw: string | undefined): ReadonlySet<string> {
  if (!raw) return new Set<string>();
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

let cached: ReadonlySet<string> | null = null;
let cachedFrom: string | undefined;

export function platformAdminUserIds(): ReadonlySet<string> {
  const raw = process.env.PLATFORM_ADMIN_USER_IDS;
  if (cached === null || cachedFrom !== raw) {
    cached = parsePlatformAdminUserIds(raw);
    cachedFrom = raw;
  }
  return cached;
}

export function isPlatformAdmin(userId: string): boolean {
  return platformAdminUserIds().has(userId);
}
