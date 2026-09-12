import { loadTenantFkProbeConfig, isTicketEpicForeignKeyViolation } from "../helpers/tenant-fk-probe";

const approved: NodeJS.ProcessEnv = {
  ALLOW_DESTRUCTIVE_DB_TESTS: "1",
  TENANT_FK_PROBE_DATABASE_URL: "postgres://probe@127.0.0.1:5432/scratch_fk_probe",
  TENANT_FK_PROBE_ORG_A: "org-a",
  TENANT_FK_PROBE_ORG_B: "org-b",
  TENANT_FK_PROBE_PROJECT_A_ID: "11",
  TENANT_FK_PROBE_PROJECT_B_ID: "22",
  TENANT_FK_PROBE_PARENT_A_ID: "101",
  TENANT_FK_PROBE_PARENT_B_ID: "202",
  TENANT_FK_PROBE_CHILD_B_ID: "203",
};

describe("tenant FK probe configuration and rejection identity", () => {
  it("requires an explicitly approved disposable database and exact seeded rows", () => {
    expect(loadTenantFkProbeConfig(approved)).toEqual({
      url: approved.TENANT_FK_PROBE_DATABASE_URL,
      orgA: "org-a", orgB: "org-b", projectA: 11, projectB: 22,
      parentA: 101, parentB: 202, childB: 203,
    });
  });

  it("fails unconfigured and does not fall back to DATABASE_URL", () => {
    expect(() => loadTenantFkProbeConfig({ DATABASE_URL: approved.TENANT_FK_PROBE_DATABASE_URL }))
      .toThrow(/TENANT_FK_PROBE_DATABASE_URL/);
  });

  /**
   * Every row names the refusal it expects. These cases all end in "something
   * threw", and a bare `.toThrow()` cannot tell the intended refusal from the
   * one that arrives by accident — an unsafe-host row satisfied by the
   * fixture-id validator, or by a typo in the env key that makes EVERY row
   * refuse for the same uninteresting reason. That is precisely how a guard
   * gets weakened without a single test going red.
   */
  it.each([
    { because: /ALLOW_DESTRUCTIVE_DB_TESTS is not set/, env: { ...approved, ALLOW_DESTRUCTIVE_DB_TESTS: undefined } },
    {
      because: /is not approved for destructive testing/,
      env: { ...approved, TENANT_FK_PROBE_DATABASE_URL: "postgres://probe@unapproved.example/scratch_fk_probe" },
    },
    {
      because: /must name a disposable database/,
      env: { ...approved, TENANT_FK_PROBE_DATABASE_URL: "postgres://probe@127.0.0.1/production" },
    },
    {
      because: /must use the PostgreSQL protocol/,
      env: { ...approved, TENANT_FK_PROBE_DATABASE_URL: "https://127.0.0.1/scratch_fk_probe" },
    },
  ])("refuses an unsafe database configuration $# before any connection", ({ because, env }) => {
    expect(() => loadTenantFkProbeConfig(env)).toThrow(because);
  });

  it.each([
    {
      because: /TENANT_FK_PROBE_ORG_A is required/,
      env: { ...approved, TENANT_FK_PROBE_ORG_A: undefined },
    },
    {
      because: /two distinct organizations and projects/,
      env: { ...approved, TENANT_FK_PROBE_ORG_B: "org-a" },
    },
    {
      because: /two distinct organizations and projects/,
      env: { ...approved, TENANT_FK_PROBE_PROJECT_B_ID: "11" },
    },
    {
      because: /two distinct parent epics and a separate child ticket/,
      env: { ...approved, TENANT_FK_PROBE_CHILD_B_ID: "202" },
    },
    {
      because: /TENANT_FK_PROBE_PARENT_A_ID must be a positive PostgreSQL integer/,
      env: { ...approved, TENANT_FK_PROBE_PARENT_A_ID: "-1" },
    },
    {
      because: /TENANT_FK_PROBE_PARENT_A_ID must be a positive PostgreSQL integer/,
      env: { ...approved, TENANT_FK_PROBE_PARENT_A_ID: "1.5" },
    },
    {
      because: /TENANT_FK_PROBE_PARENT_A_ID must be a positive PostgreSQL integer/,
      env: { ...approved, TENANT_FK_PROBE_PARENT_A_ID: "2147483648" },
    },
  ])("refuses missing, ambiguous or invalid fixture identifiers $#", ({ because, env }) => {
    expect(() => loadTenantFkProbeConfig(env)).toThrow(because);
  });

  it("accepts only the intended FK violation, including a wrapped driver error", () => {
    const violation = { code: "23503", constraint_name: "fk_tickets_org_epic" };
    expect(isTicketEpicForeignKeyViolation(violation)).toBe(true);
    expect(isTicketEpicForeignKeyViolation({ cause: violation })).toBe(true);
    expect(isTicketEpicForeignKeyViolation({ ...violation, code: "42501" })).toBe(false);
    expect(isTicketEpicForeignKeyViolation({ ...violation, constraint_name: "fk_tickets_status" })).toBe(false);
    expect(isTicketEpicForeignKeyViolation({ code: "23503", cause: { constraint_name: "fk_tickets_org_epic" } })).toBe(false);
    expect(isTicketEpicForeignKeyViolation(undefined)).toBe(false);
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    expect(isTicketEpicForeignKeyViolation(cycle)).toBe(false);
  });
});
