import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  DeliveryClass,
  DELIVERY_CLASS_POLICIES,
  createMarketingConsentProof,
  requireConsentProofForMarketing,
  type DeliveryClassPolicy,
  type MarketingConsentProof,
} from "./notification-delivery-class";
import {
  DIRECT_EMAIL_CALLER_INVENTORY,
  MigrationStatus,
  lookupCallerEntry,
} from "./notification-caller-inventory";

const ALL_CLASSES = Object.values(DeliveryClass) as DeliveryClass[];

describe("delivery class registry", () => {
  it("defines exactly the five expected classes", () => {
    expect(new Set(ALL_CLASSES)).toEqual(
      new Set(["PRODUCT_EVENT", "USER_AUTHORED", "WORKFLOW_EXTERNAL", "OPERATOR_ALERT", "MARKETING"]),
    );
  });

  it("has a policy entry for every declared class", () => {
    for (const cls of ALL_CLASSES) {
      expect(DELIVERY_CLASS_POLICIES[cls]).toBeDefined();
    }
  });

  it("each policy matches its own deliveryClass key", () => {
    for (const cls of ALL_CLASSES) {
      expect(DELIVERY_CLASS_POLICIES[cls].deliveryClass).toBe(cls);
    }
  });

  it("every policy has at least one retry attempt and a positive deadLetter window", () => {
    for (const cls of ALL_CLASSES) {
      const policy = DELIVERY_CLASS_POLICIES[cls];
      expect(policy.retryPolicy.maxAttempts).toBeGreaterThan(0);
      expect(policy.retryPolicy.backoffMinutes.length).toBe(policy.retryPolicy.maxAttempts);
      expect(policy.retryPolicy.deadLetterAfterMs).toBeGreaterThan(0);
    }
  });

  it("every policy requires audit", () => {
    for (const cls of ALL_CLASSES) {
      expect(DELIVERY_CLASS_POLICIES[cls].auditRequired).toBe(true);
    }
  });

  it("OPERATOR_ALERT escalates faster than PRODUCT_EVENT", () => {
    const alert = DELIVERY_CLASS_POLICIES[DeliveryClass.OPERATOR_ALERT];
    const product = DELIVERY_CLASS_POLICIES[DeliveryClass.PRODUCT_EVENT];
    expect(alert.retryPolicy.deadLetterAfterMs).toBeLessThan(product.retryPolicy.deadLetterAfterMs);
  });
});

describe("MARKETING consent requirement", () => {
  it("MARKETING has requiresConsent = true", () => {
    expect(DELIVERY_CLASS_POLICIES[DeliveryClass.MARKETING].requiresConsent).toBe(true);
  });

  it("MARKETING has requiresUnsubscribeLink = true", () => {
    expect(DELIVERY_CLASS_POLICIES[DeliveryClass.MARKETING].requiresUnsubscribeLink).toBe(true);
  });

  it("no non-MARKETING class requires consent", () => {
    const offenders = ALL_CLASSES.filter(
      (cls) => cls !== DeliveryClass.MARKETING && DELIVERY_CLASS_POLICIES[cls].requiresConsent,
    );
    expect(offenders).toEqual([]);
  });

  it("no non-MARKETING class requires an unsubscribe link", () => {
    const offenders = ALL_CLASSES.filter(
      (cls) => cls !== DeliveryClass.MARKETING && DELIVERY_CLASS_POLICIES[cls].requiresUnsubscribeLink,
    );
    expect(offenders).toEqual([]);
  });

  it("requireConsentProofForMarketing throws when called for MARKETING without a proof", () => {
    expect(() => requireConsentProofForMarketing(DeliveryClass.MARKETING, undefined)).toThrow();
  });

  it("requireConsentProofForMarketing throws when proof has consentVerified = false", () => {
    const badProof = { consentVerified: false } as unknown as MarketingConsentProof;
    expect(() => requireConsentProofForMarketing(DeliveryClass.MARKETING, badProof)).toThrow();
  });

  it("requireConsentProofForMarketing passes when a valid proof is supplied", () => {
    const proof = createMarketingConsentProof();
    expect(() => requireConsentProofForMarketing(DeliveryClass.MARKETING, proof)).not.toThrow();
  });

  it("requireConsentProofForMarketing is a no-op for non-MARKETING classes regardless of proof", () => {
    const nonMarketing = ALL_CLASSES.filter((cls) => cls !== DeliveryClass.MARKETING);
    for (const cls of nonMarketing) {
      expect(() => requireConsentProofForMarketing(cls, undefined)).not.toThrow();
    }
  });

  it("MARKETING authorization rule is verified-consent", () => {
    expect(DELIVERY_CLASS_POLICIES[DeliveryClass.MARKETING].authorizationRule).toBe("verified-consent");
  });

  it("MARKETING retry policy is non-retryable", () => {
    expect(DELIVERY_CLASS_POLICIES[DeliveryClass.MARKETING].retryPolicy.retryable).toBe(false);
  });
});

/**
 * The inventory only means something if it is checked against the tree. Every other assertion here
 * reads the constant back and would keep passing while a new direct sender was added — which is
 * exactly the drift the criterion asks to prevent.
 *
 * The criterion says "never call an email, push or SMS **adapter** directly", so the pattern must
 * match every email adapter, not the literal `EmailService`. `\bEmailService\b` misses
 * `AutomationEmailService`, `ProjectsEmailService`, `ClientsEmailService` and
 * `CrmOutboundEmailService` — nine real senders, including the one place marketing consent is
 * enforced. A bare substring search is the opposite error: it self-matches every adapter's own
 * declaration file. `[A-Za-z]*EmailService` with word boundaries is the definition that holds.
 */
function directEmailCallersOnDisk(): string[] {
  const srcRoot = join(__dirname, "..", "..");
  const moduleRoot = join(srcRoot, "modules");
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!p.endsWith(".ts") || p.endsWith(".spec.ts") || p.endsWith(".module.ts")) continue;
      const rel = relative(srcRoot, p).split(sep).join("/");
      if (rel.includes("/dto/") || rel.startsWith("modules/email/")) continue;
      if (rel === "modules/notifications/notification-caller-inventory.ts") continue;
      if (/\b[A-Za-z]*EmailService\b/.test(readFileSync(p, "utf8"))) found.push(rel);
    }
  };

  walk(moduleRoot);
  return found.sort();
}

describe("direct email caller inventory", () => {
  it("has at least one entry", () => {
    expect(DIRECT_EMAIL_CALLER_INVENTORY.length).toBeGreaterThan(0);
  });

  it("lists every file on disk that reaches EmailService directly", () => {
    const inventoried = new Set(DIRECT_EMAIL_CALLER_INVENTORY.map((e) => e.file));
    const missing = directEmailCallersOnDisk().filter((f) => !inventoried.has(f));
    expect(missing).toEqual([]);
  });

  it("lists no file that has stopped reaching EmailService", () => {
    const onDisk = new Set(directEmailCallersOnDisk());
    const stale = DIRECT_EMAIL_CALLER_INVENTORY.map((e) => e.file).filter((f) => !onDisk.has(f));
    expect(stale).toEqual([]);
  });

  it("every entry has a deliveryClass that exists in the registry", () => {
    const validClasses = new Set<string>(ALL_CLASSES);
    const offenders = DIRECT_EMAIL_CALLER_INVENTORY.filter(
      (e) => !validClasses.has(e.deliveryClass),
    ).map((e) => e.file);
    expect(offenders).toEqual([]);
  });

  it("every entry has a migrationStatus of PENDING_MIGRATION or EXEMPT", () => {
    const valid = new Set<string>(Object.values(MigrationStatus));
    const offenders = DIRECT_EMAIL_CALLER_INVENTORY.filter(
      (e) => !valid.has(e.migrationStatus),
    ).map((e) => e.file);
    expect(offenders).toEqual([]);
  });

  // MARKETING is exemptible only because the CRM outbound path already enforces consent through
  // CrmConsentService.suppressedEmails. An earlier version of this rule allowed only OPERATOR_ALERT
  // and USER_AUTHORED, on the premise that no consent-governed sender existed. One does.
  it("EXEMPT entries are a class that does not need the dispatch seam", () => {
    const exemptClasses = new Set<DeliveryClass>([
      DeliveryClass.OPERATOR_ALERT,
      DeliveryClass.USER_AUTHORED,
      DeliveryClass.MARKETING,
    ]);
    const offenders = DIRECT_EMAIL_CALLER_INVENTORY.filter(
      (e) => e.migrationStatus === MigrationStatus.EXEMPT && !exemptClasses.has(e.deliveryClass),
    ).map((e) => e.file);
    expect(offenders).toEqual([]);
  });

  it("classifies the CRM outbound path as MARKETING and exempts it, because it is the consent seam", () => {
    const seam = lookupCallerEntry("modules/crm/consent/crm-outbound-email.service.ts");
    expect(seam?.deliveryClass).toBe(DeliveryClass.MARKETING);
    expect(seam?.migrationStatus).toBe(MigrationStatus.EXEMPT);

    for (const runner of [
      "modules/crm/automation-studio/crm-sequences-runner.service.ts",
      "modules/crm/automation-studio/crm-automation-runner.service.ts",
    ])
      expect(lookupCallerEntry(runner)?.deliveryClass).toBe(DeliveryClass.MARKETING);
  });

  it("no two entries share the same file path", () => {
    const files = DIRECT_EMAIL_CALLER_INVENTORY.map((e) => e.file);
    expect(new Set(files).size).toBe(files.length);
  });

  it("public/contact.service is EXEMPT and OPERATOR_ALERT", () => {
    const entry = lookupCallerEntry("modules/public/contact.service.ts");
    expect(entry).toBeDefined();
    expect(entry?.deliveryClass).toBe(DeliveryClass.OPERATOR_ALERT);
    expect(entry?.migrationStatus).toBe(MigrationStatus.EXEMPT);
  });

  it("public/waitlist.service is EXEMPT and OPERATOR_ALERT", () => {
    const entry = lookupCallerEntry("modules/public/waitlist.service.ts");
    expect(entry).toBeDefined();
    expect(entry?.deliveryClass).toBe(DeliveryClass.OPERATOR_ALERT);
    expect(entry?.migrationStatus).toBe(MigrationStatus.EXEMPT);
  });

  it("all interview services are WORKFLOW_EXTERNAL — they reach external candidates", () => {
    const interviewFiles = [
      "modules/hr/interviews/hr-interview-booking.service.ts",
      "modules/hr/interviews/hr-interview-results.service.ts",
      "modules/hr/interviews/hr-interview-scheduling.service.ts",
    ];
    for (const file of interviewFiles) {
      const entry = lookupCallerEntry(file);
      expect(entry?.deliveryClass).toBe(DeliveryClass.WORKFLOW_EXTERNAL);
    }
  });
});

describe("MARKETING delivery class enforcement at the seam", () => {
  it("org-member marketing consent infrastructure does not exist: MARKETING class enforces at the seam", () => {
    expect(DELIVERY_CLASS_POLICIES[DeliveryClass.MARKETING].requiresConsent).toBe(true);
    const proof: MarketingConsentProof | undefined = undefined;
    expect(() => requireConsentProofForMarketing(DeliveryClass.MARKETING, proof)).toThrow(
      /MARKETING delivery requires recorded per-recipient consent/,
    );
  });
});
