import type { Permission } from "./types";

export const BLOG_PERMISSIONS: Permission[] = [
  {
    name: "blog:ai:use",
    resource: "blog:ai",
    action: "use",
    description: "Use AI assist on blog posts (improve, summarize, suggest title)",
  },
  {
    name: "blog:posts:manage",
    resource: "blog:posts",
    action: "manage",
    description: "Create, edit, publish, archive and delete blog posts",
  },
  {
    name: "blog:categories:manage",
    resource: "blog:categories",
    action: "manage",
    description: "Create, edit and delete blog categories",
  },
];
