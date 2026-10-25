import { NextResponse, type NextRequest } from "next/server";
import { listAccessibleReposCached } from "@/lib/access";
import { loadRuns } from "@/lib/runs";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Recent runs across every repo the signed-in user can access. Optional ?repo=<id> narrows it. */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const repos = await listAccessibleReposCached(session);
    let ids = repos.map((r) => r.repoId);
    const only = req.nextUrl.searchParams.get("repo");
    if (only) ids = ids.filter((id) => String(id) === only);
    const runs = await loadRuns(ids, 50);
    return NextResponse.json({ runs, now: Date.now() }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("runs list failed", err);
    return NextResponse.json({ error: "Could not load runs" }, { status: 502 });
  }
}
