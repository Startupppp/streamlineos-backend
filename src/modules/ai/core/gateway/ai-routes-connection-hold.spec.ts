/**
 * An LLM call inside the request's tenant transaction pins a pooled connection
 * for the whole round trip — 30s on the fast tier, 60s on standard — and the
 * pool is 10 on RDS. Six routes did that until this change.
 *
 * The gate that should have caught them could not: the provider is reached
 * through `ChatOpenAI` (`@langchain/openai`), not `fetch` or `axios`, so
 * nothing in `check-request-txn-outbound`'s OUTBOUND pattern matches an AI
 * call. These routes were found by widening that pattern by hand and verifying
 * every hop, which is why the pairing is pinned here instead.
 *
 * Both halves are load-bearing and neither is safe alone. Without the
 * decorator the service's own transactions open a SECOND connection while the
 * request still holds the first. Without the service change the handler runs
 * with no ambient context and the next `this.db` call has no tenant GUC.
 */
import { NO_TENANT_TRANSACTION } from "../../../../common/tenant/no-tenant-transaction.decorator";
import { InvAiExplainController } from "../../../inventory/ai/inv-ai-explain.controller";
import { KbFromTicketController } from "../../../kb/help-centre/kb-from-ticket.controller";
import { SupportKbEngagementController } from "../../../support/core/support-kb-engagement.controller";
import { SupportKbGapController } from "../../../support/kb-gap/support-kb-gap.controller";

function optedOut(controller: object, handler: string): boolean {
  const target = (controller as { prototype: Record<string, unknown> }).prototype[handler];
  return Reflect.getMetadata(NO_TENANT_TRANSACTION, target as object) === true;
}

describe("a route that awaits an LLM does not hold a pooled connection across it", () => {
  it("drafts a KB article from a ticket outside the request transaction", () => {
    expect(optedOut(KbFromTicketController, "draftFromTicket")).toBe(true);
  });

  it("answers a support question outside it, as POST /kb/ask already did", () => {
    expect(optedOut(SupportKbEngagementController, "askQuestion")).toBe(true);
  });

  it("drafts a knowledge-gap article outside it, the longest at 60s standard tier", () => {
    expect(optedOut(SupportKbGapController, "proposeDraft")).toBe(true);
  });

  it("narrates a reorder proposal outside it", () => {
    expect(optedOut(InvAiExplainController, "getReorderProposal")).toBe(true);
  });

  it("narrates the digest outside it, because ?narrate=true turns a GET into an LLM call", () => {
    expect(optedOut(InvAiExplainController, "getDigest")).toBe(true);
  });

  it("narrates the supplier-delay briefing outside it whenever there is vendor data", () => {
    expect(optedOut(InvAiExplainController, "getSupplierDelayBriefing")).toBe(true);
  });

  it("ANTI-VACUITY: a route beside them that reaches no provider is NOT opted out", () => {
    expect(optedOut(InvAiExplainController, "getOpsBrief")).toBe(false);
    expect(optedOut(InvAiExplainController, "confirmReorderProposal")).toBe(false);
  });
});
