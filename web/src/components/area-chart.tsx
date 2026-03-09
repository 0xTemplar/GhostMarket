'use client';

import { useMemo } from 'react';

interface AreaChartProps {
  data: number[];
  height?: number;
  className?: string;
}

export function AreaChart({ data, height = 200, className }: AreaChartProps) {
  const chartData = useMemo(() => {
    if (data.length < 2) return null;

    const width = 600;
    const padX = 0;
    const padY = 16;
    const innerW = width - padX * 2;
    const innerH = height - padY * 2;

    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 0.01;

    const points = data.map((v, i) => ({
      x: padX + (i / (data.length - 1)) * innerW,
      y: padY + innerH - ((v - min) / range) * innerH,
    }));

    const lineD = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(' ');

    const areaD = `${lineD} L${points[points.length - 1].x.toFixed(1)},${height} L${points[0].x.toFixed(1)},${height} Z`;

    const lastPoint = points[points.length - 1];
    const isPositive = data[data.length - 1] >= data[0];

    const yLabels: { value: number; y: number }[] = [];
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const val = min + (range * i) / steps;
      const y = padY + innerH - (i / steps) * innerH;
      yLabels.push({ value: val, y });
    }

    return { width, lineD, areaD, lastPoint, isPositive, yLabels };
  }, [data, height]);

  if (!chartData) return null;

  const { width, lineD, areaD, lastPoint, isPositive, yLabels } = chartData;
  const color = isPositive ? '#16A34A' : '#DC2626';

  return (
    <div className={className}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ height }}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="area-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.12" />
            <stop offset="100%" stopColor={color} stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {yLabels.map((label) => (
          <line
            key={label.value}
            x1="0"
            y1={label.y}
            x2={width}
            y2={label.y}
            stroke="#E3E1DC"
            strokeWidth="0.5"
            strokeDasharray="4 4"
          />
        ))}

        <path d={areaD} fill="url(#area-grad)" />
        <path
          d={lineD}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        <circle
          cx={lastPoint.x}
          cy={lastPoint.y}
          r="4"
          fill={color}
          stroke="white"
          strokeWidth="2"
        />
      </svg>

      <div className="flex justify-between mt-2 px-1">
        <span className="text-xs text-text-muted">30d ago</span>
        <span className="text-xs text-text-muted">Today</span>
      </div>
    </div>
  );
}
