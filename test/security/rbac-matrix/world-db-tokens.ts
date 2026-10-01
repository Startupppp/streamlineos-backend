import { Column, Param, SQL, StringChunk, Table, is } from "drizzle-orm";
import { UnsupportedQuery } from "./world-db-values";

export type Token =
  | { readonly kind: "column"; readonly column: Column }
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "list"; readonly values: readonly unknown[] }
  | { readonly kind: "word"; readonly text: string }
  | { readonly kind: "ident"; readonly text: string }
  | { readonly kind: "table"; readonly table: Table };

const LEXEME = /\s*(<>|!=|>=|<=|=|<|>|\(|\)|,|\*|\/|\|\||::|'(?:[^']|'')*'|-?\d+(?:\.\d+)?|\+|-|[A-Za-z_]+)\s*/y;
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
