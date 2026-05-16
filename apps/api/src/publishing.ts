import {
  AnalysisPipeline,
  AnalysisResult,
  PublishingDecision,
  PublishingMode,
  evaluatePublishingDecision
} from "@market-desk/analysis-engine";
import { AnalysisMode } from "@market-desk/shared";
import { TelegramClient, TelegramInlineKeyboardMarkup } from "@market-desk/telegram";

export type DraftStatus = "draft" | "auto_posted" | "approved" | "rejected" | "blocked";
export type DraftAction =
  | "approve"
  | "reject"
  | "regenerate"
  | "make_sharper"
  | "make_shorter"
  | "add_macro_context"
  | "add_source_summary"
  | "disable_asset_today";

export interface PublishingDraftRecord {
  id: string;
  symbol: string;
  assetClass: "equity" | "forex" | "commodity";
  mode: AnalysisMode;
  result: AnalysisResult;
  decision: PublishingDecision;
  status: DraftStatus;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  rejectedAt?: string;
  disabledForToday?: boolean;
  adminNotifiedAt?: string;
  publicMessageId?: number;
}

export interface PublishingActionResult {
  record: PublishingDraftRecord;
  message: string;
}

export class PublishingDraftStore {
  private readonly drafts = new Map<string, PublishingDraftRecord>();
  private readonly disabledAssets = new Map<string, string>();

  upsert(record: PublishingDraftRecord): PublishingDraftRecord {
    this.drafts.set(record.id, record);
    return record;
  }

  get(id: string): PublishingDraftRecord | undefined {
    return this.drafts.get(id);
  }

  list(): PublishingDraftRecord[] {
    return [...this.drafts.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  isAssetDisabledToday(symbol: string): boolean {
    const until = this.disabledAssets.get(symbol.toUpperCase());
    return Boolean(until && new Date(until).getTime() > Date.now());
  }

  disableAssetToday(symbol: string): string {
    const until = endOfTodayUtc();
    this.disabledAssets.set(symbol.toUpperCase(), until);
    return until;
  }
}

export class PublishingService {
  constructor(
    private readonly input: {
      pipeline: AnalysisPipeline;
      telegram: TelegramClient;
      store: PublishingDraftStore;
      publishingMode: PublishingMode;
      publicChannelId?: string;
      adminChatId?: string;
      maxAutoPostsPerDay?: number;
    }
  ) {}

  listDrafts(): PublishingDraftRecord[] {
    return this.input.store.list();
  }

  async createDraft(input: {
    symbol: string;
    assetClass?: "equity" | "forex" | "commodity";
    mode?: AnalysisMode;
    notifyAdmin?: boolean;
  }): Promise<PublishingDraftRecord> {
    const assetClass = input.assetClass ?? "equity";
    const symbol = input.symbol.toUpperCase();
    if (this.input.store.isAssetDisabledToday(symbol)) {
      throw new Error(`${symbol} is disabled for today.`);
    }

    const result = await this.analyze(assetClass, symbol, input.mode);
    const decision = evaluatePublishingDecision({
      mode: this.input.publishingMode,
      draft: result.draft,
      compliance: result.compliance,
      snapshot: result.snapshot
    });
    const now = new Date().toISOString();
    const record = this.input.store.upsert({
      id: createDraftId(),
      symbol,
      assetClass,
      mode: input.mode ?? defaultMode(assetClass),
      result,
      decision,
      status: decision.status === "blocked" ? "blocked" : "draft",
      createdAt: now,
      updatedAt: now
    });

    if (decision.status === "auto_post_allowed" && this.autoPostLimitReached()) {
      record.decision = {
        ...record.decision,
        status: "approval_required",
        reasons: [...record.decision.reasons, "Daily auto-post limit reached; admin approval is required."]
      };
      record.status = "draft";
      this.input.store.upsert(record);
    }

    if (record.decision.status === "auto_post_allowed") {
      await this.publishPublic(record, "auto_posted");
    }

    if (input.notifyAdmin ?? true) {
      await this.notifyAdmin(record);
    }

    return record;
  }

  async upsertDashboardPreview(input: {
    symbol: string;
    assetClass: "equity" | "forex" | "commodity";
    result: AnalysisResult;
    mode: AnalysisMode;
  }): Promise<PublishingDraftRecord> {
    const existing = this.listDrafts().find(
      (draft) => draft.symbol === input.symbol && draft.assetClass === input.assetClass && draft.status === "draft"
    );
    const decision = evaluatePublishingDecision({
      mode: this.input.publishingMode,
      draft: input.result.draft,
      compliance: input.result.compliance,
      snapshot: input.result.snapshot
    });
    const now = new Date().toISOString();
    const record: PublishingDraftRecord = {
      id: existing?.id ?? createDraftId(),
      symbol: input.symbol,
      assetClass: input.assetClass,
      mode: input.mode,
      result: input.result,
      decision,
      status: existing?.status ?? (decision.status === "blocked" ? "blocked" : "draft"),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      publishedAt: existing?.publishedAt,
      rejectedAt: existing?.rejectedAt,
      disabledForToday: this.input.store.isAssetDisabledToday(input.symbol)
    };
    return this.input.store.upsert(record);
  }

  async handleAction(id: string, action: DraftAction): Promise<PublishingActionResult> {
    const record = this.input.store.get(id);
    if (!record) {
      throw new Error(`Draft ${id} not found.`);
    }

    switch (action) {
      case "approve":
        if (record.decision.status === "blocked") {
          await this.notifyAdmin(record, "Blocked draft was not published.");
          return { record, message: "Blocked draft cannot be approved for public posting." };
        }
        await this.publishPublic(record, "approved");
        await this.notifyAdmin(record, "Approved and sent to public channel.");
        return { record, message: "Approved and sent." };
      case "reject":
        record.status = "rejected";
        record.rejectedAt = new Date().toISOString();
        record.updatedAt = record.rejectedAt;
        this.input.store.upsert(record);
        await this.notifyAdmin(record, "Rejected.");
        return { record, message: "Rejected." };
      case "regenerate": {
        const fresh = await this.createDraft({
          symbol: record.symbol,
          assetClass: record.assetClass,
          mode: record.mode,
          notifyAdmin: false
        });
        fresh.id = record.id;
        fresh.createdAt = record.createdAt;
        this.input.store.upsert(fresh);
        await this.notifyAdmin(fresh, "Regenerated draft.");
        return { record: fresh, message: "Regenerated." };
      }
      case "make_sharper":
        this.mutateBody(record, makeSharper(record.result.draft.body));
        await this.notifyAdmin(record, "Made sharper.");
        return { record, message: "Made sharper." };
      case "make_shorter":
        this.mutateBody(record, makeShorter(record.result.draft.body));
        await this.notifyAdmin(record, "Shortened draft.");
        return { record, message: "Shortened." };
      case "add_macro_context":
        this.mutateBody(record, addMacroContext(record));
        await this.notifyAdmin(record, "Added macro context.");
        return { record, message: "Added macro context." };
      case "add_source_summary":
        this.mutateBody(record, addSourceSummary(record));
        await this.notifyAdmin(record, "Added source summary.");
        return { record, message: "Added source summary." };
      case "disable_asset_today":
        this.input.store.disableAssetToday(record.symbol);
        record.disabledForToday = true;
        record.updatedAt = new Date().toISOString();
        this.input.store.upsert(record);
        await this.notifyAdmin(record, `${record.symbol} disabled for today.`);
        return { record, message: `${record.symbol} disabled for today.` };
    }
  }

  private async analyze(
    assetClass: "equity" | "forex" | "commodity",
    symbol: string,
    mode: AnalysisMode = defaultMode(assetClass)
  ): Promise<AnalysisResult> {
    if (assetClass === "forex") {
      return this.input.pipeline.analyzeForex(symbol, mode);
    }
    if (assetClass === "commodity") {
      return this.input.pipeline.analyzeCommodity(symbol, mode);
    }
    return this.input.pipeline.analyzeEquity(symbol, mode);
  }

  private async publishPublic(record: PublishingDraftRecord, status: "auto_posted" | "approved"): Promise<void> {
    const sendResult = await this.input.telegram.sendMessage({
      chatId: this.input.publicChannelId,
      text: record.result.draft.body
    });
    record.status = status;
    record.publishedAt = new Date().toISOString();
    record.updatedAt = record.publishedAt;
    record.publicMessageId = sendResult.messageId;
    this.input.store.upsert(record);
  }

  private autoPostLimitReached(): boolean {
    const limit = this.input.maxAutoPostsPerDay ?? 20;
    const start = startOfUtcDay().getTime();
    const count = this.listDrafts().filter(
      (draft) =>
        draft.status === "auto_posted" &&
        draft.publishedAt &&
        new Date(draft.publishedAt).getTime() >= start
    ).length;
    return count >= limit;
  }

  private async notifyAdmin(record: PublishingDraftRecord, note?: string): Promise<void> {
    const warnings = [...record.decision.warnings, ...record.decision.reasons].join("\n- ");
    const text = [
      note ? `Admin note: ${note}` : "Draft review",
      `${record.symbol} | ${record.assetClass} | ${record.status}`,
      `Decision: ${record.decision.status}`,
      `Confidence: ${record.decision.confidenceScore}/100`,
      warnings ? `Reasons:\n- ${warnings}` : "",
      "",
      record.result.draft.body
    ]
      .filter(Boolean)
      .join("\n\n");

    await this.input.telegram.sendMessage({
      chatId: this.input.adminChatId,
      text,
      replyMarkup: adminKeyboard(record.id)
    });
    record.adminNotifiedAt = new Date().toISOString();
    this.input.store.upsert(record);
  }

  private mutateBody(record: PublishingDraftRecord, body: string): void {
    record.result = {
      ...record.result,
      draft: {
        ...record.result.draft,
        body
      }
    };
    record.decision = evaluatePublishingDecision({
      mode: this.input.publishingMode,
      draft: record.result.draft,
      compliance: record.result.compliance,
      snapshot: record.result.snapshot
    });
    record.status = record.decision.status === "blocked" ? "blocked" : "draft";
    record.updatedAt = new Date().toISOString();
    this.input.store.upsert(record);
  }
}

export function publishingModeFromEnv(env: NodeJS.ProcessEnv): PublishingMode {
  return env.PUBLISHING_MODE === "auto_post" ? "auto_post" : "approval_required";
}

export function actionFromCallbackData(data: string): { id: string; action: DraftAction } | null {
  const [prefix, action, id] = data.split(":");
  if (prefix !== "pub" || !id || !isDraftAction(action)) {
    return null;
  }
  return { id, action };
}

function adminKeyboard(id: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "Approve", callback_data: `pub:approve:${id}` },
        { text: "Reject", callback_data: `pub:reject:${id}` }
      ],
      [
        { text: "Regenerate", callback_data: `pub:regenerate:${id}` },
        { text: "Shorten", callback_data: `pub:make_shorter:${id}` },
        { text: "Add context", callback_data: `pub:add_macro_context:${id}` }
      ]
    ]
  };
}

function defaultMode(assetClass: "equity" | "forex" | "commodity"): AnalysisMode {
  if (assetClass === "forex") {
    return "forex_reaction";
  }
  if (assetClass === "commodity") {
    return "commodity_reaction";
  }
  return "equity_mover_reaction";
}

function createDraftId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function isDraftAction(action: string): action is DraftAction {
  return [
    "approve",
    "reject",
    "regenerate",
    "make_sharper",
    "make_shorter",
    "add_macro_context",
    "add_source_summary",
    "disable_asset_today"
  ].includes(action);
}

function makeSharper(body: string): string {
  return withFooter(
    withoutFooter(body)
      .replace(/\bThe move appears linked to\b/g, "The cleaner read is")
      .replace(/\bThe next test is whether\b/g, "The test is whether")
      .replace(/\bThe risk is that\b/g, "The risk:")
  );
}

function makeShorter(body: string): string {
  const paragraphs = withoutFooter(body).split(/\n\s*\n/).filter(Boolean);
  return withFooter(paragraphs.slice(0, 2).join("\n\n"));
}

function addMacroContext(record: PublishingDraftRecord): string {
  const snapshot = record.result.snapshot;
  const lines =
    snapshot.assetClass === "equity"
      ? [`Macro context: sector move ${snapshot.sectorMove.toFixed(2)}%, index context ${snapshot.indexMove.toFixed(2)}%.`]
      : snapshot.assetClass === "forex"
        ? [
            `Macro context: ${snapshot.dxyContext.value}`,
            `${snapshot.yieldContext.value}`,
            `${snapshot.centralBankContext.value}`
          ]
        : [
            `Macro context: ${snapshot.dollarContext.value}`,
            `${snapshot.yieldContext.value}`,
            `${snapshot.supplyDemandContext.value}`
          ];
  return withFooter(`${withoutFooter(record.result.draft.body)}\n\n${lines.join(" ")}`);
}

function addSourceSummary(record: PublishingDraftRecord): string {
  const sources = record.result.snapshot.sources
    .slice(0, 4)
    .map((source) => `${source.provider}: ${source.title}`)
    .join("; ");
  return withFooter(`${withoutFooter(record.result.draft.body)}\n\nSources checked: ${sources || "No source summary available."}`);
}

function withoutFooter(body: string): string {
  return body.replace(/\n*\s*Market commentary only\.\s*$/i, "").trim();
}

function withFooter(body: string): string {
  const trimmed = body.trim();
  return trimmed.endsWith("Market commentary only.") ? trimmed : `${trimmed}\n\nMarket commentary only.`;
}

function endOfTodayUtc(): string {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  return end.toISOString();
}

function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
