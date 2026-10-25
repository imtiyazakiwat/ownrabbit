import { timingSafeEqual } from "node:crypto";
import { Octokit } from "octokit";
import { env } from "@/lib/env";
import { consumeOAuthState, createSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function fail(reason: string) {
  return Response.redirect(`${env.appUrl()}/?error=${encodeURIComponent(reason)}`, 302);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = await consumeOAuthState();

  if (!code || !state || !expected || !safeEqual(state, expected)) return fail("login_state");

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.clientId(),
      client_secret: env.clientSecret(),
      code,
      redirect_uri: `${env.appUrl()}/api/auth/callback`,
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);

  const tokenJson = (await tokenRes?.json().catch(() => null)) as { access_token?: string } | null;
  if (!tokenJson?.access_token) return fail("login_token");

  const { data: user } = await new Octokit({ auth: tokenJson.access_token }).rest.users.getAuthenticated();
  await createSession({
    userId: user.id,
    login: user.login,
    avatarUrl: user.avatar_url,
    token: tokenJson.access_token,
  });
  return Response.redirect(`${env.appUrl()}/dashboard`, 302);
}
