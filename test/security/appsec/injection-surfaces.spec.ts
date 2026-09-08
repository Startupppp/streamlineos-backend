import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { eq, sql, type SQL } from "drizzle-orm";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import {
  assertSafeWebhookUrl,
  checkWebhookUrl,
  resolveSafeWebhookTarget,
} from "../../../src/common/security/ssrf-guard";
import { sanitizeHtml, escapeHtml } from "../../../src/modules/hr/templates/html-sanitizer";
import { returnPathSchema } from "../../../src/modules/integrations/core/dto/integrations.schemas";
import { StorageService } from "../../../src/modules/storage/storage.service";
import { bulkUpdateFromValues } from "../../../src/common/db/bulk-update";
import { users, organizationMembers, tickets } from "../../../src/db/schema";

const BACKEND_ROOT = resolve(__dirname, "../../..");
const SHARED_GUARD = "src/common/security/ssrf-guard.ts";

function walkSource(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      walkSource(full, out);
    } else if (full.endsWith(".ts") && !full.endsWith("spec.ts") && !full.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

// `relative` yields backslashes on Windows, so every assertion below compared
// "src\\common\\security\\ssrf-guard.ts" against the forward-slash literal and failed while the
// file was in fact found — four security properties silently unverified on this platform.
const SOURCE_FILES = walkSource(resolve(BACKEND_ROOT, "src")).map((file) => ({
  path: relative(BACKEND_ROOT, file).replace(/\\/g, "/"),
  content: readFileSync(file, "utf8"),
}));

describe("SSRF — the shared guard is the only guard", () => {
  it("exactly one file in src implements the private-address blocklist", () => {
    const implementers = SOURCE_FILES.filter(
      (file) =>
        file.content.includes("169.254.169.254") ||
        /function isBlockedIpv[46]\b/.test(file.content) ||
        /\ba === 127\b/.test(file.content),
    ).map((file) => file.path);

    expect(implementers).toEqual([SHARED_GUARD]);
  });

  it("every caller of the guard imports it from common/security/ssrf-guard", () => {
    const callers = SOURCE_FILES.filter(
      (file) =>
        file.path !== SHARED_GUARD &&
        /\b(?:checkWebhookUrl|assertSafeWebhookUrl|resolveSafeWebhookTarget)\s*\(/.test(
          file.content,
        ),
    );

    expect(callers.length).toBeGreaterThanOrEqual(8);
    for (const caller of callers) {
      const importsShared = /from\s+["'][^"']*\/ssrf-guard["']/.test(caller.content);
      expect({ path: caller.path, importsShared }).toEqual({
        path: caller.path,
        importsShared: true,
      });
    }
  });

  /**
   * `src/modules/build/core/webhook-url-guard.ts` used to be a sanctioned
   * one-line re-export and this spec asserted its exact text. Commit 7c938419
   * deleted it and re-pointed its callers straight at the shared module, which
   * is strictly stronger — an indirection through a module the build team owns
   * is a place a second implementation can grow back. The invariant that
   * matters is therefore no longer "the shim says the right thing" but "there
   * is no shim, and nothing exports these names except the shared guard".
   */
  it("no module re-exports the guard under its own name — the shared module is the only import site", () => {
    const reExporters = SOURCE_FILES.filter(
      (file) =>
        file.path !== SHARED_GUARD &&
        /export\s*\{[^}]*\b(?:checkWebhookUrl|assertSafeWebhookUrl|resolveSafeWebhookTarget)\b/.test(
          file.content,
        ),
    ).map((file) => file.path);
    expect(reExporters).toEqual([]);

    const guardModules = SOURCE_FILES.filter((file) =>
      /(?:^|\/)webhook-url-guard\.ts$/.test(file.path),
    ).map((file) => file.path);
    expect(guardModules).toEqual([]);
  });

  it("blocks IPv4-mapped IPv6 loopback in every spelling new URL() can produce", async () => {
    const spellings = [
      "http://[::ffff:127.0.0.1]/x",
      "http://[::ffff:7f00:1]/x",
      "http://[::ffff:7f00:0001]/x",
      "http://[::1]/x",
      "http://[::]/x",
    ];
    for (const url of spellings) {
      expect({ url, result: await checkWebhookUrl(url) }).toEqual({
        url,
        result: { allowed: false, reason: "blocked-address" },
      });
    }
  });

  it("blocks IPv4-mapped private and link-local ranges in packed form", async () => {
    const packed = [
      "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
      "http://[::ffff:c0a8:0101]/x",
      "http://[::ffff:ac10:0001]/x",
      "http://[::ffff:0a00:0001]/x",
    ];
    for (const url of packed) {
      expect({ url, result: await checkWebhookUrl(url) }).toEqual({
        url,
        result: { allowed: false, reason: "blocked-address" },
      });
    }
  });

  it("blocks the cloud metadata endpoint, unique-local and multicast IPv6", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://[fd00::1]/x",
      "http://[fe80::1]/x",
      "http://[ff02::1]/x",
      "http://100.100.100.200/x",
    ]) {
      const result = await checkWebhookUrl(url);
      expect({ url, allowed: result.allowed }).toEqual({ url, allowed: false });
    }
  });

  it("blocks a DNS-rebinding host whose name resolves to loopback", async () => {
    const rebind = await resolveSafeWebhookTarget("https://rebind.example.com/hook", () =>
      Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
    );
    expect(rebind).toEqual({ reason: "blocked-address" });

    const mixed = await resolveSafeWebhookTarget("https://mixed.example.com/hook", () =>
      Promise.resolve([
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ]),
    );
    expect(mixed).toEqual({ reason: "blocked-address" });
  });

  it("CONTROL: a genuine public target resolves through, so the guard is not a blanket deny", async () => {
    const allowed = await resolveSafeWebhookTarget("https://hooks.example.com/x", () =>
      Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
    );
    expect("reason" in allowed).toBe(false);
    expect(() => assertSafeWebhookUrl("https://hooks.example.com/webhook/abc")).not.toThrow();
  });

  it("rejects non-http schemes and localhost by name", async () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "gopher://x/", "data:text/html,x"]) {
      const result = await checkWebhookUrl(url);
      expect({ url, result }).toEqual({ url, result: { allowed: false, reason: "unsupported-scheme" } });
    }
    for (const url of ["http://localhost/x", "http://api.localhost/x"]) {
      expect(() => assertSafeWebhookUrl(url)).toThrow("SSRF: private/internal URLs are blocked");
    }
  });

  it("the shared outbound client refuses to follow redirects, so an allowed host cannot 302 inward", () => {
    const source = readFileSync(resolve(BACKEND_ROOT, "src/common/http/outbound-request.ts"), "utf8");
    expect(source).toMatch(/redirect:\s*"error"/);
    expect(source).toMatch(/checkWebhookUrl\(url\)/);

    const guardAt = source.indexOf("checkWebhookUrl(url)");
    const fetchAt = source.search(/(?<![.\w])fetch\(url\b/);
    expect({ guarded: guardAt > -1, fetched: fetchAt > -1 }).toEqual({
      guarded: true,
      fetched: true,
    });
    expect(guardAt).toBeLessThan(fetchAt);
  });

  it("the webhook DTO refuses a private URL at the validation boundary", async () => {
    const { createSchema } = await import("../../../src/modules/webhooks/dto/webhook.schemas");
    const parsed = createSchema.safeParse({
      url: "http://169.254.169.254/latest/meta-data/",
      events: ["ticket.created"],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("SQL injection — every value reaches Postgres as a bind parameter", () => {
  const INJECTION = "' OR 1=1; DROP TABLE users; --";

  it("an equality filter binds the hostile value instead of inlining it", () => {
    const query = new QueryBuilder().select().from(users).where(eq(users.email, INJECTION));
    const { sql: text, params } = query.toSQL();

    expect(params).toContain(INJECTION);
    expect(text).not.toContain("DROP TABLE");
    expect(text).toMatch(/\$\d+/);
  });

  it("a raw sql`` fragment of the shape the auth services use still binds, not concatenates", () => {
    const normalizedEmail = INJECTION.toLowerCase();
    const query = new QueryBuilder()
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${normalizedEmail}`);
    const { sql: text, params } = query.toSQL();

    expect(params).toContain(normalizedEmail);
    expect(text).not.toContain("drop table");
    expect(text).toMatch(/lower\(.*\) = \$\d+/);
  });

  it("BITE: an interpolated identifier would land in the SQL text — the assertion above can fail", () => {
    const unsafe = sql.raw(`SELECT * FROM users WHERE email = '${INJECTION}'`);
    const { sql: text } = new QueryBuilder()
      .select()
      .from(users)
      .where(sql`${unsafe}`)
      .toSQL();

    expect(text).toContain("DROP TABLE");
  });

  it("a tenant-scoped composite predicate binds both discriminators", () => {
    const query = new QueryBuilder()
      .select()
      .from(organizationMembers)
      .where(
        sql`${organizationMembers.orgId} = ${INJECTION} and ${organizationMembers.userId} = ${INJECTION}`,
      );
    const { sql: text, params } = query.toSQL();

    expect(params).toEqual([INJECTION, INJECTION]);
    expect(text).not.toContain("DROP TABLE");
  });

  it("the set of files that build a dynamic SQL identifier through sql.raw is closed and reviewed", () => {
    const staticLiteral = /^(["'`])(?:(?!\1)[^\\$])*\1$/;
    const dynamic = SOURCE_FILES.filter((file) => {
      const matches = file.content.matchAll(/sql\.raw\(\s*([^)]*)\)/g);
      for (const match of matches) {
        if (!staticLiteral.test((match[1] ?? "").trim())) return true;
      }
      return false;
    }).map((file) => file.path);

    expect(dynamic.sort()).toEqual(
      [
        "src/common/db/bulk-update.ts",
        "src/common/tenant/with-tenant.ts",
        "src/modules/billing/core/payment-status-order.ts",
        "src/modules/build/core/build-due-sweep.service.ts",
        "src/modules/build/core/projects-reports.service.ts",
        "src/modules/inventory/stock-engine/warehouse-scope.service.ts",
        "src/modules/rbac/permission-catalog-sync.service.ts",
        "src/modules/record-layouts/record-layouts.service.ts",
        "src/modules/storage/storage-key-catalog.ts",
        "src/modules/workflows/engine/execution-advance.ts",
        "src/scripts/backfill-financial-actors.ts",
      ].sort(),
    );
  });

  /**
   * `bulk-update.ts` earns its place on the list above by construction, not by
   * review note. It builds an `UPDATE … SET` whose SET list, join key, tenant
   * predicate and per-value `::cast` are all identifiers, and the cast is the
   * one fragment that reaches the statement through `sql.raw` — verbatim text.
   * Both halves are checked against the target table's own Drizzle columns
   * before any SQL is built, so the set of strings that can reach the text half
   * is finite and comes from the schema. These drive the real builder rather
   * than reading its source, so a future edit that drops a check fails here.
   */
  describe("the bulk-update builder confines every identifier to the target table's own schema", () => {
    const HOSTILE_CASTS = [
      "integer) FROM users --",
      "integer; DROP TABLE users; --",
      "pg_authid",
      "regclass",
    ];
    const HOSTILE_IDENTIFIERS = [
      `id" = 1, "org_id`,
      "password_hash",
      "' OR 1=1 --",
    ];

    function stubExecutor(captured: unknown[]) {
      return {
        execute: (statement: unknown) => {
          captured.push(statement);
          return Promise.resolve([]);
        },
      } as never;
    }

    const base = {
      table: tickets,
      orgId: "org-1",
      key: { column: "id", type: "integer" },
      columns: [{ column: "assignee_membership_id", type: "integer" }],
      rows: [{ key: 10, values: [7] }],
    };

    it("refuses a cast name the schema does not carry, before it reaches sql.raw", async () => {
      const captured: unknown[] = [];
      const executor = stubExecutor(captured);
      for (const type of HOSTILE_CASTS) {
        await expect(
          bulkUpdateFromValues(executor, {
            ...base,
            columns: [{ column: "assignee_membership_id", type }],
          }),
        ).rejects.toThrow(/bulkUpdateFromValues/);
      }
      expect(captured).toEqual([]);
    });

    it("refuses a SET, key or tenant identifier that is not a column of the table", async () => {
      const captured: unknown[] = [];
      const executor = stubExecutor(captured);
      for (const column of HOSTILE_IDENTIFIERS) {
        await expect(
          bulkUpdateFromValues(executor, { ...base, columns: [{ column, type: "integer" }] }),
        ).rejects.toThrow(/is not a column of tickets/);
        await expect(
          bulkUpdateFromValues(executor, { ...base, key: { column, type: "integer" } }),
        ).rejects.toThrow(/is not a column of tickets/);
        await expect(
          bulkUpdateFromValues(executor, { ...base, orgColumn: column }),
        ).rejects.toThrow(/is not a column of tickets/);
        await expect(
          bulkUpdateFromValues(executor, { ...base, touch: [column] }),
        ).rejects.toThrow(/is not a column of tickets/);
      }
      expect(captured).toEqual([]);
    });

    it("CONTROL: a legitimate request still builds a bound, tenant-correlated statement", async () => {
      const captured: SQL[] = [];
      const executor = stubExecutor(captured);
      await expect(
        bulkUpdateFromValues(executor, { ...base, touch: ["updated_at"] }),
      ).resolves.toEqual([]);

      expect(captured).toHaveLength(1);
      const { sql: text, params } = new PgDialect().sqlToQuery(captured[0] as SQL);
      expect(text).toContain('"tickets"."org_id" =');
      expect(params).toContain("org-1");
      expect(text).not.toMatch(/DROP|--|;/);
    });
  });

  it("the record-layout query builds its identifiers from the compile-time catalog, not from the request", () => {
    const service = readFileSync(
      resolve(BACKEND_ROOT, "src/modules/record-layouts/record-layouts.service.ts"),
      "utf8",
    );
    expect(service).toMatch(/const source = layout\.usage;/);
    expect(service).toMatch(/import .*record-layout-catalog/);
    expect(service).not.toMatch(/sql\.raw\(\s*(?:body|query|input|params)\./);
  });
});

describe("XSS — rendered HTML is sanitized, not trusted", () => {
  it("strips script and style elements entirely", () => {
    expect(sanitizeHtml("<p>hi</p><script>alert(1)</script>")).toBe("<p>hi</p>");
    expect(sanitizeHtml("<style>body{}</style><b>x</b>")).toBe("<b>x</b>");
  });

  it("drops every on* event handler attribute", () => {
    const output = sanitizeHtml('<div onclick="steal()" onerror="x" onmouseover="y">t</div>');
    expect(output).toBe("<div>t</div>");
    expect(output).not.toMatch(/on\w+=/i);
  });

  it("drops javascript:, vbscript: and data: hrefs while keeping a real link", () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="JaVaScRiPt:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="  javascript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="vbscript:msgbox">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="https://example.com" title="ok">x</a>')).toBe(
      '<a href="https://example.com" title="ok">x</a>',
    );
  });

  it("survives the classic regex-sanitizer bypasses without emitting an executable tag", () => {
    const attempts = [
      "<scr<script>ipt>alert(1)</script>",
      "<SCRIPT>alert(1)</SCRIPT>",
      "<img src=x onerror=alert(1)>",
      "<div><scRIpt>alert(1)</scRIpt></div>",
      "<div ONCLICK=alert(1)>x</div>",
    ];
    for (const html of attempts) {
      const output = sanitizeHtml(html);
      expect({ html, executableTag: /<\s*script/i.test(output) }).toEqual({
        html,
        executableTag: false,
      });
      expect({ html, liveHandler: /\son\w+\s*=\s*(?:"|'|[a-z(])/i.test(output) }).toEqual({
        html,
        liveHandler: false,
      });
    }
  });

  it("a quote injected into an attribute value is entity-escaped, so it cannot break out into a handler", () => {
    expect(sanitizeHtml(`<a href='x" onmouseover="alert(1)'>t</a>`)).toBe(
      '<a href="x&quot; onmouseover=&quot;alert(1)">t</a>',
    );
  });

  it("a dangerous scheme is stripped from src as well as href — an img src is a URL too", () => {
    expect(sanitizeHtml('<img src="javascript:alert(1)" alt="a">')).toBe('<img alt="a">');
    expect(sanitizeHtml('<img src="data:text/html;base64,PHN2Zz4=">')).toBe("<img>");
    expect(sanitizeHtml('<img src="https://cdn.example.com/logo.png">')).toBe(
      '<img src="https://cdn.example.com/logo.png">',
    );
  });

  it("there is one HTML sanitizer, and the AI-authored description path uses it", () => {
    const localSanitizers = SOURCE_FILES.filter(
      (file) =>
        file.path !== "src/modules/hr/templates/html-sanitizer.ts" &&
        /function\s+sanitizeHtml\s*\(/.test(file.content),
    ).map((file) => file.path);
    expect(localSanitizers).toEqual([]);

    const feedbucket = SOURCE_FILES.find(
      (file) => file.path === "src/modules/feedbucket/feedbucket-ai.service.ts",
    );
    expect(feedbucket?.content).toMatch(/import \{ sanitizeHtml \} from "[^"]*html-sanitizer"/);
  });

  it("removes tags that are not on the allowlist, including iframe, object and svg", () => {
    for (const tag of ["iframe", "object", "embed", "svg", "form", "input", "base", "meta"]) {
      expect({ tag, output: sanitizeHtml(`<${tag} src="x">inner</${tag}>`) }).toEqual({
        tag,
        output: "inner",
      });
    }
  });

  it("escapeHtml neutralises every delimiter an injected string could use", () => {
    expect(escapeHtml(`<img src=x onerror="alert('1')">&`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;",
    );
  });

  it("CONTROL: safe formatting markup survives sanitisation unchanged", () => {
    const safe = "<p><strong>Total</strong>: <em>42</em></p>";
    expect(sanitizeHtml(safe)).toBe(safe);
  });
});

describe("Path traversal — object keys cannot escape their tenant prefix", () => {
  const storage = new StorageService(
    {} as never,
    { NEXT_PUBLIC_R2_PUBLIC_URL: "https://cdn.example.com" } as never,
    {} as never,
  );

  it("accepts a well-formed tenant-prefixed key", () => {
    expect(storage.isValidFileKey("org-123/documents/9f1c-report.pdf")).toBe(true);
  });

  it("rejects every traversal, absolute and escape form", () => {
    const hostile = [
      "../../etc/passwd",
      "org-1/../org-2/secret.pdf",
      "/etc/passwd",
      "..\\windows\\system32",
      "org-1\\..\\org-2\\x",
      "org-1/x .pdf",
      "file:///etc/passwd",
      "https://evil.example/x",
      "org-1/x?acl=public",
      "org-1/x#frag",
      "%2e%2e%2fetc%2fpasswd",
      "",
    ];
    for (const key of hostile) {
      expect({ key, valid: storage.isValidFileKey(key) }).toEqual({ key, valid: false });
    }
  });

  it("rejects an over-long key rather than passing it to the object store", () => {
    expect(storage.isValidFileKey(`org-1/${"a".repeat(1100)}`)).toBe(false);
  });

  it("a key derived from a foreign URL resolves to empty, never to the attacker's path", () => {
    expect(storage.getFileKeyFromUrl("https://evil.example/org-1/secret.pdf")).toBe("");
    expect(storage.getFileKeyFromUrl("https://cdn.example.com/org-1/ok.pdf")).toBe("org-1/ok.pdf");
  });

  it("a URL-encoded traversal survives decoding as an invalid key, so decode-then-validate holds", () => {
    const decoded = storage.getFileKeyFromUrl("https://cdn.example.com/%2e%2e%2f%2e%2e%2fetc/passwd");
    expect(decoded).toBe("../../etc/passwd");
    expect(storage.isValidFileKey(decoded)).toBe(false);
  });
});

describe("Unsafe redirect — post-auth return targets come from an allowlist", () => {
  it("accepts only the two declared in-app paths", () => {
    expect(returnPathSchema.parse("/calendar")).toBe("/calendar");
    expect(returnPathSchema.parse("/mail")).toBe("/mail");
  });

  it("rejects absolute, protocol-relative and traversal targets at the validation boundary", () => {
    const hostile = [
      "https://evil.example",
      "//evil.example",
      "http://evil.example/mail",
      "/calendar/../../evil",
      "javascript:alert(1)",
      "/mail?next=https://evil.example",
      "\\\\evil.example",
      "/CALENDAR",
    ];
    for (const value of hostile) {
      expect({ value, ok: returnPathSchema.safeParse(value).success }).toEqual({
        value,
        ok: false,
      });
    }
  });

  it("the callback URL is built from server-side APP_URL, never from a caller-supplied origin", () => {
    const source = readFileSync(
      resolve(BACKEND_ROOT, "src/modules/integrations/core/integrations.service.ts"),
      "utf8",
    );
    expect(source).toMatch(/const callbackUrl = `\$\{this\.config\.APP_URL\}\$\{resolvedPath\}`/);
    expect(source).not.toMatch(/callbackUrl\s*=\s*(?:body|input|params)\./);
  });
});
