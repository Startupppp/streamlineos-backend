/** The shape `ReportingService.describeSources` already returns — reused, not re-derived. */
export interface DescribedSource {
  readonly key: string;
  readonly label: string;
  readonly fields: readonly { name: string; label: string; type: string }[];
  readonly relations: readonly {
    name: string;
    fields: readonly { name: string; label: string; type: string }[];
  }[];
}

/**
 * The declared surface, rendered as the ONLY vocabulary the model is given.
 *
 * A field or source not listed here has nothing for the model to name it
 * with — the prompt is not the safety boundary (`explain`'s compile is), but
 * a model that has never seen a column name is far less likely to invent
 * one that only coincidentally collides with something real.
 */
function describeSourcesForPrompt(sources: readonly DescribedSource[]): string {
  return sources
    .map((source) => {
      const fields = source.fields.map((f) => `${f.name} (${f.type}) — ${f.label}`).join("\n    ");
      const relations = source.relations
        .map(
          (r) =>
            `  ${r.name}.*:\n    ${r.fields.map((f) => `${f.name} (${f.type}) — ${f.label}`).join("\n    ")}`,
        )
        .join("\n");
      return `${source.key} — ${source.label}\n  fields:\n    ${fields}${relations ? `\n${relations}` : ""}`;
    })
    .join("\n\n");
}

export function nlProposalPrompt(question: string, sources: readonly DescribedSource[]) {
  return {
    system: `You translate a plain-language question into a structured query description over a fixed set of declared sources. You do not write SQL, and there is no SQL for you to write — the only thing you may produce is JSON matching the schema below.

Available sources and fields (only these may be named — anything else does not exist):

${describeSourcesForPrompt(sources)}

Return one of two shapes:

1. A proposal:
{
  "ok": true,
  "description": {
    "source": "<one source key above>",
    "select": [{ "kind": "field", "field": "<field name>" } | { "kind": "aggregate", "aggregate": "count|sum|avg|min|max", "field": "<field name, omit for count>" }],
    "filter": { "kind": "compare", "field": "<field>", "operator": "<op>", "value"|"values"|"from"/"to": ... } (optional, may nest and/or/not),
    "groupBy": ["<field>", ...] (optional),
    "orderBy": [{ "select": <index into select>, "direction": "asc"|"desc" }] (optional),
    "limit": <1-1000>,
    "offset": <optional>
  },
  "explanation": "<one or two sentences: what this returns and why it answers the question>"
}

2. A refusal, when the question has no expressible answer over the sources above — a field, comparison or aggregation the question needs simply is not there, or the question is ambiguous in a way that would make any single proposal misleading:
{ "ok": false, "reason": "<one or two sentences a person reads, naming what is missing>" }

Never guess a field or source name that is not listed above. Never propose a description you are not confident answers the question — refuse instead. Comparison operators: is_null/is_not_null (no value), eq/ne/lt/lte/gt/gte (value), in/not_in (values), between (from/to).`,
    user: question,
  };
}
