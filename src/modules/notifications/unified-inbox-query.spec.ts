import { unifiedInboxQuerySchema } from "./dto/unified-inbox.schemas";

describe("unified inbox query contract", () => {
  it("parses mention event keys and a module without accepting empty keys", () => {
    const parsed = unifiedInboxQuerySchema.parse({
      limit: "25",
      eventKeys: "build.comment.mention, ,chat.message.mention",
      module: " crm ",
    });

    expect(parsed.eventKeys).toEqual([
      "build.comment.mention",
      "chat.message.mention",
    ]);
    expect(parsed.module).toBe("crm");
  });

  it("rejects an empty module filter rather than silently treating it as a source", () => {
    expect(() =>
      unifiedInboxQuerySchema.parse({ limit: "25", module: "   " }),
    ).toThrow();
  });
});
