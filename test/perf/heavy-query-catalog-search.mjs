/**
 * Search read paths: ANN vector retrieval and the trigram/tsvector text search, each measured
 * both through its SECURITY DEFINER wrapper and directly under RLS.
 *
 * Transcribed from the service that owns each query: same projection, same predicates, same
 * ORDER BY, same LIMIT. A `compare` tag pairs two shapes so the runner prints them adjacently.
 */

export const SEARCH_QUERIES = [
  {
    id: "vector-ann-security-definer",
    category: "search/vector",
    compare: "ann",
    source: "app.search_kb_chunk_ids (migration-defined SECURITY DEFINER wrapper)",
    note: "the only ANN entry point; its CTE is AS MATERIALIZED",
    params: (f) => [f.queryVector],
    sql: `SELECT id FROM app.search_kb_chunk_ids($1::vector, 20) AS id`,
  },
  {
    id: "vector-ann-direct-under-rls",
    category: "search/vector",
    compare: "ann",
    note: "the same search issued directly by the app role — HNSW ordering is post-filtered by RLS",
    params: (f) => [f.queryVector],
    sql: `
      SELECT id
      FROM kb_article_chunks
      ORDER BY embedding <=> $1::vector
      LIMIT 20`,
  },
  {
    id: "vector-ann-org-filtered-direct",
    category: "search/vector",
    compare: "ann",
    note: "explicit org predicate as well as RLS — does the planner still choose the HNSW index?",
    params: (f) => [f.queryVector, f.orgId],
    sql: `
      SELECT id
      FROM kb_article_chunks
      WHERE org_id = $2
      ORDER BY embedding <=> $1::vector
      LIMIT 20`,
  },
  {
    id: "search-trigram-security-definer",
    category: "search/vector",
    compare: "text-search",
    source: "app.search_kb_page_ids",
    params: (f) => [f.searchTerm],
    sql: `SELECT id FROM app.search_kb_page_ids($1, 50) AS id`,
  },
  {
    id: "search-ticket-trigram-sdf",
    category: "search/vector",
    compare: "ticket-search",
    source: "app.search_ticket_ids — the canonical SECURITY DEFINER escape",
    note: "ILIKE inside the definer, backed by idx_tickets_title_trgm; 18,500 tickets in the large org",
    params: (f) => [f.ticketTerm],
    sql: `SELECT id FROM app.search_ticket_ids($1, 50) AS id`,
  },
  {
    id: "search-ticket-ilike-under-rls",
    category: "search/vector",
    compare: "ticket-search",
    note: "the same predicate issued by the app role — trigram GIN under RLS",
    params: (f) => [f.orgId, f.ticketTermLike],
    sql: `
      SELECT id, title
      FROM build.tickets
      WHERE org_id = $1 AND deleted_at IS NULL AND title ILIKE $2
      LIMIT 50`,
  },
  {
    id: "search-kbpage-fts-under-rls",
    category: "search/vector",
    compare: "text-search",
    note: "the tsvector operator the SDF wraps, issued directly by the app role",
    params: (f) => [f.orgId, f.searchTerm],
    sql: `
      SELECT id
      FROM kb_pages
      WHERE org_id = $1 AND deleted_at IS NULL
        AND fts @@ websearch_to_tsquery('english', $2)
      LIMIT 50`,
  },
  {
    id: "search-ilike-under-rls",
    category: "search/vector",
    compare: "text-search",
    note: "the fallback the SDF exists to avoid, measured as the app role",
    params: (f) => [f.orgId, f.searchTermLike],
    sql: `
      SELECT id, title
      FROM kb_pages
      WHERE org_id = $1 AND deleted_at IS NULL AND title ILIKE $2
      ORDER BY updated_at DESC
      LIMIT 50`,
  },
];
