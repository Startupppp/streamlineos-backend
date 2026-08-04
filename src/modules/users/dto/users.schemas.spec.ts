import { bulkInviteSchema } from "./users.schemas";

describe("bulkInviteSchema", () => {
  const emails = (count: number) =>
    Array.from({ length: count }, (_, index) => `person-${index}@example.com`);

  it("accepts more than 100 invitations in one setup request", () => {
    expect(
      bulkInviteSchema.safeParse({ emails: emails(125), role: "MEMBER" }).success,
    ).toBe(true);
  });

  it("accepts 500 invitations and rejects oversized requests", () => {
    expect(bulkInviteSchema.safeParse({ emails: emails(500) }).success).toBe(true);
    expect(bulkInviteSchema.safeParse({ emails: emails(501) }).success).toBe(false);
  });
});
