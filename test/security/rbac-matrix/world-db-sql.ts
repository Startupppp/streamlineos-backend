import { Column, Param, SQL, StringChunk, Table, getTableColumns, getTableName, is } from "drizzle-orm";

export type Row = Readonly<Record<string, unknown>>;
export type Truth = boolean | null;

export class UnsupportedQuery extends Error {
  constructor(detail: string) {
    super(`world-db: unsupported ${detail}`);
    this.name = "UnsupportedQuery";
  }
}

type Token =
  | { readonly kind: "column"; readonly column: Column }
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "list"; readonly values: readonly unknown[] }
  | { readonly kind: "word"; readonly text: string }
  | { readonly kind: "ident"; readonly text: string }
  | { readonly kind: "table"; readonly table: Table };

export type Lookup = (column: Column) => unknown;
export type Subselect = ((table: string, column: string, conditions: ReadonlyArray<readonly [string, unknown]>) => readonly unknown[]) & {
  readonly rowsOf?: (table: Table) => readonly Row[];
};

const NO_SUBSELECT: Subselect = (table) => {
  throw new UnsupportedQuery(`subselect over ${table}`);
};

const LEXEME = /\s*(<>|!=|>=|<=|=|<|>|\(|\)|,|'(?:[^']|'')*'|-?\d+(?:\.\d+)?|[A-Za-z_]+)\s*/y;
const KEYWORDS = new Set(["and", "or", "not", "is", "null", "in", "true", "false", "asc", "desc", "like", "ilike"]);
const COMPARATORS = new Set(["=", "<>", "!=", ">", ">=", "<", "<="]);
const SUBQUERY_CLAUSES = new Set(["select", "from", "inner", "left", "join", "on", "where", "limit"]);

const propertyCache = new Map<Column, string>();

export function propertyOf(column: Column): string {
  const cached = propertyCache.get(column);
  if (cached !== undefined) return cached;
  const columns: Record<string, Column> = getTableColumns(column.table);
  const property = Object.keys(columns).find((key) => columns[key] === column);
  if (property === undefined) throw new UnsupportedQuery(`column ${column.name} outside its table's column map`);
  propertyCache.set(column, property);
  return property;
}

function lex(text: string, out: Token[]): void {
  LEXEME.lastIndex = 0;
  let position = 0;
  while (position < text.length) {
    if (text.slice(position).trim() === "") return;
    LEXEME.lastIndex = position;
    const match = LEXEME.exec(text);
    if (match === null) throw new UnsupportedQuery(`sql fragment "${text}"`);
    position = LEXEME.lastIndex;
    const lexeme = match[1];
    if (lexeme.startsWith("'")) out.push({ kind: "value", value: lexeme.slice(1, -1).replace(/''/g, "'") });
    else if (/^-?\d/.test(lexeme)) out.push({ kind: "value", value: Number(lexeme) });
    else if (/^[A-Za-z_]/.test(lexeme)) {
      const word = lexeme.toLowerCase();
      out.push(KEYWORDS.has(word) ? { kind: "word", text: word } : { kind: "ident", text: word });
    } else out.push({ kind: "word", text: lexeme });
  }
}

function listValue(item: unknown): unknown {
  if (is(item, Param)) return item.value;
  if (is(item, Column) || is(item, SQL) || is(item, Table)) throw new UnsupportedQuery("non-literal list member");
  return item;
}

export function tokensOf(node: unknown, out: Token[] = []): Token[] {
  if (is(node, SQL)) {
    for (const chunk of node.queryChunks) tokensOf(chunk, out);
    return out;
  }
  if (is(node, SQL.Aliased)) return tokensOf(node.sql, out);
  if (is(node, StringChunk)) {
    lex(node.value.join(""), out);
    return out;
  }
  if (is(node, Column)) {
    out.push({ kind: "column", column: node });
    return out;
  }
  if (is(node, Param)) {
    if (is(node.value, SQL) || is(node.value, Column)) return tokensOf(node.value, out);
    out.push(Array.isArray(node.value) ? { kind: "list", values: node.value } : { kind: "value", value: node.value });
    return out;
  }
  if (Array.isArray(node)) {
    out.push({ kind: "list", values: node.map(listValue) });
    return out;
  }
  if (is(node, Table)) {
    out.push({ kind: "table", table: node });
    return out;
  }
  if (node === null || ["string", "number", "boolean", "bigint"].includes(typeof node)) {
    out.push({ kind: "value", value: node });
    return out;
  }
  if (node instanceof Date) {
    out.push({ kind: "value", value: node });
    return out;
  }
  throw new UnsupportedQuery(`sql chunk ${Object.prototype.toString.call(node)}`);
}

function comparable(value: unknown): unknown {
  if (value instanceof Date) return value.getTime();
  return value;
}

function compare(left: unknown, right: unknown): number | null {
  if (left === null || left === undefined || right === null || right === undefined) return null;
  let a = comparable(left);
  let b = comparable(right);
  if (typeof a === "number" && typeof b === "string" && b.trim() !== "" && !Number.isNaN(Number(b))) b = Number(b);
  if (typeof b === "number" && typeof a === "string" && a.trim() !== "" && !Number.isNaN(Number(a))) a = Number(a);
  if (typeof a === "string" && typeof b === "string") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : 1;
  if (typeof a !== typeof b) return 1;
  throw new UnsupportedQuery(`comparison of ${typeof a} values`);
}

function likeMatch(value: unknown, pattern: unknown, caseless: boolean): Truth {
  if (value === null || value === undefined || pattern === null || pattern === undefined) return null;
  if (typeof value !== "string" || typeof pattern !== "string") throw new UnsupportedQuery("like over a non-string");
  const escape = (char: string): string => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\" && index + 1 < pattern.length) {
      index += 1;
      source += escape(pattern[index]);
    } else if (char === "%") source += "[\\s\\S]*";
    else if (char === "_") source += "[\\s\\S]";
    else source += escape(char);
  }
  return new RegExp(`^${source}$`, caseless ? "i" : "").test(value);
}

function andOf(values: readonly Truth[]): Truth {
  if (values.includes(false)) return false;
  if (values.includes(null)) return null;
  return true;
}

function orOf(values: readonly Truth[]): Truth {
  if (values.includes(true)) return true;
  if (values.includes(null)) return null;
  return false;
}

class Parser {
  private position = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly lookup: Lookup,
    private readonly subselect: Subselect,
  ) {}

  done(): boolean {
    return this.position >= this.tokens.length;
  }

  private peekWord(): string | undefined {
    const token = this.tokens[this.position];
    return token?.kind === "word" ? token.text : undefined;
  }

  private take(word: string): boolean {
    if (this.peekWord() !== word) return false;
    this.position += 1;
    return true;
  }

  private expect(word: string): void {
    if (!this.take(word)) throw new UnsupportedQuery(`expected "${word}" in a predicate`);
  }

  expression(): Truth {
    const parts = [this.conjunction()];
    while (this.take("or")) parts.push(this.conjunction());
    return parts.length === 1 ? parts[0] : orOf(parts);
  }

  private conjunction(): Truth {
    const parts = [this.negation()];
    while (this.take("and")) parts.push(this.negation());
    return parts.length === 1 ? parts[0] : andOf(parts);
  }

  private negation(): Truth {
    if (this.take("not")) {
      const inner = this.negation();
      return inner === null ? null : !inner;
    }
    return this.primary();
  }

  private primary(): Truth {
    if (this.take("(")) {
      const inner = this.expression();
      this.expect(")");
      return inner;
    }
    if (this.take("true")) return true;
    if (this.take("false")) return false;
    if (this.identAt(this.position) === "exists") {
      this.position += 1;
      return this.subquery().length > 0;
    }
    const left = this.operand();
    if (this.take("is")) {
      const negated = this.take("not");
      this.expect("null");
      const isNull = left === null || left === undefined;
      return negated ? !isNull : isNull;
    }
    const negatedIn = this.take("not");
    if (this.take("in")) {
      if (this.peekWord() === "(" && this.identAt(this.position + 1) === "select") {
        const values = this.subqueryAt(this.position) ? this.subquery() : this.subselectValues();
        const found = orOf(values.map((value) => {
          const order = compare(left, value);
          return order === null ? null : order === 0;
        }));
        return negatedIn ? (found === null ? null : !found) : found;
      }
      const list = this.tokens[this.position];
      if (list?.kind !== "list") throw new UnsupportedQuery("in without a literal list");
      this.position += 1;
      const hits = list.values.map((value) => {
        const order = compare(left, value);
        return order === null ? null : order === 0;
      });
      const found = orOf(hits);
      return negatedIn ? (found === null ? null : !found) : found;
    }
    const like = this.peekWord();
    if (like === "like" || like === "ilike") {
      this.position += 1;
      const matched = likeMatch(left, this.operand(), like === "ilike");
      return negatedIn ? (matched === null ? null : !matched) : matched;
    }
    if (negatedIn) throw new UnsupportedQuery("dangling not in a predicate");
    const operator = this.peekWord();
    if (operator !== undefined && COMPARATORS.has(operator)) {
      this.position += 1;
      const order = compare(left, this.operand());
      if (order === null) return null;
      if (operator === "=") return order === 0;
      if (operator === "<>" || operator === "!=") return order !== 0;
      if (operator === ">") return order > 0;
      if (operator === ">=") return order >= 0;
      if (operator === "<") return order < 0;
      return order <= 0;
    }
    if (typeof left === "boolean" || left === null) return left;
    throw new UnsupportedQuery("non-boolean operand used as a predicate");
  }

  private identAt(position: number): string | undefined {
    const token = this.tokens[position];
    return token?.kind === "ident" ? token.text : undefined;
  }

  private ident(expected?: string): string {
    const text = this.identAt(this.position);
    if (text === undefined || (expected !== undefined && text !== expected))
      throw new UnsupportedQuery(`subselect shape near "${expected ?? "identifier"}"`);
    this.position += 1;
    return text;
  }

  private subselectValues(): readonly unknown[] {
    this.expect("(");
    this.ident("select");
    const column = this.ident();
    this.ident("from");
    const table = this.ident();
    this.ident("where");
    const conditions: Array<readonly [string, unknown]> = [];
    do {
      const name = this.ident();
      this.expect("=");
      conditions.push([name, this.operand()]);
    } while (this.take("and"));
    this.expect(")");
    return this.subselect(table, column, conditions);
  }

  private closingParen(open: number): number {
    let depth = 0;
    for (let index = open; index < this.tokens.length; index += 1) {
      const token = this.tokens[index];
      if (token.kind !== "word") continue;
      if (token.text === "(") depth += 1;
      if (token.text === ")") depth -= 1;
      if (depth === 0) return index;
    }
    throw new UnsupportedQuery("unbalanced parentheses around a subquery");
  }

  private topLevel(from: number, to: number): Array<readonly [number, string]> {
    const marks: Array<readonly [number, string]> = [];
    let depth = 0;
    for (let index = from; index < to; index += 1) {
      const token = this.tokens[index];
      if (token.kind === "word" && token.text === "(") depth += 1;
      else if (token.kind === "word" && token.text === ")") depth -= 1;
      else if (depth === 0 && token.kind === "ident" && SUBQUERY_CLAUSES.has(token.text)) marks.push([index, token.text]);
    }
    return marks;
  }

  subqueryAt(open: number): boolean {
    const token = this.tokens[open];
    if (token?.kind !== "word" || token.text !== "(" || this.identAt(open + 1) !== "select") return false;
    const close = this.closingParen(open);
    const from = this.topLevel(open + 1, close).find(([, text]) => text === "from");
    return from !== undefined && this.tokens[from[0] + 1]?.kind === "table";
  }

  private tableAt(index: number): Table {
    const token = this.tokens[index];
    if (token?.kind !== "table") throw new UnsupportedQuery("subquery source that is not a schema table");
    return token.table;
  }

  private nested(start: number, end: number, lookup: Lookup): Parser {
    return new Parser(this.tokens.slice(start, end), lookup, this.subselect);
  }

  subquery(): unknown[] {
    const rowsOf = this.subselect.rowsOf;
    if (rowsOf === undefined) throw new UnsupportedQuery("correlated subquery without a row source");
    const open = this.position;
    const close = this.closingParen(open);
    const marks = this.topLevel(open + 1, close);
    const boundary = (order: number): number => (order < marks.length ? marks[order][0] : close);
    const fromMark = marks.findIndex(([, text]) => text === "from");
    const source = this.tableAt(marks[fromMark][0] + 1);
    const outer = this.lookup;
    const scoped = (combo: ReadonlyMap<Table, Row | null>): Lookup => (column) => {
      if (!combo.has(column.table)) return outer(column);
      const row = combo.get(column.table);
      if (row === null || row === undefined) return null;
      const property = propertyOf(column);
      if (!(property in row))
        throw new UnsupportedQuery(`fixture row of ${getTableName(column.table)} has no ${property} column the subquery reads`);
      return row[property];
    };
    let combos: Array<ReadonlyMap<Table, Row | null>> = rowsOf(source).map((row) => new Map([[source, row]]));
    let where: readonly [number, number] | null = null;
    let cap = Number.POSITIVE_INFINITY;
    for (let order = fromMark + 1; order < marks.length; order += 1) {
      const [index, text] = marks[order];
      if (text === "join") {
        const outerJoin = marks[order - 1]?.[1] === "left";
        const joined = this.tableAt(index + 1);
        const onOrder = order + 1;
        if (marks[onOrder]?.[1] !== "on") throw new UnsupportedQuery("subquery join without on");
        const onStart = marks[onOrder][0] + 1;
        const onEnd = boundary(onOrder + 1);
        const candidates = rowsOf(joined);
        combos = combos.flatMap((combo) => {
          const matched = candidates
            .map((row): ReadonlyMap<Table, Row | null> => new Map([...combo, [joined, row]]))
            .filter((next) => this.nested(onStart, onEnd, scoped(next)).expression() === true);
          if (matched.length > 0 || !outerJoin) return matched;
          return [new Map([...combo, [joined, null]])];
        });
      } else if (text === "where") where = [index + 1, boundary(order + 1)];
      else if (text === "limit") {
        const limit = this.tokens[index + 1];
        if (limit?.kind !== "value" || typeof limit.value !== "number") throw new UnsupportedQuery("subquery limit");
        cap = limit.value;
      }
    }
    const span = where;
    const kept = span === null
      ? combos
      : combos.filter((combo) => this.nested(span[0], span[1], scoped(combo)).expression() === true);
    const selectEnd = marks[fromMark][0];
    const values = kept.slice(0, cap).map((combo) => this.nested(open + 2, selectEnd, scoped(combo)).operand());
    this.position = close + 1;
    return values;
  }

  operand(): unknown {
    if (this.subqueryAt(this.position)) return this.subquery()[0] ?? null;
    const token = this.tokens[this.position];
    if (token === undefined) throw new UnsupportedQuery("predicate ended early");
    this.position += 1;
    if (token.kind === "column") return this.lookup(token.column);
    if (token.kind === "value") return token.value;
    if (token.kind === "word" && token.text === "null") return null;
    throw new UnsupportedQuery(`operand "${token.kind === "word" || token.kind === "ident" ? token.text : token.kind}"`);
  }
}

export function evaluate(node: unknown, lookup: Lookup, subselect: Subselect = NO_SUBSELECT): Truth {
  if (node === undefined) return true;
  const parser = new Parser(tokensOf(node), lookup, subselect);
  const truth = parser.expression();
  if (!parser.done()) throw new UnsupportedQuery("trailing tokens after a predicate");
  return truth;
}

export function scalar(node: unknown, lookup: Lookup, subselect: Subselect = NO_SUBSELECT): unknown {
  if (is(node, Column)) return lookup(node);
  const tokens = tokensOf(node);
  if (tokens.length === 1 && tokens[0].kind === "column") return lookup(tokens[0].column);
  if (tokens.length === 1 && tokens[0].kind === "value") return tokens[0].value;
  const parser = new Parser(tokens, lookup, subselect);
  if (parser.subqueryAt(0)) {
    const value = parser.operand();
    if (parser.done()) return value;
  }
  return evaluate(node, lookup, subselect);
}

export function orderKey(node: unknown): { readonly column: Column; readonly descending: boolean } {
  if (is(node, Column)) return { column: node, descending: false };
  const tokens = tokensOf(node);
  const [first, second] = tokens;
  if (first?.kind !== "column" || tokens.length > 2) throw new UnsupportedQuery("orderBy expression");
  if (second === undefined) return { column: first.column, descending: false };
  if (second.kind !== "word" || (second.text !== "asc" && second.text !== "desc"))
    throw new UnsupportedQuery("orderBy direction");
  return { column: first.column, descending: second.text === "desc" };
}

export function compareRows(left: unknown, right: unknown): number {
  return compare(left, right) ?? (left === null || left === undefined ? 1 : -1);
}

export function sqlText(node: unknown): string {
  if (is(node, SQL)) return node.queryChunks.map(sqlText).join("");
  if (is(node, StringChunk)) return node.value.join("");
  return "?";
}
