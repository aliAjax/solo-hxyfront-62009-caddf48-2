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
  makeArchive,
  nextCode,
  rectAreaPct,
  reservedByMaterial,
  requirementStatus,
  seedMaterials,
  seedState,
  emptySteps,
  uid,
} from "../src/model.ts";
import { coreReducer, historyReducer, undoHistory, redoHistory, stepAdvanceBlocked, type Action } from "../src/store.ts";

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

console.log("\n[7] 版本快照：创建 / 恢复保留历史");
check("恢复旧版本：内容回滚、id 与编号不变、自动备份入快照列表、取消归档", () => {
  let s = state;
  s = coreReducer(s, { type: "createSnapshot", id: a2.id, label: "v1 初版" });
  let arc = s.archives.find((a) => a.id === a2.id)!;
  const snapId = arc.snapshots[0].id;
  // 修改档案
  s = coreReducer(s, { type: "updateMeta", id: a2.id, patch: { name: "改名后的毯子" } });
  s = coreReducer(s, { type: "archive", id: a2.id, materials: mats });
  assert.equal(s.archives.find((a) => a.id === a2.id)!.name, "改名后的毯子");
  // 恢复
  s = coreReducer(s, { type: "restoreSnapshot", id: a2.id, snapshotId: snapId });
  arc = s.archives.find((a) => a.id === a2.id)!;
  assert.equal(arc.name, a2.name, "名称回到快照时状态");
  assert.equal(arc.archived, false, "恢复后为未归档");
  assert.equal(arc.id, a2.id);
  assert.equal(arc.code, a2.code);
  assert.ok(arc.snapshots.some((x) => x.label.includes("恢复前自动备份")), "恢复前自动备份存在");
  assert.ok(arc.snapshots.some((x) => x.id === snapId), "旧快照仍保留");
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
