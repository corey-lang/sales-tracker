"use client";

import { useEffect, useMemo, useState } from "react";

import { supabase } from "@/lib/supabase/client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

function joinAdminNames(names: string[]): string {
  if (names.length === 0) return "admin";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

type Message = {
  id: string;
  salesperson_id: string | null;
  body: string;
};

type Props = {
  salespersonId: string;
};

export function MessagesCard({ salespersonId }: Props) {
  const [personal, setPersonal] = useState<Message | null>(null);
  const [globalMsg, setGlobalMsg] = useState<Message | null>(null);
  const [adminNames, setAdminNames] = useState<string[]>([]);
  const [loaded, setLoadedState] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      supabase
        .from("messages")
        .select("id, salesperson_id, body")
        .eq("salesperson_id", salespersonId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("messages")
        .select("id, salesperson_id, body")
        .is("salesperson_id", null)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("salespeople")
        .select("first_name")
        .eq("is_admin", true)
        .order("first_name"),
    ]).then(([p, g, admins]) => {
      if (cancelled) return;
      setPersonal((p.data ?? null) as Message | null);
      setGlobalMsg((g.data ?? null) as Message | null);
      setAdminNames(
        ((admins.data ?? []) as { first_name: string }[]).map(
          (a) => a.first_name,
        ),
      );
      setLoadedState(true);
    });
    return () => {
      cancelled = true;
    };
  }, [salespersonId]);

  const title = useMemo(
    () => `Message from ${joinAdminNames(adminNames)}:`,
    [adminNames],
  );

  // Render nothing if we either haven't loaded yet or there are no messages.
  if (!loaded) return null;
  if (!personal && !globalMsg) return null;

  return (
    <Card className="gap-1">
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {personal && (
          <p className="whitespace-pre-wrap text-lg font-medium">
            {personal.body}
          </p>
        )}
        {globalMsg && (
          <p className="whitespace-pre-wrap text-lg font-medium">
            {globalMsg.body}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
