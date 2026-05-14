"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";

import { supabase } from "@/lib/supabase/client";
import { isUserRole, type UserRole } from "@/lib/permissions";
import { useSalesperson } from "@/lib/use-salesperson";

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

type LoginPerson = {
  id: string;
  first_name: string;
  is_admin: boolean;
};

export default function Home() {
  const router = useRouter();
  const { salesperson, setSalesperson, loaded } = useSalesperson();

  const [people, setPeople] = useState<LoginPerson[] | null>(null);
  const [typed, setTyped] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!loaded) return;
    if (salesperson) {
      router.replace(salesperson.is_admin ? "/admin" : "/dashboard");
      return;
    }
    // Bulk fetch deliberately excludes admin_pin — we only need id/name/is_admin
    // here to power autocomplete + decide whether to show the PIN field.
    supabase
      .from("salespeople")
      .select("id, first_name, is_admin")
      .order("first_name", { ascending: true })
      .then(({ data, error }) => {
        if (error) {
          setError(error.message);
          return;
        }
        setPeople((data ?? []) as LoginPerson[]);
      });
  }, [loaded, salesperson, router]);

  const matchedAdmin = useMemo(() => {
    if (!people) return null;
    const lower = typed.trim().toLowerCase();
    if (!lower) return null;
    return (
      people.find(
        (p) => p.first_name.toLowerCase() === lower && p.is_admin,
      ) ?? null
    );
  }, [people, typed]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = typed.trim();
    if (!name) {
      setError("Type your name.");
      return;
    }
    setLoading(true);
    setError(null);
    // CITEXT makes first_name lookup case-insensitive.
    const { data, error: lookupErr } = await supabase
      .from("salespeople")
      .select("id, first_name, is_admin, admin_pin, role")
      .eq("first_name", name)
      .maybeSingle();
    setLoading(false);
    if (lookupErr) {
      setError(lookupErr.message);
      return;
    }
    if (!data) {
      setError(`No salesperson found named "${name}".`);
      return;
    }
    if (data.is_admin) {
      if (!data.admin_pin) {
        setError(
          "Admin account has no PIN set. Ask another admin to set one in the database.",
        );
        return;
      }
      if (pin.trim() !== String(data.admin_pin).trim()) {
        // Show enough detail in the error to diagnose without DevTools.
        setError(
          `Incorrect PIN. (DB has ${String(data.admin_pin).length} chars; you entered ${pin.length}.)`,
        );
        return;
      }
    }
    const role: UserRole = isUserRole(data.role)
      ? data.role
      : data.is_admin
        ? "admin"
        : "ae";
    setSalesperson({
      id: data.id,
      first_name: data.first_name,
      is_admin: !!data.is_admin,
      role,
    });
    router.push(data.is_admin ? "/admin" : "/dashboard");
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-4">
      <Image
        src="/logo.png"
        alt="Elevate Homescriptions"
        width={240}
        height={74}
        priority
      />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>
            Type your first name. Admins also enter a PIN.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Your name</Label>
              <Input
                id="name"
                name="name"
                list="salespeople-list"
                autoComplete="off"
                autoCapitalize="words"
                placeholder={
                  people && people.length > 0
                    ? people[0].first_name
                    : "Your name"
                }
                value={typed}
                onChange={(e) => {
                  setTyped(e.target.value);
                  setError(null);
                }}
                disabled={loading || !people}
              />
              <datalist id="salespeople-list">
                {people?.map((p) => (
                  <option key={p.id} value={p.first_name} />
                ))}
              </datalist>
            </div>

            {matchedAdmin && (
              <div className="space-y-2">
                <Label htmlFor="pin">Admin PIN</Label>
                <Input
                  id="pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="PIN"
                  value={pin}
                  onChange={(e) => {
                    setPin(e.target.value);
                    setError(null);
                  }}
                  onFocus={(e) => e.currentTarget.select()}
                  disabled={loading}
                />
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
            {!people && !error && (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
            {people?.length === 0 && !error && (
              <p className="text-sm text-muted-foreground">
                Run <code>supabase/seed.sql</code> in your Supabase SQL editor
                to add the team.
              </p>
            )}

            <Button
              className="w-full"
              type="submit"
              disabled={loading || !typed || (!!matchedAdmin && !pin)}
            >
              {loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
