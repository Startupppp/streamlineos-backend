import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { KbFromTicketService } from "./kb-from-ticket.service";
import { ACCOUNT_ONLY_PRINCIPAL } from "../../../common/auth/principal";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("KbFromTicketService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const TICKET_ID = 55;

  function makeUser(orgId: string) {
    return { orgId, userId: "user-1", principal: ACCOUNT_ONLY_PRINCIPAL } as never;
  }

  const gateway = { invokeStructuredWithUsage: jest.fn() } as never;
  const events = { record: jest.fn() } as never;
  const articles = { create: jest.fn() } as never;

  function makeDb(ticketRow: unknown) {
    const wheres: unknown[] = [];
    return {
      db: {
        query: {
          supportTickets: {
            findFirst: jest.fn().mockImplementation((opts: { where?: unknown } = {}) => {
              wheres.push(opts.where);
              return Promise.resolve(ticketRow);
            }),
          },
        },
        select: jest.fn().mockImplementation(() => ({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue(Object.assign(Promise.resolve([]), {
              orderBy: jest.fn().mockResolvedValue([]),
            })),
          }),
        })),
      } as unknown as Db,
      wheres,
    };
  }

  it("throws NotFoundException for a ticket in another org (cross-tenant deny)", async () => {
    const { db, wheres } = makeDb(null);
    const svc = new KbFromTicketService(db, gateway, events, articles);

    await expect(svc.draftFromTicket(makeUser(ATTACKER), TICKET_ID, { spaceId: 1 } as never)).rejects.toThrow(NotFoundException);

    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("does not allow cross-tenant ticket access from owner org either (control guard)", async () => {
    const { db } = makeDb({ id: TICKET_ID, orgId: OWNER, title: "Test", description: null });
    (gateway.invokeStructuredWithUsage as jest.Mock).mockResolvedValue({ ok: true, data: { title: "T", content: "C" } });
    (articles.create as jest.Mock).mockResolvedValue({ id: 1, orgId: OWNER });
    const svc = new KbFromTicketService(db, gateway, events, articles);

    const result = await svc.draftFromTicket(makeUser(OWNER), TICKET_ID, { spaceId: 1 } as never);

    expect(result).toHaveProperty("orgId", OWNER);
  });
});
