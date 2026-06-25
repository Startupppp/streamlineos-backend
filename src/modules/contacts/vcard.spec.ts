import { buildVcard, vcardFilename } from "./vcard";

describe("buildVcard", () => {
  it("emits required vcard fields with CRLF line endings", () => {
    const out = buildVcard({ name: "Jane Doe" });
    expect(out.startsWith("BEGIN:VCARD\r\nVERSION:3.0")).toBe(true);
    expect(out).toContain("FN:Jane Doe");
    expect(out).toContain("N:Doe;Jane;;;");
    expect(out.endsWith("END:VCARD\r\n")).toBe(true);
  });

  it("splits a single-word name into first name with empty last name", () => {
    expect(buildVcard({ name: "Cher" })).toContain("N:;Cher;;;");
  });

  it("includes optional fields only when present", () => {
    const out = buildVcard({
      name: "Jane Doe",
      email: "jane@x.com",
      phone: "123",
      company: "Acme",
      title: "CEO",
      websiteUrl: "https://x.com",
      linkedinUrl: "https://li.com/jane",
      twitterUrl: "https://t.com/jane",
    });
    expect(out).toContain("TEL;TYPE=CELL:123");
    expect(out).toContain("EMAIL:jane@x.com");
    expect(out).toContain("ORG:Acme");
    expect(out).toContain("TITLE:CEO");
    expect(out).toContain("URL:https://x.com");
    expect(out).toContain("X-SOCIALPROFILE;type=linkedin:https://li.com/jane");
    expect(out).toContain("X-SOCIALPROFILE;type=twitter:https://t.com/jane");
  });

  it("omits optional fields when absent or null", () => {
    const out = buildVcard({ name: "Jane Doe", email: null, phone: undefined });
    expect(out).not.toContain("EMAIL:");
    expect(out).not.toContain("TEL;");
  });
});

describe("vcardFilename", () => {
  it("slugifies the name to a safe lowercase filename", () => {
    expect(vcardFilename("Jane Doe!")).toBe("jane_doe_");
  });
});
