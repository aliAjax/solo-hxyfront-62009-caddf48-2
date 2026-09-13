import { Archive, ORIGINS, Origin } from "../model";
import { Action } from "../store";

interface Props {
  archive: Archive;
  dispatch: React.Dispatch<Action>;
}

export default function MetaForm({ archive, dispatch }: Props) {
  const set = (patch: Partial<Archive>) => dispatch({ type: "updateMeta", id: archive.id, patch });
  return (
    <div className="meta-form">
      <div className="meta-code">
        <span className="code-badge">{archive.code}</span>
        <input
          className="name-input"
          value={archive.name}
          onChange={(e) => set({ name: e.target.value })}
          aria-label="地毯名称"
        />
        <span className={`tag ${archive.archived ? "tag-done" : "tag-progress"}`}>
          {archive.archived ? "已归档" : "修复中"}
        </span>
      </div>
      <div className="meta-grid">
        <label>
          <span>产地</span>
          <select value={archive.origin} onChange={(e) => set({ origin: e.target.value as Origin })}>
            {ORIGINS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>年代</span>
          <input value={archive.era} placeholder="如 约1960s" onChange={(e) => set({ era: e.target.value })} />
        </label>
        <label>
          <span>结密度</span>
          <input
            value={archive.knotDensity}
            placeholder="如 36 结/英寸"
            onChange={(e) => set({ knotDensity: e.target.value })}
          />
        </label>
        <label>
          <span>材质</span>
          <input value={archive.fiber} placeholder="如 羊毛" onChange={(e) => set({ fiber: e.target.value })} />
        </label>
        <label className="wide">
          <span>染色类型</span>
          <input
            value={archive.dye}
            placeholder="如 植物染（靛蓝）"
            onChange={(e) => set({ dye: e.target.value })}
          />
        </label>
      </div>
    </div>
  );
}
