import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SafeSpend | Devnet treasury",
  description: "Devnet treasury operations and protected payment approvals.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
