"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import SignOutButton from "./sign-out-button";

const workspaceLinks = [
  { icon: "▦", label: "Overview", href: "/dashboard" },
  { icon: "⚿", label: "API Connections", href: "/dashboard/api-connections" },
  { icon: "▤", label: "RSS Feed", href: "/dashboard/rss-feed" },
  { icon: "✦", label: "AI Configuration", href: "/dashboard/ai-configuration" },
  { icon: "♫", label: "Audio Settings", href: "/dashboard/audio-settings" },
  { icon: "▱", label: "Ad Slots", href: "/dashboard/ad-slots" },
  { icon: "◷", label: "Publishing Schedule", href: "/dashboard/publishing-schedule" },
  { icon: "☷", label: "Episodes", href: "/dashboard/episodes" },
  { icon: "▣", label: "Subscription", href: "/dashboard/subscription" },
];

export default function DashboardSidebar({ isAdmin = false }: { isAdmin?: boolean }) {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <Link href="/" className="brand"><span className="brand-mark">◉</span><span>Automate Spreaker</span></Link>
      <nav className="sidebar-nav" aria-label="Dashboard navigation">
        {isAdmin && <div className="side-label">PLATFORM ADMIN · FULL ACCESS</div>}
        <div className="side-label">WORKSPACE</div>
        {workspaceLinks.map((item) => {
          const active = item.href === "/dashboard"
            ? pathname === "/dashboard"
            : pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link className={`side-link ${active ? "active" : ""}`} href={item.href} key={item.href} aria-current={active ? "page" : undefined}>
              <span aria-hidden="true">{item.icon}</span>{item.label}
            </Link>
          );
        })}
        <div className="side-label">ACCOUNT</div>
        <Link className={`side-link ${pathname === "/dashboard/settings" ? "active" : ""}`} href="/dashboard/settings" aria-current={pathname === "/dashboard/settings" ? "page" : undefined}>
          <span aria-hidden="true">⚙</span>Settings
        </Link>
        <SignOutButton />
      </nav>
    </aside>
  );
}
