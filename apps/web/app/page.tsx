import Link from "next/link";
import { GitHubMark, Logo } from "@/components/brand";
import { getSession } from "@/lib/session";

const STAGES = [
  { n: "01", name: "Triage", text: "A fast model maps the PR, ranks files by risk, and skips the noise: lockfiles, generated code, assets." },
  { n: "02", name: "Specialists", text: "Security, correctness, performance, maintainability, and test reviewers run in parallel, each with its own brief." },
  { n: "03", name: "Investigate", text: "On deeper settings, reviewers read callers, types, and configs in a checkout of your branch before they speak." },
  { n: "04", name: "Judge", text: "A final pass throws out speculative, duplicate, and wrong findings. What survives is what a senior engineer would post." },
];

const CONTROLS = [
  ["Trigger", "every push, on @mention, or both"],
  ["Depth", "quick · standard · deep"],
  ["Reviewers", "pick which specialists run"],
  ["Budget", "cap comments, set a severity floor"],
  ["Scope", "include / exclude globs"],
  ["Rules", "your house rules, in plain English"],
];

export default async function Home({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const [session, params] = await Promise.all([getSession(), searchParams]);
  const appSlug = process.env.GITHUB_APP_SLUG ?? "ownrabbit";

  return (
    <main className="mx-auto max-w-6xl px-6 pb-24">
      <header className="flex items-center justify-between py-6">
        <Logo />
        <nav className="flex items-center gap-6 text-sm text-muted">
          <a href="https://github.com/imtiyazakiwat/ownrabbit" className="hover:text-paper">
            Source
          </a>
          {session ? (
            <Link href="/dashboard" className="text-paper hover:text-carrot">
              Dashboard →
            </Link>
          ) : (
            <a href="/api/auth/login" className="text-paper hover:text-carrot">
              Sign in
            </a>
          )}
        </nav>
      </header>

      {params.error && (
        <p role="alert" className="mt-2 border border-del/40 bg-del-bg px-4 py-2 text-del">
          Sign-in failed ({params.error}). Please try again.
        </p>
      )}

      <section className="grid gap-12 pt-16 md:grid-cols-[1.1fr_1fr] md:items-center md:pt-24">
        <div>
          <p className="rise mb-6 text-xs uppercase tracking-[0.3em] text-carrot">Open-source AI code review</p>
          <h1 className="rise font-display text-5xl leading-[1.02] font-medium tracking-tight [animation-delay:80ms] md:text-7xl">
            Reviews that read
            <br />
            <em className="text-carrot">the whole</em> story.
          </h1>
          <p className="rise mt-8 max-w-md text-muted [animation-delay:160ms]">
            OwnRabbit is a pull request reviewer you can run yourself. A team of specialist agents reads your diff,
            digs into the codebase, argues it out, and leaves only the comments worth reading.
          </p>
          <div className="rise mt-10 flex flex-wrap gap-3 [animation-delay:240ms]">
            <a
              href={`https://github.com/apps/${appSlug}/installations/new`}
              className="inline-flex items-center gap-2 bg-carrot px-5 py-3 font-semibold text-ink transition hover:bg-paper"
            >
              <GitHubMark /> Install on GitHub
            </a>
            <a
              href={session ? "/dashboard" : "/api/auth/login"}
              className="inline-flex items-center gap-2 border border-line px-5 py-3 transition hover:border-paper"
            >
              Configure repos
            </a>
          </div>
        </div>

        <DiffCard />
      </section>

      <section className="mt-32">
        <h2 className="font-display text-3xl md:text-4xl">
          Four stages. <span className="text-muted italic">One quiet review.</span>
        </h2>
        <ol className="mt-10 grid gap-px border border-line bg-line md:grid-cols-4">
          {STAGES.map((s) => (
            <li key={s.n} className="bg-ink p-6">
              <span className="text-xs text-carrot">{s.n}</span>
              <h3 className="mt-3 font-display text-xl">{s.name}</h3>
              <p className="mt-2 text-sm text-muted">{s.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-32 grid gap-12 md:grid-cols-[1fr_1.2fr]">
        <div>
          <h2 className="font-display text-3xl md:text-4xl">
            Every repo,
            <br />
            <em className="text-carrot">your rules.</em>
          </h2>
          <p className="mt-6 max-w-sm text-muted">
            Each repository gets its own settings in the dashboard. Loud on the payments service, quiet on the docs
            site.
          </p>
        </div>
        <dl className="divide-y divide-line border-y border-line">
          {CONTROLS.map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-6 py-4">
              <dt className="font-display text-lg">{k}</dt>
              <dd className="text-right text-sm text-muted">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <footer className="mt-32 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-6 text-xs text-dim">
        <span>OwnRabbit: built in the open.</span>
        <span className="caret">
          comment <span className="text-paper">@{appSlug} review</span> on any PR
        </span>
      </footer>
    </main>
  );
}

function DiffCard() {
  return (
    <figure className="rise border border-line bg-ink-2 shadow-[12px_12px_0_0_var(--color-carrot-soft)] [animation-delay:320ms]">
      <figcaption className="flex items-center justify-between border-b border-line px-4 py-2 text-xs text-muted">
        <span>src/api/users.ts</span>
        <span>
          <span className="text-add">+2</span> <span className="text-del">-1</span>
        </span>
      </figcaption>
      <pre className="overflow-x-auto py-3 text-[13px] leading-6">
        <code>
          <Line n={14}>{"export async function getUser(req) {"}</Line>
          <Line kind="del">{"  const id = Number(req.params.id);"}</Line>
          <Line n={15} kind="add">{"  const id = req.params.id;"}</Line>
          <Line n={16} kind="add">{"  return db.query(`SELECT * FROM users WHERE id = ${id}`);"}</Line>
          <Line n={17}>{"}"}</Line>
        </code>
      </pre>
      <div className="m-3 mt-0 border-l-2 border-del bg-ink-3 p-4">
        <p className="text-xs">
          <span className="text-del">● Critical</span> <span className="text-dim">· security</span>
        </p>
        <p className="mt-1 font-display text-base">SQL injection through the user id</p>
        <p className="mt-1 text-xs text-muted">
          <code className="text-paper">id</code> is no longer coerced to a number and is interpolated straight into
          SQL. Use a bound parameter.
        </p>
        <pre className="mt-3 border border-line bg-add-bg px-3 py-2 text-[12px] text-add">
          {"  return db.query('SELECT * FROM users WHERE id = $1', [id]);"}
        </pre>
      </div>
    </figure>
  );
}

function Line({ n, kind, children }: { n?: number; kind?: "add" | "del"; children: string }) {
  const tone = kind === "add" ? "bg-add-bg text-add" : kind === "del" ? "bg-del-bg text-del" : "text-paper/80";
  const sign = kind === "add" ? "+" : kind === "del" ? "-" : " ";
  return (
    <span className={`block px-4 whitespace-pre ${tone}`}>
      <span className="inline-block w-8 text-dim select-none">{n ?? ""}</span>
      <span className="select-none">{sign} </span>
      {children}
    </span>
  );
}
