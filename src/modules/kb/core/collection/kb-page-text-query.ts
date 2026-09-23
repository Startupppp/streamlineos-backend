import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

const MAX_TERMS = 8;

export function kbPagePrefixTsQuery(q: string): SQL<unknown> | null {
  const terms = q
    .trim()
    .split(/\s+/)
    .map(function stripPunctuation(word) {
      return word.replace(/[^\p{L}\p{N}]/gu, "");
    })
    .filter(function nonEmpty(word) {
      return word.length > 0;
    })
    .slice(0, MAX_TERMS);

  if (terms.length === 0) return null;

  const prefixQuery = terms
    .map(function toPrefix(term) {
      return `${term}:*`;
    })
    .join(" & ");

  return sql`to_tsquery('english', ${prefixQuery})`;
}
