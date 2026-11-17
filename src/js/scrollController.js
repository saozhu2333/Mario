import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

// 注册插件（只注册一次）
gsap.registerPlugin(ScrollTrigger);

/** 牌子淡入淡出占用的进度长度 */
const BEAT_FADE = 0.018;

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/**
 * 滚动控制器
 *
 * 把页面滚动进度映射成主时间轴的进度：
 * - 往下滚 → 时间轴前进 → 马里奥向前跑
 * - 往回滚 → 时间轴倒放 → 动作完整倒退
 * - 回到顶部 → 重置角色与金币状态
 *
 * 整页滚动就是这一关的全程：页面顶 = 起点，页面底 = 旗杆。
 * 正文内容挂在关卡的不同路段上（data-from / data-to），跑到才浮现。
 */
export class ScrollController {
  /**
   * @param {object} options
   * @param {import('./animationController.js').AnimationController} options.animation
   * @param {object} options.elements 页面上的 UI 元素集合
   */
  constructor({ animation, elements }) {
    this.animation = animation;
    this.elements = elements;
    this.instance = null;
    this.beats = [];
  }

  /** 收集所有挂在路段上的牌子 */
  collectBeats() {
    const root = this.elements.beats;
    if (!root) return [];

    return [...root.querySelectorAll('.beat')]
      // 已经交给 CSS3D 渲染的牌子由 Beats3D 接管，这里不再动它们
      .filter((el) => !el.hasAttribute('data-3d'))
      .map((el) => ({
        el,
        from: Number(el.dataset.from) || 0,
        to: el.dataset.to === undefined ? 1 : Number(el.dataset.to),
        // 起点的标题和终点的结算面板不需要随滚动做位移
        still: el.classList.contains('beat--hero') || el.classList.contains('beat--finale')
      }));
  }

  /** 按进度显示 / 隐藏牌子，并给立在跑道边的那几块加一点视差 */
  updateBeats(progress) {
    this.beats.forEach(({ el, from, to, still }) => {
      const rise = clamp01((progress - (from - BEAT_FADE)) / BEAT_FADE);
      const fall = clamp01((to + BEAT_FADE - progress) / BEAT_FADE);
      const opacity = Math.min(rise, fall);

      el.style.opacity = opacity.toFixed(3);
      el.style.visibility = opacity < 0.02 ? 'hidden' : 'visible';
      // 只在完全浮现时允许点击，避免淡出中的牌子挡住鼠标
      el.style.pointerEvents = opacity > 0.95 ? 'auto' : 'none';

      if (still) return;

      // 在所属路段内轻微横移 + 倾斜，让牌子看起来立在世界里而不是贴在屏幕上
      const t = clamp01((progress - from) / Math.max(0.0001, to - from));
      const drift = (0.5 - t) * 44;
      const lift = (0.5 - t) * -18;
      el.style.transform = `perspective(1400px) rotateY(3deg) translate3d(${drift.toFixed(
        2
      )}px, ${lift.toFixed(2)}px, 0)`;
    });
  }

  /** 导航：按进度跳转，而不是按 DOM 锚点（内容都在固定层里） */
  bindSeekLinks() {
    document.querySelectorAll('[data-seek]').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        const space = document.getElementById('scroll-space');
        if (!space) return;
        const max = space.offsetHeight - window.innerHeight;
        const target = max * Number(link.dataset.seek || 0);
        window.scrollTo({ top: target, behavior: 'smooth' });
      });
    });
  }

  init() {
    const { fill, percent, coins, hint, ui, tallyCoins, tallyTime } = this.elements;

    // 结算成绩：整段跑酷是确定的，金币数与用时在初始化时算好即可
    const duration = this.animation.timeline.duration();
    if (tallyCoins) tallyCoins.textContent = String(this.animation.getCoinCount(duration));
    if (tallyTime) tallyTime.textContent = `${Math.round(duration)} 秒`;

    this.beats = this.collectBeats();
    this.updateBeats(0);
    this.bindSeekLinks();

    this.instance = ScrollTrigger.create({
      trigger: '#scroll-space',
      start: 'top top',
      end: 'bottom bottom',
      // scrub: true 立即绑定；这里给 1 秒的追帧，滚动更顺滑
      scrub: 1,
      animation: this.animation.timeline,
      onUpdate: (self) => {
        const progress = self.progress;

        // 进度条与百分比
        gsap.set(fill, { scaleX: progress });
        percent.textContent = `${Math.round(progress * 100)}%`;

        // 金币计数：按时间轴当前时间换算
        const time = progress * duration;
        coins.textContent = `金币 ${this.animation.getCoinCount(time)}`;

        // 开始滚动后隐藏提示，显示 UI
        hint.classList.toggle('is-hidden', progress > 0.01);
        ui.classList.toggle('is-visible', progress > 0.005);

        // 跑到哪一段，浮出哪一块牌子
        this.updateBeats(progress);

        // 回到顶部：完整重置
        if (progress <= 0.0005) {
          this.animation.reset();
        }
      }
    });

    return this.instance;
  }
}
