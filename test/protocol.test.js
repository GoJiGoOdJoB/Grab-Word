// ============================================================
// test/protocol.test.js —— P0 结算基建确定性协议测试（Node 内置，无新增依赖）
// 运行: npm test  /  node test/protocol.test.js
// 测试专用 applier/handler 只在此文件注册，不进入生产 bundle。
// ============================================================
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');

// ---- 沙箱：window / 最小 DOM 桩，测试专用，不影响生产 ----
global.window = global;
global.document = {
  getElementById: function () { return null; },
  querySelector: function () { return null; },
  querySelectorAll: function () { return []; },
  createElement: function () { return { style: {}, remove: function () {}, classList: { add: function () {}, remove: function () {}, toggle: function () {} } }; },
  body: { appendChild: function () {} },
  head: { appendChild: function () {} },
  addEventListener: function () {},
};
global.playSound = function () {};

// 数据桩：Node 无导表产物，提供最小 curse_config 使 categoryOf 归类正确
global.DUNGEON_DATA = { tables: { attr_config: {}, item_config: {}, curse_config: {}, brv_mitigation: {}, shop_coeff: {} } };
['cyclone', 'daze', 'fatigue', 'illusion', 'imbalance', 'regret', 'shackle', 'wave'].forEach(function (id) {
  global.DUNGEON_DATA.tables.curse_config[id] = { name: id, desc: '' };
});

require('../../buffs/_base.js');
require('../dungeon.js');
const DungeonBuff = global.DungeonBuff;
const Dungeon = global.Dungeon;
assert.ok(DungeonBuff, 'DungeonBuff 未加载');
assert.ok(Dungeon, 'Dungeon 未加载');

// ---- 测试专用 handler（运行态只在实例/D，不在共享 handler）----
DungeonBuff.register('probe', class extends DungeonBuff.BaseBuff {
  onAdd(D, inst) { inst.count = 0; }
  onRemove(D, inst) { inst.removed = (inst.removed || 0) + 1; }
  onEvent(D, inst, type, payload) {
    inst.count = (inst.count || 0) + 1;
    if (payload.removeNext && inst.nextInstanceId) DungeonBuff.removeBuff(D, inst.nextInstanceId);
  }
});
DungeonBuff.register('dedupeTap', class extends DungeonBuff.BaseBuff {
  onEvent(D, inst) { inst.hits = (inst.hits || 0) + 1; }
});
// 诅咒桩：Node 无 DUNGEON_DATA，注册空 handler 避免 findDef 抛错（不影响断言）
['cyclone','daze','fatigue','illusion','imbalance','regret','shackle','wave'].forEach(function (id) {
  DungeonBuff.register(id, class extends DungeonBuff.CurseBuff {});
});

// 本地协议沙箱（纯协议层测试用）
function freshD(opts) {
  opts = opts || {};
  const D = {
    active: true,
    gold: opts.gold != null ? opts.gold : 100,
    stress: opts.stress != null ? opts.stress : 0,
    stressThreshold: 40,
    stressTriggerCount: 0,
    buffs: [],
    _suppRankTotal: 0,
  };
  DungeonBuff.beginRun(D);
  return D;
}

// 模块级 D（Dungeon.addStress/reduceStress/redeemCombo 等闭包使用模块 D）
function useModuleD(opts) {
  opts = opts || {};
  const D = Dungeon.state;
  D.active = true;
  D.gold = opts.gold != null ? opts.gold : 100;
  D.stress = opts.stress != null ? opts.stress : 0;
  D.stressThreshold = 40;
  D.stressTriggerCount = 0;
  D.buffs = [];
  D._suppRankTotal = 0;
  DungeonBuff.beginRun(D);
  return D;
}

// ----与去重 ----
test('2.1 同一结果事件重复派发只生效一次（同 eventSerial 去重）', function () {
  const D = freshD();
  const a = DungeonBuff.addBuff(D, 'dedupeTap', {});
  DungeonBuff.dispatchEvent(D, 'CARD_CORRECT', { eventSerial: 7, wordSerial: 1, cardSerial: 1 });
  DungeonBuff.dispatchEvent(D, 'CARD_CORRECT', { eventSerial: 7, wordSerial: 1, cardSerial: 1 });
  assert.strictEqual(a.hits, 1, '重复派发被去重');
});
test('2.1 同词不同动作互不吞事件（不同 eventSerial 均派发）', function () {
  const D = freshD();
  const a = DungeonBuff.addBuff(D, 'dedupeTap', {});
  DungeonBuff.dispatchEvent(D, 'CARD_CORRECT', { eventSerial: 1, wordSerial: 1, cardSerial: 1 });
  DungeonBuff.dispatchEvent(D, 'CARD_CORRECT', { eventSerial: 2, wordSerial: 1, cardSerial: 2 });
  assert.strictEqual(a.hits, 2);
});
test('2.1 同动作 BEFORE/AFTER 与不同结果事件标识不同', function () {
  const D = freshD();
  const a = DungeonBuff.addBuff(D, 'dedupeTap', {});
  DungeonBuff.dispatchEvent(D, 'BEFORE_WRONG', { eventSerial: 5, wordSerial: 3 });
  DungeonBuff.dispatchEvent(D, 'AFTER_WRONG', { eventSerial: 5, wordSerial: 3 });
  DungeonBuff.dispatchEvent(D, 'WORD_COMPLETE', { eventSerial: 5, wordSerial: 3 });
  assert.strictEqual(a.hits, 3, '三个事件类型全部派发');
});

// ---- 3.1/3.2/3.3 生命周期与派发有效性 ----
test('3.1 clearRun 对每个仍存实例恰好一次 onRemove，且清空本局去重/待提交状态', function () {
  const D = freshD();
  const a = DungeonBuff.addBuff(D, 'probe', {});
  const b = DungeonBuff.addBuff(D, 'probe', {});
  const c = DungeonBuff.addBuff(D, 'probe', {});
  DungeonBuff.removeBuff(D, b.instanceId);
  assert.strictEqual(b.removed, 1);
  DungeonBuff.collectIntent(D, { type: 'gold', value: 1, intentKey: 'k1' });
  DungeonBuff.dispatchEvent(D, 'TICK', { eventSerial: 1 });
  DungeonBuff.clearRun(D);
  assert.strictEqual(a.removed, 1, 'a 恰好一次 onRemove');
  assert.strictEqual(b.removed, 1, '已移除者不重复清理');
  assert.strictEqual(c.removed, 1);
  assert.strictEqual(D.pendingIntents.length, 0, '待提交意图清空');
  const p2 = DungeonBuff.dispatchEvent(D, 'TICK', { eventSerial: 1 });
  assert.ok(!p2._deduped, '本局去重状态已清空（新局同 serial 不吞）');
});
test('3.2 派发快照中前一个实例移除后续实例：被移除者不再执行本次 onEvent', function () {
  const D = freshD();
  const a = DungeonBuff.addBuff(D, 'probe', {});
  const b = DungeonBuff.addBuff(D, 'probe', {});
  const c = DungeonBuff.addBuff(D, 'probe', {});
  a.nextInstanceId = b.instanceId;
  DungeonBuff.dispatchEvent(D, 'CARD_CORRECT', { eventSerial: 9, removeNext: true });
  assert.strictEqual(b.count, 0, '被移除实例不执行');
  assert.strictEqual(b.removed, 1);
  assert.strictEqual(c.count, 1, '其余实例正常执行');
});
test('3.3 同 ID 多实例运行态隔离；记录事件不扣耐久', function () {
  const D = freshD();
  const a = DungeonBuff.addBuff(D, 'dedupeTap', { remaining: 3 });
  const b = DungeonBuff.addBuff(D, 'dedupeTap', { remaining: 3 });
  DungeonBuff.dispatchEvent(D, 'WORD_START', { eventSerial: 1 });
  assert.strictEqual(a.hits, 1);
  assert.strictEqual(b.hits, 1, '共享 handler 不共享计数');
  assert.strictEqual(a.remaining, 3, '记录型事件不消耗耐久');
  assert.strictEqual(b.remaining, 3);
});

// ---- 4.1/4.5 资源来源记录与去重、耐久确认 ----
test('4.1 资源回执记录请求值/实际值/前后余额，重复 transactionId 不重复执行', function () {
  const D = freshD({ gold: 100 });
  DungeonBuff.registerResourceApplier('gold', function (delta) {
    const before = D.gold;
    let actual = delta;
    if (before + actual < 0) actual = -before;
    D.gold = before + actual;
    return { applied: actual !== 0, actualDelta: actual, before: before, after: D.gold };
  });
  const r1 = DungeonBuff.settleResource(D, { resource: 'gold', requestedDelta: -150, transactionId: 'tx1', sourceCategory: 'ITEM', sourceReason: 'test' });
  assert.strictEqual(r1.record.requestedDelta, -150, '请求值保留');
  assert.strictEqual(r1.record.actualDelta, -100, '扣至下限0');
  assert.strictEqual(r1.record.before, 100);
  assert.strictEqual(r1.record.after, 0);
  assert.strictEqual(D.gold, 0);
  const r2 = DungeonBuff.settleResource(D, { resource: 'gold', requestedDelta: -150, transactionId: 'tx1' });
  assert.ok(r2.deduped, '重复提交去重');
  assert.strictEqual(D.gold, 0, '不重复扣');
});
test('4.5 实际生效才扣耐久：无收益不扣、有效提交扣一次、重复不重复扣', function () {
  const D = freshD();
  const inst = DungeonBuff.addBuff(D, 'probe', { remaining: 2 });
  DungeonBuff.registerIntentApplier('testStressDown', function (DRef, intent) {
    const actual = Math.min(intent.value, DRef.stress);
    DRef.stress -= actual;
    return { applied: actual > 0, actualDelta: actual };
  });
  DungeonBuff.collectIntent(D, { type: 'testStressDown', value: 3, intentKey: 'd1', sourceInstanceId: inst.instanceId });
  let out = DungeonBuff.commitIntents(D, {});
  assert.strictEqual(out[0].applied, false);
  assert.strictEqual(inst.remaining, 2, '零收益不扣耐久');
  D.stress = 5;
  DungeonBuff.collectIntent(D, { type: 'testStressDown', value: 3, intentKey: 'd2', sourceInstanceId: inst.instanceId });
  out = DungeonBuff.commitIntents(D, {});
  assert.strictEqual(out[0].applied, true);
  assert.strictEqual(D.stress, 2);
  assert.strictEqual(inst.remaining, 1, '有效提交恰好扣一次');
  DungeonBuff.collectIntent(D, { type: 'testStressDown', value: 3, intentKey: 'd2', sourceInstanceId: inst.instanceId });
  out = DungeonBuff.commitIntents(D, {});
  assert.ok(out[0].deduped, '同 intentKey 重复提交去重（跨提交持久）');
  assert.strictEqual(D.stress, 2);
  assert.strictEqual(inst.remaining, 1, '重复提交不重复扣耐久');
});

// ---- 5.1/5.2 压力实际结果与独立减压 ----
test('5.1 addStress 逐笔记录：0.4 且零耐力减免 → 实际0，取整损失不算收益', function () {
  const D = useModuleD();
  const r = Dungeon.addStress(0.4);
  assert.strictEqual(r.actualAdded, 0, 'round(0.4)=0');
  assert.strictEqual(r.enduranceAbsorbed, 0, '取整损失不算耐力收益');
  assert.strictEqual(D.stress, 0);
});
test('5.1 addStress 返回逐笔记录（阈值消耗/诅咒获得）', function () {
  const D = useModuleD({ stress: 39 });
  const curseBefore = 0;
  const r = Dungeon.addStress(3);
  assert.strictEqual(r.actualAdded, 3);
  assert.strictEqual(r.before, 39);
  assert.strictEqual(r.after, 2, '39+3=42 跨阈值40 → 余2');
  assert.strictEqual(D.stressTriggerCount, 1);
  assert.strictEqual(r.thresholdEvents.length, 1);
  assert.strictEqual(r.thresholdEvents[0].consumed, 40);
  assert.ok(r.thresholdEvents[0].curseLevelGained >= 1, '阈值触发获得诅咒');
});
test('5.2 独立减压：请求大于余额减至0；压力为0无收益；不经属性减免', function () {
  const D = useModuleD({ stress: 2 });
  const r = Dungeon.reduceStress(3);
  assert.strictEqual(r.applied, true);
  assert.strictEqual(r.actual, 2, '最多减至0');
  assert.strictEqual(r.after, 0);
  const r2 = Dungeon.reduceStress(5);
  assert.strictEqual(r2.applied, false, '压力为0时无收益');
  assert.strictEqual(r2.actual, 0);
});

// ---- 5.3 固定结算顺序 ----
function makeOrderRecorder() {
  const order = [];
  DungeonBuff.registerIntentApplier('orderUp', function (DRef, it) { order.push('up:' + it.intentKey); return { applied: true, actualDelta: 1 }; });
  DungeonBuff.registerIntentApplier('orderDown', function (DRef, it) { order.push('down:' + it.intentKey); return { applied: true, actualDelta: 1 }; });
  DungeonBuff.registerIntentApplier('orderRedeem', function (DRef, it) { order.push('redeem:' + it.intentKey); return { applied: true, actualDelta: 1 }; });
  DungeonBuff.registerIntentApplier('orderReward', function (DRef, it) { order.push('reward:' + it.intentKey); return { applied: true, actualDelta: 1 }; });
  DungeonBuff.registerIntentApplier('orderExtra', function (DRef, it) { order.push('extra:' + it.intentKey); return { applied: true, actualDelta: 1 }; });
  return order;
}
test('5.3 同批顺序固定：正压力+阈值先于减压，额外连击最后；与注册顺序无关', function () {
  const D = freshD();
  const order = makeOrderRecorder();
  DungeonBuff.collectIntent(D, { type: 'orderExtra', priority: 70, intentKey: 'x', sourceId: 's3' });
  DungeonBuff.collectIntent(D, { type: 'orderDown', priority: 40, intentKey: 'd', sourceId: 's2' });
  DungeonBuff.collectIntent(D, { type: 'orderRedeem', priority: 50, intentKey: 'r', sourceId: 's4' });
  DungeonBuff.collectIntent(D, { type: 'orderReward', priority: 60, intentKey: 'w', sourceId: 's1' });
  DungeonBuff.collectIntent(D, { type: 'orderUp', priority: 30, intentKey: 'u', sourceId: 's5' });
  DungeonBuff.commitIntents(D, {});
  assert.deepStrictEqual(order, ['up:u', 'down:d', 'redeem:r', 'reward:w', 'extra:x']);
});
test('5.3 交换实例持有顺序结果一致', function () {
  const D1 = freshD();
  const o1 = makeOrderRecorder();
  const i1 = DungeonBuff.addBuff(D1, 'probe', {});
  const i2 = DungeonBuff.addBuff(D1, 'probe', {});
  DungeonBuff.collectIntent(D1, { type: 'orderUp', priority: 30, intentKey: 'a', sourceId: 'A', sourceInstanceId: i1.instanceId });
  DungeonBuff.collectIntent(D1, { type: 'orderUp', priority: 30, intentKey: 'b', sourceId: 'B', sourceInstanceId: i2.instanceId });
  DungeonBuff.commitIntents(D1, {});
  const D2 = freshD();
  const o2 = makeOrderRecorder();
  const j2 = DungeonBuff.addBuff(D2, 'probe', {});
  const j1 = DungeonBuff.addBuff(D2, 'probe', {});
  DungeonBuff.collectIntent(D2, { type: 'orderUp', priority: 30, intentKey: 'b', sourceId: 'B', sourceInstanceId: j2.instanceId });
  DungeonBuff.collectIntent(D2, { type: 'orderUp', priority: 30, intentKey: 'a', sourceId: 'A', sourceInstanceId: j1.instanceId });
  DungeonBuff.commitIntents(D2, {});
  assert.deepStrictEqual(o1, o2, '同阶段按稳定来源标识排序');
});
test('5.3 阈值先于同批减压：39+阈值40+加1+减压3 → 先触发再减', function () {
  const D = useModuleD({ stress: 39 });
  const events = [];
  DungeonBuff.registerIntentApplier('orderUp', function (DRef, it) {
    const r = Dungeon.addStress(it.value); events.push('up:' + r.thresholdEvents.length);
    return { applied: true, actualDelta: r.actualAdded };
  });
  DungeonBuff.registerIntentApplier('orderDown', function (DRef, it) {
    const r = Dungeon.reduceStress(it.value); events.push('down:' + r.actual);
    return { applied: r.applied, actualDelta: r.actual };
  });
  DungeonBuff.collectIntent(D, { type: 'orderDown', priority: 40, value: 3, intentKey: 'd' });
  DungeonBuff.collectIntent(D, { type: 'orderUp', priority: 30, value: 1, intentKey: 'u' });
  DungeonBuff.commitIntents(D, {});
  assert.deepStrictEqual(events, ['up:1', 'down:0'], '先跨阈值（39+1=40 触发后余额0），减压无余额');
  assert.strictEqual(D.stressTriggerCount, 1, '不以净压力37取消触发');
});

// ---- 6.1/6.2/6.3 连击 ----
function comboScaffold(combo) {
  global.S = { combo: combo, burstCounter: 4, totalScore: 100 };
  const D = useModuleD();
  DungeonBuff.registerIntentApplier('comboRedeem', function (DRef, intent) { return Dungeon.redeemCombo(intent); });
  DungeonBuff.registerIntentApplier('extraCombo', function (DRef, intent) {
    const n = Math.floor(intent.value || 0);
    if (n <= 0) return { applied: false };
    global.S.combo += n;
    return { applied: true, actualDelta: n };
  });
  return D;
}
test('6.1 独立消费：不派发自然断连、不清爆发、本词分数不回算', function () {
  comboScaffold(5);
  const r = Dungeon.consumeCombo(2);
  assert.strictEqual(r.applied, true);
  assert.strictEqual(global.S.combo, 3);
  assert.strictEqual(global.S.burstCounter, 4, '爆发不清零');
  assert.strictEqual(global.S.totalScore, 100, '本词分数不回算');
  const r2 = Dungeon.consumeCombo(99);
  assert.strictEqual(r2.applied, false);
  assert.strictEqual(global.S.combo, 3, '余额不足不扣');
});
test('6.2 原子兑现：前置不满足整笔拒绝不扣连击；满足则成本收益一次结算', function () {
  const D = comboScaffold(2);
  D.stress = 0;
  let r = Dungeon.redeemCombo({ comboCost: 2, reward: { type: 'reduceStress', value: 3 } });
  assert.strictEqual(r.applied, false);
  assert.strictEqual(global.S.combo, 2, '未生效不扣连击');
  D.stress = 5;
  r = Dungeon.redeemCombo({ comboCost: 2, reward: { type: 'reduceStress', value: 3 } });
  assert.strictEqual(r.applied, true);
  assert.strictEqual(global.S.combo, 0, '成本一次扣除');
  assert.strictEqual(D.stress, 2, '实际减压3');
  assert.strictEqual(r.reward.actual, 3);
  global.S.combo = 5;
  r = Dungeon.redeemCombo({ comboCost: 1, reward: { type: 'gold', value: 0 } });
  assert.strictEqual(r.applied, false, '金币收益无效拒绝');
  assert.strictEqual(global.S.combo, 5);
});
test('6.3 基础快照含历史额外连击不含本词待加入值；本词额外连击不能即时供给兑现', function () {
  const D = comboScaffold(3);
  D.stress = 5;
  DungeonBuff.collectIntent(D, { type: 'extraCombo', priority: 70, value: 2, intentKey: 'ex', sourceId: 'itA' });
  DungeonBuff.collectIntent(D, { type: 'comboRedeem', priority: 50, comboCost: 5, reward: { type: 'reduceStress', value: 1 }, intentKey: 'rd', sourceId: 'itB' });
  const baseSnapshot = { baseScore: 10, baseGold: D.gold, comboBeforeItemSettlement: global.S.combo };
  assert.strictEqual(baseSnapshot.comboBeforeItemSettlement, 3, '快照不含本词待加入值');
  const results = DungeonBuff.commitIntents(D, baseSnapshot);
  const redeem = results.find(function (x) { return x.intent.type === 'comboRedeem'; });
  const extra = results.find(function (x) { return x.intent.type === 'extraCombo'; });
  assert.strictEqual(redeem.applied, false, '本词额外连击不能供给兑现');
  assert.strictEqual(extra.applied, true, '兑现失败后额外连击仍加入');
  assert.strictEqual(global.S.combo, 5, '3 + 2');
  assert.strictEqual(global.S.burstCounter, 4, '额外连击不增加爆发累计');
});

// ---- 7.1/7.3 分维度计时 ----
test('7.1 无专用贡献时两计时器因子为1（默认无修正）', function () {
  useModuleD();
  assert.strictEqual(Dungeon.getTotalTimeFlowMultiplier(), 1);
  assert.strictEqual(Dungeon.getWordTimeFlowMultiplier(), 1);
});
test('7.1 专用因子公式 max(0.1,(1+additive)*multiplier) 且维度不串用', function () {
  const D = useModuleD();
  DungeonBuff.register('timeWord', class extends DungeonBuff.BaseBuff {
    query(DRef, inst, key) { return key === 'wordTimeFlowMultiplier' ? { additive: 0.5 } : null; }
  });
  DungeonBuff.register('timeTotal', class extends DungeonBuff.BaseBuff {
    query(DRef, inst, key) { return key === 'totalTimeFlowMultiplier' ? { multiplier: 1.2 } : null; }
  });
  DungeonBuff.addBuff(D, 'timeWord', {});
  DungeonBuff.addBuff(D, 'timeTotal', {});
  assert.strictEqual(Dungeon.getWordTimeFlowMultiplier(), 1.5);
  assert.strictEqual(Dungeon.getTotalTimeFlowMultiplier(), 1.2);
});
test('7.3 直接恢复总时间走资源记录，不写入词内流速', function () {
  const D = useModuleD();
  DungeonBuff.registerResourceApplier('time', function (delta) {
    return { applied: true, actualDelta: delta, before: 100, after: 100 + delta };
  });
  const r = DungeonBuff.settleResource(D, { resource: 'time', requestedDelta: 30, transactionId: 't1' });
  assert.strictEqual(r.applied, true);
  assert.strictEqual(r.record.actualDelta, 30);
  assert.strictEqual(Dungeon.getWordTimeFlowMultiplier(), 1, '恢复量不进流速');
  assert.strictEqual(Dungeon.getTotalTimeFlowMultiplier(), 1);
});

test('2.2 WORD_START stores independent pure snapshots and actual blank count', function () {
  const D = freshD();
  const input = { wordSerial: 1, wordId: 'a-b', spelling: 'a-b', pos: 'n.', plannedBlankCount: 5, actualBlankPositions: [0, 2], handLetters: ['a', 'b'] };
  const context = DungeonBuff.startWord(D, input);
  input.actualBlankPositions.push(1);
  input.handLetters[0] = 'z';
  context.actualBlankPositions.length = 0;
  context.handLetters[0] = 'x';
  const snapshot = DungeonBuff.wordContext(D);
  assert.deepStrictEqual(snapshot.actualBlankPositions, [0, 2]);
  assert.deepStrictEqual(snapshot.handLetters, ['a', 'b']);
  assert.strictEqual(snapshot.actualBlankCount, 2);
  assert.strictEqual(snapshot.plannedBlankCount, 5);
  assert.strictEqual(snapshot.runSerial, D.runSerial);
  assert.strictEqual(snapshot.slots, undefined);
  assert.strictEqual(snapshot.handTiles, undefined);
});

test('2.3 letter groups normalize case and reject non letters', function () {
  ['e', 'T', 'a', 'O', 'i'].forEach(letter => assert.strictEqual(DungeonBuff.letterGroup(letter), 'HIGH'));
  'KXJQZ'.split('').forEach(letter => assert.strictEqual(DungeonBuff.letterGroup(letter), 'LOW'));
  'NRLCMPWB'.split('').forEach(letter => assert.strictEqual(DungeonBuff.letterGroup(letter), 'MID_A'));
  'SHDUFGYV'.split('').forEach(letter => assert.strictEqual(DungeonBuff.letterGroup(letter), 'MID_B'));
  ['', '-', 'ab', '1', 'é'].forEach(letter => assert.strictEqual(DungeonBuff.letterGroup(letter), null));
  const fs = require('node:fs');
  const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
  assert.ok(html.includes('originalIndex:nextBlank'));
  assert.strictEqual((html.match(/Dungeon\.dispatch\('CARD_CORRECT'/g) || []).length, 1);
});

test('2.4 pos tags are deduplicated and unknown fragments are not guessed', function () {
  assert.deepStrictEqual(DungeonBuff.normalizePos('v. vt. vi.'), { posTags: ['VERB'], unknownPos: [] });
  assert.deepStrictEqual(DungeonBuff.normalizePos('n. / adj. & adv. prep. pron. num. int.').posTags,
    ['NOUN', 'ADJECTIVE', 'ADVERB', 'FUNCTION', 'NUMERAL', 'INTERJECTION']);
  assert.deepStrictEqual(DungeonBuff.normalizePos('n. a. other'), { posTags: ['NOUN'], unknownPos: ['a', 'other'] });
  assert.deepStrictEqual(DungeonBuff.normalizePos('a.').posTags, ['UNKNOWN']);
  assert.deepStrictEqual(DungeonBuff.normalizePos(null), { posTags: ['UNKNOWN'], unknownPos: [] });
});

test('2.5/2.6 completion observations preserve wrong outcomes and interruptions', function () {
  const D = useModuleD();
  Dungeon.startWord({ wordSerial: 8, wordId: 'test', spelling: 'test', pos: 'n.', plannedBlankCount: 2, actualBlankPositions: [1, 3], handLetters: ['e', 't'] });
  const inst = DungeonBuff.addBuff(D, 'probe', { remaining: 3 });
  inst.progress = 4;
  Dungeon.recordWordResult('wrong', { eventSerial: 9, appliedStress: 0, totalTimePenalty: 0.5 });
  Dungeon.interruptWord('timeout', 5);
  Dungeon.interruptWord('pass', 0);
  const results = Dungeon.wordResults();
  assert.strictEqual(results.wrongResults[0].appliedStress, 0);
  assert.deepStrictEqual(results.interruptions.map(entry => entry.reason), ['timeout', 'pass']);
  assert.strictEqual(inst.progress, 4);
  assert.strictEqual(inst.remaining, 3);
  results.wrongResults[0].appliedStress = 99;
  assert.strictEqual(Dungeon.wordResults().wrongResults[0].appliedStress, 0);
  const fs = require('node:fs');
  const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
  assert.ok(html.includes('quality:quality,isShiny:S.isShiny,wrongCount:S.wrongCount'));
  assert.ok(html.includes('comboBeforeItemSettlement:S.combo,baseResources:'));
  assert.strictEqual((html.match(/Dungeon\.applyRegret\(\)/g) || []).length, 1);
  DungeonBuff.clearRun(D);
  assert.strictEqual(D.wordContext, null);
  assert.strictEqual(D.wordResults, null);
});

test('5.4 endurance rounding, multiple thresholds and independent fractional inputs', function () {
  const D = useModuleD();
  global.DUNGEON_DATA.tables.attr_config.end = { lv1: 0.49, lv2: 0.56 };
  const end = DungeonBuff.addBuff(D, 'end', { level: 1 });
  assert.strictEqual(Dungeon.addStress(1).actualAdded, 1);
  end.level = 2;
  const absorbed = Dungeon.addStress(1);
  assert.strictEqual(absorbed.actualAdded, 0);
  assert.strictEqual(absorbed.enduranceAbsorbed, 1);
  DungeonBuff.removeBuff(D, end.instanceId);
  D.stress = 39;
  const multi = Dungeon.addStress(82);
  assert.strictEqual(multi.thresholdEvents.length, 3);
  assert.strictEqual(multi.after, 1);
  D.stress = 0;
  Dungeon.addStress(0.4);
  Dungeon.addStress(0.4);
  assert.strictEqual(D.stress, 0);
  assert.strictEqual(Dungeon.addStress(0.8).actualAdded, 1);
  delete global.DUNGEON_DATA.tables.attr_config.end;
});

test('7.3 legacy timing factors and next word window remain independent', function () {
  const D = useModuleD();
  global.DUNGEON_DATA.tables.attr_config.wis = { lv1: 0.2 };
  DungeonBuff.addBuff(D, 'wis', { level: 1 });
  DungeonBuff.register('sharedFlowProbe', class extends DungeonBuff.BaseBuff {
    query(DRef, inst, key) {
      if (key === 'flowMultiplier') return { multiplier: 0.75 };
      if (key === 'nextWordTimeBonus') return { additive: 1000 };
      return null;
    }
  });
  DungeonBuff.addBuff(D, 'sharedFlowProbe', {});
  assert.ok(Math.abs(Dungeon.getFlowRateMultiplier() - 0.6) < 1e-10);
  assert.strictEqual(Dungeon.getWordTimeFlowMultiplier(), 1);
  assert.strictEqual(Dungeon.getTotalTimeFlowMultiplier(), 1);
  assert.strictEqual(Dungeon.query('nextWordTimeBonus').additive, 1000);
  assert.ok(Math.abs(Dungeon.getFlowRateMultiplier() - 0.6) < 1e-10);
  delete global.DUNGEON_DATA.tables.attr_config.wis;
});

test('production resource appliers keep item gold separate from base reward and rank-only score', function () {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const sandbox = { document: global.document, console, setTimeout, clearTimeout, Math };
  sandbox.window = sandbox;
  sandbox.DUNGEON_DATA = { tables: { attr_config: {}, item_config: {}, curse_config: {} } };
  sandbox.S = { combo: 4, totalScore: 10, stageScore: 2, timeLeft: 998, wordSerial: 1 };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../buffs/_base.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../dungeon.js'), 'utf8'), sandbox);
  const buff = sandbox.DungeonBuff, dungeon = sandbox.Dungeon, D = dungeon.state;
  D.active = true;
  buff.beginRun(D);
  dungeon.startWord({ wordSerial: 1, wordId: 'a', spelling: 'a', pos: 'n.', plannedBlankCount: 1, actualBlankPositions: [0], handLetters: ['a'] });
  dungeon.addGold(4, { sourceCategory: 'BASE', sourceReason: 'burst' });
  buff.collectIntent(D, { type: 'gold', value: 2, intentKey: 'itemGold', sourceId: 'probe' });
  buff.collectIntent(D, { type: 'rankScore', value: 3, intentKey: 'itemRank', sourceId: 'probe' });
  const settlement = dungeon.settleWord({ wordSerial: 1, finalScore: 5, baseResources: { score: 5, rankScore: 5, gold: 4 } });
  assert.strictEqual(settlement.baseSnapshot.baseGold, 4);
  assert.strictEqual(D.gold, 6);
  assert.strictEqual(sandbox.S.stageScore, 5);
  assert.strictEqual(sandbox.S.totalScore, 10);
  assert.strictEqual(settlement.supplementalRankTotal, 3);
  assert.strictEqual(D.resourceLog.filter(record => record.resource === 'gold' && record.sourceCategory === 'BASE').length, 1);
  assert.strictEqual(D.resourceLog.filter(record => record.resource === 'gold' && record.sourceCategory === 'ITEM').length, 1);
  const capped = dungeon.changeResource('time', 5, { maxValue: 999, sourceReason: 'perfect_burst' });
  assert.strictEqual(capped.record.actualDelta, 1);
  dungeon.changeResource('time', 5, { sourceCategory: 'ITEM' });
  assert.strictEqual(sandbox.S.timeLeft, 1004);
  const floor = dungeon.changeResource('score', -99, { sourceCategory: 'PURCHASE' });
  assert.strictEqual(floor.record.actualDelta, -10);
  assert.strictEqual(sandbox.S.stageScore, 5);
});

test('intent identity allows next-word rewards and removes exhausted instances', function () {
  const D = freshD({ stress: 5 });
  const inst = DungeonBuff.addBuff(D, 'probe', { remaining: 2 });
  DungeonBuff.registerIntentApplier('identityProbe', function () { return { applied: true }; });
  function intent() { return { type: 'identityProbe', intentKey: 'reward', sourceInstanceId: inst.instanceId }; }
  DungeonBuff.collectIntent(D, intent());
  DungeonBuff.commitIntents(D, { wordSerial: 1 });
  assert.strictEqual(inst.remaining, 1);
  DungeonBuff.collectIntent(D, intent());
  DungeonBuff.commitIntents(D, { wordSerial: 1 });
  assert.strictEqual(inst.remaining, 1);
  DungeonBuff.collectIntent(D, intent());
  DungeonBuff.commitIntents(D, { wordSerial: 2 });
  assert.strictEqual(inst.remaining, 0);
  assert.strictEqual(inst.removed, 1);
  assert.strictEqual(D.buffs.includes(inst), false);
});

test('combo redemption rejects invalid costs and unmet minimum stress', function () {
  const D = comboScaffold(5);
  D.stress = 2;
  assert.strictEqual(Dungeon.redeemCombo({ comboCost: 2, minStress: 3, reward: { type: 'reduceStress', value: 3 } }).applied, false);
  assert.strictEqual(global.S.combo, 5);
  assert.strictEqual(D.stress, 2);
  assert.strictEqual(Dungeon.redeemCombo({ comboCost: -1, reward: { type: 'gold', value: 1 } }).applied, false);
  assert.strictEqual(global.S.combo, 5);
});

test('4.4 production settlement uses immutable base input and observation cannot queue rewards', function () {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const sandbox = { document: global.document, console, setTimeout, clearTimeout, Math };
  sandbox.window = sandbox;
  sandbox.DUNGEON_DATA = { tables: { attr_config: {}, item_config: {}, curse_config: {} } };
  sandbox.S = { combo: 3, totalScore: 10, stageScore: 2, timeLeft: 100, wordSerial: 1 };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../buffs/_base.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../dungeon.js'), 'utf8'), sandbox);
  const buff = sandbox.DungeonBuff, dungeon = sandbox.Dungeon, D = dungeon.state;
  D.active = true;
  buff.beginRun(D);
  let observed, rejected;
  buff.register('baseGoldProbe', class extends buff.BaseBuff {
    onEvent(state, inst, type, payload) {
      if (type === 'WORD_COMPLETE') {
        assert.ok(Object.isFrozen(payload.baseSnapshot));
        assert.ok(Object.isFrozen(payload.baseResources));
        buff.collectIntent(state, { type: 'score', value: payload.baseSnapshot.baseGold * 2, sourceId: 'converter', intentKey: 'score' });
        buff.collectIntent(state, { type: 'gold', value: 20, sourceId: 'gold', intentKey: 'gold' });
      }
      if (type === 'AFTER_WORD_SETTLEMENT') {
        observed = payload;
        rejected = buff.collectIntent(state, { type: 'score', value: 999, intentKey: 'recursive' });
      }
    }
  });
  buff.addBuff(D, 'baseGoldProbe', {});
  dungeon.addGold(4, { sourceReason: 'burst' });
  const completion = { wordSerial: 1, eventSerial: 8, finalScore: 5, comboBeforeItemSettlement: 3, baseResources: { score: 5, rankScore: 5, gold: 4 } };
  const result = dungeon.settleWord(completion);
  completion.baseResources.gold = 999;
  assert.strictEqual(result.baseSnapshot.baseGold, 4);
  assert.strictEqual(result.baseSnapshot.baseResources.gold, 4);
  assert.strictEqual(result.baseSnapshot.comboBeforeItemSettlement, 3);
  assert.strictEqual(result.finalResources.score, 18);
  assert.strictEqual(D.gold, 24);
  assert.strictEqual(observed.intents.length, 2);
  assert.strictEqual(rejected, null);
  assert.strictEqual(D.pendingIntents.length, 0);
  assert.strictEqual(D.resourceLog.filter(record => record.resource === 'score')[0].sourceCategory, 'ITEM');
  assert.strictEqual(dungeon.settleWord({ wordSerial: 1, eventSerial: 8, finalScore: 5, baseResources: { gold: 4 } }), null);
  assert.strictEqual(D.gold, 24);
  assert.strictEqual(D.resourceLog.filter(record => record.sourceCategory === 'ITEM').every(record => !!record.eventKey), true);
  assert.strictEqual(buff.collectIntent(D, { type: 'score', value: 1, intentKey: 'nextWord' }).value, 1);
});

test('4.6 real completion preserves rank-only card rewards and failed promotion ownership', function () {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const node = { textContent: '', classList: { add() {}, remove() {} } };
  const sandbox = { document: Object.assign({}, global.document, { getElementById() { return node; } }), console, setTimeout() {}, clearInterval() {}, Math };
  sandbox.window = sandbox;
  sandbox.DUNGEON_DATA = { tables: { attr_config: {}, item_config: {}, curse_config: {} } };
  sandbox.S = { running: true, slots: [{ filled: true }], blankCount: 1, wordTimerLayer: 1, isShiny: false, wrongCount: 0, combo: 0, burstCounter: 0, burstQualities: [], totalScore: 10, stageScore: 2, timeLeft: 100, wordSerial: 1, correctCount: 0, streakCount: 0, totalCorrect: 0, perfectCount: 0, dropCounter: 0, promoReady: false, isPromoQuestion: false };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../buffs/_base.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../dungeon.js'), 'utf8'), sandbox);
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  vm.runInContext(html.slice(html.indexOf('function soloCheckComplete(){'), html.indexOf('function soloHandleIncomplete(')), sandbox);
  ['soloUpdateCombo', 'soloUpdateStageUI', 'soloAddWordBook', 'soloFlyStars'].forEach(name => sandbox[name] = function () {});
  sandbox.soloStage = function () { return { promoScore: 5 }; };
  let promoted = 0, failed = 0, displayedRank;
  sandbox.soloPromote = function () { promoted++; };
  sandbox.soloPromoFail = function () { failed++; };
  sandbox.soloUpdateStageUI = function () { displayedRank = sandbox.S.stageScore; };
  const buff = sandbox.DungeonBuff, dungeon = sandbox.Dungeon, D = dungeon.state;
  D.active = true;
  buff.beginRun(D);
  dungeon.startWord({ wordSerial: 1, wordId: 'a', spelling: 'a', pos: 'n.', plannedBlankCount: 1, actualBlankPositions: [0], handLetters: ['a'] });
  const rankInputs = [];
  buff.register('rankProbe', class extends buff.BaseBuff {
    onEvent(state, inst, type, payload) {
      if (type === 'COLLECT_RANK_PENALTIES') rankInputs.push(payload.supplementalRankTotal);
      if (type === 'CARD_CORRECT' || type === 'WORD_COMPLETE') buff.collectIntent(state, { type: 'rankScore', value: type === 'CARD_CORRECT' ? 3 : 2, sourceId: 'rankProbe', intentKey: 'rank' });
    }
  });
  buff.addBuff(D, 'rankProbe', {});
  const card = dungeon.dispatch('CARD_CORRECT', { wordSerial: 1, cardSerial: 1 });
  dungeon.settleCard(card);
  assert.strictEqual(sandbox.S.stageScore, 5);
  assert.strictEqual(sandbox.S.totalScore, 10);
  assert.strictEqual(sandbox.S.promoReady, false);
  assert.strictEqual(promoted, 0);
  sandbox.soloCheckComplete();
  assert.strictEqual(sandbox.S.stageScore, 8);
  assert.strictEqual(sandbox.S.totalScore, 11);
  assert.strictEqual(sandbox.S.promoReady, true);
  assert.strictEqual(displayedRank, 8);
  assert.strictEqual(D._suppRankTotal, 5);
  assert.strictEqual(promoted, 0);
  sandbox.S.wordSerial = 2;
  sandbox.S.wordTimerLayer = 0;
  sandbox.S.isPromoQuestion = true;
  dungeon.startWord({ wordSerial: 2, wordId: 'a', spelling: 'a', pos: 'n.', plannedBlankCount: 1, actualBlankPositions: [0], handLetters: ['a'] });
  sandbox.soloCheckComplete();
  assert.strictEqual(failed, 1);
  assert.strictEqual(promoted, 0);
  assert.strictEqual(sandbox.S.promoReady, false);
  assert.strictEqual(sandbox.S.stageScore, 10);
  assert.strictEqual(sandbox.S.totalScore, 11);
  assert.strictEqual(D._suppRankTotal, 2);
  assert.deepStrictEqual(rankInputs, [3, 5, 2]);
});

test('7.3 real timer ticks preserve wisdom slowdown shackle and isolate restoration', function () {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const ticks = [], fill = { style: {} };
  const sandbox = { document: Object.assign({}, global.document, { getElementById() { return fill; } }), console, setTimeout() {}, clearInterval() {}, setInterval(fn) { ticks.push(fn); return ticks.length; }, Math };
  sandbox.window = sandbox;
  sandbox.DUNGEON_DATA = { tables: { attr_config: { wis: { lv1: 0.2 } }, item_config: { slowdown: { category: 'PASSIVE', value: 0.25 } }, curse_config: { shackle: {} } } };
  sandbox.S = { running: true, timeLeft: 100, wordSerial: 1, wordTimerMs: 4000, wordTimerLayer: 1, blankCount: 1, wordFlowRate: 1, globalFlowRate: 1 };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../buffs/_base.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../buffs/passive/slowdown.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../dungeon.js'), 'utf8'), sandbox);
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  vm.runInContext(html.slice(html.indexOf('function soloStartTimer(){'), html.indexOf('function soloUpdateStageUI(){')), sandbox);
  vm.runInContext(html.slice(html.indexOf('function soloLayerColor('), html.indexOf('function soloRenderAll(){')), sandbox);
  sandbox.soloUpdateTimerBar = function () {};
  const buff = sandbox.DungeonBuff, dungeon = sandbox.Dungeon, D = dungeon.state;
  D.active = true;
  buff.beginRun(D);
  buff.addBuff(D, 'wis', { level: 1 });
  buff.addBuff(D, 'slowdown', {});
  buff.register('shackle', class extends buff.CurseBuff {});
  sandbox.get_buff('shackle');
  assert.strictEqual(D._shackleFlowBonus, 0.1);
  sandbox.soloStartTimer();
  sandbox.soloStartWordTimer();
  for (let i = 0; i < 3; i++) ticks.forEach(fn => fn());
  assert.ok(Math.abs(sandbox.S.timeLeft - 99.802) < 1e-10);
  assert.ok(Math.abs(sandbox.S.wordTimerMs - 3802) < 1e-10);
  buff.register('wordWindowProbe', class extends buff.BaseBuff {
    query(state, inst, key) { return key === 'nextWordTimeBonus' ? { additive: 1000 } : null; }
  });
  buff.addBuff(D, 'wordWindowProbe', {});
  const beforeWord = sandbox.S.wordTimerMs;
  const restored = dungeon.changeResource('time', 5, { sourceCategory: 'ITEM' });
  assert.strictEqual(restored.record.actualDelta, 5);
  assert.strictEqual(sandbox.S.wordTimerMs, beforeWord);
  assert.strictEqual(dungeon.query('nextWordTimeBonus').additive, 1000);
  ticks.forEach(fn => fn());
  assert.ok(Math.abs(sandbox.S.wordTimerMs - (beforeWord - 66)) < 1e-10);
  assert.ok(Math.abs(sandbox.S.timeLeft - 104.736) < 1e-10);
});

after(function () { });
