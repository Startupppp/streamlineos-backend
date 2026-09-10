import { ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { createTenantAwareDb } from "../../common/tenant/tenant-db";
import { primeRelocationTrafficTracker } from "../../common/relocation/relocation-traffic-tracker";
import { SignPublicService } from "./sign-public.service";
import { SignAuditService } from "./sign-audit.service";
import { SignTokensService } from "./sign-tokens.service";
import { SignEnvelopesService } from "./sign-envelopes.service";
import { SignFinalizationService } from "./sign-finalization.service";
import { SignNotificationsService } from "./sign-notifications.service";
import { SignIntegrationsService } from "./sign-integrations.service";
import { SignPublicFormService } from "./sign-public-form.service";
import { StorageService } from "../storage/storage.service";
import type { signRecipients } from "../../db/schema";

function recipientFixture(): Partial<typeof signRecipients.$inferSelect> {
  return {
    id: 9,
    orgId: "sign-auth-test",
    envelopeId: 1,
    name: "Signer",
    email: "signer@example.test",
    status: "viewed",
    authMethod: "access_code",
    accessCodeHash: new SignTokensService().hash("correct-code"),
    failedAuthAttempts: 0,
    authLockedUntil: null,
    authenticatedAt: null,
    tokenRevokedAt: null,
    tokenExpiresAt: null,
  };
}

async function build() {
  let recipient = recipientFixture();
  let events: Record<string, unknown>[] = [];
  let pendingRowLock = Promise.resolve();
  const envelope = { id: 1, orgId: "sign-auth-test", status: "sent" };

  function transactionState() {
    let draftRecipient = { ...recipient };
    const draftEvents: Record<string, unknown>[] = [];
    let recipientChanged = false;
    let releaseRowLock = () => {};
    const transaction = {
      execute: jest.fn().mockResolvedValue([]),
      query: {
        signRecipients: { findFirst: async () => ({ ...draftRecipient }) },
        signEnvelopes: { findFirst: async () => envelope },
      },
      select: () => ({
        from: () => ({
          where: () => ({
            for: async (mode: string) => {
              expect(mode).toBe("update");
              const previous = pendingRowLock;
              pendingRowLock = new Promise<void>((resolve) => { releaseRowLock = resolve; });
              await previous;
              draftRecipient = { ...recipient };
              return [draftRecipient];
            },
          }),
        }),
      }),
      update: () => ({
        set: (patch: Partial<typeof signRecipients.$inferSelect>) => ({
          where: async () => {
            recipientChanged = true;
            draftRecipient = { ...draftRecipient, ...patch };
            return [draftRecipient];
          },
        }),
      }),
      insert: () => ({
        values: async (rows: Record<string, unknown>[]) => {
          draftEvents.push(...rows);
        },
      }),
    };
    return {
      transaction,
      commit() {
        if (recipientChanged) recipient = draftRecipient;
        events.push(...draftEvents);
      },
      release: () => releaseRowLock(),
    };
  }

  const db = {
    async transaction<T>(fn: (tx: ReturnType<typeof transactionState>["transaction"]) => Promise<T>) {
      const state = transactionState();
      try {
        const result = await fn(state.transaction);
        state.commit();
        return result;
      } finally {
        state.release();
      }
    },
  };

  primeRelocationTrafficTracker([], Date.now());
  const module = await Test.createTestingModule({
    providers: [
      SignPublicService,
      SignAuditService,
      SignTokensService,
      { provide: "TEST_SIGN_DB", useValue: db },
      {
        provide: DRIZZLE,
        inject: ["TEST_SIGN_DB"],
        useFactory: (rawDb: Db) => createTenantAwareDb(Object.assign(rawDb, {
          __client: { end: async () => undefined },
        })),
      },
      ...[
        StorageService,
        SignEnvelopesService,
        SignFinalizationService,
        SignNotificationsService,
        SignIntegrationsService,
        SignPublicFormService,
      ].map((provide) => ({ provide, useValue: {} })),
    ],
  }).compile();

  return {
    service: module.get(SignPublicService),
    recipient: () => recipient,
    events: () => events,
    close: () => module.close(),
  };
}

describe("SignPublicService authentication transaction durability", () => {
  it("retains the failed attempt and audit trail after returning 403", async () => {
    const fixture = await build();
    try {
      await expect(fixture.service.authenticate("token", { accessCode: "wrong" }, {}))
        .rejects.toBeInstanceOf(ForbiddenException);
      expect(fixture.recipient().failedAuthAttempts).toBe(1);
      expect(fixture.events()).toEqual([expect.objectContaining({ eventType: "authentication_failed" })]);
    } finally {
      await fixture.close();
    }
  });

  it("locks the recipient after five wrong codes and rejects a correct code while locked", async () => {
    const fixture = await build();
    try {
      for (let attempt = 0; attempt < 5; attempt++)
        await expect(fixture.service.authenticate("token", { accessCode: "wrong" }, {}))
          .rejects.toBeInstanceOf(ForbiddenException);
      expect(fixture.recipient().failedAuthAttempts).toBe(5);
      expect(fixture.recipient().authLockedUntil?.getTime()).toBeGreaterThan(Date.now());
      await expect(fixture.service.authenticate("token", { accessCode: "correct-code" }, {}))
        .rejects.toThrow("Too many failed attempts");
      expect(fixture.recipient().authenticatedAt).toBeNull();
      expect(fixture.events()).toHaveLength(5);
    } finally {
      await fixture.close();
    }
  });

  it("commits successful authentication and resets previous failed attempts", async () => {
    const fixture = await build();
    try {
      fixture.recipient().failedAuthAttempts = 2;
      await expect(fixture.service.authenticate("token", { accessCode: "correct-code" }, {}))
        .resolves.toEqual({ authenticated: true });
      expect(fixture.recipient().failedAuthAttempts).toBe(0);
      expect(fixture.recipient().authenticatedAt).toBeInstanceOf(Date);
      expect(fixture.events()).toEqual([expect.objectContaining({ eventType: "authentication_passed" })]);
    } finally {
      await fixture.close();
    }
  });

  it("counts concurrent wrong codes independently and locks at the fifth attempt", async () => {
    const fixture = await build();
    try {
      const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () =>
        fixture.service.authenticate("token", { accessCode: "wrong" }, {}),
      ));
      expect(outcomes.map((outcome) => outcome.status)).toEqual(Array(8).fill("rejected"));
      expect(fixture.recipient().failedAuthAttempts).toBe(5);
      expect(fixture.recipient().authLockedUntil?.getTime()).toBeGreaterThan(Date.now());
      expect(fixture.events()).toHaveLength(5);
    } finally {
      await fixture.close();
    }
  });

  it("rechecks a new lockout before accepting a concurrently submitted correct code", async () => {
    const fixture = await build();
    try {
      fixture.recipient().failedAuthAttempts = 4;
      const outcomes = await Promise.allSettled([
        fixture.service.authenticate("token", { accessCode: "wrong" }, {}),
        fixture.service.authenticate("token", { accessCode: "correct-code" }, {}),
      ]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
      expect(fixture.recipient().failedAuthAttempts).toBe(5);
      expect(fixture.recipient().authenticatedAt).toBeNull();
      expect(fixture.events()).toEqual([expect.objectContaining({ eventType: "authentication_failed" })]);
    } finally {
      await fixture.close();
    }
  });
});
