"use client";

import {
  Activity,
  BadgeCheck,
  Bell,
  Building2,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Copy,
  ExternalLink,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  Menu,
  Moon,
  PanelLeftClose,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  TerminalSquare,
  Trash2,
  Users,
  WalletCards,
  WifiOff,
  X,
  XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Transaction } from "@solana/web3.js";
import type {
  ApiErrorBody,
  LivePayment,
  LiveVendor,
  SafeSpendBootstrap,
  VendorCadence,
  VendorEnrollmentProposal,
  VendorEnrollmentResult,
  VendorPolicyAction,
} from "@/lib/safespend-types";
import {
  calculateTreasuryMetrics,
  calculateVendorHistory,
  isFinalizedPayment,
} from "@/lib/treasury-math";

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
function cadenceKey(seconds: number): VendorCadence {
  return seconds === 86_400 ? "daily" : seconds === 604_800 ? "weekly" : "monthly";
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

function activityTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
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
  const responseText = await response.text();
  let body: T | ApiErrorBody | null = null;
  try {
    body = responseText ? (JSON.parse(responseText) as T | ApiErrorBody) : null;
  } catch {
    // Hosting layers can return plain text or HTML before the application responds.
  }
  if (!response.ok) {
    const apiMessage =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : "";
    const hostingMessage =
      response.status >= 500
        ? "SafeSpend runtime is temporarily unavailable or waking up. Retry shortly."
        : `SafeSpend request failed (HTTP ${response.status}).`;
    throw new Error(apiMessage || hostingMessage);
  }
  if (!body) {
    throw new Error("SafeSpend returned an invalid response. Retry shortly.");
  }
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
    const active = Boolean(
      data?.pendingRuns.length ||
      data?.payments.some((payment) => !["finalized", "denied", "failed"].includes(payment.status)),
    );
    const recovering = !connection?.gatewayOnline || !connection?.paired;
    const timer = window.setInterval(
      () => {
        if (document.visibilityState === "visible") void refresh(true);
      },
      recovering || active ? 5_000 : 15_000,
    );
    return () => window.clearInterval(timer);
  }, [
    connection?.gatewayOnline,
    connection?.paired,
    data?.payments,
    data?.pendingRuns.length,
    refresh,
  ]);

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
          {error && !connection ? (
            <ErrorState error={error} onRetry={() => void refresh()} />
          ) : !connection ? (
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
  const metrics = calculateTreasuryMetrics(data);
  return (
    <section className="treasury-ledger" aria-label="Finalized treasury ledger">
      <div className="ledger-balance">
        <span>Finalized onchain balance</span>
        <strong className="amount-value">
          {decimal(data.treasury.tokenBalanceBaseUnits, decimals)} <em>tokens</em>
        </strong>
        <small title={data.treasury.tokenAccount}>
          {short(data.treasury.tokenAccount, 8, 8)} · finalized on Devnet
        </small>
      </div>
      <dl className="ledger-facts">
        <div>
          <dt>Spendable above floor</dt>
          <dd className="amount-value">
            {decimal(metrics.spendableAboveFloor.toString(), decimals)} tokens
          </dd>
          <small>Current balance minus protected floor</small>
        </div>
        <div>
          <dt>Protected floor</dt>
          <dd className="amount-value">
            {decimal(metrics.protectedFloor.toString(), decimals)} tokens
          </dd>
          <small>Higher of reserve or runway requirement</small>
        </div>
        <div>
          <dt>Fee reserve</dt>
          <dd className="amount-value">{sol(data.treasury.solBalanceLamports)} SOL</dd>
          <small>Treasury account</small>
        </div>
      </dl>
      <div className="ledger-rule">
        <LockKeyhole size={15} aria-hidden="true" />
        <span>
          Vendor allowances are caps, not reserved balances. Only finalized transfers reduce this
          balance; deleting a vendor does not refund prior payments.
        </span>
      </div>
    </section>
  );
}

function RunwayPanel({ data }: { data: SafeSpendBootstrap }) {
  const weeks = Number(data.treasury.runwayMilliweeks) / 1000;
  const floor = data.policy.minimumRunwayWeeks;
  const max = Math.max(16, weeks * 1.25);
  const metrics = calculateTreasuryMetrics(data);
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
        <strong className="amount-value">{weeks.toFixed(1)}</strong>
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
          <dd className="amount-value">
            {decimal(data.policy.weeklyBurnBaseUnits, data.treasury.tokenDecimals)} tokens
          </dd>
        </div>
        <div>
          <dt>Vendor caps / week</dt>
          <dd className="amount-value">
            {decimal(metrics.normalizedWeeklyAllowance.toString(), data.treasury.tokenDecimals)}{" "}
            tokens
          </dd>
        </div>
      </dl>
      <p className="calculation-note">
        Runway = finalized balance ÷ protected weekly burn. Vendor caps are normalized to seven days
        for planning and do not replace the founder-controlled burn baseline.
      </p>
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
    data.vendors.find(
      (vendor) => vendor.enrollmentStatus === "active" && vendor.allowance.status === "available",
    )?.id ??
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
  const allowancePasses =
    vendor?.enrollmentStatus === "active" && vendor.allowance.status === "available";
  const paymentPasses = runwayPasses && allowancePasses;
  const nextAvailable = allowanceTime(vendor?.allowance.nextAvailableAt ?? null);
  const previewTitle = !vendor
    ? "No protected vendor selected"
    : vendor.enrollmentStatus !== "active"
      ? `${vendor.name} needs founder-signed enrollment`
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
    : vendor.enrollmentStatus !== "active"
      ? "Open Vendors and activate a signed policy version before requesting payment."
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
                    {v.enrollmentStatus !== "active" ? " · needs signed policy" : ""}
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

type BrowserSolanaProvider = {
  publicKey?: { toBase58(): string } | null;
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  on?(event: "accountChanged", handler: (publicKey: { toBase58(): string } | null) => void): void;
  off?(event: "accountChanged", handler: (publicKey: { toBase58(): string } | null) => void): void;
  signMessage?(
    message: Uint8Array,
    encoding?: "utf8",
  ): Promise<{ signature: Uint8Array } | Uint8Array>;
  signTransaction?(transaction: Transaction): Promise<Transaction>;
};

function browserSolanaProvider() {
  const browser = window as Window & {
    solana?: BrowserSolanaProvider;
    phantom?: { solana?: BrowserSolanaProvider };
  };
  return browser.phantom?.solana ?? browser.solana;
}

function founderWalletMismatch(connected: string, expected: string) {
  return `Connected wallet ${connected} is not the founder authority. In Phantom, switch to the imported account ${expected}, then connect again.`;
}

function bytesFromBase64(value: string) {
  const binary = window.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}

function Vendors({ data, setToast }: { data: SafeSpendBootstrap; setToast: (s: string) => void }) {
  const [query, setQuery] = useState("");
  const [mutation, setMutation] = useState<{
    action: VendorPolicyAction;
    vendor?: LiveVendor;
  } | null>(null);
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
        description="Founder-signed policy versions matched to finalized finite Devnet delegations."
        actions={
          <button className="button primary" onClick={() => setMutation({ action: "add" })}>
            <Plus size={16} /> Add vendor
          </button>
        }
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
                <th>
                  <span className="sr-only">Actions</span>
                </th>
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
                        <span>
                          {v.category} · {v.policyVersion ? `Policy v${v.policyVersion}` : "Legacy"}
                        </span>
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
                    <strong className="amount-value">
                      {decimal(v.amountBaseUnits, data.treasury.tokenDecimals)} tokens
                    </strong>
                    <span className="base-units">
                      {decimal(
                        v.allowance.amountPulledThisPeriodBaseUnits,
                        data.treasury.tokenDecimals,
                      )}{" "}
                      used ·{" "}
                      {decimal(
                        v.allowance.remainingThisPeriodBaseUnits,
                        data.treasury.tokenDecimals,
                      )}{" "}
                      remaining
                    </span>
                  </td>
                  <td>{cadence(v.periodSeconds)}</td>
                  <td>
                    <span
                      className={
                        v.enrollmentStatus === "active" && v.allowance.status === "available"
                          ? "healthy-badge"
                          : "warning-badge"
                      }
                    >
                      {v.enrollmentStatus === "active" && v.allowance.status === "available" && (
                        <span className="status-dot healthy" />
                      )}
                      {v.enrollmentStatus === "active"
                        ? allowanceLabel(v.allowance.status)
                        : "Needs signed policy"}
                    </span>
                  </td>
                  <td>
                    <div className="vendor-actions">
                      <button
                        className="icon-button compact"
                        onClick={() => setMutation({ action: "update", vendor: v })}
                        disabled={v.enrollmentStatus !== "active"}
                        aria-label={`Edit ${v.name}`}
                        title={`Edit ${v.name}`}
                      >
                        <Pencil size={15} aria-hidden="true" />
                      </button>
                      <button
                        className="icon-button compact danger"
                        onClick={() => setMutation({ action: "delete", vendor: v })}
                        disabled={v.enrollmentStatus !== "active"}
                        aria-label={`Delete ${v.name}`}
                        title={`Delete ${v.name}`}
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!filtered.length && (
          <div className="table-empty">
            <Building2 size={24} aria-hidden="true" />
            <strong>No matching vendors</strong>
            <span>Clear the search or enroll a new protected recipient.</span>
          </div>
        )}
      </section>
      <div className="configuration-note">
        <BadgeCheck size={17} />
        <div>
          <strong>Signed, versioned enrollment</strong>
          <span>
            New vendors stay unavailable until the founder signs the policy and finite delegation,
            the transaction finalizes, and the service verifies exact onchain terms.
          </span>
        </div>
      </div>
      {mutation && (
        <VendorEnrollmentDialog
          data={data}
          action={mutation.action}
          vendor={mutation.vendor}
          onClose={() => setMutation(null)}
          onActivated={() => {
            setToast(
              mutation.action === "delete"
                ? "Vendor deleted and delegation revoked"
                : mutation.action === "update"
                  ? "Vendor terms updated"
                  : "Vendor policy activated",
            );
            window.location.reload();
          }}
        />
      )}
    </div>
  );
}

function VendorEnrollmentDialog({
  data,
  action,
  vendor,
  onClose,
  onActivated,
}: {
  data: SafeSpendBootstrap;
  action: VendorPolicyAction;
  vendor?: LiveVendor;
  onClose: () => void;
  onActivated: () => void;
}) {
  const [displayName, setDisplayName] = useState(vendor?.name ?? "");
  const [recipientWallet, setRecipientWallet] = useState(vendor?.recipientWallet ?? "");
  const [amountTokens, setAmountTokens] = useState(
    vendor
      ? decimal(vendor.amountBaseUnits, data.treasury.tokenDecimals, data.treasury.tokenDecimals)
      : "",
  );
  const [cadenceValue, setCadenceValue] = useState<VendorCadence>(
    vendor ? cadenceKey(vendor.periodSeconds) : "monthly",
  );
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [founderWallet, setFounderWallet] = useState("");
  const [proposal, setProposal] = useState<VendorEnrollmentProposal | null>(null);
  const [result, setResult] = useState<VendorEnrollmentResult | null>(null);
  const [stage, setStage] = useState<"form" | "preparing" | "review" | "signing" | "finalizing">(
    "form",
  );
  const [error, setError] = useState("");
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const busy = ["preparing", "signing", "finalizing"].includes(stage);
  const vendorHistory = vendor
    ? calculateVendorHistory(data.payments, vendor)
    : { finalizedCount: 0, finalizedOutflow: 0n, openRequestCount: 0 };

  useEffect(() => {
    closeButton.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]",
        ) ?? [],
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [busy, onClose]);

  useEffect(() => {
    const provider = browserSolanaProvider();
    if (!provider?.on) return;
    const accountChanged = (publicKey: { toBase58(): string } | null) => {
      setProposal(null);
      setResult(null);
      setStage("form");
      if (!publicKey) {
        setFounderWallet("");
        setError("Wallet disconnected. Connect the protected founder account to continue.");
        return;
      }
      const address = publicKey.toBase58();
      if (address !== data.treasury.owner) {
        setFounderWallet("");
        setError(founderWalletMismatch(address, data.treasury.owner));
        return;
      }
      setFounderWallet(address);
      setError("");
    };
    provider.on("accountChanged", accountChanged);
    return () => provider.off?.("accountChanged", accountChanged);
  }, [data.treasury.owner]);

  async function connectWallet() {
    const provider = browserSolanaProvider();
    if (!provider) {
      throw new Error("Install or unlock a Solana wallet that supports message signing.");
    }
    const connected = provider.publicKey ?? (await provider.connect()).publicKey;
    const address = connected.toBase58();
    if (address !== data.treasury.owner) {
      setFounderWallet("");
      throw new Error(founderWalletMismatch(address, data.treasury.owner));
    }
    setFounderWallet(address);
    return { provider, address };
  }

  async function prepare(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStage("preparing");
    setError("");
    try {
      if (action === "delete" && deleteConfirmation !== vendor?.id) {
        throw new Error(`Type ${vendor?.id ?? "the vendor ID"} exactly to confirm deletion.`);
      }
      const wallet = founderWallet || (await connectWallet()).address;
      const endpoint =
        action === "update"
          ? "/api/safespend/vendors/update/preview"
          : action === "delete"
            ? "/api/safespend/vendors/delete/preview"
            : "/api/safespend/vendors/preview";
      const body =
        action === "delete"
          ? { vendorId: vendor?.id, founderWallet: wallet }
          : {
              ...(action === "update" ? { vendorId: vendor?.id } : {}),
              displayName,
              recipientWallet,
              amountTokens,
              cadence: cadenceValue,
              founderWallet: wallet,
            };
      const prepared = await jsonRequest<VendorEnrollmentProposal>(endpoint, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setProposal(prepared);
      setStage("review");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Vendor review could not be prepared.");
      setStage("form");
    }
  }

  async function signAndActivate() {
    if (!proposal) return;
    setStage("signing");
    setError("");
    try {
      const { provider, address } = await connectWallet();
      if (address !== proposal.review.founderWallet) {
        throw new Error(
          "Connected wallet changed. Reopen this policy change with the founder wallet.",
        );
      }
      if (!provider.signMessage || !provider.signTransaction) {
        throw new Error("Connected wallet does not support policy and transaction signing.");
      }
      const messageResult = await provider.signMessage(
        new TextEncoder().encode(proposal.signingMessage),
        "utf8",
      );
      const policySignature =
        messageResult instanceof Uint8Array ? messageResult : messageResult.signature;
      const transaction = Transaction.from(bytesFromBase64(proposal.unsignedTransactionBase64));
      const signedTransaction = await provider.signTransaction(transaction);
      const payload = {
        proposalId: proposal.proposalId,
        policySignatureBase64: bytesToBase64(policySignature),
        signedTransactionBase64: bytesToBase64(
          signedTransaction.serialize({ requireAllSignatures: true, verifySignatures: true }),
        ),
      };
      setStage("finalizing");
      for (let attempt = 0; attempt < 45; attempt += 1) {
        const activation = await jsonRequest<VendorEnrollmentResult>(
          "/api/safespend/vendors/activate",
          { method: "POST", body: JSON.stringify(payload) },
        );
        setResult(activation);
        if (activation.status === "active") return;
        await new Promise((resolve) => window.setTimeout(resolve, 2_000));
      }
      throw new Error(
        "Policy transaction is still not finalized. Keep this window open and retry.",
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Vendor policy change failed.";
      setError(
        /reject|cancel/i.test(message)
          ? "Wallet signing was cancelled. No policy or delegation change was activated."
          : message,
      );
      setStage(proposal ? "review" : "form");
    }
  }

  const review = proposal?.review;
  const projectedWeeks = review ? Number(review.projectedRunwayMilliweeks) / 1000 : 0;
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        ref={dialog}
        className="enrollment-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vendor-enrollment-title"
        aria-busy={busy}
      >
        <div className="dialog-heading">
          <div>
            <span className="section-kicker">Policy administration</span>
            <h2 id="vendor-enrollment-title">
              {result?.status === "active"
                ? action === "delete"
                  ? "Vendor deleted"
                  : action === "update"
                    ? "Vendor updated"
                    : "Vendor active"
                : action === "delete"
                  ? "Delete vendor"
                  : action === "update"
                    ? "Edit vendor"
                    : "Add vendor"}
            </h2>
          </div>
          <button
            ref={closeButton}
            className="icon-button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close vendor policy dialog"
          >
            <X size={18} />
          </button>
        </div>

        {error && (
          <div className="runtime-error" role="alert">
            <XCircle size={17} aria-hidden="true" />
            <div>
              <strong>Change refused</strong>
              <span>{error}</span>
            </div>
          </div>
        )}

        {result?.status === "active" ? (
          <div className="enrollment-success">
            <div className="state-icon success">
              <BadgeCheck size={24} aria-hidden="true" />
            </div>
            <h3>
              {action === "delete"
                ? `${review?.displayName} was removed`
                : review?.replacementStartsAfterPriorPeriod
                  ? `${review.displayName} update is scheduled`
                  : `${review?.displayName} is eligible for payments`}
            </h3>
            <p>
              {action === "delete"
                ? `Policy v${result.policyVersion} is active and the former delegation is closed. New payments are ineligible. ${vendorHistory.finalizedCount} prior finalized payment${vendorHistory.finalizedCount === 1 ? "" : "s"} remain in the immutable activity ledger; no tokens were refunded.`
                : review?.replacementStartsAfterPriorPeriod
                  ? `Policy v${result.policyVersion} is active. The prior payment remains consumed, so the new allowance starts ${new Date(review.startAt).toLocaleString()}.`
                  : `Policy v${result.policyVersion} and the exact recurring delegation are finalized and verified. Every payment still requires the SOP checkpoint and Telegram approval.`}
            </p>
            <dl className="review-grid">
              <div>
                <dt>Policy hash</dt>
                <dd>
                  <code>{short(result.policyHash, 12, 10)}</code>
                </dd>
              </div>
              <div>
                <dt>Policy transaction</dt>
                <dd>
                  <code>{short(result.signature, 12, 10)}</code>
                </dd>
              </div>
            </dl>
            <button className="button primary full-width" onClick={onActivated}>
              {action === "delete" ? "Return to vendors" : "Use vendor for payments"}
            </button>
          </div>
        ) : stage === "form" || stage === "preparing" ? (
          <form className="vendor-form" onSubmit={(event) => void prepare(event)}>
            <div className="custody-callout">
              <WalletCards size={18} aria-hidden="true" />
              <div>
                <strong>Founder wallet signs locally</strong>
                <span>
                  SafeSpend receives signed public bytes, never your key or recovery phrase.
                </span>
              </div>
            </div>
            {action === "delete" ? (
              <div className="delete-confirmation">
                <Trash2 size={19} aria-hidden="true" />
                <div>
                  <strong>Revoke {vendor?.name}</strong>
                  <p>
                    This closes delegation <code>{short(vendor?.recurringDelegation ?? "")}</code>,
                    removes the vendor from policy v{data.policy.vendorPolicyVersion + 1}, and makes
                    future payments ineligible. It does not send or refund tokens.
                  </p>
                  <dl className="delete-impact">
                    <div>
                      <dt>Already finalized</dt>
                      <dd className="amount-value">
                        {decimal(
                          vendorHistory.finalizedOutflow.toString(),
                          data.treasury.tokenDecimals,
                        )}{" "}
                        tokens · {vendorHistory.finalizedCount} payment
                        {vendorHistory.finalizedCount === 1 ? "" : "s"}
                      </dd>
                    </div>
                    <div>
                      <dt>Open requests</dt>
                      <dd>{vendorHistory.openRequestCount}</dd>
                    </div>
                  </dl>
                  <p className="delete-boundary">
                    Requests not yet submitted will be refused after the policy changes. A transfer
                    already submitted before revocation may still finalize first and will remain in
                    Activity.
                  </p>
                  <label htmlFor="delete-vendor-confirmation">
                    <span>
                      Type <code>{vendor?.id}</code> to confirm
                    </span>
                    <input
                      id="delete-vendor-confirmation"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={deleteConfirmation}
                      onChange={(event) => setDeleteConfirmation(event.target.value)}
                      required
                    />
                  </label>
                </div>
              </div>
            ) : (
              <>
                <label htmlFor="vendor-name">
                  <span>Vendor name</span>
                  <input
                    id="vendor-name"
                    type="text"
                    autoComplete="organization"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder="Railway"
                    required
                    maxLength={80}
                  />
                  <small>
                    {action === "update"
                      ? `Vendor ID remains ${vendor?.id}.`
                      : "A stable vendor ID is derived from this name."}
                  </small>
                </label>
                <label htmlFor="recipient-wallet">
                  <span>Recipient wallet</span>
                  <input
                    id="recipient-wallet"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={recipientWallet}
                    onChange={(event) => setRecipientWallet(event.target.value.trim())}
                    placeholder="Solana public key"
                    required
                    minLength={32}
                    maxLength={64}
                  />
                  <small>
                    If needed, the founder-signed transaction creates the canonical-mint token
                    account.
                  </small>
                </label>
                <div className="field-row">
                  <label htmlFor="vendor-amount">
                    <span>Amount per period</span>
                    <input
                      id="vendor-amount"
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      spellCheck={false}
                      value={amountTokens}
                      onChange={(event) => setAmountTokens(event.target.value)}
                      placeholder="12.00"
                      required
                    />
                    <small>Token units · {data.treasury.tokenDecimals} mint decimals</small>
                  </label>
                  <label htmlFor="vendor-cadence">
                    <span>Cadence</span>
                    <select
                      id="vendor-cadence"
                      value={cadenceValue}
                      onChange={(event) => setCadenceValue(event.target.value as VendorCadence)}
                    >
                      <option value="daily">Daily · 86,400 seconds</option>
                      <option value="weekly">Weekly · 604,800 seconds</option>
                      <option value="monthly">Monthly · 2,592,000 seconds</option>
                    </select>
                    <small>Monthly is a fixed 30-day period.</small>
                  </label>
                </div>
              </>
            )}
            <div className="wallet-row">
              <div>
                <span>Signing authority</span>
                <code title={founderWallet || data.treasury.owner}>
                  {founderWallet ? short(founderWallet) : short(data.treasury.owner)}
                </code>
                <small>{founderWallet ? "Founder connected" : "Required founder account"}</small>
              </div>
              {founderWallet ? (
                <div className="wallet-portfolio" aria-label="Founder treasury portfolio">
                  <div>
                    <span>Native balance</span>
                    <strong>{sol(data.treasury.solBalanceLamports)} SOL</strong>
                  </div>
                  <div>
                    <span>Treasury token</span>
                    <strong>
                      {decimal(data.treasury.tokenBalanceBaseUnits, data.treasury.tokenDecimals)}
                    </strong>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() =>
                    void connectWallet().catch((caught) =>
                      setError(caught instanceof Error ? caught.message : "Wallet unavailable."),
                    )
                  }
                >
                  <WalletCards size={16} /> Connect Phantom
                </button>
              )}
            </div>
            <button
              className={`button ${action === "delete" ? "danger" : "primary"} full-width`}
              type="submit"
              disabled={busy || (action === "delete" && deleteConfirmation !== vendor?.id)}
            >
              {stage === "preparing" ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <ShieldCheck size={16} />
              )}
              {stage === "preparing"
                ? "Validating finalized state…"
                : action === "delete"
                  ? "Review deletion"
                  : action === "update"
                    ? "Review update"
                    : "Review delegation"}
            </button>
          </form>
        ) : (
          review && (
            <div className="vendor-review">
              <div className="review-status passes" role="status">
                {stage === "finalizing" ? (
                  <LoaderCircle size={19} className="spin" aria-hidden="true" />
                ) : (
                  <ShieldCheck size={19} aria-hidden="true" />
                )}
                <div>
                  <strong>
                    {stage === "finalizing"
                      ? "Waiting for finalized policy transaction"
                      : review.replacementStartsAfterPriorPeriod
                        ? "Current-period payment is preserved"
                        : action === "delete"
                          ? "Exact revocation and policy checks pass"
                          : "Exact policy and runway checks pass"}
                  </strong>
                  <span>
                    {stage === "finalizing"
                      ? `Submitted ${short(result?.signature ?? "", 10, 8)}. The current policy remains authoritative until finalization.`
                      : review.replacementStartsAfterPriorPeriod
                        ? `${decimal(review.priorAmountPulledBaseUnits, data.treasury.tokenDecimals)} tokens already paid remain consumed. The new allowance begins ${new Date(review.startAt).toLocaleString()}.`
                        : action === "delete"
                          ? `Policy v${review.policyVersion} removes this vendor only after the delegation is finalized closed.`
                          : `First payment leaves ${projectedWeeks.toFixed(1)} weeks, above the ${review.minimumRunwayWeeks}.0 week floor.`}
                  </span>
                </div>
              </div>
              <dl className="review-grid">
                <div>
                  <dt>Vendor</dt>
                  <dd>{review.displayName}</dd>
                  <small>{review.vendorId}</small>
                </div>
                <div>
                  <dt>Fixed allowance</dt>
                  <dd>{review.amountTokens} tokens</dd>
                  <small>
                    {review.replacementStartsAfterPriorPeriod
                      ? `Next period · prior ${decimal(review.priorAmountPulledBaseUnits, data.treasury.tokenDecimals)} paid`
                      : `${review.amountBaseUnits} base units`}
                  </small>
                </div>
                <div>
                  <dt>Cadence</dt>
                  <dd>{cadence(review.periodSeconds)}</dd>
                  <small>{review.periodSeconds.toLocaleString()} seconds</small>
                </div>
                <div>
                  <dt>Finite term</dt>
                  <dd>
                    {new Date(review.startAt).toLocaleDateString()} →{" "}
                    {new Date(review.expiryAt).toLocaleDateString()}
                  </dd>
                  <small>Starts {new Date(review.startAt).toLocaleString()}</small>
                </div>
                <div>
                  <dt>Recipient wallet</dt>
                  <dd>
                    <code title={review.recipientWallet}>{short(review.recipientWallet)}</code>
                  </dd>
                  <small>
                    ATA {short(review.recipientTokenAccount)} ·{" "}
                    {review.recipientTokenAccountWillBeCreated
                      ? "created during enrollment"
                      : "already initialized"}
                  </small>
                </div>
                <div>
                  <dt>{action === "delete" ? "Current runway" : "Runway after first payment"}</dt>
                  <dd>{projectedWeeks.toFixed(1)} weeks</dd>
                  <small>
                    {decimal(review.projectedBalanceBaseUnits, data.treasury.tokenDecimals)} tokens
                  </small>
                </div>
                <div>
                  <dt>
                    {action === "delete"
                      ? "Delegation to revoke"
                      : action === "update"
                        ? review.revokedDelegation
                          ? "Delegation replacement"
                          : "Delegation retained"
                        : "Delegation PDA"}
                  </dt>
                  <dd>
                    <code
                      title={
                        action === "delete"
                          ? (review.revokedDelegation ?? undefined)
                          : (review.recurringDelegation ?? undefined)
                      }
                    >
                      {action === "update" && review.revokedDelegation
                        ? `${short(review.revokedDelegation ?? "")} → ${short(review.recurringDelegation ?? "")}`
                        : short(
                            action === "delete"
                              ? (review.revokedDelegation ?? "")
                              : (review.recurringDelegation ?? ""),
                          )}
                    </code>
                  </dd>
                  <small>
                    {action === "delete"
                      ? "Closed atomically before policy publication"
                      : action === "update" && !review.revokedDelegation
                        ? "Name-only edit; allowance period is not reset"
                        : `New nonce ${review.delegationNonce}`}
                  </small>
                </div>
                {action === "delete" && (
                  <div>
                    <dt>Historical payments</dt>
                    <dd className="amount-value">
                      {decimal(
                        vendorHistory.finalizedOutflow.toString(),
                        data.treasury.tokenDecimals,
                      )}{" "}
                      tokens
                    </dd>
                    <small>
                      {vendorHistory.finalizedCount} finalized · retained in Activity · no refund
                    </small>
                  </div>
                )}
                <div>
                  <dt>Immutable policy</dt>
                  <dd>Version {review.policyVersion}</dd>
                  <small title={review.policyHash}>{short(review.policyHash, 10, 8)}</small>
                </div>
              </dl>
              <div className="signature-explainer">
                <Clock3 size={17} aria-hidden="true" />
                <p>
                  Your wallet will request two signatures: the immutable policy version, then the
                  {action === "delete"
                    ? " Subscriptions delegation revocation"
                    : action === "update"
                      ? review.revokedDelegation
                        ? review.replacementStartsAfterPriorPeriod
                          ? " atomic replacement and revocation transaction. The new delegation starts only after the paid current period ends"
                          : " atomic replacement and revocation transaction. No current-period payment exists, so the new delegation starts immediately"
                        : " policy anchor transaction; the existing delegation and allowance period stay unchanged"
                      : " finite Subscriptions delegation"}
                  . Neither signature sends a vendor payment. A wallet-added compute budget is
                  accepted only under SafeSpend&apos;s capped Devnet fee limit.
                </p>
              </div>
              <div className="approval-actions">
                <button
                  className="button secondary"
                  onClick={() => setStage("form")}
                  disabled={busy}
                >
                  Back
                </button>
                <button
                  className={`button ${action === "delete" ? "danger" : "primary"}`}
                  onClick={() => void signAndActivate()}
                  disabled={busy}
                >
                  {busy ? <LoaderCircle size={16} className="spin" /> : <WalletCards size={16} />}
                  {stage === "finalizing"
                    ? "Finalizing on Devnet…"
                    : action === "delete"
                      ? "Sign and delete"
                      : action === "update"
                        ? "Sign and update"
                        : "Sign and activate"}
                </button>
              </div>
            </div>
          )
        )}
      </section>
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
  const metrics = calculateTreasuryMetrics(data);
  const transactions = data.payments.filter(
    (payment) => Boolean(payment.signature) && ["submitted", "finalized"].includes(payment.status),
  );
  const requests = data.payments.filter(
    (payment) => !transactions.some((transaction) => transaction.id === payment.id),
  );
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Auditable history"
        title="Activity"
        description="Verified SafeSpend payments only. Funding, minting, and policy-admin transactions are excluded."
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
      <dl className="activity-summary" aria-label="SafeSpend activity totals">
        <div>
          <dt>Current finalized balance</dt>
          <dd className="amount-value">
            {decimal(metrics.balance.toString(), data.treasury.tokenDecimals)} tokens
          </dd>
        </div>
        <div>
          <dt>Recorded finalized outflow</dt>
          <dd className="amount-value">
            {decimal(metrics.finalizedOutflow.toString(), data.treasury.tokenDecimals)} tokens
          </dd>
          <small>{metrics.finalizedPaymentCount} verified vendor payments</small>
        </div>
        <div>
          <dt>Submitted, not finalized</dt>
          <dd className="amount-value">
            {decimal(metrics.submittedOutflow.toString(), data.treasury.tokenDecimals)} tokens
          </dd>
          <small>{metrics.submittedPaymentCount} onchain transactions</small>
        </div>
        <div>
          <dt>Open approval requests</dt>
          <dd className="amount-value">{metrics.openRequestCount}</dd>
          <small>Not deducted from treasury</small>
        </div>
      </dl>
      <section className="panel activity-panel">
        {transactions.length ? (
          <div className="activity-list large">
            {transactions.map((p) => (
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
                <time>{activityTime(p.updatedAt)}</time>
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
            title="No verified payments"
            description="Funding and policy transactions are intentionally not shown as vendor payments."
            action="Start payment"
            onAction={() => navigate("payments")}
          />
        )}
      </section>
      {requests.length > 0 && (
        <section className="panel compact-panel">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">Non-transaction events</span>
              <h2>Request history</h2>
            </div>
          </div>
          <div className="activity-list large request-list">
            {requests.map((payment) => (
              <div className="activity-row" key={payment.id}>
                <div className="timeline-node">
                  <ShieldCheck size={16} />
                </div>
                <div>
                  <strong>
                    {payment.vendorId} ·{" "}
                    {decimal(payment.amountBaseUnits, data.treasury.tokenDecimals)} tokens
                  </strong>
                  <span>{payment.error ?? "No finalized transfer was recorded."}</span>
                </div>
                <time>{activityTime(payment.updatedAt)}</time>
                <span className="activity-status observed">{payment.status.replace("_", " ")}</span>
              </div>
            ))}
          </div>
        </section>
      )}
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
  const payments = data.payments.filter(isFinalizedPayment);
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
      {payments.length ? (
        <div className="activity-list">
          {payments.slice(0, 3).map((p) => (
            <div className="activity-row" key={p.id}>
              <div className="timeline-node">
                <ShieldCheck size={16} />
              </div>
              <div>
                <strong>{p.vendorId} payment</strong>
                <span>{short(p.runId, 12, 7)}</span>
              </div>
              <time className="amount-value">
                {decimal(p.amountBaseUnits, data.treasury.tokenDecimals)} tokens
              </time>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted-copy">No finalized SafeSpend payments yet.</p>
      )}
    </section>
  );
}
function AllowancePanel({ data, onManage }: { data: SafeSpendBootstrap; onManage: () => void }) {
  const metrics = calculateTreasuryMetrics(data);
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
      <dl className="allowance-summary" aria-label="Active allowance totals">
        <div>
          <dt>Callable now</dt>
          <dd className="amount-value">
            {decimal(metrics.callableNow.toString(), data.treasury.tokenDecimals)} tokens
          </dd>
        </div>
        <div>
          <dt>Normalized weekly cap</dt>
          <dd className="amount-value">
            {decimal(metrics.normalizedWeeklyAllowance.toString(), data.treasury.tokenDecimals)}{" "}
            tokens
          </dd>
        </div>
      </dl>
      {data.vendors.length ? (
        <div className="allowance-list">
          {data.vendors.map((v) => (
            <div className="allowance-row" key={v.id}>
              <div className="vendor-icon">
                <Building2 size={17} aria-hidden="true" />
              </div>
              <div>
                <strong>{v.name}</strong>
                <span>
                  {cadence(v.periodSeconds)} · policy v{v.policyVersion}
                </span>
              </div>
              <div>
                <strong className="amount-value">
                  {decimal(v.allowance.remainingThisPeriodBaseUnits, data.treasury.tokenDecimals)}{" "}
                  remaining
                </strong>
                <span>
                  {decimal(
                    v.allowance.amountPulledThisPeriodBaseUnits,
                    data.treasury.tokenDecimals,
                  )}{" "}
                  used of {decimal(v.amountBaseUnits, data.treasury.tokenDecimals)} ·{" "}
                  {allowanceLabel(v.allowance.status)}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted-copy">No active founder-signed vendor allowances.</p>
      )}
      <div className="allowance-total">
        <span>Active signed policy</span>
        <strong title={data.policy.vendorPolicyHash ?? undefined}>
          v{data.policy.vendorPolicyVersion} · {short(data.policy.vendorPolicyHash ?? "", 6, 6)}
        </strong>
      </div>
      <p className="calculation-note">
        These are maximum recurring permissions. SafeSpend does not earmark or subtract them from
        the treasury until a payment finalizes.
      </p>
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
