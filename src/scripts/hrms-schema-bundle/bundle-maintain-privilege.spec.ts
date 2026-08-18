import { supportsMaintainPrivilege } from "./bundle-maintain-privilege";

describe("schema bundle MAINTAIN privilege version gate", () => {
  it.each([
    [150000, false],
    [160999, false],
    [170000, true],
    [180001, true],
  ])("gates server version %i", (serverVersion, expected) => {
    expect(supportsMaintainPrivilege(serverVersion)).toBe(expected);
  });
});
