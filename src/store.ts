import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  AppState,
  Archive,
  COLOR_DELTA_LIMIT,
  DamageRegion,
  DamageType,
  Material,
  MaterialRequirement,
  Severity,
  Snapshot,
  STEP_DEFS,
  canToggleStep,
  colorDelta,
  duplicateArchive,
  emptySteps,
  makeArchive,
  nextCode,
  nowTs,
  rectAreaPct,
  repairMaterialReady,
  reservedByMaterial,
  requirementStatus,
  seedMaterials,
  seedState,
  snapshotArchive,
  structuredCloneShim,
  uid,
} from "./model";

// ---------------------------------------------------------------------------
// 动作定义
// ---------------------------------------------------------------------------

type MetaAction =
  | { type: "select"; id: string | null }
  | { type: "replace"; state: AppState }
  | { type: "hydrate"; state: AppState };

export type Action =
  | MetaAction
  | { type: "addArchive" }
  | { type: "duplicateArchive"; id: string }
  | { type: "deleteArchive"; id: string }
  | { type: "updateMeta"; id: string; patch: Partial<Pick<Archive, "name" | "origin" | "era" | "knotDensity" | "fiber" | "dye">> }
  | { type: "setPatternImage"; id: string; image: string | null }
  | { type: "addRegion"; id: string; region: DamageRegion }
  | { type: "updateRegion"; id: string; regionId: string; patch: Partial<DamageRegion> }
  | { type: "deleteRegion"; id: string; regionId: string }
  | { type: "addRequirement"; id: string; req: MaterialRequirement }
  | { type: "updateRequirement"; id: string; reqId: string; patch: Partial<MaterialRequirement> }
  | { type: "deleteRequirement"; id: string; reqId: string }
  | { type: "batchAssignMaterial"; id: string; reqIds: string[]; materialId: string }
  | { type: "toggleStep"; id: string; stepId: string; materials: Material[] }
  | { type: "archive"; id: string; materials: Material[] }
  | { type: "unarchive"; id: string }
  | { type: "createSnapshot"; id: string; label: string; note?: string }
  | { type: "restoreSnapshot"; id: string; snapshotId: string }
  | { type: "deleteSnapshot"; id: string; snapshotId: string };

interface HistoryState {
  past: AppState[];
  present: AppState;
  future: AppState[];
  /** 最近一次保存时间（localStorage 写入时间），非历史的一部分 */
  lastSaved: number;
}

const HISTORY_LIMIT = 100;
const STORAGE_KEY = "rug-repair-workbench-v1";

function touch(archive: Archive): Archive {
  return { ...archive, updatedAt: nowTs() };
}

function mapArchive(state: AppState, id: string, fn: (a: Archive) => Archive): AppState {
  return {
    ...state,
    archives: state.archives.map((a) => (a.id === id ? touch(fn(a)) : a)),
  };
}

// 勾选工序：取消时级联取消所有依赖该工序的后续工序
function toggleStepIn(archive: Archive, stepId: string): Archive {
  const currentlyOn = archive.steps[stepId] === true;
  const steps = { ...archive.steps };
  if (currentlyOn) {
    steps[stepId] = false;
    // 级联取消直接/间接依赖
    let changed = true;
    while (changed) {
      changed = false;
      for (const def of STEP_DEFS) {
        if (steps[def.id] && def.deps.some((d) => !steps[d])) {
          steps[def.id] = false;
          changed = true;
        }
      }
    }
  } else {
    steps[stepId] = true;
  }
  return { ...archive, steps };
}

// 推进工序前的门槛校验（由 UI 层提示原因，reducer 内再兜底）
export function stepAdvanceBlocked(
  archive: Archive,
  stepId: string,
  materials: Material[],
  reserved: Record<string, number>,
): string | null {
  const def = STEP_DEFS.find((s) => s.id === stepId);
  if (!def || archive.steps[stepId]) return null;
  for (const dep of def.deps) {
    if (!archive.steps[dep]) {
      const depDef = STEP_DEFS.find((s) => s.id === dep);
      return `前序工序未完成：「${depDef?.name ?? dep}」`;
    }
  }
  if (stepId === "match") {
    const unassigned = archive.materials.filter((r) => !r.materialId).length;
    if (unassigned > 0) return `材料未备齐：还有 ${unassigned} 项补线需求未选取色卡`;
  }
  if (stepId === "repair") {
    if (!repairMaterialReady(archive, materials, reserved)) {
      return "材料未备齐：存在色差超限或库存不足的补线需求";
    }
  }
  return null;
}

function coreReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "addArchive": {
      const a = makeArchive({ code: nextCode(state.archives) });
      return { archives: [...state.archives, a], activeId: a.id };
    }
    case "duplicateArchive": {
      const src = state.archives.find((a) => a.id === action.id);
      if (!src) return state;
      const copy = duplicateArchive(src);
      copy.code = nextCode(state.archives);
      // 复制时保留当前材料选取关系
      return { archives: [...state.archives, copy], activeId: copy.id };
    }
    case "deleteArchive": {
      const archives = state.archives.filter((a) => a.id !== action.id);
      const activeId = state.activeId === action.id ? archives[0]?.id ?? null : state.activeId;
      return { archives, activeId };
    }
    case "updateMeta":
      return mapArchive(state, action.id, (a) => ({ ...a, ...action.patch }));
    case "setPatternImage":
      return mapArchive(state, action.id, (a) => ({ ...a, patternImage: action.image }));
    case "addRegion":
      return mapArchive(state, action.id, (a) => ({ ...a, regions: [...a.regions, action.region] }));
    case "updateRegion":
      return mapArchive(state, action.id, (a) => ({
        ...a,
        regions: a.regions.map((r) => (r.id === action.regionId ? { ...r, ...action.patch } : r)),
      }));
    case "deleteRegion":
      return mapArchive(state, action.id, (a) => ({
        ...a,
        regions: a.regions.filter((r) => r.id !== action.regionId),
        materials: a.materials.filter((m) => m.regionId !== action.regionId),
      }));
    case "addRequirement":
      return mapArchive(state, action.id, (a) => ({ ...a, materials: [...a.materials, action.req] }));
    case "updateRequirement":
      return mapArchive(state, action.id, (a) => ({
        ...a,
        materials: a.materials.map((m) => (m.id === action.reqId ? { ...m, ...action.patch } : m)),
      }));
    case "deleteRequirement":
      return mapArchive(state, action.id, (a) => ({
        ...a,
        materials: a.materials.filter((m) => m.id !== action.reqId),
      }));
    case "batchAssignMaterial":
      return mapArchive(state, action.id, (a) => ({
        ...a,
        materials: a.materials.map((m) =>
          action.reqIds.includes(m.id) ? { ...m, materialId: action.materialId } : m,
        ),
      }));
    case "toggleStep": {
      const archive = state.archives.find((a) => a.id === action.id);
      if (!archive) return state;
      const turningOn = !archive.steps[action.stepId];
      if (turningOn) {
        if (!canToggleStep(archive, action.stepId)) return state;
        const reserved = reservedByMaterial(state);
        if (stepAdvanceBlocked(archive, action.stepId, action.materials, reserved)) return state;
      }
      return mapArchive(state, action.id, (a) => toggleStepIn(a, action.stepId));
    }
    case "archive":
      return mapArchive(state, action.id, (a) => ({ ...a, archived: true }));
    case "unarchive":
      return mapArchive(state, action.id, (a) => ({ ...a, archived: false }));
    case "createSnapshot":
      return mapArchive(state, action.id, (a) => ({
        ...a,
        snapshots: [snapshotArchive(a, action.label, action.note), ...a.snapshots],
      }));
    case "restoreSnapshot": {
      return mapArchive(state, action.id, (a) => {
        const snap = a.snapshots.find((s) => s.id === action.snapshotId);
        if (!snap) return a;
        // 恢复前自动留存当前状态，历史记录不丢
        const safety = snapshotArchive(a, `恢复前自动备份 · ${a.code}`);
        const restored: Archive = {
          ...clone(snap.data),
          id: a.id,
          code: a.code,
          snapshots: [safety, ...a.snapshots],
          archived: false,
          updatedAt: nowTs(),
        };
        return restored;
      });
    }
    case "deleteSnapshot":
      return mapArchive(state, action.id, (a) => ({
        ...a,
        snapshots: a.snapshots.filter((s) => s.id !== action.snapshotId),
      }));
    case "select":
      return { ...state, activeId: action.id };
    case "replace":
    case "hydrate":
      return action.state;
    default:
      return state;
  }
}

// structuredClone 在现代浏览器可用；保留一个 JSON 兜底
function clone<T>(v: T): T {
  if (typeof structuredClone === "function") return structuredClone(v);
  return structuredCloneShim(v);
}

const NON_HISTORY: ReadonlySet<string> = new Set(["select", "hydrate"]);

type InternalAction = { type: "__undo" } | { type: "__redo" } | { type: "__saved"; ts: number };

function historyReducer(state: HistoryState, action: Action | InternalAction): HistoryState {
  if (action.type === "hydrate") {
    return { past: [], present: coreReducer(state.present, action), future: [], lastSaved: state.lastSaved };
  }
  if (action.type === "__undo" || action.type === "__redo" || action.type === "__saved") {
    return state;
  }
  const next = coreReducer(state.present, action);
  if (next === state.present) return state;
  if (NON_HISTORY.has(action.type)) {
    return { ...state, present: next };
  }
  const past = [...state.past, state.present];
  if (past.length > HISTORY_LIMIT) past.shift();
  return { past, present: next, future: [], lastSaved: state.lastSaved };
}

function undo(state: HistoryState): HistoryState {
  if (state.past.length === 0) return state;
  const previous = state.past[state.past.length - 1];
  return {
    past: state.past.slice(0, -1),
    present: previous,
    future: [state.present, ...state.future],
    lastSaved: state.lastSaved,
  };
}

function redo(state: HistoryState): HistoryState {
  if (state.future.length === 0) return state;
  const next = state.future[0];
  return {
    past: [...state.past, state.present],
    present: next,
    future: state.future.slice(1),
    lastSaved: state.lastSaved,
  };
}

// ---------------------------------------------------------------------------
// 持久化 / 导入导出
// ---------------------------------------------------------------------------

interface BackupFile {
  app: "rug-repair-workbench";
  version: 1;
  exportedAt: number;
  state: AppState;
}

function loadInitial(): HistoryState {
  const base = seedState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { present?: AppState; savedAt?: number };
      if (parsed.present && Array.isArray(parsed.present.archives)) {
        return { past: [], present: sanitize(parsed.present), future: [], lastSaved: parsed.savedAt ?? 0 };
      }
    }
  } catch {
    // 损坏的本地数据直接回落到种子
  }
  return { past: [], present: base, future: [], lastSaved: 0 };
}

/** 旧数据/导入数据补齐字段，避免运行期 undefined */
function sanitize(state: AppState): AppState {
  const archives = state.archives.map((a) =>
    makeArchive({
      ...a,
      steps: { ...emptySteps(), ...(a.steps ?? {}) },
      regions: (a.regions ?? []).map((r) => ({ ...r, areaPct: r.areaPct ?? rectAreaPct(r) })),
      materials: a.materials ?? [],
      snapshots: a.snapshots ?? [],
    }),
  );
  const activeId = archives.some((a) => a.id === state.activeId) ? state.activeId : archives[0]?.id ?? null;
  return { archives, activeId };
}

export interface Store {
  state: AppState;
  materials: Material[];
  active: Archive | null;
  dispatch: React.Dispatch<Action>;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  lastSaved: number;
  saveNow: () => void;
  exportBackup: () => void;
  importBackup: (file: File) => Promise<boolean>;
}

export function useStore(): Store {
  const [hstate, dispatchBase] = useReducer(
    (state: HistoryState, action: Action | { type: "__undo" } | { type: "__redo" } | { type: "__saved"; ts: number }) => {
      if (action.type === "__undo") return undo(state);
      if (action.type === "__redo") return redo(state);
      if (action.type === "__saved") return { ...state, lastSaved: action.ts };
      return historyReducer(state, action);
    },
    undefined,
    loadInitial,
  );

  const state = hstate.present;
  const materials = useMemo(() => seedMaterials(), []);
  const saveTimer = useRef<number | null>(null);

  const persist = useCallback((s: AppState) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ present: s, savedAt: Date.now() }));
      dispatchBase({ type: "__saved", ts: Date.now() });
    } catch {
      // 存储已满（纹样图较大）时静默失败，手动导出仍可用
    }
  }, []);

  // 变更后自动保存（防抖 500ms）
  useEffect(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => persist(state), 500);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [state, persist]);

  const dispatch = useCallback<React.Dispatch<Action>>((action) => dispatchBase(action), []);

  const saveNow = useCallback(() => persist(state), [persist, state]);

  const exportBackup = useCallback(() => {
    const payload: BackupFile = {
      app: "rug-repair-workbench",
      version: 1,
      exportedAt: Date.now(),
      state,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `地毯修复档案备份_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [state]);

  const importBackup = useCallback(
    async (file: File) => {
      try {
        const parsed = JSON.parse(await file.text()) as BackupFile;
        if (parsed.app !== "rug-repair-workbench" || !parsed.state?.archives) return false;
        dispatchBase({ type: "hydrate", state: sanitize(parsed.state) });
        return true;
      } catch {
        return false;
      }
    },
    [],
  );

  const active = state.archives.find((a) => a.id === state.activeId) ?? null;

  return {
    state,
    materials,
    active,
    dispatch,
    canUndo: hstate.past.length > 0,
    canRedo: hstate.future.length > 0,
    undo: () => dispatchBase({ type: "__undo" }),
    redo: () => dispatchBase({ type: "__redo" }),
    lastSaved: hstate.lastSaved,
    saveNow,
    exportBackup,
    importBackup,
  };
}

// 纯 reducer 导出，便于在组件外（测试 / 调试）驱动状态
export { coreReducer, historyReducer };
export { undo as undoHistory, redo as redoHistory };

// 便捷选择器再导出，供组件直接使用
export {
  COLOR_DELTA_LIMIT,
  STEP_DEFS,
  colorDelta,
  rectAreaPct,
  requirementStatus,
  reservedByMaterial,
  uid,
};
export type { DamageType, Severity, Snapshot };
