import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** 跑步动画一个完整循环对应的位移（世界单位），用于把前进距离换算成动画时间 */
const STRIDE_LENGTH = 3.6;

/** 角色归一化高度（关卡里一块砖 = 1 单位，超级马里奥约 2 块高） */
const MARIO_HEIGHT = 1.8;

/** 身体半宽：跳跃时保证整个身体都越过管道 */
const BODY_HALF = 0.45;

/** 脚底离管道顶面的最小余量 */
const JUMP_MARGIN = 0.3;

/** 落地缓冲持续的水平距离 */
const LAND_LENGTH = 1.3;

/** 悬崖跳跃：起跳点 / 落点都要跨出缺口边缘，多留一点余量 */
const PIT_PAD = 0.5;

/** 跨越悬崖时的跳跃峰值高度 */
const PIT_PEAK = 2.6;

/** 楼梯金字塔中间凹槽：起跳 / 落点向两侧台顶内收的余量 */
const VALLEY_PAD = 0.3;

/** 跨越楼梯凹槽时的跳跃峰值高度 */
const VALLEY_PEAK = 2.4;

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/**
 * 马里奥角色
 *
 * 使用对象存储上的 mario.glb（来自 GitHub 现成资源）：
 * - 真正的骨骼蒙皮网格（SkinnedMesh）
 * - 自带 idle / walk / run / jump / land 等动画
 *
 * 动画策略：
 * - idle 按真实时间循环播放；
 * - run / jump / land 设为 paused，每帧由「滚动驱动的时间轴」写入 time 与 weight，
 *   因此往下滚动作前进、往回滚动作完整倒放。
 */
export class Mario {
  constructor({ scene, level }) {
    /** 关卡数据（startX / laneZ / heightAt 由 scene.js 提供） */
    this.level = level;

    /**
     * 由 GSAP 时间轴写入的状态
     * x 是前进距离；y / jumpBlend / jumpT 等由 sync() 按障碍物位置实时算出来
     */
    this.state = {
      x: level.startX,
      y: 0,
      jumpBlend: 0,
      jumpT: 0,
      landBlend: 0,
      landT: 0
    };

    /** 脚下的实际高度（带垂直阻尼，台阶不会一格一格地跳） */
    this.footGround = level.heightAt(level.startX);

    this.root = new THREE.Group();
    this.root.name = 'MarioRoot';
    scene.add(this.root);

    this.mixer = null;
    this.actions = {};
    this.durations = {};

    this.createBlobShadow(scene);
  }

  /* ------------------------------------------------------------ 模型加载 */

  /**
   * 加载并替换为带骨骼动画的马里奥模型
   * @param {string} url 模型地址，例如 '/models/mario.glb'
   */
  async load(url, onProgress) {
    // 用 load 而不是 loadAsync，才能拿到下载进度
    const gltf = await new Promise((resolve, reject) => {
      new GLTFLoader().load(
        url,
        resolve,
        (event) => {
          if (onProgress && event.lengthComputable) onProgress(event.loaded / event.total);
        },
        reject
      );
    });

    const inner = new THREE.Group();
    inner.add(gltf.scene);
    // 模型默认面朝 +Z，绕 Y 轴 +90° 后朝 +X（本项目的前进方向）
    inner.rotation.y = Math.PI / 2;
    this.root.add(inner);

    // 按高度归一化，并让脚底落在原点、身体居中
    let box = new THREE.Box3().setFromObject(inner);
    const size = box.getSize(new THREE.Vector3());
    inner.scale.setScalar(MARIO_HEIGHT / (size.y || 1));

    box = new THREE.Box3().setFromObject(inner);
    inner.position.set(
      -(box.min.x + box.max.x) / 2,
      -box.min.y,
      -(box.min.z + box.max.z) / 2
    );

    gltf.scene.traverse((child) => {
      if (child.isMesh) {
        // 骨骼动画不会更新包围盒，关闭视锥剔除避免角色突然消失
        child.frustumCulled = false;
      }
    });

    // ---- 骨骼动画 ----
    this.mixer = new THREE.AnimationMixer(gltf.scene);
    gltf.animations.forEach((clip) => {
      const action = this.mixer.clipAction(clip);
      action.play();
      action.setEffectiveWeight(0);
      this.actions[clip.name] = action;
      this.durations[clip.name] = clip.duration;
    });

    // 这三个动作完全由滚动进度决定播放到哪一帧
    ['run', 'walk', 'jump', 'land'].forEach((name) => {
      if (this.actions[name]) this.actions[name].paused = true;
    });

    // 静止时默认播 idle
    if (this.actions.idle) this.actions.idle.setEffectiveWeight(1);

    this.sync(0);
  }

  /* ------------------------------------------------------------ 姿态同步 */

  /**
   * 脚下的目标高度
   * 正常情况就是地表高度；终点前从最后一级台阶跳下时，
   * 换成一段加速下落的抛物线，直接落到旗杆前的平地；
   * 楼梯中间的凹槽则把两侧台顶连成一条斜线，让角色保持台顶高度跳过去。
   */
  groundPath(x) {
    const leap = this.level.leap;
    if (leap && x > leap.fromX && x < leap.toX) {
      const t = (x - leap.fromX) / (leap.toX - leap.fromX);
      return leap.fromY - (leap.fromY - leap.toY) * t * t;
    }

    for (const valley of this.level.valleys) {
      if (x > valley.fromX && x < valley.toX) {
        const t = (x - valley.fromX) / (valley.toX - valley.fromX);
        return valley.fromY + (valley.toY - valley.fromY) * t;
      }
    }

    return this.level.heightAt(x);
  }

  /**
   * 按当前横坐标计算跳跃状态
   *
   * 跳跃高度完全由「横向位置」决定，是一条抛物线：
   *   y = 峰值 * (1 - (d / span)²)
   * 管道：span 由管道高度反推，保证身体边缘（管道边缘 + 身体半宽）处脚底仍高于管道顶，
   *       所以整个身体一定能越过管道，不会从管子里穿过去。
   * 悬崖：起跳点与落点都在缺口边缘之外，抛物线让角色直接跨到另一侧。
   * 楼梯凹槽：起跳点与落点分别在两侧台顶，保持台顶高度跨过去。
   */
  jumpState(x) {
    let height = 0;
    let blend = 0;
    let progress = 0;
    let landBlend = 0;
    let landT = 0;

    for (const obstacle of this.level.obstacles) {
      const ground = this.level.heightAt(obstacle.x);
      const need = Math.max(1.2, obstacle.top - ground + JUMP_MARGIN);
      // 峰值比需要的高度再多 0.9，抛物线在管道边缘仍有富裕
      const peak = need + 0.9;
      const edge = obstacle.halfWidth + BODY_HALF;
      const span = edge * Math.sqrt(peak / (peak - need));

      const d = x - obstacle.x;
      const ad = Math.abs(d);

      if (ad < span) {
        const h = peak * (1 - (d / span) ** 2);
        if (h > height) {
          height = h;
          progress = (d + span) / (2 * span);
        }
        blend = Math.max(blend, clamp01((span - ad) / 0.45));
      }

      // 落地后的一小段距离内叠加落地缓冲动作
      const after = d - span;
      if (after >= 0 && after < LAND_LENGTH) {
        landBlend = Math.max(landBlend, 1 - after / LAND_LENGTH);
        landT = Math.max(landT, after / LAND_LENGTH);
      }
    }

    // 悬崖：脚下没有地面，必须从缺口前起跳、落到缺口另一侧
    for (const pit of this.level.pits) {
      const takeoff = pit.fromX - PIT_PAD;
      const landing = pit.toX + PIT_PAD;
      const mid = (takeoff + landing) / 2;
      const half = (landing - takeoff) / 2;
      const t = (x - mid) / half;

      if (Math.abs(t) < 1) {
        const h = PIT_PEAK * (1 - t * t);
        if (h > height) {
          height = h;
          progress = (x - takeoff) / (landing - takeoff);
        }
        blend = Math.max(blend, clamp01(((1 - Math.abs(t)) * half) / 0.45));
      }

      const after = x - landing;
      if (after >= 0 && after < LAND_LENGTH) {
        landBlend = Math.max(landBlend, 1 - after / LAND_LENGTH);
        landT = Math.max(landT, after / LAND_LENGTH);
      }
    }

    // 楼梯金字塔中间的凹槽：从左侧台顶起跳，越过凹槽落到右侧台顶
    for (const valley of this.level.valleys) {
      const takeoff = valley.fromX - VALLEY_PAD;
      const landing = valley.toX + VALLEY_PAD;
      const mid = (takeoff + landing) / 2;
      const half = (landing - takeoff) / 2;
      const t = (x - mid) / half;

      if (Math.abs(t) < 1) {
        const h = VALLEY_PEAK * (1 - t * t);
        if (h > height) {
          height = h;
          progress = (x - takeoff) / (landing - takeoff);
        }
        blend = Math.max(blend, clamp01(((1 - Math.abs(t)) * half) / 0.45));
      }

      const after = x - landing;
      if (after >= 0 && after < LAND_LENGTH) {
        landBlend = Math.max(landBlend, 1 - after / LAND_LENGTH);
        landT = Math.max(landT, after / LAND_LENGTH);
      }
    }

    return { height, blend, progress, landBlend, landT };
  }

  /**
   * 每帧同步位置与骨骼动画
   * @param {number} dt 帧间隔（秒）
   */
  sync(dt) {
    const s = this.state;

    // 垂直阻尼：0.25 单位精度的地表采样在台阶边缘会跳变一格，这里把它抹平
    const target = this.groundPath(s.x);
    const k = dt > 0 ? 1 - Math.exp(-dt * 26) : 1;
    this.footGround += (target - this.footGround) * k;

    const jump = this.jumpState(s.x);
    s.y = jump.height;
    s.jumpBlend = jump.blend;
    s.jumpT = jump.progress;
    s.landBlend = jump.landBlend;
    s.landT = jump.landT;

    // 跳跃高度是相对脚下的地面，绝不会沉到地面以下
    this.root.position.set(s.x, this.footGround + jump.height, this.level.laneZ);

    const jumpW = clamp01(s.jumpBlend);
    const landW = clamp01(s.landBlend) * (1 - jumpW);
    // 刚出发的极短距离内不播跑步，让 idle 平滑过渡
    const moved = clamp01(Math.abs(s.x - this.level.startX) / 0.3);
    const runW = clamp01(1 - jumpW - landW) * moved;
    const idleW = clamp01(1 - jumpW - landW - runW);

    // 跑步：动画时间直接由位移换算，所以往回滚时步频也精确倒放
    const run = this.actions.run || this.actions.walk;
    if (run) {
      const cycles = (s.x - this.level.startX) / STRIDE_LENGTH;
      const loop = cycles - Math.floor(cycles);
      run.time = loop * this.durations[run.getClip().name];
      run.setEffectiveWeight(runW);
    }

    // 起跳 / 空中姿态
    if (this.actions.jump) {
      this.actions.jump.time = clamp01(s.jumpT) * this.durations.jump;
      this.actions.jump.setEffectiveWeight(jumpW);
    }

    // 落地缓冲姿态
    if (this.actions.land) {
      this.actions.land.time = clamp01(s.landT) * this.durations.land * 0.5;
      this.actions.land.setEffectiveWeight(landW);
    }

    if (this.actions.idle) {
      this.actions.idle.setEffectiveWeight(idleW);
    }

    this.updateShadow();

    // idle 需要推进时间；其余动作 paused，只会被上面的 time / weight 驱动
    if (this.mixer) this.mixer.update(dt);
  }

  /* ------------------------------------------------------------ 假阴影 */

  /** 光线烘焙在关卡贴图里（unlit 材质收不到阴影），这里用贴地圆斑做角色投影 */
  createBlobShadow(scene) {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(
      size / 2, size / 2, 2,
      size / 2, size / 2, size / 2
    );
    gradient.addColorStop(0, 'rgba(0, 0, 0, 0.5)');
    gradient.addColorStop(0.55, 'rgba(0, 0, 0, 0.28)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    const texture = new THREE.CanvasTexture(canvas);
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 1.0),
      new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        fog: false
      })
    );
    this.shadow.rotation.x = -Math.PI / 2;
    scene.add(this.shadow);
  }

  /** 跳得越高，阴影越小越淡（阴影始终贴在地面上，不跟着角色升空） */
  updateShadow() {
    const s = this.state;
    const ground = this.level.heightAt(s.x);
    const air = clamp01((this.root.position.y - ground) / 5.5);

    // 悬在悬崖 / 楼梯凹槽上方时脚下没有地面，阴影直接隐藏
    const overGap =
      this.level.pits.some((pit) => s.x > pit.fromX && s.x < pit.toX) ||
      this.level.valleys.some((valley) => s.x > valley.fromX && s.x < valley.toX);
    this.shadow.visible = !overGap;

    this.shadow.position.set(s.x, ground + 0.05, this.level.laneZ);
    this.shadow.scale.setScalar(1 - air * 0.45);
    this.shadow.material.opacity = 1 - air * 0.8;
  }

  /* ------------------------------------------------------------ 重置 */

  /** 回到初始姿态（滚动回顶部时调用） */
  reset() {
    Object.assign(this.state, {
      x: this.level.startX,
      y: 0,
      jumpBlend: 0,
      jumpT: 0,
      landBlend: 0,
      landT: 0
    });
    this.footGround = this.level.heightAt(this.level.startX);
    this.sync(0);
  }
}
