import type {
  PublishBatch,
  PublishedSignSnapshot,
  RecallDecision,
  RecallSession,
  ReviewStatus,
  SignItem,
  SignProject,
  TermBinding,
} from "./types";

export const uid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export const STATUS_LABELS: Record<ReviewStatus, string> = {
  draft: "草稿",
  pending: "待确认",
  confirmed: "已确认",
  changes: "需修改",
};

export const BATCH_STATUS_LABELS = {
  published: "已发布",
  recalling: "撤回处理中",
  recalled: "已撤回",
} as const;

export const RECALL_DECISION_LABELS: Record<RecallDecision, string> = {
  keep: "保留本机版",
  restore: "采用发布版",
};

/** 冻结一条标识的完整可发布内容。 */
export const snapshotSign = (sign: SignItem): PublishedSignSnapshot => ({
  signId: sign.id,
  code: sign.code,
  sourceText: sign.sourceText,
  targetLanguage: sign.targetLanguage,
  targetText: sign.targetText,
  scenario: sign.scenario,
  regulation: sign.regulation,
  status: sign.status,
  terms: structuredClone(sign.terms),
  comments: structuredClone(sign.comments),
});

/** 把发布快照还原回一条标识（撤回时采用发布版）。 */
export const restoreSnapshot = (sign: SignItem, snapshot: PublishedSignSnapshot) => {
  sign.code = snapshot.code;
  sign.sourceText = snapshot.sourceText;
  sign.targetLanguage = snapshot.targetLanguage;
  sign.targetText = snapshot.targetText;
  sign.scenario = snapshot.scenario;
  sign.regulation = snapshot.regulation;
  sign.status = snapshot.status;
  sign.terms = structuredClone(snapshot.terms);
  sign.comments = structuredClone(snapshot.comments);
};

/** 标识已在本机删除时，按发布快照重建一条完整标识。 */
export const signFromSnapshot = (snapshot: PublishedSignSnapshot): SignItem => ({
  id: snapshot.signId,
  code: snapshot.code,
  sourceText: snapshot.sourceText,
  targetLanguage: snapshot.targetLanguage,
  targetText: snapshot.targetText,
  scenario: snapshot.scenario,
  regulation: snapshot.regulation,
  status: snapshot.status,
  terms: structuredClone(snapshot.terms),
  comments: structuredClone(snapshot.comments),
  versions: [],
  emergencyRevision: false,
  updatedAt: new Date().toISOString(),
});

/** 撤回比对：本机当前内容与发布快照是否一致。 */
export const snapshotMatchesSign = (snapshot: PublishedSignSnapshot, sign: SignItem | undefined) => {
  if (!sign) return false;
  return (
    sign.code === snapshot.code &&
    sign.sourceText === snapshot.sourceText &&
    sign.targetLanguage === snapshot.targetLanguage &&
    sign.targetText === snapshot.targetText &&
    sign.scenario === snapshot.scenario &&
    sign.regulation === snapshot.regulation &&
    sign.status === snapshot.status &&
    JSON.stringify(sign.terms) === JSON.stringify(snapshot.terms) &&
    JSON.stringify(sign.comments) === JSON.stringify(snapshot.comments)
  );
};

export const createBatch = (signs: SignItem[], label: string): PublishBatch => ({
  id: uid("batch"),
  label: label.trim(),
  createdAt: new Date().toISOString(),
  status: "published",
  signs: signs.map(snapshotSign),
});

export const createRecallSession = (batch: PublishBatch, signs: SignItem[]): RecallSession => ({
  id: uid("recall"),
  batchId: batch.id,
  startedAt: new Date().toISOString(),
  baseline: batch.signs.map((snapshot) => {
    const current = signs.find((sign) => sign.id === snapshot.signId);
    // 以发布快照为兜底，保证中断后仍有可比基线。
    return current ? snapshotSign(current) : structuredClone(snapshot);
  }),
  decisions: {},
});

export const findBatch = (project: SignProject, batchId: string) =>
  project.batches.find((batch) => batch.id === batchId);

/** 当前打开的撤回会话。 */
export const findRecallSession = (project: SignProject, sessionId: string) =>
  project.recallSessions.find((session) => session.id === sessionId);

/** 当前是否存在未处理完的撤回（含中断重开后未恢复的会话）。 */
export const findPendingRecall = (project: SignProject): RecallSession | undefined =>
  project.recallSessions.find((session) => findBatch(project, session.batchId)?.status === "recalling");

export const getRecallProgress = (batch: PublishBatch, session: RecallSession) =>
  batch.signs.filter((snapshot) => session.decisions[snapshot.signId]).length;

export const isRecallResolved = (batch: PublishBatch, session: RecallSession) =>
  batch.signs.every(
    (snapshot) => session.decisions[snapshot.signId] === "keep" || session.decisions[snapshot.signId] === "restore",
  );

/** 该标识最近一次覆盖它的发布批次；撤回处理期间返回 recalling 批次，使其不显示为已发布。 */
export const findLatestBatchForSign = (project: SignProject, signId: string): PublishBatch | undefined => {
  const batches = project.batches.filter((batch) => batch.signs.some((snapshot) => snapshot.signId === signId));
  return (
    batches.find((batch) => batch.status === "recalling") ??
    batches.find((batch) => batch.status === "published") ??
    undefined
  );
};

const term = (source: string, target: string, confirmed = false, required = true): TermBinding => ({
  id: uid("term"),
  source,
  target,
  required,
  confirmed,
});

export const createSeedProject = (): SignProject => {
  const signs: SignItem[] = [
    {
      id: "sign-platform",
      code: "TR-01",
      sourceText: "候车区。请在黄线内排队，照看好随身物品。",
      targetLanguage: "English",
      targetText: "Waiting Area\nPlease queue behind the yellow line and keep your belongings with you.",
      scenario: "轨道交通站台",
      regulation: "GB/T 10001.1-2023 公共信息图形符号",
      status: "pending",
      terms: [term("候车区", "Waiting Area"), term("黄线", "yellow line")],
      comments: [],
      versions: [],
      emergencyRevision: false,
      updatedAt: "2026-09-21T09:20:00.000Z",
    },
    {
      id: "sign-exit",
      code: "EM-02",
      sourceText: "紧急出口。发生紧急情况时，请按指示方向迅速撤离，不要乘坐电梯。",
      targetLanguage: "English",
      targetText: "EMERGENCY EXIT\nIn an emergency, leave quickly in the direction shown. Do not use the elevator.",
      scenario: "商场疏散通道",
      regulation: "GB 13495.1-2015 消防安全标志",
      status: "confirmed",
      terms: [term("紧急出口", "EMERGENCY EXIT", true), term("电梯", "elevator", true)],
      comments: [],
      versions: [],
      emergencyRevision: false,
      updatedAt: "2026-09-18T06:10:00.000Z",
    },
    {
      id: "sign-water",
      code: "SV-03",
      sourceText: "直饮水。请勿将茶叶、果皮等杂物丢入水槽。",
      targetLanguage: "日本語",
      targetText: "飲料水\n茶殻や果物の皮などを流さないでください。",
      scenario: "公园服务亭",
      regulation: "城市公共设施双语标识译写规范",
      status: "changes",
      terms: [term("直饮水", "飲料水"), term("水槽", "排水口")],
      comments: [],
      versions: [],
      emergencyRevision: false,
      updatedAt: "2026-09-23T02:40:00.000Z",
    },
    {
      id: "sign-smoking",
      code: "PR-07",
      sourceText: "禁止吸烟。包括电子烟。",
      targetLanguage: "Français",
      targetText: "INTERDICTION DE FUMER\nCigarettes électroniques incluses.",
      scenario: "医院入口",
      regulation: "公共场所卫生管理条例实施细则",
      status: "draft",
      terms: [term("禁止吸烟", "INTERDICTION DE FUMER"), term("电子烟", "Cigarettes électroniques")],
      comments: [],
      versions: [],
      emergencyRevision: false,
      updatedAt: "2026-09-24T04:15:00.000Z",
    },
  ];

  return {
    id: "public-sign-review-1008",
    title: "城市公共标识多语言校对",
    location: "滨海交通枢纽一期",
    activeSignId: signs[0].id,
    signs,
    batches: [],
    recallSessions: [],
    updatedAt: new Date().toISOString(),
  };
};

/** 兼容早期没有发布批次字段的本地存档。 */
export const normalizeProject = (project: SignProject): SignProject => ({
  ...project,
  batches: project.batches ?? [],
  recallSessions: project.recallSessions ?? [],
});
