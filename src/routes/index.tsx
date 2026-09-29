import { $, component$, useSignal, useVisibleTask$, type QRL } from "@builder.io/qwik";
import { type DocumentHead } from "@builder.io/qwik-city";
import {
  BATCH_STATUS_LABELS,
  RECALL_DECISION_LABELS,
  createBatch,
  createRecallSession,
  createSeedProject,
  findBatch,
  findLatestBatchForSign,
  findPendingRecall,
  findRecallSession,
  getRecallProgress,
  isRecallResolved,
  normalizeProject,
  restoreSnapshot,
  signFromSnapshot,
  snapshotMatchesSign,
  STATUS_LABELS,
  uid,
} from "../data";
import type { PublishBatch, RecallDecision, RecallSession, ReviewStatus, SignItem, SignProject } from "../types";
import { analyzeSign, cloneTerms, diffText } from "../utils";

const STORAGE_KEY = "sologsb-1008-project-v1";
const WIDTHS = [320, 480, 720, 960] as const;

export const head: DocumentHead = {
  title: "公共标识多语言校对台",
  meta: [
    { name: "description", content: "公共标识译文、术语、版本和版面风险校对工作台" },
  ],
};

function statusClass(status: ReviewStatus) {
  if (status === "confirmed") return "badge-success";
  if (status === "changes") return "badge-error";
  if (status === "pending") return "badge-warning";
  return "badge-neutral";
}

export default component$(() => {
  const project = useSignal<SignProject>(createSeedProject());
  const past = useSignal<SignProject[]>([]);
  const future = useSignal<SignProject[]>([]);
  const hydrated = useSignal(false);
  const online = useSignal(true);
  const previewWidth = useSignal(480);
  const previewFont = useSignal(42);
  const selectedVersionId = useSignal("");
  const termSource = useSignal("");
  const termTarget = useSignal("");
  const commentDraft = useSignal("");
  const replyDraft = useSignal("");
  const replyingTo = useSignal("");
  const toast = useSignal("");
  const previewId = useSignal("");
  const readOnly = useSignal(false);
  const selectedSignIds = useSignal<string[]>([]);
  const publishOpen = useSignal(false);
  const batchLabel = useSignal("");
  const recallSessionId = useSignal("");
  const active = () => project.value.signs.find((sign) => sign.id === (previewId.value || project.value.activeSignId)) ?? project.value.signs[0];

  const commit = $((label: string, update: (draft: SignProject) => void) => {
    past.value = [...past.value.slice(-49), structuredClone(project.value)];
    future.value = [];
    const draft = structuredClone(project.value);
    update(draft);
    draft.updatedAt = new Date().toISOString();
    project.value = draft;
  });

  const updateActive = $((label: string, update: (sign: SignItem, draft: SignProject) => void) => {
    commit(label, (draft) => {
      const sign = draft.signs.find((item) => item.id === draft.activeSignId);
      if (sign) update(sign, draft);
    });
  });

  const undo = $(() => {
    if (!past.value.length) return;
    const previous = past.value.at(-1)!;
    future.value = [structuredClone(project.value), ...future.value].slice(0, 50);
    past.value = past.value.slice(0, -1);
    project.value = previous;
    toast.value = "已撤销";
  });

  const redo = $(() => {
    if (!future.value.length) return;
    const next = future.value[0];
    past.value = [...past.value.slice(-49), structuredClone(project.value)];
    future.value = future.value.slice(1);
    project.value = next;
    toast.value = "已重做";
  });

  const navigateSign = $((direction: 1 | -1) => {
    if (readOnly.value) return;
    const signs = project.value.signs;
    const index = Math.max(0, signs.findIndex((sign) => sign.id === project.value.activeSignId));
    const next = signs[(index + direction + signs.length) % signs.length];
    commit("切换标识", (draft) => { draft.activeSignId = next.id; });
    selectedVersionId.value = "";
  });

  const setStatus = $((status: ReviewStatus) => {
    commit("更新审校状态", (draft) => {
      const sign = draft.signs.find((item) => item.id === draft.activeSignId);
      if (!sign) return;
      if (sign.emergencyRevision && status === "confirmed") {
        sign.status = "pending";
      } else {
        sign.status = status;
      }
    });
  });

  const toggleEmergency = $(() => {
    commit("切换紧急修订", (draft) => {
      const sign = draft.signs.find((item) => item.id === draft.activeSignId);
      if (!sign) return;
      sign.emergencyRevision = !sign.emergencyRevision;
      if (sign.emergencyRevision) sign.status = "changes";
    });
  });

  const saveVersion = $(() => {
    const sign = project.value.signs.find((item) => item.id === project.value.activeSignId);
    if (!sign) return;
    const versionId = uid("version");
    commit("保存版本快照", (draft) => {
      const current = draft.signs.find((item) => item.id === draft.activeSignId);
      if (!current) return;
      current.versions.unshift({
        id: versionId,
        label: `版本 ${current.versions.length + 1}`,
        createdAt: new Date().toISOString(),
        sourceText: current.sourceText,
        targetText: current.targetText,
        status: current.status,
        terms: cloneTerms(current.terms),
      });
      current.versions = current.versions.slice(0, 12);
    });
    selectedVersionId.value = versionId;
    toast.value = "版本快照已保存";
  });

  const addTerm = $(() => {
    const source = termSource.value.trim();
    const target = termTarget.value.trim();
    if (!source || !target) return;
    updateActive("绑定术语", (sign) => {
      sign.terms.push({ id: uid("term"), source, target, required: true, confirmed: false });
      sign.status = "pending";
    });
    termSource.value = "";
    termTarget.value = "";
  });

  const addComment = $(() => {
    const body = commentDraft.value.trim();
    if (!body) return;
    updateActive("添加审校意见", (sign) => {
      sign.comments.unshift({
        id: uid("comment"),
        author: "当前审校员",
        body,
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: [],
      });
      sign.status = sign.status === "confirmed" ? "changes" : sign.status;
    });
    commentDraft.value = "";
  });

  const addReply = $((commentId: string) => {
    const body = replyDraft.value.trim();
    if (!body) return;
    updateActive("回复审校意见", (sign) => {
      const comment = sign.comments.find((item) => item.id === commentId);
      comment?.replies.push({ id: uid("reply"), author: "当前审校员", body, createdAt: new Date().toISOString() });
    });
    replyDraft.value = "";
    replyingTo.value = "";
  });

  const sharePreview: QRL<() => void> = $(() => {
    const current = project.value.signs.find((item) => item.id === project.value.activeSignId);
    if (!current) return;
    const url = `${window.location.origin}${window.location.pathname}?preview=${encodeURIComponent(current.id)}`;
    void navigator.clipboard?.writeText(url).catch(() => undefined);
    toast.value = "只读预览链接已复制";
  });

  const toggleSelected = $((signId: string) => {
    selectedSignIds.value = selectedSignIds.value.includes(signId)
      ? selectedSignIds.value.filter((id) => id !== signId)
      : [...selectedSignIds.value, signId];
  });

  const openPublish = $(() => {
    if (findPendingRecall(project.value)) {
      toast.value = "请先处理完当前撤回批次";
      return;
    }
    if (!selectedSignIds.value.length) {
      toast.value = "请先勾选要发布的标识";
      return;
    }
    batchLabel.value = `第 ${project.value.batches.length + 1} 批 · ${new Date().toLocaleDateString()}`;
    publishOpen.value = true;
  });

  const confirmPublish = $(() => {
    const ids = selectedSignIds.value;
    const signs = project.value.signs.filter((sign) => ids.includes(sign.id));
    if (!signs.length) return;
    const batch = createBatch(signs, batchLabel.value || `第 ${project.value.batches.length + 1} 批`);
    commit("确认发布批次", (draft) => {
      draft.batches.unshift(batch);
    });
    publishOpen.value = false;
    selectedSignIds.value = [];
    toast.value = `已发布 ${batch.signs.length} 处标识，内容已冻结`;
  });

  const startRecall = $((batchId: string) => {
    if (findPendingRecall(project.value)) {
      toast.value = "请先处理完当前撤回批次";
      return;
    }
    const batch = project.value.batches.find((item) => item.id === batchId);
    if (!batch || batch.status !== "published") return;
    const session = createRecallSession(batch, project.value.signs);
    commit("发起发布撤回", (draft) => {
      const target = draft.batches.find((item) => item.id === batchId);
      if (target) target.status = "recalling";
      draft.recallSessions.unshift(session);
    });
    recallSessionId.value = session.id;
    toast.value = "批次已进入撤回处理，请逐条选择处理方式";
  });

  const resumeRecall = $((sessionId: string) => {
    recallSessionId.value = sessionId;
  });

  /**
   * 逐条处理：采用发布版会把发布快照还原到工作区；保留本机版则还原发起撤回时冻结的本机基线。
   * 两者都基于快照还原，因此选择可以反复修改且互不冲掉；本机撤回发起后再做的修改属于撤回处理范围。
   */
  const decideRecallItem = $((sessionId: string, signId: string, decision: RecallDecision) => {
    const batchId = project.value.recallSessions.find((session) => session.id === sessionId)?.batchId;
    const batch = project.value.batches.find((item) => item.id === batchId);
    const session = project.value.recallSessions.find((item) => item.id === sessionId);
    const published = batch?.signs.find((item) => item.signId === signId);
    const baseline = session?.baseline.find((item) => item.signId === signId);
    if (!batch || !session || !published || !baseline) return;
    commit("撤回逐条选择", (draft) => {
      const draftSession = draft.recallSessions.find((item) => item.id === sessionId);
      let sign = draft.signs.find((item) => item.id === signId);
      if (!draftSession) return;
      if (!sign) {
        // 该标识已在本机删除：仅在“采用发布版”时按发布快照重建。
        if (decision === "restore") {
          sign = signFromSnapshot(published);
          draft.signs.push(sign);
        }
      } else {
        restoreSnapshot(sign, decision === "restore" ? published : baseline);
      }
      draftSession.decisions[signId] = decision;
    });
  });

  const completeRecall = $(() => {
    const session = findRecallSession(project.value, recallSessionId.value);
    const batch = session ? findBatch(project.value, session.batchId) : undefined;
    if (!session || !batch) return;
    if (!isRecallResolved(batch, session)) {
      toast.value = "还有标识未选择处理方式";
      return;
    }
    commit("完成批次撤回", (draft) => {
      const target = draft.batches.find((item) => item.id === batch.id);
      if (target) target.status = "recalled";
      draft.recallSessions = draft.recallSessions.filter((item) => item.id !== session.id);
    });
    recallSessionId.value = "";
    toast.value = "批次已撤回";
  });

  const cancelRecallSession = $(() => {
    recallSessionId.value = "";
  });

  const preview = () => analyzeSign(active(), previewWidth.value, previewFont.value);
  const selectedVersion = () => active().versions.find((version) => version.id === selectedVersionId.value) ?? active().versions[0];
  const comparison = () => {
    const version = selectedVersion();
    return version ? diffText(version.targetText, active().targetText) : [];
  };

  useVisibleTask$(({ track }) => {
    track(() => hydrated.value);
    if (!hydrated.value) {
      try {
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "") as { schema: number; project: SignProject };
        if (stored.schema === 1 && stored.project?.signs?.length) {
          project.value = normalizeProject(stored.project);
          // 关页中断后回来：恢复尚未处理完的撤回会话（批次仍停留在“撤回处理中”，不显示为已发布）。
          const unfinished = project.value.recallSessions.find((session) => {
            const batch = project.value.batches.find((item) => item.id === session.batchId);
            return batch?.status === "recalling";
          });
          if (unfinished) recallSessionId.value = unfinished.id;
        }
        const requestedPreview = new URLSearchParams(window.location.search).get("preview") ?? "";
        previewId.value = requestedPreview;
        readOnly.value = Boolean(requestedPreview);
      } catch {
        // Keep bundled sample data when storage is unavailable or malformed.
      }
      hydrated.value = true;
    }
  });

  useVisibleTask$(({ track, cleanup }) => {
    track(() => hydrated.value);
    if (!hydrated.value) return;
    track(() => project.value);
    const timer = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ schema: 1, project: project.value }));
    }, 450);
    cleanup(() => window.clearTimeout(timer));
  });

  useVisibleTask$(({ cleanup }) => {
    const updateOnline = () => { online.value = navigator.onLine; };
    updateOnline();
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? undo() : undo();
      } else if (event.key.toLowerCase() === "j") {
        event.preventDefault();
        navigateSign(1);
      } else if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        navigateSign(-1);
      } else if (event.key === "[") {
        const index = WIDTHS.indexOf(previewWidth.value as (typeof WIDTHS)[number]);
        previewWidth.value = WIDTHS[Math.max(0, index - 1)];
      } else if (event.key === "]") {
        const index = WIDTHS.indexOf(previewWidth.value as (typeof WIDTHS)[number]);
        previewWidth.value = WIDTHS[Math.min(WIDTHS.length - 1, index + 1)];
      } else if (event.key === "-") {
        previewFont.value = Math.max(28, previewFont.value - 4);
      } else if (event.key === "=") {
        previewFont.value = Math.min(88, previewFont.value + 4);
      }
    };
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    window.addEventListener("keydown", keydown);
    cleanup(() => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
      window.removeEventListener("keydown", keydown);
    });
  });

  const pendingRecallSession = findPendingRecall(project.value);
  const pendingRecallBatch = pendingRecallSession
    ? findBatch(project.value, pendingRecallSession.batchId)
    : undefined;
  const publishSelection = publishOpen.value
    ? project.value.signs.filter((sign) => selectedSignIds.value.includes(sign.id))
    : [];
  const recallSession = findRecallSession(project.value, recallSessionId.value);
  const recallBatch = recallSession
    ? findBatch(project.value, recallSession.batchId)
    : undefined;

  if (readOnly.value) {
    const sign = active();
    const analysis = analyzeSign(sign, previewWidth.value, previewFont.value);
    return (
      <main data-theme="corporate" class="min-h-screen bg-slate-100 p-6">
        <div class="mx-auto max-w-5xl">
          <div class="mb-4 flex items-center justify-between">
            <div>
              <div class="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Read-only preview</div>
              <h1 class="text-2xl font-bold text-slate-800">{sign.code} · {sign.scenario}</h1>
            </div>
            <span class={`badge ${statusClass(sign.status)}`}>{STATUS_LABELS[sign.status]}</span>
          </div>
          <section class="rounded-3xl bg-white p-14 shadow-xl">
            <div class="mb-3 text-center text-xs text-slate-400">中文原文</div>
            <p class="mx-auto mb-10 max-w-2xl text-center text-lg text-slate-600">{sign.sourceText}</p>
            <div class="mx-auto border-y-4 border-slate-800 py-10 text-center">
              <p class="whitespace-pre-line font-black leading-tight tracking-wide text-slate-900" style={{ fontSize: `${previewFont.value}px` }}>{analysis.visible.join("\n")}</p>
            </div>
            <div class="mt-5 text-center text-sm text-slate-500">{sign.targetLanguage} · {sign.regulation}</div>
          </section>
          <p class="mt-4 text-center text-xs text-slate-400">此链接读取当前浏览器中的本地版本，仅用于演示只读预览。</p>
        </div>
      </main>
    );
  }

  return (
    <div data-theme="corporate" class="min-h-screen bg-slate-100 pb-9 text-slate-800">
      <header class="navbar sticky top-0 z-40 min-h-16 border-b border-slate-700 bg-[#17324d] px-5 text-white shadow-lg">
        <div class="navbar-start gap-3">
          <div class="grid h-10 w-10 place-items-center rounded-xl border border-white/20 bg-white/10 font-black">译</div>
          <div>
            <div class="text-xs uppercase tracking-[0.2em] text-sky-200">Public Sign Review</div>
            <div class="font-bold">公共标识多语言校对台</div>
          </div>
        </div>
        <div class="navbar-center hidden xl:flex">
          <input
            class="input input-sm w-80 border-white/15 bg-white/10 text-white placeholder:text-slate-300"
            value={project.value.title}
            onInput$={(_, element) => commit("修改项目名称", (draft) => { draft.title = element.value; })}
            aria-label="项目名称"
          />
        </div>
        <div class="navbar-end gap-2">
          <span class={`badge ${online.value ? "badge-success" : "badge-warning"} badge-outline`}>{online.value ? "在线" : "离线草稿"}</span>
          <button class="btn btn-ghost btn-sm" disabled={!past.value.length} onClick$={undo}>撤销</button>
          <button class="btn btn-ghost btn-sm" disabled={!future.value.length} onClick$={redo}>重做</button>
          <button class="btn btn-sm border-white/20 bg-white/10 text-white hover:bg-white/20" onClick$={sharePreview}>复制只读链接</button>
          <button class={`btn btn-sm ${active().emergencyRevision ? "btn-error" : "btn-warning"}`} onClick$={toggleEmergency}>
            {active().emergencyRevision ? "退出紧急修订" : "紧急修订"}
          </button>
        </div>
      </header>

      {active().emergencyRevision && (
        <div class="alert alert-error sticky top-16 z-30 rounded-none border-x-0 py-2 text-white">
          <span class="text-lg">!</span>
          <span><strong>紧急修订模式</strong>：确认操作已锁定，修改后必须重新审校并保存版本。</span>
        </div>
      )}

      {pendingRecallSession && pendingRecallBatch && (
        <div class="alert alert-warning sticky top-16 z-30 rounded-none border-x-0 py-2">
          <span class="text-lg">↩</span>
          <span class="flex-1">
            批次 <strong>{pendingRecallBatch.label}</strong> 正在撤回处理：已处理 {getRecallProgress(pendingRecallBatch, pendingRecallSession)}/{pendingRecallBatch.signs.length}。
            处理完成前该批次不会显示为已发布。
          </span>
          {recallSessionId.value !== pendingRecallSession.id && (
            <button class="btn btn-sm btn-warning" onClick$={() => resumeRecall(pendingRecallSession!.id)}>继续处理</button>
          )}
        </div>
      )}

      <div class="grid min-h-[calc(100vh-64px)] grid-cols-[270px_minmax(560px,1fr)_430px] gap-px bg-slate-300">
        <aside class="flex flex-col overflow-y-auto bg-slate-50 p-3">
          <div class="mb-3 rounded-xl bg-white p-4 shadow-sm">
            <div class="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">标识清单</div>
            <div class="mt-1 text-lg font-bold text-slate-800">{project.value.signs.length} 处标识</div>
            <p class="mt-1 text-xs leading-5 text-slate-500">{project.value.location}</p>
          </div>
          <div class="flex-1 space-y-2 pb-3">
            {project.value.signs.map((sign, index) => {
              const risk = analyzeSign(sign, previewWidth.value, previewFont.value);
              const checked = selectedSignIds.value.includes(sign.id);
              const batch = findLatestBatchForSign(project.value, sign.id);
              const recallLocked = Boolean(pendingRecallSession);
              return (
                <div
                  key={sign.id}
                  class={`relative rounded-xl border p-3 pr-9 transition ${sign.id === project.value.activeSignId ? "border-blue-400 bg-blue-50 shadow-sm" : "border-slate-200 bg-white hover:border-slate-300"} ${checked ? "ring-2 ring-blue-500" : ""}`}
                >
                  <button
                    class="block w-full text-left"
                    onClick$={() => {
                      commit("切换标识", (draft) => { draft.activeSignId = sign.id; });
                      selectedVersionId.value = "";
                    }}
                  >
                    <div class="flex items-center justify-between gap-2">
                      <span class="font-mono text-xs font-bold text-slate-500">{sign.code}</span>
                      <span class={`badge badge-sm ${statusClass(sign.status)}`}>{STATUS_LABELS[sign.status]}</span>
                    </div>
                    <div class="mt-2 line-clamp-2 text-sm font-semibold text-slate-700">{sign.sourceText}</div>
                    <div class="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                      <span>{sign.targetLanguage}</span>
                      <span class={risk.risk === "high" ? "font-bold text-error" : risk.risk === "medium" ? "font-bold text-warning" : "text-success"}>
                        {risk.risk === "high" ? "高风险" : risk.risk === "medium" ? "需留意" : "版面正常"}
                      </span>
                    </div>
                    {batch && (
                      <div class={`mt-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold ${batch.status === "recalling" ? "bg-error/10 text-error" : "bg-success/10 text-success"}`}>
                        <span>{batch.status === "recalling" ? "↩ " : "● "}</span>
                        {BATCH_STATUS_LABELS[batch.status]}
                      </div>
                    )}
                    <span class="sr-only">第 {index + 1} 条</span>
                  </button>
                  <input
                    type="checkbox"
                    class="checkbox checkbox-sm absolute right-2 top-2"
                    aria-label={`选择标识 ${sign.code} 加入发布批次`}
                    title={recallLocked ? "撤回处理期间不能发布新批次" : "加入发布批次"}
                    checked={checked}
                    disabled={recallLocked}
                    onChange$={() => toggleSelected(sign.id)}
                  />
                </div>
              );
            })}
          </div>
          <div class="sticky bottom-0 -mx-3 border-t border-slate-200 bg-white/95 p-3 backdrop-blur">
            {pendingRecallSession ? (
              <div class="rounded-lg bg-error/10 p-2 text-center text-xs font-bold text-error">撤回处理中，暂不能发布新批次</div>
            ) : (
              <div class="space-y-2">
                <div class="text-xs text-slate-500">已选 <strong class="text-slate-800">{selectedSignIds.value.length}</strong> 处标识，发布时冻结整组译文、术语、意见与状态。</div>
                <div class="flex gap-2">
                  <button class="btn btn-sm flex-1 btn-primary" disabled={!selectedSignIds.value.length} onClick$={openPublish}>批量确认发布</button>
                  <button class="btn btn-sm btn-ghost" disabled={!selectedSignIds.value.length} onClick$={() => { selectedSignIds.value = []; }}>清空</button>
                </div>
              </div>
            )}
          </div>
        </aside>

        <main class="min-w-0 bg-white">
          <div class="border-b border-slate-200 bg-slate-50 px-6 py-4">
            <div class="flex items-start justify-between gap-5">
              <div>
                <div class="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">{active().code} · {active().scenario}</div>
                <h1 class="mt-1 text-xl font-bold">中文原文与译文校对</h1>
              </div>
              <div class="join">
                {(["draft", "pending", "changes", "confirmed"] as ReviewStatus[]).map((status) => (
                  <button key={status} class={`btn join-item btn-sm ${active().status === status ? "btn-primary" : "btn-outline"}`} onClick$={() => setStatus(status)}>{STATUS_LABELS[status]}</button>
                ))}
              </div>
            </div>
          </div>

          <div class="space-y-5 p-6">
            <section class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body gap-4 p-5">
                <div class="flex items-center justify-between">
                  <div><div class="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Source</div><h2 class="font-bold">中文原文</h2></div>
                  <span class="badge badge-ghost">简体中文</span>
                </div>
                <textarea
                  class="textarea textarea-bordered min-h-24 w-full text-base leading-7"
                  value={active().sourceText}
                  onInput$={(_, element) => updateActive("修改中文原文", (sign) => { sign.sourceText = element.value; sign.status = "draft"; })}
                />
              </div>
            </section>

            <section class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body gap-4 p-5">
                <div class="grid grid-cols-2 gap-4">
                  <label class="form-control">
                    <span class="label-text mb-1 text-xs font-bold text-slate-500">目标语言</span>
                    <select class="select select-bordered" value={active().targetLanguage} onChange$={(_, element) => updateActive("修改目标语言", (sign) => { sign.targetLanguage = element.value; sign.status = "pending"; })}>
                      {["English", "日本語", "Français", "Deutsch", "한국어", "Español"].map((language) => <option key={language}>{language}</option>)}
                    </select>
                  </label>
                  <label class="form-control">
                    <span class="label-text mb-1 text-xs font-bold text-slate-500">适用场景</span>
                    <input class="input input-bordered" value={active().scenario} onInput$={(_, element) => updateActive("修改适用场景", (sign) => { sign.scenario = element.value; })} />
                  </label>
                </div>
                <label class="form-control">
                  <span class="label-text mb-1 text-xs font-bold text-slate-500">法规或规范提示</span>
                  <input class="input input-bordered" value={active().regulation} onInput$={(_, element) => updateActive("修改法规提示", (sign) => { sign.regulation = element.value; })} />
                </label>
                <div class="divider my-0"></div>
                <div class="flex items-center justify-between">
                  <div><div class="text-xs font-bold uppercase tracking-[0.16em] text-blue-500">Target</div><h2 class="font-bold">目标语言译文</h2></div>
                  <button class="btn btn-sm btn-outline" onClick$={saveVersion}>保存版本快照</button>
                </div>
                <textarea
                  class="textarea textarea-bordered min-h-36 w-full text-lg leading-8"
                  value={active().targetText}
                  onInput$={(_, element) => updateActive("修改译文", (sign) => { sign.targetText = element.value; sign.status = sign.emergencyRevision ? "changes" : "pending"; })}
                />
                <div class="flex flex-wrap gap-2">
                  {active().terms.map((term) => {
                    const matched = active().targetText.toLocaleLowerCase().includes(term.target.toLocaleLowerCase());
                    return (
                      <button
                        key={term.id}
                        title="点击切换术语确认状态"
                        class={`badge badge-lg gap-1 ${matched && term.confirmed ? "badge-success" : matched ? "badge-warning" : "badge-error"}`}
                        onClick$={() => updateActive("确认术语", (sign) => {
                          const current = sign.terms.find((item) => item.id === term.id);
                          if (current) current.confirmed = !current.confirmed;
                        })}
                      >
                        {term.source} → {term.target} {matched ? (term.confirmed ? "✓" : "!") : "×"}
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>

            <section class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body p-5">
                <div class="flex items-center justify-between">
                  <div><h2 class="font-bold">术语绑定</h2><p class="text-xs text-slate-500">必选术语未出现在译文中时会实时告警。</p></div>
                  <span class="badge badge-outline">{active().terms.length} 条</span>
                </div>
                <div class="mt-4 grid grid-cols-[1fr_1fr_auto] gap-2">
                  <input class="input input-sm input-bordered" placeholder="中文术语" value={termSource.value} onInput$={(_, element) => termSource.value = element.value} />
                  <input class="input input-sm input-bordered" placeholder="目标语言固定译法" value={termTarget.value} onInput$={(_, element) => termTarget.value = element.value} />
                  <button class="btn btn-sm btn-primary" onClick$={addTerm}>绑定</button>
                </div>
                <div class="mt-3 grid gap-2 md:grid-cols-2">
                  {active().terms.map((term) => (
                    <div key={term.id} class="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                      <div class="min-w-0">
                        <div class="truncate text-xs font-bold">{term.source}</div>
                        <div class="truncate text-xs text-slate-500">{term.target}</div>
                      </div>
                      <div class="flex gap-1">
                        <button class={`btn btn-xs ${term.confirmed ? "btn-success" : "btn-ghost"}`} onClick$={() => updateActive("确认术语", (sign) => { const target = sign.terms.find((item) => item.id === term.id); if (target) target.confirmed = !target.confirmed; })}>确认</button>
                        <button class="btn btn-xs btn-ghost text-error" onClick$={() => updateActive("删除术语", (sign) => { sign.terms = sign.terms.filter((item) => item.id !== term.id); })}>删除</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body p-5">
                <h2 class="font-bold">审校意见与回复</h2>
                <div class="mt-3 flex gap-2">
                  <textarea class="textarea textarea-bordered min-h-20 flex-1" placeholder="记录措辞、文化适配或法规依据…" value={commentDraft.value} onInput$={(_, element) => commentDraft.value = element.value} />
                  <button class="btn btn-primary self-end" onClick$={addComment}>添加意见</button>
                </div>
                <div class="mt-4 space-y-3">
                  {active().comments.length === 0 && <div class="rounded-xl border border-dashed p-6 text-center text-sm text-slate-400">还没有审校意见。</div>}
                  {active().comments.map((comment) => (
                    <article key={comment.id} class={`rounded-xl border-l-4 bg-slate-50 p-3 ${comment.resolved ? "border-success opacity-60" : "border-warning"}`}>
                      <div class="flex items-center justify-between text-xs"><strong>{comment.author}</strong><span class="text-slate-400">{new Date(comment.createdAt).toLocaleString()}</span></div>
                      <p class="my-2 text-sm">{comment.body}</p>
                      {comment.replies.map((reply) => (
                        <div key={reply.id} class="ml-4 my-1 border-l-2 border-slate-200 pl-3 text-xs"><strong>{reply.author}</strong>：{reply.body}</div>
                      ))}
                      {replyingTo.value === comment.id ? (
                        <div class="mt-2 flex gap-2">
                          <input class="input input-xs input-bordered flex-1" value={replyDraft.value} onInput$={(_, element) => replyDraft.value = element.value} />
                          <button class="btn btn-xs btn-primary" onClick$={() => addReply(comment.id)}>发送</button>
                        </div>
                      ) : (
                        <div class="mt-2 flex gap-2">
                          <button class="btn btn-xs btn-ghost" onClick$={() => { replyingTo.value = comment.id; }}>回复</button>
                          <button class="btn btn-xs btn-ghost" onClick$={() => updateActive("更新意见状态", (sign) => { const item = sign.comments.find((entry) => entry.id === comment.id); if (item) item.resolved = !item.resolved; })}>{comment.resolved ? "重新打开" : "标记已解决"}</button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </div>
            </section>
          </div>
        </main>

        <aside class="overflow-y-auto bg-slate-50 p-4">
          <section class="sticky top-4 space-y-4">
            <div class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body p-4">
                <div class="flex items-center justify-between">
                  <div><div class="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Live Preview</div><h2 class="font-bold">版面实时预览</h2></div>
                  <span class={`badge ${preview().risk === "high" ? "badge-error" : preview().risk === "medium" ? "badge-warning" : "badge-success"}`}>
                    {preview().risk === "high" ? "溢出风险" : preview().risk === "medium" ? "接近边界" : "版面安全"}
                  </span>
                </div>
                <div class="mt-3 flex gap-1">
                  {WIDTHS.map((width) => <button key={width} class={`btn btn-xs flex-1 ${previewWidth.value === width ? "btn-primary" : "btn-outline"}`} onClick$={() => previewWidth.value = width}>{width}px</button>)}
                </div>
                <div class="mt-2 flex items-center gap-3 text-xs">
                  <span class="w-20">字号 {previewFont.value}px</span>
                  <input type="range" min="28" max="88" step="2" class="range range-primary range-xs flex-1" value={previewFont.value} onInput$={(_, element) => previewFont.value = Number(element.value)} />
                </div>
                <div class="mt-4 overflow-hidden rounded-xl bg-slate-800 p-3">
                  <div class="mx-auto grid min-h-48 place-items-center overflow-hidden border-4 border-white bg-[#174f3d] p-3 text-center text-white" style={{ width: `${previewWidth.value}px`, maxWidth: "100%" }}>
                    <div>
                      <div style={{ fontSize: `${previewFont.value}px` }} class="font-black leading-[1.18] tracking-wide">{preview().visible.map((line, index) => <div key={index}>{line || "\u00a0"}</div>)}</div>
                    </div>
                  </div>
                </div>
                <div class="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                  <div class="rounded-lg bg-slate-100 p-2"><strong class="block text-lg">{preview().lines.length}</strong><span>预计行数</span></div>
                  <div class="rounded-lg bg-slate-100 p-2"><strong class="block text-lg">{active().targetText.length}</strong><span>字符数</span></div>
                  <div class="rounded-lg bg-slate-100 p-2"><strong class={`block text-lg ${preview().missingTerms.length ? "text-error" : "text-success"}`}>{preview().missingTerms.length}</strong><span>缺失术语</span></div>
                </div>
                {(preview().overflow || preview().tooLong) && <div class="alert alert-error mt-3 py-2 text-xs">{preview().overflow ? "当前字号下内容超过三行，可能截断。" : "译文接近标识建议字符上限。"}</div>}
              </div>
            </div>

            <div class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body p-4">
                <div class="flex items-center justify-between">
                  <div><h2 class="font-bold">版本比较</h2><p class="text-xs text-slate-500">旧版快照与当前译文逐词对比。</p></div>
                  <span class="badge badge-outline">{active().versions.length} 版</span>
                </div>
                {active().versions.length ? (
                  <>
                    <select class="select select-sm select-bordered mt-3 w-full" value={selectedVersionId.value || active().versions[0].id} onChange$={(_, element) => selectedVersionId.value = element.value}>
                      {active().versions.map((version) => <option key={version.id} value={version.id}>{`${version.label} · ${new Date(version.createdAt).toLocaleTimeString()}`}</option>)}
                    </select>
                    <div class="mt-3 rounded-lg bg-slate-900 p-3 text-sm leading-7 text-slate-100">
                      {comparison().map((token, index) => (
                        <span key={index} class={token.type === "add" ? "rounded bg-green-400/25 text-green-200" : token.type === "remove" ? "bg-red-400/25 text-red-200 line-through" : ""}>{token.value}</span>
                      ))}
                    </div>
                    <div class="mt-2 flex gap-3 text-[11px]"><span class="text-green-700">绿：新增</span><span class="text-red-700">红：删除</span></div>
                  </>
                ) : (
                  <div class="mt-3 rounded-xl border border-dashed p-5 text-center text-xs text-slate-400">保存当前译文后会在这里生成可比较版本。</div>
                )}
              </div>
            </div>

            <div class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body p-4">
                <div class="flex items-center justify-between">
                  <div>
                    <h2 class="font-bold">发布批次</h2>
                    <p class="text-xs text-slate-500">批量确认即冻结整组内容，后续可撤回任一发布点。</p>
                  </div>
                  <span class="badge badge-outline">{project.value.batches.length} 批</span>
                </div>
                {project.value.batches.length === 0 ? (
                  <div class="mt-3 rounded-xl border border-dashed p-5 text-center text-xs text-slate-400">
                    在左侧勾选标识后批量确认，将生成第一个发布批次。
                  </div>
                ) : (
                  <div class="mt-3 space-y-2">
                    {project.value.batches.map((batch) => (
                      <div key={batch.id} class="rounded-xl border border-slate-200 p-3">
                        <div class="flex items-center justify-between gap-2">
                          <div class="min-w-0">
                            <div class="truncate text-sm font-bold">{batch.label}</div>
                            <div class="text-[11px] text-slate-400">{new Date(batch.createdAt).toLocaleString()} · {batch.signs.length} 处</div>
                          </div>
                          <span class={`badge badge-sm ${batch.status === "published" ? "badge-success" : batch.status === "recalling" ? "badge-error" : "badge-ghost"}`}>
                            {BATCH_STATUS_LABELS[batch.status]}
                          </span>
                        </div>
                        <div class="mt-2 flex flex-wrap gap-1">
                          {batch.signs.map((snapshot) => (
                            <span key={snapshot.signId} class="badge badge-xs badge-ghost font-mono">{snapshot.code}</span>
                          ))}
                        </div>
                        {batch.status === "published" && (
                          <button class="btn btn-xs btn-outline btn-error mt-2 w-full" disabled={Boolean(pendingRecallSession)} onClick$={() => startRecall(batch.id)}>
                            撤回此发布点
                          </button>
                        )}
                        {batch.status === "recalling" && (
                          <button class="btn btn-xs btn-error mt-2 w-full" onClick$={() => {
                            const session = project.value.recallSessions.find((item) => item.batchId === batch.id);
                            if (session) resumeRecall(session.id);
                          }}>
                            继续撤回处理
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div class="rounded-xl bg-[#17324d] p-4 text-xs text-slate-200">
              <div class="mb-2 font-bold text-white">键盘操作</div>
              <div class="grid grid-cols-2 gap-y-1"><span><kbd class="kbd kbd-xs">J/K</kbd> 切换标识</span><span><kbd class="kbd kbd-xs">[ ]</kbd> 预览宽度</span><span><kbd class="kbd kbd-xs">- =</kbd> 字号</span><span><kbd class="kbd kbd-xs">Ctrl/⌘ Z</kbd> 撤销</span></div>
            </div>
          </section>
        </aside>
      </div>

      {false && publishOpen.value && (
        <div class="modal modal-open z-50" role="dialog" aria-modal="true" aria-label="确认发布批次">
          <div class="modal-box max-w-2xl">
            <h3 class="text-lg font-bold">确认发布批次</h3>
            <p class="py-2 text-sm text-slate-500">
              发布后将冻结这 {publishSelection.length} 处标识的原文、译文、术语、审校意见与审校状态。后续发现术语译错时，可从发布批次整批撤回。
            </p>
            <label class="form-control mt-2">
              <span class="label-text text-xs font-bold text-slate-500">批次名称</span>
              <input class="input input-bordered input-sm mt-1" value={batchLabel.value} onInput$={(_, element) => { batchLabel.value = element.value; }} />
            </label>
            <div class="mt-3 max-h-60 space-y-1 overflow-y-auto rounded-xl border border-slate-200 p-2">
              {publishSelection.map((sign) => (
                <div key={sign.id} class="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
                  <span class="font-mono text-xs font-bold text-slate-500">{sign.code}</span>
                  <span class="flex-1 truncate">{sign.sourceText}</span>
                  <span class={`badge badge-xs ${statusClass(sign.status)}`}>{STATUS_LABELS[sign.status]}</span>
                </div>
              ))}
            </div>
            <div class="modal-action">
              <button class="btn btn-ghost btn-sm" onClick$={() => { publishOpen.value = false; }}>取消</button>
              <button class="btn btn-primary btn-sm" onClick$={confirmPublish}>确认冻结并发布</button>
            </div>
          </div>
          <div class="modal-backdrop" onClick$={() => { publishOpen.value = false; }} />
        </div>
      )}

      {recallSession && recallBatch && (
        <div class="modal modal-open z-50" role="dialog" aria-modal="true" aria-label="撤回发布批次处理">
          <div class="modal-box max-w-4xl">
            <div class="flex items-start justify-between gap-4">
              <div>
                <h3 class="text-lg font-bold">撤回发布批次 · {recallBatch.label}</h3>
                <p class="mt-1 text-sm text-slate-500">
                  逐条选择：<strong class="text-error">采用发布版</strong>会用发布时冻结的译文、术语、意见和审校状态还原该条；
                  <strong class="text-slate-700">保留本机版</strong>会还原发起撤回时记录的本机内容，不会冲掉你的未发布修改。两个选择可反复切换，随时关闭页面，进度会保存并可继续。
                </p>
              </div>
              <span class={`badge badge-sm ${getRecallProgress(recallBatch, recallSession) === recallBatch.signs.length ? "badge-success" : "badge-error"}`}>{getRecallProgress(recallBatch, recallSession)}/{recallBatch.signs.length}</span>
            </div>
            <div class="mt-4 max-h-[55vh] space-y-3 overflow-y-auto pr-1">
              {recallBatch.signs.map((snapshot) => {
                const current = project.value.signs.find((sign) => sign.id === snapshot.signId);
                const decision = recallSession.decisions[snapshot.signId];
                const identical = snapshotMatchesSign(snapshot, current);
                const tokens = current ? diffText(snapshot.targetText, current.targetText) : [];
                return (
                  <article key={snapshot.signId} class={`rounded-xl border p-3 ${decision ? "border-success/50 bg-success/5" : "border-slate-300 bg-white"}`}>
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <div class="text-sm">
                        <span class="font-mono text-xs font-bold text-slate-500">{snapshot.code}</span>
                        <span class="ml-2 font-semibold">{snapshot.sourceText}</span>
                      </div>
                      <div class="flex items-center gap-2">
                        {identical && <span class="badge badge-xs badge-ghost">本机与发布版一致</span>}
                        <span class={`badge badge-xs ${decision ? "badge-success" : "badge-warning"}`}>
                          {decision ? RECALL_DECISION_LABELS[decision] : "待选择"}
                        </span>
                      </div>
                    </div>
                    <div class="mt-2 grid gap-2 md:grid-cols-2">
                      <div class="rounded-lg border border-slate-200 bg-slate-50 p-2">
                        <div class="mb-1 flex items-center justify-between text-[11px] font-bold text-slate-500">
                          <span>发布版（{new Date(recallBatch.createdAt).toLocaleDateString()} 冻结）</span>
                          <span class={`badge badge-xs ${statusClass(snapshot.status)}`}>{STATUS_LABELS[snapshot.status]}</span>
                        </div>
                        <p class="whitespace-pre-line text-xs leading-5">{snapshot.targetText}</p>
                        <div class="mt-1 flex flex-wrap gap-1">
                          {snapshot.terms.map((term) => (
                            <span key={term.id} class="badge badge-xs badge-ghost">{term.source}→{term.target}</span>
                          ))}
                        </div>
                        <div class="mt-1 text-[11px] text-slate-400">审校意见 {snapshot.comments.length} 条</div>
                      </div>
                      <div class="rounded-lg border border-slate-200 bg-white p-2">
                        <div class="mb-1 flex items-center justify-between text-[11px] font-bold text-slate-500">
                          <span>本机当前（未发布）</span>
                          {current && <span class={`badge badge-xs ${statusClass(current.status)}`}>{STATUS_LABELS[current.status]}</span>}
                        </div>
                        {current ? (
                          <>
                            <div class="whitespace-pre-line text-xs leading-5">
                              {tokens.map((token, index) => (
                                <span key={index} class={token.type === "add" ? "rounded bg-green-200/70 text-green-900" : token.type === "remove" ? "bg-red-200/70 text-red-900 line-through" : ""}>{token.value}</span>
                              ))}
                            </div>
                            <div class="mt-1 flex flex-wrap gap-1">
                              {current.terms.map((term) => (
                                <span key={term.id} class="badge badge-xs badge-ghost">{term.source}→{term.target}</span>
                              ))}
                            </div>
                            <div class="mt-1 text-[11px] text-slate-400">审校意见 {current.comments.length} 条</div>
                          </>
                        ) : (
                          <div class="text-xs text-error">该标识已在本机删除。</div>
                        )}
                      </div>
                    </div>
                    <div class="mt-2 flex gap-2">
                      <button
                        class={`btn btn-sm flex-1 ${decision === "restore" ? "btn-error" : "btn-outline btn-error"}`}
                        onClick$={() => decideRecallItem(recallSession.id, snapshot.signId, "restore")}
                      >
                        采用发布版（还原该条）
                      </button>
                      <button
                        class={`btn btn-sm flex-1 ${decision === "keep" ? "btn-primary" : "btn-outline"}`}
                        onClick$={() => decideRecallItem(recallSession.id, snapshot.signId, "keep")}
                      >
                        保留本机版
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
            <div class="modal-action">
              <button class="btn btn-ghost btn-sm" onClick$={cancelRecallSession}>稍后继续（关闭，进度保留）</button>
              <button class="btn btn-primary btn-sm" disabled={getRecallProgress(recallBatch, recallSession) !== recallBatch.signs.length} onClick$={completeRecall}>
                全部处理完，完成撤回
              </button>
            </div>
          </div>
        </div>
      )}

      {toast.value && <div class="toast toast-end z-[60]"><div class="alert alert-success"><span>{toast.value}</span></div></div>}
    </div>
  );
});
