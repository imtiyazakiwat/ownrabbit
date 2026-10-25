import { env } from "@/lib/env";
import { setOAuthState } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const state = crypto.randomUUID();
  await setOAuthState(state);
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env.clientId());
  url.searchParams.set("redirect_uri", `${env.appUrl()}/api/auth/callback`);
  url.searchParams.set("state", state);
  return Response.redirect(url.toString(), 302);
}
