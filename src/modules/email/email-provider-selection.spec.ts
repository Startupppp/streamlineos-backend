import { fallbackProvider, selectProvider } from "./email-provider-selection";

describe("which email provider is active", () => {
  it("honours an explicit preference when that provider is configured", () => {
    expect(selectProvider("zeptomail", true, true)).toBe("zeptomail");
    expect(selectProvider("resend", true, true)).toBe("resend");
  });

  it("ignores a preference for a provider that is not configured", () => {
    expect(selectProvider("resend", true, false)).toBe("zeptomail");
    expect(selectProvider("zeptomail", false, true)).toBe("resend");
  });

  it("prefers zeptomail when nothing is preferred and both are configured", () => {
    expect(selectProvider(undefined, true, true)).toBe("zeptomail");
  });

  it("falls to whichever single provider is configured", () => {
    expect(selectProvider(undefined, true, false)).toBe("zeptomail");
    expect(selectProvider(undefined, false, true)).toBe("resend");
  });

  it("is none when neither is configured, whatever is preferred", () => {
    expect(selectProvider(undefined, false, false)).toBe("none");
    expect(selectProvider("zeptomail", false, false)).toBe("none");
    expect(selectProvider("resend", false, false)).toBe("none");
  });
});

describe("which provider a failed send falls back to", () => {
  it("crosses to the other provider when both are configured", () => {
    expect(fallbackProvider("zeptomail", true, true)).toBe("resend");
    expect(fallbackProvider("resend", true, true)).toBe("zeptomail");
  });

  it("has no fallback when only the active provider is configured", () => {
    expect(fallbackProvider("zeptomail", true, false)).toBeNull();
    expect(fallbackProvider("resend", false, true)).toBeNull();
  });

  it("has no fallback when no provider is active", () => {
    expect(fallbackProvider("none", true, true)).toBeNull();
  });
});
