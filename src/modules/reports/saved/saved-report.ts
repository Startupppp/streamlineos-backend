import type { DataScope } from "../../access/access.types";
import { entityDefinition } from "../query/query-graph";
import { QueryDescriptionError } from "../query/query-errors";
import type { QueryDescription } from "../query/query-description";
import type { Requester } from "../query/query-compiler";

/**
 * A report somebody saved, and what happens when they share it.
 *
 * Phase 5, tickets 12 and 13. The ticket for 12 opens "this is the leak everyone
 * builds first and discovers second", and it is worth being precise about what
 * the leak actually is, because it is not carelessness — it is the natural
 * consequence of a reasonable-sounding decision.
 *
 * The reasonable-sounding decision is to make sharing cheap by sharing the
 * ANSWER. The author ran the report, the rows are sitting there, and handing a
 * colleague the same rows is one row in a join table and no recomputation. It is
 * also a complete bypass of every access rule in the product: the author's scope
 * ran the query, and the viewer receives what the author was allowed to see.
 *
 * So a saved report here is a QUESTION and never an answer. That is enforced by
 * the type: there is no field on `SavedReport` in which results could be stored,
 * which is the same technique `QueryDescription` uses for tenancy. The third
 * criterion — "the author's results are never cached and served to a viewer" —
 * is then not a rule anybody has to follow.
 *
 * What is shared is the right to ASK the question. The answer is computed
 * against the viewer, every time, from the viewer's own scope at that moment.
 */

/**
 * Who may open a shared report.
 *
 * Deliberately a small closed set rather than an ACL of arbitrary rules. A
 * sharing model rich enough to be interesting is a sharing model nobody can
 * reason about, and this one has to be reasoned about correctly by the person
 * clicking share, not by us.
 */
export const SHARE_AUDIENCES = ["private", "named", "organisation"] as const;
export type ShareAudience = (typeof SHARE_AUDIENCES)[number];

export interface SavedReport {
  readonly reportId: string;
  readonly orgId: string;
  readonly name: string;
  /** The question. Compiled fresh for whoever is asking it. */
  readonly description: QueryDescription;
  readonly ownerUserId: string;
  readonly audience: ShareAudience;
  /** Only meaningful for `named`; empty otherwise. */
  readonly sharedWithUserIds: readonly string[];
}

/**
 * What the access service says about one viewer, for one permission key.
 *
 * A port rather than a dependency on `AccessService`, so the rules below are
 * arguable without a database — and so the test can put a viewer with `own`
 * scope beside a viewer with `all` scope and show the rows differ, which is
 * ticket 12's second criterion stated exactly.
 */
export interface ViewerAccess {
  /** Resolved for the ENTITY's permission, not for `crm:reports:view`. */
  readonly scope: DataScope;
  /** Whether the reports surface itself is open to them at all. */
  readonly mayUseReports: boolean;
  readonly teamIds?: readonly string[];
}

export interface Viewer {
  readonly userId: string;
  readonly orgId: string;
}

export type ViewRefusal =
  | "not-in-organisation"
  | "not-shared-with-you"
  | "reports-not-permitted"
  | "no-access-to-the-underlying-records";

export class ReportNotVisibleError extends Error {
  constructor(readonly refusal: ViewRefusal, message: string) {
    super(message);
    this.name = "ReportNotVisibleError";
  }
}

/** Whether this viewer is one of the people the report was shared with. */
export function isSharedWith(report: SavedReport, viewer: Viewer): boolean {
  if (report.orgId !== viewer.orgId) return false;
  if (report.ownerUserId === viewer.userId) return true;
  switch (report.audience) {
    case "private":
      return false;
    case "named":
      return report.sharedWithUserIds.includes(viewer.userId);
    case "organisation":
      return true;
  }
}

/**
 * The requester a shared report is compiled for.
 *
 * This function is the whole of ticket 12, and its signature says why: it takes
 * the report and the VIEWER's access, and there is no parameter through which
 * the author's could arrive. Whatever the author could see is not an input to
 * what the viewer gets.
 *
 * The ordering of the refusals matters. Being outside the organisation is
 * reported before not being shared with, because the second answer leaks the
 * existence of a report in someone else's tenant. Everything after that is
 * within one organisation, where saying "this was not shared with you" is
 * information the person is entitled to.
 */
export function requesterForViewer(
  report: SavedReport,
  viewer: Viewer,
  access: ViewerAccess,
): Requester {
  if (report.orgId !== viewer.orgId)
    throw new ReportNotVisibleError("not-in-organisation", "This report does not exist.");

  if (!isSharedWith(report, viewer))
    throw new ReportNotVisibleError(
      "not-shared-with-you",
      "This report has not been shared with you.",
    );

  if (!access.mayUseReports)
    throw new ReportNotVisibleError(
      "reports-not-permitted",
      "You do not have access to reports in this organisation.",
    );

  /*
    The fourth criterion: somebody who has lost access to the underlying data
    "sees nothing rather than a stale result".

    Two things make that true and they are different. Nothing is stored, so
    there is no stale result available to serve — that is the type's doing. And a
    scope of `none` is refused here rather than compiled, which is a deliberate
    divergence from the compiler's own treatment of `none`.

    The compiler turns `none` into a query returning zero rows, which is right
    for a compiler: "may see nothing" is a legitimate answer and an empty result
    is its honest form. But a person opening a report they used to be able to
    read, and being shown an empty table, will read that as "there are no deals
    this quarter" — the most damaging possible misunderstanding, and one they
    would act on. Being told they no longer have access is the same information
    without the false reading.
  */
  if (access.scope === "none")
    throw new ReportNotVisibleError(
      "no-access-to-the-underlying-records",
      "You no longer have access to the records this report is built on.",
    );

  return {
    orgId: viewer.orgId,
    userId: viewer.userId,
    scope: access.scope,
    teamIds: access.teamIds,
  };
}

/**
 * Which permission key governs a report, so a caller knows what to resolve.
 *
 * Reports are gated by the entity they read, not by the reports module. A caller
 * that resolved scope from `crm:reports:view` would give a viewer with wide
 * reporting rights and narrow deal rights the wide answer, which is the leak in
 * its second-most-common form.
 */
export function permissionGoverning(report: SavedReport): string {
  const entity = entityDefinition(report.description.entity);
  if (!entity)
    throw new QueryDescriptionError(
      `"${report.description.entity}" is not a reportable entity`,
    );
  return entity.permission;
}
