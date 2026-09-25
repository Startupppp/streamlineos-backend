import { Test } from "@nestjs/testing";
import { KbAskController } from "./kb-ask.controller";
import { KbAskService } from "./kb-ask.service";
import { KbChatHistoryService } from "./kb-chat-history.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { COMMAND_FENCE_STORE } from "../../../common/idempotency/command-fence-store";
import { InMemoryCommandFenceStore } from "../../../common/idempotency/command-fence-store-memory";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, handle: (tx: unknown) => Promise<unknown>) => handle(db),
}));

const user: CurrentUserContext = {
  orgId: "org-a", userId: "user-a", role: "MEMBER", isOrgOwner: false,
  sessionId: "session-a", tokenScopes: null, principal: humanSessionPrincipal(7, false),
};

/**
 * The streamed route's hand-off of the company-documents option is asserted in kb-ask-stream-parity.spec.ts. The plain
 * route is the other way in to the same assistant, and nothing pinned it: dropping the option there would silently
 * make the two routes answer from different sources.
 */
describe("POST /kb/ask hands the assistant the company-documents source, like the streamed route", () => {
  it("passes { companyDocuments: true } to the service, and still saves the answer with its citations", async () => {
    const answer = { answer: "Ten days.", citations: [{ kind: "document", id: 9, title: "Leave Policy" }] };
    const ask = { ask: jest.fn().mockResolvedValue(answer) };
    const history = { createConversation: jest.fn().mockResolvedValue({ id: 5 }), appendToConversation: jest.fn().mockResolvedValue(undefined) };
    const module = await Test.createTestingModule({
      providers: [
        KbAskController,
        { provide: DRIZZLE, useValue: {} },
        { provide: KbAskService, useValue: ask },
        { provide: KbChatHistoryService, useValue: history },
        { provide: COMMAND_FENCE_STORE, useValue: new InMemoryCommandFenceStore() },
      ],
    })
      .overrideGuard(JwtAuthGuard).useValue({ canActivate: () => true })
      .overrideGuard(PermissionGuard).useValue({ canActivate: () => true })
      .overrideGuard(RateLimitGuard).useValue({ canActivate: () => true })
      .compile();
    const controller = module.get(KbAskController);

    const result = await controller.askQuestion({ question: "How many leave days?" } as never, user);

    expect(ask.ask).toHaveBeenCalledWith(user, expect.objectContaining({ question: "How many leave days?" }), { companyDocuments: true });
    expect(result).toMatchObject({ answer: "Ten days.", conversationId: 5 });
    expect(history.appendToConversation).toHaveBeenCalledWith("org-a", "user-a", 7, 5, "assistant", "Ten days.", answer.citations);
  });
});
