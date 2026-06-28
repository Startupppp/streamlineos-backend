/**
 * Syncs the permission catalog (src/common/access/catalog.ts) to the permissions DB table.
 * Run: node scripts/seed-permissions.mjs
 *
 * Requires DATABASE_URL env var (loaded from .env if present).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);

// Load .env if present
try {
  const { config } = await import("dotenv");
  config({ path: resolve(process.cwd(), ".env") });
} catch {
  // dotenv optional
}

const { neon } = await import("@neondatabase/serverless");
const { drizzle } = await import("drizzle-orm/neon-http");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const CATALOG = [
  { key: "hr:employees:view", resource: "employees", action: "view", description: "View employees" },
  { key: "hr:employees:create", resource: "employees", action: "create", description: "Create employees" },
  { key: "hr:employees:update", resource: "employees", action: "update", description: "Update employees" },
  { key: "hr:employees:delete", resource: "employees", action: "delete", description: "Delete employees" },
  { key: "hr:payroll:view", resource: "payroll", action: "view", description: "View payroll" },
  { key: "hr:payroll:manage", resource: "payroll", action: "manage", description: "Manage payroll" },
  { key: "hr:recruitment:view", resource: "recruitment", action: "view", description: "View recruitment" },
  { key: "hr:recruitment:manage", resource: "recruitment", action: "manage", description: "Manage recruitment" },
  { key: "crm:leads:view", resource: "leads", action: "view", description: "View leads" },
  { key: "crm:leads:create", resource: "leads", action: "create", description: "Create leads" },
  { key: "crm:leads:update", resource: "leads", action: "update", description: "Update leads" },
  { key: "crm:leads:delete", resource: "leads", action: "delete", description: "Delete leads" },
  { key: "crm:contacts:view", resource: "contacts", action: "view", description: "View CRM contacts" },
  { key: "crm:contacts:manage", resource: "contacts", action: "manage", description: "Manage CRM contacts" },
  { key: "inventory:products:view", resource: "products", action: "view", description: "View products" },
  { key: "inventory:products:manage", resource: "products", action: "manage", description: "Manage products" },
  { key: "inventory:orders:view", resource: "orders", action: "view", description: "View orders" },
  { key: "inventory:orders:manage", resource: "orders", action: "manage", description: "Manage orders" },
  { key: "settings:rbac:manage", resource: "rbac", action: "manage", description: "Manage roles & permissions" },
  { key: "settings:org:manage", resource: "org", action: "manage", description: "Manage organization settings" },
  { key: "settings:billing:manage", resource: "billing", action: "manage", description: "Manage billing" },
  { key: "settings:automations:view", resource: "automations", action: "view", description: "View automations" },
  { key: "settings:automations:manage", resource: "automations", action: "manage", description: "Manage automations" },
  { key: "settings:custom-fields:manage", resource: "custom-fields", action: "manage", description: "Manage custom fields" },
  { key: "settings:integrations:manage", resource: "integrations", action: "manage", description: "Manage integrations" },
  { key: "kb:articles:view", resource: "articles", action: "view", description: "View knowledge base articles" },
  { key: "kb:articles:manage", resource: "articles", action: "manage", description: "Manage knowledge base articles" },
];

const sql = neon(url);
const db = drizzle(sql);

console.log(`Seeding ${CATALOG.length} permissions...`);

for (const entry of CATALOG) {
  await sql`
    INSERT INTO permissions (name, resource, action, description)
    VALUES (${entry.key}, ${entry.resource}, ${entry.action}, ${entry.description})
    ON CONFLICT (name) DO UPDATE SET
      resource = EXCLUDED.resource,
      action = EXCLUDED.action,
      description = EXCLUDED.description
  `;
  console.log(`  ✓ ${entry.key}`);
}

console.log("Done.");
