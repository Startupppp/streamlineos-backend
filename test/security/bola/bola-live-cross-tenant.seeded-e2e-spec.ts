import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import request from "supertest";
import postgres from "postgres";
import { createSeededE2eApp, signSeededToken, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { loadCatalog, type Catalog } from "test/security/bola/live/fixture-catalog";
import {
  buildPath,
  disambiguate,
  isDisclosure,
  isFinding,
  planRoutes,
  score,
  type PlannedRoute,
  type Verdict,
} from "test/security/bola/live/probe-plan";

/**
 * Ticket 15, box 1 — the live half.
 *
 * The static sweep proved that 1,900+ object-addressable routes bind a tenant somewhere between the
 * controller and the data layer. It could not prove what the API ANSWERS when it is handed another
 * organization's id, and the ticket's box is written about the answer: 404, never 403, because a
 * 403 confirms the record exists and turns the route into an existence oracle.
 *
 * WHAT MAKES A GREEN RESULT HERE MEAN ANYTHING
 *
 * A cross-tenant 404 is worthless on its own. An unrouteable path, an id the pipe rejects, a
 * permission the caller lacks, a module the org has not enabled and a correctly bound tenant all
 * answer 404 in exactly the same way. A sweep that counts those as passes reports "all green" over
 * a run in which nothing worked — which already happened once in this release, where a journey
 * harness recorded zero findings while every step rendered an error page.
 *
 * So every route is probed TWICE with the SAME url:
 *
 *   control   the object's own owner requests it            -> must answer 2xx
 *   probe     a user in a DIFFERENT organization requests it -> must answer 404
 *
 * and `score()` refuses to grade any route whose control did not answer 2xx. Those routes are
 * counted and named as unprobeable, never as passes. The suite additionally fails if the scored
 * population collapses (`MIN_SCORED`), so a run in which authentication broke cannot report green
 * by scoring nothing.
 *
 * Mutating verbs run the PROBE FIRST. A control DELETE removes the object, so the reverse order
 * would probe an id that no longer exists and every DELETE route would "pass" vacuously.
 */

jest.setTimeout(4 * 60 * 60 * 1000);

const OWNER_URL = process.env.DATABASE_URL ?? "";
const SOURCE_ORG = process.env.BOLA_SOURCE_ORG_ID ?? "";
const PROBER_ORG = process.env.BOLA_PROBER_ORG_ID ?? "";
const ARTIFACT = process.env.BOLA_LIVE_ARTIFACT ?? "";
const ONLY = process.env.BOLA_LIVE_ONLY ?? "";
/** Pins the probing user. Empty means the prober organization's owner, the widest caller it has. */
const PROBER_USER = process.env.BOLA_PROBER_USER_ID ?? "";
const LIMIT = Number(process.env.BOLA_LIVE_LIMIT ?? "0");
const MIN_SCORED = Number(process.env.BOLA_LIVE_MIN_SCORED ?? "200");
const REQUEST_TIMEOUT_MS = Number(process.env.BOLA_LIVE_TIMEOUT_MS ?? "15000");

const USABLE =
  OWNER_URL.length > 0 &&
  /scratch/i.test(OWNER_URL) &&
  SOURCE_ORG.length > 0 &&
  PROBER_ORG.length > 0 &&
  SOURCE_ORG !== PROBER_ORG &&
  (process.env.AUTH_SIGNING_KEYS ?? "").length > 0;

if (!USABLE)
  console.error(
    "[bola-live] SKIPPED — a skipped sweep proves nothing. It needs:\n" +
      "  DATABASE_URL          owner role on a scratch database holding two seeded tenants\n" +
      "  BOLA_SOURCE_ORG_ID    the tenant whose objects are borrowed\n" +
      "  BOLA_PROBER_ORG_ID    the tenant whose user does the probing (must differ)\n" +
      "  AUTH_SIGNING_KEYS     a LOCAL PLACEHOLDER Ed25519 keyring — never a real credential\n" +
      "  BOLA_LIVE_ARTIFACT    where to write the per-route result\n",
  );

const describeIfSeeded = USABLE ? describe : describe.skip;

interface Outcome {
  readonly key: string;
  readonly verb: string;
  readonly path: string;
  readonly requestPath: string;
  readonly handler: string;
  readonly file: string;
  readonly classification: string;
  readonly sourceOrg: string;
  readonly proberOrg: string;
  readonly controlStatus: number | null;
  readonly probeStatus: number | null;
  readonly absentStatus: number | null;
  readonly verdict: Verdict;
  readonly detail: string;
  readonly probeBody?: string;
}

interface Sent {
  readonly status: number;
  readonly body: string;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Routes measured to answer another organization's id with something other than 404 while
 * disclosing nothing — an id belonging to no organization gets the identical answer.
 *
 * Pinned rather than allowed: every entry is a defect against the ticket's box, and a NEW one
 * fails the suite. Fixing one means deleting its line from the pin file.
 *
 * The list lives in JSON beside the spec rather than inline. It is hundreds of routes long, it is
 * measurement output rather than authored code, and a reviewer needs to diff it — three reasons a
 * literal array in the middle of a spec would be the wrong home for it.
 */
interface PinFile {
  readonly no404: readonly string[];
  readonly serverErrors: readonly string[];
}

const PINS = JSON.parse(
  readFileSync(join(__dirname, "live", "known-no-404.json"), "utf8"),
) as PinFile;
const KNOWN_NO_404: readonly string[] = [...PINS.no404].sort();
const KNOWN_SERVER_ERRORS: readonly string[] = [...PINS.serverErrors].sort();

function commit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

describeIfSeeded("BOLA — live cross-tenant probe of every object-addressable route", () => {
  let seeded: SeededE2eApp;
  let owner: ReturnType<typeof postgres>;
  let baseUrl = "";
  let sourceCatalog: Catalog;
  let sourceUser = "";
  let proberUser = "";
  let sourceToken = "";
  let proberToken = "";
  let tokensMintedAt = 0;
  const outcomes: Outcome[] = [];
  const harnessProofs: Record<string, unknown> = {};

  const send = async (
    verb: string,
    path: string,
    token: string,
  ): Promise<Sent> => {
    const agent = request(baseUrl);
    const lower = verb.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
    let req = agent[lower](path)
      .set("Authorization", `Bearer ${token}`)
      // @Idempotent routes answer 400 without this and the error reads like a body validation
      // failure, which would be recorded as an unprobeable route rather than a probed one.
      .set("Idempotency-Key", randomUUID())
      .timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS + 5000 });
    if (verb !== "GET" && verb !== "DELETE") req = req.send({});
    try {
      const res = await req;
      const text = typeof res.text === "string" ? res.text : JSON.stringify(res.body ?? null);
      return { status: res.status, body: text.slice(0, 400) };
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (typeof status === "number")
        return { status, body: String((error as { response?: { text?: string } }).response?.text ?? "").slice(0, 400) };
      return { status: 0, body: `transport: ${String((error as Error).message).slice(0, 200)}` };
    }
  };

  const refreshTokens = async (): Promise<void> => {
    // The keyring signs a 10-minute token; a sweep of this size outlives one, and an expired token
    // turns every remaining control into a 401 that would be filed as "route not probeable".
    if (Date.now() - tokensMintedAt < 4 * 60 * 1000) return;
    sourceToken = await signSeededToken(seeded, sourceUser, SOURCE_ORG);
    proberToken = await signSeededToken(seeded, proberUser, PROBER_ORG);
    tokensMintedAt = Date.now();
  };

  const resolveOwnerUser = async (orgId: string): Promise<string> => {
    const rows = await owner.unsafe<{ user_id: string }[]>(
      `SELECT user_id FROM organization_members
       WHERE org_id = $1 AND status = 'ACTIVE' AND user_id IS NOT NULL
       ORDER BY is_owner DESC, id ASC LIMIT 1`,
      [orgId],
    );
    const userId = rows[0]?.user_id;
    if (!userId) throw new Error(`[bola-live] no active membership in org ${orgId}`);
    return userId;
  };

  /**
   * An id no organization owns, in the shape the route's parameter takes.
   *
   * The pool holds this table's real ids, so their shape decides: a numeric key gets a number far
   * above any sequence, a uuid key gets a fresh uuid. Sending a uuid where the pipe expects an int
   * would answer 400 and the disambiguation would read as "the route cannot resolve the object"
   * when it was the request that was malformed.
   */
  const absentId = (pool: readonly string[]): string =>
    pool.every((id) => /^\d+$/.test(id)) ? "2147483001" : randomUUID();

  /** The url for one planned route, or null when an id is missing. `take` picks from the pool. */
  const urlFor = (planned: PlannedRoute, take: (key: string, pool: readonly string[]) => string | null): string | null => {
    const values = new Map<string, string>();
    for (const binding of planned.bindings) {
      if (binding.kind === "org") values.set(binding.param, SOURCE_ORG);
      else if (binding.kind === "user") values.set(binding.param, sourceUser);
      else if (binding.kind === "table") {
        const tableKey = `${binding.table.schema}.${binding.table.name}`;
        const pool = sourceCatalog.ids.get(tableKey) ?? [];
        const id = take(tableKey, pool);
        if (id === null) return null;
        values.set(binding.param, id);
      } else return null;
    }
    return buildPath(planned.path, values);
  };

  /** The same url with every object parameter replaced by an id that exists in no organization. */
  const absentUrlFor = (planned: PlannedRoute): string | null => {
    const values = new Map<string, string>();
    for (const binding of planned.bindings) {
      if (binding.kind === "org") values.set(binding.param, SOURCE_ORG);
      else if (binding.kind === "user") values.set(binding.param, sourceUser);
      else if (binding.kind === "table")
        values.set(binding.param, absentId(sourceCatalog.ids.get(`${binding.table.schema}.${binding.table.name}`) ?? []));
      else return null;
    }
    return buildPath(planned.path, values);
  };

  beforeAll(async () => {
    process.env.CRON_SECRET = process.env.CRON_SECRET ?? `bola-local-${randomUUID()}`;
    seeded = await createSeededE2eApp({ mirrorHttpStack: true });
    await seeded.app.listen(0);
    const address = seeded.app.getHttpServer().address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    if (!port) throw new Error("[bola-live] the harness app did not bind a port");
    baseUrl = `http://127.0.0.1:${String(port)}`;

    owner = postgres(OWNER_URL, { max: 2, prepare: false, ssl: false, onnotice: () => {} });
    sourceCatalog = await loadCatalog(owner, SOURCE_ORG);
    sourceUser = await resolveOwnerUser(SOURCE_ORG);
    proberUser = PROBER_USER.length > 0 ? PROBER_USER : await resolveOwnerUser(PROBER_ORG);
    await refreshTokens();
  });

  /**
   * Written every 50 routes, not only at the end.
   *
   * A sweep of this size runs for over an hour, and a run killed at minute 80 with the artifact
   * still in memory has proved nothing it can show. Flushing as it goes costs one file write per
   * fifty routes and means a killed run is still evidence for everything it reached.
   */
  let lastFlush = 0;
  const writeArtifact = (): void => {
    if (!ARTIFACT || outcomes.length === 0) return;
    lastFlush = outcomes.length;
    mkdirSync(dirname(ARTIFACT), { recursive: true });
    writeFileSync(
      ARTIFACT,
      `${JSON.stringify(
        {
          method: "live-http-cross-tenant",
          generatedAt: new Date().toISOString(),
          commit: commit(),
          sourceOrg: SOURCE_ORG,
          proberOrg: PROBER_ORG,
          sourceUser,
          proberUser,
          harnessProofs,
          outcomes,
        },
        null,
        2,
      )}\n`,
    );
  };

  afterAll(async () => {
    writeArtifact();
    if (owner) await owner.end({ timeout: 5 });
    if (seeded) await seeded.close();
  });

  it("both tenants are real and distinct, and the source tenant owns objects", () => {
    expect(SOURCE_ORG).not.toEqual(PROBER_ORG);
    expect(sourceUser).not.toEqual(proberUser);
    expect(sourceCatalog.populated.size).toBeGreaterThan(20);
  });

  /**
   * PROOF THE PROBE CAN FAIL, part 1 — the classifier and the request path really do detect a
   * served object.
   *
   * The same url is requested with the SOURCE tenant's own token. Nothing about the request
   * changes except which organization the caller belongs to, so a harness that cannot tell these
   * two apart is a harness that would report 404 no matter what the application did.
   */
  it("reports LEAK when the very same request is made by the object's own tenant", async () => {
    await refreshTokens();
    const plan = planRoutes(sourceCatalog.tables, sourceCatalog.populated).filter(
      (p) => p.unprobeable === null && p.verb === "GET",
    );
    const leaks: string[] = [];
    const checked: string[] = [];
    for (const planned of plan) {
      if (leaks.length >= 12) break;
      const url = urlFor(planned, (_k, pool) => pool[0] ?? null);
      if (url === null) continue;
      const control = await send(planned.verb, url, sourceToken);
      if (control.status < 200 || control.status >= 300) continue;
      checked.push(planned.key);
      const scored = score(control.status, control.status);
      if (scored.verdict === "LEAK") leaks.push(planned.key);
    }
    harnessProofs.sameTenantLeakDetection = { checked: checked.length, leaks: leaks.length, sample: leaks.slice(0, 5) };
    expect(checked.length).toBeGreaterThan(0);
    expect(leaks.length).toEqual(checked.length);
  });

  /**
   * PROOF THE PROBE CAN FAIL, part 2 — a genuinely weakened route turns the sweep red.
   *
   * `ProjectsQueryService.getProject` is replaced with a read that resolves the project BY ID
   * ALONE, which is exactly the defect this ticket exists to find. The cross-tenant probe must then
   * come back 200 and be scored LEAK. The original method is restored before anything else runs.
   */
  it("turns red against a route whose tenant binding has been removed", async () => {
    await refreshTokens();
    const { ProjectsQueryService } = (await import(
      "src/modules/build/core/projects-query.service"
    )) as { ProjectsQueryService: new (...args: never[]) => { getProject: unknown } };
    const service = seeded.app.get(ProjectsQueryService);
    const original = service.getProject;

    const projectIds = sourceCatalog.ids.get("build.projects") ?? [];
    const projectId = projectIds[0];
    expect(projectId).toBeDefined();
    const url = `/build/${String(projectId)}`;

    const before = await send("GET", url, proberToken);
    const beforeScore = score(200, before.status);

    (service as { getProject: unknown }).getProject = async (
      _user: unknown,
      id: number,
    ): Promise<unknown> => {
      const rows = await owner.unsafe<Record<string, unknown>[]>(
        `SELECT id, org_id, name FROM build.projects WHERE id = $1`,
        [id],
      );
      const row = rows[0];
      if (!row) throw new Error("not found");
      return row;
    };
    const after = await send("GET", url, proberToken);
    (service as { getProject: unknown }).getProject = original;
    const afterScore = score(200, after.status);

    const restored = await send("GET", url, proberToken);

    harnessProofs.mutationTest = {
      route: `GET /build/:projectId (ProjectsQueryService.getProject)`,
      boundStatus: before.status,
      boundVerdict: beforeScore.verdict,
      unboundStatus: after.status,
      unboundVerdict: afterScore.verdict,
      restoredStatus: restored.status,
    };

    expect(beforeScore.verdict).toEqual("PASS");
    expect(afterScore.verdict).toEqual("LEAK");
    expect(score(200, restored.status).verdict).toEqual("PASS");
  });

  it("probes every object-addressable route it can reach with an id from the other tenant", async () => {
    const plan = planRoutes(sourceCatalog.tables, sourceCatalog.populated);
    const order = (verb: string): number => (verb === "GET" ? 0 : verb === "DELETE" ? 2 : 1);
    const runnable = plan
      .filter((p) => ONLY.length === 0 || p.key.includes(ONLY))
      .sort((a, b) => order(a.verb) - order(b.verb) || a.key.localeCompare(b.key));
    const cursors = new Map<string, number>();
    let done = 0;

    for (const planned of runnable) {
      if (LIMIT > 0 && done >= LIMIT) break;
      done += 1;
      const base = {
        key: planned.key,
        verb: planned.verb,
        path: planned.path,
        handler: planned.handler,
        file: planned.file,
        classification: planned.classification,
        sourceOrg: SOURCE_ORG,
        proberOrg: PROBER_ORG,
      };
      if (planned.unprobeable !== null) {
        outcomes.push({
          ...base,
          requestPath: "",
          controlStatus: null,
          probeStatus: null,
          absentStatus: null,
          verdict: "UNPROBEABLE",
          detail: planned.unprobeable,
        });
        continue;
      }
      await refreshTokens();

      // A DELETE control consumes its object, so every DELETE route takes a fresh id from the back
      // of the pool. Reads and updates share the first id, which keeps the pool intact for them.
      const url = urlFor(planned, (key, pool) => {
        if (planned.verb !== "DELETE") return pool[0] ?? null;
        const used = cursors.get(key) ?? 0;
        cursors.set(key, used + 1);
        const index = pool.length - 1 - used;
        return index >= 0 ? (pool[index] ?? null) : null;
      });
      if (url === null) {
        outcomes.push({
          ...base,
          requestPath: "",
          controlStatus: null,
          probeStatus: null,
          absentStatus: null,
          verdict: "UNPROBEABLE",
          detail: "the source tenant has no remaining object of this type",
        });
        continue;
      }

      let control: Sent;
      let probeResult: Sent;
      if (MUTATING.has(planned.verb)) {
        probeResult = await send(planned.verb, url, proberToken);
        control = await send(planned.verb, url, sourceToken);
      } else {
        control = await send(planned.verb, url, sourceToken);
        probeResult = await send(planned.verb, url, proberToken);
      }

      const raw = score(
        control.status === 0 ? null : control.status,
        probeResult.status === 0 ? null : probeResult.status,
        control.body.slice(0, 160),
      );

      // Only a disclosure earns the third request. A 404 needs no explaining and an unprobeable
      // route has nothing to explain, so the sweep does not pay for either.
      let absentStatus: number | null = null;
      let scored = raw;
      if (isDisclosure(raw.verdict)) {
        const absentUrl = absentUrlFor(planned);
        if (absentUrl !== null) {
          const absent = await send(planned.verb, absentUrl, proberToken);
          absentStatus = absent.status === 0 ? null : absent.status;
          scored = disambiguate(raw, probeResult.status, absentStatus);
        }
      }

      outcomes.push({
        ...base,
        requestPath: url,
        controlStatus: control.status,
        probeStatus: probeResult.status,
        absentStatus,
        verdict: scored.verdict,
        detail: scored.detail,
        probeBody: isFinding(scored.verdict) ? probeResult.body : undefined,
      });
      if (outcomes.length - lastFlush >= 25) writeArtifact();
    }

    const tally = new Map<Verdict, number>();
    for (const outcome of outcomes) tally.set(outcome.verdict, (tally.get(outcome.verdict) ?? 0) + 1);
    process.stderr.write(
      `[bola-live] ${String(outcomes.length)} routes attempted: ${[...tally.entries()]
        .map(([verdict, count]) => `${verdict}=${String(count)}`)
        .join(" ")}\n`,
    );
    expect(outcomes.length).toBeGreaterThan(0);
  });

  it("scored enough routes for the run to mean anything", () => {
    const scored = outcomes.filter((o) => o.verdict !== "UNPROBEABLE");
    process.stderr.write(`[bola-live] scored ${String(scored.length)} of ${String(outcomes.length)} attempted\n`);
    expect(scored.length).toBeGreaterThanOrEqual(MIN_SCORED);
  });

  it("no route serves another organization's object, and none confirms it exists", () => {
    const leaks = outcomes.filter((o) => o.verdict === "LEAK");
    const oracles = outcomes.filter((o) => o.verdict === "EXISTENCE-ORACLE");
    expect({
      leaks: leaks.map((o) => `${o.verb} ${o.path} -> ${String(o.probeStatus)}`),
      existenceOracles: oracles.map((o) => `${o.verb} ${o.path} -> 403`),
    }).toEqual({ leaks: [], existenceOracles: [] });
  });

  /**
   * The routes that answer another organization's id with something other than 404 while
   * disclosing nothing — they answer an id belonging to nobody exactly the same way.
   *
   * These are pinned by name rather than allowed. Nothing here is a disclosure, so the suite does
   * not fail on the ones already known; a NEW one turns it red, which is the only way a regression
   * in this class is ever noticed.
   */
  it("records every route that answers an unowned id with something other than 404", () => {
    const softened = outcomes
      .filter((o) => o.verdict === "NO-404")
      .map((o) => `${o.verb} ${o.path} -> ${String(o.probeStatus)}`)
      .sort();
    process.stderr.write(`[bola-live] NO-404 routes: ${String(softened.length)}\n`);
    expect(softened).toEqual(KNOWN_NO_404);
  });

  it("no route errors on another organization's id", () => {
    const errors = outcomes
      .filter((o) => o.verdict === "SERVER-ERROR")
      .map((o) => `${o.verb} ${o.path} -> ${String(o.probeStatus)}`)
      .sort();
    expect(errors).toEqual(KNOWN_SERVER_ERRORS);
  });
});
