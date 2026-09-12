/**
 * Reading a Drizzle expression for the tenant recorder: the tokens a `where`, a
 * join condition or a raw `sql` template is made of, and from them the
 * `column = value` equalities it binds. `tenant-recorder.ts` filters its
 * fixtures by these and re-exports `equalities`, `orgBindings` and `sqlValues`;
 * import them from there.
 */
import { Column, Param, SQL, StringChunk, Table, is } from "drizzle-orm";

// ─── Reading a predicate ────────────────────────────────────────────────────

type Token =
  | { kind: "text"; text: string }
  | { kind: "column"; column: Column }
  | { kind: "value"; value: unknown }
  | { kind: "other" };

function collect(node: unknown, out: Token[], seen: Set<object>): void {
  if (node === null || node === undefined) return;
  if (typeof node === "function") {
    out.push({ kind: "other" });
    return;
  }
  if (typeof node !== "object") {
    out.push({ kind: "value", value: node });
    return;
  }
  if (is(node, Column)) {
    out.push({ kind: "column", column: node });
    return;
  }
  if (is(node, Param)) {
    out.push({ kind: "value", value: node.value });
    return;
  }
  if (is(node, StringChunk)) {
    out.push({ kind: "text", text: node.value.join("") });
    return;
  }
  if (is(node, Table)) {
    out.push({ kind: "other" });
    return;
  }
  if (seen.has(node)) return;
  seen.add(node);
  if (is(node, SQL)) {
    for (const chunk of node.queryChunks) collect(chunk, out, seen);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out, seen);
    return;
  }
  const record = node as { sql?: unknown; getSQL?: () => unknown; where?: unknown };
  if (record.sql !== undefined) {
    collect(record.sql, out, seen);
    return;
  }
  if (typeof record.getSQL === "function") {
    collect(record.getSQL(), out, seen);
    return;
  }
  // The relational reader hands over an options object, not the predicate.
  if (record.where !== undefined) collect(record.where, out, seen);
}

/** Adjacent string chunks merged, so `eq` inside `and(...)` reads as column, " = ", value. */
function tokensOf(expression: unknown): Token[] {
  const raw: Token[] = [];
  collect(expression, raw, new Set());
  const merged: Token[] = [];
  for (const token of raw) {
    const last = merged[merged.length - 1];
    if (token.kind === "text" && last?.kind === "text") last.text += token.text;
    else merged.push(token.kind === "text" ? { kind: "text", text: token.text } : token);
  }
  return merged;
}

/**
 * Every `column = value` equality bound in an expression.
 *
 * Covers both spellings the codebase uses: `eq(col, v)`, which binds a `Param`,
 * and a raw `sql\`${col} = ${v}\``, which leaves the value as a bare chunk.
 * A column compared with another column (a join key) binds no value and is not
 * returned — that is not a tenant predicate, it is a correlation.
 */
export function equalities(expression: unknown): Array<{ column: Column; value: unknown }> {
  const tokens = tokensOf(expression);
  const found: Array<{ column: Column; value: unknown }> = [];
  for (let i = 0; i + 2 < tokens.length; i++) {
    const [left, op, right] = [tokens[i]!, tokens[i + 1]!, tokens[i + 2]!];
    if (left.kind === "column" && op.kind === "text" && op.text.trim() === "=" && right.kind === "value")
      found.push({ column: left.column, value: right.value });
  }
  return found;
}

/** The values an expression binds to one column by equality — the tenant predicate, for the org column. */
export function orgBindings(expression: unknown, orgColumn: Column): unknown[] {
  return equalities(expression)
    .filter((binding) => binding.column === orgColumn)
    .map((binding) => binding.value);
}

/** Every scalar bound anywhere in an expression, the house `sqlValues` walk. */
export function sqlValues(expression: unknown): unknown[] {
  return tokensOf(expression)
    .filter((token): token is { kind: "value"; value: unknown } => token.kind === "value")
    .map((token) => token.value);
}
