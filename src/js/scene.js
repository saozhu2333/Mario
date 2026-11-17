import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * 模型放在对象存储上，和页面分开托管：
 * 换模型不用重新打包，首屏也不用跟着站点一起发布。
 *
 * 注意这里用的是 http：这个测试域名目前没有可用的 HTTPS 证书。
 * 站点以后部署到 HTTPS 时，要先去存储后台给域名配上证书，
 * 再把地址改成 https，否则浏览器会按混合内容拦掉。
 *
 * 所以每个模型都留了一份 public/models 里的本地副本：
 * 云端拿不到（被拦、临时挂掉）就回退到同源请求，页面至少还能跑起来。
 */
const LEVEL_URL = 'http://tol3twc4m.hn-bkt.clouddn.com/Mariolevel.glb';
const LEVEL_FALLBACK = `${import.meta.env.BASE_URL}models/level.glb`;
const COIN_URL = 'http://tol3twc4m.hn-bkt.clouddn.com/Mariocoin.glb';
const COIN_FALLBACK = `${import.meta.env.BASE_URL}models/coin.glb`;

/** 贴地金币的中心高度（相对地面）与横向间距 */
const COIN_GROUND_OFFSET = 1.35;
const COIN_SPACING = 7;

/* ---------------------------------------------------------------- 工具函数 */

/** 按名字关键字找到 glb 里的某个 Mesh（可选排除关键字，避免误匹配） */
function findMesh(root, keyword, exclude) {
  let found = null;
  root.traverse((object) => {
    if (found || !object.isMesh) return;
    if (!object.name.includes(keyword)) return;
    if (exclude && object.name.includes(exclude)) return;
    found = object;
  });
  return found;
}

/** 生成天空渐变贴图（比纯色背景有层次） */
function createSkyTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, 0, 512);
  gradient.addColorStop(0, '#4aa8ff');
  gradient.addColorStop(0.45, '#8fd1ff');
  gradient.addColorStop(0.75, '#c9ecff');
  gradient.addColorStop(1, '#f2fbff');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 512);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * 固定种子的随机数：云的排布每次刷新都一样，不会随机乱跳
 * @param {number} seed 种子
 * @returns {() => number} 0~1 的随机数
 */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * 天上的云：六坨白球叠成一小团，横着铺满整段关卡。
 *
 * 没有外挂模型：一团云就是六颗球，共用一份几何体和材质，
 * 换来的是能跟着相机真正产生视差，转视角也不会像公告板那样露馅，
 * 而且不增加任何下载体积。云放在跑道纵深之后、镜头俯角能看到的仰角内，
 * 太靠上会被裁掉，太靠下会压到跑道。
 *
 * @param {THREE.Scene} scene 场景
 * @param {object} level 关卡数据（load() 之后才有真实长度）
 * @returns {Array<object>} 每团云的基准位置与漂浮参数
 */
function createClouds(scene, level) {
  const geometry = new THREE.SphereGeometry(1, 16, 12);
  // 半球光会把云顶照白、云底压出一层淡蓝，不用手画贴图就有体积
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff });

  // 一小团云：底边基本齐平，中间垒高，左右收窄，远看就是马里奥天空里那种云
  const PUFFS = [
    [-1.75, 0.3, 0.1, 0.95],
    [-0.55, 0.9, -0.15, 1.35],
    [0.85, 0.95, 0.05, 1.45],
    [2.1, 0.4, -0.1, 1.0],
    [0.15, 0.2, 0.35, 1.15]
  ];

  const rng = seededRandom(2026);
  const clouds = [];
  const from = level.startX - 22;
  const to = level.finishX + 30;
  const count = 19;

  for (let i = 0; i < count; i += 1) {
    const group = new THREE.Group();

    PUFFS.forEach(([x, y, z, radius]) => {
      const puff = new THREE.Mesh(geometry, material);
      puff.position.set(x, y, z);
      puff.scale.setScalar(radius);
      group.add(puff);
    });

    const baseX = from + ((to - from) * (i + rng() * 0.9)) / count;
    const baseY = level.groundY + 11.5 + rng() * 4;
    group.position.set(baseX, baseY, level.laneZ - 19 - rng() * 16);
    group.scale.setScalar(0.8 + rng() * 0.95);
    scene.add(group);

    clouds.push({
      group,
      baseX,
      baseY,
      phase: rng() * Math.PI * 2,
      speed: 0.18 + rng() * 0.22,
      sway: 1.4 + rng() * 2.2
    });
  }

  return clouds;
}

/**
 * 背景里的假山：马里奥远景里那种圆顶小山，正面上两个深绿椭圆斑点。
 *
 * 和云一样用基础几何体拼：半球当山体、压扁的球当斑点，共用一份几何体和材质。
 * 站的位置贴着地面方块的后沿——再往远处放，脚下没有地面，山就会悬在半空。
 *
 * @param {THREE.Scene} scene 场景
 * @param {object} level 关卡数据（提供长度、地面高度与跑道纵深）
 * @param {number} backZ 地面方块后沿的纵深，山从这里往后排
 */
function createHills(scene, level, backZ) {
  // 上半球：底面正好在 y = 0，直接坐在地面上
  const bodyGeometry = new THREE.SphereGeometry(1, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  // 自发光压平受光差异：阳光方向跟着角色跑，远处的山会一侧偏暗，加点底色就不会忽明忽暗
  const bodyMaterial = new THREE.MeshLambertMaterial({
    color: 0x63c14f,
    emissive: 0x2f7c34,
    emissiveIntensity: 0.4
  });
  const spotGeometry = new THREE.SphereGeometry(1, 12, 10);
  const spotMaterial = new THREE.MeshLambertMaterial({
    color: 0x2c9440,
    emissive: 0x175c26,
    emissiveIntensity: 0.35
  });

  const rng = seededRandom(811);
  const count = 8;
  const from = level.startX - 26;
  const to = level.finishX + 26;

  for (let i = 0; i < count; i += 1) {
    const group = new THREE.Group();

    // 横向拉宽、纵向压低，才像远处的丘陵，不像一根柱子
    const width = 7 + rng() * 5;
    const height = width * (0.42 + rng() * 0.14);
    const depth = width * 0.8;

    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    body.scale.set(width / 2, height, depth / 2);
    group.add(body);

    // 两个斑点贴在正面：位置按椭球面反解，边缘才不会浮在空气中
    [-1, 1].forEach((side, index) => {
      const u = 0.32 + index * 0.1;
      const v = 0.28 + index * 0.14;
      const k = Math.sqrt(Math.max(0.05, 1 - u * u - v * v));

      const spot = new THREE.Mesh(spotGeometry, spotMaterial);
      spot.position.set(
        side * u * width * 0.5,
        v * height,
        k * depth * 0.5 + 0.05
      );
      spot.scale.set(width * 0.1, height * 0.19, width * 0.05);
      group.add(spot);
    });

    const x = from + ((to - from) * (i + rng() * 0.8)) / count;
    // 稍微坐进地面一点，山脚和地面后沿之间不留缝
    group.position.set(x, level.groundY - 0.35, backZ - rng() * 3);
    // 稍微转个角度，别排成一字
    group.rotation.y = (rng() - 0.5) * 0.5;
    scene.add(group);
  }
}

/**
 * 从管道网格的顶点里聚类出每一根管道
 * 关卡模型把所有管道合并在一个 Mesh 里，这里按 X 方向聚类，
 * 再按高度筛掉地下关卡的管道，只留下地面上需要跳过去的。
 */
function extractPipes(mesh, groundY) {
  const position = mesh.geometry.attributes.position;
  const vertex = new THREE.Vector3();
  const points = [];

  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
    points.push([vertex.x, vertex.y]);
  }
  points.sort((a, b) => a[0] - b[0]);

  // 间隙大于 0.8 视为两根不同的管道
  const clusters = [];
  let current = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (points[i][0] - points[i - 1][0] > 0.8) {
      clusters.push(current);
      current = [];
    }
    current.push(points[i]);
  }
  clusters.push(current);

  const pipes = [];
  clusters.forEach((cluster) => {
    const minX = cluster[0][0];
    const maxX = cluster[cluster.length - 1][0];
    const top = Math.max(...cluster.map((p) => p[1]));
    const bottom = Math.min(...cluster.map((p) => p[1]));

    // 必须立在地面上，且高度在合理范围（排除地下关卡的管道）
    if (top - groundY < 1.2 || top - groundY > 5) return;
    if (bottom > groundY + 0.5) return;

    pipes.push({
      type: 'pipe',
      x: (minX + maxX) / 2,
      top,
      halfWidth: (maxX - minX) / 2
    });
  });

  return pipes;
}

/**
 * 预计算整段关卡的地形高度（地面 + 楼梯）
 * 用射线从上往下打，得到每个采样点的真实表面高度。
 * 这里不做平滑：角色必须严丝合缝地站在台阶上，平滑会导致他陷进方块里。
 * 视觉上的起伏由角色自己的垂直阻尼处理。
 *
 * 同时记下「射线打空」的位置：那里是地面的缺口（悬崖），
 * 角色必须跳过去而不是浮在空气中走过去。
 *
 * @returns {(x: number) => number} 给定横坐标返回地表高度（附带 pits 数组）
 */
function createHeightField(meshes, level) {
  const ray = new THREE.Raycaster();
  const origin = new THREE.Vector3();
  const down = new THREE.Vector3(0, -1, 0);

  const step = 0.25;
  const x0 = level.startX - 4;
  const count = Math.ceil((level.finishX + 4 - x0) / step) + 1;

  const data = new Float32Array(count);
  const solid = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const x = x0 + i * step;
    origin.set(x, 30, level.laneZ);
    ray.set(origin, down);
    const hit = ray.intersectObjects(meshes, false)[0];
    solid[i] = hit ? 1 : 0;
    data[i] = hit ? Math.max(hit.point.y, level.groundY) : level.groundY;
  }

  const heightAt = (x) => {
    const t = Math.min(count - 1, Math.max(0, (x - x0) / step));
    const i = Math.floor(t);
    const f = t - i;
    const a = data[i];
    const b = data[Math.min(count - 1, i + 1)];
    return a + (b - a) * f;
  };

  // 把连续打空的采样点合并成一段悬崖
  heightAt.pits = [];
  let runStart = -1;
  for (let i = 0; i <= count; i++) {
    const empty = i < count && !solid[i];
    if (empty && runStart < 0) {
      runStart = i;
    } else if (!empty && runStart >= 0) {
      const fromX = x0 + runStart * step;
      const toX = x0 + (i - 1) * step;
      // 太窄的缺口可能是采样抖动，忽略
      if (toX - fromX >= 0.5) heightAt.pits.push({ fromX, toX });
      runStart = -1;
    }
  }

  return heightAt;
}

/**
 * 找出楼梯中间的凹槽：两段高台夹着一段低处
 *
 * 关卡里有两处「楼梯金字塔」，左右两半之间是空档：
 * 角色应该从左边台顶跳到右边台顶，而不是先掉进凹槽再爬上来。
 *
 * @param {(x: number) => number} heightAt 地形高度函数
 * @param {object} level 关卡数据（提供 groundY / startX / finishX）
 * @returns {Array<{fromX: number, fromY: number, toX: number, toY: number}>}
 */
function findStairValleys(heightAt, level) {
  const step = 0.25;
  // 比地面高出一级台阶以上才算「高台」
  const elevated = level.groundY + 2;

  const samples = [];
  for (let x = level.startX; x <= level.finishX; x += step) {
    samples.push({ x, y: heightAt(x) });
  }

  const valleys = [];
  let runStart = -1;
  for (let i = 0; i <= samples.length; i++) {
    const low = i < samples.length && samples[i].y < elevated;

    if (low && runStart < 0) {
      runStart = i;
    } else if (!low && runStart >= 0) {
      const left = samples[runStart - 1];
      const right = i < samples.length ? samples[i] : null;
      const width = samples[i - 1].x - samples[runStart].x;

      // 两侧都必须是高台，且凹槽不能太宽（否则是真悬崖，另有处理）
      if (left && right && left.y >= elevated && right.y >= elevated && width <= 4.5) {
        valleys.push({ fromX: left.x, fromY: left.y, toX: right.x, toY: right.y });
      }
      runStart = -1;
    }
  }

  return valleys;
}

/**
 * 把旗杆和旗面拆成两个网格
 *
 * level.glb 里旗杆、杆顶圆球和旗面合在同一个 mesh 上，无法单独让旗面下滑。
 * 这里把几何体烘焙到世界坐标，再按三角形位置把旗面分离出来：
 * 旗面是伸到旗杆左侧的那一块，圆球和杆都在旗杆中轴附近。
 *
 * @param {THREE.Scene} scene 新网格直接加进场景（几何体已是世界坐标）
 * @param {THREE.Mesh} mesh 原始合并网格
 * @param {number} poleX 旗杆中轴的横坐标
 * @param {number} clothMinY 只有高于该高度的三角形才可能是旗面
 * @returns {{cloth: THREE.Group, travel: number}|null}
 */
function splitFlag(scene, mesh, poleX, clothMinY) {
  if (!mesh) return null;

  const geometry = mesh.geometry.clone();
  geometry.applyMatrix4(mesh.matrixWorld);

  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const uv = geometry.attributes.uv;
  const index = geometry.index;

  const pole = { pos: [], nor: [], uv: [] };
  const cloth = { pos: [], nor: [], uv: [] };

  const vertexCount = index ? index.count : position.count;
  for (let i = 0; i < vertexCount; i += 3) {
    const ids = [0, 1, 2].map((k) =>
      index ? index.getX(i + k) : i + k
    );
    const xs = ids.map((id) => position.getX(id));
    const ys = ids.map((id) => position.getY(id));
    const isCloth =
      Math.min(...xs) < poleX - 0.45 && Math.max(...ys) > clothMinY;
    const target = isCloth ? cloth : pole;

    ids.forEach((id) => {
      target.pos.push(position.getX(id), position.getY(id), position.getZ(id));
      if (normal) target.nor.push(normal.getX(id), normal.getY(id), normal.getZ(id));
      if (uv) target.uv.push(uv.getX(id), uv.getY(id));
    });
  }

  const build = (data) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(data.pos, 3));
    if (data.nor.length) geo.setAttribute('normal', new THREE.Float32BufferAttribute(data.nor, 3));
    if (data.uv.length) geo.setAttribute('uv', new THREE.Float32BufferAttribute(data.uv, 2));
    return geo;
  };

  const material = mesh.material;
  const poleGeometry = build(pole);
  scene.add(new THREE.Mesh(poleGeometry, material));

  const clothMesh = new THREE.Mesh(build(cloth), material);
  const clothGroup = new THREE.Group();
  clothGroup.add(clothMesh);
  scene.add(clothGroup);

  // 原来的合并网格隐藏掉（几何体已经被拆开重建）
  mesh.visible = false;

  if (!cloth.pos.length) return null;

  const clothBox = new THREE.Box3().setFromBufferAttribute(clothMesh.geometry.attributes.position);
  const poleBox = new THREE.Box3().setFromBufferAttribute(poleGeometry.attributes.position);
  // 旗面下滑到旗杆底部上方一点点的位置
  const travel = poleBox.min.y + 0.35 - clothBox.min.y;

  return { cloth: clothGroup, travel };
}

/* ---------------------------------------------------------------- 场景搭建 */

/**
 * 创建 3D 场景
 * @param {HTMLCanvasElement} canvas 页面上的 canvas 元素
 * @returns {object} scene / camera / renderer / load / update / render / onResize
 */
export function createGameScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = createSkyTexture();
  scene.fog = new THREE.Fog(0xd8f0ff, 40, 120);

  const camera = new THREE.PerspectiveCamera(
    44,
    window.innerWidth / window.innerHeight,
    0.1,
    500
  );

  /* ------------------------------ 灯光 ------------------------------ */
  // 关卡贴图自带烘焙光照（unlit 材质），灯光主要用于照亮马里奥
  const hemisphere = new THREE.HemisphereLight(0xffffff, 0x9ec9ff, 1.6);
  scene.add(hemisphere);

  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(8, 18, 14);
  scene.add(sun);

  const rim = new THREE.DirectionalLight(0xbfe0ff, 0.8);
  rim.position.set(-10, 6, -8);
  scene.add(rim);

  /**
   * 关卡数据（load() 之后填充）
   * 由动画控制器与角色共用，避免各处重复计算
   */
  const level = {
    startX: 0,
    finishX: 100,
    length: 100,
    groundY: 0,
    laneZ: 0,
    obstacles: [],
    pits: [],
    valleys: [],
    coins: [],
    heightAt: () => 0
  };

  const coinGroups = [];
  let clouds = [];

  /* ------------------------------ 加载资源 ------------------------------ */

  /** 带字节进度的 GLB 加载：loadAsync 拿不到进度，这里包一层 */
  function loadGltf(loader, url, onProgress) {
    return new Promise((resolve, reject) => {
      loader.load(
        url,
        resolve,
        (event) => {
          if (onProgress && event.lengthComputable) onProgress(event.loaded / event.total);
        },
        reject
      );
    });
  }

  /** 先试云端，失败就把同一份模型从站点本地再取一次 */
  async function loadGltfWithFallback(loader, remote, local, onProgress) {
    try {
      return await loadGltf(loader, remote, onProgress);
    } catch (error) {
      console.warn('[scene] 云端模型加载失败，改用本地副本：', remote, error);
      return loadGltf(loader, local, onProgress);
    }
  }

  async function load(onProgress) {
    const loader = new GLTFLoader();
    // 两个文件并行下载，各自报自己的比例，按文件数摊到 0~1
    const report = (index) => (ratio) => {
      if (onProgress) onProgress((index + ratio) / 2);
    };
    const [levelGltf, coinGltf] = await Promise.all([
      loadGltfWithFallback(loader, LEVEL_URL, LEVEL_FALLBACK, report(0)),
      loadGltfWithFallback(loader, COIN_URL, COIN_FALLBACK, report(1))
    ]);

    // ---- 关卡 ----
    const levelScene = levelGltf.scene;
    scene.add(levelScene);
    levelScene.updateMatrixWorld(true);

    const groundMesh = findMesh(levelScene, 'ground1', 'underground');
    const stairMesh = findMesh(levelScene, 'flagblock');
    const pipeMesh = findMesh(levelScene, 'pipe1');
    const flagMesh = findMesh(levelScene, 'flag_0');

    const bounds = new THREE.Box3().setFromObject(levelScene);
    const groundBox = new THREE.Box3().setFromObject(groundMesh);
    const pipeBox = new THREE.Box3().setFromObject(pipeMesh);
    const flagBox = flagMesh
      ? new THREE.Box3().setFromObject(flagMesh)
      : new THREE.Box3();

    // 地面顶面高度、跑道所在的纵深
    level.groundY = groundBox.max.y;
    level.laneZ = (pipeBox.min.z + pipeBox.max.z) / 2;
    level.startX = bounds.min.x + 6;

    // 旗杆中轴（旗杆是旗面 mesh 里最右侧的那根细柱）
    const poleX = flagBox.max.x - 0.25;
    // 终点停在旗杆脚下
    level.finishX = poleX - 1.3;
    level.length = level.finishX - level.startX;

    // 地形高度（地面 + 楼梯），角色贴地行走
    level.heightAt = createHeightField([groundMesh, stairMesh], level);
    // 楼梯金字塔中间的凹槽：从一侧台顶跳到另一侧台顶
    level.valleys = findStairValleys(level.heightAt, level);
    // 跑道上的地面缺口（悬崖），需要跳过去；楼梯凹槽已单独处理
    level.pits = level.heightAt.pits.filter(
      (pit) =>
        !level.valleys.some(
          (valley) => pit.fromX >= valley.fromX - 0.5 && pit.toX <= valley.toX + 0.5
        )
    );
    // 需要跳跃跨越的管道
    level.obstacles = extractPipes(pipeMesh, level.groundY);

    level.poleX = poleX;
    // 最后一级台阶之后是断崖：让角色从楼梯顶跳下，落到旗杆前的平地
    const leapFromX = 131.2;
    const leapToX = leapFromX + 5;
    level.leap = {
      fromX: leapFromX,
      fromY: level.heightAt(leapFromX),
      toX: leapToX,
      toY: level.groundY
    };

    // 旗面单独拆出来，终点时沿旗杆滑下
    level.flag = splitFlag(scene, flagMesh, poleX, 10);

    // 天空：铺满整段关卡的白云
    clouds = createClouds(scene, level);
    // 远景：贴着地面后沿排开的圆顶假山
    createHills(scene, level, groundBox.min.z - 1);

    // ---- 金币 ----
    // 金币模型带一根骨骼但没有动画，直接取几何体生成普通 Mesh，方便随意摆放
    let coinMesh = null;
    coinGltf.scene.traverse((object) => {
      if (!coinMesh && object.isMesh) coinMesh = object;
    });

    // 原始贴图偏暗，换成干净的金色材质，卡通感更强
    const coinMaterial = new THREE.MeshStandardMaterial({
      color: 0xffcb3d,
      emissive: 0xff9f1c,
      emissiveIntensity: 0.35,
      metalness: 0.4,
      roughness: 0.3
    });

    const addCoin = (x, y) => {
      const group = new THREE.Group();
      const mesh = new THREE.Mesh(coinMesh.geometry, coinMaterial);
      mesh.scale.setScalar(1.15);
      group.add(mesh);
      group.position.set(x, y, level.laneZ);
      scene.add(group);
      level.coins.push({ group, x, baseY: y });
      coinGroups.push(group);
    };

    // 管道上方的三连金币
    level.obstacles.forEach((obstacle) => {
      for (let i = -1; i <= 1; i++) {
        addCoin(
          obstacle.x + i * 1.4,
          obstacle.top + 0.9 + (1 - Math.abs(i)) * 0.7
        );
      }
    });

    // 贴地金币（避开管道、悬崖缺口与最后跳下的断崖区域）
    for (let x = level.startX + 12; x < level.finishX - 3; x += COIN_SPACING) {
      if (level.obstacles.some((o) => Math.abs(o.x - x) < 2.8)) continue;
      if (x > level.leap.fromX - 1 && x < level.leap.toX + 1) continue;
      if (level.pits.some((p) => x > p.fromX - 1.2 && x < p.toX + 1.2)) continue;
      addCoin(x, level.heightAt(x) + COIN_GROUND_OFFSET);
    }

    return level;
  }

  /* ------------------------------ 每帧更新 ------------------------------ */
  const clock = new THREE.Clock();

  function update(marioX) {
    const dt = Math.min(clock.getDelta(), 0.05);

    // 金币自转
    coinGroups.forEach((group) => {
      group.rotation.y += dt * 3.2;
    });

    // 云慢慢横移 + 上下浮，每团速度不同，天空才不像一张贴图
    const t = clock.elapsedTime;
    clouds.forEach((cloud) => {
      cloud.group.position.x =
        cloud.baseX + Math.sin(t * cloud.speed + cloud.phase) * cloud.sway;
      cloud.group.position.y =
        cloud.baseY + Math.sin(t * cloud.speed * 0.7 + cloud.phase) * 0.28;
    });

    // 阳光跟着角色移动，保证角色始终有稳定的受光方向
    sun.position.set(marioX + 8, 18, 14);
    sun.target.position.set(marioX, 0, 0);
    sun.target.updateMatrixWorld();
  }

  function render() {
    renderer.render(scene, camera);
  }

  function onResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
  }

  return { scene, camera, renderer, level, load, update, render, onResize };
}
