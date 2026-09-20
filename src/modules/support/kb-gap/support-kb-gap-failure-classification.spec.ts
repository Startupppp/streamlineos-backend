import { SupportKbGapService } from "./support-kb-gap.service";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import type { Db } from "../../../db/drizzle.module";
import type { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import type { KbArticlesService } from "../../kb/help-centre/kb-articles.service";
import type { KbEventsService } from "../../kb/core/kb-events.service";
import type { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { SupportKnowledgeGapStatus } from "../../../db/schema/support/support-kb-gap";

type Line = Record<string, unknown>;

function capture(): { lines: Line[]; restore: () => void } {
  const lines: Line[] = [];
  const push = (chunk: unknown): boolean => {
    lines.push(JSON.parse(String(chunk)) as Line);
    return true;
  };
  const out = jest.spyOn(process.stdout, "write").mockImplementation(push);
  const err = jest.spyOn(process.stderr, "write").mockImplementation(push);
  return { lines, restore: () => [out, err].forEach((s) => s.mockRestore()) };
}

/** Every builder step returns itself; the terminal `limit()` yields no rows. */
function chain(): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const step of ["from", "innerJoin", "leftJoin", "where", "orderBy"])
    node[step] = () => node;
  node["limit"] = async () => [];
  return node;
}

function dbStub(): Db {
  const gap = {
    id: 7,
    orgId: "org-1",
    status: SupportKnowledgeGapStatus.OPEN,
    representativeQuestion: "How do I reset my password?",
    evidence: null,
  };
  const stub = {
    query: {
      supportKnowledgeGaps: { findFirst: async () => gap },
      kbSpaces: { findFirst: async () => ({ id: 3 }) },
    },
    select: () => chain(),
    selectDistinct: () => chain(),
    execute: async () => [],
    /*
      The read phase now opens a tenant transaction of its own, so the stub has
      to hand one back. It delegates to itself: a transaction that never runs
      its callback would make every assertion below pass on an empty path.
    */
    transaction: (fn: (tx: unknown) => unknown) => fn(stub),
  };
  return stub as unknown as Db;
}

function serviceWith(kind: string): SupportKbGapService {
  const gateway = {
    invokeStructuredWithUsage: async () => ({
      ok: false as const,
      kind,
      message: "AI credits exhausted",
    }),
  };
  return new SupportKbGapService(
    dbStub(),
    gateway as unknown as AiGatewayService,
    {} as KbArticlesService,
    {} as KbEventsService,
    {} as NotificationDispatchService,
  );
}

/**
 * PRD-C102's last clause: "classify expected domain failures separately from
 * actionable faults." An exhausted AI credit wallet is a billing state the
 * tenant resolves by topping up — logging it at error put a recurring, expected
 * outcome into the stream an operator is paged from.
 */
describe("support kb-gap draft — expected domain failure vs actionable fault", () => {
  let cap: ReturnType<typeof capture>;
  beforeEach(() => {
    cap = capture();
  });
  afterEach(() => cap.restore());

  it("an exhausted credit wallet is reported at warn, never at error", async () => {
    await expect(
      serviceWith("quota_exceeded").proposeDraft("org-1", 7, "user-1"),
    ).rejects.toBeInstanceOf(InsufficientAiCreditsException);

    const levels = cap.lines.map((line) => line["level"]);
    expect(levels).toContain("warn");
    expect(levels).not.toContain("error");
  });

  it("a fault an operator can act on is still reported at error", async () => {
    await expect(
      serviceWith("provider_error").proposeDraft("org-1", 7, "user-1"),
    ).rejects.toThrow();

    const levels = cap.lines.map((line) => line["level"]);
    expect(levels).toContain("error");
  });

  it("neither line carries the tenant's question", async () => {
    await expect(
      serviceWith("quota_exceeded").proposeDraft("org-1", 7, "user-1"),
    ).rejects.toBeInstanceOf(InsufficientAiCreditsException);

    const joint = JSON.stringify(cap.lines);
    expect(joint).not.toContain("How do I reset my password?");
    expect(joint).toContain("org-1");
  });
});
