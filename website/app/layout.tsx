import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Podcast Automation for Every Topic | Podcasti",
  description: "Automate RSS-powered podcast production across the topics your audience follows. Turn selected stories into original scripts, hosted voiceovers and scheduled publishing to your Spreaker show."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}