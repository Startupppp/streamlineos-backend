import {
  objectAddressableRoutes,
  paramStem,
  pluralCandidates,
  precedingSegment,
  resolveTable,
  resolveTables,
  type TableRef,
} from "./live/param-tables";
import {
  bindParam,
  buildPath,
  disambiguate,
  isDisclosure,
  isFinding,
  planRoutes,
  score,
  unpopulatedTargets,
} from "./live/probe-plan";

/**
 * The rule the live sweep grades by, tested where it can be tested cheaply.
 *
 * `bola-live-cross-tenant.seeded-e2e-spec.ts` needs a booted API and a seeded two-tenant database.
 * This file needs neither, and it pins the two decisions that decide whether that run means
 * anything: what counts as a finding, and what counts as unprobeable.
 */

const KNOWN = new Map<string, TableRef>([
  ["public.inv_products", { schema: "public", name: "inv_products", pk: "id", orgColumn: "org_id" }],
  ["public.kb_articles", { schema: "public", name: "kb_articles", pk: "id", orgColumn: "org_id" }],
  ["public.hr_people", { schema: "public", name: "hr_people", pk: "id", orgColumn: "org_id" }],
  ["build.projects", { schema: "build", name: "projects", pk: "id", orgColumn: "org_id" }],
  ["build.tickets", { schema: "build", name: "tickets", pk: "id", orgColumn: "org_id" }],
]);
const POPULATED = new Set(["public.inv_products", "build.projects", "build.tickets", "public.hr_people"]);

function route(path: string, params: string[], verb = "GET") {
  return {
    file: "src/x.controller.ts",
    controllerClass: "XController",
    handler: "h",
    verb,
    path,
    pathParams: params,
    classification: "permissioned" as const,
    permissionKeys: [],
    line: 1,
    signature: "",
    body: "",
    serviceCalls: [],
    injected: new Map<string, string>(),
  };
}

describe("BOLA live probe — how a response is graded", () => {
  it("grades a cross-tenant 404 as the pass the ticket asks for", () => {
    expect(score(200, 404).verdict).toBe("PASS");
  });

  it("grades a cross-tenant 403 as a finding, because it confirms the record exists", () => {
    const scored = score(200, 403);
    expect(scored.verdict).toBe("EXISTENCE-ORACLE");
    expect(isFinding(scored.verdict)).toBe(true);
    expect(scored.detail).toContain("confirms the record exists");
  });

  it("grades a cross-tenant 2xx as a leak", () => {
    for (const status of [200, 201, 202, 204]) expect(score(200, status).verdict).toBe("LEAK");
  });

  it("grades a cross-tenant 5xx as a finding", () => {
    expect(score(200, 500).verdict).toBe("SERVER-ERROR");
    expect(isFinding(score(200, 503).verdict)).toBe(true);
  });

  it("leaves an ambiguous status inconclusive rather than calling it a pass", () => {
    for (const status of [400, 401, 409, 422, 429]) expect(score(200, status).verdict).toBe("INCONCLUSIVE");
  });

  /**
   * The property that makes the whole sweep honest. Without it a run in which every request failed
   * would report 404 everywhere and score as clean.
   */
  it("refuses to score a route whose own-tenant control did not succeed", () => {
    for (const control of [400, 401, 403, 404, 409, 500]) {
      const scored = score(control, 404);
      expect(scored.verdict).toBe("UNPROBEABLE");
      expect(scored.detail).toContain(`control answered ${String(control)}`);
    }
    expect(score(null, 404).verdict).toBe("UNPROBEABLE");
    expect(score(200, null).verdict).toBe("UNPROBEABLE");
  });

  it("keeps a 2xx a LEAK when an id belonging to nobody is refused", () => {
    const raw = score(200, 200);
    const settled = disambiguate(raw, 200, 404);
    expect(settled.verdict).toBe("LEAK");
    expect(isDisclosure(settled.verdict)).toBe(true);
  });

  it("demotes a 2xx to NO-404 when an id belonging to nobody answers identically", () => {
    const settled = disambiguate(score(200, 200), 200, 200);
    expect(settled.verdict).toBe("NO-404");
    expect(isDisclosure(settled.verdict)).toBe(false);
    expect(isFinding(settled.verdict)).toBe(true);
    expect(settled.detail).toContain("never resolves the path object");
  });

  it("demotes a 403 to NO-404 only when an id belonging to nobody is also 403", () => {
    expect(disambiguate(score(200, 403), 403, 403).verdict).toBe("NO-404");
    expect(disambiguate(score(200, 403), 403, 404).verdict).toBe("EXISTENCE-ORACLE");
  });

  it("never demotes a pass, a server error or an unmade third request", () => {
    expect(disambiguate(score(200, 404), 404, 404).verdict).toBe("PASS");
    expect(disambiguate(score(200, 500), 500, 500).verdict).toBe("SERVER-ERROR");
    expect(disambiguate(score(200, 200), 200, null).verdict).toBe("LEAK");
  });

  it("carries the control's own body into the unprobeable reason", () => {
    expect(score(400, 404, "sortBy must be one of").detail).toContain("sortBy must be one of");
  });
});

describe("BOLA live probe — binding a path parameter to a real object", () => {
  it("derives a stem and plural forms from the parameter name", () => {
    expect(paramStem("pmWorkspaceId")).toBe("pm_workspace");
    expect(paramStem("projectId")).toBe("project");
    expect(pluralCandidates("project")).toContain("projects");
    expect(pluralCandidates("policy")).toContain("policies");
    expect(pluralCandidates("person")).toContain("people");
  });

  it("reads the collection segment in front of the parameter", () => {
    expect(precedingSegment("/build/:projectId/tickets/:ticketId", "ticketId")).toBe("tickets");
    expect(precedingSegment("/build/:projectId", "projectId")).toBe("build");
  });

  it("finds a table behind a module prefix", () => {
    expect(resolveTable(["products"], KNOWN)?.name).toBe("inv_products");
    expect(resolveTable(["nothing_here"], KNOWN)).toBeNull();
  });

  it("binds a parameter whose table holds rows for the source tenant", () => {
    const binding = bindParam(route("/build/:projectId", ["projectId"]), "projectId", KNOWN, POPULATED);
    expect(binding.kind).toBe("table");
    if (binding.kind === "table") {
      expect(binding.table).toEqual(KNOWN.get("build.projects"));
      expect(binding.tables[0]).toEqual(KNOWN.get("build.projects"));
    }
  });

  /**
   * THE MIS-BINDING THIS RANKING EXISTS TO STOP, pinned as a test rather than as a comment.
   *
   * `populated` used to score 10,000 against a hint's 100, so one unrelated row in the wrong table
   * beat the table the route's own path names. Measured on the previous full run, that is what 252
   * of 355 own-tenant control-404s looked like: `GET /csat/:surveyId` bound `public.pulse_surveys`
   * because `public.csat_surveys` was empty. With the hint dominant the empty-but-named table is
   * offered FIRST and the populated-but-unnamed one becomes the fallback — the sweep tries both.
   */
  it("prefers the table the route's own path names over one that merely holds a row", () => {
    const surveys = new Map<string, TableRef>([
      ["public.csat_surveys", { schema: "public", name: "csat_surveys", pk: "id", orgColumn: "org_id" }],
      ["public.pulse_surveys", { schema: "public", name: "pulse_surveys", pk: "id", orgColumn: "org_id" }],
    ]);
    const onlyPulseHasRows = new Set(["public.pulse_surveys"]);
    const ranked = resolveTables(["surveys"], surveys, onlyPulseHasRows, ["csat"]);
    expect(ranked.map((t) => t.name)).toEqual(["csat_surveys", "pulse_surveys"]);
    expect(resolveTable(["surveys"], surveys, onlyPulseHasRows, ["csat"])?.name).toBe("csat_surveys");
  });

  it("offers a populated fallback table so a wrong first guess is recoverable", () => {
    const jobs = new Map<string, TableRef>([
      ["public.ai_jobs", { schema: "public", name: "ai_jobs", pk: "id", orgColumn: "org_id" }],
      ["public.job_requisitions", { schema: "public", name: "job_requisitions", pk: "id", orgColumn: "org_id" }],
    ]);
    const both = new Set(["public.ai_jobs", "public.job_requisitions"]);
    const binding = bindParam(
      route("/hr/recruitment/jobs/:jobId", ["jobId"]),
      "jobId",
      jobs,
      both,
    );
    expect(binding.kind).toBe("table");
    if (binding.kind === "table") expect(binding.tables.length).toBeGreaterThan(1);
  });

  it("names the tables a fixture would have to create before the route can be asked", () => {
    const targets = unpopulatedTargets(KNOWN, new Set(["build.projects"]), [
      route("/kb/articles/:articleId", ["articleId"]),
      route("/kb/articles/:articleId/x", ["articleId"]),
      route("/build/:projectId", ["projectId"]),
    ]);
    expect(targets.get("public.kb_articles")?.routes).toBe(2);
    expect(targets.has("build.projects")).toBe(false);
  });

  it("refuses to bind a parameter whose table is empty, and says so", () => {
    const binding = bindParam(route("/kb/articles/:articleId", ["articleId"]), "articleId", KNOWN, POPULATED);
    expect(binding.kind).toBe("unbindable");
    if (binding.kind === "unbindable") expect(binding.reason).toContain("holds no row for the source tenant");
  });

  it("refuses to bind a parameter that does not address an object", () => {
    for (const param of ["moduleKey", "token", "slug", "providerKey"]) {
      const binding = bindParam(route(`/x/:${param}`, [param]), param, KNOWN, POPULATED);
      expect(binding.kind).toBe("unbindable");
      if (binding.kind === "unbindable") expect(binding.reason).toContain("does not address an object");
    }
  });

  it("binds the tenant selector and the actor to the source tenant itself", () => {
    expect(bindParam(route("/organization/:orgId", ["orgId"]), "orgId", KNOWN, POPULATED).kind).toBe("org");
    expect(bindParam(route("/users/:userId", ["userId"]), "userId", KNOWN, POPULATED).kind).toBe("user");
  });

  it("substitutes every parameter into the request path", () => {
    expect(buildPath("/build/:projectId/tickets/:ticketId", new Map([["projectId", "7"], ["ticketId", "9"]]))).toBe(
      "/build/7/tickets/9",
    );
  });

  it("marks a route unprobeable when any one of its parameters cannot be bound", () => {
    const planned = planRoutes(KNOWN, POPULATED, [
      route("/build/:projectId/x/:moduleKey", ["projectId", "moduleKey"]),
    ]);
    expect(planned[0]?.unprobeable).toContain("does not address an object");
  });
});

describe("BOLA live probe — the plan covers the whole object-addressable surface", () => {
  it("plans one entry for every object-addressable route in the tree", () => {
    const routes = objectAddressableRoutes();
    expect(routes.length).toBeGreaterThan(1800);
    const planned = planRoutes(KNOWN, POPULATED);
    expect(planned.length).toBe(routes.length);
    expect(planned.filter((p) => p.unprobeable === null).length).toBeGreaterThan(0);
  });
});
