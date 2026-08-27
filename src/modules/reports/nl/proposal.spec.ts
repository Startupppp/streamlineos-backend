import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { compileQuery, type Requester } from "../query/query-compiler";
import {
  acceptedDescription,
  parseProposal,
  proposalDigest,
  ProposalRejected,
  type QueryProposal,
} from "./proposal";

const WHO: Requester = { orgId: "org-acme", userId: "user-1", scope: "all" };

const good = {
  kind: "query",
  explanation: "Total value of open deals, by stage.",
  description: {
    entity: "deals",
    groupBy: ["stage"],
    aggregations: [{ of: "sum", field: "value", as: "total" }],
  },
};

const asProposal = (raw: unknown): QueryProposal => {
  const outcome = parseProposal(raw);
  if (outcome.kind !== "proposal") throw new Error("expected a proposal");
  return outcome;
};

describe("a proposal is a question, and the same one a person could have built", () => {
  it("compiles through exactly the path a hand-built description does", () => {
    /*
      The second criterion. Not "produces similar SQL" — the same function, so
      tenancy, scope and bounds apply to a proposed report for the same reason
      they apply to any other: the compiler does not know or care where the
      description came from.
    */
    const proposal = asProposal(good);
    const compiled = compileQuery(proposal.description, WHO);
    expect(compiled.text).toContain('"t0"."org_id" = $1');
    expect(compiled.params[0]).toBe("org-acme");
  });

  it("is still constrained by the viewer's scope, however the question was asked", () => {
    const proposal = asProposal(good);
    const narrow = compileQuery(proposal.description, { ...WHO, scope: "own" });
    expect(narrow.text).toContain('"t0"."assigned_to_id"');
  });
});

describe("a model cannot smuggle anything past the description", () => {
  it("refuses an output carrying SQL alongside a description", () => {
    /*
      The strict schema is what makes this a refusal rather than an ignored
      field. An ignored field travels: into a log, into an audit row, into
      whatever the next person writes that reads the proposal generically.
    */
    expect(() =>
      parseProposal({ ...good, rawSql: "SELECT * FROM users" }),
    ).toThrow(ProposalRejected);
    expect(() =>
      parseProposal({
        kind: "query",
        explanation: "x",
        description: { entity: "deals", where: "1=1" },
      }),
    ).toThrow(ProposalRejected);
  });

  it("refuses an entity the graph does not declare, before the database is involved", () => {
    expect(() =>
      parseProposal({ kind: "query", explanation: "x", description: { entity: "users_credentials" } }),
    ).toThrow(/is not something a report can be built on/);
  });

  it("refuses to report on a global entity that has no tenancy of its own", () => {
    expect(() =>
      parseProposal({ kind: "query", explanation: "x", description: { entity: "users" } }),
    ).toThrow(/is not something a report can be built on/);
  });

  it("refuses a field the graph withholds, rather than passing it to the compiler", () => {
    // `deals.notes` and `activities.body` exist and are deliberately not
    // reportable. A model asked for "the notes on every deal" must be stopped
    // here, so that the compiler's refusal stays a second line of defence.
    expect(() =>
      parseProposal({
        kind: "query",
        explanation: "x",
        description: { entity: "deals", select: ["notes"] },
      }),
    ).toThrow(/is not something this report can show/);
  });

  it("refuses a join the entity does not declare", () => {
    expect(() =>
      parseProposal({
        kind: "query",
        explanation: "x",
        description: { entity: "deals", joins: ["activities"] },
      }),
    ).toThrow(/is not a related record/);
  });

  it("refuses a field path that is well-formed but names nothing", () => {
    expect(() =>
      parseProposal({
        kind: "query",
        explanation: "x",
        description: { entity: "deals", joins: ["party"], select: ["party.tax_number"] },
      }),
    ).toThrow(/is not something this report can show/);
  });

  it("has no field on the proposal in which SQL could live", () => {
    const proposal = asProposal(good);
    expect(Object.keys(proposal).sort()).toEqual(["description", "digest", "explanation", "kind"]);
  });
});

describe("what runs is what was shown", () => {
  it("accepts the description whose digest the person agreed to", () => {
    const proposal = asProposal(good);
    expect(acceptedDescription(proposal, proposal.digest)).toBe(proposal.description);
  });

  it("refuses to run a description that changed after it was shown", () => {
    /*
      The fourth criterion, tested for the failure it actually has. A proposal
      addressed by id runs whatever is stored under that id at accept time —
      which need not be what was displayed. Addressing it by content closes the
      window entirely.
    */
    const shown = asProposal(good);
    const swapped = asProposal({
      kind: "query",
      explanation: "Total value of open deals, by stage.",
      description: {
        entity: "deals",
        groupBy: ["stage"],
        aggregations: [{ of: "sum", field: "probability", as: "total" }],
      },
    });

    expect(() => acceptedDescription(swapped, shown.digest)).toThrow(
      /not the report that was shown to you/,
    );
  });

  it("gives the same digest to the same question written in a different key order", () => {
    // Otherwise a client that re-serialises the proposal before echoing it back
    // is refused for a reason no user could understand or fix.
    expect(
      proposalDigest({ entity: "deals", limit: 10, select: ["name"] }),
    ).toBe(proposalDigest({ select: ["name"], limit: 10, entity: "deals" }));
  });

  it("gives different digests to questions that differ only in a filter value", () => {
    expect(
      proposalDigest({ entity: "deals", filters: [{ field: "stage", operator: "eq", value: "WON" }] }),
    ).not.toBe(
      proposalDigest({ entity: "deals", filters: [{ field: "stage", operator: "eq", value: "LOST" }] }),
    );
  });
});

describe("'I cannot express that' is an answer the model is allowed to give", () => {
  it("carries a refusal through rather than forcing a query", () => {
    const outcome = parseProposal({
      kind: "cannot-express",
      reason: "This product does not record why a customer chose a competitor.",
    });
    expect(outcome.kind).toBe("cannot-express");
    expect("reason" in outcome && outcome.reason).toMatch(/does not record/);
  });

  it("produces no description at all when it refuses", () => {
    // A refusal that still carried a description would be run by any caller
    // that checked for one before checking the kind.
    const outcome = parseProposal({ kind: "cannot-express", reason: "no" });
    expect("description" in outcome).toBe(false);
    expect("digest" in outcome).toBe(false);
  });
});

/**
 * The third criterion: "the model never emits SQL and has no database access,
 * asserted structurally rather than by prompt".
 *
 * A prompt is not an assertion. This walks the import closure of every file in
 * this directory and fails if any of them can reach a database handle or the
 * function that produces SQL — so the property is a fact about the module graph
 * rather than a promise about model behaviour.
 */
describe("the natural-language layer cannot reach a database", () => {
  const here = __dirname;

  const closureOf = (entry: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
        const target = resolve(dirname(file), match[1]!);
        for (const candidate of [`${target}.ts`, join(target, "index.ts")])
          if (existsSync(candidate)) {
            queue.push(candidate);
            break;
          }
      }
    }
    return seen;
  };

  const sources = readdirSync(here)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"))
    .map((f) => join(here, f));

  it("has files to check", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it("imports nothing that carries a database handle, at any depth", () => {
    /*
      The list is about a HANDLE, not about Drizzle. `query-graph.ts` imports
      table declarations, and transitively most of the schema, in order to read
      column names off them — that is the whole design, and forbidding it would
      forbid the thing that makes identifiers untypeable by input.

      A table declaration describes a table; it cannot reach one. What can reach
      one is the injection token, the module that provides it, the postgres
      client itself, and the two helpers that open a tenant-scoped transaction.
      Those are the five things below, and any of them appearing anywhere in this
      module's import closure means somebody has given the proposer a way to run
      what it proposes.
    */
    const forbidden = [
      /\bDRIZZLE\b/,
      /db\/drizzle/,
      /from\s+"postgres"/,
      /runInTenantTransaction/,
      /withPublicToken/,
    ];

    const offenders: string[] = [];
    for (const entry of sources)
      for (const file of closureOf(entry)) {
        const source = readFileSync(file, "utf8");
        for (const pattern of forbidden)
          if (pattern.test(source)) offenders.push(`${file.replace(here, "nl")}: ${pattern}`);
      }

    expect(offenders).toEqual([]);
  });

  it("never calls the function that produces SQL", () => {
    /*
      Proposing and running are separate steps performed by separate callers, and
      that separation is the fourth criterion's foundation: a module that could
      compile its own proposal could run one nobody accepted.
    */
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/compileQuery/);
      expect(source).not.toMatch(/query-compiler/);
    }
  });

  it("would notice if a database import were added", () => {
    // The guard above passes trivially if the closure walker finds nothing, so
    // this pins that it actually reaches beyond the entry file.
    const closure = closureOf(join(here, "proposal.ts"));
    expect(closure.size).toBeGreaterThan(1);
    expect([...closure].some((f) => f.includes("query-graph"))).toBe(true);
  });
});
