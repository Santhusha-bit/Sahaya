import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible } from "next/font/google";
import { Suspense } from "react";
import { BottomNav, NavFrame } from "@/components/nav/BottomNav";
import { ServiceWorkerRegistrar } from "@/components/pwa/ServiceWorkerRegistrar";
import { LocalModeBanner } from "@/components/LocalModeBanner";
import "./globals.css";

const atkinson = Atkinson_Hyperlegible({
  variable: "--font-atkinson",
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  title: { default: "Sahaya", template: "%s · Sahaya" },
  description: "Four AI agents for safety, everyday care, wellbeing, and money.",
  applicationName: "Sahaya",
  appleWebApp: { capable: true, title: "Sahaya", statusBarStyle: "default" },
  icons: { apple: "/icons/180" },
};

export const viewport: Viewport = {
  themeColor: "#3b3a8f",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${atkinson.variable} h-full antialiased`}>
      <body className="min-h-full font-sans">
        <Suspense fallback={null}>
          <LocalModeBanner />
        </Suspense>
        <div className="mx-auto min-h-dvh max-w-xl pb-28">{children}</div>
        <Suspense fallback={<NavFrame pathname={null} />}>
          <BottomNav />
        </Suspense>
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
