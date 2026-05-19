"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Camera, ImageUp, ListChecks, type LucideIcon } from "lucide-react";

import { formatDateMDY } from "@/lib/dates";
import { nextQuote } from "@/lib/quotes";
import { isTestAccount } from "@/lib/permissions";
import { useSalesperson } from "@/lib/use-salesperson";
import { useScrollToTop } from "@/lib/use-scroll-to-top";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ThisWeekCard } from "@/components/this-week-card";
import { AeTasksCard } from "@/components/ae-tasks-card";
import { BusinessCardScanner } from "@/components/business-card-scanner";
import { PhoneContactScanner } from "@/components/phone-contact-scanner";
import { DailyEntryForm } from "@/components/daily-entry-form";
import { MyWeekCard } from "@/components/my-week-card";
import { EditWeekCard } from "@/components/edit-week-card";
import { MessagesCard } from "@/components/messages-card";
import { VerificationCenter } from "@/components/verification-center";

/** A compact, light quick-action button. */
function QuickAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center justify-center gap-2 rounded-lg bg-card px-3 py-2.5 text-sm font-medium ring-1 ring-foreground/10 transition-colors hover:bg-muted hover:ring-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <Icon aria-hidden="true" className="size-4 text-primary" />
      {label}
    </button>
  );
}

/**
 * A business card feature shown as a titled pair of sub-actions: Take Photo
 * (rear camera) and Upload Image (photo library / files). Each button opens a
 * hidden native input owned by the dashboard.
 */
function ScanFeature({
  title,
  onTakePhoto,
  onUploadImage,
}: {
  title: string;
  onTakePhoto: () => void;
  onUploadImage: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <p className="px-0.5 text-xs font-medium text-foreground/70">{title}</p>
      <div className="grid grid-cols-2 gap-2">
        <QuickAction icon={Camera} label="Take Photo" onClick={onTakePhoto} />
        <QuickAction
          icon={ImageUp}
          label="Upload Image"
          onClick={onUploadImage}
        />
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const { salesperson, clear, loaded } = useSalesperson();
  const [entryVersion, setEntryVersion] = useState(0);
  const [quote, setQuote] = useState<string>("");

  // Business card scanning. The dashboard owns hidden native file inputs; the
  // sub-action buttons click them directly, so there is no intermediate modal.
  // Each feature has TWO inputs: a camera input (capture="environment", biases
  // the rear camera) and an upload input (no capture — Photo Library / Files).
  // A pick stores { file, key } and renders the matching scanner; `key` bumps
  // on every pick so re-picking (even the same file) re-processes — that is
  // also how the in-panel "Scan Another …" buttons work.
  const adminCameraRef = useRef<HTMLInputElement>(null);
  const adminUploadRef = useRef<HTMLInputElement>(null);
  const phoneCameraRef = useRef<HTMLInputElement>(null);
  const phoneUploadRef = useRef<HTMLInputElement>(null);
  const scanKeyRef = useRef(0);
  const [adminScan, setAdminScan] = useState<{
    file: File;
    key: number;
  } | null>(null);
  const [phoneScan, setPhoneScan] = useState<{
    file: File;
    key: number;
  } | null>(null);

  useEffect(() => {
    if (loaded && !salesperson) router.replace("/");
  }, [loaded, salesperson, router]);

  useScrollToTop();

  useEffect(() => {
    // Picking a random quote on the client only (avoids SSR/CSR hydration
    // mismatch from Math.random). Synchronous setState here is the right
    // pattern for this case.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQuote(nextQuote());
  }, []);

  if (!loaded || !salesperson) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  const handleSwitchUser = () => {
    clear();
    router.push("/");
  };

  if (salesperson.role === "assistant") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 p-4 sm:p-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                Hi, {salesperson.first_name}
              </h1>
            </div>
            <Image
              src="/logo.png"
              alt="Elevate Homescriptions"
              width={180}
              height={55}
              priority
              className="shrink-0"
            />
          </div>
          <Button variant="outline" size="sm" onClick={handleSwitchUser}>
            Log out
          </Button>
        </header>
        <VerificationCenter />
      </main>
    );
  }

  const now = new Date();
  const today = `${format(now, "EEEE")}, ${formatDateMDY(now)}`;
  const isAe = salesperson.role === "ae";

  // TEMPORARY — "Scan Card & Save Contact" is gated to the test account for
  // limited live testing before rollout. Non-test AEs only see "Scan Business
  // Card". The backend routes enforce the same gate (me.is_test). Remove this
  // when the phone-contact feature ships broadly.
  const isTest = isTestAccount(salesperson);

  const scrollToLog = () => {
    document
      .getElementById("log-activity")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  /** Records a picked image and opens the matching scanner panel. */
  const handlePickedFile = (
    e: React.ChangeEvent<HTMLInputElement>,
    target: "admin" | "phone",
  ) => {
    const file = e.target.files?.[0];
    // Reset so picking the same file again re-fires onChange.
    e.target.value = "";
    if (!file) return;
    scanKeyRef.current += 1;
    const pick = { file, key: scanKeyRef.current };
    // The two flows are mutually exclusive — opening one closes the other.
    if (target === "admin") {
      setPhoneScan(null);
      setAdminScan(pick);
    } else {
      setAdminScan(null);
      setPhoneScan(pick);
    }
  };

  // Focused review mode: while the AE is in the "Scan Card & Save Contact"
  // flow, the rest of the dashboard (momentum/leaderboard, quick actions,
  // to-do, log activity, …) is hidden so the screen reads as a dedicated
  // contact review-and-save workflow. Closing the panel restores the dashboard.
  if (isAe && phoneScan) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-3 p-4">
        <PhoneContactScanner
          salesperson={salesperson}
          file={phoneScan.file}
          fileKey={phoneScan.key}
          onScanAnother={() => phoneCameraRef.current?.click()}
          onClose={() => setPhoneScan(null)}
        />
        {/* Kept mounted so "Scan Another Contact" can reopen the camera. */}
        <input
          ref={phoneCameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(e) => handlePickedFile(e, "phone")}
          className="sr-only"
          aria-hidden="true"
          tabIndex={-1}
        />
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-3 p-4">
      {/* Compact greeting — the weekly momentum card is the visual hero. */}
      <header className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">{today}</p>
          <h1 className="truncate text-xl font-bold tracking-tight">
            Hi, {salesperson.first_name} 👋
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {salesperson.is_admin && (
            <Link
              href="/admin"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Admin
            </Link>
          )}
          <Button variant="ghost" size="sm" onClick={handleSwitchUser}>
            Log out
          </Button>
        </div>
      </header>

      {/* 1 — This week: personal momentum + leaderboard context */}
      <ThisWeekCard salespersonId={salesperson.id} refreshKey={entryVersion} />

      <MessagesCard salespersonId={salesperson.id} />

      {/* 2 — Quick actions */}
      <section className="space-y-3">
        <h2 className="px-0.5 text-sm font-medium text-muted-foreground">
          Quick actions
        </h2>

        {/* The admin scanner renders here; the action buttons below stay
            visible so another card can be scanned with a single tap. The
            phone-contact flow instead takes over the screen in focused mode
            (see the early return above). */}
        {isAe && adminScan && (
          <BusinessCardScanner
            salesperson={salesperson}
            file={adminScan.file}
            fileKey={adminScan.key}
            onScanAnother={() => adminCameraRef.current?.click()}
            onClose={() => setAdminScan(null)}
          />
        )}

        {/* Each business card feature exposes Take Photo + Upload Image. */}
        {isAe && (
          <ScanFeature
            title="Scan Business Card"
            onTakePhoto={() => adminCameraRef.current?.click()}
            onUploadImage={() => adminUploadRef.current?.click()}
          />
        )}
        {/* TEMPORARY — phone-contact feature is gated to the test account. */}
        {isAe && isTest && (
          <ScanFeature
            title="Scan Card & Save Contact"
            onTakePhoto={() => phoneCameraRef.current?.click()}
            onUploadImage={() => phoneUploadRef.current?.click()}
          />
        )}

        <div className="grid grid-cols-1 gap-2">
          <QuickAction
            icon={ListChecks}
            label="Log activity"
            onClick={scrollToLog}
          />
        </div>

        {/* Hidden native file inputs — clicked directly by the buttons above,
            so there is no intermediate modal. "Take Photo" sets
            capture="environment" to bias the rear camera; "Upload Image"
            omits capture so the OS offers Photo Library / Files / Camera. */}
        {isAe && (
          <>
            <input
              ref={adminCameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => handlePickedFile(e, "admin")}
              className="sr-only"
              aria-hidden="true"
              tabIndex={-1}
            />
            <input
              ref={adminUploadRef}
              type="file"
              accept="image/*"
              onChange={(e) => handlePickedFile(e, "admin")}
              className="sr-only"
              aria-hidden="true"
              tabIndex={-1}
            />
          </>
        )}
        {isAe && isTest && (
          <>
            <input
              ref={phoneCameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => handlePickedFile(e, "phone")}
              className="sr-only"
              aria-hidden="true"
              tabIndex={-1}
            />
            <input
              ref={phoneUploadRef}
              type="file"
              accept="image/*"
              onChange={(e) => handlePickedFile(e, "phone")}
              className="sr-only"
              aria-hidden="true"
              tabIndex={-1}
            />
          </>
        )}
      </section>

      {/* 3 — To-Do / follow-ups */}
      <AeTasksCard />

      {/* Daily activity logging — kept, de-prioritized below the dashboard. */}
      <Card id="log-activity" size="sm" className="scroll-mt-4">
        <CardHeader>
          <CardTitle>Log activity</CardTitle>
          <CardDescription>
            Enter only what you just did — it adds to your weekly total.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DailyEntryForm
            salespersonId={salesperson.id}
            refreshKey={entryVersion}
            onSaved={() => setEntryVersion((n) => n + 1)}
          />
        </CardContent>
      </Card>

      <MyWeekCard salespersonId={salesperson.id} refreshKey={entryVersion} />

      <EditWeekCard
        salespersonId={salesperson.id}
        refreshKey={entryVersion}
        onSaved={() => setEntryVersion((n) => n + 1)}
      />

      {/* 5 — Motivation, intentionally last and low-weight. */}
      {quote && (
        <p className="px-3 pb-1 text-center text-xs italic text-muted-foreground/70">
          &ldquo;{quote}&rdquo;
        </p>
      )}
    </main>
  );
}
