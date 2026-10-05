import { cn } from "@/lib/utils";

// The Road to 10,000 progress bar: a track with the goal's quarter marks and a
// finish line, filled to the percent complete. Purely presentational.

export function RoadProgressBar({
  percent,
  size = "md",
  label = "Road to 10,000 progress",
  className,
}: {
  percent: number;
  size?: "md" | "lg";
  label?: string;
  className?: string;
}) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className={cn("relative", className)}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped * 10) / 10}
        className={cn("relative w-full overflow-hidden rounded-full bg-muted", size === "lg" ? "h-5" : "h-3")}
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-primary/80 to-primary transition-[width] duration-700 ease-out"
          style={{ width: `${clamped}%` }}
        />
        {/* Quarter marks: 25 / 50 / 75%. */}
        {[25, 50, 75].map((m) => (
          <span
            key={m}
            aria-hidden="true"
            className="absolute inset-y-0 w-px bg-background/60"
            style={{ left: `${m}%` }}
          />
        ))}
      </div>
    </div>
  );
}
