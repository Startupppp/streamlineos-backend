import { Column, Param, SQL, StringChunk, Table, getTableColumns, is } from "drizzle-orm";
import { UnsupportedQuery } from "./world-db-values";

export type Token =
  | { readonly kind: "column"; readonly column: Column }
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "list"; readonly values: readonly unknown[] }
  | { readonly kind: "word"; readonly text: string }
  | { readonly kind: "ident"; readonly text: string }
  | { readonly kind: "table"; readonly table: Table };

const LEXEME = /\s*(<>|!=|>=|<=|=|<|>|\(|\)|,|\*|\/|\|\||::|'(?:[^']|'')*'|-?\d+(?:\.\d+)?|\.|\+|-|[A-Za-z_]+)\s*/y;
const KEYWORDS = new Set(["and", "or", "not", "is", "null", "in", "true", "false", "asc", "desc", "like", "ilike"]);

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

const RESERVED = new Set(["select", "from", "where", "inner", "left", "join", "on", "limit", "group", "order"]);

function aliasedColumn(table: Table, name: string): Column {
  const column = Object.values(getTableColumns(table)).find((candidate) => candidate.name === name);
  if (column === undefined) throw new UnsupportedQuery(`raw column ${name} outside its table`);
  return column;
}

export function resolveRawNames(tokens: readonly Token[], tableNamed: ((name: string) => Table | undefined) | undefined): Token[] {
  if (tableNamed === undefined) return [...tokens];
  const aliases = new Map<string, Table>();
  const sourced: Token[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const name = tokens[index + 1];
    const table = token.kind === "ident" && token.text === "from" && name?.kind === "ident" ? tableNamed(name.text) : undefined;
    const alias = tokens[index + 2];
    sourced.push(token);
    if (table === undefined || alias?.kind !== "ident" || RESERVED.has(alias.text)) continue;
    if (tokens.some((other) => other.kind === "column" && other.column.table === table))
      throw new UnsupportedQuery("a raw alias over a table the statement also names directly, whose columns would be indistinguishable");
    sourced.push({ kind: "table", table });
    aliases.set(alias.text, table);
    index += 2;
  }
  const out: Token[] = [];
  for (let index = 0; index < sourced.length; index += 1) {
    const token = sourced[index];
    const dot = sourced[index + 1];
    const column = sourced[index + 2];
    const table = token.kind === "ident" ? aliases.get(token.text) : undefined;
    if (table !== undefined && dot?.kind === "word" && dot.text === "." && column?.kind === "ident") {
      out.push({ kind: "column", column: aliasedColumn(table, column.text) });
      index += 2;
    } else out.push(token);
  }
  return out;
}
