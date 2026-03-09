interface MiniChartProps {
  data: number[];
  positive?: boolean;
  width?: number;
  height?: number;
  className?: string;
}

export function MiniChart({
  data,
  positive = true,
  width = 80,
  height = 32,
  className,
}: MiniChartProps) {
  if (data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 0.01;
  const pad = 2;
  const innerH = height - pad * 2;
  const innerW = width - pad * 2;

  const points = data.map((v, i) => ({
    x: pad + (i / (data.length - 1)) * innerW,
    y: pad + innerH - ((v - min) / range) * innerH,
  }));

  const lineD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const areaD = `${lineD} L${points[points.length - 1].x},${height} L${points[0].x},${height} Z`;

  const color = positive ? '#16A34A' : '#DC2626';
  const id = `mc-${positive ? 'g' : 'r'}-${data.length}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      style={{ width, height }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.12" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaD} fill={`url(#${id})`} />
      <path
        d={lineD}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
