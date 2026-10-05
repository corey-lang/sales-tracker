import { PACE_STATUS_LABEL, formatSignedPace, type RoadMetrics } from "@/lib/road-to-10000";
import { cn } from "@/lib/utils";

// "Ahead of pace +5.0/day" — or "Goal reached" once the total hits 10,000.

export function RoadStatusBadge({
  metrics,
  className,
  compact = false,
}: {
  metrics: RoadMetrics;
  className?: string;
  /** Home card: plain coloured text on one line instead of a padded pill. */
  compact?: boolean;
}) {
  if (compact) return <CompactStatus metrics={metrics} className={className} />;
  if (metrics.complete) {
    return (
      <span className={cn("inline-flex items-center gap-1 rounded-full bg-primary/15 px-3 py-1 text-sm font-semibold text-primary", className)}>
        🎉 Goal reached
      </span>
    );
  }
  if (!metrics.status) {
    // Pace unavailable (e.g. too early in the year): a neutral state, never "Ahead of pace —".
    return (
      <span className={cn("inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-sm font-semibold text-muted-foreground", className)}>
        Pace status <span className="font-medium">—</span>
      </span>
    );
  }
  const tone =
    metrics.status === "ahead"
      ? "bg-primary/15 text-primary"
      : metrics.status === "on_pace"
        ? "bg-muted text-foreground"
        : "bg-amber-500/15 text-amber-700 dark:text-amber-300";
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-1.5 rounded-full px-3 py-1 text-sm font-semibold", tone, className)}>
      {PACE_STATUS_LABEL[metrics.status]}
      <span className="font-medium tabular-nums opacity-80">{formatSignedPace(metrics.paceDifference)}/day</span>
    </span>
  );
}

/** The Home card's one-line status: "Ahead of pace +2.6/day" in the status colour. */
function CompactStatus({ metrics, className }: { metrics: RoadMetrics; className?: string }) {
  if (metrics.complete) {
    return <p className={cn("text-xs font-semibold text-primary", className)}>🎉 Goal reached</p>;
  }
  if (!metrics.status) {
    return (
      <p className={cn("text-xs font-semibold text-muted-foreground", className)}>
        Pace status <span className="font-medium">—</span>
      </p>
    );
  }
  const tone =
    metrics.status === "ahead"
      ? "text-primary"
      : metrics.status === "on_pace"
        ? "text-foreground"
        : "text-amber-700 dark:text-amber-300";
  return (
    <p className={cn("text-xs font-semibold", tone, className)}>
      {PACE_STATUS_LABEL[metrics.status]}{" "}
      <span className="tabular-nums">{formatSignedPace(metrics.paceDifference)}/day</span>
    </p>
  );
}
