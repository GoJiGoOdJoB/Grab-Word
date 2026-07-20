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
  // 属性系统
  attrs: { str:0, wis:0, brv:0, end:0, dex:0, luk:0 },
  // 货币
  gold: 0,
  // 压力系统
  stress: 0,
  stressThreshold: 40,
  stressTriggerCount: 0,
  wrongCountSession: 0, // 本题错牌累计(用于压力计算)
  // 诅咒
  curses: {}, // {curseName: level}
  tempCurses: [], // boss关临时诅咒
  // 道具
  items: [], // [{id, name, effect, duration, remaining}]
  // 强化环节
  shopVisitCount: 0,
  timeBuyCount: 0, // P交易购买时间次数(跨轮累计)
  goldBuyCount: 0, // T交易购买金币次数(不跨轮)
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
  attrPriceBase: 3,
  attrPriceLevelCoeff: 1.5,
  attrPriceStageCoeff: 1.2,
  timeBuyPriceBase: 15,
  timeBuyCountCoeff: 1.3,
  timeBuyStageCoeff: 1.1,
  goldBuyPriceBase: 5,
  goldBuyCountCoeff: 1.4,
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

function getAttrEffect(key, level){
  if(level<=0) return 0;
  switch(key){
    case 'str': return 0.05 + level*0.03; // 段位积分额外比例
    case 'wis': return Math.min(0.5, level*0.05); // 流速降低比例
    case 'brv': return Math.min(0.6, level*0.08); // 惩罚降低比例
    case 'end': return Math.min(0.6, level*0.07); // 压力累积降低比例
    case 'dex': return level*0.02; // 炫彩概率加成
    case 'luk': return level*0.05; // 品质/诅咒运气加成
    default: return 0;
  }
}

// ===== 核心机制 =====

// 初始化地牢模式
function dungeonInit(){
  D.active = true;
  D.attrs = { str:0, wis:0, brv:0, end:0, dex:0, luk:0 };
  D.gold = 0;
  D.stress = 0;
  D.stressThreshold = DUNGEON_CFG.stressThresholdBase;
  D.stressTriggerCount = 0;
  D.wrongCountSession = 0;
  D.curses = {};
  D.tempCurses = [];
  D.items = [];
  D.shopVisitCount = 0;
  D.timeBuyCount = 0;
  D.goldBuyCount = 0;
  D.bossActive = false;
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
  const endReduction = getAttrEffect('end', D.attrs.end);
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
    return (D.curses[k]||0) < def.maxLv;
  });
  if(available.length===0) return; // 所有诅咒满级
  const luk = getAttrEffect('luk', D.attrs.luk);
  // 运气降低高层诅咒概率(简化：运气越高越倾向选已有等级低的)
  const picked = available[Math.floor(Math.random()*available.length)];
  D.curses[picked] = (D.curses[picked]||0) + 1;
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
    return (D.curses[k]||0) < def.maxLv;
  });
  if(available.length>0){
    const picked = available[Math.floor(Math.random()*available.length)];
    D.tempCurses.push({key:picked});
    D.curses[picked] = (D.curses[picked]||0) + 1;
    dungeonApplyCurseEffects();
    dungeonRenderStateArea();
  }
  // 段位积分条外框变红
  const promoBar = document.querySelector('.solo-promo-bar');
  if(promoBar) promoBar.style.border = '2px solid #e53935';
}

function dungeonExitBoss(){
  D.bossActive = false;
  // 移除临时诅咒
  D.tempCurses.forEach(tc=>{
    if(D.curses[tc.key] && D.curses[tc.key]>0){
      D.curses[tc.key]--;
      if(D.curses[tc.key]===0) delete D.curses[tc.key];
    }
  });
  D.tempCurses = [];
  dungeonApplyCurseEffects();
  dungeonRenderStateArea();
  // 恢复积分条外框
  const promoBar = document.querySelector('.solo-promo-bar');
  if(promoBar) promoBar.style.border = '';
  // Boss额外金币
  dungeonAddGold(DUNGEON_CFG.goldPerBoss);
}

// ===== 属性效果应用 =====

// 流速修正(智慧)
function dungeonGetFlowRateMultiplier(){
  if(!D.active) return 1;
  return Math.max(0.3, 1 - getAttrEffect('wis', D.attrs.wis));
}

// 惩罚修正(勇气)
function dungeonGetPenaltyMultiplier(){
  if(!D.active) return 1;
  return Math.max(0.2, 1 - getAttrEffect('brv', D.attrs.brv));
}

// 段位积分额外加成(力量)
function dungeonGetPromoScoreBonus(baseScore){
  if(!D.active) return 0;
  return Math.round(baseScore * getAttrEffect('str', D.attrs.str));
}

// 炫彩概率加成(技巧)
function dungeonGetShinyBonus(){
  if(!D.active) return 0;
  return getAttrEffect('dex', D.attrs.dex);
}

// ===== 诅咒效果应用 =====

function dungeonApplyCurseEffects(){
  // 镣铐: 增加答题流速
  const shackleLv = D.curses.shackle || 0;
  if(typeof S!=='undefined' && D.active){
    // Store dungeon flow penalty for main loop to read
    D._shackleFlowBonus = shackleLv * 0.1;
  }
}

// 乏力: 段位积分累计降低
function dungeonGetFatigueReduction(){
  const fatigueLv = D.curses.fatigue || 0;
  if(fatigueLv===0) return 0;
  return Math.min(0.8, 0.15 + (fatigueLv-1)*0.10);
}

// 后悔: 连击中断额外扣分/扣时间
function dungeonApplyRegret(){
  const regretLv = D.curses.regret || 0;
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
  D.goldBuyCount = 0;
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

  // 悬浮拨动效果
  dungeonApplyCardTilt(area);
}

// ===== 商品卡片 HTML 生成 =====

// 属性升级卡片
// currency: 'g'|'p'|'t'
function dungeonAttrCardHTML(attrKey, currency){
  const cnName  = ATTR_NAMES[attrKey];
  const enName  = {str:'Strength',wis:'Wisdom',brv:'Bravery',end:'Endurance',dex:'Dexterity',luk:'Luck'}[attrKey];
  const curLv   = D.attrs[attrKey];
  const nextLv  = curLv + 1;
  const price   = Math.round(
    DUNGEON_CFG.attrPriceBase
    * Math.pow(DUNGEON_CFG.attrPriceLevelCoeff, curLv)
    * Math.pow(DUNGEON_CFG.attrPriceStageCoeff, Math.floor((typeof S!=='undefined'?S.stageIdx:0)/3))
  );
  const cur     = currency.toUpperCase();
  return `
    <div class="dcard dcard-attr" data-attr="${attrKey}" data-price="${price}" data-cur="${cur}">
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
    </div>`;
}

// 道具卡片
function dungeonItemCardHTML(itemDef, currency){
  const cur = currency.toUpperCase();
  return `
    <div class="dcard dcard-item" data-item="${itemDef.id}" data-price="${itemDef.price}" data-cur="${cur}">
      <div class="dcard-body dcard-body-item">
        <div class="dcard-item-text">
          <span class="dcard-item-en">${itemDef.nameEn||itemDef.id}</span>
          <span class="dcard-item-cn">${itemDef.name}</span>
        </div>
        <div class="dcard-item-icon"></div>
      </div>
      <div class="dcard-cost dcard-cost-${cur.toLowerCase()}">
        <span class="dcard-cost-num">${itemDef.price}</span>
        <span class="dcard-cost-unit">${cur}</span>
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
      <button class="dshop-reroll dshop-reroll-g">⟳ 2G</button>
    </div>
    <div class="dshop-grid dshop-grid-6">
      ${cards.join('')}
    </div>
  `;
  dungeonBindCardClicks(section, 'g');
  return section;
}

function dungeonRenderPSection(){
  const section = document.createElement('div');
  section.className = 'dshop-section dshop-section-p';

  const attrs = shuffle(ATTR_KEYS.slice()).slice(0,2);
  const timePrice = Math.round(
    DUNGEON_CFG.timeBuyPriceBase
    * Math.pow(DUNGEON_CFG.timeBuyCountCoeff, D.timeBuyCount)
    * Math.pow(DUNGEON_CFG.timeBuyStageCoeff, Math.floor((typeof S!=='undefined'?S.stageIdx:0)/3))
  );
  const buyTimeItem = {id:'buytime', name:'购买时间', nameEn:'Buy Time +10s', price:timePrice};
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
      <button class="dshop-reroll dshop-reroll-p">⟳ 15P</button>
    </div>
    <div class="dshop-grid dshop-grid-3">
      ${cards.join('')}
    </div>
  `;
  dungeonBindCardClicks(section, 'p');
  return section;
}

function dungeonRenderTSection(){
  const section = document.createElement('div');
  section.className = 'dshop-section dshop-section-t';

  const goldPrice = Math.round(DUNGEON_CFG.goldBuyPriceBase * Math.pow(DUNGEON_CFG.goldBuyCountCoeff, D.goldBuyCount));
  const buyGoldItem = {id:'buygold', name:'购买金币', nameEn:'Buy Gold +3G', price:goldPrice};
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
      <button class="dshop-reroll dshop-reroll-t">⟳ 5s</button>
    </div>
    <div class="dshop-grid dshop-grid-3">
      ${cards.join('')}
    </div>
  `;
  dungeonBindCardClicks(section, 't');
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

// 绑定卡片点击购买
function dungeonBindCardClicks(section, currency){
  section.querySelectorAll('.dcard').forEach(card=>{
    card.addEventListener('click', ()=>{
      if(card.classList.contains('dcard-bought')) return;
      const price = parseInt(card.dataset.price);
      const cur   = card.dataset.cur;
      if(!dungeonCanAfford(price, cur)) {
        // 抖动效果
        card.classList.remove('dcard-shake');
        void card.offsetWidth;
        card.classList.add('dcard-shake');
        card.addEventListener('animationend', ()=>card.classList.remove('dcard-shake'), {once:true});
        return;
      }
      dungeonDeductCost(price, cur);
      card.classList.add('dcard-bought');
      // 执行效果
      if(card.classList.contains('dcard-attr')){
        const attrKey = card.dataset.attr;
        D.attrs[attrKey]++;
        dungeonApplyCurseEffects();
        dungeonRenderStateArea();
      } else {
        dungeonApplyItemEffect(card.dataset.item);
        dungeonRenderStateArea();
      }
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
  if(cur==='P') S.totalScore=Math.max(0,S.totalScore-price);
  if(cur==='T') S.timeLeft=Math.max(0,S.timeLeft-price);
}

function dungeonApplyItemEffect(itemId){
  switch(itemId){
    case 'shield':   D.items.push({id:'shield',   remaining:3}); break;
    case 'focus':    D.items.push({id:'focus',    remaining:1}); break;
    case 'insight':  D.items.push({id:'insight',  remaining:1}); break;
    case 'goldpot':  D.items.push({id:'goldpot',  remaining:1}); break;
    case 'purify': {
      const keys=Object.keys(D.curses);
      if(keys.length){ const k=keys[Math.floor(Math.random()*keys.length)]; D.curses[k]--; if(D.curses[k]<=0) delete D.curses[k]; dungeonApplyCurseEffects(); }
      break;
    }
    case 'lucky':    D.items.push({id:'lucky',    remaining:1}); break;
    case 'slowdown': D.items.push({id:'slowdown', remaining:999}); break;
    case 'buytime':  if(typeof S!=='undefined'){S.timeLeft+=10; D.timeBuyCount++;} break;
    case 'buygold':  D.gold+=3; D.goldBuyCount++; dungeonRenderGoldUI(); break;
    case 'rewind':   D.items.push({id:'rewind',   remaining:1}); break;
    case 'medkit':   D.items.push({id:'medkit',   remaining:1}); break;
  }
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
    el.style.cssText = 'position:absolute;left:0;top:0;padding:4px 10px;background:#fff3cd;border:2px solid #ffc107;border-radius:8px;font-size:14px;font-weight:bold;color:#856404;';
    // Insert into .solo-promo-area (left of stage bar)
    const promoArea = document.querySelector('#soloPanel .solo-promo-area');
    if(promoArea){
      promoArea.style.position = 'relative';
      promoArea.appendChild(el);
    }
  }
  el.style.display = '';
  el.textContent = D.gold + 'G';
}

function dungeonRenderStressBar(){
  let el = document.getElementById('dungeonStressBar');
  if(!D.active){ if(el) el.style.display='none'; return; }
  if(!el){
    el = document.createElement('div');
    el.id = 'dungeonStressBar';
    el.style.cssText = 'width:90%;max-width:320px;height:8px;background:#333;border-radius:4px;margin:6px auto 0;position:relative;overflow:hidden;';
    el.innerHTML = '<div id="dungeonStressFill" style="height:100%;background:linear-gradient(90deg,#7b1fa2,#e040fb);width:0;transition:width 0.3s;border-radius:4px;"></div>';
    // Insert after pass button
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
  // Replace wordbook with state area in dungeon mode
  const book = document.getElementById('soloBook');
  if(!book || !D.active) return;
  let html = '<div style="font-size:11px;color:#999;margin-bottom:4px;">状态 (STATE)</div>';
  // Attributes
  html += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;">';
  ATTR_KEYS.forEach(k=>{
    if(D.attrs[k]>0) html += `<span style="padding:2px 6px;background:rgba(33,120,210,0.1);border-radius:4px;font-size:11px;color:#2178d2;">${ATTR_NAMES[k]} ${D.attrs[k]}</span>`;
  });
  html += '</div>';
  // Curses
  if(Object.keys(D.curses).length>0){
    html += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;">';
    Object.entries(D.curses).forEach(([k,lv])=>{
      if(lv>0) html += `<span style="padding:2px 6px;background:rgba(156,39,176,0.1);border-radius:4px;font-size:11px;color:#9c27b0;">${CURSE_DEFS[k]?.name||k} Lv.${lv}</span>`;
    });
    html += '</div>';
  }
  // Items
  if(D.items.length>0){
    html += '<div style="display:flex;flex-wrap:wrap;gap:4px;">';
    D.items.forEach(it=>{
      html += `<span style="padding:2px 6px;background:rgba(76,175,80,0.1);border-radius:4px;font-size:11px;color:#4caf50;">${it.id}</span>`;
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

// ===== 卡片3D悬浮拨动交互 =====
function dungeonApplyCardTilt(container){
  const MAX_TILT = 14;

  function applyTilt(card, cx, cy){
    const rect = card.getBoundingClientRect();
    const x = (cx - rect.left) / rect.width  - 0.5;
    const y = (cy - rect.top)  / rect.height - 0.5;
    card.style.transition = 'box-shadow 0.25s, border-color 0.15s';
    card.style.transform = `perspective(600px) rotateX(${-y*MAX_TILT}deg) rotateY(${x*MAX_TILT}deg) translateY(-4px) scale(1.02)`;
  }

  function resetTilt(card){
    card.style.transition = 'transform 0.3s ease, box-shadow 0.25s, border-color 0.15s';
    card.style.transform = 'perspective(600px) translateY(-2px)';
  }

  // 鼠标移动时倾斜
  container.addEventListener('mousemove', e=>{
    const card = e.target.closest('.dcard:not(.dcard-bought)');
    if(!card) return;
    applyTilt(card, e.clientX, e.clientY);
  });

  // 鼠标离开时复位（委托到每张卡片）
  container.addEventListener('mouseleave', e=>{
    const card = e.target.closest?.('.dcard:not(.dcard-bought)');
    if(card) resetTilt(card);
  }, true);

  // 触摸滑动倾斜
  container.addEventListener('touchmove', e=>{
    const t = e.touches[0];
    const card = document.elementFromPoint(t.clientX, t.clientY)?.closest('.dcard:not(.dcard-bought)');
    if(card) applyTilt(card, t.clientX, t.clientY);
  }, {passive:true});

  container.addEventListener('touchend', ()=>{
    container.querySelectorAll('.dcard:not(.dcard-bought)').forEach(c=>resetTilt(c));
  }, {passive:true});
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
.dshop-header {
  width:100%;max-width:600px;
  display:flex;justify-content:center;align-items:center;
  margin-bottom:12px;
}
.dshop-title { font-size:18px;font-weight:bold;color:#333; }

.dshop-section {
  width:100%;max-width:600px;
  border-radius:12px;padding:12px;margin-bottom:10px;
  border:2px solid #ddd;
  background:#fff;
}
.dshop-section-g { border-color:#ffc107; }
.dshop-section-p { border-color:#64b5f6; }
.dshop-section-t { border-color:#81c784; }
.dshop-section-c { border-color:#ce93d8; }

.dshop-section-header {
  display:flex;align-items:center;gap:8px;margin-bottom:10px;
  justify-content:space-between;
}
.dshop-section-icon {
  width:26px;height:26px;border-radius:50%;
  display:flex;align-items:center;justify-content:center;
  font-size:13px;font-weight:bold;
}
.dshop-icon-g { background:#ffc107;color:#fff; }
.dshop-icon-p { background:#2178d2;color:#fff; }
.dshop-icon-t { background:#4caf50;color:#fff; }
.dshop-icon-c { background:#9c27b0;color:#fff; }
.dshop-section-label { font-size:14px;font-weight:bold;color:#333; }
.dshop-reroll {
  padding:4px 10px;border-radius:8px;border:1.5px solid #ddd;
  background:#f8f8f8;color:#666;font-size:12px;font-weight:bold;
  cursor:pointer;transition:all 0.2s;
}
.dshop-reroll:hover { border-color:#999;color:#333; }
.dshop-reroll-g { border-color:#ffc107;color:#b8860b; }
.dshop-reroll-p { border-color:#64b5f6;color:#2178d2; }
.dshop-reroll-t { border-color:#81c784;color:#388e3c; }

.dshop-grid {
  display:grid;gap:8px;
}
.dshop-grid-6 { grid-template-columns:repeat(3,1fr); }
.dshop-grid-3 { grid-template-columns:repeat(3,1fr); }
.dshop-grid-2 { grid-template-columns:repeat(2,1fr); }

.dshop-slot {
  min-height:90px;
  border:2px solid #e0e0e0;border-radius:10px;
  background:#fafafa;
  cursor:pointer;transition:all 0.2s;
}
.dshop-slot:hover { border-color:#999; }

/* ===== 商品卡片 ===== */
.dcard {
  border:2px solid #e0e0e0;border-radius:10px;
  background:#fff;overflow:hidden;
  cursor:pointer;
  display:flex;flex-direction:column;
  min-height:90px;
  user-select:none;
  transform: perspective(600px) translateY(-2px);
  box-shadow: 0 3px 8px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.05);
  transition: box-shadow 0.25s, transform 0.15s, border-color 0.15s;
  will-change: transform;
}
.dcard:hover { border-color:#bbb; box-shadow:0 5px 14px rgba(0,0,0,0.11), 0 2px 5px rgba(0,0,0,0.07); }
.dcard.dcard-bought {
  opacity:0.4;pointer-events:none;
  transform:perspective(600px) translateY(3px) !important;
  box-shadow:none !important;
  filter:grayscale(0.3);
}
.dcard.dcard-shake { animation:dcardShake 0.35s ease; }
@keyframes dcardShake {
  0%,100% { transform:perspective(600px) translateY(-2px) translateX(0); }
  20%      { transform:perspective(600px) translateY(-2px) translateX(-6px); }
  40%      { transform:perspective(600px) translateY(-2px) translateX(6px); }
  60%      { transform:perspective(600px) translateY(-2px) translateX(-4px); }
  80%      { transform:perspective(600px) translateY(-2px) translateX(4px); }
}

/* ---- 属性升级卡 ---- */
.dcard-body {
  flex:1;padding:7px 8px 4px;
  display:flex;flex-direction:column;justify-content:space-between;
}
.dcard-row-top {
  display:flex;justify-content:space-between;align-items:flex-start;
}
.dcard-cn  { font-size:15px;font-weight:bold;color:#222;line-height:1.2; }
.dcard-en  { font-size:10px;color:#888;line-height:1.2;text-align:right; }
.dcard-row-lv {
  display:flex;align-items:flex-end;gap:0;
  margin-top:2px;
}
.dcard-lv-cur  { font-size:13px;font-weight:900;color:#555;line-height:1; }
.dcard-arrow {
  flex:1;min-width:14px;height:20px;
  background:#f9a825;
  clip-path:polygon(0% 100%, 100% 0%, 100% 100%);
  margin:0 4px;align-self:flex-end;
}
.dcard-lv-next { font-size:28px;font-weight:900;color:#111;line-height:1; }

/* ---- 道具卡 ---- */
.dcard-body-item {
  flex-direction:row !important;align-items:stretch;padding:7px 8px 4px;
}
.dcard-item-text { flex:1;display:flex;flex-direction:column;justify-content:space-between; }
.dcard-item-en   { font-size:10px;color:#666;line-height:1.3; }
.dcard-item-cn   { font-size:16px;font-weight:bold;color:#111;line-height:1.2; }
.dcard-item-icon {
  width:34px;height:34px;align-self:center;flex-shrink:0;
  background:#ddd;border-radius:6px;margin-left:6px;
}

/* ---- 费用条 ---- */
.dcard-cost {
  display:flex;align-items:center;justify-content:flex-end;gap:6px;
  padding:5px 10px;
  border:2px solid #e0e0e0;border-radius:0 0 8px 8px;
  border-top:none;background:#fafafa;font-weight:bold;
}
.dcard-cost-num { font-size:15px;color:#333; }
.dcard-cost-unit { font-size:15px; }
/* zone colors */
.dcard-cost-g { border-color:#ffc107; background:#fff3cd; }
.dcard-cost-g .dcard-cost-unit { color:#b8860b; }
.dcard-cost-p { border-color:#64b5f6; background:#e0f0fd; }
.dcard-cost-p .dcard-cost-unit { color:#2178d2; }
.dcard-cost-t { border-color:#81c784; background:#e6f4e6; }
.dcard-cost-t .dcard-cost-unit { color:#388e3c; }
.dcard-cost-c { border-color:#ce93d8; background:#f5e9f7; }

/* ---- 诅咒组合卡 ---- */
.dcard-body-curse {
  position:relative;
  display:block;
  padding:0;
  overflow:hidden;
  flex:1;
  min-height:68px;
}
.dcurse-half {
  position:absolute;
  top:0;left:0;width:100%;height:100%;
  padding:6px 8px;
  display:flex;flex-direction:column;justify-content:space-between;
}
/* 左上→右下 斜切：左侧道具区 */
.dcurse-item-half {
  clip-path:polygon(0% 0%, 62% 0%, 38% 100%, 0% 100%);
  background:#fff;
  align-items:flex-start;
}
/* 右上→左下 斜切：右侧诅咒区 */
.dcurse-curse-half {
  clip-path:polygon(62% 0%, 100% 0%, 100% 100%, 38% 100%);
  background:#f5e9f7;
  align-items:flex-end;
  text-align:right;
}
.dcurse-item-en  { font-size:10px;color:#666;line-height:1.2;max-width:55%; }
.dcurse-item-cn  { font-size:15px;font-weight:bold;color:#111;line-height:1.2;max-width:55%; }
.dcurse-curse-cn { font-size:15px;font-weight:bold;color:#7b1fa2;line-height:1.2;max-width:55%; }
.dcurse-curse-en { font-size:10px;color:#9c27b0;line-height:1.2;max-width:55%; }
.dcurse-icon {
  width:28px;height:28px;
  border-radius:5px;background:#ddd;flex-shrink:0;
}

.dshop-footer { margin-top:12px;text-align:center; }
.dshop-continue {
  padding:10px 30px;font-size:15px;border:none;border-radius:20px;
  color:#fff;cursor:pointer;font-weight:bold;
  background:linear-gradient(145deg,#4a9e8e,#2d7a6e);
  transition:transform 0.15s;
}
.dshop-continue:hover { transform:scale(1.05); }
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
  getPenaltyMultiplier: dungeonGetPenaltyMultiplier,
  getPromoScoreBonus: dungeonGetPromoScoreBonus,
  getShinyBonus: dungeonGetShinyBonus,
  getFatigueReduction: dungeonGetFatigueReduction,
  applyRegret: dungeonApplyRegret,
  renderStateArea: dungeonRenderStateArea,
};

})();
