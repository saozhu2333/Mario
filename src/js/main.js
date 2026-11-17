import * as THREE from 'three';
import { createGameScene } from './scene.js';
import { Mario } from './mario.js';
import { AnimationController } from './animationController.js';
import { ScrollController } from './scrollController.js';
import { Beats3D } from './beats3d.js';
import { bindBgm } from './music.js';

/**
 * 项目入口
 * 1. 加载现成关卡（level.glb）与金币（coin.glb），创建 Three.js 场景
 * 2. 加载带骨骼动画的马里奥模型（mario.glb）
 * 3. 构建 GSAP 主时间轴 + 相机跟随
 * 4. 用 ScrollTrigger 把滚动进度接到时间轴上
 */

const canvas = document.getElementById('webgl');
const loadingEl = document.getElementById('loading');
const loadingText = loadingEl.querySelector('.loading__text');
const loadingPercent = loadingEl.querySelector('.loading__percent');
const loadingBar = loadingEl.querySelector('.loading__bar');
const loadingBlocks = Array.from(loadingEl.querySelectorAll('.loading__bar i'));

/** 已经砌到第几块砖：进度只往前走，两个模型并行下载时不会来回跳 */
let loadingShown = 0;

/** 把 0~1 的加载进度画到砖块和百分比上 */
function setLoadingProgress(value) {
  loadingShown = Math.max(loadingShown, Math.min(1, Math.max(0, value)));

  const percent = Math.round(loadingShown * 100);
  if (loadingPercent) loadingPercent.textContent = `${percent}%`;
  if (loadingBar) loadingBar.setAttribute('aria-valuenow', String(percent));

  const lit = Math.round(loadingShown * loadingBlocks.length);
  loadingBlocks.forEach((block, index) => block.classList.toggle('is-on', index < lit));
}

const game = createGameScene(canvas);

/** 联系卡片里四枚图标对应的明细 */
const CONTACTS = {
  qq: { label: 'QQ', value: '2233720980' },
  wechat: { label: '微信', value: 'saozhu23333' },
  juejin: {
    label: '掘金',
    value: 'juejin.cn/user/4330325551357245',
    href: 'https://juejin.cn/user/4330325551357245'
  },
  github: {
    label: 'GitHub',
    value: 'github.com/saozhu2333',
    href: 'https://github.com/saozhu2333'
  }
};

/**
 * 联系卡片：点图标翻出对应的联系方式，再点一次收起。
 * 明细区高度是固定的，卡片不会因为点了一下就忽高忽低。
 */
function bindContacts() {
  const card = document.querySelector('#beats .beat[aria-label="联系"]');
  if (!card) return;

  const detail = card.querySelector('[data-contact-detail]');
  const buttons = [...card.querySelectorAll('.contact')];
  const hint = detail.innerHTML;

  const show = (key) => {
    const item = CONTACTS[key];

    buttons.forEach((button) => {
      const active = button.dataset.contact === key;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-expanded', String(active));
    });

    if (!item) {
      detail.innerHTML = hint;
      return;
    }

    detail.innerHTML = item.href
      ? `<span class="contact-detail__k">${item.label}</span><a class="contact-detail__v" href="${item.href}" target="_blank" rel="noopener">${item.value}</a>`
      : `<span class="contact-detail__k">${item.label}</span><span class="contact-detail__v">${item.value}</span>`;

    detail.animate(
      [
        { opacity: 0, transform: 'translateY(4px)' },
        { opacity: 1, transform: 'translateY(0)' }
      ],
      { duration: 220, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' }
    );
  };

  card.addEventListener('click', (event) => {
    const button = event.target.closest('.contact');
    if (!button) return;
    show(button.classList.contains('is-active') ? null : button.dataset.contact);
  });
}

/**
 * 终点卡片上的「再玩一次」：滚回页面顶部。
 * 顶部就是关卡起点，ScrollTrigger 回到 0 时会把角色、金币、旗面一起复位。
 */
function bindRestart() {
  const button = document.querySelector('[data-restart]');
  if (!button) return;

  button.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

async function boot() {
  // 关卡：地形、管道障碍、金币
  await game.load((ratio) => setLoadingProgress(ratio * 0.62));

  // 角色：骨骼动画马里奥（云端优先，拿不到就用站点里的副本）
  const mario = new Mario({ scene: game.scene, level: game.level });
  const reportMario = (ratio) => setLoadingProgress(0.62 + ratio * 0.33);
  try {
    await mario.load('http://tol3twc4m.hn-bkt.clouddn.com/Mariomario.glb', reportMario);
  } catch (error) {
    console.warn('[boot] 云端马里奥加载失败，改用本地副本：', error);
    await mario.load(`${import.meta.env.BASE_URL}models/mario.glb`, reportMario);
  }

  // 动画时间轴 + 相机跟随
  const animation = new AnimationController(mario, game);

  // 中间那几块正文牌子：真正放进 three 场景，靠同一个进度驱动出场 / 离场
  const beats3d = new Beats3D({
    camera: game.camera,
    level: game.level,
    host: document.body
  });
  document.querySelectorAll('#beats .beat[data-3d]').forEach((el) => {
    beats3d.add(
      el,
      Number(el.dataset.from) || 0,
      el.dataset.to === undefined ? 1 : Number(el.dataset.to),
      el.dataset.style
    );
  });
  // 联系卡片：点图标翻出对应的联系方式
  bindContacts();
  // 终点卡片：再玩一次 = 滚回起点
  bindRestart();
  // BGM 卡片：现场合成的背景音乐
  bindBgm();

  // 滚动驱动
  const scroll = new ScrollController({
    animation,
    elements: {
      ui: document.querySelector('.ui'),
      fill: document.getElementById('progress-fill'),
      percent: document.getElementById('progress-percent'),
      coins: document.getElementById('coin-count'),
      hint: document.getElementById('hint'),
      beats: document.getElementById('beats'),
      tallyCoins: document.getElementById('tally-coins'),
      tallyTime: document.getElementById('tally-time')
    }
  });
  scroll.init();

  /* ------------------------------------------------------------ 渲染循环 */
  const clock = new THREE.Clock();

  function tick() {
    const dt = Math.min(clock.getDelta(), 0.05);

    // 角色位置与骨骼动画（由滚动驱动的 state 决定）
    mario.sync(dt);
    // 相机平滑跟随
    animation.updateCamera(dt);
    // 场景动态元素：金币自转、光照跟随
    game.update(mario.state.x);
    // 渲染
    game.render();

    // 场景内的牌子：与马里奥共用时间轴进度，按各自的动作入场 / 离场
    // 用 ScrollTrigger 的进度而不是 timeline 的：scrub 追帧时 timeline 会落后，
    // 牌子会拖到终点画面里才消失
    beats3d.update(scroll.instance ? scroll.instance.progress : animation.timeline.progress());
    beats3d.render();

    requestAnimationFrame(tick);
  }
  tick();

  /* ------------------------------------------------------------ 窗口自适应 */
  window.addEventListener('resize', () => {
    game.onResize();
    beats3d.onResize();
  });

  /* ------------------------------------------------------------ 隐藏加载遮罩 */
  // 等两帧，确保首帧已经绘制
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      setLoadingProgress(1);
      loadingEl.classList.add('is-hidden');
    });
  });
}

boot().catch((error) => {
  console.error('[boot] 初始化失败', error);
  if (loadingText) loadingText.textContent = '模型加载失败，刷新一下试试';
});
