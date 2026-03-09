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
    <div className="flex items-center gap-3 w-full md:w-auto overflow-x-auto scrollbar-none pb-1">
      {categories.map((cat) => (
        <button
          key={cat}
          onClick={() => onChange(cat)}
          className={cn(
            'px-4 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors',
            selected === cat
              ? 'bg-white/10 text-white border border-white/5'
              : 'hover:bg-white/5 text-slate-400 hover:text-white border border-transparent'
          )}
        >
          {cat}
        </button>
      ))}
    </div>
  );
}
