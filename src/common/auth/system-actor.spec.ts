import { systemActor } from "./system-actor";
import { SYSTEM_JOBS, SYSTEM_JOB_IDS } from "./system-jobs";
import { ALL_PERMISSION_NAMES } from "../../modules/rbac/permissions";

describe("systemActor — isOrgOwner is always false", () => {
  it.each(SYSTEM_JOB_IDS)("job %s never produces isOrgOwner: true", (jobId) => {
    expect(systemActor(jobId, "org-123").isOrgOwner).toBe(false);
  });
});

describe("systemActor — principal kind and ceiling", () => {
  it.each(SYSTEM_JOB_IDS)("job %s produces a system-job principal", (jobId) => {
    expect(systemActor(jobId, "org-abc").principal.kind).toBe("system-job");
  });

  it.each(SYSTEM_JOB_IDS)(
    "ceiling on job %s principal equals the declared ceiling",
    (jobId) => {
      const ctx = systemActor(jobId, "org-abc");
      const declared = [...SYSTEM_JOBS[jobId].ceiling];
      expect(ctx.principal.kind).toBe("system-job");
      if (ctx.principal.kind === "system-job")
        expect([...ctx.principal.ceiling]).toEqual(declared);
    },
  );
});

describe("systemActor — userId attribution", () => {
  it('defaults userId to "system" when onBehalfOfUserId is omitted', () => {
    expect(systemActor("integrations.git.webhook", "org-1").userId).toBe("system");
  });

  it("uses the supplied onBehalfOfUserId when given", () => {
    expect(systemActor("integrations.git.webhook", "org-1", "user-xyz").userId).toBe("user-xyz");
  });

  it("ceiling is unchanged whether or not onBehalfOfUserId is supplied", () => {
    const withUser = systemActor("integrations.git.webhook", "org-1", "user-xyz");
    const withoutUser = systemActor("integrations.git.webhook", "org-1");
    if (withUser.principal.kind === "system-job" && withoutUser.principal.kind === "system-job")
      expect([...withUser.principal.ceiling]).toEqual([...withoutUser.principal.ceiling]);
    else
      throw new Error("Expected system-job principal");
  });

  it("attribution carries no authority — the job ceiling is the sole authority source", () => {
    const ctx = systemActor("integrations.git.webhook", "org-1", "user-xyz");
    expect(ctx.principal.kind).toBe("system-job");
    if (ctx.principal.kind === "system-job")
      expect([...ctx.principal.ceiling]).toEqual([...SYSTEM_JOBS["integrations.git.webhook"].ceiling]);
  });
});

describe("SYSTEM_JOBS — ceiling keys are real permission catalog entries", () => {
  const allNames = new Set(ALL_PERMISSION_NAMES);

  it.each(SYSTEM_JOB_IDS)(
    "every ceiling key in job %s exists in the permission catalog",
    (jobId) => {
      for (const key of SYSTEM_JOBS[jobId].ceiling)
        expect(allNames.has(key)).toBe(true);
    },
  );
});

describe("SYSTEM_JOBS — every job has a non-empty reason", () => {
  it.each(SYSTEM_JOB_IDS)("job %s has a non-empty reason", (jobId) => {
    expect(SYSTEM_JOBS[jobId].reason.trim().length).toBeGreaterThan(0);
  });
});
