import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import { ProjectsFeedbackService } from "./projects-feedback.service";
import {
  createFeedbackSchema,
  updateFeedbackSchema,
} from "../dto/roadmap.schemas";

const ORG = "org-feedback";
const OTHER_ORG = "org-intruder";

interface FeedbackRowShape {
  id: number;
  crmOrganizationId: number | null;
  accountValueSnapshot?: string | null;
  accountTierSnapshot?: "free" | "pro" | "enterprise" | null;
  linkedRoadmapItemId: number | null;
  duplicateOfId: number | null;
}

function feedbackRow(overrides: Partial<FeedbackRowShape> = {}): FeedbackRowShape {
  return {
    id: 5,
    crmOrganizationId: null,
    accountValueSnapshot: null,
    accountTierSnapshot: null,
    linkedRoadmapItemId: null,
    duplicateOfId: null,
    ...overrides,
  };
}

/**
 * The reference lookups and the write share `db.select`; `rows` is what every
 * reference lookup resolves to, so an empty array is "that id names nothing here".
 */
function makeService(parts: {
  referenceRows?: unknown[];
  insert?: jest.Mock;
  update?: jest.Mock;
}) {
  const limit = jest.fn().mockResolvedValue(parts.referenceRows ?? [{ id: 1 }]);
  const where = jest.fn().mockReturnValue({ limit });
  const select = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({ where, innerJoin: jest.fn().mockReturnValue({ where }) }),
  });
  const db = {
    select,
    insert: parts.insert ?? jest.fn(),
    update: parts.update ?? jest.fn(),
    query: { feedbackPosts: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) } },
  } as unknown as Db;
  return { service: new ProjectsFeedbackService(db), select };
}

function insertCapture(returned: FeedbackRowShape) {
  const values = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([returned]) });
  return { insert: jest.fn().mockReturnValue({ values }), values };
}

function updateCapture(returned: FeedbackRowShape | undefined) {
  const where = jest
    .fn()
    .mockReturnValue({ returning: jest.fn().mockResolvedValue(returned ? [returned] : []) });
  const set = jest.fn().mockReturnValue({ where });
  return { update: jest.fn().mockReturnValue({ set }), set };
}

describe("createFeedbackSchema — crm_organization_id was published but unwritable; the input gap is closed", () => {
  it("accepts a company id on create", () => {
    const parsed = createFeedbackSchema.parse({ title: "Bulk export", crmOrganizationId: 42 });
    expect(parsed.crmOrganizationId).toBe(42);
  });

  it("still rejects an unknown key, so .strict() was not widened to let the new field in (BE-13)", () => {
    expect(() =>
      createFeedbackSchema.parse({ title: "Bulk export", crmOrganisationId: 42 }),
    ).toThrow();
  });

  it("rejects a non-positive company id rather than writing a sentinel", () => {
    expect(() => createFeedbackSchema.parse({ title: "x", crmOrganizationId: 0 })).toThrow();
  });

  it("accepts an explicit null on update so an account link can be cleared", () => {
    expect(updateFeedbackSchema.parse({ crmOrganizationId: null }).crmOrganizationId).toBeNull();
  });
});

describe("ProjectsFeedbackService.createFeedback — the account link reaches the insert", () => {
  it("writes the company id into the insert values", async () => {
    const { insert, values } = insertCapture(feedbackRow({ crmOrganizationId: 42 }));
    const { service } = makeService({ insert });
    await service.createFeedback(ORG, "user-1", {
      title: "Bulk export",
      status: "open",
      crmOrganizationId: 42,
    });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        crmOrganizationId: 42,
        accountValueSnapshot: null,
        accountTierSnapshot: null,
      }),
    );
  });

  it("captures the CRM tier and lifetime value at attribution time", async () => {
    const { insert, values } = insertCapture(
      feedbackRow({ accountTierSnapshot: "enterprise", accountValueSnapshot: "1250.00" }),
    );
    const { service } = makeService({
      insert,
      referenceRows: [{ accountTierSnapshot: "enterprise", accountValueSnapshot: "1250.00" }],
    });
    await service.createFeedback(ORG, "user-1", {
      title: "Bulk export",
      status: "open",
      crmOrganizationId: 42,
    });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        accountTierSnapshot: "enterprise",
        accountValueSnapshot: "1250.00",
      }),
    );
  });

  it("writes null rather than undefined when no company is named", async () => {
    const { insert, values } = insertCapture(feedbackRow());
    const { service } = makeService({ insert });
    await service.createFeedback(ORG, "user-1", { title: "Bulk export", status: "open" });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ crmOrganizationId: null }));
  });

  it("refuses a company id from another tenant with a 404, never a 403 (BE-91)", async () => {
    const { insert } = insertCapture(feedbackRow());
    const { service } = makeService({ insert, referenceRows: [] });
    await expect(
      service.createFeedback(OTHER_ORG, "user-1", {
        title: "Bulk export",
        status: "open",
        crmOrganizationId: 42,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("ProjectsFeedbackService.updateFeedback — the account link round-trips through the patch", () => {
  it("passes the company id to .set so an existing post can be attributed", async () => {
    const { update, set } = updateCapture(feedbackRow({ crmOrganizationId: 42 }));
    const { service } = makeService({ update });
    await service.updateFeedback(ORG, 5, { crmOrganizationId: 42 });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        crmOrganizationId: 42,
        accountValueSnapshot: null,
        accountTierSnapshot: null,
      }),
    );
  });

  it("refuses a cross-tenant company id on update with a 404 and leaves the row untouched", async () => {
    const { update } = updateCapture(feedbackRow());
    const { service } = makeService({ update, referenceRows: [] });
    await expect(
      service.updateFeedback(OTHER_ORG, 5, { crmOrganizationId: 42 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(update).not.toHaveBeenCalled();
  });
});
