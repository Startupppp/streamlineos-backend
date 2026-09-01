import { readFileSync } from "node:fs";
import postgres from "postgres";
const j = JSON.parse(readFileSync("./.branch.tmp.json", "utf8"));
const base = `postgresql://${j.role}:${encodeURIComponent(j.password)}@${j.host}/neondb?sslmode=require`;
const admin = postgres(base, { prepare: false, max: 1, onnotice: () => {} });
try {
  const existing = await admin`SELECT 1 FROM pg_database WHERE datname='coldboot'`;
  if (existing.length === 0) await admin.unsafe(`CREATE DATABASE coldboot`);
  console.log("coldboot database ready");
} finally { await admin.end(); }

const coldUrl = `postgresql://${j.role}:${encodeURIComponent(j.password)}@${j.host}/coldboot?sslmode=require`;
const cold = postgres(coldUrl, { prepare: false, max: 1, onnotice: () => {} });
try {
  for (const ext of ["vector", "pg_trgm", "btree_gist", "pgcrypto", "uuid-ossp"]) {
    await cold.unsafe(`CREATE EXTENSION IF NOT EXISTS "${ext}"`);
  }
  const rows = await cold`SELECT extname FROM pg_extension ORDER BY extname`;
  console.log("extensions:", rows.map(r => r.extname).join(", "));
  const [t] = await cold`SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'`;
  console.log("public tables before chain:", t.n);
} finally { await cold.end(); }
console.log("COLD_URL=" + coldUrl);
