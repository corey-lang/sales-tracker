"use client";

import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { progressColor } from "@/lib/goals";

type Props = {
  id: string;
  label: string;
  value: number;
  current: number;
  target: number;
  hasGoal: boolean;
  onChange: (next: number) => void;
  onSave?: () => void;
  onQuickAdd?: () => void;
  saving?: boolean;
  disabled?: boolean;
};

export function ActivityCounter({
  id,
  label,
  value,
  current,
  target,
  hasGoal,
  onChange,
  onSave,
  onQuickAdd,
  saving,
  disabled,
}: Props) {
  const set = (n: number) => onChange(Math.max(0, Math.floor(n) || 0));
  const inactive = disabled || saving;

  const showProgress = hasGoal && target > 0;
  const percent = showProgress ? Math.round((current / target) * 100) : 0;
  const { text: percentColor } = progressColor(percent);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Label htmlFor={id} className="text-lg">
          {label}
        </Label>
        {showProgress ? (
          <span className="text-base tabular-nums">
            <span className="font-semibold">{current}</span>
            <span className="text-muted-foreground"> / {target}</span>
            <span className={cn("ml-2 font-semibold", percentColor)}>
              {percent}%
            </span>
          </span>
        ) : hasGoal ? (
          <span className="text-base tabular-nums text-muted-foreground">
            {current}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => set(value - 1)}
          disabled={inactive || value <= 0}
          aria-label={`Decrease ${label}`}
        >
          <Minus className="h-4 w-4" />
        </Button>
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={0}
          placeholder="0"
          value={value === 0 ? "" : value}
          onChange={(e) => {
            const raw = e.target.value;
            set(raw === "" ? 0 : Number(raw));
          }}
          onFocus={(e) => e.currentTarget.select()}
          disabled={inactive}
          className="w-20 text-center text-base font-medium tabular-nums"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => set(value + 1)}
          disabled={inactive}
          aria-label={`Increase ${label}`}
        >
          <Plus className="h-4 w-4" />
        </Button>
        {onSave && (
          <Button
            type="button"
            size="sm"
            onClick={onSave}
            disabled={inactive || value <= 0}
            aria-label={`Save ${label}`}
            className={cn(
              value > 0 &&
                !saving &&
                "bg-green-600 text-white shadow-md hover:bg-green-700 motion-safe:animate-pulse",
            )}
          >
            {saving ? "…" : "Save"}
          </Button>
        )}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onQuickAdd}
          disabled={inactive || !onQuickAdd}
          aria-hidden={!onQuickAdd}
          tabIndex={onQuickAdd ? 0 : -1}
          aria-label={`Add one to ${label}`}
          className={cn(!onQuickAdd && "invisible")}
        >
          +1
        </Button>
      </div>
    </div>
  );
}
