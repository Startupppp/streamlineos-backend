import { ALLOWED_HOSTS_VAR, assertE2eDatabaseApproved } from "./db-spec-guard";

const PRODUCTION =
  "postgresql://streamline_admin:secret@streamlineos-instance-1.c94aokgu6g21.ap-south-1.rds.amazonaws.com:5432/streamlineos";
const PRODUCTION_APP =
  "postgresql://streamline_app:secret@streamlineos-instance-1.c94aokgu6g21.ap-south-1.rds.amazonaws.com:5432/streamlineos";
const CI_SERVICE_CONTAINER = "postgres://ci:ci@127.0.0.1:5432/ci";
const CI_SERVICE_CONTAINER_APP = "postgres://streamline_app:ci@127.0.0.1:5432/ci";

describe("assertE2eDatabaseApproved", () => {
  it("refuses the production RDS host that backend/.env actually carries, because jest-e2e.json loads dotenv/config and createE2eApp seeds an organisation row", () => {
    expect(() =>
      assertE2eDatabaseApproved({ DATABASE_URL: PRODUCTION, APP_DATABASE_URL: PRODUCTION_APP }),
    ).toThrow(/not approved for destructive testing/);
  });

  it("names both offending variables rather than stopping at the first, so a half-repointed environment cannot look fixed", () => {
    let message = "";
    try {
      assertE2eDatabaseApproved({ DATABASE_URL: PRODUCTION, APP_DATABASE_URL: PRODUCTION_APP });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("DATABASE_URL ->");
    expect(message).toContain("APP_DATABASE_URL ->");
  });

  it("never echoes the password out of the refused connection string", () => {
    let message = "";
    try {
      assertE2eDatabaseApproved({ DATABASE_URL: PRODUCTION });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("secret");
  });

  it("allows the loopback service container CI runs test:e2e:ci against, so this guard does not turn the CI e2e job red", () => {
    expect(() =>
      assertE2eDatabaseApproved({
        DATABASE_URL: CI_SERVICE_CONTAINER,
        APP_DATABASE_URL: CI_SERVICE_CONTAINER_APP,
      }),
    ).not.toThrow();
  });

  it("allows a non-loopback host only when the caller names it in the allowlist", () => {
    const disposable = "postgresql://owner:pw@scratch.internal.test:5432/disposable";
    expect(() => assertE2eDatabaseApproved({ DATABASE_URL: disposable })).toThrow();
    expect(() =>
      assertE2eDatabaseApproved({
        DATABASE_URL: disposable,
        [ALLOWED_HOSTS_VAR]: "scratch.internal.test",
      }),
    ).not.toThrow();
  });

  it("passes an environment with no database variables at all, which is how a fully mocked suite runs", () => {
    expect(() => assertE2eDatabaseApproved({})).not.toThrow();
  });
});
