import { useRef, useState } from "react";
import {
  Archive,
  CANVAS_H,
  CANVAS_W,
  DamageRegion,
  DamageType,
  DAMAGE_TYPES,
  SEVERITIES,
  SEVERITY_COLORS,
  Severity,
  clamp,
  fileToPatternDataUrl,
  rectAreaPct,
  regionLabel,
  samplePattern,
  uid,
} from "../model";
import { Action } from "../store";

interface Props {
  archive: Archive;
  dispatch: React.Dispatch<Action>;
}

type Tool = "select" | "draw";
const MIN_SIZE = 8;

interface DragState {
  mode: "draw" | "move" | "resize";
  handle?: "nw" | "ne" | "sw" | "se";
  pointerId: number;
  start: { x: number; y: number };
  orig: DamageRegion;
  regionId: string;
}

export default function PatternEditor({ archive, dispatch }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const drag = useRef<DragState | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DamageRegion | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const selected = archive.regions.find((r) => r.id === selectedId) ?? null;

  function toSvg(clientX: number, clientY: number) {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    const p = toSvg(e.clientX, e.clientY);
    const target = e.target as Element;

    if (tool === "draw") {
      const region: DamageRegion = {
        id: uid("reg"),
        type: "磨损",
        severity: "中度",
        x: clamp(p.x, 0, CANVAS_W),
        y: clamp(p.y, 0, CANVAS_H),
        w: 0,
        h: 0,
        areaPct: 0,
      };
      drag.current = { mode: "draw", pointerId: e.pointerId, start: p, orig: region, regionId: region.id };
      setDraft(region);
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }

    // select 模式：判断点中的是缩放手柄还是区域
    const handle = target.getAttribute("data-handle") as DragState["handle"] | null;
    const regionId = target.getAttribute("data-region");
    if (regionId) {
      const region = archive.regions.find((r) => r.id === regionId);
      if (!region) return;
      setSelectedId(regionId);
      drag.current = {
        mode: handle ? "resize" : "move",
        handle: handle ?? undefined,
        pointerId: e.pointerId,
        start: p,
        orig: { ...region },
        regionId,
      };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } else {
      setSelectedId(null);
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const p = toSvg(e.clientX, e.clientY);

    if (d.mode === "draw") {
      const x = clamp(Math.min(d.start.x, p.x), 0, CANVAS_W);
      const y = clamp(Math.min(d.start.y, p.y), 0, CANVAS_H);
      const x2 = clamp(Math.max(d.start.x, p.x), 0, CANVAS_W);
      const y2 = clamp(Math.max(d.start.y, p.y), 0, CANVAS_H);
      setDraft({ ...d.orig, x, y, w: x2 - x, h: y2 - y, areaPct: rectAreaPct({ w: x2 - x, h: y2 - y }) });
      return;
    }

    const o = d.orig;
    let nx = o.x;
    let ny = o.y;
    let nx2 = o.x + o.w;
    let ny2 = o.y + o.h;

    if (d.mode === "move") {
      const dx = p.x - d.start.x;
      const dy = p.y - d.start.y;
      nx = clamp(o.x + dx, 0, CANVAS_W - o.w);
      ny = clamp(o.y + dy, 0, CANVAS_H - o.h);
      nx2 = nx + o.w;
      ny2 = ny + o.h;
    } else {
      const dx = p.x - d.start.x;
      const dy = p.y - d.start.y;
      const h = d.handle;
      if (h === "nw" || h === "sw") nx = clamp(o.x + dx, 0, nx2 - MIN_SIZE);
      if (h === "ne" || h === "se") nx2 = clamp(o.x + o.w + dx, nx + MIN_SIZE, CANVAS_W);
      if (h === "nw" || h === "ne") ny = clamp(o.y + dy, 0, ny2 - MIN_SIZE);
      if (h === "sw" || h === "se") ny2 = clamp(o.y + o.h + dy, ny + MIN_SIZE, CANVAS_H);
    }

    const w = nx2 - nx;
    const h = ny2 - ny;
    setDraft({ ...o, x: nx, y: ny, w, h, areaPct: rectAreaPct({ w, h }) });
  }

  function onPointerUp(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    const ended = draft;
    setDraft(null);
    if (!ended) return;

    if (d.mode === "draw") {
      if (ended.w >= MIN_SIZE && ended.h >= MIN_SIZE) {
        dispatch({ type: "addRegion", id: archive.id, region: ended });
        setSelectedId(ended.id);
        setTool("select");
      }
      return;
    }
    // 移动 / 缩放整体提交一次，撤销栈只占一条
    dispatch({
      type: "updateRegion",
      id: archive.id,
      regionId: d.regionId,
      patch: { x: ended.x, y: ended.y, w: ended.w, h: ended.h, areaPct: ended.areaPct },
    });
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const url = await fileToPatternDataUrl(file);
      dispatch({ type: "setPatternImage", id: archive.id, image: url });
      setUploadError(null);
    } catch {
      setUploadError("图片读取失败，请换一张图片");
    }
  }

  function patchSelected(patch: Partial<DamageRegion>) {
    if (!selected) return;
    dispatch({ type: "updateRegion", id: archive.id, regionId: selected.id, patch });
  }

  return (
    <div className="pattern-editor">
      <div className="editor-toolbar">
        <div className="tool-group" role="tablist" aria-label="绘制工具">
          <button className={tool === "select" ? "chip active" : "chip"} onClick={() => setTool("select")}>
            ▣ 选择 / 移动
          </button>
          <button className={tool === "draw" ? "chip active" : "chip"} onClick={() => setTool("draw")}>
            ✎ 绘制破损区
          </button>
        </div>
        <div className="tool-group" data-highlight={`${archive.id}:image`}>
          <button className="small" onClick={() => fileRef.current?.click()}>
            上传纹样图
          </button>
          <button
            className="small"
            onClick={() =>
              dispatch({
                type: "setPatternImage",
                id: archive.id,
                image: samplePattern((archive.code.length % 3) as 0 | 1 | 2),
              })
            }
          >
            示例纹样
          </button>
          {archive.patternImage && (
            <button
              className="small"
              onClick={() => {
                if (window.confirm("移除纹样图？移除后将产生「缺图」冲突。")) {
                  dispatch({ type: "setPatternImage", id: archive.id, image: null });
                }
              }}
            >
              移除
            </button>
          )}
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickFile} />
        </div>
      </div>
      {uploadError && <p className="inline-error">{uploadError}</p>}

      <div className="canvas-wrap">
        <svg
          ref={svgRef}
          className="canvas"
          viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <rect x={0} y={0} width={CANVAS_W} height={CANVAS_H} fill="#f3ece2" />
          {archive.patternImage ? (
            <image href={archive.patternImage} x={0} y={0} width={CANVAS_W} height={CANVAS_H} />
          ) : (
            <g className="no-image-hint">
              <text x={CANVAS_W / 2} y={CANVAS_H / 2 - 12} textAnchor="middle">
                缺少纹样图
              </text>
              <text x={CANVAS_W / 2} y={CANVAS_H / 2 + 18} textAnchor="middle" className="hint-sub">
                仍可绘制区域，但归档前必须上传纹样图
              </text>
            </g>
          )}

          <g style={{ pointerEvents: tool === "draw" ? "none" : "auto" }}>
            {archive.regions.map((r, i) => {
              const color = SEVERITY_COLORS[r.severity];
              const isDragging = draft && drag.current?.regionId === r.id;
              return (
                <g
                  key={r.id}
                  data-highlight={`${archive.id}:region:${r.id}`}
                  opacity={isDragging ? 0.35 : 1}
                >
                  <rect
                    data-region={r.id}
                    x={r.x}
                    y={r.y}
                    width={r.w}
                    height={r.h}
                    fill={color}
                    fillOpacity={selectedId === r.id ? 0.28 : 0.16}
                    stroke={color}
                    strokeWidth={selectedId === r.id ? 3 : 2}
                    strokeDasharray={selectedId === r.id ? "none" : "7 4"}
                    rx={4}
                    style={{ cursor: tool === "select" ? "move" : "crosshair" }}
                  />
                  <rect x={r.x} y={r.y - 26} width={108} height={22} rx={4} fill={color} />
                  <text x={r.x + 8} y={r.y - 9} fill="#fff" fontSize={15}>
                    {`${i + 1} ${r.type}·${r.severity}`}
                  </text>
                  {selectedId === r.id && tool === "select" && (
                    <Handles regionId={r.id} x={r.x} y={r.y} w={r.w} h={r.h} />
                  )}
                </g>
              );
            })}
          </g>

          {draft && (
            <rect
              x={draft.x}
              y={draft.y}
              width={draft.w}
              height={draft.h}
              fill="none"
              stroke="#1d4ed8"
              strokeWidth={2}
              strokeDasharray="5 3"
              pointerEvents="none"
            />
          )}
        </svg>
        <p className="canvas-tip">
          {tool === "draw"
            ? "在图上按住拖动即可框选破损区域，松开完成"
            : "拖动区域可移动，拖四角手柄可调整大小；点击区域可编辑"}
        </p>
      </div>

      {selected ? (
        <RegionForm
          archive={archive}
          region={selected}
          dispatch={dispatch}
          patch={patchSelected}
          onClose={() => setSelectedId(null)}
        />
      ) : (
        <div className="region-rows">
          <p className="section-label">破损区域列表（{archive.regions.length}）</p>
          {archive.regions.length === 0 && <p className="empty-hint">切换到「绘制破损区」工具，在纹样图上框选</p>}
          {archive.regions.map((r, i) => (
            <button key={r.id} className="region-row" onClick={() => setSelectedId(r.id)}>
              <span className="dot" style={{ background: SEVERITY_COLORS[r.severity] }} />
              {i + 1}. {r.type} · {r.severity} · {r.areaPct.toFixed(2)}%
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Handles({ regionId, x, y, w, h }: { regionId: string; x: number; y: number; w: number; h: number }) {
  const size = 14;
  const defs: Array<{ h: "nw" | "ne" | "sw" | "se"; cx: number; cy: number }> = [
    { h: "nw", cx: x, cy: y },
    { h: "ne", cx: x + w, cy: y },
    { h: "sw", cx: x, cy: y + h },
    { h: "se", cx: x + w, cy: y + h },
  ];
  return (
    <g>
      {defs.map((d) => (
        <rect
          key={d.h}
          data-handle={d.h}
          data-region={regionId}
          x={d.cx - size / 2}
          y={d.cy - size / 2}
          width={size}
          height={size}
          fill="#ffffff"
          stroke="#1d4ed8"
          strokeWidth={2}
          rx={2}
          style={{ cursor: `${d.h}-resize` }}
        />
      ))}
    </g>
  );
}

function RegionForm({
  archive,
  region,
  dispatch,
  patch,
  onClose,
}: {
  archive: Archive;
  region: DamageRegion;
  dispatch: React.Dispatch<Action>;
  patch: (p: Partial<DamageRegion>) => void;
  onClose: () => void;
}) {
  const idx = archive.regions.findIndex((r) => r.id === region.id);
  return (
    <div className="region-form" data-highlight={`${archive.id}:region:${region.id}`}>
      <div className="region-form-head">
        <strong>
          {idx + 1} 号破损区 · {regionLabel(archive, region)}
        </strong>
        <button className="link-btn" onClick={onClose}>
          完成
        </button>
      </div>
      <div className="region-form-grid">
        <label>
          <span>破损类型</span>
          <select value={region.type} onChange={(e) => patch({ type: e.target.value as DamageType })}>
            {DAMAGE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>严重度</span>
          <select
            value={region.severity}
            onChange={(e) => patch({ severity: e.target.value as Severity })}
          >
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>面积占比（%，可手动覆盖）</span>
          <input
            type="number"
            min={0}
            max={100}
            step={0.01}
            value={region.areaPct}
            onChange={(e) => patch({ areaPct: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
          />
        </label>
        <label>
          <span>位置 / 尺寸（逻辑坐标）</span>
          <input value={`x${Math.round(region.x)} y${Math.round(region.y)} · ${Math.round(region.w)}×${Math.round(region.h)}`} readOnly />
        </label>
      </div>
      <div className="region-form-actions">
        <button
          className="small"
          onClick={() =>
            dispatch({
              type: "addRequirement",
              id: archive.id,
              req: { id: uid("req"), regionId: region.id, targetColor: "#8a3324", qty: 10, materialId: null },
            })
          }
        >
          为此区域添加补线需求
        </button>
        <button
          className="small danger-outline"
          onClick={() => {
            if (window.confirm("删除该破损区域？关联的补线需求会一并删除，可用撤销恢复。")) {
              dispatch({ type: "deleteRegion", id: archive.id, regionId: region.id });
              onClose();
            }
          }}
        >
          删除区域
        </button>
      </div>
    </div>
  );
}
