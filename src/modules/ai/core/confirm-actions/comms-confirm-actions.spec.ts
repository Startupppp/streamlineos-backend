import type { ModuleRef } from "@nestjs/core";
import { findConfirmableAction } from ".";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.module";
import type { MailComposeService } from "../../../mail/mail-compose.service";
import { ExternalEffectLedger } from "../../../../common/outbox/external-effect-ledger";

const mockActor: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
  principal: { kind: "human-session", membershipId: 42, isOrgOwner: false },
};

const passThroughLedger = {
  execute: async (_effect: unknown, send: () => Promise<void>) => {
    await send();
    return "EXECUTED" as const;
  },
};

function makeModuleRef(compose: Partial<MailComposeService>): ModuleRef {
  return {
    get: jest.fn((token: unknown) =>
      token === ExternalEffectLedger ? passThroughLedger : compose,
    ),
  } as unknown as ModuleRef;
}

describe("mail.archive executor — performAction is called with the archive action", () => {
  it("calls performAction with the archive action so the provider moves the message out of the inbox", async () => {
    const mockPerformAction = jest.fn().mockResolvedValue(undefined);
    const moduleRef = makeModuleRef({ performAction: mockPerformAction });
    const definition = findConfirmableAction("mail.archive");

    await definition?.execute(
      { accountId: 3, messageId: "msg-abc", threadId: "thread-xyz" },
      { actor: mockActor, db: {} as Db, moduleRef, proposalId: 1 },
    );

    expect(mockPerformAction).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      42,
      "msg-abc",
      3,
      "archive",
      "thread-xyz",
    );
  });

  it("forwards undefined threadId to performAction for accounts that do not require it", async () => {
    const mockPerformAction = jest.fn().mockResolvedValue(undefined);
    const moduleRef = makeModuleRef({ performAction: mockPerformAction });
    const definition = findConfirmableAction("mail.archive");

    await definition?.execute(
      { accountId: 3, messageId: "msg-abc", threadId: undefined },
      { actor: mockActor, db: {} as Db, moduleRef, proposalId: 1 },
    );

    expect(mockPerformAction).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      42,
      "msg-abc",
      3,
      "archive",
      undefined,
    );
  });

  it("derives membershipId from actor.principal, so the caller cannot substitute their own identity", async () => {
    const mockPerformAction = jest.fn().mockResolvedValue(undefined);
    const moduleRef = makeModuleRef({ performAction: mockPerformAction });
    const definition = findConfirmableAction("mail.archive");
    const actorWithDifferentMembership: CurrentUserContext = {
      ...mockActor,
      principal: { kind: "human-session", membershipId: 99, isOrgOwner: false },
    };

    await definition?.execute(
      { accountId: 3, messageId: "msg-abc" },
      { actor: actorWithDifferentMembership, db: {} as Db, moduleRef, proposalId: 1 },
    );

    expect(mockPerformAction).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      99,
      expect.any(String),
      expect.any(Number),
      "archive",
      undefined,
    );
  });

  it("returns archived: true and a summary containing the messageId so the confirmation response is informative", async () => {
    const moduleRef = makeModuleRef({ performAction: jest.fn().mockResolvedValue(undefined) });
    const definition = findConfirmableAction("mail.archive");

    const outcome = await definition?.execute(
      { accountId: 3, messageId: "msg-abc" },
      { actor: mockActor, db: {} as Db, moduleRef, proposalId: 1 },
    );

    expect(outcome?.result).toMatchObject({ archived: true });
    expect(outcome?.summary).toContain("msg-abc");
  });
});
