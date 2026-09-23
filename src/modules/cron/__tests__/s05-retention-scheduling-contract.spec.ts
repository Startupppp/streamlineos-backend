import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(relativePath: string): string {
  return readFileSync(resolve(__dirname, "..", relativePath), "utf8");
}

describe("S05 retention scheduling contracts", () => {
  it("registers every retention route dependency in CronModule", () => {
    const module = source("cron.module.ts");
    expect(module).toMatch(/CronHrController/);
    expect(module).toMatch(/CronNotificationsController/);
    expect(module).toMatch(/CronNotificationRetentionController/);
    expect(module).toMatch(/CronSupportController/);
    expect(module).toMatch(/CronKbController/);
    expect(module).toMatch(/CronBuildController/);
    // No `CronFinanceController`: its three sweeps drove `modules/finance`, which the
    // accounting rewrite replaced with the gl_* kernel, and they have no counterpart
    // there yet. cron.module.ts names it in a comment, so a regex here would pass
    // vacuously rather than prove a registration.
    expect(module).toMatch(/CronPlatformController/);
    expect(module).toMatch(/CronHrRetentionService/);
    expect(module).toMatch(/CronNotificationRetentionService/);
    expect(module).toMatch(/NotificationRetentionService/);
    expect(module).toMatch(/CronAiUsageRetentionService/);
    expect(module).toMatch(/CronHelpdeskRetentionService/);
    expect(module).toMatch(/CronMailRetentionService/);
    expect(module).toMatch(/CronAnnouncementsRetentionService/);
    expect(module).toMatch(/CronOutboxRetentionService/);
    expect(module).toMatch(/CronNotificationOutboxRetentionService/);
  });

  it("exposes the HR policy sweep through authenticated GET/POST routes and a lease", () => {
    const controller = source("cron-hr.controller.ts");
    expect(controller).toMatch(/@Get\("hr-policy-retention-sweep"\)/);
    expect(controller).toMatch(/@Post\("hr-policy-retention-sweep"\)/);
    expect(controller).toMatch(/assertCronSecret\(authorization\)/);
    expect(controller).toMatch(/withLease\("hr-policy-retention-sweep",\s*1800/);
    expect(controller).toMatch(/this\.hrRetention\.sweep\(\)/);
  });

  it("exposes notification row and partition retention through authenticated leased routes", () => {
    const controller = source("cron-notification-retention.controller.ts");
    expect(controller).toMatch(/@Get\("notifications-retention-sweep"\)/);
    expect(controller).toMatch(/@Post\("notifications-retention-sweep"\)/);
    expect(controller).toMatch(/@Get\("notifications-retention-detach"\)/);
    expect(controller).toMatch(/@Post\("notifications-retention-detach"\)/);
    expect(controller).toMatch(/withLease\("notifications-retention-sweep",\s*300/);
    expect(controller).toMatch(/this\.notificationRetention\.sweep\(\)/);
    expect(controller).toMatch(/this\.partitionRetention\.sweep\(\)/);
  });

  it("exposes AI-usage retention through an authenticated leased deletion route", () => {
    const service = source("cron-ai-usage-retention.service.ts");
    const controller = source("cron-platform-retention.controller.ts");
    expect(service).toMatch(/class CronAiUsageRetentionService/);
    expect(controller).toMatch(/@Get\("ai-usage-retention-sweep"\)/);
    expect(controller).toMatch(/@Post\("ai-usage-retention-sweep"\)/);
    expect(controller).toMatch(/assertCronSecret\(authorization\)/);
    expect(controller).toMatch(/withLease\("ai-usage-retention-sweep",\s*1800/);
    expect(controller).toMatch(/this\.aiUsageRetention\.sweep\(\{ dryRun: false \}\)/);
  });

  it("exposes helpdesk retention through an authenticated leased route", () => {
    const controller = source("cron-hr.controller.ts");
    expect(controller).toMatch(/@Get\("helpdesk-retention-sweep"\)/);
    expect(controller).toMatch(/@Post\("helpdesk-retention-sweep"\)/);
    expect(controller).toMatch(/assertCronSecret\(authorization\)/);
    expect(controller).toMatch(/withLease\("helpdesk-retention-sweep",\s*1800/);
    expect(controller).toMatch(/this\.helpdeskRetention\.sweep\(\)/);
  });

  it("exposes mail metadata and announcements retention through authenticated leased routes", () => {
    const controller = source("cron-platform-retention.controller.ts");
    expect(controller).toMatch(/@Get\("mail-metadata-retention-sweep"\)/);
    expect(controller).toMatch(/@Post\("mail-metadata-retention-sweep"\)/);
    expect(controller).toMatch(/withLease\("mail-metadata-retention-sweep",\s*1800/);
    expect(controller).toMatch(/this\.mailRetention\.sweep\(\)/);
    expect(controller).toMatch(/@Get\("announcements-retention-sweep"\)/);
    expect(controller).toMatch(/@Post\("announcements-retention-sweep"\)/);
    expect(controller).toMatch(/withLease\("announcements-retention-sweep",\s*1800/);
    expect(controller).toMatch(/this\.announcementsRetention\.sweep\(\)/);
  });

  it("exposes KB chat, KB chunk, and build retention through authenticated leased routes", () => {
    const kb = source("cron-kb.controller.ts");
    const build = source("cron-build.controller.ts");
    expect(kb).toMatch(/@Get\("kb-chat-history-purge"\)/);
    expect(kb).toMatch(/@Post\("kb-chat-history-purge"\)/);
    expect(kb).toMatch(/withLease\("kb-chat-history-purge",\s*600/);
    expect(kb).toMatch(/this\.kbChatRetention\.purgeExpiredConversations\(\)/);
    expect(kb).toMatch(/@Get\("kb-chunk-retention-sweep"\)/);
    expect(kb).toMatch(/@Post\("kb-chunk-retention-sweep"\)/);
    expect(kb).toMatch(/withLease\("kb-chunk-retention-sweep",\s*600/);
    expect(kb).toMatch(/this\.kbChunkRetention\.pruneStaleChunks\(\)/);
    expect(build).toMatch(/@Get\("build-retention-prune"\)/);
    expect(build).toMatch(/@Post\("build-retention-prune"\)/);
    expect(build).toMatch(/withLease\("build-retention-prune",\s*120/);
    expect(build).toMatch(/this\.buildRetention\.pruneWebhookDeliveries\(\)/);
  });

  it("exposes outbox events and notification outbox retention through authenticated leased routes", () => {
    const outbox = source("cron-outbox.controller.ts");
    const notifications = source("cron-notification-retention.controller.ts");
    expect(outbox).toMatch(/@Get\("outbox-events-retention-sweep"\)/);
    expect(outbox).toMatch(/@Post\("outbox-events-retention-sweep"\)/);
    expect(outbox).toMatch(/withLease\("outbox-events-retention-sweep",\s*1800/);
    expect(outbox).toMatch(/this\.outboxRetention\.sweep\(\)/);
    expect(notifications).toMatch(/@Get\("notification-outbox-retention-sweep"\)/);
    expect(notifications).toMatch(/@Post\("notification-outbox-retention-sweep"\)/);
    expect(notifications).toMatch(/withLease\("notification-outbox-retention-sweep",\s*1800/);
    expect(notifications).toMatch(/this\.notificationOutboxRetention\.sweep\(\)/);
  });

  it("CronLeaseService writes a heartbeat key after a successful sweep and a failure record on error", () => {
    const leaseSource = source("cron-lease.service.ts");
    expect(leaseSource).toMatch(/HEARTBEAT_KEY_PREFIX/);
    expect(leaseSource).toMatch(/LAST_ERROR_KEY_PREFIX/);
    expect(leaseSource).toMatch(/writeHeartbeat/);
    expect(leaseSource).toMatch(/writeFailureRecord/);
    expect(leaseSource).toMatch(/cron:heartbeat:/);
    expect(leaseSource).toMatch(/cron:last-error:/);
  });
});
