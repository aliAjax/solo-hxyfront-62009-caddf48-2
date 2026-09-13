// 业务规则验收脚本（node 运行），覆盖多档案 / 多破损区域 / 库存冲突 / 工序门槛 / 快照 / 撤销重做
import assert from "node:assert/strict";
import {
  AppState,
  Archive,
  COLOR_DELTA_LIMIT,
  STEP_DEFS,
  buildConflicts,
  canArchive,
  archiveBlockers,
  colorDelta,
  findOverlaps,
  flattenNestedSnapshots,
  makeArchive,
  nextCode,
  rectAreaPct,
  reservedByMaterial,
  requirementStatus,
  sameArchiveContent,
  seedMaterials,
  seedState,
  emptySteps,
  snapshotArchive,
  uid,
} from "../src/model.ts";
import { coreReducer, historyReducer, undoHistory, redoHistory, sanitize, stepAdvanceBlocked, type Action } from "../src/store.ts";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const mats = seedMaterials();
let state: AppState = seedState();
const [a1, a2, a3] = state.archives;

console.log("\n[1] 种子数据：多档案、多破损区域");
check("3 份档案，CAR-117 为当前档案", () => {
  assert.equal(state.archives.length, 3);
  assert.equal(state.activeId, a2.id);
});
check("破损区域数量 2/2/1，面积占比按矩形自动计算", () => {
  assert.equal(a1.regions.length, 2);
  assert.equal(a2.regions.length, 2);
  assert.equal(a3.regions.length, 1);
  const r = a1.regions[0];
  assert.ok(Math.abs(r.areaPct - rectAreaPct(r)) < 1e-9);
  assert.ok(r.areaPct > 0 && r.areaPct < 100);
});

console.log("\n[2] 新增 / 复制 / 搜索基础操作");
check("新增档案自动编号 CAR-140 并成为当前档案", () => {
  const s = coreReducer(state, { type: "addArchive" });
  assert.equal(s.archives.length, 4);
  assert.equal(s.archives[3].code, "CAR-140");
  assert.equal(s.activeId, s.archives[3].id);
});
check("复制档案：区域与需求重新映射 id，工序/快照重置，编号递增、名称带副本", () => {
  const s = coreReducer(state, { type: "duplicateArchive", id: a2.id });
  const copy = s.archives.find((a) => a.id !== a2.id && a.name.includes("副本"))!;
  assert.ok(copy, "副本存在");
  assert.equal(copy.regions.length, 2);
  assert.equal(copy.materials.length, 3);
  assert.equal(copy.code, "CAR-140");
  assert.equal(Object.values(copy.steps).some(Boolean), false);
  assert.deepEqual(copy.snapshots, []);
  // 区域 id 已重新生成且需求的 regionId 正确重映射
  const mapped = copy.regions.map((r) => r.id);
  assert.ok(copy.materials.filter((m) => m.regionId).every((m) => mapped.includes(m.regionId!)));
  assert.ok(!a2.regions.some((r) => mapped.includes(r.id)), "区域 id 不与原档案重复");
});

console.log("\n[3] 冲突实时汇总：缺图 / 重叠 / 材料不足 / 工序倒置");
check("种子状态含材料冲突（CAR-117 未选材料 + CAR-138 库存不足）", () => {
  const conflicts = buildConflicts(state, mats);
  const kinds = new Set(conflicts.map((c) => c.kind));
  assert.ok(kinds.has("material"));
  const navy = conflicts.find((c) => c.message.includes("库存不足"));
  assert.ok(navy, "靛蓝需求 60 > 库存 18 → 库存不足");
  assert.equal(navy!.archiveCode, "CAR-138");
  const unassigned = conflicts.find((c) => c.message.includes("未选取色卡"));
  assert.ok(unassigned, "CAR-117 有一条未选取材料的需求");
});
check("缺图冲突：移除纹样图后出现", () => {
  const s = coreReducer(state, { type: "setPatternImage", id: a1.id, image: null });
  const conflicts = buildConflicts(s, mats);
  assert.ok(conflicts.some((c) => c.kind === "missing-image" && c.archiveId === a1.id));
});
check("区域重叠：相交超过 2% 才上报，贴边不误报", () => {
  const arc = makeArchive({ code: "T-1" });
  const r1 = { id: "r1", type: "磨损" as const, severity: "中度" as const, x: 0, y: 0, w: 100, h: 100, areaPct: 0 };
  const r2 = { id: "r2", type: "缺口" as const, severity: "严重" as const, x: 90, y: 90, w: 100, h: 100, areaPct: 0 };
  arc.regions = [r1, r2];
  // 相交 10×10=100，占较小面积 10000 的 1%，低于 2% 阈值 → 不上报
  assert.equal(findOverlaps(arc.regions).length, 0);
});
check("重叠阈值确认：10% 相交上报", () => {
  const mk = (x2: number) => [
    { id: "r1", type: "磨损" as const, severity: "中度" as const, x: 0, y: 0, w: 100, h: 100, areaPct: 0 },
    { id: "r2", type: "缺口" as const, severity: "严重" as const, x: x2, y: 0, w: 100, h: 100, areaPct: 0 },
  ];
  assert.equal(findOverlaps(mk(90)).length, 1, "相交 10×100=1000，占比 10%，应报告");
});
check("工序倒置检测：勾选后序但前序未完成", () => {
  const arc = makeArchive({ code: "T-2", steps: { ...emptySteps(), repair: true } });
  const conflicts = buildConflicts({ archives: [arc], activeId: arc.id }, mats);
  assert.ok(conflicts.some((c) => c.kind === "inverted"));
});

console.log("\n[4] 库存预留：全场汇总、跨档案挤占");
check("预留量 = 全场所有已选需求之和", () => {
  const reserved = reservedByMaterial(state);
  const rust = a1.materials[0]; // 铁锈红 30
  assert.equal(reserved[rust.materialId!], 30);
  const navy = a3.materials[0]; // 靛蓝 60
  assert.equal(reserved[navy.materialId!], 60);
});
check("库存不足时需求状态为 stock，补足库存后恢复 ready", () => {
  const reserved = reservedByMaterial(state);
  const req = a3.materials[0];
  assert.equal(requirementStatus(req, mats, reserved).status, "stock");
  const moreStock = mats.map((m) => (m.id === req.materialId ? { ...m, stock: 500 } : m));
  assert.equal(requirementStatus(req, moreStock, reserved).status, "ready");
});
check("色差计算与阈值：超 {COLOR_DELTA_LIMIT} 阻止", () => {
  const d = colorDelta("#000000", "#ffffff");
  assert.ok(d > COLOR_DELTA_LIMIT, `黑白色差 ${d} 超限`);
  const d2 = colorDelta("#8a3324", "#8f3a2a");
  assert.ok(d2 <= COLOR_DELTA_LIMIT, `相近色色差 ${d2} 合格`);
  const req = { id: "x", regionId: null, targetColor: "#000000", qty: 1, materialId: "mat_wool_cream" };
  assert.equal(requirementStatus(req, mats, {}).status, "delta");
});

console.log("\n[5] 工序依赖推进：不能跳过前序，材料未齐不能补线");
check("未完成前序时工序被锁，reducer 忽略勾选", () => {
  const s = coreReducer(state, { type: "toggleStep", id: a3.id, stepId: "repair", materials: mats });
  assert.equal(s.archives.find((a) => a.id === a3.id)!.steps.repair, false);
});
check("染线对色(match)要求材料全部选取；补线(repair)要求全部备齐", () => {
  // a2 有未选取需求：补齐 clean/photo 前序后，match 应因材料未选取被锁
  const a2ReadyDeps: Archive = { ...a2, steps: { ...emptySteps(), clean: true, photo: true } };
  const reason = stepAdvanceBlocked(a2ReadyDeps, "match", mats, reservedByMaterial(state));
  assert.ok(reason?.includes("未选取"), reason ?? "");
  // a1 材料齐全且 clean/photo 已完成，可推进 match
  const r1 = stepAdvanceBlocked(a1, "match", mats, reservedByMaterial(state));
  assert.equal(r1, null);
});
check("正常链路：a1 可依次推进 match → repair（材料备齐）", () => {
  let s = state;
  for (const step of ["match", "repair", "shape", "accept"]) {
    const arc = s.archives.find((a) => a.id === a1.id)!;
    const blocked = stepAdvanceBlocked(arc, step, mats, reservedByMaterial(s));
    assert.equal(blocked, null, `${step} 不应被锁: ${blocked}`);
    s = coreReducer(s, { type: "toggleStep", id: a1.id, stepId: step, materials: mats });
  }
  assert.equal(s.archives.find((a) => a.id === a1.id)!.steps.accept, true);
});
check("取消前序工序会级联取消后续工序", () => {
  let s = state;
  for (const step of ["match", "repair", "shape"]) {
    s = coreReducer(s, { type: "toggleStep", id: a1.id, stepId: step, materials: mats });
  }
  s = coreReducer(s, { type: "toggleStep", id: a1.id, stepId: "photo", materials: mats });
  const arc = s.archives.find((a) => a.id === a1.id)!;
  assert.equal(arc.steps.photo, false);
  assert.equal(arc.steps.match, false);
  assert.equal(arc.steps.repair, false);
  assert.equal(arc.steps.shape, false);
  assert.equal(arc.steps.clean, true, "更前序的 clean 保留");
});

console.log("\n[6] 归档门槛：缺图/重叠/材料/工序任一不满足即阻止");
check("CAR-138 材料不足且工序未完 → 不可归档，阻塞项准确", () => {
  assert.equal(canArchive(a3, mats, reservedByMaterial(state)), false);
  const b = archiveBlockers(a3, mats, reservedByMaterial(state));
  assert.ok(b.badRequirements >= 1);
  assert.equal(b.stepsIncomplete, true);
});
check("全部满足时可归档，归档动作置位", () => {
  // 构造一份完美档案：图 + 区域无重叠 + 材料备齐 + 全工序
  const arc = makeArchive({ code: "CAR-200", patternImage: "data:image/svg+xml,x" });
  arc.regions = [{ id: uid("reg"), type: "磨损", severity: "轻微", x: 0, y: 0, w: 50, h: 50, areaPct: 1 }];
  arc.materials = [
    { id: uid("req"), regionId: arc.regions[0].id, targetColor: "#8a3324", qty: 5, materialId: "mat_wool_rust" },
  ];
  arc.steps = Object.fromEntries(STEP_DEFS.map((d) => [d.id, true]));
  const local: AppState = { archives: [arc], activeId: arc.id };
  assert.equal(canArchive(arc, mats, reservedByMaterial(local)), true);
  const s = coreReducer(local, { type: "archive", id: arc.id, materials: mats });
  assert.equal(s.archives[0].archived, true);
});

console.log("\n[7] 版本快照：创建 / 恢复保留历史 / 不嵌套膨胀（卡死回归）");

/** 统计快照树中所有节点（含嵌套）的数量；修复后除顶层外不应有任何嵌套节点 */
function countNestedSnapshotNodes(archive: Archive): number {
  let n = 0;
  for (const s of archive.snapshots) {
    n += s.data.snapshots.length;
    // 再深一层也必须为 0（旧 bug 会在深处堆积整棵树）
    for (const inner of s.data.snapshots) n += inner.data.snapshots.length;
  }
  return n;
}

/** 估算状态 JSON 体积，用来观察是否指数膨胀 */
function sizeOf(s: unknown): number {
  return JSON.stringify(s).length;
}

check("不变量：创建的快照 data.snapshots 恒为空，绝不内嵌快照树", () => {
  let s = state;
  s = coreReducer(s, { type: "createSnapshot", id: a2.id, label: "v1" });
  s = coreReducer(s, { type: "createSnapshot", id: a2.id, label: "v2" });
  s = coreReducer(s, { type: "createSnapshot", id: a2.id, label: "v3" });
  const arc = s.archives.find((a) => a.id === a2.id)!;
  assert.equal(arc.snapshots.length, 3);
  assert.equal(countNestedSnapshotNodes(arc), 0);
  for (const snap of arc.snapshots) assert.deepEqual(snap.data.snapshots, []);
});

check("恢复旧版本：内容回滚、id 与编号不变、自动备份入列表、取消归档", () => {
  let s = state;
  s = coreReducer(s, { type: "createSnapshot", id: a2.id, label: "v1 初版" });
  let arc = s.archives.find((a) => a.id === a2.id)!;
  const snapId = arc.snapshots[0].id;
  s = coreReducer(s, { type: "updateMeta", id: a2.id, patch: { name: "改名后的毯子" } });
  s = coreReducer(s, { type: "archive", id: a2.id, materials: mats });
  assert.equal(s.archives.find((a) => a.id === a2.id)!.name, "改名后的毯子");
  s = coreReducer(s, { type: "restoreSnapshot", id: a2.id, snapshotId: snapId });
  arc = s.archives.find((a) => a.id === a2.id)!;
  assert.equal(arc.name, a2.name, "名称回到快照时状态");
  assert.equal(arc.archived, false, "恢复后为未归档");
  assert.equal(arc.id, a2.id);
  assert.equal(arc.code, a2.code);
  assert.ok(arc.snapshots.some((x) => x.auto && x.label.includes("恢复前自动备份")), "恢复前自动备份存在");
  assert.ok(arc.snapshots.some((x) => x.id === snapId), "旧快照仍保留");
  assert.equal(countNestedSnapshotNodes(arc), 0, "恢复后仍无嵌套快照");
});

check("连续恢复 5 次：快照数恒定、体积不指数膨胀、每次 <100ms 返回（卡死回归）", () => {
  let s = state;
  // v1 初版快照
  s = coreReducer(s, { type: "createSnapshot", id: a2.id, label: "v1 初版" });
  const v1 = s.archives.find((a) => a.id === a2.id)!.snapshots[0].id;
  // 改名后再拍一张 v2
  s = coreReducer(s, { type: "updateMeta", id: a2.id, patch: { name: "恢复前名字" } });
  s = coreReducer(s, { type: "createSnapshot", id: a2.id, label: "v2 改名" });
  const arc0 = s.archives.find((a) => a.id === a2.id)!;
  const v2 = arc0.snapshots[0].id;
  const baselineSize = sizeOf(arc0);
  const baselineCount = arc0.snapshots.length;

  // 在两个版本间交替恢复 5 次，每次都必须很快返回（奇数次最终落在 v1）
  let latest = s;
  for (let i = 0; i < 5; i += 1) {
    const target = i % 2 === 0 ? v1 : v2;
    const t0 = process.hrtime.bigint();
    latest = coreReducer(latest, { type: "restoreSnapshot", id: a2.id, snapshotId: target });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 100, `第 ${i + 1} 次恢复耗时 ${ms.toFixed(1)}ms 应 < 100ms`);
  }
  const arc = latest.archives.find((a) => a.id === a2.id)!;

  // 两个恢复目标都已存在于快照列表中：任何一次恢复都不需要新增备份，数量恒定
  assert.equal(arc.snapshots.length, baselineCount, `快照数应恒为 ${baselineCount}，实际 ${arc.snapshots.length}`);
  // 体积也应基本不变（只允许因线性新增出现常数倍，这里为 1 倍）
  const finalSize = sizeOf(arc);
  assert.ok(
    finalSize < baselineSize * 1.5,
    `体积疑似膨胀：${finalSize} vs baseline ${baselineSize}`,
  );
  assert.equal(countNestedSnapshotNodes(arc), 0, "连续恢复后深层嵌套仍为 0");

  // 交替恢复 6 次（偶数次），当前内容应等于 v1（原始 a2 内容）
  assert.equal(arc.name, a2.name);
});

check("同一内容连续点恢复：自动备份去重复用，不产生重复 safety", () => {
  let s = state;
  s = coreReducer(s, { type: "createSnapshot", id: a2.id, label: "v1" });
  const v1 = s.archives.find((a) => a.id === a2.id)!.snapshots[0].id;
  // 当前内容 == v1（快照刚由当前状态生成），v1 本身即备份，恢复时复用、不新增
  s = coreReducer(s, { type: "restoreSnapshot", id: a2.id, snapshotId: v1 });
  const n1 = s.archives.find((a) => a.id === a2.id)!.snapshots.length;
  assert.equal(n1, 1, "当前内容已有同名快照时不重复建备份");
  // 不做任何编辑，立即再次恢复同一版本：列表中已有相同内容快照，不新增
  s = coreReducer(s, { type: "restoreSnapshot", id: a2.id, snapshotId: v1 });
  const n2 = s.archives.find((a) => a.id === a2.id)!.snapshots.length;
  assert.equal(n2, n1, "相同内容重复恢复不增加快照");

  // 场景二：当前内容是编辑后的新状态（列表无相同快照）→ 新增 1 条 safety；
  // 再切到别的版本、再切回来时，已保存的 safety 被复用，不会重复建。
  let s2 = state;
  s2 = coreReducer(s2, { type: "createSnapshot", id: a2.id, label: "base" });
  const base = s2.archives.find((a) => a.id === a2.id)!.snapshots[0].id;
  s2 = coreReducer(s2, { type: "updateMeta", id: a2.id, patch: { name: "新状态A" } });
  s2 = coreReducer(s2, { type: "createSnapshot", id: a2.id, label: "verA" });
  const verA = s2.archives.find((a) => a.id === a2.id)!.snapshots[0].id;
  const countBefore = s2.archives.find((a) => a.id === a2.id)!.snapshots.length;
  // 当前 == verA，恢复到 base：无需 safety（verA 已是当前的备份）
  s2 = coreReducer(s2, { type: "restoreSnapshot", id: a2.id, snapshotId: base });
  const countAfterFirst = s2.archives.find((a) => a.id === a2.id)!.snapshots.length;
  assert.equal(countAfterFirst, countBefore, "当前状态已被某快照覆盖时不新增备份");
  // 再恢复回 verA：同样不需要
  s2 = coreReducer(s2, { type: "restoreSnapshot", id: a2.id, snapshotId: verA });
  const countAfterSecond = s2.archives.find((a) => a.id === a2.id)!.snapshots.length;
  assert.equal(countAfterSecond, countBefore, "来回切换不膨胀");
  assert.equal(s2.archives.find((a) => a.id === a2.id)!.name, "新状态A");
});

check("恢复后可继续编辑 / 撤销 / 重做 / 再次创建快照", () => {
  let s = state;
  s = coreReducer(s, { type: "createSnapshot", id: a2.id, label: "v1" });
  const v1 = s.archives.find((a) => a.id === a2.id)!.snapshots[0].id;
  s = coreReducer(s, { type: "updateMeta", id: a2.id, patch: { name: "临时改动" } });
  s = coreReducer(s, { type: "restoreSnapshot", id: a2.id, snapshotId: v1 });

  // 继续编辑
  s = coreReducer(s, { type: "updateMeta", id: a2.id, patch: { name: "恢复后新编辑" } });
  assert.equal(s.archives.find((a) => a.id === a2.id)!.name, "恢复后新编辑");

  // 再创建快照：新快照拍平，且恢复前自动备份仍在
  s = coreReducer(s, { type: "createSnapshot", id: a2.id, label: "恢复后 v2" });
  const arc = s.archives.find((a) => a.id === a2.id)!;
  assert.ok(arc.snapshots.some((x) => x.label === "恢复后 v2"));
  assert.ok(arc.snapshots.some((x) => x.auto));
  assert.equal(countNestedSnapshotNodes(arc), 0);

  // 在含「恢复」操作的历史栈上验证撤销/重做：
  let h: ReturnType<typeof historyReducer> = { past: [], present: state, future: [], lastSaved: 0 };
  h = historyReducer(h, { type: "createSnapshot", id: a2.id, label: "v1-h" } as Action);
  h = historyReducer(h, { type: "updateMeta", id: a2.id, patch: { name: "临时" } } as Action);
  const snapIdH = h.present.archives.find((a) => a.id === a2.id)!.snapshots.find((x) => x.label === "v1-h")!.id;
  h = historyReducer(h, { type: "restoreSnapshot", id: a2.id, snapshotId: snapIdH } as Action);
  h = historyReducer(h, { type: "updateMeta", id: a2.id, patch: { name: "再编辑" } } as Action);
  h = undoHistory(h); // 撤销「再编辑」
  assert.equal(h.present.archives.find((a) => a.id === a2.id)!.name, a2.name, "撤销跨过恢复操作后内容正确");
  h = redoHistory(h);
  assert.equal(h.present.archives.find((a) => a.id === a2.id)!.name, "再编辑", "重做可用");
});

check("旧版嵌套快照数据经 sanitize（刷新/导入）后被拍平，且快照不丢失", () => {
  // 手工构造旧 bug 时代的嵌套结构
  const arc = makeArchive({ code: "CAR-OLD", patternImage: "data:image/svg+xml,x" });
  const inner = snapshotArchive(makeArchive({ code: "CAR-OLD", name: "更早版本" }), "内层快照");
  const oldSnap = snapshotArchive(arc, "外层快照");
  (oldSnap.data as Archive).snapshots = [inner]; // 模拟旧数据的嵌套
  arc.snapshots = [oldSnap];
  const migrated = sanitize({ archives: [arc], activeId: arc.id });
  const m = migrated.archives[0];
  assert.equal(m.snapshots.length, 1, "顶层快照保留");
  assert.equal(m.snapshots[0].label, "外层快照");
  assert.deepEqual(m.snapshots[0].data.snapshots, [], "嵌套被清空");
  assert.equal(countNestedSnapshotNodes(m), 0);
  // flattenNestedSnapshots 直接调用也应幂等
  const twice = flattenNestedSnapshots(flattenNestedSnapshots(m.snapshots));
  assert.deepEqual(twice, m.snapshots);
});

check("sameArchiveContent 只比较业务内容（时间戳/快照/归档态不影响）", () => {
  const a = makeArchive({ code: "X", name: "同内容" });
  const b = { ...a, updatedAt: a.updatedAt + 9999, archived: true, snapshots: [snapshotArchive(a, "s")] };
  assert.ok(sameArchiveContent(a, b));
  const c = { ...a, name: "不同" };
  assert.ok(!sameArchiveContent(a, c));
});

console.log("\n[8] 撤销 / 重做：历史栈行为");
check("dispatch 入栈，undo 回退、redo 重放，select 不入栈", () => {
  let h = historyReducer(
    { past: [], present: state, future: [], lastSaved: 0 },
    { type: "addArchive" } as Action,
  );
  assert.equal(h.present.archives.length, 4);
  h = historyReducer(h, { type: "select", id: a1.id } as Action);
  assert.equal(h.past.length, 1, "select 不入历史");
  h = undoHistory(h);
  assert.equal(h.present.archives.length, 3);
  h = redoHistory(h);
  assert.equal(h.present.archives.length, 4);
});

console.log("\n[9] 删除区域级联删除关联需求（材料需求不悬空）");
check("删除破损区域后关联补线需求一并删除", () => {
  const before = a2.materials.length;
  const s = coreReducer(state, { type: "deleteRegion", id: a2.id, regionId: a2.regions[0].id });
  const arc = s.archives.find((a) => a.id === a2.id)!;
  assert.equal(arc.regions.length, 1);
  assert.ok(arc.materials.length < before);
  assert.ok(!arc.materials.some((m) => m.regionId === a2.regions[0].id));
});

console.log(`\n全部通过：${passed} 项验收`);
