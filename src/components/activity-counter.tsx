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
      <Label htmlFor={id} className="text-lg font-semibold">
        {label}
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        {showProgress ? (
          <div className="mr-1 flex flex-col items-start leading-tight">
            <span className="text-base tabular-nums">
              <span className="font-semibold">{current}</span>
              <span className="text-muted-foreground"> / {target}</span>
            </span>
            <span
              className={cn(
                "text-sm font-semibold tabular-nums",
                percentColor,
              )}
            >
              {percent}%
            </span>
          </div>
        ) : hasGoal ? (
          <span className="mr-1 text-base tabular-nums text-muted-foreground">
            {current}
          </span>
        ) : null}
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
          className="w-24 text-center text-base font-medium tabular-nums"
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
        <div
          className={cn(
            "flex flex-col items-center",
            !onQuickAdd && "invisible",
          )}
        >
          <Button
            type="button"
            variant="secondary"
            onClick={onQuickAdd}
            disabled={inactive || !onQuickAdd}
            aria-hidden={!onQuickAdd}
            tabIndex={onQuickAdd ? 0 : -1}
            aria-label={`Add one to ${label}`}
          >
            +1
          </Button>
          <span className="mt-0.5 text-[10px] leading-none text-muted-foreground">
            quick add
          </span>
        </div>
      </div>
    </div>
  );
}
