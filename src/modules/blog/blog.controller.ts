import { Controller, Get, Inject, NotFoundException, Param, Query, Res, UseGuards } from "@nestjs/common";
import { ApiOkResponse } from "@nestjs/swagger";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { Public } from "../../common/auth/public.decorator";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import { BlogService } from "./blog.service";
import { BlogCategoriesService } from "./blog-categories.service";
import { BlogDiscoveryService } from "./blog-discovery.service";
import { buildBlogRss } from "./lib/blog-rss";
import {
  authorSlugParamsSchema,
  categorySlugParamsSchema,
  postListQuerySchema,
  redirectQuerySchema,
  searchQuerySchema,
  sitemapQuerySchema,
  slugParamsSchema,
  type PostListQuery,
  type SearchQuery,
  type SitemapQuery,
} from "./dto/blog.schemas";
import {
  blogArticleSchema,
  blogAuthorDetailSchema,
  blogCardListSchema,
  blogCategoryDetailSchema,
  blogPostPageSchema,
  blogPublicCategoryListSchema,
  blogRedirectSchema,
  blogSitemapPageSchema,
  blogSitemapTaxonomySchema,
} from "./dto/blog-response.schemas";

const RSS_TITLE = "The StreamlineOS Journal";
const RSS_DESCRIPTION = "Practical guides for the people, projects, and processes that keep a business moving.";

/** Anonymous blog reads. Every one applies the shared publication predicate. */
@Controller("blog")
@UseGuards(JwtAuthGuard)
export class BlogController {
  constructor(
    private readonly blog: BlogService,
    private readonly categories: BlogCategoriesService,
    private readonly discovery: BlogDiscoveryService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get("posts")
  @UseRateLimit("blog:public-read")
  @Validate({ query: postListQuerySchema })
  @ResponseSchema(blogPostPageSchema)
  listPosts(@Query() query: PostListQuery) {
    return this.blog.listPublishedPosts(query);
  }

  @Public()
  @Get("by-slug/:slug")
  @UseRateLimit("blog:public-read")
  @Validate({ params: slugParamsSchema })
  @ResponseSchema(blogArticleSchema)
  async getPostBySlug(@Param("slug") slug: string) {
    const post = await this.blog.getPublishedPostBySlug(slug);
    if (!post) throw new NotFoundException("Post not found");
    return post;
  }

  @Public()
  @Get("by-slug/:slug/related")
  @UseRateLimit("blog:public-read")
  @Validate({ params: slugParamsSchema })
  @ResponseSchema(blogCardListSchema)
  async getRelatedPosts(@Param("slug") slug: string) {
    const related = await this.blog.getRelatedPosts(slug);
    if (!related) throw new NotFoundException("Post not found");
    return related;
  }

  @Public()
  @Get("search")
  @UseRateLimit("blog:public-search")
  @Validate({ query: searchQuerySchema })
  @ResponseSchema(blogCardListSchema)
  search(@Query() query: SearchQuery) {
    return this.discovery.search(query);
  }

  @Public()
  @Get("categories")
  @UseRateLimit("blog:public-read")
  @ResponseSchema(blogPublicCategoryListSchema)
  listCategories() {
    return this.categories.getCategories();
  }

  @Public()
  @Get("categories/:categorySlug")
  @UseRateLimit("blog:public-read")
  @Validate({ params: categorySlugParamsSchema })
  @ResponseSchema(blogCategoryDetailSchema)
  async getCategory(@Param("categorySlug") categorySlug: string) {
    const category = await this.categories.getCategory(categorySlug);
    if (!category) throw new NotFoundException("Category not found");
    return category;
  }

  @Public()
  @Get("authors/:authorSlug")
  @UseRateLimit("blog:public-read")
  @Validate({ params: authorSlugParamsSchema })
  @ResponseSchema(blogAuthorDetailSchema)
  async getAuthor(@Param("authorSlug") authorSlug: string) {
    const author = await this.discovery.getAuthor(authorSlug);
    if (!author) throw new NotFoundException("Author not found");
    return author;
  }

  @Public()
  @Get("redirects/resolve")
  @UseRateLimit("blog:public-read")
  @Validate({ query: redirectQuerySchema })
  @ResponseSchema(blogRedirectSchema)
  async resolveRedirect(@Query("path") path: string) {
    const redirect = await this.discovery.resolveRedirect(path);
    if (!redirect) throw new NotFoundException("No redirect");
    return redirect;
  }

  @Public()
  @Get("sitemap/posts")
  @UseRateLimit("blog:public-read")
  @Validate({ query: sitemapQuerySchema })
  @ResponseSchema(blogSitemapPageSchema)
  sitemapPosts(@Query() query: SitemapQuery) {
    return this.discovery.sitemapPosts(query);
  }

  @Public()
  @Get("sitemap/taxonomy")
  @UseRateLimit("blog:public-read")
  @ResponseSchema(blogSitemapTaxonomySchema)
  sitemapTaxonomy() {
    return this.discovery.sitemapTaxonomy();
  }

  @Public()
  @Get("rss.xml")
  @UseRateLimit("blog:public-read")
  @ApiOkResponse({ description: "RSS 2.0 feed of published posts", content: { "application/rss+xml": { schema: { type: "string" } } } })
  async rss(@Res() res: Response) {
    const siteOrigin = (this.config.BLOG_SITE_ORIGIN ?? this.config.APP_URL).replace(/\/$/, "");
    const xml = buildBlogRss(
      { siteOrigin, title: RSS_TITLE, description: RSS_DESCRIPTION },
      await this.discovery.rssItems(),
    );
    res.setHeader("Content-Type", "application/rss+xml; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(xml);
  }
}
