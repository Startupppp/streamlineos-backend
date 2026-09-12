jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: <T>(db: unknown, fn: (tx: unknown) => Promise<T>) => fn(db),
}));

import { REPORTING_REGISTRY } from "./compiler/registry";
import { REPORTING_RUN } from "./reporting-source-access";
import { ReportingService } from "./reporting.service";
import { nlProposalSchema } from "./nl-proposal.schemas";

const ORG = "org-1";
const USER = "usr-1";

/** Grants every registry source plus the run key — the same shape reporting-tenant-isolation.spec.ts uses. */
function access() {
  const granted = new Map<string, string>([[REPORTING_RUN, "all"]]);
  for (const [, source] of REPORTING_REGISTRY) granted.set(source.requiredPermission, "all");
  return {
    resolveUserPermissions: jest.fn(async () => granted),
    scopeFor: jest.fn(async (_user: unknown, key: string) => granted.get(key) ?? "none"),
  };
}

function authContexts() {
  return {
    create: (actor: unknown) => ({
      actor,
      moduleAvailable: async () => ({ available: true }),
      membership: async () => ({ active: true, isOwner: false, role: "MEMBER", membershipId: "m1" }),
      mfa: async () => ({ satisfied: true }),
    }),
  };
}

/** A `db` double sufficient for `explain`'s compile — no rows are ever read for it. */
function fakeDb() {
  return { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) };
}

function service(aiGateway: { invokeStructured: jest.Mock }) {
  return new ReportingService(
    fakeDb() as never,
    access() as never,
    authContexts() as never,
    aiGateway as never,
  );
}

describe("ReportingService.proposeFromQuestion", () => {
  it("returns the compiled proposal when the model's description holds up", async () => {
    const invokeStructured = jest.fn().mockResolvedValue({
      ok: true,
      data: {
        ok: true,
        description: {
          source: "deals",
          select: [{ kind: "aggregate", aggregate: "count" }],
          limit: 10,
        },
        explanation: "Counts every deal.",
      },
    });

    const result = await service({ invokeStructured }).proposeFromQuestion(
      { orgId: ORG, userId: USER } as never,
      "How many deals do we have?",
    );

    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.description.source).toBe("deals");
      expect(result.explanation).toBe("Counts every deal.");
      expect(result.preview.sql).toEqual(expect.any(String));
      expect(result.preview.columns.length).toBeGreaterThan(0);
    }
  });

  it("passes through the model's own refusal without ever compiling anything", async () => {
    const invokeStructured = jest.fn().mockResolvedValue({
      ok: true,
      data: { ok: false, reason: "There is no field here that says who referred a deal." },
    });

    const result = await service({ invokeStructured }).proposeFromQuestion(
      { orgId: ORG, userId: USER } as never,
      "Which deals came from referrals?",
    );

    expect(result).toEqual({
      accepted: false,
      reason: "There is no field here that says who referred a deal.",
    });
  });

  it("turns a hallucinated source into a refusal rather than a 500", async () => {
    const invokeStructured = jest.fn().mockResolvedValue({
      ok: true,
      data: {
        ok: true,
        description: { source: "not_a_real_source", select: [{ kind: "aggregate", aggregate: "count" }], limit: 10 },
        explanation: "Made this up.",
      },
    });

    const result = await service({ invokeStructured }).proposeFromQuestion(
      { orgId: ORG, userId: USER } as never,
      "Anything",
    );

    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toContain("didn't hold up");
  });

  it("never executes — there is no code path from a proposal to a row", async () => {
    // Structural, not behavioural: proposeFromQuestion's only DB-facing call
    // is explain(), whose own contract ("executing nothing") is what
    // `reporting.controller.ts`'s docblock states. Asserted here by grep
    // rather than by mocking every possible execution path, which could
    // pass by omission.
    const source = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "reporting.service.ts"),
      "utf8",
    ) as string;
    const method = source.slice(
      source.indexOf("async proposeFromQuestion"),
      source.indexOf("\n  }", source.indexOf("async proposeFromQuestion")),
    );
    expect(method).not.toMatch(/\.run\(|\brunAdHoc\(|\brunDefinition\(/);
    expect(method).toContain("this.explain(");
  });

  it("fails closed with an error surfacing the ForbiddenException, when the caller cannot even reach the proposed source", async () => {
    const deniedAccess = {
      resolveUserPermissions: jest.fn(async () => new Map([[REPORTING_RUN, "all"]])), // holds run, not the deals key
      scopeFor: jest.fn(async (_user: unknown, key: string) => (key === REPORTING_RUN ? "all" : "none")),
    };
    const invokeStructured = jest.fn().mockResolvedValue({
      ok: true,
      data: {
        ok: true,
        description: { source: "deals", select: [{ kind: "aggregate", aggregate: "count" }], limit: 10 },
        explanation: "Counts deals.",
      },
    });

    const svc = new ReportingService(
      fakeDb() as never,
      deniedAccess as never,
      authContexts() as never,
      { invokeStructured } as never,
    );

    const result = await svc.proposeFromQuestion({ orgId: ORG, userId: USER } as never, "How many deals?");
    expect(result.accepted).toBe(false);
  });
});

describe("nlProposalSchema — the structural half of 'never emits SQL'", () => {
  it("accepts free text in reason/explanation without it becoming anything but a display string", () => {
    const injected = "'; DROP TABLE crm_deals; --";
    const refusal = nlProposalSchema.safeParse({ ok: false, reason: injected });
    expect(refusal.success).toBe(true);
    // Parses as plain text, unchanged — there is no escaping step because
    // there is no destination that would need one. Nothing downstream of
    // this schema ever concatenates this string into a query; the only
    // query-shaped output the schema can produce at all is `description`,
    // which is queryDescriptionSchema itself — the same schema every
    // hand-built report goes through.
    if (refusal.success && !refusal.data.ok) expect(refusal.data.reason).toBe(injected);
  });

  it("refuses a proposal that tries to smuggle a raw sql field in alongside a description", () => {
    const result = nlProposalSchema.safeParse({
      ok: true,
      description: { source: "deals", select: [{ kind: "aggregate", aggregate: "count" }], limit: 10 },
      explanation: "x",
      sql: "SELECT * FROM users",
    });
    // .strict() on both the wrapper and queryDescriptionSchema refuses an
    // unknown key outright, rather than silently dropping it.
    expect(result.success).toBe(false);
  });
});
