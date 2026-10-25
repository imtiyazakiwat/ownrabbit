// One-time GitHub App registration via the manifest flow.
// Usage: node scripts/create-github-app.mjs <app-url> [app-name]
// Opens a local page that POSTs the manifest to GitHub; GitHub redirects back
// here with a code that is exchanged for the App's credentials, which are
// written to .secrets/github-app.json (gitignored). Nothing is sent elsewhere.
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

const appUrl = (process.argv[2] ?? "").replace(/\/+$/, "");
const name = process.argv[3] ?? "OwnRabbit";
if (!/^https:\/\//.test(appUrl)) {
  console.error("Usage: node scripts/create-github-app.mjs https://your-app.vercel.app [name]");
  process.exit(1);
}

const PORT = 3999;
const state = randomBytes(16).toString("hex");
const manifest = {
  name,
  url: appUrl,
  description: "Open-source AI pull request reviewer.",
  hook_attributes: { url: `${appUrl}/api/github/webhook`, active: true },
  redirect_url: `http://localhost:${PORT}/callback`,
  callback_urls: [`${appUrl}/api/auth/callback`],
  setup_url: `${appUrl}/dashboard`,
  request_oauth_on_install: false,
  public: true,
  default_permissions: {
    contents: "read",
    pull_requests: "write",
    issues: "write",
    metadata: "read",
  },
  default_events: ["pull_request", "issue_comment"],
};

const escape = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const page = `<!doctype html><meta charset="utf-8"><title>Create GitHub App</title>
<body style="font:16px system-ui;padding:3rem;background:#0f0e0c;color:#f1ead9">
<h1>Register ${escape(name)} on GitHub</h1>
<form action="https://github.com/settings/apps/new?state=${state}" method="post">
<input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}">
<button style="font-size:18px;padding:.8rem 1.4rem;background:#ff7a1a;border:0">Create GitHub App →</button>
</form></body>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" }).end(page);
    return;
  }
  if (url.pathname !== "/callback") return res.writeHead(404).end();

  const code = url.searchParams.get("code");
  if (!code || url.searchParams.get("state") !== state) {
    res.writeHead(400).end("Invalid state or missing code");
    return;
  }
  const r = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!r.ok) {
    res.writeHead(500).end(`GitHub conversion failed: ${r.status}`);
    return;
  }
  const app = await r.json();
  await mkdir(".secrets", { recursive: true, mode: 0o700 });
  await writeFile(
    ".secrets/github-app.json",
    JSON.stringify(
      {
        id: app.id,
        slug: app.slug,
        client_id: app.client_id,
        client_secret: app.client_secret,
        webhook_secret: app.webhook_secret,
        pem: app.pem,
        html_url: app.html_url,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  res
    .writeHead(200, { "Content-Type": "text/html" })
    .end(`<body style="font:16px system-ui;padding:3rem">Created <b>${escape(app.slug)}</b>. You can close this tab.</body>`);
  console.log(`CREATED app id=${app.id} slug=${app.slug}`);
  server.close();
});

server.listen(PORT, () => console.log(`Open http://localhost:${PORT} and click "Create GitHub App"`));
