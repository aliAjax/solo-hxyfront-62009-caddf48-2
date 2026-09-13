// 地毯修复档案工作台 —— 数据模型与纯业务逻辑

export type Origin = "波斯" | "安纳托利亚" | "高加索" | "藏毯" | "其他";
export const ORIGINS: Origin[] = ["波斯", "安纳托利亚", "高加索", "藏毯", "其他"];

export type DamageType = "磨损" | "缺口" | "褪色" | "虫蛀" | "撕裂" | "污渍";
export const DAMAGE_TYPES: DamageType[] = ["磨损", "缺口", "褪色", "虫蛀", "撕裂", "污渍"];

export type Severity = "轻微" | "中度" | "严重";
export const SEVERITIES: Severity[] = ["轻微", "中度", "严重"];

export const SEVERITY_COLORS: Record<Severity, string> = {
  轻微: "#0f766e",
  中度: "#b45309",
  严重: "#b91c1c",
};

/** 纹样图画布逻辑尺寸（viewBox） */
export const CANVAS_W = 800;
export const CANVAS_H = 560;

/** 破损区域矩形，坐标均为画布逻辑坐标 */
export interface DamageRegion {
  id: string;
  type: DamageType;
  severity: Severity;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 面积占比（%），与矩形面积联动，用户也可手动微调 */
  areaPct: number;
}

/** 材料色卡 */
export interface Material {
  id: string;
  name: string;
  color: string; // #rrggbb
  stock: number; // 库存（米 / 克，按工作室单位）
}

/** 档案的补线需求：需要的颜色 + 数量，可从色卡批量选取材料 */
export interface MaterialRequirement {
  id: string;
  /** 关联的破损区域 id（可为空，表示整毯通用需求） */
  regionId: string | null;
  targetColor: string; // 修复目标色
  qty: number; // 需求量
  materialId: string | null; // 已选取的色卡材料
}

export interface StepDef {
  id: string;
  name: string;
  /** 依赖的前序工序 id */
  deps: string[];
  /** 该工序要求的材料需求 id（材料未备齐不能推进） */
  requires: string[];
}

export const STEP_DEFS: StepDef[] = [
  { id: "clean", name: "除尘清洗", deps: [], requires: [] },
  { id: "photo", name: "纹样测绘建档", deps: ["clean"], requires: [] },
  { id: "match", name: "染线对色", deps: ["photo"], requires: [] },
  { id: "repair", name: "补线修复", deps: ["match"], requires: [] },
  { id: "shape", name: "整毯定型", deps: ["repair"], requires: [] },
  { id: "accept", name: "验收归档", deps: ["shape"], requires: [] },
];

export interface Snapshot {
  id: string;
  label: string;
  createdAt: number;
  note?: string;
  /** true 表示「恢复前自动备份」，恢复时同内容的自动备份会被复用，避免重复堆积 */
  auto?: boolean;
  data: Archive;
}

export interface Archive {
  id: string;
  code: string; // 档案编号 CAR-xxx
  name: string;
  origin: Origin;
  era: string; // 年代
  knotDensity: string; // 结密度
  fiber: string; // 材质
  dye: string; // 染色类型
  patternImage: string | null; // dataURL
  regions: DamageRegion[];
  materials: MaterialRequirement[];
  steps: Record<string, boolean>;
  snapshots: Snapshot[];
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AppState {
  archives: Archive[];
  activeId: string | null;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

let counter = 0;
export function uid(prefix = "id"): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}_${Math.round(Math.random() * 1e6).toString(36)}`;
}

export function nowTs(): number {
  return Date.now();
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function rectAreaPct(r: { w: number; h: number }): number {
  return Math.round(((r.w * r.h) / (CANVAS_W * CANVAS_H)) * 10000) / 100;
}

/** RGB 欧氏距离色差（0~441.7），超过阈值视为不可接受 */
export const COLOR_DELTA_LIMIT = 60;

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [128, 128, 128];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function colorDelta(a: string, b: string): number {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return Math.round(Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2));
}

// ---------------------------------------------------------------------------
// 库存预留
// ---------------------------------------------------------------------------

/** 每个材料被全场需求预留的数量（不考虑是否合格，已选取即预留） */
export function reservedByMaterial(state: AppState): Record<string, number> {
  const map: Record<string, number> = {};
  for (const a of state.archives) {
    for (const req of a.materials) {
      if (req.materialId) map[req.materialId] = (map[req.materialId] ?? 0) + req.qty;
    }
  }
  return map;
}

export type ReqStatus = "unassigned" | "stock" | "delta" | "ready";

/** 单条材料需求是否备齐 */
export function requirementStatus(
  req: MaterialRequirement,
  materials: Material[],
  reserved: Record<string, number>,
): { status: ReqStatus; delta: number; available: number } {
  const mat = materials.find((m) => m.id === req.materialId) ?? null;
  if (!mat) return { status: "unassigned", delta: Infinity, available: 0 };
  const delta = colorDelta(req.targetColor, mat.color);
  const available = mat.stock - (reserved[mat.id] ?? 0);
  if (delta > COLOR_DELTA_LIMIT) return { status: "delta", delta, available };
  if (available < 0) return { status: "stock", delta, available };
  return { status: "ready", delta, available };
}

// ---------------------------------------------------------------------------
// 重叠检测
// ---------------------------------------------------------------------------

export function overlapRatio(
  a: DamageRegion,
  b: DamageRegion,
): number {
  const iw = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const iwClamped = Math.max(0, iw);
  const ih = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const ihClamped = Math.max(0, ih);
  const inter = iwClamped * ihClamped;
  if (inter <= 0) return 0;
  return inter / Math.min(a.w * a.h, b.w * b.h);
}

/** 面积占比超过 2% 的重叠对才上报，避免贴边绘制的误报 */
export const OVERLAP_LIMIT = 0.02;

export function findOverlaps(regions: DamageRegion[]): Array<[DamageRegion, DamageRegion, number]> {
  const out: Array<[DamageRegion, DamageRegion, number]> = [];
  for (let i = 0; i < regions.length; i += 1) {
    for (let j = i + 1; j < regions.length; j += 1) {
      const ratio = overlapRatio(regions[i], regions[j]);
      if (ratio > OVERLAP_LIMIT) out.push([regions[i], regions[j], ratio]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 工序门槛
// ---------------------------------------------------------------------------

export function canToggleStep(archive: Archive, stepId: string): boolean {
  const def = STEP_DEFS.find((s) => s.id === stepId);
  if (!def) return false;
  const currentlyOn = archive.steps[stepId] === true;
  if (currentlyOn) return true; // 允许取消勾选（取消会连带取消后续工序）
  for (const dep of def.deps) {
    if (archive.steps[dep] !== true) return false;
  }
  return true;
}

export function stepBlockReason(archive: Archive, stepId: string): string | null {
  const def = STEP_DEFS.find((s) => s.id === stepId);
  if (!def) return null;
  if (archive.steps[stepId]) return null;
  for (const dep of def.deps) {
    if (archive.steps[dep] !== true) {
      const depDef = STEP_DEFS.find((s) => s.id === dep);
      return `需先完成「${depDef?.name ?? dep}」`;
    }
  }
  return null;
}

/** 修复工序（repair）要求所有补线需求备齐 */
export function repairMaterialReady(archive: Archive, materials: Material[], reserved: Record<string, number>): boolean {
  return archive.materials.every((req) => requirementStatus(req, materials, reserved).status === "ready");
}

/** 找出现有勾选但前序未完成的工序（导入快照/旧数据可能产生倒置） */
export function findInvertedSteps(archive: Archive): string[] {
  const out: string[] = [];
  for (const def of STEP_DEFS) {
    if (archive.steps[def.id] === true && def.deps.some((d) => archive.steps[d] !== true)) {
      out.push(def.id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 归档验收
// ---------------------------------------------------------------------------

export interface ArchiveBlockers {
  noImage: boolean;
  overlaps: number;
  badRequirements: number; // 色差超限 / 缺货 / 未选材料
  stepsIncomplete: boolean;
}

export function archiveBlockers(
  archive: Archive,
  materials: Material[],
  reserved: Record<string, number>,
): ArchiveBlockers {
  return {
    noImage: !archive.patternImage,
    overlaps: findOverlaps(archive.regions).length,
    badRequirements: archive.materials.filter(
      (req) => requirementStatus(req, materials, reserved).status !== "ready",
    ).length,
    stepsIncomplete: STEP_DEFS.some((s) => archive.steps[s.id] !== true),
  };
}

export function canArchive(archive: Archive, materials: Material[], reserved: Record<string, number>): boolean {
  if (archive.archived) return false;
  const b = archiveBlockers(archive, materials, reserved);
  return !b.noImage && b.overlaps === 0 && b.badRequirements === 0 && !b.stepsIncomplete;
}

// ---------------------------------------------------------------------------
// 冲突
// ---------------------------------------------------------------------------

export type ConflictKind = "missing-image" | "overlap" | "material" | "inverted";
export type ConflictLevel = "error" | "warning";

export interface Conflict {
  id: string;
  kind: ConflictKind;
  level: ConflictLevel;
  archiveId: string;
  archiveCode: string;
  message: string;
  /** 定位目标：tab + 元素 key */
  tab: "pattern" | "materials" | "process";
  target: string;
}

export function buildConflicts(state: AppState, materials: Material[]): Conflict[] {
  const reserved = reservedByMaterial(state);
  const out: Conflict[] = [];
  for (const a of state.archives) {
    if (!a.patternImage) {
      out.push({
        id: `${a.id}:img`,
        kind: "missing-image",
        level: "error",
        archiveId: a.id,
        archiveCode: a.code,
        message: "缺少纹样图，无法定位破损区域",
        tab: "pattern",
        target: `${a.id}:image`,
      });
    }
    findOverlaps(a.regions).forEach(([r1, r2, ratio], idx) => {
      out.push({
        id: `${a.id}:ov:${r1.id}:${r2.id}`,
        kind: "overlap",
        level: "error",
        archiveId: a.id,
        archiveCode: a.code,
        message: `破损区域 ${regionLabel(a, r1, idx)} 与 ${regionLabelById(a, r2.id)} 重叠（${Math.round(ratio * 100)}%）`,
        tab: "pattern",
        target: `${a.id}:region:${r1.id}`,
      });
    });
    a.materials.forEach((req) => {
      const r = requirementStatus(req, materials, reserved);
      if (r.status === "unassigned") {
        out.push({
          id: `${a.id}:req:${req.id}`,
          kind: "material",
          level: "error",
          archiveId: a.id,
          archiveCode: a.code,
          message: `${requirementLabel(a, req)}：未选取色卡材料`,
          tab: "materials",
          target: `${a.id}:req:${req.id}`,
        });
      } else if (r.status === "delta") {
        out.push({
          id: `${a.id}:req:${req.id}`,
          kind: "material",
          level: "error",
          archiveId: a.id,
          archiveCode: a.code,
          message: `${requirementLabel(a, req)}：色差 ${r.delta} 超过限值 ${COLOR_DELTA_LIMIT}`,
          tab: "materials",
          target: `${a.id}:req:${req.id}`,
        });
      } else if (r.status === "stock") {
        out.push({
          id: `${a.id}:req:${req.id}`,
          kind: "material",
          level: "error",
          archiveId: a.id,
          archiveCode: a.code,
          message: `${requirementLabel(a, req)}：库存不足（缺口 ${Math.abs(r.available)}）`,
          tab: "materials",
          target: `${a.id}:req:${req.id}`,
        });
      }
    });
    for (const sid of findInvertedSteps(a)) {
      const def = STEP_DEFS.find((s) => s.id === sid);
      out.push({
        id: `${a.id}:step:${sid}`,
        kind: "inverted",
        level: "warning",
        archiveId: a.id,
        archiveCode: a.code,
        message: `工序倒置：「${def?.name ?? sid}」已完成但存在未完成的前序工序`,
        tab: "process",
        target: `${a.id}:step:${sid}`,
      });
    }
  }
  return out;
}

export function regionLabel(archive: Archive, region: DamageRegion, _idx?: number): string {
  const idx = archive.regions.findIndex((r) => r.id === region.id);
  return `${idx + 1} 号${region.type}区`;
}

export function regionLabelById(archive: Archive, id: string): string {
  const r = archive.regions.find((x) => x.id === id);
  return r ? regionLabel(archive, r) : "未知区域";
}

export function requirementLabel(archive: Archive, req: MaterialRequirement): string {
  if (req.regionId) {
    const r = archive.regions.find((x) => x.id === req.regionId);
    if (r) return `${regionLabel(archive, r)}补线`;
  }
  return `补线需求 ${archive.materials.indexOf(req) + 1}`;
}

// ---------------------------------------------------------------------------
// 档案操作
// ---------------------------------------------------------------------------

export function emptySteps(): Record<string, boolean> {
  return Object.fromEntries(STEP_DEFS.map((s) => [s.id, false]));
}

/** 纯函数：从现有编号推导首个未占用的 CAR-N（N 从 140 起） */
export function nextCode(archives: Archive[]): string {
  const used = new Set(archives.map((a) => a.code));
  let n = 140;
  while (used.has(`CAR-${n}`)) n += 1;
  return `CAR-${n}`;
}

export function makeArchive(partial: Partial<Archive> = {}): Archive {
  const ts = nowTs();
  return {
    id: uid("arc"),
    code: "",
    name: "未命名地毯",
    origin: "波斯",
    era: "",
    knotDensity: "",
    fiber: "",
    dye: "",
    patternImage: null,
    regions: [],
    materials: [],
    steps: emptySteps(),
    snapshots: [],
    archived: false,
    createdAt: ts,
    updatedAt: ts,
    ...partial,
  };
}

export function duplicateArchive(archive: Archive): Archive {
  const ts = nowTs();
  const regionIdMap = new Map<string, string>();
  const regions = archive.regions.map((r) => {
    const id = uid("reg");
    regionIdMap.set(r.id, id);
    return { ...r, id };
  });
  const materials = archive.materials.map((m) => ({
    ...m,
    id: uid("req"),
    regionId: m.regionId ? regionIdMap.get(m.regionId) ?? null : null,
  }));
  return {
    ...archive,
    id: uid("arc"),
    code: "",
    name: `${archive.name}（副本）`,
    regions,
    materials,
    steps: emptySteps(),
    snapshots: [],
    archived: false,
    createdAt: ts,
    updatedAt: ts,
  };
}

// structuredClone 在现代浏览器可用；保留 JSON 兜底
export function structuredCloneShim<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function cloneArchive(archive: Archive): Archive {
  if (typeof structuredClone === "function") return structuredClone(archive);
  return structuredCloneShim(archive);
}

/**
 * 关键不变量：快照数据必须「拍平」——data 内的 snapshots 永远为空数组。
 * 否则快照会内嵌此前的整棵快照树，每次恢复都会让数据量指数膨胀，
 * 配合纹样图 dataURL 几次恢复即可把 structuredClone/JSON 序列化拖到卡死。
 */
function flatContent(archive: Archive): Archive {
  return { ...cloneArchive(archive), snapshots: [] };
}

export function snapshotArchive(archive: Archive, label: string, note?: string, auto = false): Snapshot {
  return {
    id: uid("snap"),
    label,
    note,
    auto,
    createdAt: nowTs(),
    data: flatContent(archive),
  };
}

/** 两份档案的「业务内容」是否相同（忽略 id/快照列表/时间戳/归档态） */
export function sameArchiveContent(a: Archive, b: Archive): boolean {
  const strip = (x: Archive) => ({
    code: x.code,
    name: x.name,
    origin: x.origin,
    era: x.era,
    knotDensity: x.knotDensity,
    fiber: x.fiber,
    dye: x.dye,
    patternImage: x.patternImage,
    regions: x.regions,
    materials: x.materials,
    steps: x.steps,
  });
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

/**
 * 迁移/净化历史数据：把旧版本可能嵌套的快照树拍平。
 * 顶层快照列表保留，每个快照内部的 snapshots 清空（被嵌套的快照都已在顶层存在）。
 */
export function flattenNestedSnapshots(snapshots: Snapshot[]): Snapshot[] {
  return snapshots.map((s) =>
    s.data && Array.isArray(s.data.snapshots) && s.data.snapshots.length > 0
      ? { ...s, data: { ...s.data, snapshots: [] } }
      : s,
  );
}

// ---------------------------------------------------------------------------
// 示例纹样图（内联 SVG dataURL）
// ---------------------------------------------------------------------------

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function samplePattern(variant: 0 | 1 | 2 = 0): string {
  const palettes = [
    { bg: "#7c2d12", fg: "#e8b04b", fg2: "#0f766e", line: "#f3d9a4" },
    { bg: "#1e3a5f", fg: "#d98c3f", fg2: "#9c2b2b", line: "#e9d8b8" },
    { bg: "#3f2d52", fg: "#c8923f", fg2: "#0f766e", line: "#e6d3b0" },
  ];
  const c = palettes[variant];
  const medallion = `<ellipse cx="400" cy="280" rx="180" ry="130" fill="none" stroke="${c.fg}" stroke-width="10"/>
    <ellipse cx="400" cy="280" rx="120" ry="84" fill="none" stroke="${c.fg2}" stroke-width="6"/>
    <path d="M400 150 L430 250 L400 410 L370 250 Z" fill="${c.fg}" opacity="0.55"/>
    <circle cx="400" cy="280" r="26" fill="${c.line}"/>`;
  const corners = [140, 660, 140, 660];
  const cornerYs = [120, 120, 440, 440];
  const cornersSvg = corners
    .map(
      (x, i) =>
        `<path d="M${x - 60} ${cornerYs[i]} q60 -50 120 0 q-60 50 -120 0Z" fill="${c.fg2}" opacity="0.7"/>
         <circle cx="${x}" cy="${cornerYs[i]}" r="14" fill="${c.line}"/>`,
    )
    .join("");
  let vines = "";
  for (let i = 0; i < 5; i += 1) {
    const y = 90 + i * 95;
    vines += `<path d="M40 ${y} C 200 ${y - 60}, 300 ${y + 60}, 400 ${y} S 620 ${y - 60}, 760 ${y}" fill="none" stroke="${c.line}" stroke-width="3" opacity="0.5"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}">
    <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="${c.bg}"/>
    <rect x="24" y="24" width="${CANVAS_W - 48}" height="${CANVAS_H - 48}" fill="none" stroke="${c.fg}" stroke-width="14"/>
    <rect x="44" y="44" width="${CANVAS_W - 88}" height="${CANVAS_H - 88}" fill="none" stroke="${c.line}" stroke-width="3" opacity="0.7"/>
    ${vines}
    ${medallion}
    ${cornersSvg}
  </svg>`;
  return svgDataUrl(svg);
}

/** 上传图片压缩为不超过画布尺寸的 jpeg/png dataURL */
export function fileToPatternDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("图片解析失败"));
      img.onload = () => {
        const scale = Math.min(1, CANVAS_W / img.width, CANVAS_H / img.height);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(String(reader.result));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// 种子数据
// ---------------------------------------------------------------------------

export function seedMaterials(): Material[] {
  return [
    { id: "mat_wool_rust", name: "铁锈红羊毛线", color: "#8a3324", stock: 120 },
    { id: "mat_wool_gold", name: "旧金羊毛线", color: "#c9962e", stock: 80 },
    { id: "mat_wool_cream", name: "米白羊毛线", color: "#e6d8bd", stock: 200 },
    { id: "mat_wool_teal", name: "松石绿羊毛线", color: "#0f766e", stock: 60 },
    { id: "mat_wool_navy", name: "靛蓝羊毛线", color: "#1f3a63", stock: 18 },
    { id: "mat_silk_crimson", name: "绛红真丝线", color: "#991b1b", stock: 45 },
    { id: "mat_wool_brown", name: "深棕羊毛线", color: "#5b3a22", stock: 150 },
    { id: "mat_wool_black", name: "炭黑羊毛线", color: "#26231f", stock: 90 },
    { id: "mat_cotton_white", name: "本白棉经线", color: "#efe7d6", stock: 300 },
    { id: "mat_wool_sky", name: "灰蓝羊毛线", color: "#6b8aa8", stock: 35 },
  ];
}

export function seedState(): AppState {
  const ts = nowTs();

  const a1 = makeArchive({
    code: "CAR-092",
    name: "波斯边缘磨损毯",
    origin: "波斯",
    era: "约 1960s",
    knotDensity: "36 结/英寸",
    fiber: "羊毛",
    dye: "植物染",
    patternImage: samplePattern(0),
  });
  const r1a: DamageRegion = {
    id: uid("reg"),
    type: "磨损",
    severity: "中度",
    x: 60,
    y: 470,
    w: 220,
    h: 60,
    areaPct: 0,
  };
  r1a.areaPct = rectAreaPct(r1a);
  const r1b: DamageRegion = {
    id: uid("reg"),
    type: "褪色",
    severity: "轻微",
    x: 620,
    y: 60,
    w: 120,
    h: 90,
    areaPct: 0,
  };
  r1b.areaPct = rectAreaPct(r1b);
  a1.regions = [r1a, r1b];
  a1.materials = [
    { id: uid("req"), regionId: r1a.id, targetColor: "#8a3324", qty: 30, materialId: "mat_wool_rust" },
    { id: uid("req"), regionId: r1b.id, targetColor: "#c9962e", qty: 12, materialId: "mat_wool_gold" },
  ];
  a1.steps = { ...emptySteps(), clean: true, photo: true };
  a1.updatedAt = ts;

  const a2 = makeArchive({
    code: "CAR-117",
    name: "安纳托利亚中心缺口毯",
    origin: "安纳托利亚",
    era: "约 1930s",
    knotDensity: "42 结/英寸",
    fiber: "羊毛，局部真丝",
    dye: "植物染",
    patternImage: samplePattern(1),
  });
  const r2a: DamageRegion = {
    id: uid("reg"),
    type: "缺口",
    severity: "严重",
    x: 350,
    y: 250,
    w: 110,
    h: 90,
    areaPct: 0,
  };
  r2a.areaPct = rectAreaPct(r2a);
  const r2b: DamageRegion = {
    id: uid("reg"),
    type: "虫蛀",
    severity: "中度",
    x: 520,
    y: 380,
    w: 80,
    h: 70,
    areaPct: 0,
  };
  r2b.areaPct = rectAreaPct(r2b);
  a2.regions = [r2a, r2b];
  a2.materials = [
    { id: uid("req"), regionId: r2a.id, targetColor: "#d08f3e", qty: 40, materialId: "mat_wool_gold" },
    // 未选取材料：验收「批量选取 + 未选材料」流程
    { id: uid("req"), regionId: r2a.id, targetColor: "#8f1b1b", qty: 20, materialId: null },
    { id: uid("req"), regionId: r2b.id, targetColor: "#5b3a22", qty: 15, materialId: "mat_wool_brown" },
  ];
  a2.steps = { ...emptySteps(), clean: true };
  a2.updatedAt = ts;

  const a3 = makeArchive({
    code: "CAR-138",
    name: "藏式靛蓝褪色毯",
    origin: "藏毯",
    era: "约 1980s",
    knotDensity: "30 结/英寸",
    fiber: "羊毛",
    dye: "植物染（靛蓝）",
    patternImage: samplePattern(2),
  });
  const r3a: DamageRegion = {
    id: uid("reg"),
    type: "褪色",
    severity: "中度",
    x: 120,
    y: 140,
    w: 260,
    h: 180,
    areaPct: 0,
  };
  r3a.areaPct = rectAreaPct(r3a);
  a3.regions = [r3a];
  // 靛蓝需求 60，库存仅 18 → 库存不足冲突，阻止归档
  a3.materials = [
    { id: uid("req"), regionId: r3a.id, targetColor: "#243f68", qty: 60, materialId: "mat_wool_navy" },
  ];
  a3.steps = { ...emptySteps() };
  a3.updatedAt = ts;

  return { archives: [a1, a2, a3], activeId: a2.id };
}
