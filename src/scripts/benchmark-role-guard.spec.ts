import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * PRD-C079 — "Benchmark under the application role with tenant context and RLS, never only
 * as the database owner; plans must include real authorization predicates."
 *
 * Three separate ways a harness used to answer that question without measuring it:
 *   1. capture-build-baseline.mjs accepted DATABASE_URL (the owner) as a silent fallback;
 *   2. the same script hardcoded ssl:"require", so it could never reach a local
 *      non-BYPASSRLS target and only ever ran against the remote owner-credentialled one;
 *   3. measure-route-budgets.mjs wrote the role provenance into contracts/route-budgets.json
 *      as a string literal, so the manifest's RLS claim survived being pointed anywhere.
 *
 * The guards now live in one module. Each case below fails if its guard is removed.
 *
 * The module is real ESM and jest's CommonJS runtime cannot load it, so it is exercised in a
 * child node process — which is also the only way that proves the shipped scripts can import it.
 */
const SCRIPTS_DIR = __dirname;
// A `file://` URL, not the path: an absolute Windows path is not a legal ESM
// specifier, so every case below died in the child with ERR_UNSUPPORTED_ESM_URL_SCHEME
// ("Received protocol 'd:'") before a single guard was reached.
const GUARD = pathToFileURL(join(SCRIPTS_DIR, "benchmark-role-guard.mjs")).href;

function callGuard(body: string): unknown {
  const program = `import * as g from ${JSON.stringify(GUARD)};\nprocess.stdout.write(JSON.stringify(${body}));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", program], {
    encoding: "utf8",
  });
  return JSON.parse(out) as unknown;
}

describe("benchmark role guard (PRD-C079)", () => {
  describe("resolveAppDatabaseUrl", () => {
    it("accepts APP_DATABASE_URL", () => {
      expect(callGuard(`g.resolveAppDatabaseUrl({ APP_DATABASE_URL: "postgres://streamline_app@localhost/x" })`)).toEqual(
        { ok: true, url: "postgres://streamline_app@localhost/x" },
      );
    });

    it("REFUSES to fall back to DATABASE_URL — that URL names the owner, which carries BYPASSRLS", () => {
      const r = callGuard(`g.resolveAppDatabaseUrl({ DATABASE_URL: "postgres://neondb_owner@localhost/x" })`) as {
        ok: boolean;
        url?: string;
        why?: string;
      };
      expect(r.ok).toBe(false);
      expect(r.url).toBeUndefined();
      expect(r.why).toMatch(/APP_DATABASE_URL is required/);
      expect(r.why).toMatch(/DATABASE_URL is NOT accepted as a fallback/);
    });
  });

  describe("resolveSsl", () => {
    it("follows PGSSLMODE=disable so a local scratch target is reachable", () => {
      expect(callGuard(`g.resolveSsl({ PGSSLMODE: "disable" })`)).toBe(false);
    });

    it("requires TLS otherwise", () => {
      expect(callGuard(`g.resolveSsl({})`)).toBe("require");
    });
  });

  describe("roleRefusal", () => {
    const APP = `{ name: "streamline_app", rolbypassrls: false, rolsuper: false }`;

    it("passes the application role once a no-GUC read has been denied", () => {
      expect(callGuard(`g.roleRefusal(${APP}, true)`)).toBeNull();
    });

    it("REFUSES a BYPASSRLS role — its plans omit the RLS qual", () => {
      const refusal = callGuard(
        `g.roleRefusal({ name: "neondb_owner", rolbypassrls: true, rolsuper: false }, true)`,
      ) as string;
      expect(refusal).toMatch(/REFUSING TO MEASURE/);
      expect(refusal).toMatch(/neondb_owner/);
    });

    it("REFUSES a superuser", () => {
      expect(callGuard(`g.roleRefusal({ name: "postgres", rolbypassrls: false, rolsuper: true }, true)`)).toMatch(
        /REFUSING TO MEASURE/,
      );
    });

    it("REFUSES when a no-GUC read was answered rather than denied — RLS is not in force", () => {
      expect(callGuard(`g.roleRefusal(${APP}, false)`)).toMatch(/RLS is not in force/);
    });

    it("REFUSES when pg_roles could not be read at all", () => {
      expect(callGuard(`g.roleRefusal(undefined, true)`)).toMatch(/could not read the connected role/);
    });

    it("names a probe relation whose policy RAISES, not one that quietly returns zero rows", () => {
      expect(callGuard(`g.RLS_PROBE_RELATION`)).toBe("calendar_events");
    });
  });

  describe("formatRoleProvenance", () => {
    it("derives the recorded string from the live read", () => {
      expect(callGuard(`g.formatRoleProvenance({ name: "streamline_app", rolbypassrls: false })`)).toBe(
        "streamline_app (rolbypassrls = false, tenant GUC set)",
      );
    });
  });

  describe("resolveMeasurementRole", () => {
    it("carries an observed non-BYPASSRLS role through to the manifest", () => {
      expect(
        callGuard(`g.resolveMeasurementRole({ role: "streamline_app (rolbypassrls = false, tenant GUC set)" })`),
      ).toEqual({ ok: true, role: "streamline_app (rolbypassrls = false, tenant GUC set)" });
    });

    it("REFUSES an artifact that carries no observed role — the manifest may not assert one", () => {
      const r = callGuard(`g.resolveMeasurementRole({ tenant: "org-1", profile: "reference" })`) as {
        ok: boolean;
        why?: string;
      };
      expect(r.ok).toBe(false);
      expect(r.why).toMatch(/carries no observed .role./);
    });

    it("REFUSES a role string that is not proven non-BYPASSRLS", () => {
      expect(callGuard(`g.resolveMeasurementRole({ role: "neondb_owner (rolbypassrls = true)" }).ok`)).toBe(false);
      expect(callGuard(`g.resolveMeasurementRole({ role: "streamline_app" }).ok`)).toBe(false);
    });
  });

  describe("the shipped harnesses use the guard rather than their own answer", () => {
    it("measure-route-budgets --self-test proves the three role refusals", () => {
      const out = execFileSync(process.execPath, [join(SCRIPTS_DIR, "measure-route-budgets.mjs"), "--self-test"], {
        encoding: "utf8",
      });
      expect(out).toMatch(/\[pass\] role-absent-is-refused/);
      expect(out).toMatch(/\[pass\] owner-role-is-refused/);
      expect(out).toMatch(/\[pass\] proven-role-is-carried/);
      expect(out).toMatch(/SELF-TEST PASSED/);
    });

    it("no benchmark harness reads DATABASE_URL or hardcodes ssl:\"require\"", () => {
      const readFileSync = jest.requireActual<typeof import("node:fs")>("node:fs").readFileSync;
      for (const file of ["capture-build-baseline.mjs", "run-read-cost-budgets.mjs"]) {
        const source = readFileSync(join(SCRIPTS_DIR, file), "utf8");
        expect(source).not.toMatch(/process\.env\.DATABASE_URL/);
        expect(source).not.toMatch(/ssl:\s*"require"/);
        expect(source).toMatch(/benchmark-role-guard\.mjs/);
        expect(source).toMatch(/roleRefusal/);
      }
    });

    it("measure-route-budgets does not assert a role of its own", () => {
      const readFileSync = jest.requireActual<typeof import("node:fs")>("node:fs").readFileSync;
      const source = readFileSync(join(SCRIPTS_DIR, "measure-route-budgets.mjs"), "utf8");
      const start = source.indexOf("manifest.measurement = {");
      expect(start).toBeGreaterThan(-1);
      const block = source.slice(start, source.indexOf("\n};", start));
      expect(block).toMatch(/role:\s*measuredRole/);
      expect(block).not.toMatch(/role:\s*"/);
      expect(source).toMatch(/resolveMeasurementRole/);
    });
  });
});
