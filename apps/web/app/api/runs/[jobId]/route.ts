import { NextResponse, type NextRequest } from "next/server";
import { listAccessibleReposCached } from "@/lib/access";
import { isJobId, loadRun, loadRunEvents } from "@/lib/runs";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** One run plus its events after ?after=<seq>, for incremental tailing. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { jobId } = await params;
  if (!isJobId(jobId)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const afterRaw = Number(req.nextUrl.searchParams.get("after") ?? 0);
  const after = Number.isSafeInteger(afterRaw) && afterRaw > 0 ? afterRaw : 0;

  try {
    const run = await loadRun(jobId);
    // Same 404 for "missing" and "not yours" so job ids can't be probed.
    if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
    const repos = await listAccessibleReposCached(session);
    if (!repos.some((r) => r.repoId === run.repoId)) return NextResponse.json({ error: "not found" }, { status: 404 });

    const events = await loadRunEvents(jobId, after);
    return NextResponse.json({ run, events, now: Date.now() }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("run detail failed", err);
    return NextResponse.json({ error: "Could not load run" }, { status: 502 });
  }
}
