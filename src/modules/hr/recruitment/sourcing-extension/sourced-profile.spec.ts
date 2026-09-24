import {
  candidateSourceFor,
  normaliseProfileUrl,
  sourcingNote,
  splitDisplayName,
} from "./sourced-profile";
import { saveSourcedProfileSchema } from "./sourced-profile.schemas";

describe("normaliseProfileUrl", () => {
  it("treats the same LinkedIn profile reached three ways as one URL", () => {
    const canonical = normaliseProfileUrl("https://www.linkedin.com/in/jane-doe-1a2b3c/");
    const withTracking = normaliseProfileUrl(
      "https://linkedin.com/in/jane-doe-1a2b3c?originalSubdomain=in&trk=people-search",
    );
    const withFragment = normaliseProfileUrl("https://www.linkedin.com/in/jane-doe-1a2b3c#skills");

    expect(canonical?.url).toBe("https://linkedin.com/in/jane-doe-1a2b3c");
    expect(withTracking?.url).toBe(canonical?.url);
    expect(withFragment?.url).toBe(canonical?.url);
  });

  it("keeps an identifying query parameter, so two Naukri profiles stay two people", () => {
    const first = normaliseProfileUrl("https://resdex.naukri.com/v2/candidate?id=99887766");
    const second = normaliseProfileUrl("https://resdex.naukri.com/v2/candidate?id=11223344");

    expect(first?.url).not.toBe(second?.url);
    expect(first?.url).toContain("id=99887766");
    expect(first?.platform).toBe("naukri");
  });

  it("orders surviving parameters so parameter order is not identity", () => {
    const a = normaliseProfileUrl("https://example.com/p?b=2&a=1");
    const b = normaliseProfileUrl("https://example.com/p?a=1&b=2");
    expect(a?.url).toBe(b?.url);
  });

  it("does not fold two different paths together when only tracking differs", () => {
    const one = normaliseProfileUrl("https://linkedin.com/in/alpha?utm_source=x");
    const two = normaliseProfileUrl("https://linkedin.com/in/beta?utm_source=x");
    expect(one?.url).not.toBe(two?.url);
  });

  it("refuses anything that is not http or https", () => {
    expect(normaliseProfileUrl("javascript:alert(1)")).toBeNull();
    expect(normaliseProfileUrl("data:text/html,<script>")).toBeNull();
    expect(normaliseProfileUrl("file:///etc/passwd")).toBeNull();
    expect(normaliseProfileUrl("   ")).toBeNull();
    expect(normaliseProfileUrl("not a url")).toBeNull();
  });

  it("accepts a bare www address a recruiter pasted without a scheme", () => {
    expect(normaliseProfileUrl("www.linkedin.com/in/jane")?.url).toBe(
      "https://linkedin.com/in/jane",
    );
  });

  it("reads the platform off a subdomain", () => {
    expect(normaliseProfileUrl("https://in.linkedin.com/in/jane")?.platform).toBe("linkedin");
    expect(normaliseProfileUrl("https://github.com/jane")?.platform).toBe("github");
    expect(normaliseProfileUrl("https://uk.indeed.com/r/abc")?.platform).toBe("indeed");
    expect(normaliseProfileUrl("https://example.org/jane")?.platform).toBe("other");
  });

  it("does not match a lookalike host that merely contains the name", () => {
    expect(normaliseProfileUrl("https://linkedin.com.evil.test/in/jane")?.platform).toBe("other");
    expect(normaliseProfileUrl("https://notlinkedin.com/in/jane")?.platform).toBe("other");
  });

  it("normalises the host but leaves path case alone, because paths are identity", () => {
    expect(normaliseProfileUrl("https://LinkedIn.COM/in/Jane-Doe")?.url).toBe(
      "https://linkedin.com/in/Jane-Doe",
    );
  });
});

describe("candidateSourceFor", () => {
  it("only ever returns a value the candidate source filter already offers", () => {
    const catalogued = ["LINKEDIN", "NAUKRI", "INDEED", "REFERRAL", "CAREERS_PAGE", "DIRECT", "JOB_PORTAL", "CAMPUS"];
    for (const platform of ["linkedin", "naukri", "indeed", "github", "other"] as const) {
      expect(catalogued).toContain(candidateSourceFor(platform));
    }
  });
});

describe("splitDisplayName", () => {
  it("splits a two-part name", () => {
    expect(splitDisplayName("Jane Doe")).toEqual({ firstName: "Jane", lastName: "Doe" });
  });

  it("keeps a compound surname whole", () => {
    expect(splitDisplayName("Ana Maria de Souza")).toEqual({
      firstName: "Ana",
      lastName: "Maria de Souza",
    });
  });

  it("gives a mononym a last name, because the column is NOT NULL", () => {
    expect(splitDisplayName("Prince")).toEqual({ firstName: "Prince", lastName: "Prince" });
  });

  it("collapses the whitespace a copied page brings with it", () => {
    expect(splitDisplayName("  Jane\n\tDoe  ")).toEqual({ firstName: "Jane", lastName: "Doe" });
  });

  it("returns null for a name with nothing in it", () => {
    expect(splitDisplayName("   ")).toBeNull();
  });
});

describe("saveSourcedProfileSchema", () => {
  const valid = {
    profileUrl: "https://www.linkedin.com/in/jane-doe",
    fullName: "Jane Doe",
    consent: true,
  };

  it("accepts the minimum a page can offer", () => {
    const parsed = saveSourcedProfileSchema.parse(valid);
    expect(parsed.email).toBeNull();
    expect(parsed.skills).toEqual([]);
  });

  it("refuses a save with consent missing", () => {
    const { consent: _consent, ...withoutConsent } = valid;
    expect(saveSourcedProfileSchema.safeParse(withoutConsent).success).toBe(false);
  });

  it("refuses a save with consent explicitly withheld", () => {
    expect(saveSourcedProfileSchema.safeParse({ ...valid, consent: false }).success).toBe(false);
  });

  it("refuses a profileUrl that would not normalise", () => {
    expect(
      saveSourcedProfileSchema.safeParse({ ...valid, profileUrl: "javascript:alert(1)" }).success,
    ).toBe(false);
  });

  it("lowercases the email so dedupe is not case-sensitive", () => {
    const parsed = saveSourcedProfileSchema.parse({ ...valid, email: "Jane.Doe@Example.COM" });
    expect(parsed.email).toBe("jane.doe@example.com");
  });

  it("turns a blank optional field into null rather than an empty string", () => {
    const parsed = saveSourcedProfileSchema.parse({ ...valid, headline: "   ", phone: "" });
    expect(parsed.headline).toBeNull();
    expect(parsed.phone).toBeNull();
  });

  it("refuses an unknown field, so a page cannot smuggle one in", () => {
    expect(
      saveSourcedProfileSchema.safeParse({ ...valid, status: "HIRED" }).success,
    ).toBe(false);
  });

  it("caps the skills a listing can contribute", () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `skill-${i}`);
    expect(saveSourcedProfileSchema.safeParse({ ...valid, skills: tooMany }).success).toBe(false);
  });
});

describe("sourcingNote", () => {
  it("records where the profile came from", () => {
    const note = sourcingNote({
      platform: "linkedin",
      profileUrl: "https://linkedin.com/in/jane",
      headline: "Staff Engineer at Acme",
      recruiterNote: "Met at a meetup.",
    });
    expect(note).toContain("Sourced from a linkedin profile: https://linkedin.com/in/jane");
    expect(note).toContain("Staff Engineer at Acme");
    expect(note).toContain("Met at a meetup.");
  });

  it("omits the lines it has nothing for", () => {
    const note = sourcingNote({
      platform: "other",
      profileUrl: "https://example.com/jane",
      headline: null,
      recruiterNote: null,
    });
    expect(note).toBe("Sourced from a web profile: https://example.com/jane");
  });
});
