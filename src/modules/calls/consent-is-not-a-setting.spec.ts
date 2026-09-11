import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_PERMISSION_NAMES } from "../rbac/permissions";
import {
  callRecordingConsentVerdict,
  CONSENT_REGIME_REGISTER,
} from "./call-recording-consent";
import {
  callRecordingConsentBodySchema,
  consentRefusalQuerySchema,
} from "./dto/call-recording-consent.schemas";

/**
 * The consent rule is enforcement, not configuration.
 *
 * A two-party consent jurisdiction is criminal law. Recording a conversation
 * there without every participant's agreement is an offence, and running a model
 * over the recording compounds it — so this is not a dial a customer success
 * conversation can move for one account. `send-guardrails.ts` says the same
 * about outbound and `send-guardrails.spec.ts` pins it the same way; this file
 * is that pattern applied to the one rule in the product where the consequence
 * of getting it wrong is not a complaint but a prosecution.
 *
 * The way a rule like this dies is never a decision to remove it. It is somebody
 * adding an override "just for one customer" — a `consentRequired: false` on a
 * settings row, a `?force=true`, a `crm:call-analysis:override` permission — and
 * the next person to read the code taking the override for the rule. Each
 * describe below closes one of those doors, and each fails at the door rather
 * than in production.
 */

const OVERRIDE_KEYS = [
  "consentRequired",
  "requireConsent",
  "enforceConsent",
  "skipConsentCheck",
  "consentCheckEnabled",
  "twoPartyConsentEnabled",
  "jurisdictionOverride",
  "defaultJurisdiction",
  "regime",
  "consentRegime",
  "analyseAnyway",
  "force",
  "bypass",
  "consentedAt",
  "ruleVersion",
];

describe("no request body can reach the rule", () => {
  const valid = {
    jurisdiction: "US-CA",
    orgPartyConsented: true,
    counterpartyConsented: true,
    counterpartyMethod: "announced-and-acknowledged" as const,
  };

  it("accepts the attestation itself, so the rest of this file is not vacuous", () => {
    expect(callRecordingConsentBodySchema.safeParse(valid).success).toBe(true);
  });

  it("rejects every key that would let a caller switch the rule off", () => {
    for (const key of OVERRIDE_KEYS) {
      const attempt = { ...valid, [key]: true };
      expect(
        `${key}: ${callRecordingConsentBodySchema.safeParse(attempt).success}`,
      ).toBe(`${key}: false`);
    }
  });

  it("rejects an override smuggled in beside fields that are legitimate", () => {
    /**
     * `.strict()` is what makes this fail. Zod's default is to strip an unknown
     * key silently, which would accept the request, drop the override, and leave
     * whoever added it believing it was honoured somewhere further down.
     */
    expect(
      callRecordingConsentBodySchema.safeParse({
        ...valid,
        note: "customer is fine with it",
        skipConsentCheck: true,
      }).success,
    ).toBe(false);
  });

  it("rejects a caller-supplied consent timestamp on the ledger query too", () => {
    // The refusal ledger is a read, but a `sinceDays` schema that accepted
    // unknown keys is the natural place for a `?force=` to be added later and
    // for nobody to notice it does nothing.
    expect(consentRefusalQuerySchema.safeParse({ sinceDays: 7 }).success).toBe(true);
    expect(consentRefusalQuerySchema.safeParse({ sinceDays: 7, force: true }).success).toBe(false);
  });
});

describe("no permission key can reach the rule", () => {
  it("catalogues no override, waiver or bypass key anywhere in the product", () => {
    /**
     * A key like `crm:call-analysis:override` would be grantable, and therefore
     * would exist for an administrator under pressure to grant. A criminal-law
     * constraint an administrator can lift is an advisory. The scan is across
     * the whole catalogue rather than the CRM namespace, because the key that
     * unlocks this would not necessarily be named after this module.
     */
    const suspicious = ALL_PERMISSION_NAMES.filter((name) =>
      /(consent|recording).*(override|waive|bypass|disable|skip)|(override|waive|bypass|skip).*(consent|recording)/i.test(
        name,
      ),
    );
    expect(suspicious).toEqual([]);
  });

  it("keeps the attest key off the suffixes that grant it to every rep", () => {
    // `buildModuleMemberPermissionKeys` hands every key ending `:view` or
    // `:read` to CRM_MODULE_MEMBER. A rep is both the person who knows whether
    // the notice was played and the person the attestation benefits.
    const key = "crm:call-recording-consent:attest";
    expect(ALL_PERMISSION_NAMES).toContain(key);
    expect(key.endsWith(":view")).toBe(false);
    expect(key.endsWith(":read")).toBe(false);
  });
});

describe("no column, route or flag reaches the rule", () => {
  const sourceFiles = (): string[] =>
    execSync('git ls-files --cached --others --exclude-standard -- "src/**/*.ts"', {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    })
      .split("\n")
      .filter((path) => path.endsWith(".ts") && !path.endsWith(".spec.ts"));

  it("has no source file that both imports the rule and mentions a tenant override", () => {
    /**
     * The scan is over importers rather than over the whole tree, because the
     * word "override" is unremarkable elsewhere and a test that fails on every
     * unrelated commit is a test somebody deletes. What is being caught is a
     * file that both knows about the rule and knows about a switch — which is
     * the exact shape of the change this whole file exists to prevent.
     */
    const offenders = sourceFiles().filter((path) => {
      let source: string;
      try {
        source = readFileSync(path, "utf8");
      } catch {
        return false;
      }
      if (!source.includes("call-recording-consent")) return false;
      return /consentRequired|skipConsent|consentEnabled|jurisdictionOverride|bypassConsent/i.test(
        source,
      );
    });

    expect(offenders).toEqual([]);
  });

  it("keeps the register in the rule module, not in a table", () => {
    /**
     * The register is a `const` in a source file so that changing it is a code
     * change under review — somebody's signed decision that a market may be
     * recorded one-party, findable later in a diff. A `jurisdiction_regimes`
     * table would make the same change an UPDATE nobody reviews.
     */
    const migrations = join(__dirname, "../../../migrations");
    const files = execSync(`ls ${migrations}`, { encoding: "utf8" }).split("\n");
    const regimeTables = files.filter((f) => /regime|jurisdiction_rule/i.test(f));
    expect(regimeTables).toEqual([]);

    expect(Object.keys(CONSENT_REGIME_REGISTER).length).toBeGreaterThan(0);
  });

  it("keeps the rule a function of one snapshot rather than of a policy argument", () => {
    /**
     * Arity, asserted the way `send-guardrails.spec.ts` asserts it. A second
     * parameter is how a rule like this acquires a `policy` or an `options` bag,
     * and the first thing anybody puts in one is the exception they needed
     * today.
     */
    expect(callRecordingConsentVerdict).toHaveLength(1);
  });

  it("has no route anywhere that names a consent override", () => {
    const offenders = sourceFiles().filter((path) => {
      if (!path.includes("/calls/")) return false;
      let source: string;
      try {
        source = readFileSync(path, "utf8");
      } catch {
        return false;
      }
      // A `@Post(":activityId/analysis/force")` or similar. Narrow to the
      // module, because that is where such a route would be added.
      return /@(Get|Post|Put|Patch|Delete)\([^)]*(force|override|waive|bypass|skip)/i.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
