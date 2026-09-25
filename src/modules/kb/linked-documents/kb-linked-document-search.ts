import { sql, type SQL } from "drizzle-orm";
import { documents } from "../../../db/schema";

const MAX_TERMS = 12;
const MIN_TERM_LENGTH = 2;

/**
 * The words of a free-text question, reduced to letters and digits so they can be handed to `to_tsquery` without
 * any of its operator syntax coming with them.
 */
export function searchTerms(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    if (match[0].length < MIN_TERM_LENGTH) continue;
    seen.add(match[0]);
    if (seen.size === MAX_TERMS) break;
  }
  return [...seen];
}

// What is searched is the document's own metadata, read from the joined row at query time. There is no copy of it
// anywhere to go stale, and no text of the file: nothing here reads, extracts or indexes an HR file.
const vector = sql`to_tsvector('english', concat_ws(' ', ${documents.name}, ${documents.description}, ${documents.category}, array_to_string(${documents.tags}, ' ')))`;

export interface MetadataSearch {
  match: SQL;
  rank: SQL;
}

/**
 * `all`: every word must be present, what a person typing in a search box expects. `any`: a question in a sentence
 * ("how many days of leave do I get") shares only some of its words with the policy that answers it, so a word is
 * enough and the best match ranks first. Null when the text holds no usable word, which finds nothing.
 */
export function metadataSearch(text: string, mode: "all" | "any"): MetadataSearch | null {
  const terms = searchTerms(text);
  if (terms.length === 0) return null;
  const query = mode === "all" ? sql`websearch_to_tsquery('english', ${terms.join(" ")})` : sql`to_tsquery('english', ${terms.join(" | ")})`;
  return { match: sql`(${vector} @@ ${query})`, rank: sql`ts_rank(${vector}, ${query})` };
}
