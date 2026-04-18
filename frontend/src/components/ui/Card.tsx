import { cn } from "../../lib/utils";

export type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: "default" | "glass";
};

export function Card({ className, variant = "glass", ...props }: CardProps) {
  const styles =
    variant === "glass"
      ? "rounded-2xl border border-slate-800/70 bg-slate-950/40 backdrop-blur shadow-lg shadow-black/20"
      : "rounded-2xl border border-slate-800 bg-slate-950 shadow-lg shadow-black/20";

  return <div className={cn(styles, className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("px-5 pt-5", className)} {...props} />
  );
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2 className={cn("text-lg font-extrabold tracking-tight text-slate-100", className)} {...props} />
  );
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("mt-1 text-sm text-slate-400", className)} {...props} />
  );
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("px-5 py-5", className)} {...props} />
  );
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("px-5 pb-5", className)} {...props} />
  );
}