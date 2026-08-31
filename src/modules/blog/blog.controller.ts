import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { Public } from "../../common/auth/public.decorator";
import { BlogService } from "./blog.service";
import {
  feedSchema,
  type FeedInput,
  } from "./dto/blog.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const slugParams = z.object({ slug: z.string().min(1) }).strict();

@Controller("blog")
@UseGuards(JwtAuthGuard)
export class BlogController {
  constructor(private readonly blog: BlogService) {}

  @Public()
  @Get("by-slug/:slug")
  @Validate({ params: slugParams })
  async getPostBySlug(@Param("slug") slug: string) {
    const post = await this.blog.getPublishedPostBySlug(slug);
    if (!post) throw new NotFoundException("Post not found");
    return post;
  }

  @Public()
  @Get("by-slug/:slug/adjacent")
  @Validate({ params: slugParams })
  getAdjacentPosts(@Param("slug") slug: string) {
    return this.blog.getAdjacentPosts(slug);
  }

  @Public()
  @Get("categories")
  listCategories() {
    return this.blog.getCategories();
  }

  @Public()
  @Get("feed")
  @Validate({ query: feedSchema })
  feed(@Query() query: FeedInput) {
    return this.blog.getPublishedPosts(query);
  }
}
