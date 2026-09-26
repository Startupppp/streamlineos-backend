import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, sep } from "path";

const SRC_ROOT = join(__dirname, "..", "..");

/**
 * `notifications.membership_id` is the recipient authority: every read path
 * filters on it (`notifications-read.service.ts`, `unified-inbox-sources.ts`,
 * `unified-inbox.service.ts`). The column is nullable and its composite FK is
 * MATCH SIMPLE, so a NULL satisfies the constraint and Postgres accepts the row
 * — it simply becomes unreadable. Six callers outside this module inserted
 * exactly that shape.
 *
 * Only the two writers inside the notifications module resolve the membership
 * before writing, so the module is the boundary this guard draws.
 */
const NOTIFICATIONS_MODULE = "modules/notifications/";

const RAW_INSERT = /\.insert\(\s*notifications\s*\)/;

interface SourceFile {
  path: string;
  text: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      walk(full, out);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".spec.ts") || entry.endsWith(".d.ts")) continue;
    out.push(full);
  }
  return out;
}

function productionSources(): SourceFile[] {
  return walk(SRC_ROOT).map((full) => ({
    path: relative(SRC_ROOT, full).split(sep).join("/"),
    text: readFileSync(full, "utf8"),
  }));
}

export function findRawNotificationInserts(files: readonly SourceFile[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    if (file.path.startsWith(NOTIFICATIONS_MODULE)) continue;
    file.text.split("\n").forEach((line, index) => {
      if (RAW_INSERT.test(line)) found.push(`${file.path}:${index + 1}`);
    });
  }
  return found;
}

describe("no module outside notifications writes a notification row itself", () => {
  const files = productionSources();

  it("scanned a real tree, so an empty result means the scan found nothing rather than nothing to scan", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(
      files.some(
        (file) => file.path === "modules/notifications/notification-dispatch-persistence.service.ts",
      ),
    ).toBe(true);
  });

  it("bites on a raw insert reintroduced in a domain module", () => {
    expect(
      findRawNotificationInserts([
        {
          path: "modules/made-up/x.service.ts",
          text: "await this.db.insert(notifications).values({ orgId, userId });",
        },
      ]),
    ).toEqual(["modules/made-up/x.service.ts:1"]);
  });

  it("does not bite on the notifications module's own two membership-resolving writers", () => {
    expect(
      findRawNotificationInserts([
        {
          path: "modules/notifications/notifications.service.ts",
          text: ".insert(notifications)",
        },
        {
          path: "modules/notifications/notification-dispatch-persistence.service.ts",
          text: ".insert(notifications)",
        },
      ]),
    ).toEqual([]);
  });

  it("does not mistake a neighbouring notification table for the recipient table", () => {
    expect(
      findRawNotificationInserts([
        {
          path: "modules/made-up/y.service.ts",
          text: "await tx.insert(notificationDeliveries).values(rows);\nawait tx.insert(notificationOutbox).values(rows);",
        },
      ]),
    ).toEqual([]);
  });

  it("finds no raw notification insert anywhere under src outside the notifications module", () => {
    expect(findRawNotificationInserts(files)).toEqual([]);
  });
});
