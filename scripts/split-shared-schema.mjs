import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

// c23-05: shared.ts holds eight unrelated domains, so importing one drags in all of them.
// Declarations are interleaved, so blocks are extracted per declaration with their leading
// comments rather than by line range.

const SRC = "src/db/schema/common/shared.ts";
const OUT_DIR = "src/db/schema/common";

const GROUPS = {
  "notifications.ts": [
    "notifications",
    "notificationReadWatermarks",
    "notificationTemplates",
    "notificationAuditLogs",
    "notificationPreferences",
    "notificationsRelations",
    "notificationTemplatesRelations",
    "notificationAuditLogsRelations",
  ],
  "broadcasts.ts": ["broadcasts", "broadcastsRelations"],
  "push-subscriptions.ts": ["pushSubscriptions", "pushSubscriptionsRelations"],
  "calendar-events.ts": [
    "calendarEvents",
    "eventAttendees",
    "calendarEventsRelations",
    "eventAttendeesRelations",
  ],
  "webhooks.ts": ["webhookEndpoints", "webhookLogs"],
  "subscriptions.ts": [
    "subscriptions",
    "subscriptionPayments",
    "coupons",
    "couponRedemptions",
    "subscriptionsRelations",
    "subscriptionPaymentsRelations",
    "couponsRelations",
    "couponRedemptionsRelations",
  ],
  "audit-logs.ts": ["auditLogs"],
  "ai-usage.ts": ["aiUsageLogs"],
};

const PG_CORE = [
  "pgTable", "text", "serial", "timestamp", "boolean", "jsonb", "integer", "bigint",
  "index", "unique", "uniqueIndex", "numeric", "varchar", "primaryKey", "foreignKey", "check",
];
const DRIZZLE = ["relations", "sql"];
const ENUMS = [
  "notificationTypeEnum", "notificationPriorityEnum", "notificationCategoryEnum",
  "broadcastStatusEnum", "notificationChannelEnum", "subscriptionStatusEnum",
  "subscriptionPlanEnum", "broadcastAudienceTypeEnum", "templateApprovalStatusEnum",
];
const AUTH = ["organizations", "users"];

const src = readFileSync(SRC, "utf8");
const lines = src.split("\n");

const starts = [];
lines.forEach((line, i) => {
  const m = /^export const ([A-Za-z0-9_]+)\s*=/.exec(line);
  if (m) starts.push({ name: m[1], line: i });
});

// Walk back over the declaration's own leading comments and blank line.
function blockStart(declLine) {
  let i = declLine;
  while (i > 0) {
    const prev = lines[i - 1].trim();
    if (prev.startsWith("//") || prev.startsWith("*") || prev.startsWith("/*") || prev.endsWith("*/")) {
      i -= 1;
      continue;
    }
    break;
  }
  return i;
}

const blocks = new Map();
for (let k = 0; k < starts.length; k += 1) {
  const from = blockStart(starts[k].line);
  const to = k + 1 < starts.length ? blockStart(starts[k + 1].line) : lines.length;
  blocks.set(starts[k].name, lines.slice(from, to).join("\n").replace(/\s+$/, ""));
}

const owner = new Map();
for (const [file, names] of Object.entries(GROUPS)) for (const n of names) owner.set(n, file);
const unassigned = [...blocks.keys()].filter((n) => !owner.has(n));
if (unassigned.length) {
  process.stderr.write(`unassigned declarations: ${unassigned.join(", ")}\n`);
  process.exit(1);
}

for (const [file, names] of Object.entries(GROUPS)) {
  const body = names.map((n) => blocks.get(n)).join("\n\n");
  const used = (list) => list.filter((s) => new RegExp(`\\b${s}\\b`).test(body));
  const imports = [];
  const core = used(PG_CORE);
  if (core.length) imports.push(`import { ${core.join(", ")} } from "drizzle-orm/pg-core";`);
  const dz = used(DRIZZLE);
  if (dz.length) imports.push(`import { ${dz.join(", ")} } from "drizzle-orm";`);
  const en = used(ENUMS);
  if (en.length) imports.push(`import {\n  ${en.join(",\n  ")},\n} from "./enums";`);
  const au = used(AUTH);
  if (au.length) imports.push(`import { ${au.join(", ")} } from "./auth";`);
  writeFileSync(`${OUT_DIR}/${file}`, `${imports.join("\n")}\n\n${body}\n`);
  process.stdout.write(`${file}: ${names.length} declarations\n`);
}

unlinkSync(SRC);
process.stdout.write("shared.ts removed\n");
