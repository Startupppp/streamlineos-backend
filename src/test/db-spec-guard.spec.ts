import {
  ALLOWED_HOSTS_VAR,
  OPT_IN_VAR,
  assertApprovedDatabaseUrl,
  assertDbSpecEnvironmentApproved,
  checkDatabaseUrl,
  requireApprovedDatabaseUrl,
} from "./db-spec-guard";

const REMOTE =
  "postgresql://neondb_owner:npg_secret@ep-orange-mode-azxn5hbr-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const LOCAL = "postgresql://neondb_owner@127.0.0.1:5432/scratch_local?sslmode=disable";

const optedIn: NodeJS.ProcessEnv = { [OPT_IN_VAR]: "1" };

describe("db-spec-guard", () => {
  describe("refuses", () => {
    it("the remote Neon database backend/.env actually points at, even when opted in", () => {
      const verdict = checkDatabaseUrl(REMOTE, optedIn);
      expect(verdict.ok).toBe(false);
      if (verdict.ok) throw new Error("unreachable");
      expect(verdict.because).toContain("not approved for destructive testing");
      expect(verdict.target).toBe(
        "ep-orange-mode-azxn5hbr-pooler.c-3.ap-southeast-1.aws.neon.tech:5432/neondb",
      );
    });

    it("an approved host when the operator has not opted in", () => {
      const verdict = checkDatabaseUrl(LOCAL, {});
      expect(verdict.ok).toBe(false);
      if (verdict.ok) throw new Error("unreachable");
      expect(verdict.because).toContain(OPT_IN_VAR);
    });

    it("an environment with no database URL at all, rather than falling back to .env", () => {
      expect(() => assertDbSpecEnvironmentApproved(optedIn)).toThrow(/no \*DATABASE_URL is set/);
      expect(() => assertDbSpecEnvironmentApproved(optedIn)).toThrow(/no \.env fallback/);
    });

    it("a spec whose own variables are unset", () => {
      expect(() =>
        requireApprovedDatabaseUrl({
          spec: "party-legacy-writer.db.spec.ts",
          vars: ["DATABASE_URL"],
          env: optedIn,
        }),
      ).toThrow(/none of them is set/);
    });

    it("a remote URL sitting in a variable no spec reads", () => {
      const env: NodeJS.ProcessEnv = {
        [OPT_IN_VAR]: "1",
        DATABASE_URL: LOCAL,
        REGION_CELL_2_DATABASE_URL: REMOTE,
      };
      expect(() => assertDbSpecEnvironmentApproved(env)).toThrow(/REGION_CELL_2_DATABASE_URL/);
    });

    it("with a message naming the database it refused and what to set", () => {
      let message = "";
      try {
        assertApprovedDatabaseUrl("DATABASE_URL", REMOTE, optedIn);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("DATABASE_URL -> ep-orange-mode-azxn5hbr-pooler");
      expect(message).toContain("neondb");
      expect(message).toContain(`Set ${OPT_IN_VAR}=1`);
      expect(message).toContain("127.0.0.1");
      expect(message).not.toContain("npg_secret");
    });
  });

  describe("admits", () => {
    it("the approved local database when the operator has opted in", () => {
      expect(assertApprovedDatabaseUrl("DATABASE_URL", LOCAL, optedIn)).toBe(LOCAL);
      expect(() =>
        assertDbSpecEnvironmentApproved({ [OPT_IN_VAR]: "1", DATABASE_URL: LOCAL }),
      ).not.toThrow();
    });

    it("the first variable a spec names that is set", () => {
      const env: NodeJS.ProcessEnv = { [OPT_IN_VAR]: "1", APP_DATABASE_URL: LOCAL };
      expect(
        requireApprovedDatabaseUrl({
          spec: "party-legacy-writer.db.spec.ts",
          vars: ["PARTY_PROBE_DATABASE_URL", "APP_DATABASE_URL"],
          env,
        }),
      ).toBe(LOCAL);
    });

    it("a host the operator explicitly added, and still nothing beyond it", () => {
      const env: NodeJS.ProcessEnv = { [OPT_IN_VAR]: "1", [ALLOWED_HOSTS_VAR]: "db.internal.test" };
      expect(checkDatabaseUrl("postgresql://u@db.internal.test:5432/scratch", env).ok).toBe(true);
      expect(checkDatabaseUrl(REMOTE, env).ok).toBe(false);
    });
  });
});
