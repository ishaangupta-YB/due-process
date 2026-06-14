import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DueProcess",
  description:
    "Legal information and document preparation for California tenants facing eviction. Not legal advice.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
