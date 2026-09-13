import { Conflict, ConflictKind } from "../model";

interface Props {
  conflicts: Conflict[];
  onLocate: (c: Conflict) => void;
  activeOnly: boolean;
  onScopeChange: (activeOnly: boolean) => void;
}

const KIND_META: Record<ConflictKind, { label: string; icon: string }> = {
  "missing-image": { label: "缺图", icon: "🖼" },
  overlap: { label: "区域重叠", icon: "▦" },
  material: { label: "材料不足", icon: "🧶" },
  inverted: { label: "工序倒置", icon: "⇅" },
};

export default function ConflictPanel({ conflicts, onLocate, activeOnly, onScopeChange }: Props) {
  const groups: ConflictKind[] = ["missing-image", "overlap", "material", "inverted"];
  const errors = conflicts.filter((c) => c.level === "error").length;

  return (
    <div className="conflict-panel" data-tab="conflicts">
      <div className="conflict-head">
        <h2>
          冲突面板{" "}
          <span className={`conflict-count ${errors > 0 ? "has-error" : ""}`}>
            {conflicts.length}
          </span>
        </h2>
        <div className="scope-switch">
          <button className={!activeOnly ? "chip active" : "chip"} onClick={() => onScopeChange(false)}>
            全场
          </button>
          <button className={activeOnly ? "chip active" : "chip"} onClick={() => onScopeChange(true)}>
            当前档案
          </button>
        </div>
      </div>

      {conflicts.length === 0 ? (
        <p className="all-clear">✓ 暂无冲突，满足条件的档案可以归档</p>
      ) : (
        groups.map((kind) => {
          const items = conflicts.filter((c) => c.kind === kind);
          if (items.length === 0) return null;
          const meta = KIND_META[kind];
          return (
            <section key={kind} className="conflict-group">
              <h3>
                {meta.icon} {meta.label} <span className="group-count">{items.length}</span>
              </h3>
              <ul>
                {items.map((c) => (
                  <li key={c.id} className={c.level}>
                    <button className="conflict-item" onClick={() => onLocate(c)}>
                      <span className="conflict-archive">{c.archiveCode}</span>
                      <span className="conflict-msg">{c.message}</span>
                      <span className="locate-link">定位 →</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}
