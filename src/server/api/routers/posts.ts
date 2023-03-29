import { privateProcedure } from "./../trpc";

import { clerkClient } from "@clerk/nextjs/server";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { filterUserForClient } from "~/utils/filterUserForClient";

// rate limiter, 3 requests per minute max
const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(3, "1 m"),
  analytics: true,
});

export const postsRouter = createTRPCRouter({
  getAll: publicProcedure.query(async ({ ctx }) => {
    const posts = await ctx.prisma.post.findMany({
      take: 100,
      orderBy: {
        createdAt: "desc",
      },
    });

    const users = (
      await clerkClient.users.getUserList({
        userId: posts.map((post) => post.authorId),
        limit: 100,
      })
    ).map(filterUserForClient);

    return posts.map((post) => {
      const author = users.find((user) => user.id === post.authorId);

      if (!author || !author.username)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Author not found",
        });

      return {
        post,
        author: {
          ...author,
          username: author.username,
        },
      };
    });
  }),
  create: privateProcedure
    .input(
      z.object({
        content: z
          .string()
          .emoji("Solo puedes twittear emojis")
          .min(1)
          .max(280),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const authorId = ctx.userId;

      const { success } = await ratelimit.limit(authorId);

      if (!success) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
        });
      }

      const { content } = input;

      const post = await ctx.prisma.post.create({
        data: {
          content,
          authorId,
        },
      });

      return post;
    }),
  delete: privateProcedure
    .input(z.string())
    .mutation(async ({ ctx, input }) => {
      const authorId = ctx.userId;
      console.log(input)
      const post = await ctx.prisma.post.findUnique({
        where: {
          id: input,
        },
      });

      if (!post) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Post not found",
        });
      }

      if (post.authorId !== authorId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "You are not authorized to delete this post",
        });
      }

      await ctx.prisma.post.delete({
        where: {
          id: input,
        },
      });

      return true;
    }),
});
