export type ReviewStatus = "draft" | "pending" | "confirmed" | "changes";

export interface Reply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
  replies: Reply[];
}

export interface TermBinding {
  id: string;
  source: string;
  target: string;
  required: boolean;
  confirmed: boolean;
}

export interface VersionSnapshot {
  id: string;
  label: string;
  createdAt: string;
  sourceText: string;
  targetText: string;
  status: ReviewStatus;
  terms: TermBinding[];
}

export interface SignItem {
  id: string;
  code: string;
  sourceText: string;
  targetLanguage: string;
  targetText: string;
  scenario: string;
  regulation: string;
  status: ReviewStatus;
  terms: TermBinding[];
  comments: ReviewComment[];
  versions: VersionSnapshot[];
  emergencyRevision: boolean;
  updatedAt: string;
}

export type BatchStatus = "published" | "recalling" | "recalled";

export type RecallDecision = "keep" | "restore";

/** 发布瞬间冻结的单条标识快照（含原文、译文、术语、意见与审校状态）。 */
export interface PublishedSignSnapshot {
  signId: string;
  code: string;
  sourceText: string;
  targetLanguage: string;
  targetText: string;
  scenario: string;
  regulation: string;
  status: ReviewStatus;
  terms: TermBinding[];
  comments: ReviewComment[];
}

export interface PublishBatch {
  id: string;
  label: string;
  createdAt: string;
  status: BatchStatus;
  signs: PublishedSignSnapshot[];
}

/** 撤回处理会话：逐条记录本机内容与发布版的取舍，未完成前批次不视为已撤回。 */
export interface RecallSession {
  id: string;
  batchId: string;
  startedAt: string;
  /** 发起撤回时的本机内容基线，用于逐条比对与中断后继续。 */
  baseline: PublishedSignSnapshot[];
  decisions: Record<string, RecallDecision>;
}

export interface SignProject {
  id: string;
  title: string;
  location: string;
  activeSignId: string;
  signs: SignItem[];
  batches: PublishBatch[];
  recallSessions: RecallSession[];
  updatedAt: string;
}

export interface PersistedProject {
  schema: 1;
  project: SignProject;
}

export interface DiffToken {
  type: "same" | "add" | "remove";
  value: string;
}
