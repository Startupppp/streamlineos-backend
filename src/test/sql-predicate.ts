import { Column, Param, SQL, StringChunk, getTableName } from "drizzle-orm";

export type FakeRow = Record<string, unknown>;
export type RowSets = Record<string, FakeRow[]>;

type Token =
  | { kind: "text"; text: string }
  | { kind: "column"; table: string; column: string }
  | { kind: "value"; value: unknown };

function flatten(node: unknown, out: Token[]): void {
  if (node instanceof SQL) {
    for (const chunk of node.queryChunks as unknown[]) flatten(chunk, out);
    return;
  }
  if (node instanceof StringChunk) {
    const raw = (node as unknown as { value: string[] }).value;
    out.push({ kind: "text", text: raw.join("") });
    return;
  }
  if (node instanceof Column) {
    out.push({ kind: "column", table: getTableName(node.table), column: node.name });
    return;
  }
  if (node instanceof Param) {
    out.push({ kind: "value", value: (node as unknown as { value: unknown }).value });
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) flatten(item, out);
    return;
  }
  throw new Error(`sql-predicate: unsupported chunk ${String(node)}`);
}

const KEYWORDS =
  /(\(|\)|,|\bis not null\b|\bis null\b|\band\b|\bor\b|\bnot\b|\bilike\b|\bin\b|\blower\b|\btrue\b|\bfalse\b|<>|>=|<=|=|>|<)/i;

function tokenize(node: SQL): Token[] {
  const raw: Token[] = [];
  flatten(node, raw);
  const merged: Token[] = [];
  for (const token of raw) {
    if (token.kind !== "text") {
      merged.push(token);
      continue;
    }
    const text = token.text.replace(/\s+/g, " ");
    if (text === "") continue;
    const previous = merged.at(-1);
    if (previous?.kind === "text") previous.text = `${previous.text}${text}`;
    else merged.push({ kind: "text", text });
  }
  return merged.flatMap((token) =>
    token.kind === "text"
      ? token.text
          .split(KEYWORDS)
          .map((piece) => piece.trim())
          .filter((piece) => piece !== "")
          .map((piece): Token => ({ kind: "text", text: piece }))
      : [token],
  );
}

export class RowScope {
  constructor(private readonly rows: RowSets) {}

  read(table: string, column: string): unknown {
    const row = this.rows[table];
    if (row === undefined) throw new Error(`sql-predicate: no bound row for table ${table}`);
    const only = row[0];
    return only === undefined ? null : (only[column] ?? null);
  }
}

function compare(operator: string, left: unknown, right: unknown): boolean {
  const l = left instanceof Date ? left.getTime() : left;
  const r = right instanceof Date ? right.getTime() : right;
  switch (operator) {
    case "=":
      return l === r;
    case "<>":
      return l !== r;
    case ">":
      return (l as number) > (r as number);
    case ">=":
      return (l as number) >= (r as number);
    case "<":
      return (l as number) < (r as number);
    case "<=":
      return (l as number) <= (r as number);
    default:
      throw new Error(`sql-predicate: unsupported operator ${operator}`);
  }
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly scope: RowScope,
  ) {}

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private text(): string | null {
    const token = this.peek();
    return token?.kind === "text" ? token.text.toLowerCase() : null;
  }

  parse(): boolean {
    const value = this.expression();
    if (this.index !== this.tokens.length) {
      throw new Error(`sql-predicate: trailing tokens at ${this.index}`);
    }
    return value;
  }

  private expression(): boolean {
    let value = this.term();
    for (;;) {
      const text = this.text();
      if (text !== "and" && text !== "or") return value;
      this.index += 1;
      const right = this.term();
      value = text === "and" ? value && right : value || right;
    }
  }

  private term(): boolean {
    if (this.text() === "(") {
      this.index += 1;
      const value = this.expression();
      if (this.text() !== ")") throw new Error("sql-predicate: unbalanced parenthesis");
      this.index += 1;
      return value;
    }
    if (this.text() === "not") {
      this.index += 1;
      return !this.term();
    }
    const literal = this.text();
    if (literal === "true" || literal === "false") {
      this.index += 1;
      return literal === "true";
    }
    return this.comparison();
  }

  private operand(): unknown {
    const token = this.peek();
    if (token === undefined) throw new Error("sql-predicate: expected an operand");
    this.index += 1;
    if (token.kind === "column") return this.scope.read(token.table, token.column);
    if (token.kind === "value") return token.value;
    if (token.text.toLowerCase() === "lower") {
      if (this.text() !== "(") throw new Error("sql-predicate: expected lower(");
      this.index += 1;
      const inner = this.operand();
      if (this.text() !== ")") throw new Error("sql-predicate: expected )");
      this.index += 1;
      return typeof inner === "string" ? inner.toLowerCase() : inner;
    }
    throw new Error(`sql-predicate: unsupported operand ${token.text}`);
  }

  private comparison(): boolean {
    const left = this.operand();
    const operator = this.text();
    if (operator === null) throw new Error("sql-predicate: expected an operator");
    this.index += 1;
    if (operator === "is null") return left === null || left === undefined;
    if (operator === "is not null") return left !== null && left !== undefined;
    if (operator === "ilike") {
      const pattern = String(this.operand());
      const expression = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`, "i");
      return typeof left === "string" && expression.test(left);
    }
    if (operator === "in") {
      const values: unknown[] = [];
      // `inArray` renders its members as a bare parameter array with no
      // parentheses and no separators, so the parenthesised form is only one of
      // the two shapes that reach here.
      if (this.text() === "(") {
        this.index += 1;
        while (this.text() !== ")") {
          if (this.text() === ",") this.index += 1;
          else values.push(this.operand());
        }
        this.index += 1;
      } else {
        while (this.peek()?.kind === "value") values.push(this.operand());
        if (values.length === 0) throw new Error("sql-predicate: expected in (");
      }
      return values.includes(left);
    }
    return compare(operator, left, this.operand());
  }
}

export function matchesPredicate(predicate: SQL | undefined, rows: RowSets): boolean {
  if (predicate === undefined) return true;
  return new Parser(tokenize(predicate), new RowScope(rows)).parse();
}
