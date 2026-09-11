import { BadRequestException, NotFoundException } from "@nestjs/common";
import { SurveyLiveParticipantService } from "./survey-live-participant.service";

function buildDb(opts: {
  insertedResponseSession?: { id: number };
  responseSession?: { id: number; metadata: Record<string, unknown> } | null;
  choices?: Array<{ id: number; score: number | null }>;
} = {}) {
  const insertValues = jest.fn();
  const insert = jest.fn(() => ({
    values: (values: unknown) => {
      insertValues(values);
      return { returning: jest.fn().mockResolvedValue([opts.insertedResponseSession ?? { id: 1 }]) };
    },
  }));

  const deleteWhere = jest.fn().mockResolvedValue(undefined);
  const del = jest.fn(() => ({ where: deleteWhere }));

  const db = {
    insert,
    delete: del,
    query: {
      surveyResponseSessions: {
        findFirst: jest.fn().mockResolvedValue(opts.responseSession ?? null),
      },
      surveyQuestionChoices: {
        findMany: jest.fn().mockResolvedValue(opts.choices ?? []),
      },
    },
  };
  return { db, insertValues, deleteWhere };
}

const baseSessionData = {
  id: 10,
  orgId: "org_1",
  surveyId: 3,
  versionId: 3,
  currentQuestionId: 55,
};
const baseSession = baseSessionData as never;

describe("SurveyLiveParticipantService.join", () => {
  it("rejects joining a session that has already ended", async () => {
    const { db } = buildDb();
    const service = new SurveyLiveParticipantService(db as never);
    const session = { ...baseSessionData, status: "ended" } as never;
    await expect(service.join(session, {})).rejects.toThrow(BadRequestException);
  });

  it("marks the response session anonymous when no email is given", async () => {
    const { db, insertValues } = buildDb({ insertedResponseSession: { id: 77 } });
    const service = new SurveyLiveParticipantService(db as never);
    const session = { ...baseSessionData, status: "active" } as never;
    const result = await service.join(session, { name: "Alex" });
    expect(result).toEqual({ participantToken: "77" });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ anonymous: true, metadata: { liveSessionId: 10, name: "Alex", email: null } }),
    );
  });

  it("marks the response session non-anonymous when an email is given", async () => {
    const { db, insertValues } = buildDb({ insertedResponseSession: { id: 78 } });
    const service = new SurveyLiveParticipantService(db as never);
    const session = { ...baseSessionData, status: "active" } as never;
    await service.join(session, { email: "a@b.com" });
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ anonymous: false }));
  });
});

describe("SurveyLiveParticipantService.submitAnswer", () => {
  it("rejects an answer for a question that is no longer the active one", async () => {
    const { db } = buildDb();
    const service = new SurveyLiveParticipantService(db as never);
    await expect(
      service.submitAnswer(baseSession, { participantToken: "1", questionId: 999 } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects when the participant token does not belong to this live session", async () => {
    const { db } = buildDb({ responseSession: { id: 1, metadata: { liveSessionId: 999 } } });
    const service = new SurveyLiveParticipantService(db as never);
    await expect(
      service.submitAnswer(baseSession, { participantToken: "1", questionId: 55 } as never),
    ).rejects.toThrow(NotFoundException);
  });

  it("rejects a non-numeric participant token", async () => {
    const { db } = buildDb();
    const service = new SurveyLiveParticipantService(db as never);
    await expect(
      service.submitAnswer(baseSession, { participantToken: "not-a-number", questionId: 55 } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it("sums the score of only the selected choices", async () => {
    const { db, insertValues } = buildDb({
      responseSession: { id: 1, metadata: { liveSessionId: 10 } },
      choices: [
        { id: 100, score: 100 },
        { id: 101, score: 0 },
        { id: 102, score: 50 },
      ],
    });
    const service = new SurveyLiveParticipantService(db as never);
    await service.submitAnswer(baseSession, { participantToken: "1", questionId: 55, choiceIds: [100, 102] } as never);
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ score: 150, choiceIds: [100, 102] }));
  });

  it("leaves score null when no choices were selected", async () => {
    const { db, insertValues } = buildDb({ responseSession: { id: 1, metadata: { liveSessionId: 10 } } });
    const service = new SurveyLiveParticipantService(db as never);
    await service.submitAnswer(baseSession, { participantToken: "1", questionId: 55, answerValue: "free text" } as never);
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ score: null, answerValue: "free text" }));
  });

  it("deletes any prior answer for this session+question before inserting (upsert semantics)", async () => {
    const { db, deleteWhere } = buildDb({ responseSession: { id: 1, metadata: { liveSessionId: 10 } } });
    const service = new SurveyLiveParticipantService(db as never);
    await service.submitAnswer(baseSession, { participantToken: "1", questionId: 55 } as never);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });
});

describe("SurveyLiveParticipantService.getParticipantCount", () => {
  it("returns 0 when no rows match", async () => {
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: jest.fn().mockResolvedValue([]) })),
      })),
    };
    const service = new SurveyLiveParticipantService(db as never);
    await expect(service.getParticipantCount("org-1", 10)).resolves.toBe(0);
  });

  it("returns the row's count when present", async () => {
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: jest.fn().mockResolvedValue([{ count: 4 }]) })),
      })),
    };
    const service = new SurveyLiveParticipantService(db as never);
    await expect(service.getParticipantCount("org-1", 10)).resolves.toBe(4);
  });
});
