'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { TrendingUp, Briefcase, Ghost } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

const links = [
  { href: '/', label: 'Markets', icon: TrendingUp },
  { href: '/portfolio', label: 'Portfolio', icon: Briefcase },
];

export function Navbar() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-border/80 bg-card/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2.5 group">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary shadow-sm shadow-primary/25 transition-shadow group-hover:shadow-md group-hover:shadow-primary/30">
              <Ghost className="h-[18px] w-[18px] text-white" />
            </div>
            <span className="font-heading text-lg font-bold tracking-tight text-text">
              Ghost<span className="text-primary">Market</span>
            </span>
          </Link>

          <nav className="hidden sm:flex items-center gap-1">
            {links.map((link) => {
              const isActive =
                link.href === '/'
                  ? pathname === '/'
                  : pathname.startsWith(link.href);

              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={cn(
                    'flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary-soft text-primary'
                      : 'text-text-secondary hover:text-text hover:bg-elevated'
                  )}
                >
                  <link.icon className="h-4 w-4" />
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            className="hidden sm:inline-flex"
          >
            Connect Wallet
          </Button>

          <div className="flex sm:hidden items-center gap-1">
            {links.map((link) => {
              const isActive =
                link.href === '/'
                  ? pathname === '/'
                  : pathname.startsWith(link.href);

              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={cn(
                    'flex items-center justify-center rounded-lg p-2.5 transition-colors',
                    isActive
                      ? 'bg-primary-soft text-primary'
                      : 'text-text-secondary hover:text-text'
                  )}
                >
                  <link.icon className="h-5 w-5" />
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </header>
  );
}
