"use client";

import {
  Activity,
  Blocks,
  Cable,
  GitBranchPlus,
  LayoutDashboard,
  SlidersHorizontal,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/lanes", label: "Lanes", icon: Blocks },
  { href: "/threads", label: "Threads", icon: GitBranchPlus },
  { href: "/webhooks", label: "Webhooks", icon: Cable },
  { href: "/topology", label: "Topology", icon: Activity },
  { href: "/system", label: "System", icon: SlidersHorizontal },
];

const isActivePath = ({
  pathname,
  href,
}: {
  pathname: string;
  href: string;
}) =>
  href === "/"
    ? pathname === "/"
    : pathname === href || pathname.startsWith(`${href}/`);

export const SidebarNav = () => {
  const pathname = usePathname();

  return (
    <aside className="sticky top-0 flex h-screen w-64 shrink-0 flex-col border-zinc-800/80 border-r bg-zinc-950/80 px-4 py-5 backdrop-blur-md">
      <div>
        <p className="text-xs text-zinc-500 uppercase tracking-[0.22em]">
          Codex Bridge
        </p>
        <h1 className="mt-1 font-semibold text-lg text-zinc-100">Ops HUD</h1>
        <p className="mt-2 text-xs text-zinc-500">Operational command center</p>
      </div>

      <nav className="mt-6 flex flex-col gap-1">
        {navItems.map((item) => {
          const active = isActivePath({ pathname, href: item.href });
          const Icon = item.icon;
          return (
            <Link
              className={`group flex items-center gap-2 rounded-md px-3 py-2 text-sm transition ${
                active
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
              }`}
              href={item.href}
              key={item.href}
            >
              <Icon
                className={
                  active
                    ? "text-zinc-100"
                    : "text-zinc-500 group-hover:text-zinc-300"
                }
                size={15}
              />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto rounded-md border border-zinc-800 bg-zinc-900/70 p-3">
        <p className="text-xs text-zinc-500">
          Real-time operational visibility for lanes, threads, sessions, and
          webhooks.
        </p>
      </div>
    </aside>
  );
};
