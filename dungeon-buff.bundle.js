// ============================================================
// dungeon-buff.bundle.js —— 由 build_buffs.py 自动生成，请勿手动编辑。
// 生成时间: 2026-10-14T22:49:27
// 源文件数: 16
// ============================================================

// ---- buffs/_base.js ----
// ============================================================
// buffs/_base.js  ——  地牢 Buff 系统基础设施
// 拼接时永远排在最前。经典脚本，挂 window.DungeonBuff。
// 提供：BaseBuff + 4 个 Category 父类 + 注册器 + 调度层。
// 子类文件在各自末尾用 DungeonBuff.register(id, Cls) 自注册。
// ============================================================
window.DungeonBuff = (function () {
  'use strict';

  // ---- 静态配置：来自导表产物 window.DUNGEON_DATA ----
  function catalog() {
    return (window.DUNGEON_DATA && window.DUNGEON_DATA.tables) || {};
  }
  // 按 id 找定义（属性表 / 道具表）
  function findDef(buffId) {
    var t = catalog();
    return (t.attr_config && t.attr_config[buffId]) ||
           (t.item_config && t.item_config[buffId]) ||
           (t.curse_config && t.curse_config[buffId]) ||
           null;
  }
  // 按来源表推断分类（attr_config→ATTR / curse_config→CURSE / item_config 自带 PASSIVE|INSTANT）
  function categoryOf(buffId) {
    var t = catalog();
    if (t.attr_config && t.attr_config[buffId]) return 'ATTR';
    if (t.item_config && t.item_config[buffId]) return t.item_config[buffId].category || 'PASSIVE';
    if (t.curse_config && t.curse_config[buffId]) return 'CURSE';
    return 'ATTR';
  }
  // 属性效果：直接取 Lv{level} 列（数据驱动，无公式）
  function getAttrEffect(buffId, level) {
    if (level <= 0) return 0;
    var t = catalog();
    var def = t.attr_config && t.attr_config[buffId];
    if (!def) return 0;
    var v = def['lv' + level];
    return typeof v === 'number' ? v : 0;
  }

  // ---- 基类 ----
  class BaseBuff {
    constructor(buffId) { this.buffId = buffId; }
    get def() { return findDef(this.buffId); }
    onAdd(D, instance) {}
    onRemove(D, instance) {}
    onEvent(D, instance, eventType, payload) {}
    query(D, instance, queryKey) { return null; }
  }

  // ---- 4 个 Category 父类 ----
  class AttrBuff extends BaseBuff {
    query(D, instance, queryKey) {
      if (queryKey !== this.buffId) return null;
      return { multiplier: getAttrEffect(this.buffId, instance.level) };
    }
  }

  class PassiveBuff extends BaseBuff {
    onEvent(D, instance, eventType, payload) {
      var def = this.def;
      if (!def || instance.remaining === 0) return;
      if (eventType !== def.triggerOn && !this._handlesEvent(eventType)) return;
      var result = this._applyEffect(D, instance, payload, eventType) || { applied: false };
      if (!result.applied) return;
      if (instance.remaining > 0) instance.remaining--;
      if (result.remove || instance.remaining === 0) removeBuff(D, instance.instanceId);
    }
    _handlesEvent(eventType) { return false; }
    _applyEffect(D, instance, payload, eventType) { return { applied: false }; }
  }

  class InstantBuff extends BaseBuff {
    onAdd(D, instance) {
      var def = this.def || {};
      if (def.effect === 'ADD_GOLD' && typeof window.dungeonInstantAddGold === 'function') {
        window.dungeonInstantAddGold(def.value, instance);
      } else if (def.effect === 'ADD_TIME' && typeof window.dungeonInstantAddTime === 'function') {
        window.dungeonInstantAddTime(def.value, instance);
      } else if (def.effect === 'RM_CURSE' && typeof window.dungeonInstantRemoveCurse === 'function') {
        window.dungeonInstantRemoveCurse(def.value);
      }
      removeBuff(D, instance.instanceId); // 即时道具触发后立刻移除
    }
  }

  class CurseBuff extends BaseBuff {
    query(D, instance, queryKey) { return null; } // 子类覆盖
  }

  // ---- 注册器 ----
  var customHandlers = {}; // 由子类文件自注册填充
  var instances = new Map();

  function register(buffId, Cls) { customHandlers[buffId] = Cls; }

  function defaultHandlerFor(buffId) {
    var def = findDef(buffId);
    if (!def) throw new Error('未知 buffId: "' + buffId + '"');
    switch (categoryOf(buffId)) {
      case 'ATTR':    return new AttrBuff(buffId);
      case 'INSTANT': return new InstantBuff(buffId);
      case 'PASSIVE': throw new Error('PASSIVE "' + buffId + '" 必须自注册子类');
      case 'CURSE':   throw new Error('CURSE "' + buffId + '" 必须自注册子类');
      default:        return new BaseBuff(buffId);
    }
  }

  function getBuffHandler(buffId) {
    var h = instances.get(buffId);
    if (h) return h;
    var Cls = customHandlers[buffId];
    h = Cls ? new Cls(buffId) : defaultHandlerFor(buffId);
    instances.set(buffId, h);
    return h;
  }

  // ---- 调度层 ----
  function addBuff(D, buffId, options) {
    options = options || {};
    var def = findDef(buffId) || {};
    var instance = {
      instanceId: buffId + '_' + Date.now() + '_' + Math.floor(Math.random() * 1e6),
      buffId: buffId,
      category: categoryOf(buffId),
      level: options.level != null ? options.level : 1,
      remaining: options.remaining != null ? options.remaining
               : (def.remaining != null ? def.remaining : -1),
      sourceStage: options.sourceStage != null ? options.sourceStage : 0,
    };
    if (!D.buffs) D.buffs = [];
    D.buffs.push(instance);
    getBuffHandler(buffId).onAdd(D, instance);
    return instance;
  }

  function removeBuff(D, instanceId) {
    if (!D.buffs) return;
    var idx = D.buffs.findIndex(function (b) { return b.instanceId === instanceId; });
    if (idx === -1) return;
    var instance = D.buffs[idx];
    getBuffHandler(instance.buffId).onRemove(D, instance);
    D.buffs.splice(idx, 1);
  }

  function letterGroup(letter) {
    var normalized = String(letter || '').toUpperCase();
    if (!/^[A-Z]$/.test(normalized)) return null;
    if ('ETAOI'.includes(normalized)) return 'HIGH';
    if ('KXJQZ'.includes(normalized)) return 'LOW';
    if ('NRLCMPWB'.includes(normalized)) return 'MID_A';
    return 'MID_B';
  }

  function normalizePos(pos) {
    var mapping = {
      n: 'NOUN', v: 'VERB', vt: 'VERB', vi: 'VERB',
      adj: 'ADJECTIVE', adv: 'ADVERB', prep: 'FUNCTION',
      conj: 'FUNCTION', pron: 'FUNCTION', art: 'FUNCTION',
      det: 'FUNCTION', num: 'NUMERAL', int: 'INTERJECTION', interj: 'INTERJECTION'
    };
    var tags = [], unknown = [];
    var tokens = String(pos || '').toLowerCase().split(/[\s.,;/&、，；]+/).filter(Boolean);
    tokens.forEach(function (token) {
      var tag = mapping[token];
      if (tag) {
        if (!tags.includes(tag)) tags.push(tag);
      } else if (!unknown.includes(token)) unknown.push(token);
    });
    return { posTags: tags.length ? tags : ['UNKNOWN'], unknownPos: unknown };
  }

  function startWord(D, input) {
    var pos = normalizePos(input.pos);
    var positions = input.actualBlankPositions.slice();
    D.wordContext = {
      runSerial: D.runSerial,
      wordSerial: input.wordSerial,
      wordId: input.wordId,
      spelling: input.spelling,
      plannedBlankCount: input.plannedBlankCount,
      actualBlankPositions: positions,
      actualBlankCount: positions.length,
      posTags: pos.posTags,
      unknownPos: pos.unknownPos,
      handLetters: input.handLetters.slice()
    };
    D.wordResults = { wrongResults: [], interruptions: [] };
    return wordContext(D);
  }

  function recordWordResult(D, type, result) {
    var results = D.wordResults;
    if (!results) return;
    var list = type === 'wrong' ? results.wrongResults : results.interruptions;
    if (result.eventSerial != null && list.some(function (entry) {
      return entry.eventSerial === result.eventSerial && entry.reason === result.reason;
    })) return;
    list.push(Object.assign({}, result));
  }

  function wordResults(D) {
    var results = D.wordResults || { wrongResults: [], interruptions: [] };
    return {
      wrongResults: results.wrongResults.map(function (entry) { return Object.assign({}, entry); }),
      interruptions: results.interruptions.map(function (entry) { return Object.assign({}, entry); })
    };
  }

  function wordContext(D) {
    var context = D.wordContext;
    if (!context) return { runSerial: D.runSerial };
    return Object.assign({}, context, {
      actualBlankPositions: context.actualBlankPositions.slice(),
      posTags: context.posTags.slice(),
      unknownPos: context.unknownPos.slice(),
      handLetters: context.handLetters.slice()
    });
  }

  // ---- 本局上下文与事件标识（P0：纯数据、可去重）----
  function beginRun(D) {
    D.runSerial = (D.runSerial || 0) + 1;
    D.eventSerial = 0;
    D.eventKeys = new Set();     // 去重键 runSerial:eventType:eventSerial
    D.pendingIntents = [];       // 待提交意图
    D._intentKeys = new Set();   // 本局意图去重（跨提交持久）
    D._txSeq = 0;
    D._settledTx = new Set();    // 已结算 transactionId
    D._txRecords = {};
    D.resourceLog = [];          // 资源变化记录（来源可查）
    D.wordContext = null;
    D.wordResults = null;
    D._currentEventKey = null;
    D._observingSettlement = false;
  }

  function clearRun(D) {
    if (!D.buffs) D.buffs = [];
    var snapshot = D.buffs.slice();
    for (var i = 0; i < snapshot.length; i++) {
      removeBuff(D, snapshot[i].instanceId); // 每个仍存实例恰一次 onRemove
    }
    D.eventKeys = new Set();
    D.pendingIntents = [];
    D._intentKeys = new Set();
    D._settledTx = new Set();
    D._txRecords = {};
    D.resourceLog = [];
    D.wordContext = null;
    D.wordResults = null;
    D._currentEventKey = null;
    D._observingSettlement = false;
  }

  // 资源提交：唯一 owner 为主游戏（dungeon.js 注册 applier），本层只做
  // 来源记录、上下限执行与 transactionId 去重。记录保留请求值与实际值。
  var resourceAppliers = {};
  function registerResourceApplier(resource, fn) { resourceAppliers[resource] = fn; }

  function settleResource(D, intent) {
    intent = intent || {};
    if (intent.transactionId == null) {
      intent.transactionId = 'tx' + (D.runSerial || 0) + '_' + (++D._txSeq || (D._txSeq = 1));
    }
    var txId = intent.transactionId;
    if (D._settledTx.has(txId)) {
      return { applied: false, deduped: true, transactionId: txId, record: D._txRecords[txId] || null };
    }
    var record = {
      transactionId: txId,
      eventKey: intent.eventKey || null, // runSerial:eventType:eventSerial
      wordSerial: intent.wordSerial == null ? null : intent.wordSerial,
      resource: intent.resource,
      requestedDelta: intent.requestedDelta,
      actualDelta: 0,
      before: null,
      after: null,
      sourceCategory: intent.sourceCategory || null, // BASE/ATTR/ITEM/CURSE/PURCHASE
      sourceReason: intent.sourceReason || null,
      sourceInstanceId: intent.sourceInstanceId || null,
      intentKey: intent.intentKey || null,
    };
    var fn = resourceAppliers[intent.resource];
    var result = null;
    if (typeof fn === 'function') result = fn(intent.requestedDelta, intent, D) || null;
    if (result) {
      record.actualDelta = typeof result.actualDelta === 'number' ? result.actualDelta : 0;
      record.before = result.before == null ? null : result.before;
      record.after = result.after == null ? null : result.after;
    }
    D._settledTx.add(txId);
    D._txRecords[txId] = record;
    D.resourceLog.push(record);
    return { applied: !!result && record.actualDelta !== 0, deduped: false, transactionId: txId, record: record };
  }

  // ---- 附加意图收集与提交（固定排序；同批新增实例不参加本次收集）----
  // 意图优先级（P0 语义阶段，同级按来源 id + intentKey 稳定排序，与注册顺序无关）：
  //   10 收集奖励 / 20 依赖附加段位总量的惩罚 / 30 正向压力（含阈值检测）
  //   40 减压 / 50 连击兑现 / 60 资源奖励 / 70 额外连击（最后加入）
  var INTENT_PRIORITY = { collect: 10, rankPenalty: 20, stressUp: 30, stressDown: 40, comboRedeem: 50, reward: 60, extraCombo: 70 };
  var intentAppliers = {};
  function registerIntentApplier(type, fn) { intentAppliers[type] = fn; }

  function collectIntent(D, intent) {
    if (D._observingSettlement) return null;
    if (!D.pendingIntents) D.pendingIntents = [];
    if (intent.eventKey == null && D._currentEventKey) intent.eventKey = D._currentEventKey;
    D.pendingIntents.push(intent);
    return intent;
  }

  function intentRank(intent) {
    if (typeof intent.priority === 'number') return intent.priority;
    return INTENT_PRIORITY[intent.type] != null ? INTENT_PRIORITY[intent.type] : 60;
  }

  function commitIntents(D, baseSnapshot) {
    var list = (D.pendingIntents || []).slice(); // 快照：提交中新收集不参加
    D.pendingIntents = [];
    list.sort(function (a, b) {
      var pa = intentRank(a), pb = intentRank(b);
      if (pa !== pb) return pa - pb;
      var sa = String(a.sourceId || ''), sb = String(b.sourceId || '');
      if (sa !== sb) return sa < sb ? -1 : 1;
      var ia = String(a.intentKey || ''), ib = String(b.intentKey || '');
      return ia < ib ? -1 : (ia > ib ? 1 : 0);
    });
    var seenKeys = D._intentKeys || (D._intentKeys = new Set());
    var results = [];
    for (var i = 0; i < list.length; i++) {
      var intent = list[i];
      if (intent.sourceInstanceId && !(D.buffs || []).some(function (instance) {
        return instance.instanceId === intent.sourceInstanceId && instance.remaining !== 0;
      })) {
        results.push({ intent: intent, applied: false, reason: 'removedSource' });
        continue;
      }
      var dedupKey = (D.runSerial || 0) + ':' + (intent.eventKey || (baseSnapshot && baseSnapshot.wordSerial) || '') + ':' + (intent.sourceInstanceId || intent.sourceId || '') + ':' + (intent.intentKey || ('auto' + i));
      if (intent.intentKey && seenKeys.has(dedupKey)) {
        results.push({ intent: intent, applied: false, deduped: true });
        continue;
      }
      if (intent.intentKey) seenKeys.add(dedupKey);
      var fn = intentAppliers[intent.type];
      var res = null;
      if (typeof fn === 'function') res = fn(D, intent, baseSnapshot || null) || null;
      var applied = !!(res && res.applied);
      var out = { intent: intent, applied: applied, result: res || null };
      // 有限耐久：仅在实际生效后确认一次；无收益/未生效/重复不扣
      if (applied && intent.sourceInstanceId && res.consumeDurability !== false) {
        var inst = null;
        for (var j = 0; j < (D.buffs || []).length; j++) {
          if (D.buffs[j].instanceId === intent.sourceInstanceId) { inst = D.buffs[j]; break; }
        }
        if (inst && typeof inst.remaining === 'number' && inst.remaining > 0) {
          inst.remaining--;
          if (inst.remaining === 0) removeBuff(D, inst.instanceId);
        }
      }
      results.push(out);
    }
    return results;
  }

  // 派发游戏事件。返回 payload：允许「可拦截 / 可修正」型道具在 onEvent 里
  // 写回字段（如 payload.blocked / payload.mult），主游戏据此决定后续行为。
  // P0：调用前确认实例仍存在（派发中被移除者不再执行）；调用方可携带
  // eventSerial 实现同一结果事件重复派发去重（键 runSerial:eventType:eventSerial）。
  function dispatchEvent(D, eventType, payload) {
    payload = payload || {};
    if (!D.buffs) return payload;
    if (payload.eventSerial == null) payload.eventSerial = ++D.eventSerial;
    var key = (D.runSerial || 0) + ':' + eventType + ':' + payload.eventSerial;
    if (D.eventKeys && D.eventKeys.has(key)) {
      payload._deduped = true;
      return payload;
    }
    if (D.eventKeys) D.eventKeys.add(key);
    payload._eventKey = key;
    var snapshot = D.buffs.slice();
    var previousEventKey = D._currentEventKey;
    var previousObservation = D._observingSettlement;
    D._currentEventKey = key;
    D._observingSettlement = previousObservation || eventType === 'AFTER_WORD_SETTLEMENT' || eventType === 'AFTER_CARD_SETTLEMENT';
    try {
      for (var i = 0; i < snapshot.length; i++) {
        if (D.buffs.indexOf(snapshot[i]) === -1) continue; // 派发期间被移除：跳过
        getBuffHandler(snapshot[i].buffId).onEvent(D, snapshot[i], eventType, payload);
      }
    } finally {
      D._currentEventKey = previousEventKey;
      D._observingSettlement = previousObservation;
    }
    return payload;
  }

  function query(D, queryKey) {
    var result = { additive: 0, multiplier: 1 };
    if (!D.buffs) return result;
    for (var i = 0; i < D.buffs.length; i++) {
      var r = getBuffHandler(D.buffs[i].buffId).query(D, D.buffs[i], queryKey);
      if (!r) continue;
      if (r.additive) result.additive += r.additive;
      if (r.multiplier) result.multiplier *= r.multiplier;
    }
    return result;
  }

  return {
    BaseBuff: BaseBuff,
    AttrBuff: AttrBuff,
    PassiveBuff: PassiveBuff,
    InstantBuff: InstantBuff,
    CurseBuff: CurseBuff,
    register: register,
    getBuffHandler: getBuffHandler,
    addBuff: addBuff,
    removeBuff: removeBuff,
    beginRun: beginRun,
    startWord: startWord,
    wordContext: wordContext,
    recordWordResult: recordWordResult,
    wordResults: wordResults,
    letterGroup: letterGroup,
    normalizePos: normalizePos,
    clearRun: clearRun,
    dispatchEvent: dispatchEvent,
    query: query,
    catalog: catalog,
    getAttrEffect: getAttrEffect,
    settleResource: settleResource,
    registerResourceApplier: registerResourceApplier,
    collectIntent: collectIntent,
    commitIntents: commitIntents,
    registerIntentApplier: registerIntentApplier,
    INTENT_PRIORITY: INTENT_PRIORITY,
  };
})();

// ---- buffs/curse/cyclone.js ----
// buffs/curse/cyclone.js
// 旋风：词牌切换时随机锁定 1/2/3 个手牌位置；该位置每次补牌都会重新应用旋转。
DungeonBuff.register('cyclone', class extends DungeonBuff.CurseBuff {
  onEvent(D, instance, eventType, payload) {
    if (eventType === 'RENDER') {
      instance._cycloneSlots = this._pickSlots(instance.level, payload && payload.handSize);
      instance._cycloneDirection = Math.random() < 0.5 ? -1 : 1;
      return;
    }
    if (eventType !== 'HAND_RENDER' || !payload || !payload.slots) return;
    var selected = instance._cycloneSlots || [];
    for (var i = 0; i < payload.slots.length; i++) {
      var slot = payload.slots[i];
      if (!slot || selected.indexOf(slot.index) === -1 || slot.tile.classList.contains('used')) continue;
      slot.tile.classList.add('dungeon-cyclone-tile');
      slot.tile.style.setProperty('--cyclone-direction', instance._cycloneDirection || 1);
    }
  }

  _pickSlots(level, handSize) {
    var slots = [];
    for (var i = 1; i <= (handSize || 6); i++) slots.push(i);
    for (var j = slots.length - 1; j > 0; j--) {
      var pick = Math.floor(Math.random() * (j + 1));
      var temp = slots[j];
      slots[j] = slots[pick];
      slots[pick] = temp;
    }
    return slots.slice(0, Math.min(level, 3, slots.length));
  }
});

// ---- buffs/curse/daze.js ----
// buffs/curse/daze.js
// 恍惚：词牌刷新后立刻渐隐；后续按随机间隔重复，连续两轮优先不选相同字母。
DungeonBuff.register('daze', class extends DungeonBuff.CurseBuff {
  onAdd(D, instance) {
    instance._daze = { timers: [], active: [], previous: [] };
  }

  onRemove(D, instance) {
    this._clear(instance);
  }

  onEvent(D, instance, eventType, payload) {
    if (eventType !== 'RENDER' || !payload || !payload.tiles) return;
    this._clear(instance);
    var state = instance._daze = { timers: [], active: [], previous: [], tiles: payload.tiles };
    var count = Math.min(instance.level, 3);
    var duration = instance.level >= 4 ? 2000 : 1000;
    this._schedule(instance, count, duration, true);
  }

  _schedule(instance, count, duration, immediate) {
    var self = this;
    var state = instance._daze;
    if (!state) return;
    var run = function () {
      if (!instance._daze || instance._daze !== state) return;
      self._fade(instance, count, duration);
      state.timers.push(setTimeout(run, duration + self._delay()));
    };
    if (immediate) run();
    else state.timers.push(setTimeout(run, this._delay()));
  }

  _fade(instance, count, duration) {
    var state = instance._daze;
    if (!state || !state.tiles) return;
    var choices = state.tiles.filter(function (tile) {
      return tile && tile.isConnected && state.active.indexOf(tile) === -1 && state.previous.indexOf(tile) === -1;
    });
    if (choices.length < count) {
      choices = state.tiles.filter(function (tile) {
        return tile && tile.isConnected && state.active.indexOf(tile) === -1;
      });
    }
    if (!choices.length) return;
    var selected = [];
    while (choices.length && selected.length < count) {
      var index = Math.floor(Math.random() * choices.length);
      selected.push(choices.splice(index, 1)[0]);
    }
    state.previous = selected;
    for (var i = 0; i < selected.length; i++) {
      var tile = selected[i];
      state.active.push(tile);
      tile.classList.add('dungeon-trance-fading');
      state.timers.push(setTimeout(function (target) {
        return function () {
          target.classList.remove('dungeon-trance-fading');
          var activeIndex = state.active.indexOf(target);
          if (activeIndex !== -1) state.active.splice(activeIndex, 1);
        };
      }(tile), duration));
    }
  }

  _delay() {
    return 1200 + Math.floor(Math.random() * 1201);
  }

  _clear(instance) {
    var state = instance._daze;
    if (!state) return;
    for (var i = 0; i < state.timers.length; i++) clearTimeout(state.timers[i]);
    for (var j = 0; j < state.active.length; j++) state.active[j].classList.remove('dungeon-trance-fading');
    instance._daze = null;
  }
});

// ---- buffs/curse/fatigue.js ----
// buffs/curse/fatigue.js
// TODO(fatigue)：积分降低比例
DungeonBuff.register('fatigue', class extends DungeonBuff.CurseBuff {
  query(D, instance, queryKey) {
    if (queryKey !== 'SCORE_MULT') return null;
    // TODO: 积分降低比例（按 instance.level 返回 { additive } 或 { multiplier }）
    return null;
  }
});

// ---- buffs/curse/illusion.js ----
// buffs/curse/illusion.js
// TODO(illusion)：手牌字母随机互换位置
DungeonBuff.register('illusion', class extends DungeonBuff.CurseBuff {
  onEvent(D, instance, eventType, payload) {
    if (eventType !== 'DEAL') return;
    // TODO: 手牌字母随机互换位置
  }
});

// ---- buffs/curse/imbalance.js ----
// buffs/curse/imbalance.js
// TODO(imbalance)：字母随机倒转
DungeonBuff.register('imbalance', class extends DungeonBuff.CurseBuff {
  onEvent(D, instance, eventType, payload) {
    if (eventType !== 'RENDER') return;
    // TODO: 字母随机倒转
  }
});

// ---- buffs/curse/regret.js ----
// buffs/curse/regret.js
// TODO(regret)：连击中断扣额外分/时间
DungeonBuff.register('regret', class extends DungeonBuff.CurseBuff {
  onEvent(D, instance, eventType, payload) {
    if (eventType !== 'BREAK') return;
    // TODO: 连击中断扣额外分/时间
  }
});

// ---- buffs/curse/shackle.js ----
// buffs/curse/shackle.js
// TODO(shackle)：流速加成比例
DungeonBuff.register('shackle', class extends DungeonBuff.CurseBuff {
  query(D, instance, queryKey) {
    if (queryKey !== 'FLOW_MULT') return null;
    // TODO: 流速加成比例（按 instance.level 返回 { additive } 或 { multiplier }）
    return null;
  }
});

// ---- buffs/curse/wave.js ----
// buffs/curse/wave.js
// 海浪：手牌整体呈波浪状上下晃动（偏上浮动），最高 4 层，层数越高晃动幅度越大。
// 由主游戏在 soloRenderHand 末尾派发 'HAND_RENDER' 事件驱动，payload.tiles 为手牌 .card DOM 列表。
// 位移写入卡牌的位移合成层 .card-motion（变量 --wave-amp 驱动动画 --wave-y），
// 与其它位移 buff 叠加、互不覆盖；出牌飞行读取合成层，无需感知本诅咒。
DungeonBuff.register('wave', class extends DungeonBuff.CurseBuff {
  onEvent(D, instance, eventType, payload) {
    if (eventType !== 'HAND_RENDER' || !payload || !payload.tiles) return;
    var amp = [0, 12, 26, 54, 110][instance.level] || 110; // px：Lv1=12 / Lv2=26 / Lv3=54 / Lv4=110
    var tiles = payload.tiles;
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      if (!t || t.classList.contains('used')) continue; // 空槽不晃
      var motion = t.querySelector && t.querySelector('.card-motion');
      if (!motion) continue;
      motion.classList.add('dungeon-wave-tile');
      motion.style.setProperty('--wave-amp', amp + 'px');
      motion.style.animationDelay = (i * 0.13) + 's'; // 相邻牌错相位 → 波浪
    }
  }
});

// ---- buffs/passive/focus.js ----
// buffs/passive/focus.js
// TODO(focus)：答对触发，延长下一题答题窗口
DungeonBuff.register('focus', class extends DungeonBuff.PassiveBuff {
  _applyEffect(D, instance, payload) {
    // TODO: 答对触发，延长下一题答题窗口
  }
});

// ---- buffs/passive/insight.js ----
// buffs/passive/insight.js
// TODO(insight)：答对触发，显示提示字母
DungeonBuff.register('insight', class extends DungeonBuff.PassiveBuff {
  _applyEffect(D, instance, payload) {
    // TODO: 答对触发，显示提示字母
  }
});

// ---- buffs/passive/lucky.js ----
// buffs/passive/lucky.js
// TODO(lucky)：炫彩判定时概率翻倍
DungeonBuff.register('lucky', class extends DungeonBuff.PassiveBuff {
  _applyEffect(D, instance, payload) {
    // TODO: 炫彩判定时概率翻倍
  }
});

// ---- buffs/passive/medkit.js ----
// buffs/passive/medkit.js
DungeonBuff.register('medkit', class extends DungeonBuff.PassiveBuff {
  _handlesEvent(eventType) { return eventType === 'BEFORE_LIFE_LOSS'; }

  _applyEffect(D, instance, payload, eventType) {
    if (eventType !== 'BEFORE_LIFE_LOSS' || !payload || payload.blocked) return { applied: false };
    payload.blocked = true;
    payload.restoreLives = this.def.value || 1;
    return { applied: true };
  }
});

// ---- buffs/passive/rewind.js ----
// buffs/passive/rewind.js
DungeonBuff.register('rewind', class extends DungeonBuff.PassiveBuff {
  _handlesEvent(eventType) { return eventType === 'BEFORE_TIMEOUT'; }

  _applyEffect(D, instance, payload, eventType) {
    if (eventType !== 'BEFORE_TIMEOUT' || !payload || payload.blocked) return { applied: false };
    payload.blocked = true;
    payload.restoreTime = this.def.value;
    return { applied: true };
  }
});

// ---- buffs/passive/shield.js ----
// buffs/passive/shield.js
DungeonBuff.register('shield', class extends DungeonBuff.PassiveBuff {
  _handlesEvent(eventType) { return eventType === 'BEFORE_WRONG'; }

  _applyEffect(D, instance, payload, eventType) {
    if (eventType !== 'BEFORE_WRONG' || !payload || payload.blocked || (payload.preventTimePenalty && payload.preventStress)) return { applied: false };
    payload.preventTimePenalty = true;
    payload.preventStress = true;
    payload.preventExtraPenalty = true;
    return { applied: true };
  }
});

// ---- buffs/passive/slowdown.js ----
// buffs/passive/slowdown.js
DungeonBuff.register('slowdown', class extends DungeonBuff.PassiveBuff {
  query(D, instance, queryKey) {
    if (queryKey !== 'flowMultiplier') return null;
    return { multiplier: 1 - (this.def.value || 0) };
  }
});
