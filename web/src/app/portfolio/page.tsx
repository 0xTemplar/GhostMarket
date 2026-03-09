'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { ArrowRight, Ghost } from 'lucide-react';
import { mockPositions, mockPortfolioStats } from '@/data/markets';
import { PortfolioSummary } from '@/components/portfolio-summary';
import { PortfolioPositionRow } from '@/components/portfolio-position-row';
import { Button } from '@/components/ui/button';

export default function PortfolioPage() {
  const hasPositions = mockPositions.length > 0;

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <div className="mb-8">
          <h1 className="font-heading text-2xl sm:text-3xl font-bold tracking-tight text-text">
            Portfolio
          </h1>
          <p className="mt-1.5 text-text-secondary text-sm sm:text-base">
            Your open positions and performance. Exact sizes are shielded.
          </p>
        </div>

        {hasPositions ? (
          <>
            <div className="mb-8">
              <PortfolioSummary stats={mockPortfolioStats} />
            </div>

            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-heading text-lg font-bold text-text">
                Open Positions
              </h2>
              <span className="text-sm text-text-muted">
                {mockPositions.length} position
                {mockPositions.length !== 1 ? 's' : ''}
              </span>
            </div>

            <div className="space-y-3">
              {mockPositions.map((position, i) => (
                <PortfolioPositionRow
                  key={position.id}
                  position={position}
                  index={i}
                />
              ))}
            </div>
          </>
        ) : (
          <div className="rounded-2xl border border-dashed border-border bg-card p-16 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-soft">
              <Ghost className="h-7 w-7 text-primary" />
            </div>
            <h3 className="font-heading text-lg font-bold text-text mb-2">
              No positions yet
            </h3>
            <p className="text-sm text-text-muted mb-6 max-w-sm mx-auto">
              Browse active markets and place your first shielded prediction
              to get started.
            </p>
            <Link href="/">
              <Button>
                Browse Markets
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </div>
        )}
      </motion.div>
    </div>
  );
}
