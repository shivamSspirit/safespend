"use client";

import {
  Activity,
  BadgeCheck,
  Bell,
  Building2,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  ExternalLink,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  Menu,
  Moon,
  PanelLeftClose,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  TerminalSquare,
  Users,
  WifiOff,
  X,
  XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApiErrorBody,
  LivePayment,
  LiveVendor,
  SafeSpendBootstrap,
} from "@/lib/safespend-types";

type View = "overview" | "payments" | "vendors" | "activity" | "settings";
type Connection = { gatewayOnline: boolean; paired: boolean; gatewayPaired: boolean };

const navItems: { id: View; label: string; icon: LucideIcon }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "payments", label: "Payments", icon: Send },
  { id: "vendors", label: "Vendors", icon: Users },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "settings", label: "Policies", icon: SlidersHorizontal },
];

function short(value: string, left = 6, right = 6) {
  return value ? `${value.slice(0, left)}…${value.slice(-right)}` : "—";
}
function decimal(baseUnits: string, decimals: number, maximum = 4) {
  const negative = baseUnits.startsWith("-");
  const digits = negative ? baseUnits.slice(1) : baseUnits;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = decimals ? padded.slice(0, -decimals) : padded;
  const fraction = decimals ? padded.slice(-decimals).replace(/0+$/, "").slice(0, maximum) : "";
  return `${negative ? "-" : ""}${BigInt(whole).toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}
function sol(lamports: string) {
  return (Number(lamports) / 1_000_000_000).toLocaleString("en-US", { maximumFractionDigits: 4 });
}
function runway(milliweeks: string) {
  return (Number(milliweeks) / 1000).toFixed(1);
}
function cadence(seconds: number) {
  const days = Math.round(seconds / 86_400);
  return days === 7 ? "Weekly" : days === 30 ? "Monthly" : `Every ${days} days`;
}

function allowanceLabel(status: LiveVendor["allowance"]["status"]) {
  if (status === "available") return "Available";
  if (status === "spent") return "Paid this period";
  if (status === "not_started") return "Not started";
  if (status === "expiring") return "Expires too soon";
  if (status === "expired") return "Expired";
  return "Invalid";
}

function allowanceTime(value: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.method && init.method !== "GET") {
    headers.set("Content-Type", "application/json");
    headers.set("x-safespend-action", "founder-dashboard");
  }
  const response = await fetch(url, { ...init, headers, cache: "no-store" });
  const body = (await response.json()) as T | ApiErrorBody;
  if (!response.ok) throw new Error((body as ApiErrorBody).error || "SafeSpend request failed.");
  return body as T;
}

export function FounderDashboard() {
  const [view, setView] = useState<View>("overview");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [dark, setDark] = useState(false);
  const [browserOnline, setBrowserOnline] = useState(true);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [data, setData] = useState<SafeSpendBootstrap | null>(null);
  const connectionRef = useRef<Connection | null>(null);
  const dataRef = useRef<SafeSpendBootstrap | null>(null);
  const [error, setError] = useState("");
  const [syncWarning, setSyncWarning] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState("");

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      let state = connectionRef.current;
      if (!quiet || !state?.gatewayOnline || !state.paired) {
        state = await jsonRequest<Connection>("/api/safespend/connection");
        connectionRef.current = state;
        setConnection(state);
      }
      if (state.gatewayOnline && state.paired) {
        const next = await jsonRequest<SafeSpendBootstrap>("/api/safespend/bootstrap");
        dataRef.current = next;
        setData(next);
        setError("");
        setSyncWarning("");
      } else {
        dataRef.current = null;
        setData(null);
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Unable to load SafeSpend.";
      if (dataRef.current) setSyncWarning(message);
      else setError(message);
    } finally {
      if (!quiet) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem("safespend-theme");
    setDark(saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches);
    setBrowserOnline(window.navigator.onLine);
    const on = () => setBrowserOnline(true);
    const off = () => setBrowserOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    void refresh();
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [refresh]);

  useEffect(() => {
    if (!connection?.paired) return;
    const active = Boolean(
      data?.pendingRuns.length ||
      data?.payments.some((payment) => !["finalized", "denied", "failed"].includes(payment.status)),
    );
    const timer = window.setInterval(
      () => {
        if (document.visibilityState === "visible") void refresh(true);
      },
      active ? 5_000 : 15_000,
    );
    return () => window.clearInterval(timer);
  }, [connection?.paired, data?.payments, data?.pendingRuns.length, refresh]);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    window.localStorage.setItem("safespend-theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const currentNav = navItems.find((item) => item.id === view) ?? navItems[0];
  const attentionCount =
    (data?.pendingRuns.length ?? 0) +
    (data?.payments.filter((p) =>
      ["checkpoint", "awaiting_telegram", "submitted"].includes(p.status),
    ).length ?? 0);

  return (
    <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      {(!browserOnline || connection?.gatewayOnline === false) && (
        <div className="offline-banner" role="status">
          <WifiOff size={15} />
          {!browserOnline ? "Browser offline" : "ZeroClaw gateway offline — start the daemon"}
        </div>
      )}
      <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`} aria-label="Primary navigation">
        <div className="brand-lockup">
          <div className="brand-mark">
            <ShieldCheck size={19} />
          </div>
          <div className="brand-copy">
            <strong>SafeSpend</strong>
            <span>Devnet treasury</span>
          </div>
          <button
            className="icon-button sidebar-close"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close navigation"
          >
            <X size={19} />
          </button>
        </div>
        <nav className="side-nav">
          <span className="nav-eyebrow">Workspace</span>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={view === item.id ? "active" : ""}
                key={item.id}
                onClick={() => {
                  setView(item.id);
                  setSidebarOpen(false);
                }}
                aria-current={view === item.id ? "page" : undefined}
              >
                <Icon size={18} />
                <span>{item.label}</span>
                {item.id === "payments" && attentionCount > 0 && <em>{attentionCount}</em>}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-boundary">
          <span>Runtime boundary</span>
          <strong>T2 · Devnet only</strong>
          <small>Bounded signer in the local daemon</small>
        </div>
      </aside>
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close navigation"
        />
      )}
      <div className="content-shell">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-button mobile-menu"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open navigation"
            >
              <Menu size={20} />
            </button>
            <button
              className="icon-button desktop-collapse"
              onClick={() => setCollapsed((v) => !v)}
              aria-label="Toggle sidebar"
            >
              <PanelLeftClose size={19} className={collapsed ? "flipped" : ""} />
            </button>
            <div className="breadcrumb">
              <span>Workspace</span>
              <ChevronRight size={14} />
              <strong>{currentNav.label}</strong>
            </div>
          </div>
          <div className="topbar-actions">
            <div className="network-pill">
              <span /> Devnet
            </div>
            <button
              className="icon-button"
              onClick={() => setDark((v) => !v)}
              aria-label="Toggle theme"
            >
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button className="icon-button" aria-label="Refresh" onClick={() => void refresh()}>
              <RefreshCw size={18} className={refreshing ? "spin" : ""} />
            </button>
          </div>
        </header>
        <main id="main-content" className="main-content">
          {syncWarning && data && (
            <div className="sync-warning" role="status">
              <WifiOff size={17} />
              <div>
                <strong>Live refresh delayed</strong>
                <span>
                  Showing verified state from {new Date(data.generatedAt).toLocaleTimeString()}.{" "}
                  {syncWarning}
                </span>
              </div>
              <button className="button secondary" onClick={() => void refresh()}>
                Retry
              </button>
            </div>
          )}
          {!connection ? (
            <DashboardSkeleton />
          ) : !connection.gatewayOnline ? (
            <SetupState kind="offline" onDone={() => void refresh()} />
          ) : !connection.paired ? (
            <SetupState kind="pair" onDone={() => void refresh()} />
          ) : error ? (
            <ErrorState error={error} onRetry={() => void refresh()} />
          ) : !data ? (
            <DashboardSkeleton />
          ) : (
            <>
              {view === "overview" && (
                <Overview
                  data={data}
                  refresh={refresh}
                  refreshing={refreshing}
                  navigate={setView}
                  setToast={setToast}
                />
              )}
              {view === "payments" && (
                <Payments data={data} refresh={refresh} setToast={setToast} />
              )}
              {view === "vendors" && <Vendors data={data} setToast={setToast} />}
              {view === "activity" && <ActivityView data={data} navigate={setView} />}
              {view === "settings" && <SettingsView data={data} setToast={setToast} />}
            </>
          )}
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className={view === item.id ? "active" : ""}
              onClick={() => setView(item.id)}
            >
              <Icon size={19} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <div className={`toast ${toast ? "show" : ""}`} role="status" aria-live="polite">
        <CheckCircle2 size={17} /> {toast}
      </div>
    </div>
  );
}

function SetupState({ kind, onDone }: { kind: "offline" | "pair"; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function pair() {
    setBusy(true);
    setError("");
    try {
      await jsonRequest("/api/safespend/pair", {
        method: "POST",
        body: JSON.stringify({ pairingCode: code }),
      });
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Pairing failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Local runtime"
        title={kind === "offline" ? "Start ZeroClaw first" : "Pair this dashboard"}
        description={
          kind === "offline"
            ? "The dashboard reads and submits only through your loopback ZeroClaw gateway."
            : "Use the six-digit HTTP pairing code printed by the daemon. This is not a Telegram bind code."
        }
      />
      <section className="panel setup-panel">
        <div className="state-icon processing">
          <TerminalSquare size={23} />
        </div>
        {kind === "offline" ? (
          <>
            <h2>Gateway not reachable</h2>
            <p>From the repository root, run:</p>
            <code className="command-block">./scripts/run-zeroclaw-dev.sh</code>
            <button className="button primary" onClick={onDone}>
              <RefreshCw size={16} /> Check again
            </button>
          </>
        ) : (
          <>
            <h2>Server-only gateway pairing</h2>
            <p>
              The bearer token is stored locally under <code>dashboard/.safespend</code> and never
              sent to browser JavaScript.
            </p>
            <label className="pair-field">
              <span>HTTP pairing code</span>
              <input
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
              />
            </label>
            {error && (
              <div className="runtime-error" role="alert">
                <XCircle size={17} />
                <div>
                  <strong>Pairing failed</strong>
                  <span>{error}</span>
                </div>
              </div>
            )}
            <button
              className="button primary"
              onClick={() => void pair()}
              disabled={code.length !== 6 || busy}
            >
              {busy ? <LoaderCircle size={16} className="spin" /> : <LockKeyhole size={16} />} Pair
              dashboard
            </button>
          </>
        )}
      </section>
    </div>
  );
}

function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

function Overview({
  data,
  refresh,
  refreshing,
  navigate,
  setToast,
}: {
  data: SafeSpendBootstrap;
  refresh: (quiet?: boolean) => Promise<void>;
  refreshing: boolean;
  navigate: (v: View) => void;
  setToast: (s: string) => void;
}) {
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={`Finalized slot ${data.network.finalizedSlot.toLocaleString()}`}
        title="Treasury"
        description="Finalized Devnet state shared by Telegram and this dashboard."
        actions={
          <>
            <button
              className="button secondary"
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              <RefreshCw size={16} className={refreshing ? "spin" : ""} /> Refresh
            </button>
            <button className="button primary" onClick={() => navigate("payments")}>
              <Plus size={17} /> New payment
            </button>
          </>
        }
      />
      <TrustStrip data={data} />
      <TreasuryLedger data={data} />
      <div className="overview-grid">
        <PaymentFlow data={data} refresh={refresh} setToast={setToast} compact />
        <RunwayPanel data={data} />
      </div>
      <div className="lower-grid">
        <RecentActivity data={data} onViewAll={() => navigate("activity")} />
        <AllowancePanel data={data} onManage={() => navigate("vendors")} />
      </div>
    </div>
  );
}

function TrustStrip({ data }: { data: SafeSpendBootstrap }) {
  return (
    <div className="trust-strip">
      <div>
        <span className={`status-dot ${data.connection.guardianOnline ? "healthy" : ""}`} />
        <strong>Guardian {data.connection.guardianOnline ? "online" : "unavailable"}</strong>
        <small>
          Audit {data.connection.auditStoreOnline ? "synced" : "unavailable"} · ZeroClaw{" "}
          {data.connection.version ?? "runtime"}
        </small>
      </div>
      <div>
        <BadgeCheck size={17} />
        <strong>Chain-native cap</strong>
        <small>Subscriptions · Devnet {short(data.network.genesisHash, 4, 4)}</small>
      </div>
      <div>
        <LockKeyhole size={17} />
        <strong>Telegram approval</strong>
        <small>Fails closed after 120 seconds</small>
      </div>
      <span className="custody-label">T2 · bounded signer</span>
    </div>
  );
}

function TreasuryLedger({ data }: { data: SafeSpendBootstrap }) {
  const decimals = data.treasury.tokenDecimals;
  return (
    <section className="treasury-ledger" aria-label="Finalized treasury ledger">
      <div className="ledger-balance">
        <span>Available treasury</span>
        <strong>{decimal(data.treasury.tokenBalanceBaseUnits, decimals)}</strong>
        <small>{data.treasury.tokenBalanceBaseUnits} base units · finalized</small>
      </div>
      <dl className="ledger-facts">
        <div>
          <dt>Runway</dt>
          <dd>{runway(data.treasury.runwayMilliweeks)} weeks</dd>
          <small>{data.policy.minimumRunwayWeeks}.0 week floor</small>
        </div>
        <div>
          <dt>Weekly burn</dt>
          <dd>{decimal(data.policy.weeklyBurnBaseUnits, decimals)} tokens</dd>
          <small>Protected policy</small>
        </div>
        <div>
          <dt>Fee reserve</dt>
          <dd>{sol(data.treasury.solBalanceLamports)} SOL</dd>
          <small>Treasury account</small>
        </div>
      </dl>
    </section>
  );
}

function RunwayPanel({ data }: { data: SafeSpendBootstrap }) {
  const weeks = Number(data.treasury.runwayMilliweeks) / 1000;
  const floor = data.policy.minimumRunwayWeeks;
  const max = Math.max(16, weeks * 1.25);
  return (
    <section className="panel runway-panel">
      <div className="panel-heading">
        <div>
          <span className="section-kicker">Policy guardrail</span>
          <h2>Runway protection</h2>
        </div>
        <span className={weeks >= floor ? "healthy-badge" : "danger-badge"}>
          {weeks >= floor ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
          {weeks >= floor ? "Healthy" : "At risk"}
        </span>
      </div>
      <div className="runway-number">
        <strong>{weeks.toFixed(1)}</strong>
        <span>weeks remaining</span>
      </div>
      <div className="runway-scale">
        <div className="runway-track">
          <span style={{ width: `${Math.min(100, (weeks / max) * 100)}%` }} />
        </div>
        <div className="floor-marker" style={{ left: `${Math.min(100, (floor / max) * 100)}%` }}>
          <i />
          <span>{floor} wk floor</span>
        </div>
      </div>
      <div className="runway-axis">
        <span>0</span>
        <span>{floor}</span>
        <span>{max.toFixed(0)} weeks</span>
      </div>
      <dl className="policy-list">
        <div>
          <dt>Minimum runway</dt>
          <dd>{floor}.0 weeks</dd>
        </div>
        <div>
          <dt>Weekly burn</dt>
          <dd>{decimal(data.policy.weeklyBurnBaseUnits, data.treasury.tokenDecimals)} tokens</dd>
        </div>
        <div>
          <dt>Token reserve</dt>
          <dd>
            {decimal(data.policy.minimumTokenReserveBaseUnits, data.treasury.tokenDecimals)} tokens
          </dd>
        </div>
      </dl>
    </section>
  );
}

function Payments({
  data,
  refresh,
  setToast,
}: {
  data: SafeSpendBootstrap;
  refresh: (quiet?: boolean) => Promise<void>;
  setToast: (s: string) => void;
}) {
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Treasury operations"
        title="Payments"
        description="Start in either surface; checkpoint state and onchain finality remain shared."
      />
      <div className="payments-layout">
        <PaymentFlow data={data} refresh={refresh} setToast={setToast} />
        <aside className="payments-aside">
          <PendingRuns data={data} />
          <BoundaryPanel data={data} />
        </aside>
      </div>
    </div>
  );
}

function PaymentFlow({
  data,
  refresh,
  setToast,
  compact = false,
}: {
  data: SafeSpendBootstrap;
  refresh: (quiet?: boolean) => Promise<void>;
  setToast: (s: string) => void;
  compact?: boolean;
}) {
  const activePayment = data.payments.find(
    (payment) => !["finalized", "denied", "failed"].includes(payment.status),
  );
  const [trackedPaymentId, setTrackedPaymentId] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState(
    data.vendors.find((vendor) => vendor.allowance.status === "available")?.id ??
      data.vendors[0]?.id ??
      "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const payment =
    activePayment ?? data.payments.find((candidate) => candidate.id === trackedPaymentId);
  const vendor =
    data.vendors.find((v) => v.id === (payment?.vendorId ?? vendorId)) ?? data.vendors[0];
  const projectedBalance = vendor
    ? BigInt(data.treasury.tokenBalanceBaseUnits) - BigInt(vendor.amountBaseUnits)
    : 0n;
  const weeklyBurn = BigInt(data.policy.weeklyBurnBaseUnits);
  const projectedMilliweeks =
    weeklyBurn > 0n && projectedBalance > 0n ? (projectedBalance * 1000n) / weeklyBurn : 0n;
  const runwayPasses =
    projectedBalance >= BigInt(data.policy.minimumTokenReserveBaseUnits) &&
    projectedMilliweeks >= BigInt(data.policy.minimumRunwayWeeks * 1000);
  const allowancePasses = vendor?.allowance.status === "available";
  const paymentPasses = runwayPasses && allowancePasses;
  const nextAvailable = allowanceTime(vendor?.allowance.nextAvailableAt ?? null);
  const previewTitle = !vendor
    ? "No protected vendor selected"
    : vendor.allowance.status === "spent"
      ? `${vendor.name} was already paid this period`
      : vendor.allowance.status === "not_started"
        ? `${vendor.name} allowance has not started`
        : vendor.allowance.status === "expired"
          ? `${vendor.name} allowance has expired`
          : vendor.allowance.status === "expiring"
            ? `${vendor.name} allowance expires too soon`
            : vendor.allowance.status === "invalid"
              ? `${vendor.name} onchain allowance is unavailable`
              : !runwayPasses
                ? "Protected runway would be breached"
                : "Allowance, recipient, reserve, and runway pass";
  const previewDetail = !vendor
    ? "Select a protected vendor."
    : vendor.allowance.status === "spent"
      ? `${decimal(vendor.allowance.amountPulledThisPeriodBaseUnits, data.treasury.tokenDecimals)} tokens used.${nextAvailable ? ` Next period: ${nextAvailable}.` : " No later period is available."}`
      : vendor.allowance.status === "not_started"
        ? `Starts ${allowanceTime(vendor.allowance.periodStartAt) ?? "after the current finalized slot"}.`
        : vendor.allowance.status === "expired"
          ? "Create a new founder-authorized delegation before requesting payment."
          : vendor.allowance.status === "expiring"
            ? "The expiry is inside the protected safety window. Replace the delegation offline."
            : vendor.allowance.status === "invalid"
              ? "The finalized delegation is missing or does not match the protected amount and cadence."
              : runwayPasses
                ? `Projected runway: ${(Number(projectedMilliweeks) / 1000).toFixed(1)} weeks.`
                : `This payment projects ${(Number(projectedMilliweeks) / 1000).toFixed(1)} weeks, below the ${data.policy.minimumRunwayWeeks}.0 week floor.`;
  async function mutate(url: string, body: unknown, success: string) {
    setBusy(true);
    setError("");
    try {
      const result = await jsonRequest<LivePayment>(url, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setToast(success);
      await refresh();
      return result;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Operation failed.");
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    const selected = data.vendors.find((v) => v.id === vendorId);
    if (selected) {
      const created = await mutate(
        "/api/safespend/payments",
        { vendorId: selected.id, amountBaseUnits: selected.amountBaseUnits },
        "SOP request started",
      );
      if (created) setTrackedPaymentId(created.id);
    }
  }
  const stage = payment?.status ?? "idle";
  const activeIndex =
    stage === "idle" || stage === "validating"
      ? 0
      : stage === "checkpoint"
        ? 1
        : stage === "awaiting_telegram"
          ? 2
          : stage === "submitting" || stage === "submitted"
            ? 3
            : stage === "finalized"
              ? 4
              : 1;
  return (
    <section className={`panel payment-flow ${compact ? "compact" : ""}`}>
      <div className="panel-heading">
        <div>
          <span className="section-kicker">Protected operation</span>
          <h2>Payment approval flow</h2>
        </div>
        {payment && ["finalized", "denied", "failed"].includes(payment.status) ? (
          <button className="text-button" onClick={() => setTrackedPaymentId(null)}>
            <Plus size={14} /> New request
          </button>
        ) : payment ? (
          <span className="source-badge">Started in {payment.source}</span>
        ) : null}
      </div>
      <div className="flow-progress">
        {[
          ["Request", Send],
          ["SOP", ShieldCheck],
          ["Telegram", LockKeyhole],
          ["Submit", Send],
          ["Finalized", BadgeCheck],
        ].map(([label, Icon], index) => {
          const I = Icon as LucideIcon;
          const complete = index < activeIndex || stage === "finalized";
          return (
            <div
              className={`flow-step ${complete ? "complete" : ""} ${index === activeIndex ? "active" : ""}`}
              key={label as string}
            >
              <span>{complete ? <Check size={15} /> : <I size={15} />}</span>
              <small>{label as string}</small>
            </div>
          );
        })}
      </div>
      {error && (
        <div className="runtime-error" role="alert">
          <XCircle size={17} />
          <div>
            <strong>Operation refused</strong>
            <span>{error}</span>
          </div>
        </div>
      )}
      {!payment && (
        <div className="request-form">
          <div className="field-row">
            <label>
              <span>Configured vendor</span>
              <select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                {data.vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} · {v.category}
                    {v.allowance.status === "spent" ? " · paid this period" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Exact protected allowance</span>
              <div className="amount-input">
                <strong>
                  {vendor ? decimal(vendor.amountBaseUnits, data.treasury.tokenDecimals) : "—"}
                </strong>
                <em>tokens</em>
              </div>
            </label>
          </div>
          <div className={`policy-preview ${paymentPasses ? "passes" : "fails"}`} role="status">
            {paymentPasses ? <ShieldCheck size={18} /> : <XCircle size={18} />}
            <div>
              <strong>{previewTitle}</strong>
              <span>{previewDetail}</span>
            </div>
          </div>
          <button
            className="button primary full-width"
            onClick={() => void start()}
            disabled={busy || !vendor || !paymentPasses}
          >
            {busy ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}{" "}
            {paymentPasses
              ? "Start approved-expense SOP"
              : vendor?.allowance.status === "spent"
                ? "Already paid this period"
                : "Blocked by protected policy"}
          </button>
        </div>
      )}
      {payment?.status === "validating" && (
        <Centered
          icon={LoaderCircle}
          title="Guardian validating request"
          description="The headless approved-expense SOP is checking the exact vendor and amount."
          spin
        />
      )}
      {payment?.status === "checkpoint" && (
        <ApprovalCard
          payment={payment}
          vendor={vendor}
          decimals={data.treasury.tokenDecimals}
          busy={busy}
          onDecision={(decision) =>
            void mutate(
              "/api/safespend/sop/decision",
              { runId: payment.runId, decision },
              decision === "approve" ? "SOP checkpoint approved; check Telegram" : "Payment denied",
            )
          }
        />
      )}
      {payment?.status === "awaiting_telegram" && (
        <Centered
          icon={Bell}
          title="Approve the payment tool in Telegram"
          description="Open Safespend in Telegram and tap Approve. If Telegram is unavailable or no decision arrives within 120 seconds, ZeroClaw denies the tool call. No transaction is built before approval."
        />
      )}
      {payment?.status === "submitting" && (
        <Centered
          icon={LoaderCircle}
          title="Verifying submitted result"
          description="SafeSpend is looking for a whitelisted payer result and independently checking the Devnet transfer."
          spin
        />
      )}
      {payment?.status === "submitted" && (
        <Receipt
          payment={payment}
          vendor={vendor}
          decimals={data.treasury.tokenDecimals}
          finalized={false}
          setToast={setToast}
        />
      )}
      {payment?.status === "finalized" && (
        <Receipt
          payment={payment}
          vendor={vendor}
          decimals={data.treasury.tokenDecimals}
          finalized
          setToast={setToast}
        />
      )}
      {payment && ["denied", "failed"].includes(payment.status) && (
        <div className="transaction-state centered-state denied-state">
          <div className="state-icon denied">
            <XCircle size={23} />
          </div>
          <h3>{payment.status === "denied" ? "Payment not sent" : "Payment failed"}</h3>
          <p>{payment.error ?? "No verified Devnet transfer was recorded."}</p>
        </div>
      )}
    </section>
  );
}

function ApprovalCard({
  payment,
  vendor,
  decimals,
  busy,
  onDecision,
}: {
  payment: LivePayment;
  vendor: LiveVendor;
  decimals: number;
  busy: boolean;
  onDecision: (d: "approve" | "deny") => void;
}) {
  return (
    <div className="approval-card amber">
      <div className="approval-heading">
        <div className="approval-icon">
          <ShieldCheck size={20} />
        </div>
        <div>
          <span>Checkpoint 1 of 2</span>
          <h3>Founder SOP approval</h3>
        </div>
      </div>
      <p>
        Approving resumes the payer step. The separate payment-tool approval will still be sent to
        Telegram.
      </p>
      <dl className="approval-facts">
        <div>
          <dt>Vendor</dt>
          <dd>{vendor.name}</dd>
        </div>
        <div>
          <dt>Amount</dt>
          <dd>{decimal(payment.amountBaseUnits, decimals)} tokens</dd>
        </div>
        <div>
          <dt>SOP run</dt>
          <dd>{short(payment.runId, 12, 8)}</dd>
        </div>
        <div>
          <dt>Next approver</dt>
          <dd>telegram.guardian</dd>
        </div>
      </dl>
      <div className="approval-actions">
        <button className="button secondary" disabled={busy} onClick={() => onDecision("deny")}>
          <X size={16} /> Deny
        </button>
        <button className="button primary" disabled={busy} onClick={() => onDecision("approve")}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />} Approve
          checkpoint
        </button>
      </div>
    </div>
  );
}
function Centered({
  icon: Icon,
  title,
  description,
  spin = false,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  spin?: boolean;
}) {
  return (
    <div className="transaction-state centered-state">
      <div className="state-icon processing">
        <Icon size={23} className={spin ? "spin" : ""} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
function Receipt({
  payment,
  vendor,
  decimals,
  finalized,
  setToast,
}: {
  payment: LivePayment;
  vendor: LiveVendor;
  decimals: number;
  finalized: boolean;
  setToast: (s: string) => void;
}) {
  async function copy() {
    if (payment.signature) {
      await navigator.clipboard.writeText(payment.signature);
      setToast("Transaction signature copied");
    }
  }
  return (
    <div className={`transaction-state ${finalized ? "success-state" : "centered-state"}`}>
      <div className={finalized ? "success-heading" : "state-icon submitted"}>
        {finalized ? (
          <>
            <div className="state-icon success">
              <CheckCircle2 size={23} />
            </div>
            <div>
              <span>Finalized on Devnet</span>
              <h3>
                {decimal(payment.amountBaseUnits, decimals)} tokens sent to {vendor.name}
              </h3>
            </div>
          </>
        ) : (
          <BadgeCheck size={23} />
        )}
      </div>
      {!finalized && (
        <>
          <h3>Submitted to Devnet</h3>
          <p>Signature found and transfer verified. Waiting for finalized commitment.</p>
        </>
      )}
      <div className="signature-row">
        <div>
          <span>Transaction signature</span>
          <code>{short(payment.signature ?? "", 16, 14)}</code>
        </div>
        <button className="icon-button" onClick={() => void copy()} aria-label="Copy signature">
          <Copy size={17} />
        </button>
      </div>
      {payment.signature && (
        <a
          className="button secondary full-width"
          href={`https://explorer.solana.com/tx/${payment.signature}?cluster=devnet`}
          target="_blank"
          rel="noreferrer"
        >
          View on Solana Explorer <ExternalLink size={15} />
        </a>
      )}
    </div>
  );
}

function PendingRuns({ data }: { data: SafeSpendBootstrap }) {
  const known = new Set(data.payments.map((p) => p.runId));
  return (
    <section className="panel compact-panel">
      <div className="panel-heading">
        <div>
          <span className="section-kicker">Shared queue</span>
          <h2>Pending SOP runs</h2>
        </div>
        <span className="count-badge">{data.pendingRuns.length}</span>
      </div>
      {data.pendingRuns.length ? (
        <div className="allowance-list">
          {data.pendingRuns.map((run) => (
            <div className="queue-item" key={run.runId}>
              <div className="vendor-icon">
                <ShieldCheck size={18} />
              </div>
              <div>
                <strong>{short(run.runId, 10, 7)}</strong>
                <span>
                  {known.has(run.runId)
                    ? "Exact dashboard intent recorded"
                    : "Telegram-originated · approve in Telegram"}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted-copy">No SOP runs currently waiting.</p>
      )}
    </section>
  );
}
function BoundaryPanel({ data }: { data: SafeSpendBootstrap }) {
  return (
    <section className="panel compact-panel policy-summary">
      <div className="panel-heading">
        <div>
          <span className="section-kicker">T2 boundary</span>
          <h2>Transaction firewall</h2>
        </div>
      </div>
      <dl className="policy-list">
        <div>
          <dt>Network</dt>
          <dd>Devnet only</dd>
        </div>
        <div>
          <dt>Program</dt>
          <dd>
            <code>{short(data.policy.subscriptionsProgram)}</code>
          </dd>
        </div>
        <div>
          <dt>Tool approval</dt>
          <dd>Telegram</dd>
        </div>
        <div>
          <dt>Browser secrets</dt>
          <dd>None</dd>
        </div>
      </dl>
      <div className="info-note">
        <ShieldCheck size={16} />
        <p>Signer, RPC URL, bot token, and gateway bearer remain server-side.</p>
      </div>
    </section>
  );
}

function Vendors({ data, setToast }: { data: SafeSpendBootstrap; setToast: (s: string) => void }) {
  const [query, setQuery] = useState("");
  const filtered = data.vendors.filter((v) =>
    `${v.name} ${v.category}`.toLowerCase().includes(query.toLowerCase()),
  );
  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
    setToast("Protected address copied");
  }
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Protected recipients"
        title="Vendor allowances"
        description="Read-only values loaded from the active protected Devnet configuration."
      />
      <div className="toolbar-row">
        <label className="table-search">
          <Search size={17} />
          <span className="sr-only">Search vendors</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search vendors"
          />
        </label>
      </div>
      <section className="panel table-panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Vendor</th>
                <th>Recipient token account</th>
                <th>Allowance</th>
                <th>Cadence</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((v) => (
                <tr key={v.id}>
                  <td>
                    <div className="vendor-cell">
                      <div className="vendor-icon">
                        <Building2 size={18} />
                      </div>
                      <div>
                        <strong>{v.name}</strong>
                        <span>{v.category}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <button
                      className="copy-value"
                      onClick={() => void copy(v.recipientTokenAccount)}
                    >
                      <code>{short(v.recipientTokenAccount)}</code>
                      <Copy size={14} />
                    </button>
                  </td>
                  <td>
                    <strong>
                      {decimal(v.amountBaseUnits, data.treasury.tokenDecimals)} tokens
                    </strong>
                    <span className="base-units">{v.amountBaseUnits} base units</span>
                  </td>
                  <td>{cadence(v.periodSeconds)}</td>
                  <td>
                    <span
                      className={
                        v.allowance.status === "available" ? "healthy-badge" : "warning-badge"
                      }
                    >
                      {v.allowance.status === "available" && (
                        <span className="status-dot healthy" />
                      )}
                      {allowanceLabel(v.allowance.status)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <div className="configuration-note">
        <LockKeyhole size={17} />
        <div>
          <strong>Offline configuration only</strong>
          <span>
            Change vendors in protected ZeroClaw config, then restart the daemon. The dashboard
            cannot rewrite payment policy.
          </span>
        </div>
      </div>
    </div>
  );
}

function ActivityView({
  data,
  navigate,
}: {
  data: SafeSpendBootstrap;
  navigate: (v: View) => void;
}) {
  const items = data.payments;
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Auditable history"
        title="Activity"
        description="Dashboard requests plus independently observed finalized treasury signatures."
        actions={
          <a
            className="button secondary"
            href={`https://explorer.solana.com/address/${data.treasury.tokenAccount}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={16} /> Explorer
          </a>
        }
      />
      <section className="panel activity-panel">
        {items.length ? (
          <div className="activity-list large">
            {items.map((p) => (
              <div className="activity-row" key={p.id}>
                <div className="timeline-node">
                  <ShieldCheck size={16} />
                </div>
                <div>
                  <strong>
                    {p.vendorId} · {decimal(p.amountBaseUnits, data.treasury.tokenDecimals)} tokens
                  </strong>
                  <span>
                    {p.runId}
                    {p.signature && (
                      <>
                        {" · "}
                        <a
                          className="signature-link"
                          href={`https://explorer.solana.com/tx/${p.signature}?cluster=devnet`}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Open transaction ${p.signature} in Solana Explorer`}
                        >
                          {short(p.signature)} <ExternalLink size={11} aria-hidden="true" />
                        </a>
                      </>
                    )}
                  </span>
                </div>
                <time>{new Date(p.updatedAt).toLocaleTimeString()}</time>
                <span
                  className={`activity-status ${p.status === "finalized" ? "verified" : "observed"}`}
                >
                  {p.status.replace("_", " ")}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={Send}
            title="No dashboard payments yet"
            description="Start a protected Devnet request to create the local audit ledger."
            action="Start payment"
            onAction={() => navigate("payments")}
          />
        )}
      </section>
      <section className="panel compact-panel">
        <div className="panel-heading">
          <div>
            <span className="section-kicker">Finalized RPC state</span>
            <h2>Recent treasury signatures</h2>
          </div>
        </div>
        <div className="activity-list">
          {data.recentSignatures.map((s) => (
            <a
              className="activity-row"
              key={s.signature}
              href={`https://explorer.solana.com/tx/${s.signature}?cluster=devnet`}
              target="_blank"
              rel="noreferrer"
            >
              <div className="timeline-node">
                <BadgeCheck size={16} />
              </div>
              <div>
                <strong>{short(s.signature, 14, 12)}</strong>
                <span>{s.err ? "Onchain error" : (s.confirmationStatus ?? "Observed")}</span>
              </div>
              <time>{s.blockTime ? new Date(s.blockTime * 1000).toLocaleDateString() : "—"}</time>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}

function SettingsView({
  data,
  setToast,
}: {
  data: SafeSpendBootstrap;
  setToast: (s: string) => void;
}) {
  const [testing, setTesting] = useState(false);
  async function testInjection() {
    setTesting(true);
    try {
      const result = await jsonRequest<{
        passed: boolean;
        transcript: Array<{ case: string; result: string }>;
      }>("/api/safespend/prompt-injection-test", { method: "POST", body: "{}" });
      setToast(
        result.passed
          ? `Injection test passed: ${result.transcript.length}/${result.transcript.length} blocked`
          : "Injection test failed",
      );
    } catch (caught) {
      setToast(caught instanceof Error ? caught.message : "Test failed");
    } finally {
      setTesting(false);
    }
  }
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="System controls"
        title="Policies & custody"
        description="Authoritative, read-only guardrails from the active SafeSpend runtime."
      />
      <div className="settings-layout">
        <section className="panel settings-section">
          <div className="settings-heading">
            <div className="settings-icon">
              <ShieldCheck size={18} />
            </div>
            <div>
              <h2>Protected payment policy</h2>
              <p>Dashboard values cannot override these runtime checks.</p>
            </div>
          </div>
          <dl className="connection-list">
            <div>
              <dt>Canonical mint</dt>
              <dd>
                <code>{short(data.treasury.mint)}</code>
              </dd>
            </div>
            <div>
              <dt>Treasury account</dt>
              <dd>
                <code>{short(data.treasury.tokenAccount)}</code>
              </dd>
            </div>
            <div>
              <dt>Session delegate</dt>
              <dd>
                <code>{short(data.treasury.sessionDelegate)}</code>
              </dd>
            </div>
            <div>
              <dt>Minimum runway</dt>
              <dd>{data.policy.minimumRunwayWeeks}.0 weeks</dd>
            </div>
            <div>
              <dt>Mainnet</dt>
              <dd>Blocked</dd>
            </div>
            <div>
              <dt>RPC genesis</dt>
              <dd>
                <code>{short(data.network.genesisHash)}</code>
              </dd>
            </div>
          </dl>
          <div className="protected-warning">
            <LockKeyhole size={17} />
            <div>
              <strong>Local daemon holds bounded T2 authority</strong>
              <span>
                The browser receives public addresses and balances only. The limited session key
                never leaves protected plugin configuration.
              </span>
            </div>
          </div>
        </section>
        <section className="panel settings-section">
          <div className="settings-heading">
            <div className="settings-icon">
              <TerminalSquare size={18} />
            </div>
            <div>
              <h2>Runtime connection</h2>
              <p>Live local and Devnet endpoints.</p>
            </div>
          </div>
          <dl className="connection-list">
            <div>
              <dt>ZeroClaw</dt>
              <dd>{data.connection.version ?? "Connected"}</dd>
            </div>
            <div>
              <dt>Telegram</dt>
              <dd>{data.connection.telegramOnline ? "Configured" : "Unavailable"}</dd>
            </div>
            <div>
              <dt>SOP audit</dt>
              <dd>{data.connection.auditStoreOnline ? "Read-only · synced" : "Unavailable"}</dd>
            </div>
            <div>
              <dt>RPC provider</dt>
              <dd>{data.network.rpcProvider}</dd>
            </div>
            <div>
              <dt>Finalized slot</dt>
              <dd>{data.network.finalizedSlot.toLocaleString()}</dd>
            </div>
          </dl>
        </section>
        <section className="panel settings-section">
          <div className="settings-heading">
            <div className="settings-icon">
              <ShieldCheck size={18} />
            </div>
            <div>
              <h2>Prompt-injection firewall</h2>
              <p>Run the fail-closed test corpus without calling the LLM, signer, or RPC.</p>
            </div>
          </div>
          <button
            className="button secondary full-width"
            onClick={() => void testInjection()}
            disabled={testing}
          >
            {testing ? <LoaderCircle size={16} className="spin" /> : <ShieldCheck size={16} />} Run
            security transcript
          </button>
        </section>
        <section className="panel settings-section">
          <div className="settings-heading">
            <div className="settings-icon">
              <LockKeyhole size={18} />
            </div>
            <div>
              <h2>Custody & third-party trust</h2>
              <p>What is enforced today and what remains roadmap.</p>
            </div>
          </div>
          <dl className="connection-list">
            <div>
              <dt>Onchain cap</dt>
              <dd>Subscriptions delegation</dd>
            </div>
            <div>
              <dt>Transaction firewall</dt>
              <dd>Exact intent + simulation</dd>
            </div>
            <div>
              <dt>Approvals</dt>
              <dd>SOP + Telegram tool gate</dd>
            </div>
            <div>
              <dt>Squads v4</dt>
              <dd>Proposer-only roadmap</dd>
            </div>
            <div>
              <dt>Agent identity</dt>
              <dd>Not active</dd>
            </div>
            <div>
              <dt>External trust</dt>
              <dd>ZeroClaw, RPC, Telegram, model provider</dd>
            </div>
          </dl>
          <div className="info-note">
            <ShieldCheck size={16} />
            <p>No MCP server or payment facilitator participates in the signing path.</p>
          </div>
        </section>
      </div>
    </div>
  );
}

function RecentActivity({ data, onViewAll }: { data: SafeSpendBootstrap; onViewAll: () => void }) {
  return (
    <section className="panel compact-panel">
      <div className="panel-heading">
        <div>
          <span className="section-kicker">Audit trail</span>
          <h2>Recent activity</h2>
        </div>
        <button className="text-button" onClick={onViewAll}>
          View all <ChevronRight size={14} />
        </button>
      </div>
      {data.payments.length ? (
        <div className="activity-list">
          {data.payments.slice(0, 3).map((p) => (
            <div className="activity-row" key={p.id}>
              <div className="timeline-node">
                <ShieldCheck size={16} />
              </div>
              <div>
                <strong>{p.vendorId} payment</strong>
                <span>{short(p.runId, 12, 7)}</span>
              </div>
              <time>{p.status}</time>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted-copy">No dashboard payment requests yet.</p>
      )}
    </section>
  );
}
function AllowancePanel({ data, onManage }: { data: SafeSpendBootstrap; onManage: () => void }) {
  return (
    <section className="panel compact-panel">
      <div className="panel-heading">
        <div>
          <span className="section-kicker">Protected config</span>
          <h2>Vendor allowances</h2>
        </div>
        <button className="text-button" onClick={onManage}>
          Review <ChevronRight size={14} />
        </button>
      </div>
      <div className="allowance-list">
        {data.vendors.map((v) => (
          <div className="allowance-row" key={v.id}>
            <div className="vendor-icon">
              <Building2 size={17} />
            </div>
            <div>
              <strong>{v.name}</strong>
              <span>
                {v.category} · {cadence(v.periodSeconds)}
              </span>
            </div>
            <div>
              <strong>{decimal(v.amountBaseUnits, data.treasury.tokenDecimals)}</strong>
              <span>{allowanceLabel(v.allowance.status)}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  onAction,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state">
      <div>
        <Icon size={21} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action && (
        <button className="button secondary" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}
function ErrorState({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Fail-closed runtime"
        title="SafeSpend paused"
        description="No payment action is available until the live state validates."
      />
      <div className="runtime-error" role="alert">
        <XCircle size={18} />
        <div>
          <strong>Live state unavailable</strong>
          <span>{error}</span>
        </div>
        <button className="button secondary" onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  );
}
function DashboardSkeleton() {
  return (
    <div className="page-stack skeleton-page" aria-busy="true">
      <div className="skeleton header-skeleton" />
      <div className="skeleton trust-skeleton" />
      <div className="skeleton ledger-skeleton" />
      <div className="overview-grid">
        <div className="skeleton panel-skeleton" />
        <div className="skeleton panel-skeleton" />
      </div>
    </div>
  );
}
