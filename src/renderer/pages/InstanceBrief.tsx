import { Activity, ArrowUpRight, CalendarClock, Globe2 } from "lucide-react";
import type { Bootstrap } from "../../shared/types";
import type { RouteRow } from "../analysis";
import { date, useApp } from "../store";
import { instanceBrief, taskTargets } from "../workbench";

export default function InstanceBrief({
  id,
  data,
  routes,
  routeState,
}: {
  id: string;
  data: Bootstrap;
  routes: RouteRow[];
  routeState: "pending" | "error" | "ready";
}) {
  const navigate = useApp((s) => s.navigate);
  const { active, issues, attention, next } = instanceBrief(
    id,
    data.jobs,
    data.schedules,
    routes,
  );
  return (
    <section className="instance-brief" aria-label="当前实例值班摘要">
      <button
        data-attention={issues > 0}
        onClick={() =>
          navigate(
            "tasks",
            active
              ? taskTargets.active
              : issues
                ? taskTargets.issues
                : taskTargets.history,
          )
        }
      >
        <Activity size={18} />
        <span>
          <small>实例任务</small>
          <strong>
            {active
              ? active + " 项执行中"
              : issues
                ? issues + " 项失败或中断"
                : "无待处理任务"}
          </strong>
        </span>
        <ArrowUpRight size={14} />
      </button>
      <button
        data-attention={
          routeState === "error" || (routeState === "ready" && attention > 0)
        }
        onClick={() =>
          navigate(
            "network",
            routeState === "ready" && attention
              ? "network-attention"
              : routes.length
                ? "network-routes"
                : undefined,
          )
        }
      >
        <Globe2 size={18} />
        <span>
          <small>线路检查</small>
          <strong>
            {routeState === "error"
              ? "状态未确认"
              : routeState === "pending"
                ? "读取中…"
                : attention
                  ? attention + " 条需检查"
                  : routes.length
                    ? routes.length + " 条已登记"
                    : "暂无玩家入口"}
          </strong>
        </span>
        <ArrowUpRight size={14} />
      </button>
      <button
        title={next ? next.name + " · " + date(next.nextAt) : undefined}
        onClick={() =>
          navigate("schedules", next ? "plan-" + next.id : undefined)
        }
      >
        <CalendarClock size={18} />
        <span>
          <small>下次计划{next && " · " + date(next.nextAt)}</small>
          <strong>{next?.name || "暂无待执行计划"}</strong>
        </span>
        <ArrowUpRight size={14} />
      </button>
    </section>
  );
}
