import {
  Activity,
  BarChart3,
  Archive,
  Blocks,
  Box,
  FileCode2,
  FolderOpen,
  Globe2,
  LayoutDashboard,
  Server,
  Settings2,
  Terminal,
  Timer,
  Users,
  Wrench,
} from "lucide-react";

export type Page =
  | "overview"
  | "analysis"
  | "console"
  | "players"
  | "worlds"
  | "packs"
  | "files"
  | "config"
  | "backups"
  | "network"
  | "schedules"
  | "instances"
  | "tools"
  | "tasks"
  | "settings";
export const groups = ["服务器运行", "内容与配置", "连接与维护", "工作空间"];
export const navigation: {
  page: Page;
  label: string;
  icon: typeof Box;
  group: number;
  keywords: string;
}[] = [
  {
    page: "overview",
    label: "服务器总览",
    icon: LayoutDashboard,
    group: 0,
    keywords: "首页 性能 状态 核心 更新",
  },
  {
    page: "analysis",
    label: "运行分析",
    icon: BarChart3,
    group: 0,
    keywords: "性能 趋势 分析 峰值 P95 日志 异常 统计 报告",
  },
  {
    page: "console",
    label: "实时控制台",
    icon: Terminal,
    group: 0,
    keywords: "日志 命令 公告",
  },
  {
    page: "players",
    label: "玩家与权限",
    icon: Users,
    group: 0,
    keywords: "在线 历史 管理员 允许名单",
  },
  {
    page: "worlds",
    label: "世界管理",
    icon: Box,
    group: 1,
    keywords: "地图 导入 导出 切换",
  },
  {
    page: "packs",
    label: "模组与插件",
    icon: Blocks,
    group: 1,
    keywords: "行为包 资源包 Endstone 依赖",
  },
  {
    page: "files",
    label: "文件管理",
    icon: FolderOpen,
    group: 1,
    keywords: "目录 编辑 文本",
  },
  {
    page: "network",
    label: "网络线路",
    icon: Globe2,
    group: 2,
    keywords: "穿透 隧道 质量 检测 信令 转接",
  },
  {
    page: "backups",
    label: "备份与恢复",
    icon: Archive,
    group: 2,
    keywords: "快照 校验 恢复 清单",
  },
  {
    page: "schedules",
    label: "自动化计划",
    icon: Timer,
    group: 2,
    keywords: "定时 重启 cron 计划任务",
  },
  {
    page: "config",
    label: "服务器配置",
    icon: FileCode2,
    group: 1,
    keywords: "表单 原文 server.properties",
  },
  {
    page: "instances",
    label: "实例管理",
    icon: Server,
    group: 3,
    keywords: "新建 关联 路径 环境 重命名",
  },
  {
    page: "tools",
    label: "工具与环境",
    icon: Wrench,
    group: 3,
    keywords: "客户端 下载 更新 Python",
  },
  {
    page: "tasks",
    label: "任务与记录",
    icon: Activity,
    group: 3,
    keywords: "进度 结果 失败 操作 历史",
  },
  {
    page: "settings",
    label: "应用设置",
    icon: Settings2,
    group: 3,
    keywords: "主题 动画 通知 后台 存储 关于",
  },
];
export const pageInfo = (page: Page) =>
  navigation.find((n) => n.page === page)!;
export const isGlobal = (page: Page) => pageInfo(page)?.group === 3;
export function readPreference<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}
