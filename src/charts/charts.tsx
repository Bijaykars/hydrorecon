import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { FdcPoint } from '../engine/hydro.ts';
import type { Scheme } from '../types.ts';

echarts.use([
  LineChart,
  BarChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  CanvasRenderer,
]);

const INK = '#e6edf3';
const MUTED = '#8fa3b5';
const FAINT = '#64788c';
const LINE = '#1e2a38';
const RIVER = '#4db8ff';
const AMBER = '#d29922';
const GREEN = '#3fb950';
const PURPLE = '#bc8cff';
const RED = '#f85149';

type Option = echarts.EChartsCoreOption;

function EChart({ option, height }: { option: Option; height: number }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ReturnType<typeof echarts.init> | null>(null);

  useEffect(() => {
    if (!el.current) return;
    chart.current = echarts.init(el.current);
    const ro = new ResizeObserver(() => chart.current?.resize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={el} style={{ height }} className="w-full" />;
}

const baseAxis = {
  axisLine: { lineStyle: { color: LINE } },
  axisTick: { show: false },
  axisLabel: { color: FAINT, fontSize: 10 },
  splitLine: { lineStyle: { color: LINE, type: 'dashed' as const } },
};

const baseTooltip = {
  backgroundColor: '#1a2430',
  borderColor: '#2c3d52',
  textStyle: { color: INK, fontSize: 11 },
};

/** Flow-duration curve with the design + residual flow marked. */
export function FdcChart({
  fdc,
  designFlowCms,
  residualCms,
}: {
  fdc: FdcPoint[];
  designFlowCms?: number;
  residualCms?: number;
}) {
  // Thin to ~180 points for the chart — the shape, not every day.
  const step = Math.max(1, Math.floor(fdc.length / 180));
  const data = fdc.filter((_, i) => i % step === 0).map((p) => [p.p * 100, p.q]);

  const markLines: object[] = [];
  if (designFlowCms !== undefined) {
    markLines.push({
      yAxis: designFlowCms,
      label: { formatter: 'design', color: GREEN, fontSize: 9, position: 'insideEndTop' },
      lineStyle: { color: GREEN, type: 'dashed', width: 1 },
    });
  }
  if (residualCms !== undefined) {
    markLines.push({
      yAxis: residualCms,
      label: { formatter: 'residual', color: AMBER, fontSize: 9, position: 'insideEndTop' },
      lineStyle: { color: AMBER, type: 'dashed', width: 1 },
    });
  }

  const option: Option = {
    animation: false,
    grid: { left: 44, right: 12, top: 12, bottom: 26 },
    tooltip: {
      ...baseTooltip,
      trigger: 'axis',
      valueFormatter: (v: unknown) => `${Number(v).toFixed(1)} m³/s`,
    },
    xAxis: {
      type: 'value',
      min: 0,
      max: 100,
      name: '% of time exceeded',
      nameLocation: 'middle',
      nameGap: 18,
      nameTextStyle: { color: FAINT, fontSize: 10 },
      ...baseAxis,
    },
    yAxis: { type: 'log', name: 'm³/s', nameTextStyle: { color: FAINT, fontSize: 10 }, ...baseAxis },
    series: [
      {
        type: 'line',
        data,
        showSymbol: false,
        lineStyle: { color: RIVER, width: 2 },
        areaStyle: { color: 'rgba(77,184,255,0.10)' },
        markLine: {
          symbol: 'none',
          silent: true,
          data: markLines,
        },
      },
    ],
  };
  return <EChart option={option} height={190} />;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Monthly means, colored by NEA PPA season (wet mid-Apr → mid-Dec). */
export function MonthlyChart({ monthlyMeans }: { monthlyMeans: number[] }) {
  const option: Option = {
    animation: false,
    grid: { left: 44, right: 12, top: 12, bottom: 22 },
    tooltip: {
      ...baseTooltip,
      trigger: 'axis',
      valueFormatter: (v: unknown) => `${Number(v).toFixed(1)} m³/s`,
    },
    xAxis: { type: 'category', data: MONTHS, ...baseAxis, splitLine: { show: false } },
    yAxis: { type: 'value', name: 'm³/s', nameTextStyle: { color: FAINT, fontSize: 10 }, ...baseAxis },
    series: [
      {
        type: 'bar',
        data: monthlyMeans.map((v, m) => ({
          value: Number.isFinite(v) ? Number(v.toFixed(2)) : 0,
          // Wet season ≈ mid-Apr..mid-Dec: Apr and Dec are boundary months.
          itemStyle: {
            color: m >= 4 && m <= 10 ? RIVER : m === 3 || m === 11 ? '#3a6f96' : AMBER,
            borderRadius: [2, 2, 0, 0],
          },
        })),
        barWidth: '62%',
      },
    ],
  };
  return <EChart option={option} height={150} />;
}

const FAMILY_COLOR: Record<Scheme['family'], string> = {
  canal: GREEN,
  tunnel: PURPLE,
  'high-head': RED,
};

/** Energy vs CAPEX — the seed of the Pareto view. */
export function ParetoChart({
  schemes,
  selectedId,
  onSelect,
}: {
  schemes: Scheme[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const option: Option = {
    animation: false,
    grid: { left: 48, right: 16, top: 14, bottom: 34 },
    tooltip: {
      ...baseTooltip,
      formatter: (p: unknown) => {
        const item = p as { data: { scheme: Scheme } };
        const s = item.data.scheme;
        return `<b>${s.name}</b><br/>${s.energyGwh.value.toFixed(1)} GWh/yr · ${s.capexMnNpr.value.toFixed(0)} Mn NPR<br/>${s.capacityMW.value.toFixed(1)} MW · PF ${(s.plantFactor.value * 100).toFixed(0)}%`;
      },
    },
    xAxis: {
      type: 'value',
      name: 'CAPEX, Mn NPR (assumed)',
      nameLocation: 'middle',
      nameGap: 20,
      nameTextStyle: { color: FAINT, fontSize: 10 },
      scale: true,
      ...baseAxis,
    },
    yAxis: {
      type: 'value',
      name: 'GWh/yr',
      nameTextStyle: { color: FAINT, fontSize: 10 },
      scale: true,
      ...baseAxis,
    },
    series: [
      {
        type: 'scatter',
        data: schemes.map((s) => ({
          value: [s.capexMnNpr.value, s.energyGwh.value],
          scheme: s,
          itemStyle: {
            color: FAMILY_COLOR[s.family],
            borderColor: s.id === selectedId ? INK : 'transparent',
            borderWidth: 2,
          },
          symbolSize: 10 + s.plantFactor.value * 22,
          label: {
            show: true,
            position: 'top',
            distance: 6,
            color: MUTED,
            fontSize: 10,
            formatter: s.id,
          },
        })),
      },
    ],
  };
  return (
    <div
      onClick={() => {
        /* per-point click handled below via chart events is overkill for 3 points —
           cycle selection on container click keeps it simple until real Pareto sets land */
      }}
    >
      <EChart option={option} height={210} />
      <div className="mt-1 flex flex-wrap gap-1.5">
        {schemes.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(s.id)}
            className={`rounded border px-2 py-0.5 text-[11px] ${
              s.id === selectedId
                ? 'border-river text-river'
                : 'border-line text-muted hover:border-line-strong'
            }`}
          >
            <span
              className="mr-1 inline-block size-2 rounded-full align-middle"
              style={{ background: FAMILY_COLOR[s.family] }}
            />
            {s.id} {s.familyLabel}
          </button>
        ))}
      </div>
    </div>
  );
}
