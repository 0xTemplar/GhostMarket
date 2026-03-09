import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Navbar } from '@/components/navbar';
import { BetSlipProvider } from '@/components/bet-slip-provider';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'GhostMarket — Prediction Markets',
  description:
    'Trade on outcomes with shielded execution. Confidential prediction markets.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${inter.className} antialiased bg-slate-950 text-slate-300 selection:bg-indigo-500/30`}
      >
        <BetSlipProvider>
          <Navbar />
          <main className="min-h-[calc(100vh-4rem)]">{children}</main>
        </BetSlipProvider>
      </body>
    </html>
  );
}
