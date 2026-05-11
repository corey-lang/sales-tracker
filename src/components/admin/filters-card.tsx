"use client";

import {
  endOfMonth,
  endOfWeek,
  format,
  startOfMonth,
  startOfWeek,
  subMonths,
  subWeeks,
} from "date-fns";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Salesperson = { id: string; first_name: string };

type Props = {
  from: string;
  to: string;
  salespersonFilter: string;
  people: Salesperson[];
  onChangeFrom: (v: string) => void;
  onChangeTo: (v: string) => void;
  onChangeSalesperson: (v: string) => void;
};

const fmt = (d: Date) => format(d, "yyyy-MM-dd");

export function FiltersCard({
  from,
  to,
  salespersonFilter,
  people,
  onChangeFrom,
  onChangeTo,
  onChangeSalesperson,
}: Props) {
  const apply = (start: Date, end: Date) => {
    onChangeFrom(fmt(start));
    onChangeTo(fmt(end));
  };

  const applyToday = () => {
    const n = new Date();
    apply(n, n);
  };
  const applyThisWeek = () => {
    const n = new Date();
    apply(
      startOfWeek(n, { weekStartsOn: 0 }),
      endOfWeek(n, { weekStartsOn: 0 }),
    );
  };
  const applyLastWeek = () => {
    const n = subWeeks(new Date(), 1);
    apply(
      startOfWeek(n, { weekStartsOn: 0 }),
      endOfWeek(n, { weekStartsOn: 0 }),
    );
  };
  const applyMTD = () => {
    const n = new Date();
    apply(startOfMonth(n), n);
  };
  const applyLastMonth = () => {
    const n = subMonths(new Date(), 1);
    apply(startOfMonth(n), endOfMonth(n));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Filters</CardTitle>
        <CardDescription>Date range + salesperson selection.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="from">From</Label>
            <Input
              id="from"
              type="date"
              value={from}
              onChange={(e) => onChangeFrom(e.target.value)}
              className="w-44"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="to">To</Label>
            <Input
              id="to"
              type="date"
              value={to}
              onChange={(e) => onChangeTo(e.target.value)}
              className="w-44"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="salesperson">Salesperson</Label>
            <Select
              value={salespersonFilter}
              onValueChange={onChangeSalesperson}
            >
              <SelectTrigger id="salesperson" className="w-48">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All salespeople</SelectItem>
                {people.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.first_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Quick range:</span>
          <Button type="button" variant="outline" size="sm" onClick={applyToday}>
            Today
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={applyThisWeek}>
            This week
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={applyLastWeek}>
            Last week
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={applyMTD}>
            MTD
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={applyLastMonth}>
            Last month
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
