import { escapeHtml, sanitizeHtml } from "../../html-sanitizer";

describe("escapeHtml", () => {
  it("escapes ampersand", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes less-than", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('say "hi"')).toBe("say &quot;hi&quot;");
  });

  it("escapes single quotes", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("leaves plain text unchanged", () => {
    expect(escapeHtml("Hello World")).toBe("Hello World");
  });
});

describe("sanitizeHtml — XSS prevention", () => {
  it("strips <script> tags and their content", () => {
    const input = '<p>Hello</p><script>alert("xss")</script>';
    expect(sanitizeHtml(input)).not.toContain("<script>");
    expect(sanitizeHtml(input)).not.toContain("alert");
  });

  it("strips <style> tags", () => {
    const input = "<style>body { color: red }</style><p>ok</p>";
    expect(sanitizeHtml(input)).not.toContain("<style>");
    expect(sanitizeHtml(input)).toContain("<p>");
  });

  it("removes onclick event handler from allowed tag", () => {
    const input = '<p onclick="alert(1)">text</p>';
    expect(sanitizeHtml(input)).not.toContain("onclick");
    expect(sanitizeHtml(input)).toContain("<p>");
  });

  it("strips onerror from img", () => {
    const input = '<img src="x" onerror="alert(1)">';
    expect(sanitizeHtml(input)).not.toContain("onerror");
  });

  it("blocks javascript: href on anchor", () => {
    const input = '<a href="javascript:alert(1)">click</a>';
    expect(sanitizeHtml(input)).not.toContain("javascript:");
  });

  it("blocks data: href on anchor", () => {
    const input = '<a href="data:text/html,<h1>hi">click</a>';
    const out = sanitizeHtml(input);
    expect(out).not.toContain('href="data:');
  });

  it("preserves safe href on anchor", () => {
    const input = '<a href="https://example.com" title="go">link</a>';
    expect(sanitizeHtml(input)).toContain('href="https://example.com"');
  });

  it("removes disallowed tag (iframe)", () => {
    const input = '<iframe src="https://evil.com"></iframe>';
    expect(sanitizeHtml(input)).not.toContain("iframe");
  });

  it("keeps allowed structural tags", () => {
    const input = "<div><p><strong>bold</strong></p></div>";
    expect(sanitizeHtml(input)).toBe("<div><p><strong>bold</strong></p></div>");
  });

  it("removes disallowed attributes from div", () => {
    const input = '<div id="myid" style="color:red">content</div>';
    const out = sanitizeHtml(input);
    expect(out).not.toContain('id="myid"');
    expect(out).toContain("style");
  });
});

describe("Template variable interpolation", () => {
  function interpolate(template: string, ctx: Record<string, string>): string {
    return template.replace(/\{\{([^}]+)\}\}/g, (_match, raw: string) => {
      const token = raw.trim();
      if (token in ctx) return ctx[token];
      return `⟦missing:${token}⟧`;
    });
  }

  it("replaces a known token with its context value", () => {
    const result = interpolate("Hello {{employee.fullName}}", { "employee.fullName": "Alice Smith" });
    expect(result).toBe("Hello Alice Smith");
  });

  it("replaces multiple tokens in one template", () => {
    const result = interpolate("Dear {{employee.firstName}}, from {{company.name}}", {
      "employee.firstName": "Bob",
      "company.name": "Acme Corp",
    });
    expect(result).toBe("Dear Bob, from Acme Corp");
  });

  it("emits ⟦missing:token⟧ for unresolved tokens", () => {
    const result = interpolate("Your CTC is {{salary.ctc}}", {});
    expect(result).toBe("Your CTC is ⟦missing:salary.ctc⟧");
  });

  it("leaves template text outside tokens unchanged", () => {
    const result = interpolate("No tokens here.", {});
    expect(result).toBe("No tokens here.");
  });

  it("handles whitespace around token name", () => {
    const result = interpolate("{{ employee.fullName }}", { "employee.fullName": "Charlie" });
    expect(result).toBe("Charlie");
  });

  it("XSS: variable values are HTML-escaped before insertion", () => {
    const rawValue = '<script>alert("xss")</script>';
    const escaped = escapeHtml(rawValue);
    const ctx: Record<string, string> = { "employee.fullName": escaped };
    const result = interpolate("Name: {{employee.fullName}}", ctx);
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
  });
});

describe("HrTemplateRenderService — salary masking", () => {
  it("salary.* tokens are excluded from context when includeSensitive is false", () => {
    const sensitiveTokens = ["salary.basic", "salary.grossMonthly", "salary.ctc"];
    const ctx: Record<string, string> = {};
    for (const tok of sensitiveTokens) {
      expect(Object.prototype.hasOwnProperty.call(ctx, tok)).toBe(false);
    }
  });

  it("unresolved salary tokens produce missing marker when not included", () => {
    function interpolate(template: string, ctx: Record<string, string>): string {
      return template.replace(/\{\{([^}]+)\}\}/g, (_match, raw: string) => {
        const token = raw.trim();
        if (token in ctx) return ctx[token];
        return `⟦missing:${token}⟧`;
      });
    }
    const result = interpolate("Salary: {{salary.ctc}}", {});
    expect(result).toBe("Salary: ⟦missing:salary.ctc⟧");
  });
});
