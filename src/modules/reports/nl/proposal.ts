import { createHash } from "node:crypto";
import { z } from "zod";
import { AGGREGATIONS, FILTER_OPERATORS, type QueryDescription } from "../query/query-description";
import { QUERY_GRAPH } from "../query/query-graph";

/**
 * Asking a question in English and getting a report.
 *
 * Phase 5, ticket 15. The ticket's own sentence is the design: "the model
 * proposes a description; it never emits SQL and never touches the database."
 * Everything below exists to make that structurally true rather than a thing the
 * prompt asks for politely.
 *
 * The version of this feature that everyone builds first is text-to-SQL. It
 * demos beautifully and it is indefensible: the model becomes the thing deciding
 * which tables are read, which means the model is deciding tenancy, and a
 * language model's fidelity to an instruction like "always include org_id" is
 * not a security control — it is a probability. One dropped predicate is one
 * tenant reading another's pipeline.
 *
 * So the model's entire output surface is a `QueryDescription`: a set of KEYS
 * into `QUERY_GRAPH`. It cannot name a table, because table names are not
 * something a description contains. It cannot write a predicate, because there
 * is no field for one. It cannot opt out of tenancy, because — as
 * `query-description.ts` says — there is nowhere in the type to say so. The
 * worst a compromised or hallucinating model can do is propose a bad but legal
 * question about the tenant's own data, which a person then reads before it
 * runs.
 *
 * Three further properties are worth stating because each removes a real attack:
 *
 * **Everything is validated against the graph, not trusted.** A model that
 * invents `entity: "users_credentials"` is refused by `parseProposal`, not by
 * the database.
 *
 * **The proposal is shown before it runs, and what runs is what was shown.**
 * Acceptance is keyed on a digest of the description itself rather than on an
 * identifier, so there is no window in which the stored proposal can change
 * between being displayed and being accepted.
 *
 * **"I cannot express that" is a first-class answer.** A model with no way to
 * refuse will answer every question, including the ones whose honest answer is
 * that the product does not hold that data — and a confidently wrong report is
 * worse than no report, because somebody acts on it.
 */

/** Every field key a description may name, per entity, derived from the graph. */
function fieldKeysFor(entity: string): readonly string[] {
  const definition = QUERY_GRAPH[entity];
  if (!definition) return [];
  return Object.entries(definition.fields)
    .filter(([, field]) => !field.sensitive)
    .map(([key]) => key);
}

/**
 * A field path the model may propose: `field`, or `join.field`.
 *
 * Validated as a whole rather than by a regex, because the point is not that it
 * looks like an identifier — it is that it names something the graph declares.
 * A path that merely looks well-formed is exactly what the compiler is designed
 * never to trust.
 */
function isKnownPath(entity: string, path: string): boolean {
  const parts = path.split(".");
  if (parts.length === 1) return fieldKeysFor(entity).includes(parts[0]!);
  if (parts.length !== 2) return false;
  const [joinKey, field] = parts as [string, string];
  const join = QUERY_GRAPH[entity]?.joins?.[joinKey];
  return join ? fieldKeysFor(join.to).includes(field) : false;
}

const filterSchema = z.object({
  field: z.string(),
  operator: z.enum(FILTER_OPERATORS),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number()]))])
    .optional(),
});

/**
 * The shape a model is allowed to return.
 *
 * `.strict()` everywhere, and that is load-bearing rather than tidy. A permissive
 * object would let a model return `{ entity: "deals", rawSql: "..." }` and let
 * the extra key travel unnoticed to whatever eventually logs or forwards the
 * proposal. Refusing unknown keys means a model that has been talked into
 * emitting SQL produces a validation failure, which is visible, rather than a
 * silently ignored field, which is not.
 */
const descriptionSchema = z
  .object({
    entity: z.string(),
    joins: z.array(z.string()).optional(),
    select: z.array(z.string()).optional(),
    filters: z.array(filterSchema).optional(),
    groupBy: z.array(z.string()).optional(),
    aggregations: z
      .array(z.object({ of: z.enum(AGGREGATIONS), field: z.string().optional(), as: z.string() }).strict())
      .optional(),
    orderBy: z.array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]) }).strict()).optional(),
    limit: z.number().int().optional(),
  })
  .strict();

/** What the model returns: a description, or an honest refusal. */
const modelOutputSchema = z.union([
  z.object({ kind: z.literal("query"), description: descriptionSchema, explanation: z.string() }).strict(),
  z.object({ kind: z.literal("cannot-express"), reason: z.string() }).strict(),
]);

export interface QueryProposal {
  readonly kind: "proposal";
  /** Compiled through exactly the same path a hand-built description is. */
  readonly description: QueryDescription;
  /** What the model understood the question to mean, for the person to check. */
  readonly explanation: string;
  /**
   * A fingerprint of the description above.
   *
   * The fourth criterion — "a proposal the person did not accept is never
   * executed" — is usually implemented as a proposal id the client sends back,
   * and that is a time-of-check-to-time-of-use bug waiting for its first race:
   * whatever is stored under that id at accept time is what runs, and it need
   * not be what was displayed. Keying acceptance on the content means the
   * accepted thing and the shown thing are the same thing by definition.
   */
  readonly digest: string;
}

export interface CannotExpress {
  readonly kind: "cannot-express";
  readonly reason: string;
}

export type ProposalOutcome = QueryProposal | CannotExpress;

/**
 * A stable fingerprint of a description.
 *
 * Keys are sorted at every level, because `{a,b}` and `{b,a}` are the same
 * question and must not produce different digests — otherwise a client that
 * re-serialises the proposal before echoing it back is refused for no reason a
 * user could understand.
 */
export function proposalDigest(description: QueryDescription): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, canonical(v)]),
      );
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical(description))).digest("hex");
}

export class ProposalRejected extends Error {
  constructor(readonly why: string) {
    super(why);
    this.name = "ProposalRejected";
  }
}

/**
 * Model output, turned into a proposal or refused.
 *
 * Refusal here is not a failure mode, it is the normal handling of a model that
 * answered creatively. Nothing that fails this reaches the compiler, so the
 * compiler's own refusals remain a second line rather than the first.
 */
export function parseProposal(raw: unknown): ProposalOutcome {
  const parsed = modelOutputSchema.safeParse(raw);
  if (!parsed.success)
    throw new ProposalRejected("the proposal was not in the form a query description takes");

  if (parsed.data.kind === "cannot-express")
    return { kind: "cannot-express", reason: parsed.data.reason };

  const description = parsed.data.description as QueryDescription;
  const entity = QUERY_GRAPH[description.entity];
  if (!entity || !entity.rootable)
    throw new ProposalRejected(`"${description.entity}" is not something a report can be built on`);

  for (const key of description.joins ?? [])
    if (!entity.joins?.[key]) throw new ProposalRejected(`"${key}" is not a related record of "${description.entity}"`);

  const paths = [
    ...(description.select ?? []),
    ...(description.groupBy ?? []),
    ...(description.filters ?? []).map((f) => f.field),
    ...(description.orderBy ?? []).map((o) => o.field),
    ...(description.aggregations ?? []).flatMap((a) => (a.field ? [a.field] : [])),
  ];
  for (const path of paths)
    if (!isKnownPath(description.entity, path))
      throw new ProposalRejected(`"${path}" is not something this report can show`);

  return {
    kind: "proposal",
    description,
    explanation: parsed.data.explanation,
    digest: proposalDigest(description),
  };
}

/**
 * The description to run, given what the person actually agreed to.
 *
 * Called instead of "look the proposal up by id and run it". If the digest the
 * person accepted does not match the proposal in hand, the two have diverged and
 * neither is safe to run — so nothing runs.
 */
export function acceptedDescription(
  proposal: QueryProposal,
  acceptedDigest: string,
): QueryDescription {
  if (acceptedDigest !== proposal.digest)
    throw new ProposalRejected(
      "this is not the report that was shown to you; review the new one before running it",
    );
  return proposal.description;
}
