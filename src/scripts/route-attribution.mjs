/**
 * Route-to-module attribution.
 *
 * Maps an API route's first path segment (namespace) to the owning module and
 * its SLO owner, deriving both the administering overrides and the route-segment
 * exceptions from the committed module manifest rather than a local table.
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

import {
  committedModuleManifest,
  moduleOwningNamespace,
} from "./permission-key-extractors.mjs";

let routeSegmentToModuleId = null;

// A route's first segment is not always the module id (/knowledge → kb, /dashboard → home), so derive it from the manifest's own `route` rather than a second table.
function routeSegmentOverrides() {
  if (routeSegmentToModuleId === null) {
    routeSegmentToModuleId = new Map();
    for (const entry of committedModuleManifest().modules) {
      const segment = (entry.route ?? "").split("/").filter(Boolean)[0];
      if (segment !== undefined && segment !== entry.id)
        routeSegmentToModuleId.set(segment, entry.id);
    }
    if (routeSegmentToModuleId.size === 0)
      throw new Error("module manifest yielded no route-segment overrides; attribution would be silently identity-only");
  }
  return routeSegmentToModuleId;
}

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

// Administration wins over the route segment: /notifications is the notifications module's route, but Home administers the namespace.
export function resolveModuleForNamespace(namespace) {
  const administering = moduleOwningNamespace(namespace);
  if (administering !== namespace) return administering;
  return routeSegmentOverrides().get(namespace) ?? namespace;
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

  const calendarAttrib = resolveRouteAttribution("calendar");
  const notificationsAttrib = resolveRouteAttribution("notifications");
  const dashboardAttrib = resolveRouteAttribution("dashboard");
  const authAttrib = resolveRouteAttribution("auth");
  const platformAttrib = resolveRouteAttribution("platform");

  const checks = {
    hrAttributesToPeopleTeam:
      hrAttrib.module === "hr" && hrAttrib.owner === "people-team",
    calendarAttributesToCommunicationsViaHome:
      calendarAttrib.module === "home" && calendarAttrib.owner === "communications-team",
    notificationsAttributesToHomeNotItsOwnModule:
      notificationsAttrib.module === "home" && notificationsAttrib.owner === "communications-team",
    dashboardRouteSegmentAttributesToHome:
      dashboardAttrib.module === "home" && dashboardAttrib.owner === "communications-team",
    authAttributesToPlatform:
      authAttrib.platform === true && authAttrib.owner === "platform-reliability",
    platformAttributesToPlatform:
      platformAttrib.platform === true && platformAttrib.owner === "platform-reliability",
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
