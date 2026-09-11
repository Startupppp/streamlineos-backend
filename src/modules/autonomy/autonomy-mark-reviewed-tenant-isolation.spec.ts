import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.types";
import { AutonomyScoringService } from "./autonomy-scoring.service";

function makeDbWithScore(score: unknown) {
  const returning_ = jest.fn().mockResolvedValue(score ? [{ id: "score-1" }] : []);
  const where_ = jest.fn().mockReturnValue({ returning: returning_ });
  const set_ = jest.fn().mockReturnValue({ where: where_ });
  const update_ = jest.fn().mockReturnValue({ set: set_ });
  const findFirst = jest.fn().mockResolvedValue(score);
  const db = {
    update: update_,
    query: { autonomyShadowScores: { findFirst } },
  } as unknown as Db;
  return { db, findFirst };
}

const OWN_ORG = "aaaaaaaa-0000-0000-0000-000000000001";
const OTHER_ORG = "bbbbbbbb-0000-0000-0000-000000000002";
const USER_ID = "user-0001";
const SCORE_ID = "score-uuid-0001";

describe("AutonomyScoringService.markReviewed — cross-tenant isolation", () => {
  it("marks reviewed when the score belongs to the caller's org (own → success)", async () => {
    const { db } = makeDbWithScore({ autonomyShadowScoreId: SCORE_ID });
    const svc = new AutonomyScoringService(db, {} as never, {} as never, {} as never);
    const result = await svc.markReviewed(OWN_ORG, USER_ID, SCORE_ID);
    expect(result).toMatchObject({ reviewed: true });
  });

  it("throws 404 when the score belongs to a different org (cross-tenant → 404)", async () => {
    const { db } = makeDbWithScore(undefined);
    const svc = new AutonomyScoringService(db, {} as never, {} as never, {} as never);
    await expect(svc.markReviewed(OTHER_ORG, USER_ID, SCORE_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws 404 when the score id does not exist (unknown → 404)", async () => {
    const { db } = makeDbWithScore(undefined);
    const svc = new AutonomyScoringService(db, {} as never, {} as never, {} as never);
    await expect(svc.markReviewed(OWN_ORG, USER_ID, "nonexistent")).rejects.toBeInstanceOf(NotFoundException);
  });
});
