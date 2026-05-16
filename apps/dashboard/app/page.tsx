"use client";

import { useEffect, useMemo, useState } from "react";

interface DashboardSnapshot {
  snapshot: {
    assetClass: string;
    symbol?: string;
    pair?: string;
    asset?: string;
    percentChange: number;
    sources: Array<{ id: string; provider: string; title: string; type: string }>;
  };
  draft: {
    title: string;
    body: string;
    confidence: { score: number; band: string; rationale: string; requiresReview: boolean };
    catalyst: { label: string; classification: string; confidenceScore: number };
    sourcesUsed: string[];
  };
  compliance: {
    status: string;
    flags: Array<{ code: string; phrase: string; severity: string }>;
  };
  publishing?: {
    id: string;
    status: string;
    disabledForToday: boolean;
    decision: {
      status: string;
      reasons: string[];
      warnings: string[];
      cautiousLanguageRequired: boolean;
    };
  };
}

interface Mover {
  symbol: string;
  percentChange: number;
  assetClass: string;
}

interface SchedulerJob {
  name: string;
  cronUtc?: string;
  everyMs?: number;
  lagosLabel: string;
  description: string;
}

interface DashboardData {
  snapshots: DashboardSnapshot[];
  movers: Mover[];
  watchlist: string[];
  scheduler: { enabled: boolean; jobs: SchedulerJob[] };
  aiStatus?: {
    provider: string;
    model: string;
    fallbackProvider: string;
    configured: boolean;
    todayAiCalls: number;
    todayFallbackCount: number;
    maxGenerationsPerDay: number;
  };
  postHistory: Array<{ id: string; symbol: string; channel: string; publishedAt?: string }>;
}

type DraftAction =
  | "approve"
  | "reject"
  | "regenerate"
  | "make_sharper"
  | "make_shorter"
  | "add_macro_context"
  | "add_source_summary"
  | "disable_asset_today";

const fallbackData: DashboardData = {
  snapshots: [],
  movers: [
    { symbol: "NVDA", percentChange: 3.84, assetClass: "equity" },
    { symbol: "NATGAS", percentChange: 2.44, assetClass: "commodity" },
    { symbol: "GOLD", percentChange: 1.05, assetClass: "commodity" }
  ],
  watchlist: ["AAPL", "NVDA", "TSLA", "EURUSD", "GBPUSD", "GOLD", "OIL", "NATGAS", "DXY"],
  scheduler: { enabled: false, jobs: [] },
  aiStatus: {
    provider: "Gemini",
    model: "gemini-2.5-flash",
    fallbackProvider: "template",
    configured: false,
    todayAiCalls: 0,
    todayFallbackCount: 0,
    maxGenerationsPerDay: 40
  },
  postHistory: []
};

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData>(fallbackData);
  const [status, setStatus] = useState("Connecting to API...");
  const [watchSymbol, setWatchSymbol] = useState("");
  const [watchlist, setWatchlist] = useState<string[]>(fallbackData.watchlist);
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "/api/market-desk";

  async function refreshDashboard(active = true) {
    fetch(`${apiUrl}/dashboard`, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`API returned ${response.status}`);
        }
        return response.json() as Promise<DashboardData>;
      })
      .then((payload) => {
        if (!active) {
          return;
        }
        setData(payload);
        setWatchlist(payload.watchlist);
        setStatus("Live mock pipeline connected");
      })
      .catch((error: Error) => {
        if (!active) {
          return;
        }
        setStatus(`API unavailable; showing local fallback. ${error.message}`);
      });
  }

  useEffect(() => {
    let active = true;
    void refreshDashboard(active);
    return () => {
      active = false;
    };
  }, [apiUrl]);

  const averageConfidence = useMemo(() => {
    if (data.snapshots.length === 0) {
      return 0;
    }
    return Math.round(
      data.snapshots.reduce((total, item) => total + item.draft.confidence.score, 0) / data.snapshots.length
    );
  }, [data.snapshots]);

  function addWatchSymbol() {
    const symbol = watchSymbol.trim().toUpperCase();
    if (!symbol || watchlist.includes(symbol)) {
      return;
    }
    setWatchlist((current) => [...current, symbol]);
    setWatchSymbol("");
  }

  async function runDraftAction(id: string, action: DraftAction) {
    setStatus(`Running ${action.replace(/_/g, " ")}...`);
    const response = await fetch(`${apiUrl}/publishing/drafts/${id}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action })
    });
    if (!response.ok) {
      setStatus(`Action failed: ${response.status}`);
      return;
    }
    setStatus(`Action complete: ${action.replace(/_/g, " ")}`);
    await refreshDashboard();
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Admin dashboard</p>
          <h1>Market Desk Engine</h1>
        </div>
        <div className="status-pill">{status}</div>
      </header>

      <section className="metrics" aria-label="Desk overview">
        <div>
          <span>Average confidence</span>
          <strong>{averageConfidence || "--"}/100</strong>
        </div>
        <div>
          <span>Compliance queue</span>
          <strong>{data.snapshots.filter((item) => item.compliance.flags.length > 0).length}</strong>
        </div>
        <div>
          <span>Scheduler</span>
          <strong>{data.scheduler.enabled ? "Active" : "Paused"}</strong>
        </div>
        <div>
          <span>Provider mode</span>
          <strong>Mock</strong>
        </div>
        <div>
          <span>AI writer</span>
          <strong>{data.aiStatus ? `${data.aiStatus.provider} / ${data.aiStatus.fallbackProvider}` : "--"}</strong>
        </div>
      </section>

      <section className="workspace-grid">
        <div className="panel wide">
          <div className="section-heading">
            <h2>Generated Drafts</h2>
            <span>{data.snapshots.length} drafts</span>
          </div>
          <div className="draft-grid">
            {data.snapshots.length === 0 ? (
              <p className="empty">Start the API to populate live mock snapshots and drafts.</p>
            ) : (
              data.snapshots.map((item) => (
                <DraftCard
                  key={item.publishing?.id ?? item.draft.title}
                  item={item}
                  onAction={(action) => item.publishing?.id && runDraftAction(item.publishing.id, action)}
                />
              ))
            )}
          </div>
        </div>

        <div className="panel">
          <div className="section-heading">
            <h2>Movers</h2>
            <span>Mock tape</span>
          </div>
          <div className="mover-list">
            {data.movers.map((mover) => (
              <div key={mover.symbol} className="mover-row">
                <span>{mover.symbol}</span>
                <strong className={mover.percentChange >= 0 ? "positive" : "negative"}>
                  {mover.percentChange >= 0 ? "+" : ""}
                  {mover.percentChange.toFixed(2)}%
                </strong>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="section-heading">
            <h2>Watchlist</h2>
            <span>{watchlist.length} assets</span>
          </div>
          <div className="watch-input">
            <input
              value={watchSymbol}
              onChange={(event) => setWatchSymbol(event.target.value)}
              placeholder="Add symbol"
              aria-label="Add watchlist symbol"
            />
            <button type="button" onClick={addWatchSymbol}>
              Add
            </button>
          </div>
          <div className="tags">
            {watchlist.map((symbol) => (
              <span key={symbol}>{symbol}</span>
            ))}
          </div>
        </div>

        <div className="panel wide">
          <div className="section-heading">
            <h2>Scheduler Status</h2>
            <span>{data.scheduler.jobs.length} jobs</span>
          </div>
          <div className="schedule-table">
            {data.scheduler.jobs.length === 0 ? (
              <p className="empty">Scheduler definitions load from the API.</p>
            ) : (
              data.scheduler.jobs.map((job) => (
                <div key={job.name} className="schedule-row">
                  <span>{job.description}</span>
                  <span>{job.lagosLabel}</span>
                  <code>{job.cronUtc ?? `${Math.round((job.everyMs ?? 0) / 60000)} min`}</code>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="panel">
          <div className="section-heading">
            <h2>AI Status</h2>
            <span>{data.aiStatus?.configured ? "configured" : "fallback"}</span>
          </div>
          <div className="detail-grid">
            <div>
              <span>Provider</span>
              <strong>{data.aiStatus?.provider ?? "--"}</strong>
            </div>
            <div>
              <span>Model</span>
              <strong>{data.aiStatus?.model ?? "--"}</strong>
            </div>
            <div>
              <span>AI calls today</span>
              <strong>
                {data.aiStatus?.todayAiCalls ?? 0}/{data.aiStatus?.maxGenerationsPerDay ?? "--"}
              </strong>
            </div>
            <div>
              <span>Fallbacks today</span>
              <strong>{data.aiStatus?.todayFallbackCount ?? 0}</strong>
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="section-heading">
            <h2>Telegram History</h2>
            <span>{data.postHistory.length} posts</span>
          </div>
          {data.postHistory.length === 0 ? (
            <p className="empty">No Telegram posts have been recorded in this mock session.</p>
          ) : (
            data.postHistory.map((post) => (
              <div key={post.id} className="post-row">
                <strong>{post.symbol}</strong>
                <span>{post.channel}</span>
              </div>
            ))
          )}
        </div>
      </section>
    </main>
  );
}

function DraftCard({ item, onAction }: { item: DashboardSnapshot; onAction: (action: DraftAction) => void }) {
  const subject = item.snapshot.symbol ?? item.snapshot.pair ?? item.snapshot.asset ?? "UNKNOWN";
  const flags = item.compliance.flags;

  return (
    <article className="draft-card">
      <div className="draft-head">
        <div>
          <p>{subject}</p>
          <h3>{item.draft.title}</h3>
        </div>
        <div className="score">{item.draft.confidence.score}</div>
      </div>
      <p className="draft-body">{item.draft.body}</p>
      <div className="detail-grid">
        <div>
          <span>Classification</span>
          <strong>{item.draft.catalyst.classification}</strong>
        </div>
        <div>
          <span>Catalyst</span>
          <strong>{item.draft.catalyst.label}</strong>
        </div>
        <div>
          <span>Compliance</span>
          <strong>{item.compliance.status}</strong>
        </div>
        <div>
          <span>Publishing</span>
          <strong>{item.publishing?.decision.status ?? "draft"}</strong>
        </div>
      </div>
      {item.publishing?.decision.reasons.length ? (
        <p className="decision-note">{item.publishing.decision.reasons.join(" ")}</p>
      ) : null}
      <div className="tags">
        {item.draft.sourcesUsed.map((source) => (
          <span key={source}>{source}</span>
        ))}
        {item.snapshot.sources.length === 0 && <span>No sources</span>}
      </div>
      <div className="flags">
        {flags.length === 0 ? (
          <span>Compliance clear</span>
        ) : (
          flags.map((flag) => <span key={`${flag.code}-${flag.phrase}`}>{flag.code}</span>)
        )}
      </div>
      <div className="actions">
        <button type="button" onClick={() => onAction("approve")}>
          Approve post
        </button>
        <button type="button" onClick={() => onAction("reject")}>
          Reject post
        </button>
        <button type="button" onClick={() => onAction("regenerate")}>
          Regenerate
        </button>
        <button type="button" onClick={() => onAction("make_sharper")}>
          Make sharper
        </button>
        <button type="button" onClick={() => onAction("make_shorter")}>
          Make shorter
        </button>
        <button type="button" onClick={() => onAction("add_macro_context")}>
          Add macro context
        </button>
        <button type="button" onClick={() => onAction("add_source_summary")}>
          Add source summary
        </button>
        <button type="button" onClick={() => onAction("disable_asset_today")}>
          Disable asset for today
        </button>
      </div>
    </article>
  );
}
