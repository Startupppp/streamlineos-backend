import type { Permission } from "./types";

export const BLOG_PERMISSIONS: Permission[] = [
  {
    name: "blog:ai:use",
    resource: "blog:ai",
    action: "use",
    description:
      "Use AI assist on blog posts (improve, summarize, suggest title)",
  },
];
