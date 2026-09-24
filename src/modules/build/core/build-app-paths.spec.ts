import {
  buildCycleListHref,
  buildFeedbucketHref,
  buildIncidentHref,
  buildProjectHref,
  buildReleaseListHref,
  buildTicketBoardHref,
  buildTicketHref,
  buildTicketKey,
} from "./build-app-paths";

describe("build-app-paths", () => {
  it("builds the canonical project board href", () => {
    expect(buildProjectHref(7)).toBe("/build/7");
  });

  it("formats a ticket key from project key + number", () => {
    expect(buildTicketKey("STRE", 29)).toBe("STRE-29");
    expect(buildTicketKey(null, 29)).toBe("29");
  });

  it("builds a ticket detail href with an encoded key", () => {
    expect(buildTicketHref(1, "STRE-29")).toBe("/build/1/tickets/STRE-29");
    expect(buildTicketHref(1, "STRE-29", 44)).toBe(
      "/build/1/tickets/STRE-29?comment=44",
    );
  });

  it("builds a board deep-link when only the numeric ticket id is known", () => {
    expect(buildTicketBoardHref(1, 900)).toBe("/build/1?ticket=900");
  });

  it("builds project-scoped list and detail hrefs without a /projects segment", () => {
    expect(buildCycleListHref(3)).toBe("/build/3/cycles");
    expect(buildReleaseListHref(3)).toBe("/build/3/releases");
    expect(buildIncidentHref(3, 9)).toBe("/build/3/incidents/9");
  });

  it("the iteration list href targets the cycles route that exists in the frontend, never the retired /sprints route that 404s", () => {
    expect(buildCycleListHref(3)).not.toContain("/sprints");
  });

  it("builds feedbucket hrefs under /build", () => {
    expect(buildFeedbucketHref(5, 12)).toBe("/build/5/feedbucket/12");
    expect(buildFeedbucketHref(null, 12)).toBe("/build");
  });
});
