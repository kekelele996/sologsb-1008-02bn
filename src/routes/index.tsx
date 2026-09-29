import { $, component$, useSignal, useVisibleTask$, type QRL } from "@builder.io/qwik";
import { type DocumentHead } from "@builder.io/qwik-city";
import { createSeedProject, STATUS_LABELS, uid } from "../data";
import type { ReleaseBatch, ReleaseState, ReviewStatus, SignItem, SignProject, SignSnapshot, WithdrawDecision } from "../types";
import { analyzeSign, applySnapshot, captureSnapshot, cloneTerms, diffText, hasLocalChanges } from "../utils";

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

const RELEASE_STATE_LABEL: Record<ReleaseState, string> = {
  published: "已发布",
  withdrawing: "撤回处理中",
  withdrawn: "已撤回",
};

function releaseStateClass(state: ReleaseState) {
  if (state === "published") return "badge-success";
  if (state === "withdrawing") return "badge-warning";
  return "badge-ghost";
}

const formatTime = (value: string) => new Date(value).toLocaleString();

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
  const releasesOpen = useSignal(false);
  const activeReleaseId = useSignal<string | null>(null);
  const active = () => project.value.signs.find((sign) => sign.id === (previewId.value || project.value.activeSignId)) ?? project.value.signs[0];

  /** 找到一条标识所属的最新发布点：撤回处理中的批次优先，其次才是已发布，已撤回批次不再算作已发布。 */
  const signRelease = (signId: string): ReleaseBatch | undefined => {
    const contains = project.value.releases.filter(
      (release) => release.state !== "withdrawn" && release.snapshots.some((snapshot) => snapshot.signId === signId),
    );
    return contains.find((release) => release.state === "withdrawing") ?? contains[0];
  };

  const activeRelease = () =>
    activeReleaseId.value ? project.value.releases.find((release) => release.id === activeReleaseId.value) : undefined;

  /** 撤回处理清单：冻结版与本机当前内容比对，无本机修改的条目自动“采用”，有冲突待逐条选择。 */
  const withdrawItems = (release: ReleaseBatch) =>
    release.snapshots.map((snapshot) => {
      const sign = project.value.signs.find((item) => item.id === snapshot.signId);
      const conflict = hasLocalChanges(sign, snapshot);
      const decision = release.decisions[snapshot.signId] ?? (conflict ? undefined : "adopt");
      return { snapshot, sign, conflict, decision: decision as WithdrawDecision | undefined, resolved: Boolean(decision) };
    });

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

  // —— 发布批次：批量确认时冻结整组标识，之后可按发布点撤回 ——

  const toggleSelectSign = $((signId: string) => {
    selectedSignIds.value = selectedSignIds.value.includes(signId)
      ? selectedSignIds.value.filter((id) => id !== signId)
      : [...selectedSignIds.value, signId];
  });

  const toggleSelectAll = $(() => {
    selectedSignIds.value = selectedSignIds.value.length === project.value.signs.length
      ? []
      : project.value.signs.map((sign) => sign.id);
  });

  const publishBatch = $(() => {
    const ids = selectedSignIds.value;
    if (!ids.length) return;
    const selected = project.value.signs.filter((sign) => ids.includes(sign.id));
    if (!selected.length) return;
    const batchId = uid("release");
    const now = new Date();
    const name = `发布批次 · ${now.toLocaleDateString()} ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    commit("批量确认并发布", (draft) => {
      draft.releases.unshift({
        id: batchId,
        name,
        publishedAt: now.toISOString(),
        state: "published",
        decisions: {},
        snapshots: selected.map((sign) => {
          const target = draft.signs.find((item) => item.id === sign.id)!;
          // 批量确认：组内标识统一置为已确认后再冻结，保证冻结版即发布版。
          target.status = "confirmed";
          return captureSnapshot(target);
        }),
      });
    });
    selectedSignIds.value = [];
    activeReleaseId.value = batchId;
    releasesOpen.value = true;
    toast.value = `已冻结并发布 ${selected.length} 条标识`;
  });

  const openRelease = $((releaseId: string) => {
    activeReleaseId.value = releaseId;
    releasesOpen.value = true;
  });

  const closeReleases = $(() => {
    releasesOpen.value = false;
    activeReleaseId.value = null;
  });

  /** 发起撤回：进入“撤回处理中”，未处理完之前该批不再显示为已发布。 */
  const startWithdraw = $((releaseId: string) => {
    commit("撤回发布批次", (draft) => {
      const release = draft.releases.find((item) => item.id === releaseId);
      if (!release || release.state !== "published") return;
      release.state = "withdrawing";
      release.withdrawStartedAt = new Date().toISOString();
      release.snapshots.forEach((snapshot) => {
        const sign = draft.signs.find((item) => item.id === snapshot.signId);
        if (sign && !hasLocalChanges(sign, snapshot)) release.decisions[snapshot.signId] = "adopt";
      });
    });
    toast.value = "批次已进入撤回处理，请逐条确认采用或保留";
  });

  /** 处理列表中逐条选择：采用该批冻结版，或保留本机未发布修改。选择随项目持久化，关页可续。 */
  const chooseWithdraw = $((releaseId: string, signId: string, decision: WithdrawDecision) => {
    commit("记录撤回处理选择", (draft) => {
      const release = draft.releases.find((item) => item.id === releaseId);
      if (release) release.decisions[signId] = decision;
    });
  });

  /** 全部条目处理完后整批落地：采用冻结版的条目整组还原译文、原文、术语、意见和审校状态。 */
  const finishWithdraw = $((releaseId: string) => {
    let unresolved = 0;
    project.value.releases
      .find((item) => item.id === releaseId)
      ?.snapshots.forEach((snapshot) => {
        const sign = project.value.signs.find((item) => item.id === snapshot.signId);
        const decision = project.value.releases.find((item) => item.id === releaseId)!.decisions[snapshot.signId]
          ?? (hasLocalChanges(sign, snapshot) ? undefined : "adopt");
        if (!decision) unresolved += 1;
      });
    if (unresolved > 0) {
      toast.value = `还有 ${unresolved} 条未处理，无法完成撤回`;
      return;
    }
    commit("完成批次撤回", (draft) => {
      const release = draft.releases.find((item) => item.id === releaseId);
      if (!release || release.state !== "withdrawing") return;
      release.snapshots.forEach((snapshot) => {
        const decision = release.decisions[snapshot.signId] ?? "adopt";
        if (decision !== "adopt") return;
        const sign = draft.signs.find((item) => item.id === snapshot.signId);
        if (sign) applySnapshot(sign, snapshot);
      });
      release.state = "withdrawn";
      release.withdrawFinishedAt = new Date().toISOString();
    });
    toast.value = "发布批次已撤回，冻结版已按选择还原";
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
          // 兼容旧版本地数据：没有发布批次记录时补空数组。
          stored.project.releases ??= [];
          project.value = stored.project;
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
          <button
            class={`btn btn-sm gap-1.5 border-white/20 bg-white/10 text-white hover:bg-white/20 ${project.value.releases.some((release) => release.state === "withdrawing") ? "ring-2 ring-amber-300" : ""}`}
            onClick$={() => { activeReleaseId.value = null; releasesOpen.value = true; }}
          >
            发布批次
            <span class="badge badge-sm badge-ghost">{project.value.releases.length}</span>
            {project.value.releases.some((release) => release.state === "withdrawing") && <span class="badge badge-sm badge-warning">处理中</span>}
          </button>
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

      {project.value.releases.some((release) => release.state === "withdrawing") && (
        <div class="alert alert-warning sticky z-30 rounded-none border-x-0 py-2">
          <span class="text-lg">⏳</span>
          <span class="flex-1">
            <strong>有发布批次正在撤回处理</strong>：未逐条处理完的批次不会显示为已发布，处理选择已保存在本机，可随时回来继续。
          </span>
          {project.value.releases.filter((release) => release.state === "withdrawing").map((release) => (
            <button key={release.id} class="btn btn-xs btn-outline" onClick$={() => openRelease(release.id)}>继续处理 · {release.name}</button>
          ))}
        </div>
      )}

      <div class="grid min-h-[calc(100vh-64px)] grid-cols-[270px_minmax(560px,1fr)_430px] gap-px bg-slate-300">
        <aside class="overflow-y-auto bg-slate-50 p-3">
          <div class="mb-3 rounded-xl bg-white p-4 shadow-sm">
            <div class="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">标识清单</div>
            <div class="mt-1 text-lg font-bold text-slate-800">{project.value.signs.length} 处标识</div>
            <p class="mt-1 text-xs leading-5 text-slate-500">{project.value.location}</p>
          </div>
          <div class="mb-3 rounded-xl border border-blue-200 bg-blue-50 p-3 shadow-sm">
            <label class="flex cursor-pointer items-center gap-2 text-xs font-bold text-slate-600">
              <input
                type="checkbox"
                class="checkbox checkbox-xs checkbox-primary"
                checked={selectedSignIds.value.length === project.value.signs.length}
                onChange$={toggleSelectAll}
              />
              全选本批标识
            </label>
            <div class="mt-2 flex items-center justify-between gap-2">
              <span class="text-xs text-slate-500">已选 <strong class="text-blue-700">{selectedSignIds.value.length}</strong> / {project.value.signs.length} 条</span>
              <button
                class="btn btn-xs btn-primary"
                disabled={!selectedSignIds.value.length}
                onClick$={publishBatch}
              >
                批量确认发布
              </button>
            </div>
            <p class="mt-2 text-[11px] leading-4 text-slate-400">发布时整组冻结原文、译文、术语、意见与状态，随后可按发布点撤回。</p>
          </div>
          <div class="space-y-2">
            {project.value.signs.map((sign, index) => {
              const risk = analyzeSign(sign, previewWidth.value, previewFont.value);
              const selected = selectedSignIds.value.includes(sign.id);
              const release = signRelease(sign.id);
              return (
                <div
                  key={sign.id}
                  class={`relative rounded-xl border transition ${sign.id === project.value.activeSignId ? "border-blue-400 bg-blue-50 shadow-sm" : "border-slate-200 bg-white hover:border-slate-300"} ${selected ? "ring-2 ring-blue-300" : ""}`}
                >
                  <input
                    type="checkbox"
                    class="checkbox checkbox-xs checkbox-primary absolute left-2.5 top-3 z-10"
                    checked={selected}
                    onClick$={(event) => event.stopPropagation()}
                    onChange$={() => toggleSelectSign(sign.id)}
                    aria-label={`选择 ${sign.code}`}
                  />
                  <button
                    class="w-full p-3 pl-8 text-left"
                    onClick$={() => {
                      commit("切换标识", (draft) => { draft.activeSignId = sign.id; });
                      selectedVersionId.value = "";
                    }}
                  >
                    <div class="flex items-center justify-between">
                      <span class="font-mono text-xs font-bold text-slate-500">{sign.code}</span>
                      <span class={`badge badge-sm ${statusClass(sign.status)}`}>{STATUS_LABELS[sign.status]}</span>
                    </div>
                    <div class="mt-2 line-clamp-2 text-sm font-semibold text-slate-700">{sign.sourceText}</div>
                    {release && (
                      <div class="mt-2">
                        <span class={`badge badge-xs ${releaseStateClass(release.state)}`}>
                          {release.state === "withdrawing" ? "撤回处理中" : "已发布"}
                        </span>
                      </div>
                    )}
                    <div class="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                      <span>{sign.targetLanguage}</span>
                      <span class={risk.risk === "high" ? "font-bold text-error" : risk.risk === "medium" ? "font-bold text-warning" : "text-success"}>
                        {risk.risk === "high" ? "高风险" : risk.risk === "medium" ? "需留意" : "版面正常"}
                      </span>
                    </div>
                    <span class="sr-only">第 {index + 1} 条</span>
                  </button>
                </div>
              );
            })}
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

            <div class="rounded-xl bg-[#17324d] p-4 text-xs text-slate-200">
              <div class="mb-2 font-bold text-white">键盘操作</div>
              <div class="grid grid-cols-2 gap-y-1"><span><kbd class="kbd kbd-xs">J/K</kbd> 切换标识</span><span><kbd class="kbd kbd-xs">[ ]</kbd> 预览宽度</span><span><kbd class="kbd kbd-xs">- =</kbd> 字号</span><span><kbd class="kbd kbd-xs">Ctrl/⌘ Z</kbd> 撤销</span></div>
            </div>
          </section>
        </aside>
      </div>

      {releasesOpen.value && (
        <div class="modal modal-open z-50">
          <div class="modal-box max-w-3xl">
            {(() => {
              const release = activeRelease();
              if (!release) {
                return (
                  <>
                    <div class="flex items-start justify-between">
                      <div>
                        <h3 class="text-lg font-bold">发布批次</h3>
                        <p class="text-xs text-slate-500">批量确认时整组冻结标识；任一发布点都可撤回，撤回逐条还原该批译文、术语、意见与状态。</p>
                      </div>
                      <button class="btn btn-sm btn-circle btn-ghost" onClick$={closeReleases}>✕</button>
                    </div>
                    <div class="mt-4 space-y-3">
                      {project.value.releases.length === 0 && (
                        <div class="rounded-xl border border-dashed p-8 text-center text-sm text-slate-400">
                          还没有发布批次。在左侧清单勾选标识后点击“批量确认发布”。
                        </div>
                      )}
                      {project.value.releases.map((item) => {
                        const processed = item.snapshots.filter((snapshot) => item.decisions[snapshot.signId]).length;
                        return (
                          <div key={item.id} class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-4">
                            <div class="min-w-0">
                              <div class="flex flex-wrap items-center gap-2">
                                <strong class="truncate">{item.name}</strong>
                                <span class={`badge badge-sm ${releaseStateClass(item.state)}`}>{RELEASE_STATE_LABEL[item.state]}</span>
                                <span class="badge badge-sm badge-ghost">{item.snapshots.length} 条</span>
                              </div>
                              <div class="mt-1 text-xs text-slate-500">
                                发布于 {formatTime(item.publishedAt)}
                                {item.state === "withdrawing" && (
                                  <span class="text-warning"> · 处理进度 {processed}/{item.snapshots.length}（选择已自动保存，可关页后续做）</span>
                                )}
                                {item.state === "withdrawn" && item.withdrawFinishedAt && (
                                  <span> · 撤回完成 {formatTime(item.withdrawFinishedAt)}</span>
                                )}
                              </div>
                            </div>
                            {item.state === "published" && (
                              <button class="btn btn-sm btn-outline btn-warning shrink-0" onClick$={() => startWithdraw(item.id)}>撤回此发布点</button>
                            )}
                            {item.state === "withdrawing" && (
                              <button class="btn btn-sm btn-warning shrink-0" onClick$={() => openRelease(item.id)}>继续处理 {processed}/{item.snapshots.length}</button>
                            )}
                            {item.state === "withdrawn" && (
                              <button class="btn btn-sm btn-ghost shrink-0" onClick$={() => openRelease(item.id)}>查看记录</button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                );
              }

              const items = withdrawItems(release);
              const resolvedCount = items.filter((entry) => entry.resolved).length;
              const readOnlyBatch = release.state === "withdrawn";

              const renderSnapshotContent = (snapshot: SignSnapshot) => (
                <div class="space-y-2">
                  <div class="rounded-lg bg-slate-100 p-2">
                    <div class="text-[10px] font-bold uppercase tracking-wider text-slate-400">中文原文</div>
                    <p class="mt-0.5 whitespace-pre-line text-xs leading-5">{snapshot.sourceText}</p>
                  </div>
                  <div class="rounded-lg bg-slate-100 p-2">
                    <div class="text-[10px] font-bold uppercase tracking-wider text-slate-400">译文 · {snapshot.targetLanguage}</div>
                    <p class="mt-0.5 whitespace-pre-line text-xs leading-5">{snapshot.targetText}</p>
                  </div>
                  <div class="flex flex-wrap gap-1">
                    {snapshot.terms.map((term) => (
                      <span key={term.id} class={`badge badge-xs ${term.confirmed ? "badge-success" : "badge-warning"}`}>{term.source} → {term.target}</span>
                    ))}
                  </div>
                  <div>
                    <div class="text-[10px] font-bold uppercase tracking-wider text-slate-400">审校意见 {snapshot.comments.length} 条</div>
                    {snapshot.comments.length === 0 && <p class="text-[11px] text-slate-400">无意见</p>}
                    {snapshot.comments.map((comment) => (
                      <div key={comment.id} class={`mt-1 border-l-2 pl-2 text-[11px] leading-4 ${comment.resolved ? "border-success text-slate-400 line-through" : "border-warning"}`}>
                        <strong>{comment.author}</strong>：{comment.body}
                      </div>
                    ))}
                  </div>
                  <span class={`badge badge-xs ${statusClass(snapshot.status)}`}>发布时状态：{STATUS_LABELS[snapshot.status]}</span>
                </div>
              );

              const renderCurrentContent = (entry: (typeof items)[number]) => {
                const sign = entry.sign;
                if (!sign) return <p class="text-xs text-error">本机已找不到该标识，将直接采用发布冻结版。</p>;
                return (
                  <div class="space-y-2">
                    <div class="rounded-lg bg-slate-100 p-2">
                      <div class="text-[10px] font-bold uppercase tracking-wider text-slate-400">中文原文</div>
                      <p class="mt-0.5 whitespace-pre-line text-xs leading-5">{sign.sourceText}</p>
                    </div>
                    <div class="rounded-lg bg-slate-100 p-2">
                      <div class="text-[10px] font-bold uppercase tracking-wider text-slate-400">译文 · {sign.targetLanguage}</div>
                      <p class="mt-0.5 whitespace-pre-line text-xs leading-5">{sign.targetText}</p>
                    </div>
                    <div class="flex flex-wrap gap-1">
                      {sign.terms.map((term) => (
                        <span key={term.id} class={`badge badge-xs ${term.confirmed ? "badge-success" : "badge-warning"}`}>{term.source} → {term.target}</span>
                      ))}
                    </div>
                    <div>
                      <div class="text-[10px] font-bold uppercase tracking-wider text-slate-400">审校意见 {sign.comments.length} 条</div>
                      {sign.comments.length === 0 && <p class="text-[11px] text-slate-400">无意见</p>}
                      {sign.comments.map((comment) => (
                        <div key={comment.id} class={`mt-1 border-l-2 pl-2 text-[11px] leading-4 ${comment.resolved ? "border-success text-slate-400 line-through" : "border-warning"}`}>
                          <strong>{comment.author}</strong>：{comment.body}
                        </div>
                      ))}
                    </div>
                    <span class={`badge badge-xs ${statusClass(sign.status)}`}>本机当前状态：{STATUS_LABELS[sign.status]}</span>
                  </div>
                );
              };

              return (
                <>
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <button class="btn btn-xs btn-ghost -ml-2" onClick$={() => { activeReleaseId.value = null; }}>← 返回批次列表</button>
                      <h3 class="mt-1 text-lg font-bold">{release.name}</h3>
                      <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <span class={`badge badge-sm ${releaseStateClass(release.state)}`}>{RELEASE_STATE_LABEL[release.state]}</span>
                        <span>发布于 {formatTime(release.publishedAt)}</span>
                        {release.state === "withdrawing" && (
                          <span class="font-bold text-warning">处理进度 {resolvedCount}/{items.length}，未处理完不会标记已发布</span>
                        )}
                      </div>
                    </div>
                    <button class="btn btn-sm btn-circle btn-ghost" onClick$={closeReleases}>✕</button>
                  </div>

                  <div class="mt-4 max-h-[60vh] space-y-3 overflow-y-auto pr-1">
                    {items.map((entry) => (
                      <section key={entry.snapshot.signId} class={`rounded-xl border p-3 ${entry.conflict ? "border-amber-300 bg-amber-50/50" : "border-slate-200"}`}>
                        <div class="flex flex-wrap items-center justify-between gap-2">
                          <div class="flex items-center gap-2">
                            <span class="font-mono text-xs font-bold">{entry.snapshot.code}</span>
                            {entry.conflict
                              ? <span class="badge badge-xs badge-error">本机有未发布修改</span>
                              : <span class="badge badge-xs badge-ghost">本机无改动</span>}
                          </div>
                          {!readOnlyBatch && (
                            <div class="join">
                              <button
                                class={`btn join-item btn-xs ${entry.decision === "adopt" ? "btn-primary" : "btn-outline"}`}
                                onClick$={() => chooseWithdraw(release.id, entry.snapshot.signId, "adopt")}
                              >
                                采用发布冻结版
                              </button>
                              <button
                                class={`btn join-item btn-xs ${entry.decision === "keep" ? "btn-primary" : "btn-outline"}`}
                                onClick$={() => chooseWithdraw(release.id, entry.snapshot.signId, "keep")}
                              >
                                保留本机修改
                              </button>
                            </div>
                          )}
                          {readOnlyBatch && (
                            <span class="text-xs text-slate-400">
                              处理结果：{release.decisions[entry.snapshot.signId] === "keep" ? "保留本机修改" : "已采用冻结版"}
                            </span>
                          )}
                        </div>
                        {!entry.conflict && release.state === "withdrawing" && (
                          <p class="mt-2 text-[11px] text-slate-500">本机与冻结版一致，默认采用；也可显式改选。</p>
                        )}
                        <div class="mt-2 grid gap-2 md:grid-cols-2">
                          <div>
                            <div class="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">该批冻结版</div>
                            {renderSnapshotContent(entry.snapshot)}
                          </div>
                          <div>
                            <div class="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">本机当前内容</div>
                            {renderCurrentContent(entry)}
                          </div>
                        </div>
                      </section>
                    ))}
                  </div>

                  <div class="modal-action">
                    {release.state === "published" && (
                      <button class="btn btn-sm btn-outline btn-warning" onClick$={() => startWithdraw(release.id)}>撤回此发布点</button>
                    )}
                    {release.state === "withdrawing" && (
                      <>
                        <span class="mr-auto self-center text-xs text-slate-500">
                          {resolvedCount === items.length ? "全部条目已处理，可以完成撤回。" : `还有 ${items.length - resolvedCount} 条待选择，可先关闭稍后继续。`}
                        </span>
                        <button class="btn btn-sm btn-ghost" onClick$={closeReleases}>保存进度并关闭</button>
                        <button
                          class="btn btn-sm btn-warning"
                          disabled={resolvedCount !== items.length}
                          onClick$={() => finishWithdraw(release.id)}
                        >
                          完成撤回并还原 ({resolvedCount}/{items.length})
                        </button>
                      </>
                    )}
                    {release.state === "withdrawn" && (
                      <button class="btn btn-sm btn-ghost" onClick$={closeReleases}>关闭</button>
                    )}
                  </div>
                </>
              );
            })()}
          </div>
          <button class="modal-backdrop" aria-label="关闭" onClick$={closeReleases}></button>
        </div>
      )}

      {toast.value && <div class="toast toast-end z-[60]"><div class="alert alert-success"><span>{toast.value}</span></div></div>}
    </div>
  );
});
