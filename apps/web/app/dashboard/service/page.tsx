import { DEFAULT_FREE_MODEL } from "@ownrabbit/core";
import { getPauseState, getReviewModelConfig } from "@ownrabbit/core/server";
import { isAdmin } from "@/lib/admin";
import { getSession } from "@/lib/session";
import { ReviewModelForm } from "./review-model-form";
import { ServiceForm } from "./service-form";

export const dynamic = "force-dynamic";

export const metadata = { title: "Admin — Global Review Settings" };

export default async function ServicePage() {
  const session = (await getSession())!;
  const [state, modelConfig] = await Promise.all([
    getPauseState().catch(() => undefined),
    getReviewModelConfig().catch(() => ({ defaultModel: DEFAULT_FREE_MODEL })),
  ]);

  return (
    <main className="pt-10">
      <p className="text-xs tracking-[0.3em] text-carrot uppercase">Admin Settings</p>
      <h1 className="mt-2 font-display text-4xl">Global Review Settings</h1>
      <p className="mt-2 max-w-xl text-sm text-muted">
        One switch to pause reviews temporarily across all repositories and installations. Pull requests that trigger
        while paused receive a pause note instead of queuing a failing job.
      </p>

      {!isAdmin(session) ? (
        <div className="mt-8 max-w-xl border border-line p-6">
          <p className="font-display text-xl">Read-only</p>
          <p className="mt-2 text-sm text-muted">
            Only admins can pause or resume reviews globally.
          </p>
        </div>
      ) : (
        <>
          {state ? (
            <ServiceForm state={state} />
          ) : (
            <p role="alert" className="mt-8 max-w-xl border border-del/40 bg-del-bg p-4 text-del">
              Couldn’t load the service state. Refresh the page.
            </p>
          )}
          <ReviewModelForm initial={modelConfig} />
        </>
      )}
    </main>
  );
}
