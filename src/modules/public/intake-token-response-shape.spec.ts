import "reflect-metadata";
import { BadRequestException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { IntakeService } from "./intake.service";

const PROJECT_ID = 42;
const ORG_ID = "org-test";
const TOKEN = "deadbeef0102030405060708090a0b0c0d0e0f10111213141516171819";
const REFUSAL = "Invalid request";
const PUBLISHED_AT = new Date("2024-01-01T00:00:00Z");

function makeDb(opts: {
  orgIdByToken: string | null;
  projectIdByToken: number | null;
  projectExists: boolean;
  intakePublished?: boolean;
}): Db {
  const resolverRows =
    opts.orgIdByToken && opts.projectIdByToken
      ? [{ project_id: opts.projectIdByToken, org_id: opts.orgIdByToken }]
      : [];
  const intakePublishedAt =
    opts.intakePublished === false ? null : PUBLISHED_AT;
  const projectRows = opts.projectExists
    ? [{ id: PROJECT_ID, intakePublishedAt }]
    : [];

  return {
    execute: jest.fn().mockResolvedValue(resolverRows),
    transaction: jest
      .fn()
      .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          execute: jest.fn().mockResolvedValue([]),
          select: jest.fn().mockReturnValue({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue(projectRows),
              }),
            }),
          }),
          insert: jest.fn().mockReturnValue({
            values: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ id: 99 }]),
            }),
          }),
        }),
      ),
  } as unknown as Db;
}

describe("IntakeService.submitIntakeByToken — three failure cases are indistinguishable", () => {
  it("throws BadRequestException for an unknown token (resolver returns empty)", async () => {
    const svc = new IntakeService(
      makeDb({ orgIdByToken: null, projectIdByToken: null, projectExists: false }),
    );
    await expect(
      svc.submitIntakeByToken("totally-unknown-token", { title: "probe" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("throws BadRequestException when the token resolves but the project is soft-deleted", async () => {
    const svc = new IntakeService(
      makeDb({ orgIdByToken: ORG_ID, projectIdByToken: PROJECT_ID, projectExists: false }),
    );
    await expect(
      svc.submitIntakeByToken(TOKEN, { title: "probe" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("throws BadRequestException when the token resolves but intake is not published", async () => {
    const svc = new IntakeService(
      makeDb({
        orgIdByToken: ORG_ID,
        projectIdByToken: PROJECT_ID,
        projectExists: true,
        intakePublished: false,
      }),
    );
    await expect(
      svc.submitIntakeByToken(TOKEN, { title: "probe" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("all three failure cases produce the same message — oracle learns nothing from the response body", async () => {
    const unknownTokenSvc = new IntakeService(
      makeDb({ orgIdByToken: null, projectIdByToken: null, projectExists: false }),
    );
    const deletedProjectSvc = new IntakeService(
      makeDb({ orgIdByToken: ORG_ID, projectIdByToken: PROJECT_ID, projectExists: false }),
    );
    const unpublishedSvc = new IntakeService(
      makeDb({
        orgIdByToken: ORG_ID,
        projectIdByToken: PROJECT_ID,
        projectExists: true,
        intakePublished: false,
      }),
    );

    const capture = (p: Promise<unknown>) =>
      p.then(() => null, (e: unknown) => e);

    const [unknown, deleted, unpublished] = await Promise.all([
      capture(unknownTokenSvc.submitIntakeByToken("totally-unknown-token", { title: "probe" })),
      capture(deletedProjectSvc.submitIntakeByToken(TOKEN, { title: "probe" })),
      capture(unpublishedSvc.submitIntakeByToken(TOKEN, { title: "probe" })),
    ]);

    expect(unknown).toBeInstanceOf(BadRequestException);
    expect(deleted).toBeInstanceOf(BadRequestException);
    expect(unpublished).toBeInstanceOf(BadRequestException);

    expect(unknown instanceof Error ? unknown.message : "").toBe(REFUSAL);
    expect(deleted instanceof Error ? deleted.message : "").toBe(REFUSAL);
    expect(unpublished instanceof Error ? unpublished.message : "").toBe(REFUSAL);
  });
});

describe("IntakeService.submitIntakeByToken — success path", () => {
  it("returns a message string and never exposes an internal id", async () => {
    const svc = new IntakeService(
      makeDb({
        orgIdByToken: ORG_ID,
        projectIdByToken: PROJECT_ID,
        projectExists: true,
        intakePublished: true,
      }),
    );
    const result = await svc.submitIntakeByToken(TOKEN, { title: "Feature request" });

    expect(result).toMatchObject({ message: "Request submitted successfully" });
    expect((result as Record<string, unknown>).id).toBeUndefined();
  });

  it("accepts a full payload including optional fields", async () => {
    const svc = new IntakeService(
      makeDb({
        orgIdByToken: ORG_ID,
        projectIdByToken: PROJECT_ID,
        projectExists: true,
        intakePublished: true,
      }),
    );
    const result = await svc.submitIntakeByToken(TOKEN, {
      title: "Bug report",
      description: "Steps to reproduce",
      submitterEmail: "user@example.com",
      submitterName: "Jane Smith",
      priority: "high",
      requestType: "bug",
    });

    expect(result).toMatchObject({ message: "Request submitted successfully" });
  });
});

describe("IntakeService.submitIntakeByToken — failure paired with success (BE-141 positive)", () => {
  it("unpublished intake is refused while a published one for the same token succeeds", async () => {
    const publishedSvc = new IntakeService(
      makeDb({
        orgIdByToken: ORG_ID,
        projectIdByToken: PROJECT_ID,
        projectExists: true,
        intakePublished: true,
      }),
    );
    const unpublishedSvc = new IntakeService(
      makeDb({
        orgIdByToken: ORG_ID,
        projectIdByToken: PROJECT_ID,
        projectExists: true,
        intakePublished: false,
      }),
    );

    const accepted = await publishedSvc.submitIntakeByToken(TOKEN, { title: "valid" });
    const refused = await unpublishedSvc
      .submitIntakeByToken(TOKEN, { title: "probe" })
      .then(() => null, (e: unknown) => e);

    expect(accepted).toMatchObject({ message: "Request submitted successfully" });
    expect(refused).toBeInstanceOf(BadRequestException);
  });
});
