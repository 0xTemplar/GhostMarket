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
        'flex flex-col gap-1 rounded-xl bg-slate-800/70 px-4 py-3 border border-white/5',
        className
      )}
    >
      <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">
        {label}
      </span>
      <span className="text-sm font-semibold text-white">{value}</span>
    </div>
  );
}
