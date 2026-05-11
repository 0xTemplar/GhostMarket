import { notFound } from 'next/navigation';
import { OracleRoom } from '@/components/oracle-room';
import { MotionWrapper } from '@/components/motion-wrapper';
import { isOracleRoomPubliclyDisabled } from '@/lib/oracle-room-access';

/** Env-based lock must be evaluated per request, not at build time. */
export const dynamic = 'force-dynamic';

export default function OraclePage() {
  if (isOracleRoomPubliclyDisabled()) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <MotionWrapper>
        <OracleRoom />
      </MotionWrapper>
    </div>
  );
}
