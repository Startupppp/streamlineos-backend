import { compileQuery } from "../query/query-compiler";
import type { QueryDescription } from "../query/query-description";
import {
  isSharedWith,
  permissionGoverning,
  ReportNotVisibleError,
  requesterForViewer,
  type SavedReport,
  type ViewerAccess,
} from "./saved-report";

const DESCRIPTION: QueryDescription = {
  entity: "deals",
  select: ["name", "value"],
  aggregations: [{ of: "sum", field: "value", as: "total" }],
};

const REPORT: SavedReport = {
  reportId: "rep-1",
  orgId: "org-acme",
  name: "Pipeline by stage",
  description: DESCRIPTION,
  ownerUserId: "author",
  audience: "organisation",
  sharedWithUserIds: [],
};

const WIDE: ViewerAccess = { scope: "all", mayUseReports: true };
const NARROW: ViewerAccess = { scope: "own", mayUseReports: true };

/*
  Ticket 12. The criterion is "a viewer with narrower scope sees fewer rows,
  proven by test with two users of differing scope", so the test compiles the
  same saved report for two people and shows the statements differ in the way
  that changes the answer — not that a function was called with the right
  argument.
*/
describe("a shared report is answered for whoever is asking", () => {
  it("gives a narrower viewer a narrower query than the author's", () => {
    const author = compileQuery(
      DESCRIPTION,
      requesterForViewer(REPORT, { userId: "author", orgId: "org-acme" }, WIDE),
    );
    const colleague = compileQuery(
      DESCRIPTION,
      requesterForViewer(REPORT, { userId: "rep", orgId: "org-acme" }, NARROW),
    );

    // The author's statement constrains by organisation alone.
    expect(author.text).toContain('"t0"."org_id" = $1');
    expect(author.text).not.toContain("assigned_to_id");

    // The colleague's constrains by ownership as well, and to THEIR id.
    expect(colleague.text).toContain('"t0"."assigned_to_id" = $2');
    expect(colleague.params).toContain("rep");
    expect(colleague.params).not.toContain("author");
  });

  it("has no field in which a saved report could carry the author's rows", () => {
    /*
      The structural half of "the author's results are never cached and served
      to a viewer". Not "the cache is invalidated correctly" — there is nowhere
      to put a result, so the mistake cannot be made. A caller that smuggles one
      in finds it ignored, exactly as a smuggled orgId is on a description.
     */
    const smuggled = {
      ...REPORT,
      rows: [{ name: "somebody else's deal", total: 999_999 }],
      results: [{ name: "and again" }],
      cachedAt: new Date(),
    } as unknown as SavedReport;

    const requester = requesterForViewer(smuggled, { userId: "rep", orgId: "org-acme" }, NARROW);
    const compiled = compileQuery(smuggled.description, requester);

    expect(JSON.stringify(compiled)).not.toContain("somebody else's deal");
    expect(Object.keys(requester).sort()).toEqual(["orgId", "scope", "teamIds", "userId"]);
  });

  it("resolves scope from the entity's permission, not from the reports one", () => {
    /*
      The second-most-common form of the leak: a viewer with wide reporting
      rights and narrow deal rights reads every deal. The scope has to come from
      the key that governs the RECORDS.
    */
    expect(permissionGoverning(REPORT)).toBe("crm:deals:read");
    expect(permissionGoverning({ ...REPORT, description: { entity: "parties" } })).toBe(
      "party:parties:view",
    );
  });
});

describe("a viewer who should not see it, does not", () => {
  it("refuses a viewer in another organisation without admitting the report exists", () => {
    try {
      requesterForViewer(REPORT, { userId: "outsider", orgId: "org-other" }, WIDE);
      throw new Error("should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(ReportNotVisibleError);
      expect((error as ReportNotVisibleError).refusal).toBe("not-in-organisation");
      // "does not exist", not "you may not see it" — the second confirms it does.
      expect((error as Error).message).toBe("This report does not exist.");
    }
  });

  it("refuses somebody the report was never shared with", () => {
    const priv: SavedReport = { ...REPORT, audience: "private" };
    expect(() =>
      requesterForViewer(priv, { userId: "rep", orgId: "org-acme" }, WIDE),
    ).toThrow(/has not been shared with you/);
    // ...but the author still opens their own private report.
    expect(() =>
      requesterForViewer(priv, { userId: "author", orgId: "org-acme" }, WIDE),
    ).not.toThrow();
  });

  it("honours a named list rather than treating any colleague as shared-with", () => {
    const named: SavedReport = {
      ...REPORT,
      audience: "named",
      sharedWithUserIds: ["invited"],
    };
    expect(isSharedWith(named, { userId: "invited", orgId: "org-acme" })).toBe(true);
    expect(isSharedWith(named, { userId: "uninvited", orgId: "org-acme" })).toBe(false);
    // Membership of the same organisation is not membership of the list.
    expect(isSharedWith(named, { userId: "invited", orgId: "org-other" })).toBe(false);
  });

  it("tells somebody who lost access that they lost it, rather than showing an empty report", () => {
    /*
      The fourth criterion, and the reason it is a refusal here while the
      compiler happily turns `none` into a query returning nothing: an empty
      table reads as "there were no deals", which is a false claim about the
      business that somebody will repeat in a meeting.
    */
    try {
      requesterForViewer(REPORT, { userId: "rep", orgId: "org-acme" }, { scope: "none", mayUseReports: true });
      throw new Error("should have refused");
    } catch (error) {
      expect((error as ReportNotVisibleError).refusal).toBe("no-access-to-the-underlying-records");
      expect((error as Error).message).toMatch(/no longer have access/);
    }
  });

  it("refuses somebody who may see deals but may not use reports", () => {
    expect(() =>
      requesterForViewer(REPORT, { userId: "rep", orgId: "org-acme" }, { scope: "all", mayUseReports: false }),
    ).toThrow(/do not have access to reports/);
  });
});

describe("nothing about the author reaches the viewer's query", () => {
  it("cannot be passed the author's access even deliberately", () => {
    /*
      Ticket 12 in one assertion. `requesterForViewer` takes the viewer and the
      viewer's access; there is no parameter through which an author's could
      arrive, so "re-evaluates against the viewer" is the only thing the
      signature permits.
    */
    expect(requesterForViewer.length).toBe(3);

    const requester = requesterForViewer(REPORT, { userId: "rep", orgId: "org-acme" }, NARROW);
    expect(requester.userId).toBe("rep");
    expect(requester.scope).toBe("own");
  });

  it("carries the viewer's own teams for team scope", () => {
    const requester = requesterForViewer(
      REPORT,
      { userId: "lead", orgId: "org-acme" },
      { scope: "team", mayUseReports: true, teamIds: ["dept-north"] },
    );
    expect(requester.teamIds).toEqual(["dept-north"]);
  });
});
