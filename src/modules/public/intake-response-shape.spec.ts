import "reflect-metadata";
import { BadRequestException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { IntakeService } from "./intake.service";

const PROJECT_ID = 42;
const ORG_ID = "org-test";
const REFUSAL = "Invalid request";
const PUBLISHED_AT = new Date("2024-01-01T00:00:00Z");

function makeDb(opts: {
  orgId: string | null;
  projectExists: boolean;
  intakePublished?: boolean;
}): Db {
  const orgIdRows = opts.orgId ? [{ org_id: opts.orgId }] : [{ org_id: null }];
  const intakePublishedAt =
    opts.intakePublished === false ? null : PUBLISHED_AT;
  const projectRows = opts.projectExists
    ? [{ id: PROJECT_ID, intakePublishedAt }]
    : [];

  return {
    execute: jest.fn().mockResolvedValue(orgIdRows),
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

describe("IntakeService — success response contains no sequential integer id", () => {
  it("returns only a message string on success", async () => {
    const svc = new IntakeService(makeDb({ orgId: ORG_ID, projectExists: true }));
    const result = await svc.submitIntake(PROJECT_ID, { title: "Login is broken" });

    expect(result).toMatchObject({ message: "Request submitted successfully" });
  });

  it("does not include a sequential id in the success response", async () => {
    const svc = new IntakeService(makeDb({ orgId: ORG_ID, projectExists: true }));
    const result = await svc.submitIntake(PROJECT_ID, { title: "Login is broken" });

    expect((result as Record<string, unknown>).id).toBeUndefined();
  });
});

describe("IntakeService — refusal paths throw identical errors (no second oracle)", () => {
  it("throws BadRequestException when the project id does not resolve to any org", async () => {
    const svc = new IntakeService(makeDb({ orgId: null, projectExists: false }));
    await expect(svc.submitIntake(99999, { title: "probe" })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("throws BadRequestException when the org resolves but the project is absent under RLS", async () => {
    const svc = new IntakeService(makeDb({ orgId: ORG_ID, projectExists: false }));
    await expect(svc.submitIntake(PROJECT_ID, { title: "probe" })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("both refusal paths produce the same message — walking the id space learns nothing", async () => {
    const absentSvc = new IntakeService(makeDb({ orgId: null, projectExists: false }));
    const deletedSvc = new IntakeService(makeDb({ orgId: ORG_ID, projectExists: false }));

    const absent = await absentSvc
      .submitIntake(99999, { title: "probe" })
      .then(() => null, (e: unknown) => e);
    const deleted = await deletedSvc
      .submitIntake(PROJECT_ID, { title: "probe" })
      .then(() => null, (e: unknown) => e);

    expect(absent).toBeInstanceOf(BadRequestException);
    expect(deleted).toBeInstanceOf(BadRequestException);
    expect(absent instanceof Error ? absent.message : "").toBe(REFUSAL);
    expect(deleted instanceof Error ? deleted.message : "").toBe(REFUSAL);
  });
});

describe("IntakeService — published-intake flag controls submission acceptance", () => {
  it("accepts a submission when intake_published_at is set", async () => {
    const svc = new IntakeService(
      makeDb({ orgId: ORG_ID, projectExists: true, intakePublished: true }),
    );
    const result = await svc.submitIntake(PROJECT_ID, { title: "Feature request" });

    expect(result).toMatchObject({ message: "Request submitted successfully" });
  });

  it("refuses a submission when intake_published_at is null", async () => {
    const svc = new IntakeService(
      makeDb({ orgId: ORG_ID, projectExists: true, intakePublished: false }),
    );
    await expect(
      svc.submitIntake(PROJECT_ID, { title: "probe" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("unpublished project and non-existent project produce byte-identical errors", async () => {
    const unpublishedSvc = new IntakeService(
      makeDb({ orgId: ORG_ID, projectExists: true, intakePublished: false }),
    );
    const nonExistentSvc = new IntakeService(
      makeDb({ orgId: null, projectExists: false }),
    );

    const unpublished = await unpublishedSvc
      .submitIntake(PROJECT_ID, { title: "probe" })
      .then(() => null, (e: unknown) => e);
    const nonExistent = await nonExistentSvc
      .submitIntake(99999, { title: "probe" })
      .then(() => null, (e: unknown) => e);

    expect(unpublished).toBeInstanceOf(BadRequestException);
    expect(nonExistent).toBeInstanceOf(BadRequestException);
    expect(unpublished instanceof Error ? unpublished.message : "").toBe(REFUSAL);
    expect(nonExistent instanceof Error ? nonExistent.message : "").toBe(REFUSAL);
  });

  it("refusing an unpublished project leaves the negative assertion paired with a published acceptance", async () => {
    const publishedSvc = new IntakeService(
      makeDb({ orgId: ORG_ID, projectExists: true, intakePublished: true }),
    );
    const unpublishedSvc = new IntakeService(
      makeDb({ orgId: ORG_ID, projectExists: true, intakePublished: false }),
    );

    const accepted = await publishedSvc.submitIntake(PROJECT_ID, { title: "valid" });
    const refused = await unpublishedSvc
      .submitIntake(PROJECT_ID, { title: "probe" })
      .then(() => null, (e: unknown) => e);

    expect(accepted).toMatchObject({ message: "Request submitted successfully" });
    expect(refused).toBeInstanceOf(BadRequestException);
  });
});
