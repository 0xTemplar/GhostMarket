'use client';

import { motion } from 'framer-motion';
import { Shield, Zap, BarChart3 } from 'lucide-react';

const features = [
  { icon: Shield, label: 'Shielded Execution', desc: 'Hidden order intent' },
  { icon: Zap, label: 'Gasless Claims', desc: 'Zero-friction payouts' },
  { icon: BarChart3, label: 'Live Markets', desc: 'Trade outcomes 24/7' },
];

export function HeroSection() {
  return (
    <section className="relative overflow-hidden border-b border-border/50 bg-gradient-to-b from-primary-soft/60 via-card to-surface">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--color-primary-soft)_0%,_transparent_60%)] opacity-40" />

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pb-10 pt-12 sm:pb-14 sm:pt-16">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className="max-w-2xl"
        >
          <h1 className="font-heading text-3xl font-extrabold tracking-tight text-text sm:text-4xl lg:text-[2.75rem] lg:leading-[1.15]">
            Trade on what you
            <span className="text-primary"> believe</span>
          </h1>
          <p className="mt-4 text-base text-text-secondary leading-relaxed sm:text-lg max-w-lg">
            Prediction markets with shielded execution. Your position size and
            intent stay private.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.15, ease: 'easeOut' }}
          className="mt-8 flex flex-wrap gap-x-8 gap-y-4"
        >
          {features.map((item) => (
            <div key={item.label} className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-card shadow-sm border border-border">
                <item.icon className="h-4 w-4 text-primary" />
              </div>
              <div>
                <div className="text-sm font-semibold text-text">
                  {item.label}
                </div>
                <div className="text-xs text-text-muted">{item.desc}</div>
              </div>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
