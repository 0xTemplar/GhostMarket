'use client';

import { cn } from '@/lib/utils';

const categories = [
  'All',
  'Crypto',
  'Macro',
  'Politics',
  'Tech',
  'Sports',
  'Climate',
] as const;

interface FilterBarProps {
  selected: string;
  onChange: (category: string) => void;
}

export function FilterBar({ selected, onChange }: FilterBarProps) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto scrollbar-none pb-0.5">
      {categories.map((cat) => (
        <button
          key={cat}
          onClick={() => onChange(cat)}
          className={cn(
            'whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition-all duration-200 cursor-pointer',
            selected === cat
              ? 'bg-text text-card shadow-sm'
              : 'bg-card text-text-secondary border border-border hover:border-border-hover hover:text-text'
          )}
        >
          {cat}
        </button>
      ))}
    </div>
  );
}
