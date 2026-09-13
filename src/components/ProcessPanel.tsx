import { useMemo, useState } from "react";
import {
  AppState,
  Archive,
  Material,
  STEP_DEFS,
  archiveBlockers,
  canArchive,
  formatTime,
  findInvertedSteps,
  repairMaterialReady,
  reservedByMaterial,
} from "../model";
import { Action, stepAdvanceBlocked } from "../store";

interface Props {
  archive: Archive;
  materials: Material[];
  state: AppState;
  dispatch: React.Dispatch<Action>;
}

export default function ProcessPanel({ archive, materials, state, dispatch }: Props) {
  const reserved = useMemo(() => reservedByMaterial(state), [state]);
  const [note, setNote] = useState("");
  const inverted = new Set(findInvertedSteps(archive));

  const blockers = archiveBlockers(archive, materials, reserved);
  const archivable = canArchive(archive, materials, reserved);
  const blockerItems: Array<{ ok: boolean; text: string }> = [
    { ok: !blockers.noImage, text: blockers.noImage ? "缺少纹样图" : "纹样图已上传" },
    { ok: blockers.overlaps === 0, text: blockers.overlaps === 0 ? "无区域重叠" : `存在 ${blockers.overlaps} 组区域重叠` },
    {
      ok: blockers.badRequirements === 0,
      text: blockers.badRequirements === 0 ? "补线材料全部备齐" : `${blockers.badRequirements} 项补线需求未备齐（色差/缺货/未选取）`,
    },
    { ok: !blockers.stepsIncomplete, text: blockers.stepsIncomplete ? "修复工序未全部完成" : "修复工序全部完成" },
  ];

  return (
    <div className="process-panel">
      <section className="subpanel">
        <div className="subpanel-head">
          <h3>修复工序（严格按依赖推进，不可跳过）</h3>
        </div>
        <ol className="step-list">
          {STEP_DEFS.map((def, i) => {
            const done = archive.steps[def.id] === true;
            const reason = stepAdvanceBlocked(archive, def.id, materials, reserved);
            const blocked = reason !== null;
            const isInverted = inverted.has(def.id);
            const deps = STEP_DEFS.filter((d) => def.deps.includes(d.id));
            return (
              <li
                key={def.id}
                className={`step ${done ? "done" : ""} ${blocked ? "locked" : ""} ${isInverted ? "inverted" : ""}`}
                data-highlight={`${archive.id}:step:${def.id}`}
              >
                <label className="step-check">
                  <input
                    type="checkbox"
                    checked={done}
                    disabled={blocked && !done}
                    onChange={() => dispatch({ type: "toggleStep", id: archive.id, stepId: def.id, materials })}
                  />
                  <span className="step-index">{i + 1}</span>
                  <span className="step-name">{def.name}</span>
                </label>
                <span className="step-meta">
                  {deps.length > 0 && !done && <em>依赖：{deps.map((d) => d.name).join("、")}</em>}
                  {def.id === "repair" && !repairMaterialReady(archive, materials, reserved) && (
                    <em className="gate-warn">材料未备齐，不能补线</em>
                  )}
                  {isInverted && <em className="gate-warn">工序倒置</em>}
                  {blocked && !done && <b className="lock-reason" title={reason ?? ""}>🔒 {reason}</b>}
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="subpanel">
        <div className="subpanel-head">
          <h3>归档验收</h3>
        </div>
        <ul className="gate-list">
          {blockerItems.map((b) => (
            <li key={b.text} className={b.ok ? "ok" : "bad"}>
              <span>{b.ok ? "✓" : "✕"}</span> {b.text}
            </li>
          ))}
        </ul>
        {archive.archived ? (
          <div className="archive-bar">
            <span className="badge badge-ok">已于 {formatTime(archive.updatedAt)} 归档</span>
            <button className="small" onClick={() => dispatch({ type: "unarchive", id: archive.id })}>
              撤销归档继续编辑
            </button>
          </div>
        ) : (
          <button
            className="primary"
            disabled={!archivable}
            title={archivable ? "" : "存在阻止归档的问题，请按上方清单处理"}
            onClick={() => {
              if (window.confirm(`确认归档 ${archive.code}「${archive.name}」？`)) {
                dispatch({ type: "archive", id: archive.id, materials });
              }
            }}
          >
            归档档案
          </button>
        )}
      </section>

      <section className="subpanel">
        <div className="subpanel-head">
          <h3>版本快照（{archive.snapshots.length}）</h3>
        </div>
        <div className="snapshot-create">
          <input
            placeholder="快照备注（可选，如：初版测绘）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button
            className="small"
            onClick={() => {
              dispatch({
                type: "createSnapshot",
                id: archive.id,
                label: note.trim() || `手动快照`,
                note: note.trim() || undefined,
              });
              setNote("");
            }}
          >
            创建快照
          </button>
        </div>
        <p className="hint">恢复旧版本前会自动备份当前状态，历史快照始终保留。</p>
        {archive.snapshots.length === 0 && <p className="empty-hint">还没有版本快照</p>}
        <ul className="snapshot-list">
          {archive.snapshots.map((s) => (
            <li key={s.id}>
              <div>
                <strong>{s.label}</strong>
                <span>{formatTime(s.createdAt)}</span>
                {s.note && <em>{s.note}</em>}
              </div>
              <div className="snapshot-actions">
                <button
                  className="link-btn"
                  onClick={() => {
                    if (window.confirm("恢复到该版本？当前状态会先自动备份为快照，不会丢失。")) {
                      dispatch({ type: "restoreSnapshot", id: archive.id, snapshotId: s.id });
                    }
                  }}
                >
                  恢复
                </button>
                <button
                  className="link-btn danger"
                  onClick={() => {
                    if (window.confirm("删除该快照？")) {
                      dispatch({ type: "deleteSnapshot", id: archive.id, snapshotId: s.id });
                    }
                  }}
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
