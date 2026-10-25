import type { Metadata, Viewport } from "next";
import { Fraunces, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  axes: ["SOFT", "opsz"],
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

const siteUrl = (process.env.APP_URL ?? "https://ownrabbit.vercel.app").replace(/\/+$/, "");
const description =
  "OwnRabbit is an open-source, self-hostable AI code reviewer for GitHub pull requests. Multi-agent reviews, inline suggestions, and per-repo control. A free CodeRabbit alternative.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: "OwnRabbit: open-source AI code review for GitHub", template: "%s · OwnRabbit" },
  description,
  applicationName: "OwnRabbit",
  keywords: [
    "AI code review",
    "pull request review",
    "GitHub app",
    "CodeRabbit alternative",
    "open source",
    "self-hosted",
    "LLM",
    "Gemini",
    "code quality",
  ],
  authors: [{ name: "OwnRabbit contributors", url: "https://github.com/imtiyazakiwat/ownrabbit" }],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "OwnRabbit",
    title: "OwnRabbit: open-source AI code review",
    description,
  },
  twitter: { card: "summary_large_image", title: "OwnRabbit: open-source AI code review", description },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = { themeColor: "#0f0e0c", colorScheme: "dark" };

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "OwnRabbit",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Web",
  description,
  url: siteUrl,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  codeRepository: "https://github.com/imtiyazakiwat/ownrabbit",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${jetbrains.variable}`}>
      <body>
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:bg-carrot focus:px-3 focus:py-2 focus:text-ink">
          Skip to content
        </a>
        <div id="main">{children}</div>
        <script
          type="application/ld+json"
          // Static, server-defined object; no user input.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
        />
      </body>
    </html>
  );
}
