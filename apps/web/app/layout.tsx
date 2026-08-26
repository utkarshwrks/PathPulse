import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PathPulse',
  description:
    'Intelligent dead reckoning for seamless navigation when GNSS drops out. SIH26168, ISRO.',
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
    <html lang="en">
      <body className="h-full antialiased">{children}</body>
    </html>
  );
}
