export interface VcardContact {
  name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  title?: string | null;
  websiteUrl?: string | null;
  linkedinUrl?: string | null;
  twitterUrl?: string | null;
}

export function buildVcard(contact: VcardContact): string {
  const nameParts = contact.name.trim().split(/\s+/);
  const firstName = nameParts.slice(0, -1).join(" ") || contact.name;
  const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : "";

  const lines: string[] = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${contact.name}`,
    `N:${lastName};${firstName};;;`,
  ];

  if (contact.phone) lines.push(`TEL;TYPE=CELL:${contact.phone}`);
  if (contact.email) lines.push(`EMAIL:${contact.email}`);
  if (contact.company) lines.push(`ORG:${contact.company}`);
  if (contact.title) lines.push(`TITLE:${contact.title}`);
  if (contact.websiteUrl) lines.push(`URL:${contact.websiteUrl}`);
  if (contact.linkedinUrl) lines.push(`X-SOCIALPROFILE;type=linkedin:${contact.linkedinUrl}`);
  if (contact.twitterUrl) lines.push(`X-SOCIALPROFILE;type=twitter:${contact.twitterUrl}`);

  lines.push("END:VCARD");
  return lines.join("\r\n") + "\r\n";
}

export function vcardFilename(name: string): string {
  return name.replace(/[^a-z0-9]/gi, "_").toLowerCase();
}
