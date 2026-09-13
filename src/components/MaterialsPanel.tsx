import { useMemo, useState } from "react";
import {
  Archive,
  COLOR_DELTA_LIMIT,
  Material,
  MaterialRequirement,
  regionLabelById,
  requirementLabel,
  requirementStatus,
  reservedByMaterial,
  uid,
} from "../model";
import { Action } from "../store";

interface Props {
  archive: Archive;
  materials: Material[];
  state: { archives: Archive[] };
  dispatch: React.Dispatch<Action>;
}

export default function MaterialsPanel({ archive, materials, state, dispatch }: Props) {
  const reserved = useMemo(() => reservedByMaterial({ archives: state.archives, activeId: archive.id }), [state.archives, archive.id]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [batchTarget, setBatchTarget] = useState<string>("");

  const pickedMaterials = materials.filter((m) => picked.has(m.id));
  const checkedCount = picked.size;

  function togglePick(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function applyBatch() {
    if (!batchTarget || picked.size === 0) return;
    dispatch({ type: "batchAssignMaterial", id: archive.id, reqIds: [batchTarget], materialId: pickedMaterials[0].id });
    setPicked(new Set());
    setBatchTarget("");
  }

  function batchCreateRequirements() {
    // 对每个勾选的色卡新建一条整毯需求
    for (const mat of pickedMaterials) {
      dispatch({
        type: "addRequirement",
        id: archive.id,
        req: {
          id: uid("req"),
          regionId: null,
          targetColor: mat.color,
          qty: Math.max(5, Math.round(mat.stock * 0.1)),
          materialId: mat.id,
        },
      });
    }
    setPicked(new Set());
  }

  return (
    <div className="materials-panel">
      <section className="subpanel">
        <div className="subpanel-head">
          <h3>材料色卡库</h3>
          <span className="hint">勾选多个色卡可批量操作；全场需求实时预留库存</span>
        </div>
        <div className="swatch-grid">
          {materials.map((m) => {
            const used = reserved[m.id] ?? 0;
            const available = m.stock - used;
            return (
              <label
                key={m.id}
                className={`swatch${picked.has(m.id) ? " picked" : ""}${available < 0 ? " short" : ""}`}
              >
                <input type="checkbox" checked={picked.has(m.id)} onChange={() => togglePick(m.id)} />
                <span className="swatch-color" style={{ background: m.color }} />
                <span className="swatch-name">{m.name}</span>
                <span className={`swatch-stock${available < 0 ? " danger" : available < m.stock * 0.15 ? " warn" : ""}`}>
                  {available < 0 ? `超预留 ${Math.abs(available)}` : `余 ${available}`}/{m.stock}
                </span>
              </label>
            );
          })}
        </div>

        {checkedCount > 0 && (
          <div className="batch-bar">
            <span>已选 {checkedCount} 个色卡</span>
            {checkedCount === 1 && (
              <>
                <select value={batchTarget} onChange={(e) => setBatchTarget(e.target.value)}>
                  <option value="">批量分配给…</option>
                  {archive.materials.map((req, i) => (
                    <option key={req.id} value={req.id}>
                      {req.regionId ? regionLabelById(archive, req.regionId) : `整毯需求 ${i + 1}`}
                    </option>
                  ))}
                </select>
                <button className="small" disabled={!batchTarget} onClick={applyBatch}>
                  分配
                </button>
              </>
            )}
            <button className="small" onClick={batchCreateRequirements}>
              按选中色卡新增 {checkedCount} 条补线需求
            </button>
          </div>
        )}
      </section>

      <section className="subpanel">
        <div className="subpanel-head">
          <h3>本档案补线需求（{archive.materials.length}）</h3>
          <button
            className="small"
            onClick={() =>
              dispatch({
                type: "addRequirement",
                id: archive.id,
                req: { id: uid("req"), regionId: null, targetColor: "#8a3324", qty: 10, materialId: null },
              })
            }
          >
            + 新增需求
          </button>
        </div>

        {archive.materials.length === 0 && (
          <p className="empty-hint">还没有补线需求，可在纹样区域编辑中添加，或从色卡批量生成</p>
        )}

        <div className="req-list">
          {archive.materials.map((req) => (
            <RequirementRow
              key={req.id}
              archive={archive}
              req={req}
              materials={materials}
              reserved={reserved}
              dispatch={dispatch}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function RequirementRow({
  archive,
  req,
  materials,
  reserved,
  dispatch,
}: {
  archive: Archive;
  req: MaterialRequirement;
  materials: Material[];
  reserved: Record<string, number>;
  dispatch: React.Dispatch<Action>;
}) {
  const r = requirementStatus(req, materials, reserved);
  const mat = materials.find((m) => m.id === req.materialId) ?? null;
  const badge = {
    unassigned: { text: "未选取", cls: "badge-error" },
    delta: { text: `色差 ${r.delta}`, cls: "badge-error" },
    stock: { text: `缺货 ${Math.abs(r.available)}`, cls: "badge-error" },
    ready: { text: "已备齐", cls: "badge-ok" },
  }[r.status];

  return (
    <div className={`req-row status-${r.status}`} data-highlight={`${archive.id}:req:${req.id}`}>
      <div className="req-row-main">
        <strong>{requirementLabel(archive, req)}</strong>
        <div className="req-colors">
          <span className="color-chip">
            目标
            <i style={{ background: req.targetColor }} />
            <input
              type="color"
              value={/^#[0-9a-f]{6}$/i.test(req.targetColor) ? req.targetColor : "#000000"}
              onChange={(e) =>
                dispatch({ type: "updateRequirement", id: archive.id, reqId: req.id, patch: { targetColor: e.target.value } })
              }
              title="调整目标色"
            />
          </span>
          <span className="delta-arrow">→</span>
          <span className="color-chip">
            用料
            <i style={{ background: mat?.color ?? "#ddd" }} />
          </span>
          {r.status !== "unassigned" && (
            <span className={r.delta > COLOR_DELTA_LIMIT ? "delta bad" : "delta ok"}>
              色差 {r.delta}/{COLOR_DELTA_LIMIT}
            </span>
          )}
        </div>
      </div>

      <label className="qty">
        数量
        <input
          type="number"
          min={1}
          value={req.qty}
          onChange={(e) =>
            dispatch({
              type: "updateRequirement",
              id: archive.id,
              reqId: req.id,
              patch: { qty: Math.max(1, Number(e.target.value) || 1) },
            })
          }
        />
      </label>

      <select
        value={req.materialId ?? ""}
        onChange={(e) =>
          dispatch({
            type: "updateRequirement",
            id: archive.id,
            reqId: req.id,
            patch: { materialId: e.target.value || null },
          })
        }
      >
        <option value="">— 未选取色卡 —</option>
        {materials.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}（库存 {m.stock}）
          </option>
        ))}
      </select>

      <span className={`badge ${badge.cls}`}>{badge.text}</span>

      <button
        className="link-btn danger"
        onClick={() => dispatch({ type: "deleteRequirement", id: archive.id, reqId: req.id })}
      >
        删除
      </button>
    </div>
  );
}

// 供外部预检：列出当前档案未备齐需求
export function countBadRequirements(
  archive: Archive,
  materials: Material[],
  reserved: Record<string, number>,
): number {
  return archive.materials.filter((req) => requirementStatus(req, materials, reserved).status !== "ready").length;
}
