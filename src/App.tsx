import { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import { buildConflicts, Conflict, formatTime } from "./model";
import { useStore } from "./store";
import ArchiveList from "./components/ArchiveList";
import ConflictPanel from "./components/ConflictPanel";
import MaterialsPanel from "./components/MaterialsPanel";
import MetaForm from "./components/MetaForm";
import PatternEditor from "./components/PatternEditor";
import ProcessPanel from "./components/ProcessPanel";

type Tab = "pattern" | "materials" | "process" | "conflicts";

const TAB_LABELS: Record<Tab, string> = {
  pattern: "纹样图",
  materials: "材料色卡",
  process: "工序/版本",
  conflicts: "冲突",
};

function App() {
  const store = useStore();
  const { state, materials, active, dispatch } = store;
  const [tab, setTab] = useState<Tab>("pattern");
  const [drawerOpen, setDrawerOpen] = useState(() =>
    typeof window === "undefined" ? true : window.innerWidth > 860,
  );
  const [scopeActiveOnly, setScopeActiveOnly] = useState(false);
  const [flashKey, setFlashKey] = useState(0);
  const flashTarget = useRef<string | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const allConflicts = useMemo(() => buildConflicts(state, materials), [state, materials]);
  const conflicts = scopeActiveOnly && active
    ? allConflicts.filter((c) => c.archiveId === active.id)
    : allConflicts;

  const conflictCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const c of allConflicts) map[c.archiveId] = (map[c.archiveId] ?? 0) + 1;
    return map;
  }, [allConflicts]);

  const archivedCounts = useMemo(
    () => ({ done: state.archives.filter((a) => a.archived).length, total: state.archives.length }),
    [state.archives],
  );

  function showToast(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  }

  function locate(c: Conflict) {
    if (c.archiveId !== state.activeId) dispatch({ type: "select", id: c.archiveId });
    setTab(c.tab);
    flashTarget.current = c.target;
    setFlashKey((k) => k + 1);
  }

  // 定位：滚动到来源元素并高亮闪烁
  useEffect(() => {
    if (!flashKey || !flashTarget.current) return;
    const target = flashTarget.current;
    const t = window.setTimeout(() => {
      const el = document.querySelector(`[data-highlight="${CSS.escape(target)}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
        el.classList.remove("flash");
        // 强制重排以重新触发动画
        void (el as HTMLElement).offsetWidth;
        el.classList.add("flash");
        window.setTimeout(() => el.classList.remove("flash"), 2400);
      }
    }, 120);
    return () => window.clearTimeout(t);
  }, [flashKey]);

  // 键盘快捷键：Ctrl/Cmd+Z 撤销，+Shift+Z 重做
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        store.undo();
      } else if (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey)) {
        e.preventDefault();
        store.redo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <h1>地毯修复档案工作台</h1>
          <p>纹样 · 材料 · 工序 · 冲突一站式追踪</p>
        </div>
        <div className="topbar-actions">
          <span className="save-state" title="所有改动自动保存到本机">
            {store.lastSaved ? `已自动保存 ${formatTime(store.lastSaved)}` : "自动保存中…"}
          </span>
          <button className="small" onClick={store.undo} disabled={!store.canUndo} title="撤销 (Ctrl+Z)">
            ↶ 撤销
          </button>
          <button className="small" onClick={store.redo} disabled={!store.canRedo} title="重做 (Ctrl+Shift+Z)">
            ↷ 重做
          </button>
          <button className="small" onClick={() => { store.saveNow(); showToast("已保存到本机"); }}>
            保存
          </button>
          <button className="small" onClick={() => store.exportBackup()}>
            导出备份
          </button>
          <button className="small" onClick={() => importRef.current?.click()}>
            导入
          </button>
          <input
            ref={importRef}
            type="file"
            accept="application/json"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              const ok = await store.importBackup(file);
              showToast(ok ? "备份已导入" : "导入失败：文件格式不正确");
            }}
          />
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <details
            className="panel sidebar-panel archive-drawer"
            open={drawerOpen}
            onToggle={(e) => setDrawerOpen((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary className="panel-title drawer-summary">
              档案库 <span className="drawer-count">{state.archives.length}</span>
            </summary>
            <ArchiveList
              state={state}
              dispatch={dispatch}
              conflictCounts={conflictCounts}
              archivedCounts={archivedCounts}
              onSelectCard={() => {
                if (window.innerWidth <= 860) setDrawerOpen(false);
              }}
            />
          </details>
        </aside>

        <section className="main-col">
          <nav className="tabbar" aria-label="工作台分区">
            {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
              <button
                key={t}
                className={tab === t ? "tab active" : "tab"}
                onClick={() => setTab(t)}
              >
                {TAB_LABELS[t]}
                {t === "conflicts" && allConflicts.length > 0 && (
                  <span className="tab-badge">{allConflicts.length}</span>
                )}
              </button>
            ))}
          </nav>

          <div className={`tab-view tab-${tab}`}>
            {active ? (
              <>
                <section className={`panel ${tab === "pattern" ? "" : "hidden"}`}>
                  <MetaForm archive={active} dispatch={dispatch} />
                </section>
                <section className={`panel ${tab === "pattern" ? "" : "hidden"}`}>
                  <PanelTitle title="纹样局部标记图" sub="在纹样图上绘制、移动、调整破损区域，记录类型 / 严重度 / 面积占比" />
                  <PatternEditor archive={active} dispatch={dispatch} />
                </section>

                <section className={`panel ${tab === "materials" ? "" : "hidden"}`}>
                  <PanelTitle title="材料色卡与库存预留" sub="批量选取色卡、分配补线需求；色差超限或库存不足会阻止归档" />
                  <MaterialsPanel archive={active} materials={materials} state={state} dispatch={dispatch} />
                </section>

                <section className={`panel ${tab === "process" ? "" : "hidden"}`}>
                  <PanelTitle title="修复工序与版本" sub="工序按依赖推进；可创建版本快照并恢复，历史记录保留" />
                  <ProcessPanel archive={active} materials={materials} state={state} dispatch={dispatch} />
                </section>

                <section className={`panel ${tab === "conflicts" ? "" : "hidden"}`}>
                  <ConflictPanel
                    conflicts={conflicts}
                    onLocate={locate}
                    activeOnly={scopeActiveOnly}
                    onScopeChange={setScopeActiveOnly}
                  />
                </section>
              </>
            ) : (
              <section className="panel empty-state">
                <h2>尚未选择档案</h2>
                <p>从左侧档案库选择一份，或新增档案开始记录。</p>
                <button className="primary" onClick={() => dispatch({ type: "addArchive" })}>
                  + 新增档案
                </button>
              </section>
            )}
          </div>
        </section>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

function PanelTitle({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="panel-heading">
      <h2>{title}</h2>
      <p>{sub}</p>
    </div>
  );
}

export default App;
