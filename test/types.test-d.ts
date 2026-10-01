import type {
  ExecutionContext,
  ExportedHandler,
  Request as CfRequest,
  ScheduledController,
} from "@cloudflare/workers-types/index.js";
import { Response as CfResponse } from "@cloudflare/workers-types/index.js";
import { expectTypeOf } from "vitest";
import { withSupabasePreviews } from "../src/runtime.js";

type Env = { SUPABASE_URL: string; CACHE: { get(key: string): Promise<string | null> } };

const plain = withSupabasePreviews({
  async fetch(_request: Request, env: Env, _ctx: unknown) {
    return new Response(await env.CACHE.get(env.SUPABASE_URL));
  },
});
expectTypeOf(plain.fetch).parameter(1).toEqualTypeOf<Env>();

const untypedRequest = withSupabasePreviews({
  fetch(req, env: { A: string }, ctx) {
    return new Response(`${req} ${env.A} ${ctx}`);
  },
});
expectTypeOf(untypedRequest.fetch).parameter(1).toEqualTypeOf<{ A: string }>();

const arrow = withSupabasePreviews({
  fetch: async (_req: Request, env: { A: string }) => new Response(env.A),
});
expectTypeOf(arrow.fetch).parameter(1).toEqualTypeOf<{ A: string }>();

const exported: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    ctx.waitUntil(env.CACHE.get(request.url));
    return new CfResponse(env.SUPABASE_URL);
  },
  async scheduled(controller, env) {
    await env.CACHE.get(controller.cron);
  },
};
expectTypeOf(withSupabasePreviews(exported)).toEqualTypeOf<ExportedHandler<Env>>();

const satisfied = withSupabasePreviews({
  async fetch(request: CfRequest, env: Env, _ctx: ExecutionContext) {
    return new CfResponse(`${request.url} ${env.SUPABASE_URL}`);
  },
} satisfies ExportedHandler<Env>);
expectTypeOf(satisfied.fetch).parameter(1).toEqualTypeOf<Env>();

const scheduledOnly = withSupabasePreviews(
  {
    async scheduled(_controller: ScheduledController, env: Env) {
      await env.CACHE.get("k");
    },
  },
  { inject: false },
);
expectTypeOf(scheduledOnly.scheduled).parameter(1).toEqualTypeOf<Env>();

// @ts-expect-error a handler must be an object
withSupabasePreviews("not a handler");
