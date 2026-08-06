// ============================================================
// 地牢模式 (Dungeon DLC) - 外置模块
// 注入方式：在主HTML的 </body> 前引入 <script src="dungeon.js"></script>
// 依赖：主文件中的全局变量 S, selectedSubmode, selectedMode 等
// ============================================================

(function(){
'use strict';

// ===== 地牢状态 =====
const D = {
  active: false,
  // 货币
  gold: 0,
  // 压力系统
  stress: 0,
  stressThreshold: 40,
  stressTriggerCount: 0,
  wrongCountSession: 0, // 本题错牌累计(用于压力计算)
  // boss关临时诅咒（记 curseKey，退出时按 key 降级）
  tempCurses: [],
  // 统一数据源：ATTR/PASSIVE/CURSE/INSTANT 全部实例化到这里
  buffs: [], // [{instanceId, buffId, category, level, remaining, sourceStage}]
  // 强化环节
  shopVisitCount: 0,
  buyCounts: {}, // {buffId: 本局已购买次数}，统一定价公式的 n
  // Boss
  bossActive: false,
};

// ===== 配置 =====
const DUNGEON_CFG = {
  stressThresholdBase: 40,
  stressPerTimeout: 2,
  stressPerPass: 3,
  stressPerPromote: { easy:5, medium:6, hard:7, endless:8 },
  goldPerPromote: { easy:3, medium:5, hard:7, endless:8 },
  goldPerBurst: 1,
  goldPerPerfectBurst: 4,
  goldPerBoss: 3,
  bossInterval: 3,
  wrongStressStartAt: 3, // 从第3次错牌开始累计压力
  shopFirstTriggerStage: 3, // 初中1星
  shopPreviewHoldTime: 1500, // ms
};

// ===== 属性名称映射 =====
const ATTR_NAMES = {
  str:'力量', wis:'智慧', brv:'勇气', end:'耐力', dex:'技巧', luk:'运气'
};
const ATTR_KEYS = ['str','wis','brv','end','dex','luk'];

// ===== 诅咒定义 =====
const CURSE_DEFS = {
  daze:    { name:'恍惚', maxLv:5, desc:'字母透明度闪烁' },
  illusion:{ name:'幻觉', maxLv:3, desc:'手牌字母互换位置' },
  imbalance:{name:'失衡', maxLv:5, desc:'字母倒转显示' },
  fatigue: { name:'乏力', maxLv:0, desc:'段位积分累计降低' }, // 0=无上限
  regret:  { name:'后悔', maxLv:0, desc:'连击中断额外扣分' },
  shackle: { name:'镣铐', maxLv:0, desc:'答题流速增加' },
};
const CURSE_KEYS = Object.keys(CURSE_DEFS);

// ===== 工具函数 =====
function isDungeonActive(){ return D.active; }

function getStageTier(stageIdx){
  if(stageIdx>=9) return 'endless';
  if(stageIdx>=6) return 'hard';
  if(stageIdx>=3) return 'medium';
  return 'easy';
}

// 属性效果：委托配置驱动版（Lv{level} 列），无公式
function getAttrEffect(key, level){
  if(level<=0) return 0;
  if(typeof DungeonBuff!=='undefined' && DungeonBuff.getAttrEffect){
    return DungeonBuff.getAttrEffect(key, level);
  }
  return 0;
}

// ===== 统一数据源 D.buffs：层级辅助 =====
// ATTR / CURSE 为「按 id 唯一的等级实例」，PASSIVE / INSTANT 为独立实例
function dungeonFindBuff(buffId){
  for(var i=0;i<D.buffs.length;i++){ if(D.buffs[i].buffId===buffId) return D.buffs[i]; }
  return null;
}
function dungeonLevelOf(buffId){
  var b = dungeonFindBuff(buffId);
  return b ? b.level : 0;
}
function dungeonMaxLevelOf(buffId){
  if(ATTR_NAMES[buffId]) return 10;                       // 属性封顶 Lv10
  if(CURSE_DEFS[buffId]) return CURSE_DEFS[buffId].maxLv || 0; // 0 = 无上限
  return 0;
}
// 升/降 ATTR/CURSE 等级；不存在则创建，降到 0 则移除
function dungeonAddLevel(buffId, delta){
  var b = dungeonFindBuff(buffId);
  if(!b){
    if(delta<=0) return;
    b = DungeonBuff.addBuff(D, buffId, {level:0});
  }
  b.level += delta;
  var mx = dungeonMaxLevelOf(buffId);
  if(mx>0 && b.level>mx) b.level = mx;
  if(b.level<=0) DungeonBuff.removeBuff(D, b.instanceId);
  return b;
}

// ===== 配置按需加载（不进主程序，进地牢时才注入）=====
function dungeonLoadData(){
  if(window.DUNGEON_DATA) return;                               // 已加载
  if(document.getElementById('dungeonDataScript')) return;      // 加载中
  var s = document.createElement('script');
  s.id  = 'dungeonDataScript';
  s.src = 'game_dungeon_data.js';
  document.head.appendChild(s);
}

// ===== 即时道具效果回调（供 DungeonBuff.InstantBuff 调用）=====
window.dungeonInstantAddGold = function(v){
  D.gold += (v||0);
  dungeonRenderGoldUI();
};
window.dungeonInstantAddTime = function(v){
  if(typeof S!=='undefined'){
    S.timeLeft += (v||0);
    if(typeof soloUpdateTimerBar==='function') soloUpdateTimerBar();
  }
};
window.dungeonInstantRemoveCurse = function(v){
  var n = v||1;
  for(var i=0;i<n;i++){
    var curses = D.buffs.filter(function(b){ return b.category==='CURSE' && b.level>0; });
    if(!curses.length) break;
    var pick = curses[Math.floor(Math.random()*curses.length)];
    dungeonAddLevel(pick.buffId, -1);
  }
  dungeonApplyCurseEffects();
};

// ===== 核心机制 =====

// 初始化地牢模式
function dungeonInit(){
  D.active = true;
  D.gold = 0;
  D.stress = 0;
  D.stressThreshold = DUNGEON_CFG.stressThresholdBase;
  D.stressTriggerCount = 0;
  D.wrongCountSession = 0;
  D.tempCurses = [];
  D.buffs = [];
  D.shopVisitCount = 0;
  D.buyCounts = {};
  D.bossActive = false;
  // 按需加载地牢配置（不进主程序，进地牢时才注入）
  dungeonLoadData();
  // 切换单词簿为状态区
  const label = document.getElementById('soloBookLabel');
  if(label) label.textContent = '状态';
  dungeonRenderGoldUI();
  dungeonRenderStressBar();
  dungeonRenderStateArea();
}

function dungeonReset(){
  D.active = false;
  // 恢复单词簿
  const label = document.getElementById('soloBookLabel');
  if(label) label.textContent = '单词簿';
  const book = document.getElementById('soloBook');
  if(book) book.innerHTML = '';
  dungeonHideUI();
}

// ===== 压力值系统 =====

function dungeonAddStress(amount){
  if(!D.active) return;
  const endReduction = getAttrEffect('end', dungeonLevelOf('end'));
  const actual = Math.max(0, Math.round(amount * (1 - endReduction)));
  D.stress += actual;
  dungeonRenderStressBar();
  // 检查阈值
  while(D.stress >= D.stressThreshold){
    D.stress -= D.stressThreshold;
    D.stressTriggerCount++;
    dungeonTriggerCurse();
  }
  dungeonRenderStressBar();
}

function dungeonTriggerCurse(){
  // 随机抽取一个诅咒
  const available = CURSE_KEYS.filter(k=>{
    const def = CURSE_DEFS[k];
    if(def.maxLv===0) return true; // 无上限
    return dungeonLevelOf(k) < def.maxLv;
  });
  if(available.length===0) return; // 所有诅咒满级
  const luk = getAttrEffect('luk', dungeonLevelOf('luk'));
  // 运气：以 luk 概率抑制高层诅咒——命中时改抽当前等级最低的诅咒
  let picked;
  if(Math.random() < luk){
    let minLv = Infinity;
    available.forEach(k=>{ const lv=dungeonLevelOf(k); if(lv<minLv) minLv=lv; });
    const lowest = available.filter(k=>dungeonLevelOf(k)===minLv);
    picked = lowest[Math.floor(Math.random()*lowest.length)];
  } else {
    picked = available[Math.floor(Math.random()*available.length)];
  }
  dungeonAddLevel(picked, 1);
  dungeonShowCurseEffect(picked);
  dungeonRenderStateArea();
  dungeonApplyCurseEffects();
}

function dungeonShowCurseEffect(curseKey){
  // 全屏紫色特效(类似连击爆发，无中央文字)
  const flash = document.createElement('div');
  flash.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:100;pointer-events:none;box-shadow:inset 0 0 120px 40px rgba(128,0,255,0.6);animation:dungeonCurseFlash 0.8s ease-out forwards;';
  document.body.appendChild(flash);
  setTimeout(()=>flash.remove(), 900);
  if(typeof playSound==='function') playSound(180, 0.5, 0.4);
}

// ===== 金币系统 =====

function dungeonAddGold(amount){
  if(!D.active) return;
  D.gold += amount;
  dungeonRenderGoldUI();
}

function dungeonSpendGold(amount){
  if(D.gold < amount) return false;
  D.gold -= amount;
  dungeonRenderGoldUI();
  return true;
}

// ===== Boss关 =====

function dungeonCheckBoss(stageIdx){
  // Boss在每大段位的3星: stageIdx 2,5,8; endless每3级
  if(stageIdx >= 9){
    const el = (typeof S!=='undefined') ? S.endlessLevel : 0;
    return el > 0 && el % 3 === 0;
  }
  return (stageIdx + 1) % 3 === 0; // 2,5,8
}

function dungeonEnterBoss(){
  D.bossActive = true;
  // 临时添加1个1级诅咒
  const available = CURSE_KEYS.filter(k=>{
    const def = CURSE_DEFS[k];
    if(def.maxLv===0) return true;
    return dungeonLevelOf(k) < def.maxLv;
  });
  if(available.length>0){
    const picked = available[Math.floor(Math.random()*available.length)];
    D.tempCurses.push({key:picked});
    dungeonAddLevel(picked, 1);
    dungeonApplyCurseEffects();
    dungeonRenderStateArea();
  }
  // 段位积分条外框变红
  const promoBar = document.querySelector('.solo-promo-bar');
  if(promoBar) promoBar.style.boxShadow = '0 0 0 2px #e53935';
}

function dungeonExitBoss(){
  D.bossActive = false;
  // 移除临时诅咒
  D.tempCurses.forEach(tc=>{
    if(dungeonLevelOf(tc.key) > 0) dungeonAddLevel(tc.key, -1);
  });
  D.tempCurses = [];
  dungeonApplyCurseEffects();
  dungeonRenderStateArea();
  // 恢复积分条外框
  const promoBar = document.querySelector('.solo-promo-bar');
  if(promoBar) promoBar.style.boxShadow = '';
  // Boss额外金币
  dungeonAddGold(DUNGEON_CFG.goldPerBoss);
}

// ===== 属性效果应用 =====

// 流速修正(智慧)
function dungeonGetFlowRateMultiplier(){
  if(!D.active) return 1;
  return Math.max(0.3, 1 - getAttrEffect('wis', dungeonLevelOf('wis')));
}

// 勇气减伤(brv)：最终伤害 = 原伤害 × (1 - 基础减伤系数 × 该惩罚修正)
//   基础减伤系数 = brv 的 Lv{level} 列（随等级增）
//   修正系数     = brv_mitigation[key].coeff（固定常量，配置表）
function dungeonBrvMitigate(key, raw){
  if(!D.active) return raw;
  const base = getAttrEffect('brv', dungeonLevelOf('brv'));
  if(base<=0) return raw;
  const t = (typeof DungeonBuff!=='undefined') ? DungeonBuff.catalog() : {};
  const row = t.brv_mitigation && t.brv_mitigation[key];
  const coeff = (row && typeof row.coeff==='number') ? row.coeff : 0;
  const reduce = Math.min(0.9, base * coeff); // 减伤上限 90%，避免归零
  return raw * (1 - reduce);
}

// 段位积分额外加成(力量)
function dungeonGetPromoScoreBonus(baseScore){
  if(!D.active) return 0;
  return Math.round(baseScore * getAttrEffect('str', dungeonLevelOf('str')));
}

// 炫彩概率加成(技巧)
function dungeonGetShinyBonus(){
  if(!D.active) return 0;
  return getAttrEffect('dex', dungeonLevelOf('dex'));
}

// ===== 诅咒效果应用 =====

function dungeonApplyCurseEffects(){
  // 镣铐: 增加答题流速
  const shackleLv = dungeonLevelOf('shackle');
  if(typeof S!=='undefined' && D.active){
    // Store dungeon flow penalty for main loop to read
    D._shackleFlowBonus = shackleLv * 0.1;
  }
}

// 乏力: 段位积分累计降低
function dungeonGetFatigueReduction(){
  const fatigueLv = dungeonLevelOf('fatigue');
  if(fatigueLv===0) return 0;
  return Math.min(0.8, 0.15 + (fatigueLv-1)*0.10);
}

// 后悔: 连击中断额外扣分/扣时间
function dungeonApplyRegret(){
  const regretLv = dungeonLevelOf('regret');
  if(regretLv===0 || !D.active) return;
  const scorePenalty = regretLv * 2;
  const timePenalty = Math.max(0, regretLv - 2);
  if(typeof S!=='undefined'){
    S.totalScore = Math.max(0, S.totalScore - scorePenalty);
    S.stageScore -= scorePenalty;
    if(timePenalty > 0) S.timeLeft = Math.max(0, S.timeLeft - timePenalty);
  }
}

// ===== 强化环节(商城) =====

function dungeonShouldShowShop(stageIdx){
  return D.active && stageIdx >= DUNGEON_CFG.shopFirstTriggerStage;
}

function dungeonOpenShop(){
  D.shopVisitCount++;
  dungeonRenderShop();
}

function dungeonRenderShop(){
  // Hide game content below promo bar + hide promo bar
  const els = ['soloWordSection','soloStatus'];
  els.forEach(id=>{ const e=document.getElementById(id); if(e) e.style.display='none'; });
  document.querySelector('#soloPanel .solo-cards-section').style.display='none';
  document.querySelector('#soloPanel .solo-book-section').style.display='none';
  document.querySelector('#soloPanel .solo-promo-area').style.display='none';
  const stressBar = document.getElementById('dungeonStressBar');
  if(stressBar) stressBar.style.display='none';

  // Pause global time flow
  D._savedGlobalFlow = S.globalFlowRate;
  S.globalFlowRate = 0;

  // Show shop area
  const area = document.getElementById('dungeonShopArea');
  area.style.display = '';
  area.innerHTML = '';

  // Header (title centered, no currencies)
  area.innerHTML = `
    <div class="dshop-header">
      <div class="dshop-title">强化</div>
      <div class="dungeon-gold dshop-header-gold"><span class="dgold-num">${D.gold}</span>G</div>
    </div>
  `;

  // Section 1: G金币交易
  area.appendChild(dungeonRenderGSection());

  // Section 2: P/T交易 (轮流)
  if(D.shopVisitCount % 2 === 1){
    area.appendChild(dungeonRenderPSection());
  } else {
    area.appendChild(dungeonRenderTSection());
  }

  // Section 3: C诅咒交易
  area.appendChild(dungeonRenderCSection());

  // Continue button
  const footer = document.createElement('div');
  footer.className = 'dshop-footer';
  footer.innerHTML = `<button class="dshop-continue" id="dungeonShopContinue">继续前进 →</button>`;
  area.appendChild(footer);

  document.getElementById('dungeonShopContinue').onclick = dungeonCloseShop;
  if(typeof playSound==='function'){playSound(523,0.15);setTimeout(()=>playSound(784,0.15),100);setTimeout(()=>playSound(1047,0.2),200);}

  // 初始化可购买状态（灰色遮罩）
  dungeonUpdateDisabledState();
  dungeonApplyCardTilt(area);
}

// ===== 商品卡片 HTML 生成 =====

// ===== 统一定价公式（§3.1.2）=====
// 最终价格 = 基础价格 × 价格递增系数^n × 商店整体递增系数^m
//   n = 该商品本局已购买次数 (D.buyCounts)
//   m = 已进入商店次数 (D.shopVisitCount 从 1 起算，故 m = shopVisitCount-1)
function dungeonShopCoeff(){
  const t  = (typeof DungeonBuff!=='undefined') ? DungeonBuff.catalog() : {};
  const sc = (t.shop_coeff && t.shop_coeff.shopGlobalCoeff) || null;
  return (sc && typeof sc.value==='number') ? sc.value : 1.1;
}
function dungeonPriceDef(buffId){
  const t = (typeof DungeonBuff!=='undefined') ? DungeonBuff.catalog() : {};
  return (t.attr_config && t.attr_config[buffId]) ||
         (t.item_config && t.item_config[buffId]) || null;
}
function dungeonPrice(buffId){
  const def = dungeonPriceDef(buffId);
  if(!def) return 0;
  const base = (typeof def.basePrice==='number') ? def.basePrice : 0;
  const step = (typeof def.priceStep==='number') ? def.priceStep : 1;
  const n    = D.buyCounts[buffId] || 0;
  const m    = Math.max(0, D.shopVisitCount - 1);
  return Math.round(base * Math.pow(step, n) * Math.pow(dungeonShopCoeff(), m));
}
// 刷新价（来自 shop_coeff.rerollPrice{G|P|T|C}）
function dungeonRerollPrice(curUpper){
  const fallback = { G:2, P:15, T:5, C:1 };
  const t  = (typeof DungeonBuff!=='undefined') ? DungeonBuff.catalog() : {};
  const sc = (t.shop_coeff && t.shop_coeff['rerollPrice'+curUpper]) || null;
  return (sc && typeof sc.value==='number') ? sc.value : (fallback[curUpper] || 0);
}

// 属性升级卡片
// currency: 'g'|'p'|'t'
function dungeonAttrCardHTML(attrKey, currency){
  const cnName  = ATTR_NAMES[attrKey];
  const enName  = {str:'Strength',wis:'Wisdom',brv:'Bravery',end:'Endurance',dex:'Dexterity',luk:'Luck'}[attrKey];
  const curLv   = dungeonLevelOf(attrKey);
  const nextLv  = curLv + 1;
  const price   = dungeonPrice(attrKey);
  const cur     = currency.toUpperCase();
  return `
    <div class="dcard dcard-attr" data-attr="${attrKey}" data-price="${price}" data-cur="${cur}">
      <div class="dcard-inner">
      <div class="dcard-body">
        <div class="dcard-row-top">
          <span class="dcard-cn">${cnName}</span>
          <span class="dcard-en">${enName}</span>
        </div>
        <div class="dcard-row-lv">
          <span class="dcard-lv-cur">Lv.${curLv}</span>
          <span class="dcard-arrow"></span>
          <span class="dcard-lv-next">Lv.${nextLv}</span>
        </div>
      </div>
      <div class="dcard-cost dcard-cost-${cur.toLowerCase()}">
        <span class="dcard-cost-num">${price}</span>
        <span class="dcard-cost-unit">${cur}</span>
      </div>
      </div>
    </div>`;
}

// 道具卡片
function dungeonItemCardHTML(itemDef, currency){
  const cur = currency.toUpperCase();
  const price = dungeonPrice(itemDef.id) || itemDef.price || 0;
  return `
    <div class="dcard dcard-item" data-item="${itemDef.id}" data-price="${price}" data-cur="${cur}">
      <div class="dcard-inner">
      <div class="dcard-body dcard-body-item">
        <div class="dcard-item-text">
          <span class="dcard-item-en">${itemDef.nameEn||itemDef.id}</span>
          <span class="dcard-item-cn">${itemDef.name}</span>
        </div>
        <div class="dcard-item-icon"></div>
      </div>
      <div class="dcard-cost dcard-cost-${cur.toLowerCase()}">
        <span class="dcard-cost-num">${price}</span>
        <span class="dcard-cost-unit">${cur}</span>
      </div>
      </div>
    </div>`;
}

// 道具数据表
const ITEM_DEFS_LOW = [
  {id:'shield',   name:'护盾',   nameEn:'Shield',   price:5},
  {id:'focus',    name:'专注',   nameEn:'Focus',    price:4},
  {id:'insight',  name:'洞察',   nameEn:'Insight',  price:4},
  {id:'goldpot',  name:'金币罐', nameEn:'Gold Pot', price:3},
];
const ITEM_DEFS_HIGH = [
  {id:'purify',   name:'净化',   nameEn:'Purify',   price:10},
  {id:'lucky',    name:'幸运星', nameEn:'Lucky Star',price:9},
  {id:'slowdown', name:'缓行者', nameEn:'Slowdown', price:12},
];
const ITEM_DEFS_TIME = [
  {id:'rewind',   name:'时间回溯',nameEn:'Rewind',   price:8},
  {id:'medkit',   name:'急救包',  nameEn:'Med Kit',  price:6},
];

function dungeonRenderGSection(){
  const section = document.createElement('div');
  section.className = 'dshop-section dshop-section-g';

  // 生成 G 区 6 个槽位内容
  const attrPool = shuffle(ATTR_KEYS.slice());
  const cards = [
    dungeonAttrCardHTML(attrPool[0], 'g'),                                       // 1: 固定属性
    Math.random()<0.7 ? dungeonAttrCardHTML(attrPool[1],'g') : dungeonItemCardHTML(shuffle(ITEM_DEFS_LOW.slice())[0],'g'), // 2
    Math.random()<0.4 ? dungeonAttrCardHTML(attrPool[2],'g') : dungeonItemCardHTML(shuffle(ITEM_DEFS_LOW.slice())[0],'g'), // 3
    dungeonItemCardHTML(shuffle(ITEM_DEFS_LOW.slice())[0], 'g'),                  // 4
    Math.random()<0.6 ? dungeonItemCardHTML(shuffle(ITEM_DEFS_HIGH.slice())[0],'g') : dungeonItemCardHTML(shuffle(ITEM_DEFS_LOW.slice())[0],'g'), // 5
    dungeonItemCardHTML(shuffle(ITEM_DEFS_HIGH.slice())[0], 'g'),                 // 6: 固定高价值
  ];

  section.innerHTML = `
    <div class="dshop-section-header">
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="dshop-section-icon dshop-icon-g">G</span>
        <span class="dshop-section-label">金币交易</span>
      </div>
      <button class="dshop-reroll dshop-reroll-g" data-price="${dungeonRerollPrice('G')}" data-cur="G">⟳ ${dungeonRerollPrice('G')}G</button>
    </div>
    <div class="dshop-grid dshop-grid-6">
      ${cards.join('')}
    </div>
  `;
  dungeonBindCardClicks(section, 'g');
  dungeonBindRerollBtn(section);
  return section;
}

function dungeonRenderPSection(){
  const section = document.createElement('div');
  section.className = 'dshop-section dshop-section-p';

  const attrs = shuffle(ATTR_KEYS.slice()).slice(0,2);
  const buyTimeItem = {id:'buytime', name:'购买时间', nameEn:'Buy Time +10s'};
  const cards = [
    dungeonItemCardHTML(buyTimeItem, 'p'),
    dungeonAttrCardHTML(attrs[0], 'p'),
    dungeonAttrCardHTML(attrs[1], 'p'),
  ];

  section.innerHTML = `
    <div class="dshop-section-header">
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="dshop-section-icon dshop-icon-p">P</span>
        <span class="dshop-section-label">分数交易</span>
      </div>
      <button class="dshop-reroll dshop-reroll-p" data-price="${dungeonRerollPrice('P')}" data-cur="P">⟳ ${dungeonRerollPrice('P')}P</button>
    </div>
    <div class="dshop-grid dshop-grid-3">
      ${cards.join('')}
    </div>
  `;
  dungeonBindCardClicks(section, 'p');
  dungeonBindRerollBtn(section);
  return section;
}

function dungeonRenderTSection(){
  const section = document.createElement('div');
  section.className = 'dshop-section dshop-section-t';

  const buyGoldItem = {id:'buygold', name:'购买金币', nameEn:'Buy Gold +3G'};
  const cards = [
    dungeonItemCardHTML(buyGoldItem, 't'),
    dungeonItemCardHTML(shuffle(ITEM_DEFS_TIME.slice())[0], 't'),
    dungeonItemCardHTML(shuffle(ITEM_DEFS_TIME.slice())[1]||ITEM_DEFS_TIME[0], 't'),
  ];

  section.innerHTML = `
    <div class="dshop-section-header">
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="dshop-section-icon dshop-icon-t">T</span>
        <span class="dshop-section-label">时间交易</span>
      </div>
      <button class="dshop-reroll dshop-reroll-t" data-price="${dungeonRerollPrice('T')}" data-cur="T">⟳ ${dungeonRerollPrice('T')}s</button>
    </div>
    <div class="dshop-grid dshop-grid-3">
      ${cards.join('')}
    </div>
  `;
  dungeonBindCardClicks(section, 't');
  dungeonBindRerollBtn(section);
  return section;
}

// 诅咒组合道具数据
const CURSE_COMBO_DEFS = [
  { itemId:'immortal', itemName:'不灭之心', itemNameEn:'Immortal Heart', curseKey:'fatigue',  curseName:'乏力',   curseNameEn:'Fatigue',   curses:1 },
  { itemId:'timelord', itemName:'时间领主', itemNameEn:'Time Lord',      curseKey:'shackle',  curseName:'镣铐',   curseNameEn:'Shackle',   curses:2 },
  { itemId:'essence',  itemName:'属性精华', itemNameEn:'Attr Essence',   curseKey:'illusion', curseName:'幻觉',   curseNameEn:'Illusion',  curses:1 },
  { itemId:'double',   itemName:'双倍积分', itemNameEn:'Double Score',   curseKey:'regret',   curseName:'后悔',   curseNameEn:'Regret',    curses:2 },
  { itemId:'immune',   itemName:'诅咒免疫', itemNameEn:'Curse Immune',   curseKey:'daze',     curseName:'恍惚',   curseNameEn:'Daze',      curses:3 },
];

// 诅咒组合卡片 HTML
function dungeonCurseCardHTML(combo){
  return `
    <div class="dcard dcard-curse" data-item="${combo.itemId}" data-curse="${combo.curseKey}" data-curses="${combo.curses}">
      <div class="dcard-inner">
      <div class="dcard-body dcard-body-curse">
        <div class="dcurse-half dcurse-item-half">
          <span class="dcurse-item-en">${combo.itemNameEn}</span>
          <span class="dcurse-item-cn">${combo.itemName}</span>
          <div class="dcurse-icon dcurse-item-icon"></div>
        </div>
        <div class="dcurse-half dcurse-curse-half">
          <div class="dcurse-icon dcurse-curse-icon"></div>
          <span class="dcurse-curse-cn">${combo.curseName}</span>
          <span class="dcurse-curse-en">${combo.curseNameEn}</span>
        </div>
      </div>
      </div>
    </div>`;
}

function dungeonRenderCSection(){
  const section = document.createElement('div');
  section.className = 'dshop-section dshop-section-c';

  const picks = shuffle(CURSE_COMBO_DEFS.slice()).slice(0, 2);
  const cards = picks.map(c => dungeonCurseCardHTML(c));

  section.innerHTML = `
    <div class="dshop-section-header">
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="dshop-section-icon dshop-icon-c">C</span>
        <span class="dshop-section-label">诅咒交易</span>
      </div>
    </div>
    <div class="dshop-grid dshop-grid-2">
      ${cards.join('')}
    </div>
  `;

  // 绑定点击
  section.querySelectorAll('.dcard-curse').forEach(card=>{
    card.addEventListener('click', ()=>{
      if(card.classList.contains('dcard-bought')) return;
      card.classList.add('dcard-bought');
      // 触发道具效果
      dungeonApplyItemEffect(card.dataset.item);
      // 附加对应诅咒
      const n = parseInt(card.dataset.curses) || 1;
      for(let i=0;i<n;i++) dungeonTriggerCurse();
      dungeonRenderStateArea();
    });
  });

  return section;
}

// 绑定刷新按钮点击（与卡片相同的负担判断逻辑）
function dungeonBindRerollBtn(section){
  const btn = section.querySelector('.dshop-reroll[data-price]');
  if(!btn) return;
  btn.addEventListener('click', ()=>{
    const price = parseInt(btn.dataset.price);
    const cur   = btn.dataset.cur;
    if(!dungeonCanAfford(price, cur)){
      dungeonPlayDullSound();
      return;
    }
    btn.classList.add('full-press');
    setTimeout(()=>{
      btn.classList.remove('full-press');
      dungeonDeductCost(price, cur);
      // 刷新本区域所有卡片（重新渲染 section）
      const grid = section.querySelector('.dshop-grid');
      if(!grid) return;
      const currency = cur.toLowerCase();
      let newCards = [];
      if(currency==='g'){
        const attrPool = shuffle(ATTR_KEYS.slice());
        newCards = [
          dungeonAttrCardHTML(attrPool[0],'g'),
          Math.random()<0.7?dungeonAttrCardHTML(attrPool[1],'g'):dungeonItemCardHTML(shuffle(ITEM_DEFS_LOW.slice())[0],'g'),
          Math.random()<0.4?dungeonAttrCardHTML(attrPool[2],'g'):dungeonItemCardHTML(shuffle(ITEM_DEFS_LOW.slice())[0],'g'),
          dungeonItemCardHTML(shuffle(ITEM_DEFS_LOW.slice())[0],'g'),
          Math.random()<0.6?dungeonItemCardHTML(shuffle(ITEM_DEFS_HIGH.slice())[0],'g'):dungeonItemCardHTML(shuffle(ITEM_DEFS_LOW.slice())[0],'g'),
          dungeonItemCardHTML(shuffle(ITEM_DEFS_HIGH.slice())[0],'g'),
        ];
      } else if(currency==='p'){
        const attrs = shuffle(ATTR_KEYS.slice()).slice(0,2);
        newCards = [dungeonItemCardHTML({id:'buytime',name:'购买时间',nameEn:'Buy Time +10s'},'p'),dungeonAttrCardHTML(attrs[0],'p'),dungeonAttrCardHTML(attrs[1],'p')];
      } else if(currency==='t'){
        const attrs = shuffle(ATTR_KEYS.slice()).slice(0,1);
        newCards = [dungeonItemCardHTML({id:'buygold',name:'购买金币',nameEn:'Buy Gold +3'},'t'),dungeonItemCardHTML(shuffle(ITEM_DEFS_TIME.slice())[0],'t'),dungeonAttrCardHTML(attrs[0],'t')];
      }
      grid.innerHTML = newCards.join('');
      dungeonBindCardClicks(section, currency);
      dungeonUpdateDisabledState();
    }, 120);
  });
}

// 实时更新商店内所有卡片和刷新按钮的可购买颜色状态
function dungeonUpdateDisabledState(){
  const area = document.getElementById('dungeonShopArea');
  if(!area) return;
  // 卡片：费用数字红/正常
  area.querySelectorAll('.dcard:not(.dcard-bought)').forEach(card=>{
    const price = parseInt(card.dataset.price);
    const cur   = card.dataset.cur;
    const numEl = card.querySelector('.dcard-cost-num');
    if(!numEl || !price || !cur) return;
    if(dungeonCanAfford(price, cur)){
      numEl.classList.remove('unaffordable');
    } else {
      numEl.classList.add('unaffordable');
    }
  });
  // 刷新按钮：文字红/正常
  area.querySelectorAll('.dshop-reroll[data-price]').forEach(btn=>{
    const price = parseInt(btn.dataset.price);
    const cur   = btn.dataset.cur;
    if(!price || !cur) return;
    if(dungeonCanAfford(price, cur)){
      btn.classList.remove('unaffordable');
    } else {
      btn.classList.add('unaffordable');
    }
  });
}

// 沉闷音效（低频短促，模拟"无法操作"）
function dungeonPlayDullSound(){
  if(typeof playSound!=='function') return;
  playSound(90, 0.12, 0.45);
}

// 绑定卡片点击购买
function dungeonBindCardClicks(section, currency){
  section.querySelectorAll('.dcard').forEach(card=>{
    card.addEventListener('click', ()=>{
      if(card.classList.contains('dcard-bought')) return;
      const price = parseInt(card.dataset.price);
      const cur   = card.dataset.cur;
      if(!dungeonCanAfford(price, cur)) {
        dungeonPlayDullSound();
        return;
      }
      dungeonDeductCost(price, cur);
      card.classList.add('dcard-bought');
      // 执行效果
      if(card.classList.contains('dcard-attr')){
        const attrKey = card.dataset.attr;
        D.buyCounts[attrKey] = (D.buyCounts[attrKey]||0) + 1;
        dungeonAddLevel(attrKey, 1);
        dungeonApplyCurseEffects();
        dungeonRenderStateArea();
      } else {
        const itemId = card.dataset.item;
        D.buyCounts[itemId] = (D.buyCounts[itemId]||0) + 1;
        dungeonApplyItemEffect(itemId);
        dungeonRenderStateArea();
      }
      // 购买后重新评估所有卡片可购买状态
      dungeonUpdateDisabledState();
    });
  });
}

function dungeonCanAfford(price, cur){
  if(typeof S==='undefined') return false;
  if(cur==='G') return D.gold >= price;
  if(cur==='P') return S.totalScore >= price;
  if(cur==='T') return S.timeLeft >= price;
  return false;
}

function dungeonDeductCost(price, cur){
  if(cur==='G') D.gold-=price, dungeonRenderGoldUI();
  if(cur==='P'){
    S.totalScore=Math.max(0,S.totalScore-price);
    const box=document.getElementById('soloScoreBox');
    if(box) box.innerHTML=S.totalScore+' <span style="font-size:0.6em">P</span>';
  }
  if(cur==='T'){
    S.timeLeft=Math.max(0,S.timeLeft-price);
    if(typeof soloUpdateTimerBar==='function') soloUpdateTimerBar();
  }
}

function dungeonApplyItemEffect(itemId){
  // 已登记道具统一走 Buff 系统（PASSIVE 子类 / INSTANT 父类各自处理）
  var t  = (typeof DungeonBuff!=='undefined') ? DungeonBuff.catalog() : {};
  var ic = t.item_config || {};
  if(ic[itemId]) DungeonBuff.addBuff(D, itemId);
  // 未登记的诅咒组合道具(immortal/timelord/...)本身无效果，效果由其附带诅咒实现
}

function dungeonCloseShop(){
  // Hide shop area
  const area = document.getElementById('dungeonShopArea');
  if(area){ area.style.display='none'; area.innerHTML=''; }

  // Restore game content
  const els = ['soloWordSection','soloStatus'];
  els.forEach(id=>{ const e=document.getElementById(id); if(e) e.style.display=''; });
  document.querySelector('#soloPanel .solo-cards-section').style.display='';
  document.querySelector('#soloPanel .solo-book-section').style.display='';
  document.querySelector('#soloPanel .solo-promo-area').style.display='';
  const stressBar = document.getElementById('dungeonStressBar');
  if(stressBar) stressBar.style.display='';

  // 0.3s buffer before restoring flow
  setTimeout(()=>{
    if(typeof S!=='undefined') S.globalFlowRate = D._savedGlobalFlow || 1;
  }, 300);

  // Resume game
  if(typeof S!=='undefined' && typeof soloSetupWord==='function'){
    soloSetupWord();
  }
}

// ===== UI渲染 =====

function dungeonRenderGoldUI(){
  let el = document.getElementById('dungeonGoldDisplay');
  if(!D.active){ if(el) el.style.display='none'; return; }
  if(!el){
    el = document.createElement('div');
    el.id = 'dungeonGoldDisplay';
    el.className = 'dungeon-gold';
    el.style.cssText = 'position:absolute;left:0;top:0;';
    el.innerHTML = '<span class="dgold-num"></span>G';
    // Insert into .solo-promo-area (left of stage bar)
    const promoArea = document.querySelector('#soloPanel .solo-promo-area');
    if(promoArea){
      promoArea.style.position = 'relative';
      promoArea.appendChild(el);
    }
  }
  el.style.display = '';
  // 同步所有金币数字（游戏内角标 + 商城头部）
  document.querySelectorAll('.dgold-num').forEach(e=>{ e.textContent = D.gold; });
}

function dungeonRenderStressBar(){
  let el = document.getElementById('dungeonStressBar');
  if(!D.active){ if(el) el.style.display='none'; return; }
  if(!el){
    el = document.createElement('div');
    el.id = 'dungeonStressBar';
    el.style.cssText = 'width:100%;max-width:600px;display:flex;align-items:center;gap:0;margin:4px auto 0;';
    el.innerHTML = `
      <span id="dungeonStressLabel" style="font-size:11px;font-weight:900;color:#400060;letter-spacing:0.08em;white-space:nowrap;padding:0 6px 0 0;flex-shrink:0;">STRESS</span>
      <div id="dungeonStressTrack" style="flex:1;height:18px;background:#e0e0e0;border:2px solid #fff;box-shadow:0 0 0 2px #400060;border-radius:9px;overflow:hidden;position:relative;">
        <div id="dungeonStressFill" style="height:100%;background:#9c27b0;width:0%;transition:width 0.3s;border-radius:0;"></div>
      </div>
    `;
    const passBtn = document.querySelector('#soloPanel .pass-btn');
    if(passBtn && passBtn.parentNode){
      passBtn.parentNode.insertBefore(el, passBtn.nextSibling);
    } else {
      const panel = document.getElementById('soloPanel');
      if(panel) panel.appendChild(el);
    }
  }
  el.style.display = '';
  const fill = document.getElementById('dungeonStressFill');
  if(fill) fill.style.width = Math.min(100, D.stress/D.stressThreshold*100)+'%';
}

function dungeonRenderStateArea(){
  const book = document.getElementById('soloBook');
  if(!book || !D.active) return;
  // 单词簿同款风格：纯文本标签，居左，无背景，无圆角
  let html = '<div style="font-size:10px;color:#999;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:4px;">STATE</div>';
  const buffs = D.buffs || [];
  // Attributes
  const attrEntries = buffs.filter(b=>b.category==='ATTR' && b.level>0);
  if(attrEntries.length>0){
    html += '<div style="display:flex;flex-wrap:wrap;gap:3px 8px;margin-bottom:4px;">';
    attrEntries.forEach(b=>{
      html += `<span style="font-size:12px;font-weight:900;color:#0d3172;">${ATTR_NAMES[b.buffId]||b.buffId}&thinsp;${b.level}</span>`;
    });
    html += '</div>';
  }
  // Curses
  const curseEntries = buffs.filter(b=>b.category==='CURSE' && b.level>0);
  if(curseEntries.length>0){
    html += '<div style="display:flex;flex-wrap:wrap;gap:3px 8px;margin-bottom:4px;">';
    curseEntries.forEach(b=>{
      html += `<span style="font-size:12px;font-weight:900;color:#400060;">${CURSE_DEFS[b.buffId]?.name||b.buffId}&thinsp;Lv.${b.level}</span>`;
    });
    html += '</div>';
  }
  // Passive items
  const itemEntries = buffs.filter(b=>b.category==='PASSIVE');
  if(itemEntries.length>0){
    const ic = ((typeof DungeonBuff!=='undefined') ? DungeonBuff.catalog() : {}).item_config || {};
    html += '<div style="display:flex;flex-wrap:wrap;gap:3px 8px;">';
    itemEntries.forEach(b=>{
      const nm = (ic[b.buffId] && ic[b.buffId].name) || b.buffId;
      html += `<span style="font-size:12px;font-weight:900;color:#1b4d28;">${nm}</span>`;
    });
    html += '</div>';
  }
  book.innerHTML = html;
}

function dungeonHideUI(){
  ['dungeonGoldDisplay','dungeonStressBar'].forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.style.display='none';
  });
}

// ===== 卡片交互（小丑牌式 3D 悬浮倾斜，事件委托，刷新后新卡自动生效） =====
const DTILT_SELECTOR = '.dcard';
const DTILT_MAX = 14;      // 最大倾斜角(度)
const DTILT_PERSP = 700;   // 透视距离(px)
function dungeonTiltTarget(el){
  // .dcard 变换其上层卡面 .dcard-inner（阴影板 ::before 保持静止）；按钮直接变换自身
  return el.classList.contains('dcard') ? (el.querySelector('.dcard-inner') || el) : el;
}
function dungeonTiltTransform(el, e, pressed){
  const tgt = dungeonTiltTarget(el);
  const r = el.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width  - 0.5; // -0.5..0.5
  const py = (e.clientY - r.top)  / r.height - 0.5;
  const rotY = px * DTILT_MAX * 2;
  const rotX = -py * DTILT_MAX * 2;
  const scale = pressed ? 0.95 : 1.06;
  const lift  = pressed ? 2 : -6;
  tgt.style.transition = 'transform 0s';
  tgt.style.transform =
    `perspective(${DTILT_PERSP}px) rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg) `+
    `scale(${scale}) translateY(${lift}px)`;
  el.style.zIndex = '5';
}
function dungeonTiltReset(el){
  const tgt = dungeonTiltTarget(el);
  tgt.style.transition = 'transform 0.35s cubic-bezier(.2,.8,.3,1.3)';
  tgt.style.transform = '';
  el.style.zIndex = '';
}
function dungeonApplyCardTilt(container){
  if(!container || container._dtiltBound) return;
  container._dtiltBound = true;
  container.addEventListener('pointermove', e=>{
    const el = e.target.closest(DTILT_SELECTOR);
    if(!el || !container.contains(el)) return;
    if(el.classList.contains('dcard-bought')) return;
    dungeonTiltTransform(el, e, el._dpressed);
  });
  container.addEventListener('pointerout', e=>{
    const el = e.target.closest(DTILT_SELECTOR);
    if(!el) return;
    // 仍在同一元素内部移动时 pointerout 会误触，排除之
    if(e.relatedTarget && el.contains(e.relatedTarget)) return;
    el._dpressed = false;
    dungeonTiltReset(el);
  });
  container.addEventListener('pointerdown', e=>{
    const el = e.target.closest(DTILT_SELECTOR);
    if(!el || el.classList.contains('dcard-bought')) return;
    el._dpressed = true;
    dungeonTiltTransform(el, e, true);
  });
  const release = e=>{
    const el = e.target.closest ? e.target.closest(DTILT_SELECTOR) : null;
    if(el && el._dpressed){
      el._dpressed = false;
      dungeonTiltTransform(el, e, false);
    }
  };
  container.addEventListener('pointerup', release);
}
const style = document.createElement('style');
style.textContent = `
@keyframes dungeonCurseFlash {
  0%{opacity:1} 100%{opacity:0}
}

/* ===== 地牢商城样式 ===== */
.dungeon-shop-area {
  width:100%;max-width:600px;
  flex:1;
  overflow-y:auto;
  display:flex;flex-direction:column;align-items:center;
  padding:10px 12px 20px;
  scrollbar-width:thin;
  scrollbar-color:transparent transparent;
}
.dungeon-shop-area:hover { scrollbar-color:rgba(0,0,0,0.2) transparent; }
.dungeon-shop-area::-webkit-scrollbar { width:4px; }
.dungeon-shop-area::-webkit-scrollbar-track { background:transparent; }
.dungeon-shop-area::-webkit-scrollbar-thumb { background:transparent;border-radius:4px; }
.dungeon-shop-area:hover::-webkit-scrollbar-thumb { background:rgba(0,0,0,0.2); }

/* ===== 商店 Header ===== */
.dshop-header {
  width:100%;max-width:600px;
  display:flex;justify-content:center;align-items:center;
  margin-bottom:14px;position:relative;
}
.dshop-title {
  font-size:20px;font-weight:900;color:#111;
  text-transform:uppercase;letter-spacing:0.08em;
  border-bottom:4px solid #111;padding-bottom:2px;
}
.dungeon-gold {
  display:inline-flex;align-items:center;
  padding:3px 12px;
  background:#ffc107;border:3px solid #6b4500;border-radius:10px;
  font-size:16px;font-weight:900;color:#3d2800;line-height:1;
}
.dshop-header-gold { position:absolute;left:0;top:50%;transform:translateY(-50%); }

/* ===== 交易区块 ===== */
.dshop-section {
  width:100%;max-width:600px;
  border-radius:0;padding:12px;margin-bottom:10px;
  border:3px solid #111;
  background:#fff;
}
.dshop-section-g { background:#fffbe6; border-color:#6b4500; }
.dshop-section-p { background:#e8f4fd; border-color:#0d3172; }
.dshop-section-t { background:#e8f7e8; border-color:#1b4d28; }
.dshop-section-c { background:#f9f0fc; border-color:#400060; }

.dshop-section-header {
  display:flex;align-items:center;gap:8px;margin-bottom:10px;
  justify-content:space-between;
}
.dshop-section-icon {
  width:26px;height:26px;border-radius:0;
  display:flex;align-items:center;justify-content:center;
  font-size:13px;font-weight:900;
  border:2px solid #3a3a3a;
}
.dshop-section-g .dshop-section-icon { border-color:#6b4500; }
.dshop-section-p .dshop-section-icon { border-color:#0d3172; }
.dshop-section-t .dshop-section-icon { border-color:#1b4d28; }
.dshop-section-c .dshop-section-icon { border-color:#400060; }
.dshop-icon-g { background:#ffc107;color:#111; }
.dshop-icon-p { background:#2178d2;color:#fff; }
.dshop-icon-t { background:#4caf50;color:#fff; }
.dshop-icon-c { background:#9c27b0;color:#fff; }
.dshop-section-label { font-size:14px;font-weight:900;color:#111;text-transform:uppercase;letter-spacing:0.05em; }

.dshop-reroll {
  padding:5px 10px;border-radius:0;
  border:2px solid #3a3a3a;
  background:#fff;color:#111;font-size:12px;font-weight:900;
  box-shadow:3px 3px 0 0 #3a3a3a;
  cursor:pointer;transition:box-shadow 0.12s,transform 0.12s;
}
.dshop-reroll:hover,
.dshop-reroll:active { box-shadow:1px 1px 0 0 #3a3a3a; transform:translate(1px,1px); }
.dshop-reroll.full-press { box-shadow:none !important; transform:translate(3px,3px) !important; }
.dshop-reroll-g { background:#ffc107; border-color:#6b4500; box-shadow:3px 3px 0 0 #6b4500; }
.dshop-reroll-g:hover,.dshop-reroll-g:active { box-shadow:1px 1px 0 0 #6b4500; }
.dshop-reroll-p { background:#64b5f6; border-color:#0d3172; box-shadow:3px 3px 0 0 #0d3172; }
.dshop-reroll-p:hover,.dshop-reroll-p:active { box-shadow:1px 1px 0 0 #0d3172; }
.dshop-reroll-t { background:#81c784; border-color:#1b4d28; box-shadow:3px 3px 0 0 #1b4d28; }
.dshop-reroll-t:hover,.dshop-reroll-t:active { box-shadow:1px 1px 0 0 #1b4d28; }

/* ===== 卡片网格 ===== */
.dshop-grid {
  display:grid;gap:8px;
}
.dshop-grid-6 { grid-template-columns:repeat(3,1fr); }
.dshop-grid-3 { grid-template-columns:repeat(3,1fr); }
.dshop-grid-2 { grid-template-columns:repeat(2,1fr); }

/* ===== 商品卡片 ===== */
/* .dcard = 外层定位槽（透明），::before = 下层静止阴影板，.dcard-inner = 上层卡面(3D倾斜目标) */
.dcard {
  position:relative;
  min-height:90px;
  cursor:pointer;
  user-select:none;
}
.dcard::before {
  content:'';
  position:absolute;
  left:0;right:0;top:0;bottom:0;
  background:#3a3a3a;
  transform:translateY(4px);
  transition:transform 0.12s;
  z-index:0;
}
.dcard-inner {
  position:relative;
  z-index:1;
  min-height:90px;
  height:100%;
  width:100%;
  background:#fff;
  border:3px solid #3a3a3a;
  border-radius:0;
  overflow:hidden;
  display:flex;flex-direction:column;
  transform-origin:center center;
  will-change:transform;
  backface-visibility:hidden;
}
/* 悬浮/点击的卡面位移与倾斜由 JS(dungeonApplyCardTilt) 接管；阴影板随状态加深/压平 */
.dcard:hover::before  { transform:translateY(6px); }
.dcard:active::before { transform:translateY(1px); }
.dcard.dcard-bought   { pointer-events:none; }
.dcard.dcard-bought::before { transform:translateY(1px); }
.dcard.dcard-bought .dcard-inner { opacity:0.4;filter:grayscale(0.6); }
/* 各区块颜色：阴影板 + 卡面描边 */
.dshop-section-g .dcard::before   { background:#6b4500; }
.dshop-section-g .dcard-inner     { border-color:#6b4500; }
.dshop-section-p .dcard::before   { background:#0d3172; }
.dshop-section-p .dcard-inner     { border-color:#0d3172; }
.dshop-section-t .dcard::before   { background:#1b4d28; }
.dshop-section-t .dcard-inner     { border-color:#1b4d28; }
.dshop-section-c .dcard::before   { background:#400060; }
.dshop-section-c .dcard-inner     { border-color:#400060; }

/* ---- 属性升级卡体 ---- */
.dcard-body {
  flex:1;padding:7px 8px 4px;
  display:flex;flex-direction:column;justify-content:space-between;
}
.dcard-row-top {
  display:flex;justify-content:space-between;align-items:flex-start;
}
.dcard-cn  { font-size:15px;font-weight:900;color:#111;line-height:1.2;text-transform:uppercase; }
.dcard-en  { font-size:10px;color:#555;line-height:1.2;text-align:right;font-weight:700; }
.dcard-row-lv {
  display:flex;align-items:flex-end;gap:0;
  margin-top:2px;
}
.dcard-lv-cur  { font-size:13px;font-weight:900;color:#555;line-height:1; }
.dcard-arrow {
  flex:1;min-width:14px;height:20px;
  background:#ffc107;
  clip-path:polygon(0% 100%, 100% 0%, 100% 100%);
  margin:0 4px;align-self:flex-end;
  border:none;
}
.dcard-lv-next { font-size:28px;font-weight:900;color:#111;line-height:1; }

/* ---- 道具卡体 ---- */
.dcard-body-item {
  flex-direction:row !important;align-items:stretch;padding:7px 8px 4px;
}
.dcard-item-text { flex:1;display:flex;flex-direction:column;justify-content:space-between; }
.dcard-item-en   { font-size:10px;color:#555;line-height:1.3;font-weight:700; }
.dcard-item-cn   { font-size:16px;font-weight:900;color:#111;line-height:1.2; }
.dcard-item-icon {
  width:34px;height:34px;align-self:center;flex-shrink:0;
  background:#f0f0f0;border-radius:0;
  border:2px solid #111;
  margin-left:6px;
}

/* ---- 费用条 ---- */
.dcard-cost {
  display:flex;align-items:center;justify-content:flex-end;gap:6px;
  padding:5px 10px;
  border-top:3px solid #111;
  background:#f0f0f0;
  font-weight:900;
}
.dcard-cost-num { font-size:15px;color:#111;transition:color 0.15s; }
.dcard-cost-num.unaffordable { color:#e53935; }
/* 刷新按钮不可负担时数字红色 */
.dshop-reroll.unaffordable { color:#e53935 !important; }
.dcard-cost-unit { font-size:15px; }
.dcard-cost-g { background:#fff3cd;border-top-color:#111; }
.dcard-cost-g .dcard-cost-unit { color:#7a5900; }
.dcard-cost-p { background:#dceefb;border-top-color:#111; }
.dcard-cost-p .dcard-cost-unit { color:#0d47a1; }
.dcard-cost-t { background:#d9f2d9;border-top-color:#111; }
.dcard-cost-t .dcard-cost-unit { color:#1b5e20; }
.dcard-cost-c { background:#f3e5f5;border-top-color:#111; }
.dcard-cost-c .dcard-cost-unit { color:#4a148c; }

/* ---- 诅咒组合卡 ---- */
.dcard-body-curse {
  position:relative;display:block;
  padding:0;overflow:hidden;
  flex:1;min-height:68px;
}
.dcurse-half {
  position:absolute;top:0;left:0;width:100%;height:100%;
  padding:6px 8px;
  display:flex;flex-direction:column;justify-content:space-between;
}
.dcurse-item-half {
  clip-path:polygon(0% 0%, 62% 0%, 38% 100%, 0% 100%);
  background:#fff;align-items:flex-start;
}
.dcurse-curse-half {
  clip-path:polygon(62% 0%, 100% 0%, 100% 100%, 38% 100%);
  background:#f3e5f5;align-items:flex-end;text-align:right;
}
.dcurse-item-en  { font-size:10px;color:#555;line-height:1.2;max-width:55%;font-weight:700; }
.dcurse-item-cn  { font-size:15px;font-weight:900;color:#111;line-height:1.2;max-width:55%; }
.dcurse-curse-cn { font-size:15px;font-weight:900;color:#4a148c;line-height:1.2;max-width:55%; }
.dcurse-curse-en { font-size:10px;color:#7b1fa2;line-height:1.2;max-width:55%;font-weight:700; }
.dcurse-icon {
  width:28px;height:28px;
  border-radius:0;background:#e0e0e0;flex-shrink:0;
  border:2px solid #111;
}

/* ===== 继续按钮 ===== */
.dshop-footer { margin-top:14px;text-align:center; }
.dshop-continue {
  padding:10px 32px;font-size:15px;
  border:2px solid #3a3a3a;border-radius:0;
  color:#111;cursor:pointer;font-weight:900;
  background:#fff;
  box-shadow:3px 3px 0 0 #3a3a3a;
  transition:box-shadow 0.12s,transform 0.12s;
}
.dshop-continue:hover {
  box-shadow:1px 1px 0 0 #3a3a3a;
  transform:translate(1px,1px);
  background:#f0f0f0;
}
.dshop-continue:active {
  box-shadow:none;
  transform:translate(3px,3px);
}
`;
document.head.appendChild(style);

// ===== Shuffle helper =====
function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];}
  return arr;
}

// ===== 暴露全局接口供主文件调用 =====
window.Dungeon = {
  state: D,
  cfg: DUNGEON_CFG,
  init: dungeonInit,
  reset: dungeonReset,
  isActive: isDungeonActive,
  addStress: dungeonAddStress,
  addGold: dungeonAddGold,
  checkBoss: dungeonCheckBoss,
  enterBoss: dungeonEnterBoss,
  exitBoss: dungeonExitBoss,
  shouldShowShop: dungeonShouldShowShop,
  openShop: dungeonOpenShop,
  getFlowRateMultiplier: dungeonGetFlowRateMultiplier,
  brvMitigate: dungeonBrvMitigate,
  getPromoScoreBonus: dungeonGetPromoScoreBonus,
  getShinyBonus: dungeonGetShinyBonus,
  getFatigueReduction: dungeonGetFatigueReduction,
  applyRegret: dungeonApplyRegret,
  renderStateArea: dungeonRenderStateArea,
};

})();
