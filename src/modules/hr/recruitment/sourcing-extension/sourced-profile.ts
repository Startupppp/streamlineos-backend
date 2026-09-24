/**
 * Turning a page a recruiter is looking at into something that can be matched
 * against candidates already in the org.
 *
 * Everything here is pure. The identity decisions a sourcing extension makes
 * are the ones with teeth — merging two people is far worse than saving the
 * same person twice — so they are settled in a file with no database in it and
 * pinned by `sourced-profile.spec.ts`.
 */

/** Platforms whose pages the extension knows how to read. */
export const SOURCING_PLATFORMS = ["linkedin", "naukri", "indeed", "github", "other"] as const;
export type SourcingPlatform = (typeof SOURCING_PLATFORMS)[number];

/**
 * Host suffixes, matched against the registrable part of the hostname.
 *
 * Suffix rather than equality because the same profile is served from
 * `www.linkedin.com`, `in.linkedin.com` and `resdex.naukri.com`, and a
 * recruiter on any of them is on the same platform.
 */
const PLATFORM_HOSTS: ReadonlyArray<readonly [SourcingPlatform, string]> = [
  ["linkedin", "linkedin.com"],
  ["naukri", "naukri.com"],
  ["indeed", "indeed.com"],
  ["github", "github.com"],
];

/**
 * Query parameters that describe how a recruiter arrived rather than who they
 * are looking at.
 *
 * This is a deny-list, not an allow-list, and deliberately so. Dropping every
 * parameter would be tidier, but a Naukri profile is identified by its query
 * string — `?id=…` — so a blanket strip would give thousands of distinct people
 * one normalised URL and dedupe them into a single candidate record. Removing
 * only what is known to be noise fails in the safe direction: the worst case is
 * the same person saved twice, which a recruiter can see and merge.
 */
const TRACKING_PARAMS = new Set([
  "originalsubdomain",
  "origintoken",
  "lipi",
  "licu",
  "midtoken",
  "midsig",
  "trk",
  "trkemail",
  "refid",
  "trackingid",
  "src",
  "source",
  "ref",
  "referer",
  "referrer",
  "fromsearch",
  "position",
  "pagenum",
  "eblowmatch",
  "sessionid",
  "gclid",
  "fbclid",
]);

function isTracking(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAMS.has(lower);
}

export interface NormalisedProfileUrl {
  /** What is stored and compared. */
  url: string;
  platform: SourcingPlatform;
}

/**
 * The comparable form of a profile URL, or null if it is not one we will store.
 *
 * Only http(s) survives. A `javascript:` or `data:` URL reaching a stored field
 * that the candidate screen later renders as a link is the shape of a stored
 * XSS, and no sourcing flow has a use for one.
 */
export function normaliseProfileUrl(raw: string): NormalisedProfileUrl | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed.startsWith("www.") ? `https://${trimmed}` : trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!host) return null;

  const platform =
    PLATFORM_HOSTS.find(([, suffix]) => host === suffix || host.endsWith(`.${suffix}`))?.[0] ??
    "other";

  // Case is not identity in a host; it can be in a path, so the path is left alone.
  const path = parsed.pathname.replace(/\/+$/, "");

  const params = [...parsed.searchParams.entries()]
    .filter(([name]) => !isTracking(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = new URLSearchParams(params).toString();

  // The fragment never identifies a profile, and `#` survives a copy-paste.
  return { url: `https://${host}${path}${query ? `?${query}` : ""}`, platform };
}

/**
 * Where a sourced candidate came from, in the vocabulary the rest of
 * recruitment already uses.
 *
 * `DIRECT` rather than a new `SOURCED_*` value: `CANDIDATE_SOURCES` is the same
 * list the candidate filter and the two intake sheets render, and a value only
 * this flow writes would show up in the list as a source the filter cannot
 * select and the sheets cannot set.
 */
export function candidateSourceFor(platform: SourcingPlatform): string {
  switch (platform) {
    case "linkedin":
      return "LINKEDIN";
    case "naukri":
      return "NAUKRI";
    case "indeed":
      return "INDEED";
    case "github":
    case "other":
      return "DIRECT";
  }
}

export interface SplitName {
  firstName: string;
  lastName: string;
}

/**
 * A display name split into the two columns `candidates` actually has.
 *
 * `last_name` is NOT NULL, so a mononym still has to produce something. It
 * repeats the first name rather than writing a placeholder: a candidate screen
 * showing "Prince —" or "Prince (unknown)" is worse than showing "Prince
 * Prince", which at least reads as a name the recruiter can correct.
 */
export function splitDisplayName(full: string): SplitName | null {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;

  const first = parts[0];
  const rest = parts.slice(1).join(" ");
  return { firstName: first.slice(0, 100), lastName: (rest || first).slice(0, 100) };
}

/**
 * The note recorded against the candidate saying where this came from.
 *
 * Written in full sentences with the platform and the URL because it is read
 * months later by someone deciding whether an approach is a re-approach.
 */
export function sourcingNote(input: {
  platform: SourcingPlatform;
  profileUrl: string;
  headline: string | null;
  recruiterNote: string | null;
}): string {
  const where = input.platform === "other" ? "a web profile" : `a ${input.platform} profile`;
  const lines = [`Sourced from ${where}: ${input.profileUrl}`];
  if (input.headline) lines.push(`Listing headline: ${input.headline}`);
  if (input.recruiterNote) lines.push(input.recruiterNote);
  return lines.join("\n");
}
