import { cn } from "../../lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  error?: string;
  containerClassName?: string;
};

export function Input({
  label,
  hint,
  error,
  containerClassName,
  className,
  id,
  ...props
}: InputProps) {
  const inputId = id ?? props.name ?? undefined;
  const describedById = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;

  return (
    <div className={cn("w-full", containerClassName)}>
      {label ? (
        <label htmlFor={inputId} className="mb-1 block text-sm font-semibold text-slate-200">
          {label}
        </label>
      ) : null}

      <input
        id={inputId}
        className={cn(
          "h-11 w-full rounded-xl border bg-slate-950/30 px-3 text-sm text-slate-100 placeholder:text-slate-500",
          "border-slate-700 focus:border-cyan-400/60 focus:outline-none focus:ring-2 focus:ring-cyan-400/30",
          "disabled:opacity-60 disabled:cursor-not-allowed",
          error ? "border-rose-500/70 focus:border-rose-400/70 focus:ring-rose-400/20" : "",
          className
        )}
        aria-invalid={!!error}
        aria-describedby={describedById}
        {...props}
      />

      {error ? (
        <p id={`${inputId}-error`} className="mt-1 text-xs font-medium text-rose-300">
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="mt-1 text-xs text-slate-400">
          {hint}
        </p>
      ) : null}
    </div>
  );
}