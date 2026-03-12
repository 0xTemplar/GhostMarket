'use client';

import { motion } from 'framer-motion';
import { OracleRoom } from '@/components/oracle-room';

export default function OraclePage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
      >
        <OracleRoom />
      </motion.div>
    </div>
  );
}

