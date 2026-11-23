import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { acquireModelSlot, heldSlots, withModelSlot } from "../src/model/slots.ts";
import { reviewBatchSize } from "../src/research/claimReview.ts";
import { parseParallelConfig, stageWidth } from "../src/util/parallel.ts";
import { pool } from "../src/util/pool.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("A14 pool: width honoured; on failure no new item starts and in-flight calls settle before the throw", async () => {
  let inFlight = 0;
  let peak = 0;
  await pool([...Array(10).keys()], 4, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await sleep(5);
    inFlight--;
  });
  assert.equal(peak, 4);

  const started: number[] = [];
  const finished: number[] = [];
  await assert.rejects(
    pool([0, 1, 2, 3, 4, 5], 3, async (x) => {
      started.push(x);
      if (x === 0) throw new Error("boom");
      await sleep(20);
      finished.push(x);
    }),
    /boom/,
  );
  assert.deepEqual(started.sort(), [0, 1, 2], "nothing new starts after the failure");
  assert.deepEqual(finished.sort(), [1, 2], "the calls in flight finished before the error surfaced");
});

test("A14 model slots: global cap shared through slot dirs; stale slot of a dead pid is taken over", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh-slots-"));
  try {
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      [...Array(7).keys()].map(() =>
        withModelSlot(
          async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            assert.ok(heldSlots(root).length <= 3);
            await sleep(15);
            inFlight--;
          },
          { cap: 3, root },
        ),
      ),
    );
    assert.equal(peak, 3);
    assert.equal(heldSlots(root).length, 0, "all slots released");

    // a slot held by a process that no longer exists (another sfsh process killed) does not block forever
    fs.mkdirSync(path.join(root, "slot-0"));
    fs.writeFileSync(path.join(root, "slot-0", "owner"), "999999:dead", "utf8");
    const release = await acquireModelSlot({ cap: 1, root });
    assert.equal(heldSlots(root)[0]!.owner!.split(":")[0], String(process.pid));
    release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("A14 parallel config: defaults, per-stage override, invalid values rejected", () => {
  const c = parseParallelConfig({ global_model_calls: 8, stage_width_default: 6, stages: { nkg_review: 4 } });
  assert.equal(stageWidth("nkg_review", c), 4);
  assert.equal(stageWidth("claims", c), 6);
  assert.equal(parseParallelConfig({}).global_model_calls, 6);
  assert.throws(() => parseParallelConfig({ global_model_calls: 0 }), /global_model_calls/);
  assert.throws(() => parseParallelConfig({ stages: { bogus: 2 } }), /unknown stage key/);
  assert.throws(() => parseParallelConfig({ stages: { claims: 2.5 } }), /stages.claims/);
});

test("A14 claim review batch size fills the width (40..120 per batch)", () => {
  assert.equal(reviewBatchSize(318, 6), 53);
  assert.equal(reviewBatchSize(30, 6), 40);
  assert.equal(reviewBatchSize(1000, 6), 120);
  assert.equal(reviewBatchSize(318, 3), 106);
});
