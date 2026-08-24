function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function toMarkdown(title: string, contentText: string | null): string {
  return `# ${title}\n\n${contentText ?? ""}`;
}

export function toHtml(title: string, contentText: string | null): string {
  const text = contentText ?? "";
  const lines = text.split("\n").filter(function nonEmpty(l) {
    return l.trim().length > 0;
  });
  const paragraphs = lines.map(function wrapLine(l) {
    return `<p>${escapeHtml(l)}</p>`;
  }).join("\n");
  return `<h1>${escapeHtml(title)}</h1>\n${paragraphs}`;
}
