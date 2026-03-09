import { cn } from '@/lib/utils';

interface ProbabilityBadgeProps {
  probability: number;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function ProbabilityBadge({
  probability,
  size = 'md',
  className,
}: ProbabilityBadgeProps) {
  const pct = Math.round(probability * 100);

  return (
    <span
      className={cn(
        'font-mono font-semibold tabular-nums',
        size === 'sm' && 'text-sm',
        size === 'md' && 'text-base',
        size === 'lg' && 'text-2xl',
        pct >= 60 && 'text-yes',
        pct >= 40 && pct < 60 && 'text-amber-600',
        pct < 40 && 'text-no',
        className
      )}
    >
      {pct}¢
    </span>
  );
}
