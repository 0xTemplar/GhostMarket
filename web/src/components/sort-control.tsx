'use client';

import { Sparkles, LayoutGrid, List, ChevronDown } from 'lucide-react';

export type SortOption = 'trending' | 'volume' | 'newest' | 'ending-soon';

interface SortControlProps {
  value: SortOption;
  onChange: (value: SortOption) => void;
}

const options: { value: SortOption; label: string }[] = [
  { value: 'trending', label: 'Trending' },
  { value: 'newest', label: 'Newest' },
  { value: 'volume', label: 'Volume' },
  { value: 'ending-soon', label: 'Ending Soon' },
];

export function SortControl({ value, onChange }: SortControlProps) {
  const currentLabel = options.find((o) => o.value === value)?.label ?? 'Newest';

  return (
    <div className="flex items-center gap-3 w-full md:w-auto justify-between md:justify-end">
      <div className="flex gap-1 bg-slate-900 border border-white/10 rounded-lg p-1">
        <div className="relative">
          <button
            onClick={() => {}}
            className="px-3 py-1.5 text-sm font-medium text-white bg-white/10 rounded flex items-center gap-2"
          >
            <Sparkles className="w-3.5 h-3.5" strokeWidth={1.5} />
            {currentLabel}
            <ChevronDown className="w-3.5 h-3.5 ml-1" strokeWidth={1.5} />
          </button>
          <select
            value={value}
            onChange={(e) => onChange(e.target.value as SortOption)}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          >
            {options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <button className="p-1.5 hover:bg-white/5 rounded text-white">
          <LayoutGrid className="w-5 h-5" strokeWidth={1.5} />
        </button>
        <button className="p-1.5 hover:bg-white/5 rounded text-slate-500">
          <List className="w-5 h-5" strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}
