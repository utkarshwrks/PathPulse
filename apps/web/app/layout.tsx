import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

/**
 * Two families, self-hosted by next/font so nothing is fetched at runtime.
 *
 * ★ THE FONT IS PART OF THE ARGUMENT ★
 * This interface is almost entirely numbers, and numbers that shift width as
 * they change read as unstable — which for a navigation HUD is the exact
 * wrong impression. JetBrains Mono has true tabular figures and a tall
 * x-height at small sizes, which is where every reading in the HUD lives.
 * Inter carries the prose.
 *
 * next/font inlines them at build time, so there is no network request, no
 * layout shift, and the APK keeps working with every radio off — a webfont
 * fetched from Google would break offline mode outright.
 */
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'PathPulse — navigation that does not stop when the satellites do',
  description:
    'Intelligent dead reckoning for seamless navigation when GNSS drops out. Inertial estimation constrained by vehicle physics and road geometry, on an ordinary Android phone. SIH26168, ISRO.',
  applicationName: 'PathPulse',
  authors: [{ name: 'Team Avinya' }],
  keywords: [
    'dead reckoning', 'GNSS', 'INS', 'NavIC', 'inertial navigation',
    'sensor fusion', 'map matching', 'SIH26168', 'ISRO',
  ],
  openGraph: {
    title: 'PathPulse — navigation that does not stop when the satellites do',
    description:
      'Dead reckoning on an ordinary phone: 10.0% mean drift over 60-second GNSS blackouts, measured and reported with its tail.',
    type: 'website',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  // The map is full-bleed and the HUD sits over it; a scrollable body would
  // fight touch panning on the phone.
  userScalable: false,
  themeColor: '#0a0e14',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="h-full antialiased">{children}</body>
    </html>
  );
}
