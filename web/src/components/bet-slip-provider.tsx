'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { Market } from '@/types/market';
import { BetSlip } from '@/components/bet-slip';

interface BetSlipState {
  isOpen: boolean;
  market: Market | null;
  selectedSide: 'YES' | 'NO';
}

interface BetSlipContextValue {
  state: BetSlipState;
  openBetSlip: (market: Market, side?: 'YES' | 'NO') => void;
  closeBetSlip: () => void;
  setSide: (side: 'YES' | 'NO') => void;
}

const BetSlipContext = createContext<BetSlipContextValue | null>(null);

export function useBetSlip() {
  const ctx = useContext(BetSlipContext);
  if (!ctx) throw new Error('useBetSlip must be used within BetSlipProvider');
  return ctx;
}

export function BetSlipProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BetSlipState>({
    isOpen: false,
    market: null,
    selectedSide: 'YES',
  });

  const openBetSlip = useCallback(
    (market: Market, side: 'YES' | 'NO' = 'YES') => {
      setState({ isOpen: true, market, selectedSide: side });
    },
    []
  );

  const closeBetSlip = useCallback(() => {
    setState((prev) => ({ ...prev, isOpen: false }));
  }, []);

  const setSide = useCallback((side: 'YES' | 'NO') => {
    setState((prev) => ({ ...prev, selectedSide: side }));
  }, []);

  return (
    <BetSlipContext.Provider value={{ state, openBetSlip, closeBetSlip, setSide }}>
      {children}
      {state.isOpen && state.market && (
        <BetSlip
          market={state.market}
          side={state.selectedSide}
          onSideChange={setSide}
          onClose={closeBetSlip}
        />
      )}
    </BetSlipContext.Provider>
  );
}
