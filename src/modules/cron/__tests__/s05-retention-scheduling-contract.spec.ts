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
    expect(module).toMatch(/CronSupportController/);
    expect(module).toMatch(/CronBuildController/);
    expect(module).toMatch(/CronPlatformController/);
    expect(module).toMatch(/CronHrRetentionService/);
    expect(module).toMatch(/CronNotificationRetentionService/);
    expect(module).toMatch(/NotificationRetentionService/);
    expect(module).toMatch(/CronAiUsageRetentionService/);
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
    const controller = source("cron-notifications.controller.ts");
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
    const controller = source("cron-platform.controller.ts");
    expect(service).toMatch(/class CronAiUsageRetentionService/);
    expect(controller).toMatch(/@Get\("ai-usage-retention-sweep"\)/);
    expect(controller).toMatch(/@Post\("ai-usage-retention-sweep"\)/);
    expect(controller).toMatch(/assertCronSecret\(authorization\)/);
    expect(controller).toMatch(/withLease\("ai-usage-retention-sweep",\s*1800/);
    expect(controller).toMatch(/this\.aiUsageRetention\.sweep\(\{ dryRun: false \}\)/);
  });

  it("exposes KB chat, KB chunk, and build retention through authenticated leased routes", () => {
    const support = source("cron-support.controller.ts");
    const build = source("cron-build.controller.ts");
    expect(support).toMatch(/@Get\("kb-chat-history-purge"\)/);
    expect(support).toMatch(/@Post\("kb-chat-history-purge"\)/);
    expect(support).toMatch(/withLease\("kb-chat-history-purge",\s*600/);
    expect(support).toMatch(/this\.kbChatRetention\.purgeExpiredConversations\(\)/);
    expect(support).toMatch(/@Get\("kb-chunk-retention-sweep"\)/);
    expect(support).toMatch(/@Post\("kb-chunk-retention-sweep"\)/);
    expect(support).toMatch(/withLease\("kb-chunk-retention-sweep",\s*600/);
    expect(support).toMatch(/this\.kbChunkRetention\.pruneStaleChunks\(\)/);
    expect(build).toMatch(/@Get\("build-retention-prune"\)/);
    expect(build).toMatch(/@Post\("build-retention-prune"\)/);
    expect(build).toMatch(/withLease\("build-retention-prune",\s*120/);
    expect(build).toMatch(/this\.buildRetention\.pruneWebhookDeliveries\(\)/);
  });
});
