const MAX_PARAGRAPHS = 500;

export function paragraphize(contentText: string | null | undefined): Record<string, unknown> {
  const text = contentText?.trim() ?? "";
  if (!text) {
    return { type: "doc", content: [{ type: "p", children: [{ text: "" }] }] };
  }
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, MAX_PARAGRAPHS)
    .map((p) => ({ type: "p", children: [{ text: p }] }));
  return {
    type: "doc",
    content: paras.length ? paras : [{ type: "p", children: [{ text: "" }] }],
  };
}
