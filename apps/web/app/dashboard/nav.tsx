"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/dashboard", label: "Repositories", match: (p: string) => p === "/dashboard" || /^\/dashboard\/\d+/.test(p) },
  { href: "/dashboard/runs", label: "Runs", match: (p: string) => p.startsWith("/dashboard/runs") },
];

export function DashboardNav({ isAdmin = false }: { isAdmin?: boolean }) {
  const pathname = usePathname();
  const allLinks = isAdmin
    ? [
        ...LINKS,
        {
          href: "/dashboard/admin",
          label: "Admin",
          match: (p: string) => p.startsWith("/dashboard/admin") || p.startsWith("/dashboard/service"),
        },
      ]
    : LINKS;

  return (
    <nav aria-label="Dashboard" className="flex gap-5 text-sm">
      {allLinks.map((link) => {
        const active = link.match(pathname);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={`border-b-2 pb-0.5 ${active ? "border-carrot text-paper" : "border-transparent text-muted hover:text-paper"}`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
