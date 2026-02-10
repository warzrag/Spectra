import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Spectra — The Next-Gen Antidetect Browser',
  description: 'Manage multiple browser profiles with unique fingerprints. Stay undetected with advanced anti-fingerprinting, proxy support, and team collaboration.',
  keywords: ['antidetect browser', 'browser fingerprint', 'multi-account', 'privacy', 'spectra'],
  icons: {
    icon: '/favicon.svg',
  },
  openGraph: {
    title: 'Spectra — The Next-Gen Antidetect Browser',
    description: 'Manage multiple browser profiles with unique fingerprints. Stay undetected.',
    type: 'website',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="scroll-smooth">
      <body className="min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}
