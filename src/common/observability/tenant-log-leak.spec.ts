import { readFileSync } from "fs";
import { join } from "path";
import { redact } from "./redact";

/**
 * PRD-C102. The redactor is key-based: it withholds a value by the name of the
 * field it sits under inside `meta`. Anything interpolated into the message
 * string has no key, so it walks straight past — which is how a customer's
 * mailbox address, a notification recipient and a notification title were being
 * written to the log stream from four call sites while `check:log-secrets` was
 * green over all four (its CHECK 1 reads argument names, not message text).
 *
 * These pin the message string closed. The redactor proofs below say why the
 * meta shape those call sites moved to is the safe carrier.
 */
describe("tenant identifiers never reach a log MESSAGE string", () => {
  const BACKEND_SRC = join(__dirname, "..", "..");

  const SCANNED_FILES = [
    "modules/ingress/adapters/crm-mailbox.service.ts",
    "modules/notifications/providers/notification-email.provider.ts",
    "modules/notifications/providers/notification-web-push.provider.ts",
    "modules/support/kb-gap/support-kb-gap.service.ts",
  ];

  const LOGGER_TEMPLATE_MESSAGE =
    /\.(?:log|info|warn|error|debug|verbose)\(\s*`((?:[^`\\]|\\.)*)`/gs;

  /**
   * A tenant's own content or contact details. `${String(err)}` and
   * `${err.message}` are diagnostics about the failure rather than about the
   * tenant, and stay in the message on purpose.
   */
  const TENANT_IDENTIFIER =
    /\$\{[^}]*\b(?:mailboxAddress|recipientAddress|emailAddress|representativeQuestion|input\.title|gap\.title|\w+\.subject)\b[^}]*\}/;

  it.each(SCANNED_FILES)("%s keeps tenant identifiers out of the message string", (relative) => {
    const source = readFileSync(join(BACKEND_SRC, relative), "utf8");
    const offenders: string[] = [];

    LOGGER_TEMPLATE_MESSAGE.lastIndex = 0;
    for (const match of source.matchAll(LOGGER_TEMPLATE_MESSAGE)) {
      const message = match[1] ?? "";
      if (TENANT_IDENTIFIER.test(message)) offenders.push(message);
    }

    expect(offenders).toEqual([]);
  });

  it("the scan bites — the mailbox sweep line as it was written is detected", () => {
    const bad = "this.logger.warn(`sweep failed for ${row.mailboxAddress}: ${message}`);";
    LOGGER_TEMPLATE_MESSAGE.lastIndex = 0;
    const found = [...bad.matchAll(LOGGER_TEMPLATE_MESSAGE)].filter((m) =>
      TENANT_IDENTIFIER.test(m[1] ?? ""),
    );
    expect(found).toHaveLength(1);
  });

  it("the scan bites — the sandbox email line as it was written is detected", () => {
    const bad =
      'this.logger.debug(`SANDBOX EMAIL -> ${input.recipientAddress ?? "no-address"}: ${input.title}`);';
    LOGGER_TEMPLATE_MESSAGE.lastIndex = 0;
    const found = [...bad.matchAll(LOGGER_TEMPLATE_MESSAGE)].filter((m) =>
      TENANT_IDENTIFIER.test(m[1] ?? ""),
    );
    expect(found).toHaveLength(1);
  });

  it("the scan does not flag an error diagnostic that carries no tenant identifier", () => {
    const good = "this.logger.warn(`sweep failed: ${message}`);";
    LOGGER_TEMPLATE_MESSAGE.lastIndex = 0;
    const found = [...good.matchAll(LOGGER_TEMPLATE_MESSAGE)].filter((m) =>
      TENANT_IDENTIFIER.test(m[1] ?? ""),
    );
    expect(found).toHaveLength(0);
  });
});

describe("the meta keys the moved call sites use are the ones the redactor withholds", () => {
  it("withholds a mailbox address under mailboxEmailAddress while keeping the organisation", () => {
    const line = JSON.stringify(
      redact({ organizationId: "org-1", crmMailboxSyncId: "sync-1", mailboxEmailAddress: "ada@example.com" }),
    );
    expect(line).not.toContain("ada@example.com");
    expect(line).toContain("[redacted]");
    expect(line).toContain("org-1");
  });

  it("(bite proof) the same address under a key the redactor does not know is NOT withheld", () => {
    expect(JSON.stringify(redact({ mailboxAddress: "ada@example.com" }))).toContain(
      "ada@example.com",
    );
  });
});
