import { env } from "@/lib/env";
import { destroySession } from "@/lib/session";

export const dynamic = "force-dynamic";

// POST only, so a cross-site <img src> cannot log users out.
export async function POST() {
  await destroySession();
  return Response.redirect(`${env.appUrl()}/`, 303);
}
