import type { Metadata } from "next";
import { Space_Grotesk, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-space-grotesk",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "DueProcess — California eviction response help",
  description:
    "Legal information and document preparation for California tenants facing eviction. Not legal advice.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${inter.variable} ${jetbrainsMono.variable}`}
    >
      <body>
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        <div className="page">
          <header className="site-header">
            <div className="site-header__inner">
              <a href="/" className="brand">
                <span className="brand__mark" aria-hidden="true">
                  DP
                </span>
                DueProcess
              </a>
              <span className="brand__tag">California · Tenant help</span>
              <span className="header-disclaimer">
                Legal info, not a lawyer
              </span>
            </div>
          </header>

          <main id="main">{children}</main>

          <footer className="site-footer" role="contentinfo">
            <div className="site-footer__inner">
              <p style={{ margin: 0 }}>
                <strong>This is not legal advice and DueProcess is not a lawyer.</strong>{" "}
                It provides legal information and helps you prepare{" "}
                <strong>drafts to review before filing</strong>. It cannot
                represent you or file anything with a court. For advice about
                your situation, contact a licensed attorney or a legal-aid
                clinic. Deadlines shown are estimates — always confirm with the
                court.
              </p>
              <div className="footer-credits">
                <span>Built by Ishaan Gupta</span>
                <a
                  href="https://github.com/ishaangupta-YB/due-process.git"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open source
                </a>
              </div>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
