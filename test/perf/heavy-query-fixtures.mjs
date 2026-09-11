export const LARGE_ORG = "aaaaaaaa-1111-0000-0000-000000000001";
export const MID_ORG = "aaaaaaaa-1111-0000-0000-000000000003";
export const SMALL_ORG = "aaaaaaaa-1111-0000-0000-000000000002";
export const TINY_ORG = "aaaaaaaa-1111-0000-0000-000000000004";

export const ORG_PROFILES = [
  { id: LARGE_ORG, label: "large", members: 500, events: 60000, notifications: 240000, chunks: 12000 },
  { id: MID_ORG, label: "mid", members: 60, events: 6000, notifications: 24000, chunks: 1200 },
  { id: SMALL_ORG, label: "small", members: 8, events: 600, notifications: 2400, chunks: 120 },
  { id: TINY_ORG, label: "tiny", members: 10, events: 1200, notifications: 4800, chunks: 240 },
];

/**
 * A scratch target is asserted by name and by inequality with every live URL, because
 * "point SCRATCH_DATABASE_URL somewhere safe" is advice and this script writes ~350k rows.
 */
export function assertScratchTarget(scratchUrl, liveUrls) {
  let database;
  try {
    database = new URL(scratchUrl).pathname.replace(/^\//, "").split("?")[0];
  } catch {
    return { ok: false, reason: "target URL is not parseable" };
  }
  if (!/scratch/i.test(database))
    return { ok: false, reason: `refusing database "${database}" — its name must contain "scratch"` };
  for (const live of liveUrls)
    if (live && live === scratchUrl)
      return { ok: false, reason: "target URL is identical to a live database URL" };
  return { ok: true, database };
}

export function scaled(n, scale) {
  return Math.max(1, Math.round(n * scale));
}
