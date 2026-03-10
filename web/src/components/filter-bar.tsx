'use client';

import { cn } from '@/lib/utils';

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

interface FilterBarProps {
  selected: string;
  onChange: (category: string) => void;
}

export function FilterBar({ selected, onChange }: FilterBarProps) {
  return (
    <div className="flex items-center gap-1 w-full md:w-auto overflow-x-auto scrollbar-none pb-1">
      {categories.map((cat) => {
        const isActive = selected === cat;
        return (
          <button
            key={cat}
            onClick={() => onChange(cat)}
            className={cn(
              'px-4 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-all duration-200',
              isActive
                ? 'bg-indigo-500/15 text-white border border-indigo-500/30 shadow-[0_0_12px_rgba(99,102,241,0.12)]'
                : 'hover:bg-white/5 text-slate-400 hover:text-white border border-transparent'
            )}
          >
            {cat}
          </button>
        );
      })}
    </div>
  );
}
