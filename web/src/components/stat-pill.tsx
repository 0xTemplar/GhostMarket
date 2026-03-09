import { cn } from '@/lib/utils';

interface StatPillProps {
  label: string;
  value: string;
  className?: string;
}

export function StatPill({ label, value, className }: StatPillProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-xl bg-elevated/70 px-4 py-3',
        className
      )}
    >
      <span className="text-xs font-medium text-text-muted uppercase tracking-wide">
        {label}
      </span>
      <span className="text-sm font-semibold text-text">{value}</span>
    </div>
  );
}
