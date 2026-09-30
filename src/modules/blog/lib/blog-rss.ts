import type { BlogCard } from "../blog-public.projection";

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

export function escapeXml(value: string): string {
  // Characters XML 1.0 forbids outright are dropped rather than escaped.
  return value
    .replace(/[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/gu, "")
    .replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c);
}

export interface RssChannel {
  /** Canonical public origin, e.g. `https://www.streamlineos.in`. No trailing slash. */
  siteOrigin: string;
  title: string;
  description: string;
}

/** RSS 2.0 with canonical links and the post id as a stable, non-permalink guid. */
export function buildBlogRss(channel: RssChannel, items: BlogCard[]): string {
  const blogUrl = `${channel.siteOrigin}/blogs`;
  const lastBuild = items[0]?.modifiedAt ?? items[0]?.publishedAt ?? null;
  const entries = items.map((item) => {
    const link = `${blogUrl}/${encodeURIComponent(item.slug)}`;
    const pubDate = item.publishedAt ? `<pubDate>${item.publishedAt.toUTCString()}</pubDate>` : "";
    const category = item.category ? `<category>${escapeXml(item.category.name)}</category>` : "";
    const author = item.author ? `<dc:creator>${escapeXml(item.author.name)}</dc:creator>` : "";
    return [
      "<item>",
      `<title>${escapeXml(item.title)}</title>`,
      `<link>${escapeXml(link)}</link>`,
      `<guid isPermaLink="false">urn:uuid:${item.id}</guid>`,
      `<description>${escapeXml(item.excerpt)}</description>`,
      pubDate,
      category,
      author,
      "</item>",
    ].join("");
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    "<channel>",
    `<title>${escapeXml(channel.title)}</title>`,
    `<link>${escapeXml(blogUrl)}</link>`,
    `<description>${escapeXml(channel.description)}</description>`,
    "<language>en</language>",
    `<atom:link href="${escapeXml(`${blogUrl}/rss.xml`)}" rel="self" type="application/rss+xml"/>`,
    lastBuild ? `<lastBuildDate>${lastBuild.toUTCString()}</lastBuildDate>` : "",
    ...entries,
    "</channel>",
    "</rss>",
  ].join("\n");
}
