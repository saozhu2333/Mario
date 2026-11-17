/**
 * 背景音乐：用 Web Audio 现场合成超级玛丽第一关的主题。
 *
 * 不引音频文件——方波加一段短包络就够红白机那味儿，
 * 而且不用多下几百 KB，点播放的瞬间就能出声。
 * 点按是浏览器要求的用户手势，AudioContext 只能在点击里创建。
 */

/** 每分钟拍数：和游戏里一样快 */
const TEMPO = 200;

/** 一拍多少秒 */
const BEAT = 60 / TEMPO;

/** 总音量：合成方波比较冲，压低一点 */
const VOLUME = 0.16;

/**
 * 主旋律：[音名, 拍数]，null 表示休止。
 * 每小节 4 拍，五小节一循环。
 */
const MELODY = [
  // 第一小节：那段最出名的前奏
  ['E5', 0.25], ['E5', 0.25], [null, 0.25], ['E5', 0.25],
  [null, 0.25], ['C5', 0.25], ['E5', 0.5],
  ['G5', 0.75], [null, 0.25],
  ['G4', 0.75], [null, 0.25],

  // 第二小节：半音下行
  ['C5', 0.5], ['G4', 0.5], ['E4', 0.5], ['A4', 0.5],
  ['B4', 0.5], ['A#4', 0.5], ['A4', 0.5], [null, 0.5],

  // 第三小节
  ['G4', 0.5], ['E5', 0.5], ['G5', 0.5], ['A5', 0.5],
  ['F5', 0.5], ['G5', 0.5], ['E5', 0.5], [null, 0.5],

  // 第四小节
  ['C5', 0.5], ['D5', 0.5], ['B4', 0.5], [null, 0.5],
  ['G4', 0.5], ['F#4', 0.5], ['F4', 0.5], ['D#4', 0.5],

  // 第五小节
  ['E4', 0.5], [null, 0.5], ['G#4', 0.5], ['A4', 0.5],
  ['C5', 0.5], ['A4', 0.5], ['C5', 0.5], ['D5', 0.5]
];

/** 低音：每拍一个根音，跟着和声走 */
const BASS = [
  'C3', 'C3', 'G2', 'G2',
  'C3', 'G2', 'C3', 'G2',
  'F2', 'F2', 'C3', 'C3',
  'C3', 'G2', 'C3', 'G2',
  'C3', 'C3', 'G2', 'G2'
];

const SEMITONES = {
  C: 0,
  'C#': 1,
  D: 2,
  'D#': 3,
  E: 4,
  F: 5,
  'F#': 6,
  G: 7,
  'G#': 8,
  A: 9,
  'A#': 10,
  B: 11
};

/** 音名 → 频率（以 A4 = 440Hz 为基准） */
function frequency(name) {
  const match = /^([A-G]#?)(-?\d)$/.exec(name);
  if (!match) return 0;
  const semitone = SEMITONES[match[1]] + (Number(match[2]) - 4) * 12 - 9;
  return 440 * Math.pow(2, semitone / 12);
}

/**
 * 排一个音：短起音、平直保持、快速收尾，就是红白机那种干脆的音色
 */
function scheduleNote(ctx, out, name, at, duration, type, volume) {
  const hz = frequency(name);
  if (!hz) return;

  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();

  oscillator.type = type;
  oscillator.frequency.setValueAtTime(hz, at);

  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.linearRampToValueAtTime(volume, at + 0.006);
  gain.gain.setValueAtTime(volume, at + Math.max(0.03, duration - 0.05));
  gain.gain.linearRampToValueAtTime(0.0001, at + duration);

  oscillator.connect(gain).connect(out);
  oscillator.start(at);
  oscillator.stop(at + duration + 0.02);
}

/**
 * 绑定卡片里的播放 / 暂停按钮
 * 循环用 AudioContext 的时钟累加排期，不依赖 setInterval 的准点性。
 */
export function bindBgm() {
  const button = document.querySelector('[data-bgm]');
  if (!button) return;

  const player = button.closest('.player');
  const loopBeats = BASS.length;
  const loopDuration = loopBeats * BEAT;

  let ctx = null;
  let master = null;
  let timer = null;
  let nextLoopAt = 0;
  let playing = false;

  function ensureContext() {
    if (ctx) return true;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return false;

    ctx = new AudioCtx();
    master = ctx.createGain();
    master.gain.value = VOLUME;
    master.connect(ctx.destination);
    return true;
  }

  /** 排一整轮，返回下一轮的起始时间 */
  function scheduleLoop(start) {
    let at = start;

    MELODY.forEach(([name, beats]) => {
      const duration = beats * BEAT;
      if (name) scheduleNote(ctx, master, name, at, duration * 0.92, 'square', 0.13);
      at += duration;
    });

    BASS.forEach((name, index) => {
      scheduleNote(ctx, master, name, start + index * BEAT, BEAT * 0.8, 'triangle', 0.2);
    });

    return start + loopDuration;
  }

  /** 提前半秒把下一轮排进去 */
  function pump() {
    while (nextLoopAt < ctx.currentTime + 0.5) {
      nextLoopAt = scheduleLoop(nextLoopAt);
    }
  }

  function start() {
    if (!ensureContext()) return false;
    if (ctx.state === 'suspended') ctx.resume();

    nextLoopAt = Math.max(nextLoopAt, ctx.currentTime + 0.06);

    // 淡入，免得第一个音“啪”一下
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(0.0001, ctx.currentTime);
    master.gain.linearRampToValueAtTime(VOLUME, ctx.currentTime + 0.08);

    pump();
    timer = window.setInterval(pump, 200);
    return true;
  }

  function stop() {
    window.clearInterval(timer);
    timer = null;

    // 先把总音量压下去再挂起，正在响的音符不会被硬切
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
    master.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.06);

    window.setTimeout(() => {
      if (!playing) ctx.suspend();
    }, 90);
  }

  button.addEventListener('click', () => {
    if (playing) {
      playing = false;
      stop();
    } else {
      if (!start()) return;
      playing = true;
    }

    if (player) player.classList.toggle('is-playing', playing);
    button.setAttribute('aria-pressed', String(playing));
    button.setAttribute('aria-label', playing ? '暂停背景音乐' : '播放背景音乐');
  });
}
