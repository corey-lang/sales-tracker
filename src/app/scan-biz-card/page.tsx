"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, ImageUp } from "lucide-react";

import { useSalesperson } from "@/lib/use-salesperson";
import { useScrollToTop } from "@/lib/use-scroll-to-top";

import { BottomNav, BOTTOM_NAV_SPACER } from "@/components/bottom-nav";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BusinessCardScanner } from "@/components/business-card-scanner";
import { PhoneContactScanner } from "@/components/phone-contact-scanner";

// Dedicated Scan Biz Card route. Two clearly-labelled paths surface both
// existing scan flows; each path lets the AE pick a capture source (camera
// vs. upload). Once a file is picked the matching scanner panel renders
// in-place on this same route, so the AE never bounces back to /dashboard.
//
// The downstream scan pipeline is unchanged:
//   * "Scan Card"                       -> BusinessCardScanner
//                                          (upload -> business_card_scans
//                                           row -> background AI extraction
//                                           -> admin review queue / Tonja)
//   * "Scan Card and add to Contacts"   -> PhoneContactScanner
//                                          (upload -> AI extraction ->
//                                           editable review -> vCard handed
//                                           to the phone Contacts app)
// Duplicate detection, admin verification, and contact-save behavior all
// live inside those existing components / their API routes — nothing here
// changes them.

export default function ScanBizCardPage() {
  const router = useRouter();
  const { salesperson, loaded } = useSalesperson();
  useScrollToTop();

  // Hidden file inputs. Two per flow — one with capture="environment" (rear
  // camera) and one without (Photo Library / Files). The visible buttons
  // click these directly so the OS picker is the only intermediate UI.
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
    if (!loaded) return;
    if (!salesperson) {
      router.replace("/");
      return;
    }
    if (salesperson.role === "assistant") {
      router.replace("/dashboard");
    }
  }, [loaded, salesperson, router]);

  if (!loaded || !salesperson || salesperson.role === "assistant") {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  /** Records a picked image and opens the matching scanner panel. */
  const handlePickedFile = (
    e: React.ChangeEvent<HTMLInputElement>,
    target: "admin" | "phone",
  ) => {
    const file = e.target.files?.[0];
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

  // Focused review mode for the phone-contact flow — matches the prior
  // dashboard behavior so the editable contact screen fills the viewport
  // without competing chrome. Closing the panel returns to the choice list.
  if (phoneScan) {
    return (
      <main className="pwa-safe-top mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-3 p-4">
        <PhoneContactScanner
          salesperson={salesperson}
          file={phoneScan.file}
          fileKey={phoneScan.key}
          onScanAnother={() => phoneCameraRef.current?.click()}
          onClose={() => setPhoneScan(null)}
        />
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
    <>
      <main
        className={`pwa-safe-top mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-4 p-4 ${BOTTOM_NAV_SPACER}`}
      >
        <header className="space-y-1 pt-1">
          <p className="text-sm text-muted-foreground">Capture</p>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Scan Biz Card
          </h1>
          <p className="text-sm text-muted-foreground">
            Pick where the card should go.
          </p>
        </header>

        {/* Admin / review-queue flow. The scanner panel renders in-place
            below the choice cards once a file is picked so the AE can
            batch-scan additional cards without leaving the page. */}
        {adminScan && (
          <BusinessCardScanner
            salesperson={salesperson}
            file={adminScan.file}
            fileKey={adminScan.key}
            onScanAnother={() => adminCameraRef.current?.click()}
            onClose={() => setAdminScan(null)}
          />
        )}

        <ScanPathCard
          title="Scan Card"
          description="Send to the review queue for follow-up."
          onTakePhoto={() => adminCameraRef.current?.click()}
          onUploadImage={() => adminUploadRef.current?.click()}
        />

        <ScanPathCard
          title="Scan Card and add to Contacts"
          description="Save the card straight to your phone contacts."
          onTakePhoto={() => phoneCameraRef.current?.click()}
          onUploadImage={() => phoneUploadRef.current?.click()}
        />

        {/* Hidden native file inputs. Clicked directly by the buttons above
            so there's no intermediate UI. Camera inputs set
            capture="environment" to bias the rear camera; upload inputs
            omit capture so iOS / Android offer Photo Library / Files. */}
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
      </main>
      <BottomNav salesperson={salesperson} />
    </>
  );
}

function ScanPathCard({
  title,
  description,
  onTakePhoto,
  onUploadImage,
}: {
  title: string;
  description: string;
  onTakePhoto: () => void;
  onUploadImage: () => void;
}) {
  return (
    <Card>
      <CardContent className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant="outline"
            className="justify-center"
            onClick={onTakePhoto}
          >
            <Camera aria-hidden="true" className="size-4" />
            Take Photo
          </Button>
          <Button
            type="button"
            variant="outline"
            className="justify-center"
            onClick={onUploadImage}
          >
            <ImageUp aria-hidden="true" className="size-4" />
            Upload
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
