import { redirect } from "next/navigation";
import { getPauseState } from "@ownrabbit/core/server";
import { Logo } from "@/components/brand";
import { isAdmin } from "@/lib/admin";
import { getSession } from "@/lib/session";
import { DashboardNav } from "./nav";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/api/auth/login");
  const pause = await getPauseState().catch(() => undefined);

  return (
    <div className="mx-auto max-w-[88rem] px-6 pb-24">
      <header className="flex items-center justify-between border-b border-line py-5">
        <div className="flex items-center gap-8">
          <Logo />
          <DashboardNav isAdmin={isAdmin(session)} />
        </div>
        <div className="flex items-center gap-4 text-sm">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={session.avatarUrl} alt="" width={24} height={24} className="h-6 w-6 rounded-full" />
          <span className="text-muted">{session.login}</span>
          <form action="/api/auth/logout" method="post">
            <button type="submit" className="text-muted hover:text-carrot">
              Sign out
            </button>
          </form>
        </div>
      </header>
      {pause?.paused && (
        <p role="status" className="mt-4 border border-warn/40 bg-warn/10 px-4 py-2.5 text-sm text-warn">
          <strong className="font-semibold">Reviews are paused globally</strong>
          {pause.pausedBy ? ` by @${pause.pausedBy}` : ""} — {pause.message}
        </p>
      )}
      {children}
    </div>
  );
}
