import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Market Desk Engine",
  description: "Admin dashboard for automated market intelligence commentary."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
