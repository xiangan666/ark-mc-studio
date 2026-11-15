import React, { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronRight,
  ChevronDown,
  FolderOpen,
  LoaderCircle,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { useApp, message, statusLabel } from "./store";
import type { Metric } from "../shared/types";

export function Button({
  children,
  variant = "default",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "danger" | "ghost" | "purple";
}) {
  return (
    <button
      type="button"
      {...props}
      className={`button ${variant} ${className}`}
    >
      {children}
    </button>
  );
}
export function IconButton({
  label,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          {...props}
          aria-label={label}
          className={`icon-button ${props.className || ""}`}
        >
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" sideOffset={7}>
          {label}
          <Tooltip.Arrow />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Status({ status }: { status: string }) {
  return (
    <Badge
      tone={
        status === "running" || status === "success"
          ? "green"
          : status === "failed" || status === "interrupted"
            ? "red"
            : status === "starting" ||
                status === "queued" ||
                status === "stopping"
              ? "amber"
              : "neutral"
      }
    >
      <span className={`status-dot ${status === "running" ? "pulse" : ""}`} />
      {statusLabel[status] || status}
    </Badge>
  );
}
export function Panel({
  id,
  children,
  className = "",
  title,
  aside,
  subtitle,
}: {
  id?: string;
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  aside?: ReactNode;
  subtitle?: string;
}) {
  return (
    <section id={id} className={`panel ${className}`}>
      {title && (
        <div className="panel-heading">
          <div>
            <h3>{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}
export function Heading({
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      <div className="heading-actions">{actions}</div>
    </header>
  );
}
export function PageTabs<T extends string>({
  id,
  label,
  value,
  onChange,
  items,
}: {
  id: string;
  label: string;
  value: T;
  onChange: (value: T) => void;
  items: { value: T; label: string; count?: number }[];
}) {
  return (
    <nav className="page-tabs" aria-label={label} role="tablist">
      {items.map((item, index) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          id={`${id}-tab-${item.value}`}
          aria-controls={`${id}-panel-${item.value}`}
          aria-selected={value === item.value}
          tabIndex={value === item.value ? 0 : -1}
          className={value === item.value ? "active" : ""}
          onClick={() => onChange(item.value)}
          onKeyDown={(event) => {
            const delta =
              event.key === "ArrowRight"
                ? 1
                : event.key === "ArrowLeft"
                  ? -1
                  : 0;
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : delta
                    ? (index + delta + items.length) % items.length
                    : -1;
            if (next >= 0) {
              event.preventDefault();
              onChange(items[next].value);
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>('button[role="tab"]')
                [next]?.focus();
            }
          }}
        >
          {item.label}
          {item.count !== undefined && (
            <span className="tab-count">{item.count}</span>
          )}
        </button>
      ))}
    </nav>
  );
}
export function Empty({
  icon: Icon = FolderOpen,
  title = "这里还没有内容",
  description,
  action,
}: {
  icon?: React.ElementType;
  title?: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={27} />
      </div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: string;
}) {
  const Icon =
    tone === "warn"
      ? TriangleAlert
      : tone === "success"
        ? CheckCircle2
        : AlertCircle;
  return (
    <div className={`notice ${tone}`}>
      <Icon size={17} />
      <div>{children}</div>
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading">
      <LoaderCircle className="spin" size={22} />
      <span>正在读取真实数据…</span>
    </div>
  );
}
export function Field({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  const inputId = React.useId();
  const descriptionId = hint ? `${inputId}-hint` : undefined;
  let control = children;
  let labelledControl = false;
  if (React.isValidElement(children)) {
    if (
      typeof children.type === "string" &&
      ["input", "select", "textarea"].includes(children.type)
    ) {
      control = React.cloneElement(children as React.ReactElement<any>, {
        id: inputId,
        "aria-describedby": descriptionId,
      });
      labelledControl = true;
    } else if (children.type === PathInput) {
      control = React.cloneElement(children as React.ReactElement<any>, {
        inputId,
        descriptionId,
      });
      labelledControl = true;
    }
  }
  return (
    <div
      className={`field ${className}`}
      role={labelledControl ? undefined : "group"}
      aria-label={labelledControl ? undefined : label}
    >
      <label htmlFor={inputId}>{label}</label>
      {control}
      {hint && <small id={descriptionId}>{hint}</small>}
    </div>
  );
}
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <div className="toggle-row">
      <div>
        <strong>{label}</strong>
        {description && <p>{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`toggle ${checked ? "on" : ""}`}
      >
        <span />
      </button>
    </div>
  );
}
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  wide = false,
  presentation = "dialog",
  onCloseAutoFocus,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
  presentation?: "dialog" | "drawer";
  onCloseAutoFocus?: React.ComponentProps<
    typeof Dialog.Content
  >["onCloseAutoFocus"];
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className={`modal ${wide ? "wide" : ""} ${presentation === "drawer" ? "drawer" : ""}`}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <div className="modal-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description>
                {description || "方舟 MC · ArkMC Studio"}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button className="icon-button" aria-label="关闭对话框">
                <X size={19} />
              </button>
            </Dialog.Close>
          </div>
          <div className="modal-content">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Drawer(
  props: Omit<React.ComponentProps<typeof Modal>, "presentation">,
) {
  return <Modal {...props} presentation="drawer" />;
}
export function Disclosure({
  title,
  children,
  open: initial = false,
}: {
  title: string;
  children: ReactNode;
  open?: boolean;
}) {
  const [open, setOpen] = useState(initial);
  const reduced = useReducedMotion();
  const preference = useApp((s) => s.data?.settings.reducedMotion);
  return (
    <div className={`disclosure ${open ? "is-open" : ""}`}>
      <button
        className="disclosure-trigger"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {title}
        <ChevronDown size={15} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reduced || preference ? 0 : 0.26 }}
            className="disclosure-content"
          >
            <div>{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
export function Steps({
  items,
  current,
}: {
  items: string[];
  current: number;
}) {
  return (
    <ol className="flow-steps" aria-label="操作步骤">
      {items.map((item, i) => (
        <li
          key={item}
          className={i < current ? "done" : i === current ? "current" : ""}
          aria-current={i === current ? "step" : undefined}
        >
          <span>{i < current ? <Check size={12} /> : i + 1}</span>
          {item}
        </li>
      ))}
    </ol>
  );
}
export function useUnsavedChanges(changed: boolean, label: string) {
  useEffect(() => {
    useApp.setState({ dirty: changed ? label : "" });
  }, [changed, label]);
  useEffect(
    () => () => {
      useApp.setState({ dirty: "" });
    },
    [],
  );
}
export function Confirm({
  open,
  onClose,
  onConfirm,
  title,
  description,
  danger = false,
  label = "确认操作",
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description: string;
  danger?: boolean;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
    >
      <Notice tone={danger ? "warn" : "info"}>{description}</Notice>
      <div className="modal-actions">
        <Button onClick={onClose}>取消</Button>
        <Button
          variant={danger ? "danger" : "primary"}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
              onClose();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <LoaderCircle size={16} className="spin" /> : null}
          {label}
        </Button>
      </div>
    </Modal>
  );
}
export function PathInput({
  value,
  onChange,
  file = false,
  extensions = ["zip"],
  placeholder,
  inputId,
  descriptionId,
}: {
  value: string;
  onChange: (value: string) => void;
  file?: boolean;
  extensions?: string[];
  placeholder?: string;
  inputId?: string;
  descriptionId?: string;
}) {
  return (
    <div className="input-with-button">
      <input
        id={inputId}
        aria-describedby={descriptionId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
      <Button
        onClick={async () => {
          const result = file
            ? await window.ark.chooseFile([{ name: "支持的文件", extensions }])
            : await window.ark.chooseDirectory();
          if (result) onChange(result);
        }}
      >
        <FolderOpen size={16} />
        浏览
      </Button>
    </div>
  );
}
export function useQuery<T>(
  method: string,
  args: Record<string, unknown>,
  interval = 0,
) {
  const identity = `${method}:${JSON.stringify(args)}`;
  const [state, setState] = useState<{
    identity: string;
    data: T | null;
    error: string;
    pending: boolean;
    updatedAt: number;
  }>({ identity, data: null, error: "", pending: true, updatedAt: 0 });
  const [key, setKey] = useState(0);
  const revision = useApp((s) => s.revision);
  const encoded = JSON.stringify(args);
  useEffect(() => {
    let alive = true;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      setState((old) =>
        old.identity === identity
          ? { ...old, pending: true }
          : { identity, data: null, error: "", pending: true, updatedAt: 0 },
      );
      try {
        const value = await window.ark.call<T>(method, JSON.parse(encoded));
        if (alive) {
          setState({
            identity,
            data: value,
            error: "",
            pending: false,
            updatedAt: Date.now(),
          });
        }
      } catch (error) {
        if (alive)
          setState((old) => ({
            ...old,
            identity,
            error: message(error),
            pending: false,
          }));
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = interval
      ? setInterval(() => {
          if (!document.hidden) void load();
        }, interval)
      : undefined;
    const visible = () => {
      if (!document.hidden && interval) void load();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [method, encoded, identity, key, revision, interval]);
  const current = state.identity === identity;
  const setData = React.useCallback(
    (data: React.SetStateAction<T | null>) =>
      setState((old) => ({
        identity,
        data:
          typeof data === "function"
            ? (data as (value: T | null) => T | null)(
                old.identity === identity ? old.data : null,
              )
            : data,
        error: "",
        pending: false,
        updatedAt: Date.now(),
      })),
    [identity],
  );
  return {
    data: current ? state.data : null,
    error: current ? state.error : "",
    loading: !current || (state.pending && state.data === null),
    refreshing: !current || state.pending,
    updatedAt: current ? state.updatedAt : 0,
    reload: () => setKey((k) => k + 1),
    setData,
  };
}
export function QueryError({
  error,
  retry,
}: {
  error: string;
  retry: () => void;
}) {
  return (
    <Notice tone="warn">
      <span>{error}</span>
      <Button variant="ghost" onClick={retry}>
        重试
        <ChevronRight size={14} />
      </Button>
    </Notice>
  );
}
export function SearchInput({
  value,
  onChange,
  placeholder = "搜索…",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="search-input">
      <Search size={16} />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
      {value && (
        <button aria-label="清空搜索" onClick={() => onChange("")}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}
const DeferredChart = React.lazy(() => import("./MetricChart"));
export function Chart(props: {
  metrics: Metric[];
  kind?: "cpu" | "memory" | "tps" | "players";
  height?: number;
  interactive?: boolean;
}) {
  return (
    <React.Suspense
      fallback={
        <div
          className="chart chart-loading"
          style={{ height: props.height || 210 }}
          role="status"
        >
          正在加载图表…
        </div>
      }
    >
      <DeferredChart {...props} />
    </React.Suspense>
  );
}
export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === "error" ? (
            <AlertCircle size={18} />
          ) : t.kind === "success" ? (
            <CheckCircle2 size={18} />
          ) : (
            <Check size={18} />
          )}
          <span>{t.text}</span>
          <button
            aria-label="关闭通知"
            onClick={() =>
              useApp.setState((s) => ({
                toasts: s.toasts.filter((item) => item.id !== t.id),
              }))
            }
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
export function VoxelScene({ compact = false }: { compact?: boolean }) {
  const blocks: ReactNode[] = [];
  const heights = (x: number, z: number) =>
    Math.max(
      0,
      Math.round(
        3 +
          2.6 * Math.sin(x * 0.64 + z * 0.43) +
          1.5 * Math.cos(z * 0.83 - x * 0.2),
      ),
    );
  for (let z = 0; z < 12; z++)
    for (let x = 0; x < 15; x++) {
      const h = heights(x, z);
      const px = 330 + (x - z) * 23;
      const py = 75 + (x + z) * 11.5 - h * 14;
      const top = h > 5 ? "#619e81" : h > 3 ? "#4c8d70" : "#32705e";
      blocks.push(
        <g key={`${x}-${z}`}>
          <path d={`M${px} ${py}l23 11.5-23 11.5-23-11.5Z`} fill={top} />
          <path
            d={`M${px - 23} ${py + 11.5}l23 11.5v${18 + h * 3}l-23-11.5Z`}
            fill={h > 4 ? "#234a43" : "#193d38"}
          />
          <path
            d={`M${px} ${py + 23}l23-11.5v${18 + h * 3}l-23 11.5Z`}
            fill={h > 4 ? "#305d4c" : "#234e44"}
          />
          <path
            d={`M${px} ${py}l23 11.5-23 11.5-23-11.5Z`}
            fill="none"
            stroke="#b9ffd6"
            strokeOpacity=".08"
          />
        </g>,
      );
    }
  return (
    <svg
      className={`voxel-scene ${compact ? "compact" : ""}`}
      viewBox="0 0 720 410"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="world-glow">
          <stop stopColor="#5beaa1" stopOpacity=".25" />
          <stop offset="1" stopColor="#5beaa1" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="360" cy="225" rx="340" ry="170" fill="url(#world-glow)" />
      <g transform="translate(0,-8)">
        {blocks}
        <g transform="translate(400,84)">
          <path d="m-10 30 10-6 10 6v45l-10 6-10-6Z" fill="#564c40" />
          <path d="m0-15 46 24v36L0 69-46 45V9Z" fill="#285a47" />
          <path d="m0-15 46 24L0 33-46 9Z" fill="#87bd86" />
          <path d="M0 33 46 9v36L0 69Z" fill="#3f7d5b" />
          <path d="m-24-34 48 0 22 17L0 8-46-17Z" fill="#67a77c" />
        </g>
        <g transform="translate(258,131)">
          <path d="m-7 15 7-4 7 4v30l-7 4-7-4Z" fill="#4f493e" />
          <path d="m0-30 33 17v27L0 31-33 14v-27Z" fill="#397350" />
          <path d="m0-30 33 17L0 4-33-13Z" fill="#a1c89b" />
        </g>
        <g transform="translate(340,67)">
          <path d="m0 0 35 18-35 18-35-18Z" fill="#a596d5" />
          <path d="M-35 18 0 36v29l-35-18Z" fill="#5b547e" />
          <path d="m0 36 35-18v29L0 65Z" fill="#787099" />
          <path d="m-16 17 16-8 16 8-16 8Z" fill="#d7caff" opacity=".8" />
        </g>
      </g>
      <g className="world-sparks" fill="#9bf4ba">
        <rect x="570" y="85" width="4" height="4" />
        <rect x="210" y="98" width="3" height="3" />
        <rect x="500" y="45" width="3" height="3" />
        <rect x="595" y="200" width="3" height="3" />
      </g>
    </svg>
  );
}

export function tabPanelProps(id: string, value: string) {
  return {
    id: `${id}-panel-${value}`,
    role: "tabpanel",
    "aria-labelledby": `${id}-tab-${value}`,
    tabIndex: 0,
  };
}
