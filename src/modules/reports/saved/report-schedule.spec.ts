import type { SavedReport, ViewerAccess } from "./saved-report";
import { planDelivery, scopeNote, type ReportSchedule } from "./report-schedule";

const REPORT: SavedReport = {
  reportId: "rep-1",
  orgId: "org-acme",
  name: "Pipeline",
  description: { entity: "deals" },
  ownerUserId: "author",
  audience: "organisation",
  sharedWithUserIds: [],
};

const SCHEDULE: ReportSchedule = {
  scheduleId: "sch-1",
  reportId: "rep-1",
  orgId: "org-acme",
  cadence: "weekly",
  hour: 8,
  createdByUserId: "author",
  recipientUserIds: ["author", "rep", "leaver"],
  active: true,
};

const access = (entries: Record<string, ViewerAccess>) => new Map(Object.entries(entries));

/*
  Scheduling is where ticket 12 goes to die, because there is no viewer present
  when a schedule fires — only an author who set it up weeks ago. These assert
  that each recipient is evaluated as themselves.
*/
describe("a scheduled report is evaluated per recipient, not once for the author", () => {
  it("gives each recipient their own scope rather than the author's", () => {
    const plan = planDelivery(
      SCHEDULE,
      REPORT,
      access({
        author: { scope: "all", mayUseReports: true },
        rep: { scope: "own", mayUseReports: true },
        leaver: { scope: "all", mayUseReports: true },
      }),
    );

    const sends = plan.filter((p) => p.kind === "send");
    expect(sends).toHaveLength(3);
    expect(sends.map((s) => ("scopeUsed" in s ? s.scopeUsed : null))).toEqual([
      "all",
      "own",
      "all",
    ]);
  });

  it("takes no author access at all, so it cannot accidentally use it", () => {
    /*
      The structural half. `planDelivery` receives the schedule, the report and a
      map keyed by recipient — there is no parameter through which the author's
      resolved access could arrive, so "runs as the author" is not an
      implementation mistake available to be made.
    */
    expect(planDelivery.length).toBe(3);
  });

  it("drops a recipient who has left the organisation, without mailing them", () => {
    const plan = planDelivery(
      SCHEDULE,
      REPORT,
      access({
        author: { scope: "all", mayUseReports: true },
        rep: { scope: "own", mayUseReports: true },
      }),
    );
    const leaver = plan.find((p) => p.userId === "leaver")!;
    expect(leaver.kind).toBe("drop");
    // Not "tell-them": telling a leaver means mailing a former employee about
    // their old employer's data, which is worse than the confusion it prevents.
  });

  it("stops delivering when the author narrows who the report is shared with", () => {
    /*
      Sharing is re-evaluated at fire time, not at schedule creation. Otherwise
      revoking access is cosmetic: the screen stops showing it and the mail keeps
      arriving every Monday.
    */
    const narrowed: SavedReport = { ...REPORT, audience: "named", sharedWithUserIds: ["author"] };
    const plan = planDelivery(
      SCHEDULE,
      narrowed,
      access({
        author: { scope: "all", mayUseReports: true },
        rep: { scope: "own", mayUseReports: true },
        leaver: { scope: "all", mayUseReports: true },
      }),
    );

    expect(plan.find((p) => p.userId === "author")!.kind).toBe("send");
    const rep = plan.find((p) => p.userId === "rep")!;
    expect(rep.kind).toBe("tell-them-access-changed");
    expect("why" in rep && rep.why).toMatch(/no longer shared/);
  });

  it("tells a recipient who lost record access rather than sending an empty table", () => {
    const plan = planDelivery(
      SCHEDULE,
      REPORT,
      access({
        author: { scope: "all", mayUseReports: true },
        rep: { scope: "none", mayUseReports: true },
        leaver: { scope: "all", mayUseReports: true },
      }),
    );
    const rep = plan.find((p) => p.userId === "rep")!;
    expect(rep.kind).toBe("tell-them-access-changed");
    // An empty scheduled report reads as "no deals this week" and gets repeated
    // in a meeting. Saying why is the same information without the false claim.
    expect("why" in rep && rep.why).toMatch(/no longer have access to the records/);
  });

  it("sends nothing at all once a schedule is paused", () => {
    expect(
      planDelivery({ ...SCHEDULE, active: false }, REPORT, access({ author: { scope: "all", mayUseReports: true } })),
    ).toEqual([]);
  });
});

describe("a recipient is told what their number covers", () => {
  it("distinguishes a personal total from the organisation's", () => {
    /*
      Once two viewers legitimately see different totals, a total without its
      scope is ambiguous — and the person quoting it in a meeting will not know
      which one they have.
    */
    expect(scopeNote("own")).toMatch(/your own records/);
    expect(scopeNote("team")).toMatch(/your team/);
    expect(scopeNote("all")).toMatch(/every record/);
    expect(new Set(["own", "team", "all"].map(scopeNote)).size).toBe(3);
  });
});
