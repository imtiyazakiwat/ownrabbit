import "server-only";
import { EncryptJWT, jwtDecrypt } from "jose";
import { cookies } from "next/headers";
import { env } from "./env";

/**
 * Session = encrypted JWT (A256GCM) in an httpOnly cookie. It holds the
 * user's GitHub token, which never reaches client JavaScript.
 */
export interface Session {
  userId: number;
  login: string;
  avatarUrl: string;
  token: string;
}

const COOKIE = "or_session";
const STATE_COOKIE = "or_oauth_state";
const MAX_AGE_SECONDS = 8 * 60 * 60; // GitHub App user tokens expire after 8h.

async function key(): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.sessionSecret()));
  return new Uint8Array(digest);
}

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

export async function createSession(session: Session): Promise<void> {
  const jwt = await new EncryptJWT({ ...session })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .encrypt(await key());
  (await cookies()).set(COOKIE, jwt, { ...cookieOptions, maxAge: MAX_AGE_SECONDS });
}

export async function getSession(): Promise<Session | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  try {
    const { payload } = await jwtDecrypt(raw, await key());
    const { userId, login, avatarUrl, token } = payload as unknown as Session;
    if (typeof userId !== "number" || typeof token !== "string" || typeof login !== "string") return null;
    return { userId, login, avatarUrl, token };
  } catch {
    return null;
  }
}

export async function destroySession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

export async function setOAuthState(state: string): Promise<void> {
  (await cookies()).set(STATE_COOKIE, state, { ...cookieOptions, maxAge: 600 });
}

export async function consumeOAuthState(): Promise<string | undefined> {
  const store = await cookies();
  const value = store.get(STATE_COOKIE)?.value;
  store.delete(STATE_COOKIE);
  return value;
}
