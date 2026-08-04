import { listMembersSchema } from "./organization.schemas";

describe("listMembersSchema", () => {
  it("rejects member page sizes above 100", () => {
    expect(() => listMembersSchema.parse({ limit: 101 })).toThrow();
  });
});
