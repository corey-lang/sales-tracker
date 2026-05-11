"use client";

import { cn } from "@/lib/utils";
import { progressColor } from "@/lib/goals";

type Props = {
  label: string;
  value: number;
  target: number;
  showBar?: boolean;
};

export function ActivityProgressRow({
  label,
  value,
  target,
  showBar = true,
}: Props) {
  const enabled = showBar && target > 0;
  const percent = enabled ? Math.round((value / target) * 100) : 0;
  const { bar, text } = progressColor(percent);

  return (
    <li className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        <span className="tabular-nums">
          <span className="text-xl font-bold">{value}</span>
          {enabled && (
            <>
              <span className="text-xl font-bold text-muted-foreground">
                {" "}
                / {target}
              </span>
              <span className={cn("ml-2 text-sm font-semibold", text)}>
                {percent}%
              </span>
            </>
          )}
        </span>
      </div>
      {enabled && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className={cn("h-full transition-[width]", bar)}
            style={{ width: `${Math.min(100, percent)}%` }}
          />
        </div>
      )}
    </li>
  );
}
