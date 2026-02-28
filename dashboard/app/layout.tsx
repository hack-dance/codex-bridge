import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { SidebarNav } from "@/components/sidebar-nav";
import "@xyflow/react/dist/style.css";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Codex Bridge Dashboard",
  description: "Operational dashboard for lanes, threads, webhooks, and runtime issues",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <div className="min-h-screen bg-background text-foreground">
          <div className="pointer-events-none fixed inset-0 opacity-60">
            <div className="absolute -left-32 -top-24 h-96 w-96 rounded-full bg-zinc-900 blur-3xl" />
            <div className="absolute bottom-0 right-0 h-112 w-md rounded-full bg-zinc-900 blur-3xl" />
          </div>
          <div className="relative flex w-full">
            <SidebarNav />
            <div className="min-h-screen flex-1 px-2 py-4 md:px-3 md:py-5">{children}</div>
          </div>
        </div>
      </body>
    </html>
  )
}
