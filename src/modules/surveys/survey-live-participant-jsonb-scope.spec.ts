import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import { SurveyLiveParticipantService } from "./survey-live-participant.service";
import type { Db } from "../../db/drizzle.module";

/**
 * PRD-C058. `survey_response_sessions.metadata->>'liveSessionId'` is the only link between
 * a live session and its participants: it is filtered on, joined on and used to decide
 * whether a participant token belongs to this session. Two things were wrong with it and
 * both are pinned here.
 *
 *   1. NO TENANT PREDICATE. getQuestionResults and getParticipantCount matched on the JSONB
 *      key alone, across every organisation in the deployment, and the read that resolves a
 *      participant token fetched the session row by id with no org predicate either.
 *   2. UNBOUNDED. getQuestionResults fetched one row per participant answer and counted them
 *      in JavaScript. The classification file called it a FALSE-POSITIVE with the
 *      justification "live participant reads bounded by sessionId+userId", which described a
 *      different query — that is an allowlist entry standing in for a fix.
 *
 * The index that makes the predicate a lookup rather than a scan of the tenant's whole
 * survey history is migration 1065; it is measured there, not here.
 */

const dialect = new PgDialect();
const ORG = "org-owner";
const OTHER_ORG = "org-attacker";
const LIVE_SESSION = 7;
const QUESTION = 11;

function rendered(condition: SQL | undefined): { sql: string; params: unknown[] } {
  if (condition === undefined) throw new Error("no condition was captured");
  const query = dialect.sqlToQuery(condition);
  return { sql: query.sql, params: query.params };
}

describe("SurveyLiveParticipantService — the liveSessionId JSONB key is tenant-scoped and bounded", () => {
  it("scopes getQuestionResults to the caller's organisation on both sides of the join", async () => {
    let captured: SQL | undefined;
    const groupBy = jest.fn().mockResolvedValue([]);
    const where = jest.fn((condition: SQL) => {
      captured = condition;
      return { groupBy };
    });
    const findMany = jest.fn().mockResolvedValue([]);
    const db = {
      select: jest.fn(() => ({ from: jest.fn(() => ({ innerJoin: jest.fn(() => ({ where })) })) })),
      query: { surveyQuestionChoices: { findMany } },
    } as unknown as Db;

    await new SurveyLiveParticipantService(db).getQuestionResults(ORG, LIVE_SESSION, QUESTION);

    const { sql, params } = rendered(captured);
    expect(sql).toContain("org_id");
    expect(params).toContain(ORG);
    expect(params).not.toContain(OTHER_ORG);
    expect(sql).toContain("liveSessionId");
    expect(groupBy).toHaveBeenCalled();
  });

  it("aggregates getQuestionResults in SQL rather than one row per participant", async () => {
    const groupBy = jest.fn().mockResolvedValue([{ choiceIds: [3], answers: 400 }]);
    const projections: unknown[] = [];
    const findMany = jest.fn().mockResolvedValue([{ id: 3, label: "Yes", isCorrect: true }]);
    const db = {
      select: jest.fn((projection: unknown) => {
        projections.push(projection);
        return { from: jest.fn(() => ({ innerJoin: jest.fn(() => ({ where: jest.fn(() => ({ groupBy })) })) })) };
      }),
      query: { surveyQuestionChoices: { findMany } },
    } as unknown as Db;

    const result = await new SurveyLiveParticipantService(db).getQuestionResults(ORG, LIVE_SESSION, QUESTION);

    const projection = projections[0] as { answers?: SQL } | undefined;
    expect(rendered(projection?.answers).sql).toContain("count(*)");
    expect(result.responseCount).toBe(400);
    expect(result.choiceDistribution).toEqual([{ choiceId: 3, label: "Yes", count: 400, isCorrect: true }]);
  });

  it("bounds every survey_question_choices read", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const db = {
      select: jest.fn(() => ({ from: jest.fn(() => ({ innerJoin: jest.fn(() => ({ where: jest.fn(() => ({ groupBy: jest.fn().mockResolvedValue([]) })) })) })) })),
      query: { surveyQuestionChoices: { findMany } },
    } as unknown as Db;

    await new SurveyLiveParticipantService(db).getQuestionResults(ORG, LIVE_SESSION, QUESTION);

    const options = findMany.mock.calls[0]?.[0] as { limit?: number } | undefined;
    expect(typeof options?.limit).toBe("number");
    expect(options?.limit).toBeGreaterThan(0);
  });

  it("scopes getParticipantCount to the caller's organisation", async () => {
    let captured: SQL | undefined;
    const where = jest.fn((condition: SQL) => {
      captured = condition;
      return Promise.resolve([{ count: 3 }]);
    });
    const db = { select: jest.fn(() => ({ from: jest.fn(() => ({ where })) })) } as unknown as Db;

    const count = await new SurveyLiveParticipantService(db).getParticipantCount(ORG, LIVE_SESSION);

    expect(count).toBe(3);
    const { sql, params } = rendered(captured);
    expect(sql).toContain("org_id");
    expect(params).toContain(ORG);
    expect(sql).toContain("liveSessionId");
  });

  it("resolves a participant token only inside the session's own organisation", async () => {
    let captured: SQL | undefined;
    const findFirst = jest.fn((options: { where: SQL }) => {
      captured = options.where;
      return Promise.resolve(undefined);
    });
    const db = { query: { surveyResponseSessions: { findFirst } } } as unknown as Db;
    const service = new SurveyLiveParticipantService(db);
    const session = { id: LIVE_SESSION, orgId: ORG, surveyId: 5, versionId: 2, status: "active", currentQuestionId: QUESTION } as never;

    await expect(service.submitAnswer(session, { questionId: QUESTION, participantToken: "42" } as never)).rejects.toThrow(
      "Participant not found for this session",
    );
    const { sql, params } = rendered(captured);
    expect(sql).toContain("org_id");
    expect(params).toContain(ORG);
  });
});
