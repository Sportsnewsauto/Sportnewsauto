import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Automate Spreaker Podcast",
  description: "Create, produce and publish podcast episodes automatically using your own AI and Spreaker accounts."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}