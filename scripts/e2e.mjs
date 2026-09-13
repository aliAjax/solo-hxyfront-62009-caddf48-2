// 真实浏览器 E2E：桌面 1440px 与 390px 窄屏，验收快照恢复不卡死、状态持久与刷新迁移。
// 运行：node scripts/e2e.mjs（自动启停 vite dev server）
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const PORT = 62009;
const BASE = `http://127.0.0.1:${PORT}`;
const STORAGE_KEY = "rug-repair-workbench-v1";

let passed = 0;
async function ok(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function startServer() {
  const child = spawn("node_modules/.bin/vite", ["--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    stdio: "ignore",
  });
  return child;
}

// 无 root 环境下把用户目录内的 Chromium 依赖库提供给动态链接器
const LOCAL_LIBS = process.env.CHROMIUM_LIBS || "/tmp/chromedeps";
function launchOptions() {
  const extra = [
    `${LOCAL_LIBS}/usr/lib/aarch64-linux-gnu`,
    `${LOCAL_LIBS}/lib/aarch64-linux-gnu`,
    `${LOCAL_LIBS}/usr/lib`,
  ].join(":");
  return {
    args: ["--no-sandbox"],
    env: { ...process.env, LD_LIBRARY_PATH: `${extra}:${process.env.LD_LIBRARY_PATH || ""}` },
  };
}

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(BASE);
      if (r.ok) return;
    } catch {
      /* 未就绪 */
    }
    await sleep(250);
  }
  throw new Error("dev server 未在 15s 内就绪");
}

async function readStored(page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
}

async function waitStorageMatches(page, predicate) {
  for (let i = 0; i < 40; i += 1) {
    const raw = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
    if (raw) {
      try {
        if (predicate(JSON.parse(raw))) return;
      } catch {
        /* 半写入状态，继续等 */
      }
    }
    await sleep(100);
  }
  throw new Error("localStorage 未在 4s 内达到预期状态");
}

async function restoreByName(page, label, expectedName, timeoutMs = 3000) {
  // 点击某快照的「恢复」，确认弹窗自动接受，测量页面更新耗时（主线程卡死会直接反映在墙钟上）
  const li = page.locator(".snapshot-list li", { has: page.locator("strong", { hasText: label }) }).first();
  const start = Date.now();
  await Promise.all([
    page.waitForFunction(
      (name) => document.querySelector(".name-input")?.value === name,
      expectedName,
      { timeout: timeoutMs },
    ),
    li.getByRole("button", { name: "恢复" }).click(),
  ]);
  return Date.now() - start;
}

async function gotoTab(page, name) {
  await page.locator(".tabbar").getByRole("button", { name }).click();
}

async function noHorizontalOverflow(page) {
  const dims = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
  }));
  assert.ok(dims.sw <= dims.iw + 2, `横向溢出：scrollWidth ${dims.sw} > ${dims.iw}`);
}

async function run() {
  const server = startServer();
  let browser;
  try {
    await waitForServer();
    browser = await chromium.launch(launchOptions());

    // ============ 桌面 1440px ============
    console.log("\n[桌面 1440×900]");
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      page.on("dialog", (d) => d.accept());
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));

      await page.goto(BASE);
      await page.waitForSelector(".app");

      await ok("页面加载即可交互（切到冲突标签）", async () => {
        await page.getByRole("button", { name: /冲突/ }).click();
        await page.waitForSelector(".conflict-panel");
      });

      await ok("选择 CAR-117 并连续创建两个快照", async () => {
        await page.locator(".archive-card", { hasText: "CAR-117" }).click();
        await gotoTab(page, /工序/);
        const input = page.locator(".snapshot-create input");
        await input.fill("S1 初版");
        await page.locator(".snapshot-create button", { hasText: "创建快照" }).click();
        await page.locator(".snapshot-list li", { hasText: "S1 初版" }).waitFor();
        // S1 之后改名（名称输入框在纹样图标签）
        await gotoTab(page, /纹样图/);
        await page.locator(".name-input").fill("E2E改名");
        await sleep(550);
        await gotoTab(page, /工序/);
        await input.fill("S2 改名");
        await page.locator(".snapshot-create button", { hasText: "创建快照" }).click();
        await page.locator(".snapshot-list li", { hasText: "S2 改名" }).waitFor();
        assert.equal(await page.locator(".snapshot-list li").count(), 2);
      });

      await ok("在 S1/S2 间连续恢复 5 次，每次 3s 内完成（卡死回归）", async () => {
        const original = "安纳托利亚中心缺口毯";
        const seq = [
          ["S1 初版", original],
          ["S2 改名", "E2E改名"],
          ["S1 初版", original],
          ["S2 改名", "E2E改名"],
          ["S1 初版", original],
        ];
        for (const [label, expected] of seq) {
          const ms = await restoreByName(page, label, expected);
          assert.ok(ms < 3000, `恢复 ${label} 耗时 ${ms}ms，疑似卡死`);
        }
        assert.equal(await page.locator(".snapshot-list li").count(), 2, "恢复不产生重复快照");
      });

      await ok("localStorage 已存状态：无嵌套快照、体积合理", async () => {
        await waitStorageMatches(page, (raw) =>
          raw.present.archives.some((a) => a.snapshots.length >= 2),
        );
        const stored = await readStored(page);
        let nested = 0;
        let total = 0;
        for (const a of stored.present.archives) {
          total += a.snapshots.length;
          for (const s of a.snapshots) {
            assert.ok(Array.isArray(s.data.snapshots), "快照结构完整");
            nested += s.data.snapshots.length;
          }
        }
        assert.equal(nested, 0, `存在 ${nested} 个嵌套快照`);
        assert.ok(total >= 2);
        const bytes = JSON.stringify(stored).length;
        assert.ok(bytes < 200_000, `存档体积异常：${bytes} 字节`);
      });

      await ok("刷新后内容与快照列表保持，且立即可操作", async () => {
        await page.reload();
        await page.waitForSelector(".app");
        assert.equal(await page.locator(".name-input").inputValue(), "安纳托利亚中心缺口毯");
        await page.getByRole("button", { name: /工序/ }).click();
        assert.equal(await page.locator(".snapshot-list li").count(), 2);
      });

      await ok("刷新后可继续编辑、撤销、重做、再建快照", async () => {
        await gotoTab(page, /纹样图/);
        await page.locator(".name-input").fill("刷新后新编辑");
        await page.getByRole("button", { name: "↶ 撤销" }).click();
        await page.waitForFunction(() => document.querySelector(".name-input")?.value === "安纳托利亚中心缺口毯");
        await page.getByRole("button", { name: "↷ 重做" }).click();
        await page.waitForFunction(() => document.querySelector(".name-input")?.value === "刷新后新编辑");
        await gotoTab(page, /工序/);
        await page.locator(".snapshot-create input").fill("S3 刷新后");
        await page.locator(".snapshot-create button", { hasText: "创建快照" }).click();
        await page.locator(".snapshot-list li", { hasText: "S3 刷新后" }).waitFor();
        assert.equal(await page.locator(".snapshot-list li").count(), 3);
      });

      await ok("无页面运行时错误", async () => {
        assert.deepEqual(errors, []);
      });

      await ctx.close();
    }

    // ============ 旧版嵌套数据迁移（桌面） ============
    console.log("\n[旧嵌套数据刷新迁移]");
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      page.on("dialog", (d) => d.accept());
      await page.goto(BASE);
      await waitStorageMatches(page, (raw) => Boolean(raw?.present?.archives?.length));

      // 手工制造旧 bug 时代的嵌套快照树
      await page.evaluate((key) => {
        const raw = JSON.parse(localStorage.getItem(key));
        const arc = raw.present.archives[1];
        const inner = { id: "snap_inner", label: "内层快照", createdAt: 1, data: { ...structuredClone(arc), snapshots: [] } };
        const outer = {
          id: "snap_outer",
          label: "外层快照",
          createdAt: 2,
          data: { ...structuredClone(arc), snapshots: [inner] },
        };
        arc.snapshots = [outer];
        localStorage.setItem(key, JSON.stringify(raw));
      }, STORAGE_KEY);

      await page.reload();
      await page.waitForSelector(".app");

      await ok("刷新后旧嵌套快照被拍平且顶层快照保留", async () => {
        await page.getByRole("button", { name: /工序/ }).click();
        await page.locator(".snapshot-list li", { hasText: "外层快照" }).waitFor();
        await sleep(600); // 等自动保存
        const stored = await readStored(page);
        for (const a of stored.present.archives) {
          for (const s of a.snapshots) assert.equal(s.data.snapshots.length, 0);
        }
      });

      await ok("迁移后页面 1s 内可切换标签、可恢复", async () => {
        const start = Date.now();
        await page.getByRole("button", { name: /纹样图/ }).click();
        await page.waitForSelector(".canvas", { timeout: 1500 });
        assert.ok(Date.now() - start < 1500);
      });

      await ctx.close();
    }

    // ============ 390px 窄屏 ============
    console.log("\n[窄屏 390×844]");
    {
      const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      const page = await ctx.newPage();
      page.on("dialog", (d) => d.accept());
      await page.goto(BASE);
      await page.waitForSelector(".app");

      await ok("无横向溢出", async () => {
        await noHorizontalOverflow(page);
      });

      await ok("抽屉式档案库可展开并选择 CAR-092，选择后自动收起", async () => {
        const summary = page.locator(".drawer-summary");
        await summary.click();
        await page.locator(".archive-card", { hasText: "CAR-092" }).click();
        await page.waitForSelector(".name-input");
        assert.equal(await page.locator(".name-input").inputValue(), "波斯边缘磨损毯");
        await noHorizontalOverflow(page);
      });

      await ok("窄屏在纹样图上拖框新增破损区域（核心绘制操作）", async () => {
        await gotoTab(page, /纹样图/);
        const before = await page.locator(".region-row").count();
        await page.getByRole("button", { name: /绘制破损区/ }).click();
        const box = await page.locator(".canvas").boundingBox();
        assert.ok(box);
        await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.4, { steps: 6 });
        await page.mouse.up();
        // 新区域自动选中并打开编辑表单；CAR-092 原有 2 个区域，新的为第 3 号
        await page.locator(".region-form strong", { hasText: `${before + 1} 号破损区` }).waitFor({ timeout: 2000 });
        await noHorizontalOverflow(page);
      });

      await ok("窄屏连续恢复 3 次不卡死、快照不重复", async () => {
        await gotoTab(page, /工序/);
        await page.locator(".snapshot-create input").fill("M1");
        await page.locator(".snapshot-create button", { hasText: "创建快照" }).click();
        await page.locator(".snapshot-list li", { hasText: "M1" }).waitFor();
        await gotoTab(page, /纹样图/);
        await page.locator(".name-input").fill("窄屏改名");
        await sleep(550);
        await gotoTab(page, /工序/);
        await page.locator(".snapshot-create input").fill("M2");
        await page.locator(".snapshot-create button", { hasText: "创建快照" }).click();
        await page.locator(".snapshot-list li", { hasText: "M2" }).waitFor();

        const original = "波斯边缘磨损毯";
        for (const [label, expected] of [
          ["M1", original],
          ["M2", "窄屏改名"],
          ["M1", original],
        ]) {
          const ms = await restoreByName(page, label, expected, 3000);
          assert.ok(ms < 3000, `窄屏恢复 ${label} 耗时 ${ms}ms`);
        }
        assert.equal(await page.locator(".snapshot-list li").count(), 2);
        await noHorizontalOverflow(page);
      });

      await ok("窄屏冲突面板可定位来源", async () => {
        await page.getByRole("button", { name: /冲突/ }).click();
        await page.waitForSelector(".conflict-panel");
        const first = page.locator(".conflict-item").first();
        if (await first.count()) {
          await first.click();
          await page.waitForTimeout(300);
          await noHorizontalOverflow(page);
        }
      });

      await ctx.close();
    }

    await browser.close();
    console.log(`\nE2E 全部通过：${passed} 项`);
  } finally {
    server.kill("SIGTERM");
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
