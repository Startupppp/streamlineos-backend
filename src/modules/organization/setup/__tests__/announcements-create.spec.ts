import { AnnouncementsController } from "../announcements.controller";
import {
  createHrAnnouncementSchema,
  updateHrAnnouncementSchema,
} from "../dto/announcements.schemas";

const user = { orgId: "org-1", userId: "user-1" };

describe("announcements create contract", () => {
  it("accepts a datetime-local publishAt string and hands the service a Date", async () => {
    const create = jest.fn().mockResolvedValue({ id: 1 });
    const controller = new AnnouncementsController({ create } as never);

    const body = createHrAnnouncementSchema.parse({
      title: "Quarterly townhall",
      content: "Join us in the main hall this Friday.",
      targetType: "ALL",
      status: "PUBLISHED",
      publishAt: "2026-07-25T08:17",
      isPinned: false,
    });

    await controller.create(user as never, body);

    const [, , targetIds, data] = create.mock.calls[0] as [
      string,
      string,
      string[],
      { publishAt?: Date | null; expiresAt?: Date | null; title: string },
    ];
    expect(targetIds).toEqual([]);
    expect(data.publishAt).toBeInstanceOf(Date);
    expect(Number.isNaN((data.publishAt as Date).getTime())).toBe(false);
    expect(data.expiresAt).toBeNull();
    expect(data.title).toBe("Quarterly townhall");
  });

  it("rejects invalid payloads before they reach the database", () => {
    expect(() =>
      createHrAnnouncementSchema.parse({
        title: "&^#&($^(",
        content: "FEHISO(_# n",
        status: "PUBLISHED",
      }),
    ).toThrow();

    expect(() =>
      createHrAnnouncementSchema.parse({
        title: "Valid title",
        content: "Valid announcement content here.",
        status: "SCHEDULED",
      }),
    ).toThrow();

    expect(() =>
      createHrAnnouncementSchema.parse({
        title: "Valid title",
        content: "Valid announcement content here.",
        targetType: "DEPARTMENT",
        targetIds: [],
        status: "DRAFT",
      }),
    ).toThrow();
  });

  it("rejects unknown fields so clients cannot mass-assign columns", () => {
    const result = createHrAnnouncementSchema.safeParse({
      title: "Valid title",
      content: "Valid announcement content here.",
      status: "DRAFT",
      id: 999,
      orgId: "attacker-org",
      readCount: 42,
    });
    expect(result.success).toBe(false);
    const keys = result.success
      ? []
      : result.error.issues.flatMap((issue) =>
          issue.code === "unrecognized_keys" ? issue.keys : [],
        );
    expect(keys).toEqual(expect.arrayContaining(["id", "orgId", "readCount"]));
  });

  it("accepts a body carrying exactly the nine client-owned fields", () => {
    const result = createHrAnnouncementSchema.safeParse({
      title: "Valid title",
      content: "Valid announcement content here.",
      targetType: "ALL",
      targetIds: [],
      status: "DRAFT",
      publishAt: undefined,
      expiresAt: undefined,
      isPinned: false,
      attachmentUrls: [],
    });
    expect(result.success).toBe(true);
  });

  it("update converts provided dates and leaves omitted dates untouched", async () => {
    const update = jest.fn().mockResolvedValue({ id: 1 });
    const controller = new AnnouncementsController({ update } as never);

    const body = updateHrAnnouncementSchema.parse({
      expiresAt: "2026-08-01T18:00",
    });
    await controller.update(user as never, 1, body);

    const [, , , patch] = update.mock.calls[0] as [
      string,
      number,
      string[] | undefined,
      { publishAt?: Date | null; expiresAt?: Date | null },
    ];
    expect(patch.expiresAt).toBeInstanceOf(Date);
    expect(patch).not.toHaveProperty("publishAt");
  });
});
