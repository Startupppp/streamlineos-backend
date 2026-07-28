import type { Permission } from "./types";

export const BLOG_PERMISSIONS: Permission[] = [
  {
    name: "blog:posts:manage",
    resource: "blog:posts",
    action: "manage",
    description: "Manage blog posts",
  },
  {
    name: "blog:categories:manage",
    resource: "blog:categories",
    action: "manage",
    description: "Manage blog categories",
  },
  {
    name: "blog:ai:use",
    resource: "blog:ai",
    action: "use",
    description:
      "Use AI assist on blog posts (improve, summarize, suggest title)",
  },
];
