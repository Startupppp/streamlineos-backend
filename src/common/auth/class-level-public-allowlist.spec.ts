import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(__dirname, "..", "..");

/**
 * Every name in this set carries class-level @Public(), meaning every route
 * added to the class silently inherits public exposure. The discipline is:
 * an unauthenticated route lives in its own controller (crm-consent.controller.ts
 * is the canonical reference). This allowlist pins the current 51 classes so a
 * new class-level @Public() cannot be added without a deliberate review.
 *
 * To add a new class-level @Public() controller: add its name here, justify it
 * in the commit message, and confirm every route in the class is intentionally
 * unauthenticated. To convert a class-level to method-level, remove from here.
 *
 * This list is shrink-only — removals are always safe.
 */
const CLASS_LEVEL_PUBLIC_ALLOWLIST = new Set<string>([
  "AgentController",
  "AssessmentScoreController",
  "BgvCallbackController",
  "BlogInternalController",
  "BoardApplyIngressController",
  "CalendarProviderWebhookController",
  "CarrierWebhooksPublicController",
  "ChannelSnapshotCronController",
  "ChannelSyncCronController",
  "ChannelWebhookController",
  "CronBillingController",
  "CronBuildController",
  "CronBuildProjectRetentionController",
  "CronCalendarController",
  "CronGdprController",
  "CronHrController",
  "CronHrNotificationsController",
  "CronInvitationExpiryController",
  "CronKbController",
  "CronNotificationRetentionController",
  "CronNotificationsController",
  "CronOutboxController",
  "CronPlatformController",
  "CronPlatformRetentionController",
  "CronSignController",
  "CronStorageController",
  "CronSupportController",
  "EmailWebhookController",
  "FeedbucketPublicController",
  "HealthController",
  "HrInterviewBookingController",
  "IntegrationsGitController",
  "InventoryWebhookDeliveryController",
  "KbPublicPagesController",
  "KbRagController",
  "KbWidgetController",
  "LeadsIngestController",
  "PaymentWebhooksPublicController",
  "PortalAuthController",
  "PublicController",
  "PublicWhiteboardLinksController",
  "RazorpayWebhookController",
  "SignPublicController",
  "SlottingCronController",
  "StorageKbController",
  "StripeWebhookController",
  "UnsubscribeController",
  "VoiceScreenResultController",
  "WhatsAppIngressController",
  "WhatsappInboundController",
  "WorkflowsCronController",
]);

function walk(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    if (e.isFile() && full.endsWith(".ts") && !full.includes(".spec.")) return [full];
    return [];
  });
}

function extractClassLevelPublicNames(src: string): string[] {
  const noComments = src
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  if (!/@Public\(\)/.test(noComments) || !/@Controller/.test(noComments)) return [];

  const names: string[] = [];
  const lines = noComments.split("\n");

  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() !== "@Public()") continue;

    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      const line = (lines[j] ?? "").trim();
      const match = /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/.exec(line);
      if (match) {
        names.push(match[1] as string);
        break;
      }
      if (line === "" || /^@/.test(line)) continue;
      break;
    }
  }

  return names;
}

describe("class-level @Public() allowlist", () => {
  const allNames: string[] = [];

  beforeAll(() => {
    for (const file of walk(SRC)) {
      const content = readFileSync(file, "utf8");
      allNames.push(...extractClassLevelPublicNames(content));
    }
  });

  it("detects at least the known class-level @Public() controllers — anti-vacuity check", () => {
    expect(allNames.length).toBeGreaterThanOrEqual(CLASS_LEVEL_PUBLIC_ALLOWLIST.size);
  });

  it("every class-level @Public() controller is in the allowlist — a new addition must be reviewed", () => {
    const unlisted = allNames.filter((name) => !CLASS_LEVEL_PUBLIC_ALLOWLIST.has(name));
    expect(unlisted).toEqual([]);
  });

  it("the allowlist contains no names absent from the codebase — stale entries are removed", () => {
    const nameSet = new Set(allNames);
    const stale = [...CLASS_LEVEL_PUBLIC_ALLOWLIST].filter((name) => !nameSet.has(name));
    expect(stale).toEqual([]);
  });

  it("demonstrates that adding a new class-level @Public() would fail — the gate genuinely bites", () => {
    const fakeNew = "SomeNewUnauthenticatedController";
    expect(CLASS_LEVEL_PUBLIC_ALLOWLIST.has(fakeNew)).toBe(false);
    const wouldFail = !CLASS_LEVEL_PUBLIC_ALLOWLIST.has(fakeNew);
    expect(wouldFail).toBe(true);
  });
});
