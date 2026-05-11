"use client";

import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Props = {
  id: string;
  label: string;
  value: number;
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
  onChange,
  onSave,
  onQuickAdd,
  saving,
  disabled,
}: Props) {
  const set = (n: number) => onChange(Math.max(0, Math.floor(n) || 0));
  const inactive = disabled || saving;

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      <Label htmlFor={id} className="text-base">
        {label}
      </Label>
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
          className="w-16 text-center tabular-nums"
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
