import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { kbSources } from "../../../db/schema";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { AccessService } from "../../access/access.service";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { KbCandidateService } from "./kb-candidate.service";
import { KbSearchRetrievalService } from "./kb-search-retrieval.service";

const ORG = "org-asker";
const OWN_SOURCES = [11, 12];
const FOREIGN_SOURCE = 901;

const user: CurrentUserContext = {
  userId: "user-1",
  orgId: ORG,
  isOrgOwner: false,
  role: "member",
  sessionId: "sess-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

interface FakeDb {
  readonly guardWhere: SQL[];
  readonly retrievalCalls: number;
  select: (projection: Record<string, unknown>) => unknown;
}

function fakeDb(visibleSourceIds: number[]): FakeDb {
  const guardWhere: SQL[] = [];
  let calls = 0;
  const chunkRows = visibleSourceIds.map((sourceId, index) => ({
    sourceId,
    title: `Source ${sourceId}`,
    spaceId: null,
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    content: `passage ${sourceId}`,
    chunkIndex: index,
  }));
  return {
    guardWhere,
    get retrievalCalls() {
      return calls;
    },
    select: (projection: Record<string, unknown>) => {
      calls += 1;
      if (projection.id === kbSources.id)
        return {
          from: () => ({
            where: (cond: SQL) => {
              guardWhere.push(cond);
              return Promise.resolve(visibleSourceIds.map((id) => ({ id })));
            },
          }),
        };
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve(chunkRows),
      };
      return chain;
    },
  };
}

async function retrievalOver(db: FakeDb): Promise<KbSearchRetrievalService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      KbSearchRetrievalService,
      { provide: DRIZZLE, useValue: db },
      { provide: AiGatewayService, useValue: { isEmbeddingConfigured: () => false } },
      { provide: KbCandidateService, useValue: { hasEmbeddedChunks: async () => true } },
      { provide: AccessService, useValue: {} },
      {
        provide: KnowledgeAuthorizationService,
        useValue: { resolveStanding: async () => ({ accessibleSpaceIds: [5] }) },
      },
    ],
  }).compile();
  return moduleRef.get(KbSearchRetrievalService);
}

describe("POST /kb/ask sourceIds — a requested source list is answered whole or refused whole", () => {
  it("refuses with 404 when one requested source is another organisation's, instead of answering from the caller's own", async () => {
    const db = fakeDb(OWN_SOURCES);
    const svc = await retrievalOver(db);

    await expect(
      svc.retrieveTopSourcesWithOutcome(user, "how do refunds work", 4, [...OWN_SOURCES, FOREIGN_SOURCE]),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(db.retrievalCalls).toBe(1);
  });

  it("refuses an all-foreign list with the same 404, so the refusal does not distinguish unknown from foreign", async () => {
    const db = fakeDb([]);
    const svc = await retrievalOver(db);

    await expect(
      svc.retrieveTopSourcesWithOutcome(user, "how do refunds work", 4, [FOREIGN_SOURCE]),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("binds the ownership read to the caller's organisation and the spaces the caller can see", async () => {
    const db = fakeDb(OWN_SOURCES);
    const svc = await retrievalOver(db);

    await svc.retrieveTopSourcesWithOutcome(user, "how do refunds work", 4, OWN_SOURCES);

    const [where] = db.guardWhere;
    if (where === undefined) throw new Error("the ownership read never ran");
    const rendered = new PgDialect().sqlToQuery(where);
    expect(rendered.sql).toContain('"kb_sources"."org_id" = $1');
    expect(rendered.sql).toContain('"kb_sources"."deleted_at" is null');
    expect(rendered.params).toEqual(expect.arrayContaining([ORG, ...OWN_SOURCES, 5]));
  });

  it("answers from every requested source when all of them are the caller's own", async () => {
    const db = fakeDb(OWN_SOURCES);
    const svc = await retrievalOver(db);

    const outcome = await svc.retrieveTopSourcesWithOutcome(user, "how do refunds work", 4, OWN_SOURCES);

    expect(outcome.results.map((document) => document.sourceId)).toEqual(OWN_SOURCES);
    expect(db.retrievalCalls).toBe(2);
  });

  it("skips the ownership read when no source list is requested", async () => {
    const db = fakeDb(OWN_SOURCES);
    const svc = await retrievalOver(db);

    const outcome = await svc.retrieveTopSourcesWithOutcome(user, "how do refunds work", 4);

    expect(db.guardWhere).toEqual([]);
    expect(outcome.results.map((document) => document.sourceId)).toEqual(OWN_SOURCES);
  });
});
