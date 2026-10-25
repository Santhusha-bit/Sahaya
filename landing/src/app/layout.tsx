import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://sahaya.ai"),
  title: "Sahaya | Your AI Companion for Independent Living",
  description:
    "Sahaya is a voice-first AI companion helping older adults stay safe, manage everyday care, understand wellness changes, and simplify finances while keeping families connected.",
  keywords: [
    "AI companion",
    "older adults",
    "elder care",
    "voice assistant",
    "scam protection",
    "medication reminders",
    "family care dashboard",
    "independent living",
  ],
  authors: [{ name: "Sahaya" }],
  openGraph: {
    title: "Sahaya | Your AI Companion for Independent Living",
    description:
      "One voice-first AI companion for safer, healthier, more independent living, keeping families connected.",
    type: "website",
    siteName: "Sahaya",
  },
  twitter: {
    card: "summary_large_image",
    title: "Sahaya | Your AI Companion for Independent Living",
    description:
      "One voice-first AI companion for safer, healthier, more independent living, keeping families connected.",
  },
  icons: {
    icon: "/brand/mark.svg",
  },
};

export const viewport: Viewport = {
  themeColor: "#168b82",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-full focus:bg-ink focus:px-5 focus:py-3 focus:text-white"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
