import { sql, type SQL } from "drizzle-orm";
import { documents } from "../../../db/schema";

const MAX_TERMS = 12;
const MIN_TERM_LENGTH = 2;

export function searchTerms(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    if (match[0].length < MIN_TERM_LENGTH) continue;
    seen.add(match[0]);
    if (seen.size === MAX_TERMS) break;
  }
  return [...seen];
}

const vector = sql`to_tsvector('english', concat_ws(' ', ${documents.name}, ${documents.description}, ${documents.category}, array_to_string(${documents.tags}, ' ')))`;

export interface MetadataSearch {
  match: SQL;
  rank: SQL;
}

export function metadataSearch(text: string, mode: "all" | "any"): MetadataSearch | null {
  const terms = searchTerms(text);
  if (terms.length === 0) return null;
  const query = mode === "all" ? sql`websearch_to_tsquery('english', ${terms.join(" ")})` : sql`to_tsquery('english', ${terms.join(" | ")})`;
  return { match: sql`(${vector} @@ ${query})`, rank: sql`ts_rank(${vector}, ${query})` };
}
