import gsap from 'gsap';
import * as THREE from 'three';

/** 马里奥沿关卡前进的基准速度（世界单位 / 秒），决定整条时间线的长度 */
const SPEED = 5.5;

/** 相机到跑道中线的距离（世界单位），越大角色越小、看到的世界越宽 */
const CAMERA_Z = 22.8;

/** 相机相对角色的基准水平偏置（世界单位），对应 RIG = 1 */
const BASE_OFFSET_X = 3.1;

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/**
 * 相机相对角色的水平偏置：竖屏时横向视野很窄，偏置必须跟着收窄，
 * 否则相机会把角色挤出画面左边。
 * @param {number} aspect 视口宽高比
 */
export function cameraOffsetX(aspect) {
  return 2.4 + clamp01((aspect - 0.6) / 0.7) * 3.8;
}

/**
 * 动画控制器
 *
 * 把「角色状态」编排成一条 GSAP 主时间轴：
 * 前进位移、跳跃、落地缓冲、金币收集都写进同一条 timeline，
 * 再由 ScrollTrigger 通过 scrub 控制它的进度，因此往回滚就会倒放。
 */
export class AnimationController {
  constructor(mario, game) {
    this.mario = mario;
    this.game = game;
    this.level = game.level;
    this.state = mario.state;

    /** 整条时间轴总时长（秒） */
    this.duration = this.level.length / SPEED;

    /** 每枚金币被收集时对应的时间点 */
    this.coinTimes = this.level.coins.map((coin) => this.timeAt(coin.x));

    this.timeline = this.buildTimeline();
    this.initCameraFollow();
    this.resetCamera();
  }

  /** 距离 → 时间轴时间的映射 */
  timeAt(x) {
    return (x - this.level.startX) / SPEED;
  }

  /* ------------------------------------------------------------ 主时间轴 */
  buildTimeline() {
    const state = this.state;
    const level = this.level;
    const timeline = gsap.timeline({ paused: true });

    // 1. 匀速前进（时间轴的主干）
    timeline.to(state, {
      x: level.finishX,
      duration: this.duration,
      ease: 'none'
    }, 0);

    // 2. 到达终点后：旗面沿旗杆滑下（travel 是负值，直接作为目标位移）
    if (level.flag) {
      timeline.to(
        level.flag.cloth.position,
        { y: level.flag.travel, duration: 1.6, ease: 'power2.in' },
        this.duration + 0.25
      );
    }

    // 3. 金币收集：被碰到的金币向上飘起并缩小消失
    level.coins.forEach((coin) => {
      const at = this.timeAt(coin.x);

      timeline.to(
        coin.group.position,
        { y: coin.baseY + 1.3, duration: 0.32, ease: 'power1.out' },
        at
      );
      timeline.to(
        coin.group.scale,
        { x: 0.001, y: 0.001, z: 0.001, duration: 0.32, ease: 'back.in(2)' },
        at
      );
    });

    return timeline;
  }

  /* ------------------------------------------------------------ 相机跟随 */

  /**
   * 相机跟随使用「每帧朝目标位置阻尼靠近」的方式：
   * 比固定时长的补间更容易控制，也能在最后一跳（8 格高台跳下）时
   * 通过误差上限强制镜头跟上，避免角色掉出画面。
   */
  initCameraFollow() {
    this.lookTarget = new THREE.Vector3(0, 0, this.level.laneZ);
  }

  /** 把镜头直接摆到起点（重置 / 初始化用） */
  resetCamera() {
    const x = this.level.startX;
    const ground = this.level.heightAt(x);
    const rig = this.getRig();

    this.game.camera.position.set(
      x + BASE_OFFSET_X * rig,
      ground + 3.9 * rig,
      CAMERA_Z
    );
    this.lookTarget.set(x + 2.0 * rig, ground + 1.85 * rig, this.level.laneZ);
    this.game.camera.lookAt(this.lookTarget);
  }

  /** 跟随系数：由视口宽高比决定，宽屏拉远、窄屏收近 */
  getRig() {
    const aspect = this.game.camera.aspect || 1.6;
    return cameraOffsetX(aspect) / BASE_OFFSET_X;
  }

  /**
   * 每帧调用：把相机目标点推向马里奥当前的位置
   * @param {number} dt 帧间隔（秒）
   */
  updateCamera(dt) {
    const state = this.state;
    // 脚下高度用角色自己的阻尼值，上下台阶时镜头跟着平滑移动
    const ground = this.mario.footGround;

    // 临近终点时镜头缓缓后退拉远，把整根旗杆和下滑的旗面收进画面
    const finale = clamp01((state.x - (this.level.finishX - 9)) / 9);
    const rig = this.getRig();

    // 终点再往后退一截，把整根旗杆和下滑的旗面都收进画面
    const camX = state.x + BASE_OFFSET_X * rig + finale * 3.2;
    const camY = ground + 3.9 * rig + state.y * 0.45 + finale * 6;
    const camZ = CAMERA_Z + finale * 14;
    const lookX = state.x + 2.0 * rig + finale * 1.8;
    const lookY = ground + 1.85 * rig + state.y * 0.55 + finale * 6.4;

    const camera = this.game.camera;
    const k = dt > 0 ? 1 - Math.exp(-dt * 7) : 1;
    const kl = dt > 0 ? 1 - Math.exp(-dt * 10) : 1;

    camera.position.x += (camX - camera.position.x) * k;
    camera.position.y += (camY - camera.position.y) * k;
    camera.position.z += (camZ - camera.position.z) * k;

    // 垂直误差上限：高速下落时不允许镜头被甩太高，保证角色留在画面内
    camera.position.y = Math.min(camY + 0.8, Math.max(camY - 2.2, camera.position.y));

    this.lookTarget.x += (lookX - this.lookTarget.x) * kl;
    this.lookTarget.y += (lookY - this.lookTarget.y) * kl;
    this.lookTarget.z = this.level.laneZ;

    camera.lookAt(this.lookTarget);
  }

  /* ------------------------------------------------------------ 辅助逻辑 */

  /**
   * 某一时刻已经收集的金币数量（用于 UI 显示）
   * @param {number} time 时间轴当前时间
   */
  getCoinCount(time) {
    let count = 0;
    for (const t of this.coinTimes) {
      if (t <= time) count++;
    }
    return count;
  }

  /** 回到顶部时的完整重置 */
  reset() {
    this.timeline.progress(0);

    this.level.coins.forEach((coin) => {
      gsap.set(coin.group.position, { y: coin.baseY });
      gsap.set(coin.group.scale, { x: 1, y: 1, z: 1 });
    });

    this.mario.reset();
  }
}
