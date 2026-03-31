import { OracleRoom } from '@/components/oracle-room';
import { OracleLocked } from '@/components/oracle-locked';
import { MotionWrapper } from '@/components/motion-wrapper';

export default function OraclePage() {
  const isLocked = process.env.ORACLE_ROOM_LOCKED === 'true';

  if (isLocked) {
    return <OracleLocked />;
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <MotionWrapper>
        <OracleRoom />
      </MotionWrapper>
    </div>
  );
}
