import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/examples/jsm/renderers/CSS3DRenderer.js';
import { cameraOffsetX } from './animationController.js';

/** 牌子立在跑道后方多远（世界单位） */
const BEHIND_LANE = 5;

/** 出场动作占多少进度 */
const ENTER = 0.03;

/**
 * 离场大约占用多少「屏高」的滚动。
 *
 * 用屏幕高度而不是固定像素：整关的滚动距离 = 占位高度 - 视口高度，
 * 同一次离场在 1080p 和笔记本的小窗口上要划过的像素差很多，
 * 但换算成屏高之后比例一致，读起来的节奏才一样。
 */
const EXIT_VIEWPORTS = 0.32;

/** 离场至少占多少进度：视口特别高时换算出来的进度极小，给个下限免得一闪就没 */
const MIN_EXIT_SPAN = 0.02;

/** 牌子滑进画面后停在哪个 NDC 横坐标：之后一直停在这儿，直到离场 */
const REST_NDC_X = 0.4;

/** 「滑进来就位」占整段路的比例：就位后卡片会停住，不会一路飘着走 */
const SETTLE_RATIO = 0.22;

/**
 * 每块牌子在关卡里的站位：屏幕下沿（NDC）、屏幕宽度、纵深（离跑道多远）、
 * 出场时中心停在画面右缘的哪个位置（NDC）。
 * 五块都不同——高度、大小、距离、滑入节奏都不一样，不会像同一个弹窗弹五次。
 *
 * 所有 bottom 都在画面中线以上：马里奥站在画面下方，牌子只会从他头顶上方飘过，
 * 不会再挡住他。
 */
const LAYOUTS = {
  // 关于：悬在画面上方，略远，偏小
  block: { bottom: 0.24, widthPx: 392, depth: 8, lead: 0.92 },
  // 最近在写：最宽、最近，正文看得最清
  coin: { bottom: 0.20, widthPx: 436, depth: 3, lead: 0.98 },
  // 再往前翻：最远的一块，出现时已经进画面了，滑得慢
  pipe: { bottom: 0.30, widthPx: 364, depth: 13, lead: 0.88 },
  // 现在：压得最低的一张短卡
  brick: { bottom: 0.22, widthPx: 380, depth: 6, lead: 1.04 },
  // 联系：最高、最窄
  flag: { bottom: 0.36, widthPx: 348, depth: 10, lead: 0.95 }
};

/** 画面里最低能落到哪儿：再低就压到马里奥身上了 */
const MIN_BOTTOM_NDC = 0.2;

const clamp01 = (value) => Math.min(1, Math.max(0, value));

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

const easeOutBack = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

const easeOutBounce = (t) => {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
};

/**
 * 五套入场 / 离场动作，全部取自这一关里真实出现过的道具：
 * block 顶问号砖弹出、coin 金币翻面、pipe 从管口升起、brick 砖块砸下、flag 升旗。
 * e 是入场进度 0~1，x 是离场进度 0~1，两者都由滚动进度解析计算，可以精确倒放。
 *
 * 离场只用「位移 + 淡出」，不做长时间缩小。
 * 淡出压在收尾：前半段位移时还保持全不透明，最后才化掉，
 * 这样牌子在大屏上也读得完，不会提前变淡。
 */
const STYLES = {
  /** 关于：被问号砖从下面顶出来，回弹一下；收尾时被按回砖里（整块沉下去） */
  block(e, x) {
    const p = easeOutBack(e);
    const s = 0.55 + 0.45 * p;
    return {
      transform: `translate3d(0, ${((1 - p) * 62 + x * 58).toFixed(2)}%, 0) scale(${s.toFixed(
        3
      )})`,
      opacity: String(clamp01((1 - x) * 2.6))
    };
  },

  /** 最近在写：像金币一样翻面翻出来，离场继续翻面转走 */
  coin(e, x) {
    const p = easeOutCubic(e);
    return {
      transform: `perspective(1400px) translate3d(0, ${((1 - p) * 24 - x * 16).toFixed(
        2
      )}%, 0) rotateY(${((1 - p) * 96 - x * 168).toFixed(1)}deg) scale(${(
        0.72 + 0.28 * p
      ).toFixed(3)})`,
      opacity: String(clamp01((1 - x) * 2.6))
    };
  },

  /** 再往前翻：从旁边的管口被推出来；离场时被抽回管口里 */
  pipe(e, x) {
    const p = easeOutCubic(e);
    return {
      transform: `translate3d(${((1 - p) * 46 - x * 60).toFixed(2)}%, ${(
        -x * 30
      ).toFixed(2)}%, 0) rotate(${((1 - p) * -3).toFixed(2)}deg) scale(${(
        0.9 + 0.1 * p
      ).toFixed(3)})`,
      opacity: String(clamp01((1 - x) * 2.6))
    };
  },

  /** 现在：被砖块砸下来，落地弹两下；离场时被镜头甩走 */
  brick(e, x) {
    const p = easeOutBounce(e);
    const s = 0.9 + 0.1 * p;
    const squash = 1 - 0.09 * Math.sin(Math.PI * Math.min(1, e * 1.2));
    return {
      transform: `translate3d(${(-x * 54).toFixed(2)}%, ${((1 - p) * -78 - x * 20).toFixed(
        2
      )}%, 0) rotate(${(-x * 6).toFixed(2)}deg) scale(${s.toFixed(3)}, ${(
        s * squash
      ).toFixed(3)})`,
      opacity: String(clamp01((1 - x) * 2.6))
    };
  },

  /** 联系：顺着旗杆升起来；离场时被风卷走（右移、上浮、旋转） */
  flag(e, x) {
    const p = easeOutCubic(e);
    return {
      transform: `translate3d(${((1 - p) * -12 + x * 72).toFixed(2)}%, ${(
        (1 - p) * 72 -
        x * 46
      ).toFixed(2)}%, 0) rotate(${((1 - p) * -2 + x * 9).toFixed(2)}deg) scale(${(
        0.9 + 0.1 * p
      ).toFixed(3)})`,
      opacity: String(clamp01((1 - x) * 2.6))
    };
  }
};

/**
 * 把博客正文的牌子真正放进 three 场景
 *
 * 每块牌子对应关卡的一段路：跑到那段时从画面右缘滑进来，在路段里停住，
 * 到这段路的最后才按各自的动作离场（见 STYLES）。
 * 横向、纵向都换算成 NDC 反解世界坐标，落点和时机不跟视口宽高比挂钩。
 *
 * 手机竖屏的横向视野只有二十几度，牌子钉死在世界坐标上会一闪而过，
 * 所以窄屏下改成挂在相机上，只保留道具式的出场 / 离场。
 */
export class Beats3D {
  constructor({ camera, level, host }) {
    this.camera = camera;
    this.level = level;

    this.renderer = new CSS3DRenderer();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.domElement.className = 'stage3d';
    host.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.cam = new THREE.PerspectiveCamera(camera.fov, camera.aspect, 0.1, 500);

    // 相机到跑道中线的纵深：牌子的大小、位置都按这个深度换算
    this.laneDistance = Math.max(6, Math.abs(camera.position.z - level.laneZ));

    this.items = [];
    this.tmp = new THREE.Vector3();
    this.maxScroll = this.measureScroll();
  }

  /** 整关能滚多远（像素）：进度 1 对应的滚动距离 */
  measureScroll() {
    const space = document.getElementById('scroll-space');
    const total = space ? space.offsetHeight : window.innerHeight * 9;
    return Math.max(1, total - window.innerHeight);
  }

  /**
   * 离场占用的进度。
   *
   * 先按「划多少屏高」换算出进度，再夹在合理区间里：
   * 大屏的滚动距离长，换算出的进度很小，所以给 MIN_EXIT_SPAN 兜底，
   * 免得本来该看两眼的离场在大屏上一闪就过去；
   * 同时不超过整段路的 32%，免得短路段被离场吃掉大半。
   */
  exitSpan(sectionSpan) {
    const span = (EXIT_VIEWPORTS * window.innerHeight) / this.maxScroll;
    return Math.min(sectionSpan * 0.32, Math.max(MIN_EXIT_SPAN, Math.min(0.07, span)));
  }

  /**
   * 把一块牌子挂进 3D 场景
   * @param {HTMLElement} el 页面里的牌子元素
   * @param {number} from 出现时的进度
   * @param {number} to 这块牌子失效的进度
   * @param {'block'|'coin'|'pipe'|'brick'|'flag'} styleKey 入场 / 离场动作
   */
  add(el, from, to, styleKey) {
    const style = STYLES[styleKey] ? styleKey : 'block';
    el.classList.add('beat--stage', `beat--${style}`);

    // 原始内容包进卡片，卡片自己承担入场 / 离场动作
    const rig = document.createElement('div');
    rig.className = 'beat__rig';
    const card = document.createElement('div');
    card.className = 'beat__card';
    while (el.firstChild) card.appendChild(el.firstChild);
    rig.append(card);
    el.appendChild(rig);

    const object = new CSS3DObject(el);
    object.position.set(0, 0, this.level.laneZ - BEHIND_LANE);
    this.scene.add(object);

    const item = {
      el,
      rig,
      object,
      from,
      to,
      style,
      layout: LAYOUTS[style],
      width: el.offsetWidth || 440,
      height: el.offsetHeight || 0,
      anchor: new THREE.Vector3()
    };
    this.items.push(item);

    // 文章可以点开，展开后重新量一次高度，牌子的底边才不会跟着往下掉
    el.addEventListener(
      'toggle',
      () => {
        item.height = el.offsetHeight || item.height;
      },
      true
    );

    this.place(item);
  }

  /** 牌子在屏幕上的目标像素宽度 */
  targetWidth(item) {
    if (window.innerWidth < 640) return Math.min(item.layout.widthPx, 330);
    // 窗口很矮时整体收一点，牌子的高度才不会压到马里奥头上
    return item.layout.widthPx * Math.min(1, window.innerHeight / 900);
  }

  /** 牌子在屏幕上的宽度占比：屏幕再宽，牌子的实际像素宽度也基本不变 */
  screenRatio(item) {
    const w = window.innerWidth;
    const compact = w < 640;
    // 极窄屏上别让牌子顶满整个宽度
    return Math.min(compact ? 0.9 : 0.6, this.targetWidth(item) / w);
  }

  /** 牌子投到屏幕上有多高（NDC，2 就是整个屏幕） */
  cardNdcHeight(item) {
    const px = this.targetWidth(item);
    const shown = item.width ? item.height * (px / item.width) : 0;
    return (shown / window.innerHeight) * 2;
  }

  /** 底边该落在哪个 NDC 高度：在画面中线以上，整块牌子又不出画 */
  targetBottom(item) {
    return Math.max(
      MIN_BOTTOM_NDC,
      Math.min(item.layout.bottom, 0.93 - this.cardNdcHeight(item))
    );
  }

  /**
   * 沿竖直方向把牌子挪一下，让底边精确落在目标 NDC 上。
   * 用的是真实投影，所以不管相机俯角、牌子在画面左右哪个位置，都不会算偏。
   */
  pinBottom(item) {
    const dist = this.laneDistance + item.layout.depth;
    const tan = Math.tan((this.cam.fov * Math.PI) / 360);
    const halfWorld = (this.cardNdcHeight(item) / 2) * dist * tan;
    const pos = item.object.position;
    let bottomY = pos.y - halfWorld;

    for (let i = 0; i < 2; i += 1) {
      this.tmp.set(pos.x, bottomY, pos.z).project(this.cam);
      const error = this.targetBottom(item) - this.tmp.y;
      if (Math.abs(error) < 0.002) break;
      bottomY += error * dist * tan;
    }

    pos.y = bottomY + halfWorld;
  }

  /**
   * 把牌子的横向位置挪到指定的 NDC 上。
   *
   * 透视除法只和纵深有关，所以在固定的 y / z 上，NDC x 对世界 x 是线性的：
   * 取两个点投影得到斜率，一次就能反解出该落在哪个世界 x。
   * 这样横向就成了「按进度走的屏幕坐标」，宽屏窄屏的落点完全一致。
   */
  pinX(item, ndcX) {
    const pos = item.object.position;

    this.tmp.set(pos.x, pos.y, pos.z).project(this.cam);
    const fromX = pos.x;
    const fromNdc = this.tmp.x;

    this.tmp.set(pos.x + 1, pos.y, pos.z).project(this.cam);
    const slope = this.tmp.x - fromNdc;
    if (Math.abs(slope) < 1e-6) return;

    pos.x = fromX + (ndcX - fromNdc) / slope;
  }

  /** 视口尺寸 / 宽高比换算出的景框半宽半高（按牌子自己的纵深算） */
  frame(depth) {
    const halfH = Math.tan((this.cam.fov * Math.PI) / 360) * (this.laneDistance + depth);
    return { halfH, halfW: halfH * this.cam.aspect };
  }

  /**
   * 给牌子一个初始锚点：纵深的 z、以及首帧用的世界 x。
   * 横向真正的位置每帧由 update() 里的 pinX 按进度反解，
   * 纵向由 pinBottom 每帧校正，这里只是兜底。
   */
  place(item) {
    const layout = item.layout;
    const { halfW } = this.frame(layout.depth);
    const offsetX = cameraOffsetX(this.cam.aspect);
    const x =
      this.level.startX +
      item.from * this.level.length +
      offsetX +
      halfW * layout.lead;
    const ground = this.level.heightAt ? this.level.heightAt(x) : 0;

    item.width = item.el.offsetWidth || item.width;
    item.height = item.el.offsetHeight || item.height;

    // 视线在牌子纵深上的高度（由相机抬升 + 俯角换算出来）
    const rig = offsetX / 3.1;
    const camY = ground + 3.9 * rig;
    const lookY = ground + 1.85 * rig;
    const axisY = camY + (lookY - camY) * ((this.laneDistance + layout.depth) / this.laneDistance);

    item.anchor.set(x, axisY, this.level.laneZ - layout.depth);
    item.object.position.copy(item.anchor);
  }

  /**
   * 每帧更新：按整关进度算出牌子该在屏幕的哪个位置、做什么动作。
   * 横向、纵向都换算成 NDC 再反解世界坐标，
   * 所以离场时机只跟进度有关，不会随视口尺寸漂。
   * @param {number} progress 整关进度 0~1
   */
  update(progress) {
    // 本层相机先跟上主相机，投影出来的屏幕位置才和实际渲染一致
    this.cam.position.copy(this.camera.position);
    this.cam.quaternion.copy(this.camera.quaternion);
    this.cam.updateMatrixWorld(true);

    const compact = window.innerWidth < 640;

    this.items.forEach((item) => {
      // 过了自己那段路就彻底收掉，不给它在终点画面里继续逗留
      if (progress < item.from || progress >= item.to) {
        item.object.visible = false;
        return;
      }

      const { halfH, halfW } = this.frame(item.layout.depth);
      const ratio = this.screenRatio(item);
      const worldWidth = ratio * 2 * halfW;

      const span = Math.max(0.0001, item.to - item.from);
      const exitSpan = this.exitSpan(span);

      const enter = clamp01((progress - item.from) / ENTER);
      // 离场只占收尾的一段：长度按视口换算，矮屏长、高屏短
      const exit = clamp01((progress - (item.to - exitSpan)) / exitSpan);

      if (compact) {
        // 窄屏：牌子挂在相机上，跟着镜头走
        const bottom = this.targetBottom(item);
        const localY = (bottom + this.cardNdcHeight(item) / 2) * halfH;
        item.object.position
          .set(0, localY, -(this.laneDistance + item.layout.depth))
          .applyQuaternion(this.camera.quaternion)
          .add(this.camera.position);
      } else {
        // 宽屏：横向也按 NDC 定位。
        // 前半段从右缘滑进来就位，之后就停住不动——不再一路被相机推着往左飘，
        // 所以「离场」只发生在最后 exitSpan 那一段，不会看着像一出现就在走。
        item.object.position.copy(item.anchor);
        const settle = easeOutCubic(
          clamp01((progress - item.from) / (span * SETTLE_RATIO))
        );
        this.pinX(item, item.layout.lead + (REST_NDC_X - item.layout.lead) * settle);
        // 竖直方向每帧校正，保证牌子的底边始终在马里奥头顶上方
        this.pinBottom(item);
      }

      if (exit >= 1) {
        item.object.visible = false;
        return;
      }

      item.object.visible = true;
      item.object.scale.setScalar(worldWidth / item.width);

      const pose = STYLES[item.style](enter, exit);
      item.rig.style.transform = pose.transform;
      item.rig.style.opacity = pose.opacity;
    });
  }

  /** 相机与 WebGL 主相机同步，然后渲染这一层 */
  render() {
    this.cam.position.copy(this.camera.position);
    this.cam.quaternion.copy(this.camera.quaternion);
    this.renderer.render(this.scene, this.cam);
  }

  onResize() {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.cam.aspect = window.innerWidth / window.innerHeight;
    this.cam.updateProjectionMatrix();
    // 滚动距离跟着视口高度变，离场窗口也要重新换算
    this.maxScroll = this.measureScroll();
    // 视口变了，牌子的钉点（相对镜头的位置和大小）也要重算
    this.items.forEach((item) => this.place(item));
  }
}
