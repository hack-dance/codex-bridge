import { MoreVertical } from "lucide-react"
import Link from "next/link"
import type { ReactNode } from "react"

export const Panel = ({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}) => (
  <section className="rounded-2xl border border-zinc-800 bg-zinc-900/85 p-4 shadow-lg shadow-black/20 backdrop-blur-sm">
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {description ? <p className="mt-1 text-xs text-zinc-500">{description}</p> : null}
      </div>
      {actions}
    </div>
    {children}
  </section>
)

export const StatCard = ({
  title,
  value,
  subtitle,
}: {
  title: string
  value: number
  subtitle: string
}) => (
  <article className="rounded-xl border border-zinc-800 bg-zinc-900/85 p-4">
    <p className="text-xs uppercase tracking-wide text-zinc-500">{title}</p>
    <p className="mt-1 text-3xl font-semibold">{value}</p>
    <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>
  </article>
)

export const ConnectionBadge = ({
  label,
  value,
}: {
  label: string
  value: boolean
}) => (
  <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
    <span className="text-sm text-zinc-300">{label}</span>
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${
        value
          ? "border border-emerald-300/40 bg-emerald-300/15 text-emerald-100"
          : "border border-zinc-500/40 bg-zinc-200/20 text-zinc-300"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${value ? "bg-emerald-300" : "bg-zinc-400"}`}
        aria-hidden="true"
      />
      {value ? "connected" : "not connected"}
    </span>
  </div>
)

export const EmptyState = ({ text }: { text: string }) => (
  <p className="rounded-lg border border-dashed border-zinc-700 px-3 py-4 text-sm text-zinc-400">{text}</p>
)

export const Banner = ({
  tone,
  text,
}: {
  tone: "error" | "success"
  text: string
}) => (
  <div
    className={`mt-4 rounded-md px-4 py-3 text-sm ${
      tone === "error"
        ? "border border-rose-500/40 bg-rose-950/30 text-rose-200"
        : "border border-emerald-500/30 bg-emerald-950/20 text-emerald-200"
    }`}
  >
    {text}
  </div>
)

export const ActionButton = ({
  label,
  onClick,
  busy,
  icon,
  variant = "default",
}: {
  label: string
  onClick: () => void
  busy?: boolean
  icon?: ReactNode
  variant?: "default" | "danger" | "accent"
}) => (
  <button
    type="button"
    disabled={busy}
    onClick={onClick}
    className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60 ${
      variant === "danger"
        ? "border-rose-800 bg-rose-950/40 text-rose-100 hover:bg-rose-900/50"
        : variant === "accent"
          ? "border-zinc-600 bg-zinc-100 text-zinc-900 hover:bg-zinc-200"
          : "border-zinc-700 bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
    }`}
  >
    {icon}
    {label}
  </button>
)

export const MiniButton = ({
  label,
  onClick,
  busy,
  variant = "default",
  icon,
}: {
  label: string
  onClick: () => void
  busy?: boolean
  variant?: "default" | "danger"
  icon?: ReactNode
}) => (
  <button
    type="button"
    disabled={busy}
    onClick={onClick}
    className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs ${
      variant === "danger"
        ? "border-rose-700 bg-rose-950/40 text-rose-200 hover:bg-rose-900/50"
        : "border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
    } disabled:cursor-not-allowed disabled:opacity-60`}
  >
    {icon}
    {label}
  </button>
)

const rowActionItemClassName = ({ variant }: { variant: "default" | "danger" }) =>
  `flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition ${
    variant === "danger"
      ? "text-rose-200 hover:bg-rose-900/35"
      : "text-zinc-200 hover:bg-zinc-800"
  }`

export const RowActionMenu = ({
  label = "Row actions",
  children,
}: {
  label?: string
  children: ReactNode
}) => (
  <details className="group relative inline-block text-left">
    <summary className="inline-flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-zinc-200 transition hover:bg-zinc-700 [&::-webkit-details-marker]:hidden">
      <MoreVertical size={14} />
      <span className="sr-only">{label}</span>
    </summary>
    <div className="absolute right-0 z-30 mt-1 min-w-[180px] rounded-md border border-zinc-700 bg-zinc-900/95 p-1 shadow-2xl shadow-black/40 backdrop-blur">
      {children}
    </div>
  </details>
)

export const RowActionMenuButton = ({
  label,
  onClick,
  busy,
  disabled,
  icon,
  variant = "default",
}: {
  label: string
  onClick: () => void
  busy?: boolean
  disabled?: boolean
  icon?: ReactNode
  variant?: "default" | "danger"
}) => (
  <button
    type="button"
    disabled={busy || disabled}
    onClick={(event) => {
      onClick()
      event.currentTarget.closest("details")?.removeAttribute("open")
    }}
    className={`${rowActionItemClassName({ variant })} disabled:cursor-not-allowed disabled:opacity-55`}
  >
    {icon}
    {label}
  </button>
)

export const RowActionMenuLink = ({
  href,
  label,
  icon,
  variant = "default",
}: {
  href: string
  label: string
  icon?: ReactNode
  variant?: "default" | "danger"
}) => (
  <Link
    href={href}
    onClick={(event) => {
      event.currentTarget.closest("details")?.removeAttribute("open")
    }}
    className={rowActionItemClassName({ variant })}
  >
    {icon}
    {label}
  </Link>
)
