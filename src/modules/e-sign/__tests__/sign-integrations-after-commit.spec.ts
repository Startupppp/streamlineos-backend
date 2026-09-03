import type { Db } from "../../../db/drizzle.module";
import { SignIntegrationsService } from "../sign-integrations.service";
import type { signEnvelopes } from "../../../db/schema";
import {
  runWithTenantContext,
  type AfterCommitHook,
} from "../../../common/tenant/tenant-context";

type EnvelopeRow = typeof signEnvelopes.$inferSelect;

const ORG_ID = "org-1";

function makeEnvelope(): EnvelopeRow {
  return {
    id: 7,
    orgId: ORG_ID,
    title: "Master services agreement",
    status: "expired",
    senderMembershipId: 42,
    sourceModule: "sign",
    sourceEntityType: null,
    sourceEntityId: null,
  } as unknown as EnvelopeRow;
}

function makeService(overrides?: {
  automationRejects?: boolean;
  notificationRejects?: boolean;
}) {
  const db = {
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ user: { id: "user-sender" } }),
      },
    },
  } as unknown as Db;

  const automation = {
    runAutomationsForEvent: jest.fn(() =>
      overrides?.automationRejects
        ? Promise.reject(new Error("automation engine down"))
        : Promise.resolve(undefined),
    ),
  };
  const webhooks = { dispatch: jest.fn() };
  const notifications = {
    create: jest.fn(() =>
      overrides?.notificationRejects
        ? Promise.reject(new Error("notifications down"))
        : Promise.resolve(undefined),
    ),
  };

  const svc = new SignIntegrationsService(
    db,
    automation as never,
    webhooks as never,
    notifications as never,
  );
  return { svc, automation, notifications, webhooks };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("SignIntegrationsService — side effects defer past the request transaction", () => {
  it("emitEnvelopeEvent does NOT touch the database inside the request transaction: the sender notification and the automation run are queued as after-commit hooks", async () => {
    const { svc, automation, notifications } = makeService();
    const afterCommit: AfterCommitHook[] = [];

    await runWithTenantContext(
      { orgId: ORG_ID, audience: "INTERNAL", tx: {} as never, afterCommit },
      async () => {
        svc.emitEnvelopeEvent(makeEnvelope(), "expired");
      },
    );
    await settle();

    expect(afterCommit).toHaveLength(2);
    expect(automation.runAutomationsForEvent).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();

    for (const hook of afterCommit) await hook();

    expect(automation.runAutomationsForEvent).toHaveBeenCalledTimes(1);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID, userId: "user-sender" }),
    );
  });

  it("emitBulkSendCompleted queues the sender notification rather than writing it inside the request transaction", async () => {
    const { svc, notifications } = makeService();
    const afterCommit: AfterCommitHook[] = [];

    await runWithTenantContext(
      { orgId: ORG_ID, audience: "INTERNAL", tx: {} as never, afterCommit },
      async () => {
        svc.emitBulkSendCompleted(ORG_ID, "user-sender", 3, {
          totalCount: 2,
          successCount: 2,
          failedCount: 0,
        });
      },
    );
    await settle();

    expect(notifications.create).not.toHaveBeenCalled();
    expect(afterCommit).toHaveLength(2);

    for (const hook of afterCommit) await hook();
    expect(notifications.create).toHaveBeenCalledTimes(1);
  });

  it("a failing hook is caught, so a drained after-commit queue never rejects and never becomes an unhandled rejection", async () => {
    const { svc } = makeService({ automationRejects: true, notificationRejects: true });
    const afterCommit: AfterCommitHook[] = [];

    await runWithTenantContext(
      { orgId: ORG_ID, audience: "INTERNAL", tx: {} as never, afterCommit },
      async () => {
        svc.emitEnvelopeEvent(makeEnvelope(), "expired");
      },
    );

    expect(afterCommit).toHaveLength(2);
    for (const hook of afterCommit) await expect(hook()).resolves.not.toThrow();
  });

  it("outside a request there is no after-commit queue, so the effects still run inline", async () => {
    const { svc, automation, notifications } = makeService();

    svc.emitEnvelopeEvent(makeEnvelope(), "expired");
    await settle();

    expect(automation.runAutomationsForEvent).toHaveBeenCalledTimes(1);
    expect(notifications.create).toHaveBeenCalledTimes(1);
  });
});
