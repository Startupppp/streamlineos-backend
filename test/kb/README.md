# Seeded KB visibility tests

The seeded parity test requires a reachable PostgreSQL database supplied through
`DATABASE_URL`. The database must already have the current migrations applied,
the `vector` extension enabled, and the KB/RLS schema available; the test uses
the owner connection to seed its isolated organization and starts the real
`AppModule` for service execution. No `OPENAI_API_KEY` is required because the
test replaces only the outbound embedding call with a deterministic 1536-value
vector; pgvector storage, candidate retrieval, and visibility predicates still
run against PostgreSQL.

Run it from `backend` with:

```sh
DATABASE_URL=<owner-postgres-url> pnpm test:e2e:seeded -- --runTestsByPath test/kb/kb-page-visibility.seeded-e2e-spec.ts
```

If `DATABASE_URL` or the migrated pgvector database is unavailable, the test
cannot provide runtime evidence. TypeScript compilation still verifies the
test and the command above is the exact prerequisite for the seeded proof.
