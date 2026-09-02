const ALLOWED_TAGS = new Set([
  "a", "b", "br", "blockquote", "caption", "code", "col", "colgroup",
  "div", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img",
  "li", "ol", "p", "pre", "s", "small", "span", "strong", "sub", "sup",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title", "target", "rel"]),
  img: new Set(["src", "alt", "width", "height"]),
  td: new Set(["colspan", "rowspan", "align", "valign"]),
  th: new Set(["colspan", "rowspan", "align", "valign", "scope"]),
  div: new Set(["style"]),
  p: new Set(["style"]),
  span: new Set(["style"]),
  table: new Set(["style", "border", "cellpadding", "cellspacing", "width"]),
  col: new Set(["style", "width"]),
};

const DANGEROUS_ATTR_PATTERN = /^on/i;
const DANGEROUS_URL_PATTERN = /^(?:javascript|vbscript|data):/i;
const URL_BEARING_ATTRS = new Set(["href", "src"]);

function sanitizeTag(tagName: string, attrsString: string): string {
  const lower = tagName.toLowerCase();
  if (!ALLOWED_TAGS.has(lower)) return "";

  const allowed = ALLOWED_ATTRS[lower] ?? new Set<string>();
  const sanitizedAttrs: string[] = [];

  const attrRegex = /([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(attrsString)) !== null) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (DANGEROUS_ATTR_PATTERN.test(name)) continue;
    if (!allowed.has(name)) continue;
    if (URL_BEARING_ATTRS.has(name) && DANGEROUS_URL_PATTERN.test(value.trim())) continue;
    sanitizedAttrs.push(`${name}="${value.replace(/"/g, "&quot;")}"`);
  }

  return `<${lower}${sanitizedAttrs.length > 0 ? " " + sanitizedAttrs.join(" ") : ""}>`;
}

export function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<(\/?)([\w-]+)([^>]*)>/g, (_, slash: string, tag: string, attrs: string) => {
      if (slash === "/") {
        const lower = tag.toLowerCase();
        return ALLOWED_TAGS.has(lower) ? `</${lower}>` : "";
      }
      return sanitizeTag(tag, attrs);
    });
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
