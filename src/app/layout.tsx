import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { JuiceBoxUnreadProvider } from "@/components/juice-box-unread-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Elevate AE",
  description: "Daily sales activity tracking for the Elevate AE team",
  applicationName: "Elevate AE",
  appleWebApp: {
    capable: true,
    title: "Elevate",
    statusBarStyle: "black-translucent",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: "#0f1115",
  colorScheme: "dark",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* Juice Box unread state lives at root so the bottom-nav badge and
            the /juice-box page share one source of truth. The provider is a
            no-op for users who cannot see Juice Box. */}
        <JuiceBoxUnreadProvider>{children}</JuiceBoxUnreadProvider>
      </body>
    </html>
  );
}
