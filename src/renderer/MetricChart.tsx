import { useEffect, useRef, useState } from "react";
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { useMotionPreference } from "./use-motion-preference";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import {
  DataZoomComponent,
  GridComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useApp, time } from "./store";
import type { Metric } from "../shared/types";
import { metricChartPoints } from "./analysis";
import { IconButton } from "./components";
echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  DataZoomComponent,
  CanvasRenderer,
]);

export default function MetricChart({
  metrics,
  kind = "cpu",
  height = 210,
  interactive = false,
}: {
  metrics: Metric[];
  kind?: "cpu" | "memory" | "tps" | "players";
  height?: number;
  interactive?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const instance = useRef<ReturnType<typeof echarts.init> | null>(null);
  const theme = useApp((s) => s.data?.settings.theme);
  const reduced = useMotionPreference();
  const minSpan = 5;
  const [visiblePercent, setVisiblePercent] = useState(100);
  function range() {
    const options = instance.current?.getOption()?.dataZoom as
      { start?: number; end?: number }[] | undefined;
    return [options?.[0]?.start ?? 0, options?.[0]?.end ?? 100] as const;
  }
  function zoom(factor: number | "reset") {
    const [start, end] = range();
    const span =
      factor === "reset"
        ? 100
        : Math.max(minSpan, Math.min(100, (end - start) * factor));
    const left = Math.max(0, Math.min(100 - span, (start + end - span) / 2));
    instance.current?.dispatchAction({
      type: "dataZoom",
      dataZoomIndex: 0,
      start: left,
      end: left + span,
    });
  }
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    instance.current = chart;
    chart.on("datazoom", () => {
      const [start, end] = range();
      setVisiblePercent(Math.round(end - start));
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.dispose();
      instance.current = null;
    };
  }, []);
  useEffect(() => {
    const chart = instance.current;
    if (!chart) return;
    const tokens = getComputedStyle(document.documentElement);
    const color = tokens
      .getPropertyValue(
        {
          cpu: "--green",
          memory: "--purple",
          tps: "--blue",
          players: "--amber",
        }[kind],
      )
      .trim();
    const muted = tokens.getPropertyValue("--dim").trim();
    const line = tokens.getPropertyValue("--line").trim();
    const span = (metrics.at(-1)?.at || 0) - (metrics[0]?.at || 0);
    const points = metricChartPoints(metrics, kind);
    chart.setOption({
      animation: !reduced,
      animationDuration: 280,
      animationDurationUpdate: 220,
      grid: { top: 18, left: 48, right: 18, bottom: interactive ? 60 : 27 },
      dataZoom: interactive
        ? [
            {
              type: "inside",
              filterMode: "none",
              minSpan,
              zoomOnMouseWheel: "ctrl",
              moveOnMouseMove: false,
            },
            {
              type: "slider",
              minSpan,
              bottom: 5,
              height: 18,
              borderColor: "transparent",
              textStyle: { color: muted, fontSize: 10 },
              brushSelect: false,
            },
          ]
        : [],
      tooltip: {
        trigger: "axis",
        backgroundColor: theme === "light" ? "#fff" : "#152128",
        borderColor: line,
        textStyle: { color: theme === "light" ? "#1d353b" : "#e4eeed" },
        valueFormatter: (v: number) =>
          typeof v === "number"
            ? v.toFixed(kind === "players" ? 0 : kind === "tps" ? 2 : 1) +
              (kind === "cpu" ? "%" : kind === "memory" ? " MB" : "")
            : "未采集",
      },
      xAxis: {
        type: "time",
        axisLine: { lineStyle: { color: line } },
        axisTick: { show: false },
        axisLabel: {
          color: muted,
          fontSize: 10,
          hideOverlap: true,
          formatter: (value: number) =>
            span >= 86400000
              ? new Date(value).toLocaleString("zh-CN", {
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })
              : time(value).slice(0, 5),
        },
        splitNumber: span >= 86400000 ? 3 : 5,
      },
      yAxis: {
        type: "value",
        min: 0,
        minInterval: kind === "players" ? 1 : undefined,
        name: kind === "memory" ? "MB" : kind === "players" ? "人" : "",
        nameTextStyle: { color: muted, fontSize: 10 },
        max: kind === "tps" ? 20 : kind === "cpu" ? 100 : undefined,
        splitLine: { lineStyle: { color: line + "66", type: "dashed" } },
        axisLabel: {
          color: muted,
          fontSize: 10,
          formatter: (v: number) => (kind === "cpu" ? `${v}%` : v),
        },
        axisLine: { show: false },
      },
      series: [
        {
          type: "line",
          showSymbol: true,
          symbol: "circle",
          symbolSize: 3,
          smooth: 0.2,
          connectNulls: false,
          lineStyle: { color, width: 2 },
          itemStyle: { color },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: color + "24" },
              { offset: 1, color: color + "00" },
            ]),
          },
          data: points,
        },
      ],
    });
  }, [metrics, kind, theme, reduced, interactive]);
  return (
    <>
      {interactive && metrics.length > 1 && (
        <div className="chart-zoom" role="group" aria-label="图表时间缩放">
          <span>
            可见范围 <output>{visiblePercent}%</output>
          </span>
          <IconButton
            label="放大图表时间轴"
            disabled={visiblePercent <= minSpan}
            onClick={() => zoom(0.5)}
          >
            <ZoomIn size={14} />
          </IconButton>
          <IconButton
            label="缩小图表时间轴"
            disabled={visiblePercent >= 100}
            onClick={() => zoom(2)}
          >
            <ZoomOut size={14} />
          </IconButton>
          <IconButton
            label="还原完整时间轴"
            disabled={visiblePercent >= 100}
            onClick={() => zoom("reset")}
          >
            <RotateCcw size={14} />
          </IconButton>
        </div>
      )}
      <div
        className="chart"
        role="img"
        aria-label={`${{ cpu: "CPU 使用率", memory: "内存工作集", tps: "TPS", players: "在线人数" }[kind]}趋势图，共 ${metrics.length} 个时间点${interactive ? "，可拖动底部时间范围缩放" : ""}`}
        ref={ref}
        style={{ height }}
      />
    </>
  );
}
