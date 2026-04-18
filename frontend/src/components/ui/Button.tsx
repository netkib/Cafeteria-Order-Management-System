import { cn } from "../../lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
};

const base =
  "inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition " +
  "focus:outline-none focus:ring-2 focus:ring-cyan-400/60 focus:ring-offset-2 focus:ring-offset-slate-950 " +
  "disabled:opacity-60 disabled:cursor-not-allowed select-none";

const variants: Record<Variant, string> = {
  primary:
    "bg-cyan-500 text-slate-950 hover:bg-cyan-400 active:bg-cyan-500 shadow-sm shadow-cyan-500/20",
  secondary:
    "bg-slate-800 text-slate-100 hover:bg-slate-700 active:bg-slate-800 border border-slate-700",
  ghost:
    "bg-transparent text-slate-100 hover:bg-slate-800/70 active:bg-slate-800 border border-slate-800",
  danger:
    "bg-rose-500 text-white hover:bg-rose-400 active:bg-rose-500 shadow-sm shadow-rose-500/20",
};

const sizes: Record<Size, string> = {
  sm: "h-9 px-3 text-sm",
  md: "h-11 px-4 text-sm",
  lg: "h-12 px-5 text-base",
};

function Spinner() {
  return (
    <span
      className="h-4 w-4 animate-spin rounded-full border-2 border-slate-950/30 border-t-slate-950"
      aria-hidden="true"
    />
  );
}

export function Button({
  className,
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(base, variants[variant], sizes[size], className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Spinner /> : null}
      <span>{children}</span>
    </button>
  );
}