import { cn } from "../../lib/utils";

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
};

const toneStyles: Record<NonNullable<BadgeProps["tone"]>, string> = {
  neutral: "bg-slate-800/70 text-slate-100 border border-slate-700",
  success: "bg-emerald-500/15 text-emerald-200 border border-emerald-500/30",
  warning: "bg-amber-500/15 text-amber-200 border border-amber-500/30",
  danger: "bg-rose-500/15 text-rose-200 border border-rose-500/30",
  info: "bg-cyan-500/15 text-cyan-200 border border-cyan-500/30",
};

export function Badge({ className, tone = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold",
        toneStyles[tone],
        className
      )}
      {...props}
    />
  );
}