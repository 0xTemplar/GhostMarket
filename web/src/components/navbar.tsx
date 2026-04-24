'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutGrid,
  Briefcase,
  Wallet,
  Search,
  Bell,
  Menu,
  Ghost,
  Shield,
  Radar,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { AuthButton } from '@/components/auth-button';
import { useFlowAuth } from '@/lib/flow/provider';

const mainLinks = [
  { href: '/', label: 'Markets', icon: LayoutGrid },
  { href: '/portfolio', label: 'Portfolio', icon: Briefcase },
  { href: '/vault', label: 'Vault', icon: Wallet },
  { href: '/oracle', label: 'Oracle Room', icon: Radar },
];

const categories = [
  'All',
  'For You',
  'Politics',
  'Sports',
  'Crypto',
  'Macro',
  'Tech',
  'Climate',
];

const ADMIN_ADDRESS = process.env.NEXT_PUBLIC_ADMIN_ADDRESS?.toLowerCase();

export function Navbar() {
  const pathname = usePathname();
  const { user } = useFlowAuth();
  const isAdmin =
    ADMIN_ADDRESS &&
    user.evmAddress?.toLowerCase() === ADMIN_ADDRESS;

  return (
    <nav className="border-b border-white/5 bg-slate-950/95 backdrop-blur-md sticky top-0 z-50">
      {/* Primary Nav */}
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-6">
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2 text-white">
            <div className="w-8 h-8 bg-indigo-500 rounded-lg flex items-center justify-center shadow-[0_0_15px_rgba(99,102,241,0.5)]">
              <Ghost className="w-5 h-5 text-white" strokeWidth={1.5} />
            </div>
            <span className="text-xl font-medium tracking-tight">
              Ghost<span className="text-indigo-400">Market</span>
            </span>
          </Link>

          <div className="hidden md:flex items-center gap-1">
            {mainLinks.map((link) => {
              const isActive =
                link.href === '/'
                  ? pathname === '/'
                  : pathname.startsWith(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={cn(
                    'flex items-center gap-2 px-4 py-2 text-sm rounded-lg font-medium transition-colors',
                    isActive
                      ? 'text-indigo-400 bg-indigo-500/10'
                      : 'hover:text-white hover:bg-white/5'
                  )}
                >
                  <link.icon className="w-4 h-4" strokeWidth={1.5} />
                  {link.label}
                </Link>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-4 flex-1 justify-end max-w-md">
          <div className="relative hidden lg:block w-full group">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 group-focus-within:text-slate-300 transition-colors"
              strokeWidth={1.5}
            />
            <input
              type="text"
              placeholder="Search everything..."
              className="w-full bg-slate-900 border border-white/10 rounded-full py-2.5 pl-10 pr-10 text-sm focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 transition-all placeholder:text-slate-600"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-600 border border-white/10 px-1.5 py-0.5 rounded bg-white/5">
              /
            </span>
          </div>

          <div className="h-6 w-px bg-white/10 mx-2 hidden sm:block" />

          <button
            className="relative p-2 hover:bg-white/5 rounded-full transition-colors"
            aria-label="Notifications"
          >
            <Bell className="w-5 h-5" strokeWidth={1.5} />
            <span className="absolute top-2 right-2 w-2 h-2 bg-indigo-500 rounded-full shadow-[0_0_8px_rgba(99,102,241,0.8)]" />
          </button>

          {isAdmin && (
            <Link
              href="/admin"
              title="Admin"
              className={cn(
                'p-2 rounded-lg transition-colors',
                pathname.startsWith('/admin')
                  ? 'bg-amber-500/10 text-amber-400'
                  : 'text-slate-500 hover:text-amber-400 hover:bg-amber-500/10'
              )}
            >
              <Shield className="w-5 h-5" strokeWidth={1.5} />
            </Link>
          )}
          <AuthButton />
          <button className="lg:hidden p-2 hover:bg-white/5 rounded-lg">
            <Menu className="w-6 h-6" strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {/* Secondary Nav - Categories */}
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 border-t border-white/5 h-12 flex items-center overflow-x-auto scrollbar-none gap-6 text-sm">
        <div className="flex items-center gap-2 text-indigo-400 border-b-2 border-indigo-400 h-full px-1 shrink-0">
          <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
          <span className="font-medium">Live</span>
        </div>
        {categories.map((cat) => (
          <Link
            key={cat}
            href={cat === 'All' ? '/' : `/?cat=${cat.toLowerCase()}`}
            className={cn(
              'whitespace-nowrap transition-colors shrink-0',
              cat === 'All' ? 'text-white font-medium' : 'hover:text-slate-100'
            )}
          >
            {cat}
          </Link>
        ))}
      </div>
    </nav>
  );
}
