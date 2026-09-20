import { resolvePeopleByName } from "../../../../directory/person-seam";
import type { Db } from "../../../../../db/drizzle.module";
import type { AmbiguousCandidate } from "../../registry/ask-os-tool.types";

export type AttendeeResolution = {
  resolved: string[];
  unresolved: string[];
  firstAmbiguous: { needle: string; candidates: readonly AmbiguousCandidate[] } | null;
};

export async function resolveAttendeeNames(
  db: Db,
  orgId: string,
  names: readonly string[],
): Promise<AttendeeResolution> {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  let firstAmbiguous: AttendeeResolution["firstAmbiguous"] = null;

  if (names.length === 0) return { resolved, unresolved, firstAmbiguous };

  const resolutions = await resolvePeopleByName(db, orgId, names);

  for (const [needle, resolution] of resolutions) {
    if (resolution.status === "resolved") {
      resolved.push(resolution.userId);
    } else if (resolution.status === "ambiguous") {
      if (firstAmbiguous === null)
        firstAmbiguous = { needle, candidates: resolution.candidates };
    } else {
      unresolved.push(needle);
    }
  }

  return { resolved, unresolved, firstAmbiguous };
}
