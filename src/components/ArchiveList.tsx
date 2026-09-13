import { useMemo, useState } from "react";
import { AppState, Archive, ORIGINS, Origin, formatTime } from "../model";
import { Action } from "../store";

interface Props {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  conflictCounts: Record<string, number>;
  archivedCounts: { done: number; total: number };
  onSelectCard?: () => void;
}

export default function ArchiveList({ state, dispatch, conflictCounts, archivedCounts, onSelectCard }: Props) {
  const [query, setQuery] = useState("");
  const [originFilter, setOriginFilter] = useState<Origin | "全部">("全部");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return state.archives.filter((a) => {
      if (originFilter !== "全部" && a.origin !== originFilter) return false;
      if (!q) return true;
      return (
        a.code.toLowerCase().includes(q) ||
        a.name.toLowerCase().includes(q) ||
        a.origin.toLowerCase().includes(q) ||
        a.fiber.toLowerCase().includes(q) ||
        a.dye.toLowerCase().includes(q)
      );
    });
  }, [state.archives, query, originFilter]);

  return (
    <div className="archive-list">
      <div className="list-toolbar">
        <div className="list-summary">
          <strong>{state.archives.length}</strong> 份档案 · 已归档 {archivedCounts.done}/{archivedCounts.total}
        </div>
        <button className="primary small" onClick={() => dispatch({ type: "addArchive" })}>
          + 新增档案
        </button>
      </div>

      <input
        className="search"
        placeholder="搜索编号 / 名称 / 材质 / 染色…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="搜索档案"
      />

      <div className="origin-filter">
        {(["全部", ...ORIGINS] as const).map((o) => (
          <button
            key={o}
            className={originFilter === o ? "chip active" : "chip"}
            onClick={() => setOriginFilter(o)}
          >
            {o}
          </button>
        ))}
      </div>

      <div className="archive-items">
        {filtered.length === 0 && <p className="empty-hint">没有匹配的档案</p>}
        {filtered.map((a) => (
          <ArchiveCard
            key={a.id}
            archive={a}
            active={a.id === state.activeId}
            conflicts={conflictCounts[a.id] ?? 0}
            dispatch={dispatch}
            onSelect={onSelectCard}
          />
        ))}
      </div>
    </div>
  );
}

function ArchiveCard({
  archive,
  active,
  conflicts,
  dispatch,
  onSelect,
}: {
  archive: Archive;
  active: boolean;
  conflicts: number;
  dispatch: React.Dispatch<Action>;
  onSelect?: () => void;
}) {
  const stepDone = Object.values(archive.steps).filter(Boolean).length;
  return (
    <article
      className={`archive-card${active ? " active" : ""}${archive.archived ? " archived" : ""}`}
      data-highlight={active ? undefined : `archive:${archive.id}`}
      onClick={() => {
        dispatch({ type: "select", id: archive.id });
        onSelect?.();
      }}
    >
      <div className="card-top">
        <b>{archive.code}</b>
        {archive.archived && <span className="tag tag-done">已归档</span>}
        {!archive.archived && conflicts > 0 && <span className="tag tag-conflict">{conflicts} 冲突</span>}
        <span className="tag tag-origin">{archive.origin}</span>
      </div>
      <h3>{archive.name}</h3>
      <p className="card-meta">
        {archive.era || "年代未填"} · {archive.knotDensity || "结密度未填"}
      </p>
      <div className="card-foot">
        <span>
          工序 {stepDone}/6 · 区域 {archive.regions.length}
        </span>
        <span className="card-time">{formatTime(archive.updatedAt)}</span>
      </div>
      <div className="card-actions" onClick={(e) => e.stopPropagation()}>
        <button
          className="link-btn"
          onClick={() => dispatch({ type: "duplicateArchive", id: archive.id })}
          title="基于此档案复制一份（工序与快照重置）"
        >
          复制
        </button>
        <button
          className="link-btn danger"
          onClick={() => {
            if (window.confirm(`确定删除档案 ${archive.code}「${archive.name}」？此操作可通过撤销恢复。`)) {
              dispatch({ type: "deleteArchive", id: archive.id });
            }
          }}
        >
          删除
        </button>
      </div>
    </article>
  );
}
