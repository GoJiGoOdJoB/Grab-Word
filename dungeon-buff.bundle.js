// ============================================================
// dungeon-buff.bundle.js —— 由 build_buffs.py 自动生成，请勿手动编辑。
// 生成时间: 2026-07-29T22:49:37
// 源文件数: 1
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
      if (!def || eventType !== def.triggerOn) return;
      if (instance.remaining <= 0) return;
      this._applyEffect(D, instance, payload);
      instance.remaining--;
      if (instance.remaining <= 0) removeBuff(D, instance.instanceId);
    }
    _applyEffect(D, instance, payload) {} // 子类覆盖
  }

  class InstantBuff extends BaseBuff {
    onAdd(D, instance) {
      var def = this.def || {};
      if (def.effect === 'ADD_GOLD' && typeof window.dungeonInstantAddGold === 'function') {
        window.dungeonInstantAddGold(def.value);
      } else if (def.effect === 'ADD_TIME' && typeof window.dungeonInstantAddTime === 'function') {
        window.dungeonInstantAddTime(def.value);
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
    switch (def.category || 'ATTR') {
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
      category: def.category || 'ATTR',
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

  function dispatchEvent(D, eventType, payload) {
    if (!D.buffs) return;
    payload = payload || {};
    var snapshot = D.buffs.slice();
    for (var i = 0; i < snapshot.length; i++) {
      getBuffHandler(snapshot[i].buffId).onEvent(D, snapshot[i], eventType, payload);
    }
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
    dispatchEvent: dispatchEvent,
    query: query,
    catalog: catalog,
    getAttrEffect: getAttrEffect,
  };
})();
