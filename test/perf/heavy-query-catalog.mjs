/**
 * The named heavy read paths, transcribed from the services that own them.
 *
 * One file per domain; this barrel is the order the runner measures in.
 */

import { CALENDAR_QUERIES } from "./heavy-query-catalog-calendar.mjs";
import { NOTIFICATION_QUERIES } from "./heavy-query-catalog-notifications.mjs";
import { SEARCH_QUERIES } from "./heavy-query-catalog-search.mjs";
import { DASHBOARD_QUERIES } from "./heavy-query-catalog-dashboard.mjs";

export const CATEGORIES = [
  "reminder",
  "export",
  "fanout",
  "unread",
  "free/busy",
  "recurrence",
  "search/vector",
  "dashboard",
];

export const QUERIES = [
  ...CALENDAR_QUERIES,
  ...NOTIFICATION_QUERIES,
  ...SEARCH_QUERIES,
  ...DASHBOARD_QUERIES,
];
