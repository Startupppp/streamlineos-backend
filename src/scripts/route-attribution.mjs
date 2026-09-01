/**
 * Route-to-module attribution.
 *
 * Maps an API route's first path segment (namespace) to the owning module and
 * its SLO owner using the same logic as moduleOwningNamespace() in
 * module-vocabulary.ts — derived from MODULE_REGISTRY.administersNamespaces.
 *
 * Three outcome shapes for resolveRouteAttribution(namespace):
 *   { module, owner }                        — a covered module owns it
 *   { platform: true, owner }                — a declared shared platform surface
 *   { sloExcluded: true, module, owner }     — known module outside SLO scope
 *   { unattributable: true, namespace }      — not registered and not declared platform;
 *                                              a new namespace that nobody claimed
 *
 * Usage:
 *   import { resolveRouteAttribution, extractNamespaceFromSpanName } from "./route-attribution.mjs";
 *   node src/scripts/route-attribution.mjs --self-test
 */

/**
 * Namespace-to-module-id overrides.
 * Two sources:
 * 1. MODULE_REGISTRY.administersNamespaces: Home administers chat/mail/calendar/notifications;
 *    CRM administers party.  The same logic as moduleOwningNamespace() in module-vocabulary.ts.
 * 2. Route-segment exceptions where the first API path segment differs from the module id:
 *    /knowledge/... → kb module (id "kb", route "/knowledge")
 *    /dashboard/... → home module (id "home", route "/dashboard")
 */
const NAMESPACE_TO_MODULE_ID = {
  party: "crm",
  chat: "home",
  mail: "home",
  calendar: "home",
  notifications: "home",
  knowledge: "kb",
  dashboard: "home",
};

/**
 * Module id → SLO owner for every in-scope module.
 * Mirrors MODULE_SLO_OWNERSHIP in slo-modules.ts; must stay in sync when owners change.
 */
const MODULE_OWNERS = {
  hr: "people-team",
  payroll: "people-team",
  timesheets: "people-team",
  directory: "people-team",
  build: "delivery-team",
  workflows: "delivery-team",
  sign: "delivery-team",
  surveys: "delivery-team",
  feedbucket: "support-team",
  support: "support-team",
  accounting: "finance-team",
  billing: "payments-team",
  kb: "knowledge-team",
  blog: "knowledge-team",
  home: "communications-team",
  settings: "platform-reliability",
};

/**
 * Shared platform surfaces with no owning module.
 * Declared explicitly so a new namespace that does not appear here AND has no module
 * owner is reported as unattributable rather than silently falling through.
 */
export const PLATFORM_NAMESPACES = new Set([
  "health",
  "auth",
  "cron",
  "platform",
]);

/**
 * Modules excluded from the SLO scope (CRM, Inventory).
 * Their routes exist and breach alerts should reach platform-reliability,
 * but they carry no individual SLO owner.
 */
const SLO_EXCLUDED_MODULES = new Set(["crm", "inventory"]);

/**
 * Maps a namespace through the administersNamespaces overrides and route-segment
 * exceptions to the canonical module id.
 */
export function resolveModuleForNamespace(namespace) {
  return NAMESPACE_TO_MODULE_ID[namespace] ?? namespace;
}

/**
 * Returns the attribution for a given first-path-segment namespace.
 */
export function resolveRouteAttribution(namespace) {
  if (PLATFORM_NAMESPACES.has(namespace))
    return { platform: true, owner: "platform-reliability" };

  const moduleId = resolveModuleForNamespace(namespace);

  if (SLO_EXCLUDED_MODULES.has(moduleId))
    return { module: moduleId, sloExcluded: true, owner: "platform-reliability" };

  const owner = MODULE_OWNERS[moduleId];
  if (owner !== undefined) return { module: moduleId, owner };

  return { unattributable: true, namespace };
}

/**
 * Extracts the first path segment (namespace) from a span name formatted as
 * "METHOD /path/segments".  Returns null if the name does not look like a route span
 * (e.g. "seam:db.query.execute" has no space before the path).
 */
export function extractNamespaceFromSpanName(spanName) {
  const firstSpace = spanName.indexOf(" ");
  if (firstSpace === -1) return null;
  const path = spanName.slice(firstSpace + 1).split("?")[0];
  const segments = path.split("/").filter(Boolean);
  return segments[0] ?? null;
}

import { fileURLToPath } from "node:url";

const isMainScript = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainScript && process.argv.includes("--self-test")) {
  const hrAttrib = resolveRouteAttribution("hr");
  const chatAttrib = resolveRouteAttribution("chat");
  const mailAttrib = resolveRouteAttribution("mail");
  const knowledgeAttrib = resolveRouteAttribution("knowledge");
  const healthAttrib = resolveRouteAttribution("health");
  const cronAttrib = resolveRouteAttribution("cron");
  const unknownAttrib = resolveRouteAttribution("unknown-new-namespace");
  const crmAttrib = resolveRouteAttribution("crm");
  const partyAttrib = resolveRouteAttribution("party");

  const checks = {
    hrAttributesToPeopleTeam:
      hrAttrib.module === "hr" && hrAttrib.owner === "people-team",
    chatAttributesToCommunicationsViaHome:
      chatAttrib.module === "home" && chatAttrib.owner === "communications-team",
    mailAttributesToCommunicationsViaHome:
      mailAttrib.module === "home" && mailAttrib.owner === "communications-team",
    knowledgeAttributesToKbModule:
      knowledgeAttrib.module === "kb" && knowledgeAttrib.owner === "knowledge-team",
    healthAttributesToPlatform:
      healthAttrib.platform === true && healthAttrib.owner === "platform-reliability",
    cronAttributesToPlatform:
      cronAttrib.platform === true && cronAttrib.owner === "platform-reliability",
    unknownNamespaceIsUnattributable:
      unknownAttrib.unattributable === true && unknownAttrib.namespace === "unknown-new-namespace",
    crmIsSloExcluded:
      crmAttrib.sloExcluded === true && crmAttrib.module === "crm",
    partyAttributesToCrmSloExcluded:
      partyAttrib.sloExcluded === true && partyAttrib.module === "crm",
    extractNamespaceFromHrRoute:
      extractNamespaceFromSpanName("GET /hr/employees/some-id") === "hr",
    extractNamespaceFromChatRoute:
      extractNamespaceFromSpanName("GET /chat/channels") === "chat",
    seamsSpanNameReturnsNull:
      extractNamespaceFromSpanName("seam:route.cached.read") === null,
    ownersDifferBetweenHrAndChat:
      hrAttrib.owner !== chatAttrib.owner,
    ownersDifferBetweenHrAndHealth:
      hrAttrib.owner !== healthAttrib.owner,
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }) + "\n");
  process.exit(pass ? 0 : 1);
}
