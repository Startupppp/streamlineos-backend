import { CacheService } from "../../common/cache/cache.service";
import {
  organizationMembers,
  supportTicketEmbeddings,
  supportTickets,
  users,
} from "../../db/schema";
import {
  SUPPORT_ERASURE_PAGE,
  erasedRequesterEmail,
} from "../support/core/support-ticket-erasure";
import { GdprSubjectErasureService } from "./gdpr-subject-erasure.service";

jest.mock("../../common/rbac/access-mutation-commit", () => ({
  commitAccessChange: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../common/auth/membership-state.service", () => ({
  membershipStandingChannel: { publish: jest.fn() },
}));

/**
 * The surviving-membership guard moved off the erasing org's tenant transaction and onto
 * its own identity-scoped one: `organization_members` admits a row only when its org is
 * the tenant GUC's or its user is `app.user_id`, and a tenant transaction never sets the
 * second, so from inside one the read is blind. Nothing in this file turns on its answer —
 * it is doubled here so it no longer occupies a slot in the `tx` sequence below.
 * `gdpr-subject-erasure-global-identity.db.spec.ts` proves the real one against Postgres.
 */
jest.mock("../../common/tenant/with-identity", () => ({
  withIdentity: jest.fn((_db: unknown, _userId: string, fn: (tx: unknown) => unknown) =>
    fn({
      select: () => ({
        from: () => {
          // The surviving-membership guard joins organizations to exclude deleted ones;
          // this double models a builder, so it walks the same links the query does.
          const chain: Record<string, unknown> = {
            innerJoin: () => chain,
            where: () => chain,
            limit: () => Promise.resolve([]),
          };
          return chain;
        },
      }),
    }),
  ),
}));

const ORG = "org-support";
const SUBJECT = "user-support-subject";
const ACTOR = "user-support-actor";
const LIVE_EMAIL = "Dana.Subject@example.com";
const THIRD_PARTY_EMAIL = "external.customer@partner.example";
const TICKET_COUNT = SUPPORT_ERASURE_PAGE * 2 + 37;

interface TicketRow {
  id: number;
  requesterEmail: string | null;
  requesterName: string | null;
}

interface Store {
  userEmail: string;
  userName: string | null;
  tickets: TicketRow[];
  embeddingTicketIds: number[];
  emailsReadBySupportErasure: string[];
  ticketSelectCalls: number;
  callOrder: string[];
}

function makeStore(ticketCount: number): Store {
  const tickets: TicketRow[] = [];
  for (let i = 1; i <= ticketCount; i++) {
    tickets.push({ id: i, requesterEmail: LIVE_EMAIL, requesterName: "Dana Subject" });
  }
  // Channel-ingested: attributed to the subject as agent, but the requester is a third
  // party. Matching on created_by_membership_id instead would clobber THIS row's email.
  tickets.push({
    id: ticketCount + 1,
    requesterEmail: THIRD_PARTY_EMAIL,
    requesterName: "External Customer",
  });
  return {
    userEmail: LIVE_EMAIL,
    userName: "Dana Subject",
    tickets,
    embeddingTicketIds: tickets.map((t) => t.id),
    emailsReadBySupportErasure: [],
    ticketSelectCalls: 0,
    callOrder: [],
  };
}

type SetValues = Record<string, unknown>;

function makeTx(store: Store) {
  let lastTicketPageIds: number[] = [];

  const selectChain = () => {
    let table: unknown = null;
    const resolve = (): unknown[] => {
      if (table === users) {
        store.emailsReadBySupportErasure.push(store.userEmail);
        return [{ email: store.userEmail }];
      }
      if (table === supportTickets) {
        store.ticketSelectCalls++;
        const needle = store.userEmail.trim().toLowerCase();
        const matching = store.tickets
          .filter((t) => (t.requesterEmail ?? "").trim().toLowerCase() === needle)
          .sort((a, b) => a.id - b.id)
          .slice(0, SUPPORT_ERASURE_PAGE);
        lastTicketPageIds = matching.map((t) => t.id);
        return matching.map((t) => ({ id: t.id }));
      }
      // Every other table read on `tx` is empty here. The other-org membership probe is
      // no longer one of them — it runs under `withIdentity`, doubled above.
      return [];
    };
    const chain = {
      from: (t: unknown) => {
        table = t;
        return chain;
      },
      // The surviving-membership guard joins organizations to exclude deleted orgs;
      // the double models a builder, so it needs the link the query now walks.
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(resolve()),
      then: (onOk: (value: unknown) => unknown, onErr?: (reason: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onOk, onErr),
    };
    return chain;
  };

  const updateChain = (table: unknown) => {
    let values: SetValues = {};
    const apply = (): unknown[] => {
      if (table === supportTickets) {
        store.callOrder.push("support_tickets.update");
        const email = values.requesterEmail;
        const name = values.requesterName;
        const touched: Array<{ id: number }> = [];
        for (const ticket of store.tickets) {
          if (!lastTicketPageIds.includes(ticket.id)) continue;
          ticket.requesterEmail = typeof email === "string" ? email : null;
          ticket.requesterName = typeof name === "string" ? name : null;
          touched.push({ id: ticket.id });
        }
        return touched;
      }
      if (table === users) {
        store.callOrder.push("users.update");
        const email = values.email;
        if (typeof email === "string") store.userEmail = email;
        store.userName = null;
        return [{ id: SUBJECT }];
      }
      return [];
    };
    const chain = {
      set: (v: SetValues) => {
        values = v;
        return chain;
      },
      // The surviving-membership guard joins organizations to exclude deleted orgs;
      // the double models a builder, so it needs the link the query now walks.
      innerJoin: () => chain,
      where: () => chain,
      returning: () => Promise.resolve(apply()),
      then: (onOk: (value: unknown) => unknown, onErr?: (reason: unknown) => unknown) =>
        Promise.resolve(apply()).then(onOk, onErr),
    };
    return chain;
  };

  const deleteChain = (table: unknown) => {
    const apply = (): unknown[] => {
      if (table === supportTicketEmbeddings) {
        store.callOrder.push("support_ticket_embeddings.delete");
        const removed = store.embeddingTicketIds.filter((id) =>
          lastTicketPageIds.includes(id),
        );
        store.embeddingTicketIds = store.embeddingTicketIds.filter(
          (id) => !lastTicketPageIds.includes(id),
        );
        return removed.map((id) => ({ id }));
      }
      return [];
    };
    const chain = {
      // The surviving-membership guard joins organizations to exclude deleted orgs;
      // the double models a builder, so it needs the link the query now walks.
      innerJoin: () => chain,
      where: () => chain,
      returning: () => Promise.resolve(apply()),
      then: (onOk: (value: unknown) => unknown, onErr?: (reason: unknown) => unknown) =>
        Promise.resolve(apply()).then(onOk, onErr),
    };
    return chain;
  };

  const insertChain = () => {
    const chain: Record<string, unknown> = {
      values: () => chain,
      onConflictDoNothing: () => chain,
      onConflictDoUpdate: () => chain,
      returning: () => Promise.resolve([{ id: 1 }]),
      then: (onOk: (v: unknown) => unknown, onErr?: (r: unknown) => unknown) =>
        Promise.resolve([{ id: 1 }]).then(onOk, onErr),
    };
    return chain;
  };

  return {
    select: jest.fn(() => selectChain()),
    update: jest.fn((table: unknown) => updateChain(table)),
    delete: jest.fn((table: unknown) => deleteChain(table)),
    insert: jest.fn(() => insertChain()),
  };
}

function makeDb(store: Store) {
  const tx = makeTx(store);
  const dbSelectChain = () => {
    let table: unknown = null;
    const resolve = (): unknown[] =>
      table === organizationMembers ? [{ id: 41 }] : [];
    const chain = {
      from: (t: unknown) => {
        table = t;
        return chain;
      },
      // The surviving-membership guard joins organizations to exclude deleted orgs;
      // the double models a builder, so it needs the link the query now walks.
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(resolve()),
      then: (onOk: (value: unknown) => unknown, onErr?: (reason: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onOk, onErr),
    };
    return chain;
  };
  const db = {
    select: jest.fn(() => dbSelectChain()),
    update: jest.fn(() => {
      const postUpdate: Record<string, unknown> = {
        set: () => postUpdate,
        where: () => postUpdate,
        returning: () => Promise.resolve([]),
        then: (resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
          Promise.resolve([]).then(resolve, reject),
      };
      return postUpdate;
    }),
    insert: jest.fn(() => {
      const postChain: Record<string, unknown> = {
        values: () => postChain,
        onConflictDoNothing: () => postChain,
        onConflictDoUpdate: () => postChain,
        returning: () => Promise.resolve([{ id: 1 }]),
        then: (resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
          Promise.resolve([{ id: 1 }]).then(resolve, reject),
      };
      return postChain;
    }),
    transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { db, tx };
}

function makePurgeDouble() {
  return {
    buildManifest: jest.fn().mockResolvedValue({ blocked: false, keys: [] }),
    purgeFromManifest: jest.fn().mockResolvedValue({
      blocked: false,
      dryRun: false,
      deleted: [],
      skipped: [],
      failed: [],
      manifest: [],
    }),
  };
}

function buildService(db: unknown, purge: unknown) {
  const cache = {} as CacheService;
  const effectLedger = {
    execute: jest.fn().mockImplementation(async (_eff: unknown, send: () => Promise<unknown>) => {
      await send();
      return "EXECUTED" as const;
    }),
  };
  const sessions = { revokeAllForUser: jest.fn().mockResolvedValue({ revokedCount: 0 }) };
  return new GdprSubjectErasureService(
    db as never,
    cache,
    sessions as never,
    purge as never,
    effectLedger as never,
    { commitManyPageChanges: jest.fn() } as never,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Support tickets are a sink of erasure, reached by the TOP-LEVEL entry point ──
//
// MECHANISM: `anonymiseSubjectSupportTickets` was implemented and fully specced but had
// no caller, exactly like `GdprStoragePurgeService` before it. These tests drive
// `eraseSubject`, never the helper, so an unwired helper fails them.
//
// Every fixture carries MORE tickets than SUPPORT_ERASURE_PAGE: a fixture smaller than
// one page cannot tell a drain from a single `.limit(n)`.

describe("GdprSubjectErasureService — support ticket requester PII", () => {
  it("anonymises every page of the subject's tickets through eraseSubject", async () => {
    const store = makeStore(TICKET_COUNT);
    const { db } = makeDb(store);
    const service = buildService(db, makePurgeDouble());

    const result = await service.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    const sentinel = erasedRequesterEmail(SUBJECT);
    const anonymised = store.tickets.filter((t) => t.requesterEmail === sentinel);
    expect(anonymised).toHaveLength(TICKET_COUNT);
    expect(store.ticketSelectCalls).toBe(3);
    expect(result.tablesAnonymised).toContain("support_tickets");
    expect(result.tablesAnonymised).toContain("support_ticket_embeddings");
  });

  it("deletes the embedding of every anonymised ticket, past the first page", async () => {
    const store = makeStore(TICKET_COUNT);
    const { db } = makeDb(store);
    const service = buildService(db, makePurgeDouble());

    await service.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    // Only the third party's embedding survives: its ticket was never a match.
    expect(store.embeddingTicketIds).toEqual([TICKET_COUNT + 1]);
  });

  it("runs while users.email is still live — the tombstone would match nothing", async () => {
    const store = makeStore(TICKET_COUNT);
    const { db } = makeDb(store);
    const service = buildService(db, makePurgeDouble());

    await service.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(store.emailsReadBySupportErasure).toEqual([LIVE_EMAIL]);
    expect(store.emailsReadBySupportErasure).not.toContain(erasedRequesterEmail(SUBJECT));
    expect(store.callOrder.indexOf("users.update")).toBeGreaterThan(
      store.callOrder.lastIndexOf("support_tickets.update"),
    );
    expect(store.userEmail).toBe(erasedRequesterEmail(SUBJECT));
  });

  it("leaves a third party's requester_email alone on a channel-ingested ticket", async () => {
    const store = makeStore(TICKET_COUNT);
    const { db } = makeDb(store);
    const service = buildService(db, makePurgeDouble());

    await service.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    const thirdParty = store.tickets.find((t) => t.id === TICKET_COUNT + 1);
    expect(thirdParty?.requesterEmail).toBe(THIRD_PARTY_EMAIL);
    expect(thirdParty?.requesterName).toBe("External Customer");
  });

  it("is idempotent — a second erasure finds the sentinel and touches nothing", async () => {
    const store = makeStore(TICKET_COUNT);
    const { db } = makeDb(store);
    const service = buildService(db, makePurgeDouble());

    await service.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });
    const callsAfterFirst = store.ticketSelectCalls;
    const result = await service.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: false });

    expect(store.ticketSelectCalls).toBe(callsAfterFirst);
    expect(result.tablesAnonymised).not.toContain("support_tickets");
  });

  it("declares both tables in a dry run", async () => {
    const store = makeStore(TICKET_COUNT);
    const { db } = makeDb(store);
    const service = buildService(db, makePurgeDouble());

    const result = await service.eraseSubject(SUBJECT, ORG, ACTOR, { dryRun: true });

    expect(result.tablesAnonymised).toContain("support_tickets");
    expect(result.tablesAnonymised).toContain("support_ticket_embeddings");
  });
});
