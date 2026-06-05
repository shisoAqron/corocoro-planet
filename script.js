/* =========================================================
   ころころ星あつめ  -  script.js
   ---------------------------------------------------------
   仕様の肝:
   - 画面中央の「枠」へ、外側から惑星を投げ入れる
   - 投げ入れた向き = 枠内の重力方向（左から入れる→重力は右 など）
   - 同じ段階の惑星が接触すると合体して1段階大きく
   - 密度が上がると重力側の壁から少しずつ「はみ出し」、
     限界を超えると（一定時間継続で）ゲームオーバー

   物理は「遊んでわかりやすい」近似。位置ベースの緩和ソルバで
   安定性を優先し、壁は“やわらかい”ので押し負けるとはみ出す。
   ========================================================= */

(() => {
  'use strict';

  // ---------------- DOM参照 ----------------
  const canvas   = document.getElementById('game');
  const ctx      = canvas.getContext('2d');
  const stageEl  = document.getElementById('stage');
  const scoreEl  = document.getElementById('scoreValue');
  const bestEl   = document.getElementById('bestValue');
  const gravArrowEl = document.getElementById('gravArrow');
  const warningEl   = document.getElementById('warning');
  const hintTextEl  = document.getElementById('hintText');

  const tutorialEl  = document.getElementById('tutorial');
  const gameoverEl  = document.getElementById('gameover');
  const finalScoreEl= document.getElementById('finalScore');
  const finalBestEl = document.getElementById('finalBest');
  const newRecordEl = document.getElementById('newRecord');

  // ---------------- 惑星の定義（段階＝種類） ----------------
  // 半径は「枠の短辺(base)」に対する比率。小さい順に7段階。
  // 小さい3段階(0,1,2)だけがランダムで出現する。
  const PLANETS = [
    { name:'青小惑星', rMul:0.052, c1:'#bfe6ff', c2:'#3f97ff', c3:'#1c5fd0', kind:'plain' },
    { name:'月',       rMul:0.064, c1:'#eef1f6', c2:'#b7bfce', c3:'#7d869a', kind:'moon'  },
    { name:'赤い惑星', rMul:0.080, c1:'#ffd0a8', c2:'#ff7a52', c3:'#c83a2a', kind:'mars'  },
    { name:'縞惑星',   rMul:0.100, c1:'#ffe6b0', c2:'#f0a23c', c3:'#c87a2a', kind:'striped' },
    { name:'土星',     rMul:0.122, c1:'#ffe9b8', c2:'#e6b362', c3:'#b07c2a', kind:'saturn' },
    { name:'地球',     rMul:0.146, c1:'#bff0ff', c2:'#3aa0ff', c3:'#1860c0', kind:'earth' },
    { name:'ガス惑星', rMul:0.176, c1:'#d7c4ff', c2:'#9b6bff', c3:'#5a2fb0', kind:'gas'   },
    // 最終段階：ブラックホール。ガス惑星より1〜2回り大きい特別な存在（誕生直後に巻き込んで弾ける）。
    { name:'ブラックホール', rMul:0.230, c1:'#000000', c2:'#1a0a2a', c3:'#3a1060', kind:'blackhole' },
  ];

  const MAX_LEVEL = PLANETS.length - 1;            // = ブラックホール
  // 合体結果レベルごとの得点（最後はブラックホール誕生ボーナス）
  const SCORE_FOR = [0, 1, 3, 6, 10, 15, 21, 50];
  const MISS_PENALTY = 15;   // 投げた惑星が枠に入らず画面外へ消えたときの減点

  // ---------------- 物理パラメータ（遊びやすさ優先で調整） ----------------
  const GRAVITY      = 2600;   // 重力加速度(px/s^2 相当)
  const DAMPING      = 0.86;   // 速度の減衰（ねっとり詰まる感じ）
  const WALL_SOFT    = 0.45;   // 壁の押し戻し率(0-1)。小さいほど“はみ出しやすい”
  const SOLVER_ITERS = 6;      // 衝突解決の反復回数
  const SUBSTEPS     = 2;      // 1フレームの最小分割数
  const MAX_SUBSTEPS = 10;     // 高速な惑星のすり抜け防止用の最大分割数
  const MAX_OUT_MUL  = 0.6;    // 壁外へ出られる最大量（半径比）。完全脱出を防ぐ
  const FRAME_W_RATIO = 0.9;   // 枠の横幅比（高さに対して少し狭くする。1.0で正方形）
  const THROW_SPEED   = 1300;  // 投入の基本速度
  const THROW_COOLDOWN= 0.42;  // 連続投入の最小間隔(秒)

  // 合体の接触判定。衝突ソルバは重なりを解消して中心間距離を
  // ほぼ (r1+r2) に保つため、「触れている＝合体」とみなす必要がある。
  // (r1+r2) にわずかな余裕(スロップ)を持たせて、接触を取りこぼさない。
  const MERGE_TOUCH   = 1.08;

  // ブラックホール（最終段階）の挙動。誕生→短い寿命の間に周囲を吸い寄せ→弾ける。
  const BH_LIFE       = 0.9;     // 寿命(秒)。誕生後この時間で爆発
  const BH_PULL       = 280000;  // 引力の強さ（大きくなった分すこし強め）
  const BH_PULL_MAX   = 5600;    // 引力加速度の上限（暴れ防止）
  // 爆発時の巻き込み半径（自半径比）。本体が大きいほど巻き込み範囲も大きくなる。
  const BH_ABSORB_MUL = 2.3;     // r=0.23*base のとき実半径 ≈ 0.53*base

  // ---------------- 隕石（お邪魔オブジェクト） ----------------
  // 顔なし・ボコボコの岩。いろんな方向から飛んできて、枠内に入ると重力方向へ落ちる。
  // デバッグ用に有無と頻度を調整できる（画面の🛠パネル / コンソール window.coroDebug）。
  const DEBUG = {
    meteorsEnabled: true,   // 隕石を出すか
    meteorInterval: 5,      // 基準の平均出現間隔(秒)。得点で短くなる
  };
  window.coroDebug = DEBUG; // コンソールから coroDebug.meteorInterval = 3 等で調整可

  const METEOR_SPEED = 1.1;  // 飛来速度（base比 /秒）。ゆっくりめ
  const METEOR_ANGLE_SPREAD = 0.7; // 中央方向からの角度ブレ(±rad ≈ 40°)。枠を外すこともある
  // 得点が上がるほど出現間隔を短縮（1点あたり METEOR_SPEEDUP 秒ずつ、下限 METEOR_INTERVAL_MIN）
  const METEOR_SPEEDUP = 0.004;     // 例: 500点で -2.0秒
  const METEOR_INTERVAL_MIN = 1.5;  // 最短間隔(秒)
  const METEOR_HP = 5;              // 隣で惑星が合体／投入惑星の衝突でこの回数に達すると壊れる
  const METEOR_BLAST_RANGE_MUL = 3.0; // 破壊時の吹き飛ばし範囲（自半径比）
  const METEOR_BLAST_SPEED = 1.6;     // 破壊時の吹き飛ばし強さ（base比の最大速度）
  // グラフィックパターン（色違いの岩）。表面の凹凸・クレーターは個体ごとにランダム生成。
  const METEOR_STYLES = [
    { c1:'#a89884', c2:'#6f5f4d', c3:'#3e342a' }, // 茶色い岩
    { c1:'#bcbcc6', c2:'#7d7d88', c3:'#474752' }, // 灰色の岩
    { c1:'#8a6f5a', c2:'#574436', c3:'#2c2118' }, // 焦げ茶の岩
    { c1:'#7e9092', c2:'#4d5d5f', c3:'#283536' }, // 青灰の岩
  ];

  // はみ出し危険度のしきい値。
  // dangerは「最大まではみ出した惑星の個数」相当（各惑星0〜1の合計）。
  const WARN_DANGER   = 1.2;   // これ以上で「ピンチ！」警告
  const OVER_DANGER   = 3.5;   // これを一定時間こえるとゲームオーバー
  const OVER_TIME     = 1.4;   // 継続秒数
  const INSTANT_OVER  = 6.0;   // 一気にこえたら即アウト

  // ---------------- 状態 ----------------
  let DPR = 1;
  let W = 0, H = 0;            // CSSピクセルでのステージサイズ
  let frame = { x:0, y:0, w:0, h:0 };  // 枠の矩形（CSSpx）
  let base = 1;               // 枠短辺
  let planets = [];           // 場の惑星
  let particles = [];         // 演出パーティクル
  let scorePops = [];         // スコアポップ
  let stars = [];             // 背景の星

  let gravDir = { x: 1, y: 0 };   // 現在の重力方向（単位ベクトル,4方位）
  let gravArrowFade = 0;          // 枠内に出す大きな矢印の表示残量

  let score = 0;
  let best = Number(localStorage.getItem('coro_best') || 0);

  let nextLevel = randSpawnLevel();
  let staging = null;     // 構え中の惑星 {x,y,level,r,side,dir}
  let dragging = false;
  let cooldown = 0;       // 投入クールダウン
  let dangerTimer = 0;    // 危険継続時間
  let meteorTimer = 0;    // 次の隕石までの残り時間
  let running = false;    // ゲーム進行中か
  let soundOn = localStorage.getItem('coro_sound') !== 'off';
  let shake = 0;          // 画面シェイク量

  let pointer = { x:0, y:0 };
  let lastPointer = { x:0, y:0 };
  let flickVel = { x:0, y:0 };
  let pressStart = { x:0, y:0 };       // ジェスチャ開始点（タッチした位置）

  // ====================================================
  //  初期化・レイアウト
  // ====================================================
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2.5);
    const rect = stageEl.getBoundingClientRect();
    W = rect.width;
    H = rect.height;
    canvas.width  = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    // 枠は中央。外周に投入＆はみ出し用の余白(band)を残す。
    const band = Math.min(W, H) * 0.12;        // 外側の帯
    const availW = W - band * 2;
    const availH = H - band * 2;
    const side = Math.min(availW, availH, 460); // 基準サイズ（高さ）
    frame.h = side;
    frame.w = side * FRAME_W_RATIO;             // 横幅は少し狭く
    frame.x = (W - frame.w) / 2;
    frame.y = (H - frame.h) / 2;
    base = Math.min(frame.w, frame.h);          // 惑星サイズ等は狭い方(横幅)に合わせる

    // 既存惑星の半径を再計算（リサイズ追従）
    for (const p of planets) p.r = p.isMeteor ? p.rMul * base : radiusOf(p.level);
    if (staging) staging.r = radiusOf(staging.level);

    buildStars();
  }

  function buildStars() {
    stars = [];
    const n = Math.floor((W * H) / 6000);
    for (let i = 0; i < n; i++) {
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: Math.random() * 1.4 + 0.3,
        a: Math.random() * 0.6 + 0.2,
        tw: Math.random() * Math.PI * 2,
      });
    }
  }

  function radiusOf(level) { return PLANETS[level].rMul * base; }
  function randSpawnLevel() {
    const r = Math.random();
    return r < 0.5 ? 0 : (r < 0.82 ? 1 : 2); // 小さいほど出やすい
  }

  // ====================================================
  //  ゲーム開始・リセット
  // ====================================================
  function startGame() {
    planets = [];
    particles = [];
    scorePops = [];
    score = 0;
    cooldown = 0;
    dangerTimer = 0;
    meteorTimer = meteorIntervalNow();
    shake = 0;
    gravDir = { x: 1, y: 0 };
    gravArrowFade = 0;
    nextLevel = randSpawnLevel();
    updateScoreUI();
    spawnStaging();
    hideWarning();
    gameoverEl.classList.add('hidden');
    running = true;
    setHint('星をフリック／ドラッグして投げ入れよう！<br><b>投げた向きに重力が変わる！</b>');
  }

  // 次の惑星を用意。待機中は枠の下の外側に「次の惑星」として表示しておく。
  // タッチすると、その指の位置へ移動して構える。
  function spawnStaging() {
    const r = radiusOf(nextLevel);
    staging = {
      level: nextLevel, r,
      x: frame.x + frame.w / 2,
      y: frame.y + frame.h + r + base * 0.05,
      aim: { x: 0, y: -1 },   // 待機中のヒント矢印（上向き）
    };
  }

  // ====================================================
  //  入力（ポインタ：タッチ＆マウス共通）
  // ====================================================
  function getPos(e) {
    const rect = stageEl.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  }

  function onDown(e) {
    if (!running || cooldown > 0 || !staging) return;
    e.preventDefault();
    dragging = true;
    pressStart = pointer = lastPointer = getPos(e);
    flickVel = { x: 0, y: 0 };
    // タッチした位置へ惑星を移動（ここから投げ入れる）
    moveStagingTo(pointer.x, pointer.y);
    staging.aim = computeAim();
  }

  function onMove(e) {
    if (!dragging) return;
    e.preventDefault();
    const p = getPos(e);
    flickVel.x = flickVel.x * 0.6 + (p.x - lastPointer.x) * 0.4;
    flickVel.y = flickVel.y * 0.6 + (p.y - lastPointer.y) * 0.4;
    lastPointer = p;
    pointer = p;
    // 惑星は指に追従（＝投げ入れ位置）、向きはフリック/ドラッグから決定
    moveStagingTo(p.x, p.y);
    staging.aim = computeAim();
  }

  function onUp(e) {
    if (!dragging) return;
    e.preventDefault();
    dragging = false;
    throwPlanet();
  }

  // 構え中の惑星を指の位置へ。ただし「枠の中からは投げない」ため、
  // 枠の内側に入った場合は最寄りの辺の外側へ押し出す（＝必ず枠外から投げる）。
  function moveStagingTo(px, py) {
    if (!staging) return;
    const r = staging.r;
    let x = clamp(px, r, W - r);
    let y = clamp(py, r, H - r);

    const L = frame.x, R = frame.x + frame.w, T = frame.y, B = frame.y + frame.h;
    if (x > L && x < R && y > T && y < B) {        // 中心が枠内 → 枠外へ
      const dl = x - L, dr = R - x, dt = y - T, db = B - y;
      const m = Math.min(dl, dr, dt, db);
      if      (m === dl) x = L - r;                // 最寄りの辺の外側（惑星が枠外に出る位置）
      else if (m === dr) x = R + r;
      else if (m === dt) y = T - r;
      else               y = B + r;
    }
    staging.x = x;
    staging.y = y;
  }

  // 投げる向き（＝重力方向）を求める。
  // ドラッグ量が十分ならその向き、ほぼ動いていなければ枠の中心方向。
  function computeAim() {
    const gx = pointer.x - pressStart.x, gy = pointer.y - pressStart.y;
    const gmag = Math.hypot(gx, gy);
    if (gmag > base * 0.04) return { x: gx / gmag, y: gy / gmag };
    // 動かさずタップ → 枠の中心へ投げ入れる
    let dx = (frame.x + frame.w / 2) - staging.x;
    let dy = (frame.y + frame.h / 2) - staging.y;
    const d = Math.hypot(dx, dy) || 1;
    return { x: dx / d, y: dy / d };
  }

  // 投入：タッチした位置から、aim 方向へ速度を与えて放つ。重力もその向きへ。
  function throwPlanet() {
    if (!staging) return;
    const dir = computeAim();

    // 枠外へ投げるのは許可（入らなければ後述の checkMissedThrows で減点）。
    // フリック/ドラッグの勢いで少しだけ速くなる
    const flickMag = Math.hypot(flickVel.x, flickVel.y);
    const speed = THROW_SPEED + clamp(flickMag * 22, 0, 700);

    const p = makePlanet(staging.level, staging.x, staging.y);
    p.vx = dir.x * speed;
    p.vy = dir.y * speed;
    p.entered = false;   // 枠内に入るまで壁判定をしない
    p.thrown = true;     // 投げた惑星（枠外へ消えたら減点対象）
    planets.push(p);

    // 重力方向を投げた向きへ切り替え（任意角度）
    setGravity(dir.x, dir.y);
    playThrow();
    spawnTrail(p, dir);

    // 次の惑星を用意（クールダウン後に構える）
    nextLevel = randSpawnLevel();
    staging = null;
    cooldown = THROW_COOLDOWN;
  }

  // (x,y) から dir 方向のレイが枠の矩形に当たるか（＝惑星の中心が枠内に入りうるか）
  function willEnterFrame(x, y, dir) {
    const L = frame.x, R = frame.x + frame.w, T = frame.y, B = frame.y + frame.h;
    if (x >= L && x <= R && y >= T && y <= B) return true; // 始点が枠内
    let tmin = 0, tmax = Infinity;
    if (Math.abs(dir.x) < 1e-6) {
      if (x < L || x > R) return false;
    } else {
      let t1 = (L - x) / dir.x, t2 = (R - x) / dir.x;
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    }
    if (Math.abs(dir.y) < 1e-6) {
      if (y < T || y > B) return false;
    } else {
      let t1 = (T - y) / dir.y, t2 = (B - y) / dir.y;
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    }
    return tmax >= tmin && tmax > 0;
  }

  // 重力方向を任意角度で設定。上部インジケータの矢印を回転表示する。
  function setGravity(x, y) {
    const len = Math.hypot(x, y) || 1;
    gravDir = { x: x / len, y: y / len };
    gravArrowFade = 1.4; // 枠内に大きな矢印を一定時間表示
    const deg = Math.atan2(gravDir.y, gravDir.x) * 180 / Math.PI;
    gravArrowEl.textContent = '→';
    gravArrowEl.style.transform = `rotate(${deg}deg)`;
  }

  function makePlanet(level, x, y) {
    const p = {
      level, x, y, vx: 0, vy: 0,
      r: radiusOf(level),
      entered: true,
      merging: 0,      // 合体直後の演出スケール
      spin: Math.random() * Math.PI * 2,
      out: 0,          // 現在のはみ出し率（描画/危険度用）
      id: Math.random(),
    };
    // ブラックホールは「誕生→寿命カウント→爆発」する特別な惑星
    if (PLANETS[level].kind === 'blackhole') {
      p.blackhole = true;
      p.fuse = BH_LIFE;
    }
    return p;
  }

  // ====================================================
  //  物理更新
  // ====================================================
  function update(dt) {
    if (cooldown > 0) {
      cooldown -= dt;
      if (cooldown <= 0 && running && !staging) {
        cooldown = 0;
        spawnStaging();
      }
    }

    if (running) {
      // 速い惑星（投げた直後など）が他をすり抜けないよう、
      // 「1サブステップでの移動量が最小惑星の半径の半分以下」になるよう分割数を自動調整。
      let maxSpeed = 0;
      for (const p of planets) {
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > maxSpeed) maxSpeed = sp;
      }
      const maxMove = base * PLANETS[0].rMul * 0.5; // 最小惑星の半径の半分
      let nSub = SUBSTEPS;
      if (maxMove > 0 && maxSpeed * dt > maxMove) {
        nSub = Math.ceil((maxSpeed * dt) / maxMove);
      }
      nSub = clamp(nSub, SUBSTEPS, MAX_SUBSTEPS);

      const sub = dt / nSub;
      for (let s = 0; s < nSub; s++) step(sub);
      handleMerges();
      updateBlackholes(dt);   // 寿命カウント＆爆発
      updateMeteors(dt);      // 隕石の回転・出現
      checkMissedThrows();    // 枠に入らず外へ消えた投入は減点
      computeDanger(dt);
    }

    // 演出更新
    updateParticles(dt);
    updateScorePops(dt);
    if (gravArrowFade > 0) gravArrowFade -= dt;
    if (shake > 0) shake = Math.max(0, shake - dt * 60);

    // 背景の星のまたたき
    for (const st of stars) st.tw += dt * 2;
  }

  function step(dt) {
    const L = frame.x, R = frame.x + frame.w, T = frame.y, B = frame.y + frame.h;

    // 0) ブラックホールの引力：周囲の惑星を中心へ吸い寄せる（位置更新前に速度へ加算）
    for (const bh of planets) {
      if (!bh.blackhole) continue;
      for (const p of planets) {
        if (p === bh || p.blackhole) continue;
        const dx = bh.x - p.x, dy = bh.y - p.y;
        const d = Math.hypot(dx, dy) || 1;
        const accel = Math.min(BH_PULL / d, BH_PULL_MAX);
        p.vx += (dx / d) * accel * dt;
        p.vy += (dy / d) * accel * dt;
      }
    }

    // 1) 重力＋速度積分
    for (const p of planets) {
      if (p.entered) {
        // 枠内：重力で落ち、減衰でねっとり詰まる
        p.vx += gravDir.x * GRAVITY * dt;
        p.vy += gravDir.y * GRAVITY * dt;
        const d = Math.pow(DAMPING, dt * 60);
        p.vx *= d; p.vy *= d;
      }
      // ↑ 枠外を飛行中(!entered)は減衰なしで直進させ、確実に枠へ入れる
      // 速度クランプ（安定化）
      const maxv = base * 30;
      p.vx = clamp(p.vx, -maxv, maxv);
      p.vy = clamp(p.vy, -maxv, maxv);
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      // 枠内に入ったら壁判定を有効化
      if (!p.entered && p.x > L && p.x < R && p.y > T && p.y < B) {
        p.entered = true;
      }
    }

    // 2) 衝突解決（位置ベースの反復）
    for (let it = 0; it < SOLVER_ITERS; it++) {
      // 惑星同士
      for (let i = 0; i < planets.length; i++) {
        for (let j = i + 1; j < planets.length; j++) {
          resolvePair(planets[i], planets[j]);
        }
      }
      // 壁（やわらかい：押し戻し率 WALL_SOFT）
      for (const p of planets) {
        if (!p.entered) continue;
        resolveWalls(p, L, R, T, B);
      }
    }
  }

  function resolvePair(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    let dist = Math.hypot(dx, dy);
    const min = a.r + b.r;
    if (dist >= min || dist === 0) {
      if (dist === 0) { b.x += 0.5; } // 完全重なり回避
      return;
    }
    // 投げた惑星が何かにぶつかった瞬間の処理（隕石なら耐久を1削る）
    handleProjectileImpact(a, b);

    const overlap = min - dist;
    const nx = dx / dist, ny = dy / dist;
    // 質量 = 面積比。大きい惑星ほど動きにくい
    const ma = a.r * a.r, mb = b.r * b.r;
    const total = ma + mb;
    const corr = overlap * 0.8;
    a.x -= nx * corr * (mb / total);
    a.y -= ny * corr * (mb / total);
    b.x += nx * corr * (ma / total);
    b.y += ny * corr * (ma / total);
    // 速度を法線方向にやや殺す（跳ねすぎ防止）
    const rvn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (rvn < 0) {
      const imp = rvn * 0.5;
      a.vx += nx * imp * (mb / total);
      a.vy += ny * imp * (mb / total);
      b.vx -= nx * imp * (ma / total);
      b.vy -= ny * imp * (ma / total);
    }
  }

  // 投げた惑星(projectile)が最初に何かへ衝突した瞬間に1回だけ呼ばれる。
  // 相手が隕石なら耐久を1削る。以後は通常の惑星として扱う（多重ヒット防止）。
  function handleProjectileImpact(a, b) {
    let proj = null, other = null;
    if (a.thrown && !a.isMeteor) { proj = a; other = b; }
    else if (b.thrown && !b.isMeteor) { proj = b; other = a; }
    if (!proj) return;
    proj.thrown = false;                 // 着弾＝もう飛翔体ではない
    if (other.isMeteor && !other.dead) hitMeteor(other);
  }

  // やわらかい壁：はみ出しても WALL_SOFT 分しか戻さない＝混むとはみ出す。
  // ただし MAX_OUT までで頭打ち（完全脱出は防止）。
  function resolveWalls(p, L, R, T, B) {
    const maxOut = p.r * MAX_OUT_MUL;
    // 左
    if (p.x - p.r < L) {
      const pen = L - (p.x - p.r);
      p.x += pen * WALL_SOFT;
      if (p.x - p.r < L - maxOut) p.x = L - maxOut + p.r;
      if (p.vx < 0) p.vx *= 0.4;
    }
    // 右
    if (p.x + p.r > R) {
      const pen = (p.x + p.r) - R;
      p.x -= pen * WALL_SOFT;
      if (p.x + p.r > R + maxOut) p.x = R + maxOut - p.r;
      if (p.vx > 0) p.vx *= 0.4;
    }
    // 上
    if (p.y - p.r < T) {
      const pen = T - (p.y - p.r);
      p.y += pen * WALL_SOFT;
      if (p.y - p.r < T - maxOut) p.y = T - maxOut + p.r;
      if (p.vy < 0) p.vy *= 0.4;
    }
    // 下
    if (p.y + p.r > B) {
      const pen = (p.y + p.r) - B;
      p.y -= pen * WALL_SOFT;
      if (p.y + p.r > B + maxOut) p.y = B + maxOut - p.r;
      if (p.vy > 0) p.vy *= 0.4;
    }
  }

  // ====================================================
  //  合体処理
  // ====================================================
  function handleMerges() {
    for (let i = 0; i < planets.length; i++) {
      for (let j = i + 1; j < planets.length; j++) {
        const a = planets[i], b = planets[j];
        if (a.dead || b.dead) continue;
        if (a.blackhole || b.blackhole) continue; // ブラックホールは合体しない
        if (a.isMeteor || b.isMeteor) continue;   // 隕石は合体しない（お邪魔）
        if (a.level !== b.level) continue;
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        // 接触していれば合体（ソルバ後は dist ≈ r1+r2 なので、わずかな余裕で判定）
        if (dist <= (a.r + b.r) * MERGE_TOUCH) {
          mergePair(a, b);
        }
      }
    }
    planets = planets.filter(p => !p.dead);
  }

  function mergePair(a, b) {
    a.dead = b.dead = true;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;

    // 隣で合体が起きた隕石にダメージ（3回で破壊）
    damageAdjacentMeteors(a, b);

    // ブラックホール同士は合体させない（誕生直後に弾ける一過性の存在のため）
    const newLevel = a.level + 1;
    const np = makePlanet(newLevel, mx, my);
    np.vx = (a.vx + b.vx) / 2;
    np.vy = (a.vy + b.vy) / 2;
    np.merging = 1; // ぽよん演出
    planets.push(np);

    addScore(SCORE_FOR[newLevel], mx, my);

    if (np.blackhole) {
      // ガス惑星×ガス惑星 → ブラックホール誕生（爆発は寿命到達時）
      burst(mx, my, '#b07aff', 22);
      burst(mx, my, '#7af0ff', 12);
      shake = 9;
      playBlackholeBorn();
    } else {
      burst(mx, my, PLANETS[newLevel].c2, 12);
      shake = Math.min(6, 2 + newLevel);
      playMerge(0.7 + newLevel * 0.05);
    }
  }

  // 合体した2惑星(a,b)に接している隕石へダメージ。METEOR_HP 回で破壊。
  function damageAdjacentMeteors(a, b) {
    const slop = base * 0.04;
    for (const m of planets) {
      if (!m.isMeteor || m.dead) continue;
      const touchA = Math.hypot(m.x - a.x, m.y - a.y) <= m.r + a.r + slop;
      const touchB = Math.hypot(m.x - b.x, m.y - b.y) <= m.r + b.r + slop;
      if (touchA || touchB) hitMeteor(m);
    }
  }

  function hitMeteor(m) {
    m.hits = (m.hits || 0) + 1;
    if (m.hits >= METEOR_HP) {
      breakMeteor(m);
    } else {
      // ひびが入る：かけらが少し飛ぶ
      burst(m.x, m.y, '#cfc2a8', 6, 0.4);
      shake = Math.max(shake, 3);
      playMeteorCrack();
    }
  }

  function breakMeteor(m) {
    m.dead = true;   // handleMerges 側でまとめて除去される

    // 周りを軽く吹き飛ばす（近いほど強く、範囲外はゼロ）
    const R = m.r * METEOR_BLAST_RANGE_MUL;
    const power = base * METEOR_BLAST_SPEED;
    for (const p of planets) {
      if (p === m || p.dead) continue;
      const dx = p.x - m.x, dy = p.y - m.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d < R) {
        const f = (1 - d / R) * power;
        p.vx += (dx / d) * f;
        p.vy += (dy / d) * f;
      }
    }

    burst(m.x, m.y, '#8a7a64', 16, 0.7);
    burst(m.x, m.y, '#cfc2a8', 10, 0.5);
    shake = Math.max(shake, 6);
    playMeteorBreak();
  }

  // ブラックホールの寿命管理。寿命が尽きたら爆発させる。
  function updateBlackholes(dt) {
    let exploded = false;
    for (const bh of planets) {
      if (!bh.blackhole || bh.dead) continue;
      bh.fuse -= dt;
      bh.spin += dt * 14;          // 速い渦巻き
      bh.merging = 0;              // ぽよん演出は使わない
      if (bh.fuse <= 0) { explodeBlackhole(bh); exploded = true; }
    }
    if (exploded) planets = planets.filter(p => !p.dead);
  }

  // 爆発：周囲の惑星を巻き込んで消し、巻き込んだ数に応じて大量加点。
  function explodeBlackhole(bh) {
    bh.dead = true;
    const R = bh.r * BH_ABSORB_MUL;
    let absorbed = 0;
    for (const p of planets) {
      if (p === bh || p.dead || p.blackhole) continue;
      if (Math.hypot(p.x - bh.x, p.y - bh.y) < R) { p.dead = true; absorbed++; }
    }
    const pts = 100 + absorbed * 30;
    addScore(pts, bh.x, bh.y);
    // 派手な爆発演出。本体サイズ(巻き込み半径)に合わせて飛び散る範囲と量を調整。
    const spread = (R / base) * 1.6;   // 巻き込み半径まで届くように
    burst(bh.x, bh.y, '#c89bff', 54, spread);
    burst(bh.x, bh.y, '#7af0ff', 38, spread * 0.7);
    burst(bh.x, bh.y, '#ffffff', 22, spread * 0.45);
    shake = 22;
    playBlackholePop();
  }

  // ====================================================
  //  隕石（お邪魔オブジェクト）
  // ====================================================
  // 出現タイマー管理＆回転更新。枠内に入ると（entered）通常の重力に従って落ちる。
  function updateMeteors(dt) {
    // 回転（飛来中もくるくる回る）＋枠に入らず画面外へ去ったものを掃除
    const margin = base;
    let gone = false;
    for (const p of planets) {
      if (!p.isMeteor) continue;
      p.spin += p.spinV * dt;
      // 枠に入った隕石は重力で残る。未進入のまま画面外へ大きく出たら消す。
      if (!p.entered &&
          (p.x < -margin || p.x > W + margin || p.y < -margin || p.y > H + margin)) {
        p.dead = true;
        gone = true;
      }
    }
    if (gone) planets = planets.filter(p => !p.dead);

    // 出現
    if (!DEBUG.meteorsEnabled) return;
    meteorTimer -= dt;
    if (meteorTimer <= 0) {
      spawnMeteor();
      // 間隔は ±30% でばらつかせる
      meteorTimer = meteorIntervalNow() * (0.7 + Math.random() * 0.6);
    }
  }

  // 現在の出現間隔（秒）。基準値から得点に応じて短縮し、下限でクランプ。
  function meteorIntervalNow() {
    return Math.max(METEOR_INTERVAL_MIN, DEBUG.meteorInterval - score * METEOR_SPEEDUP);
  }

  function rand(a, b) { return a + Math.random() * (b - a); }

  // 画面端のどこかから、中央方向±αのランダムな角度で飛来させる。
  // 角度ブレにより、枠の中に入らずそのまま通り過ぎる隕石もある。
  function spawnMeteor() {
    const rMul = rand(0.05, 0.09);
    const r = rMul * base;
    const cx = frame.x + frame.w / 2, cy = frame.y + frame.h / 2;

    // 画面端のランダムな位置（少し外側）から出現
    const side = ['left', 'right', 'top', 'bottom'][(Math.random() * 4) | 0];
    const off = r + 6;
    let x, y;
    if (side === 'left')       { x = -off;     y = rand(0, H); }
    else if (side === 'right') { x = W + off;  y = rand(0, H); }
    else if (side === 'top')   { y = -off;     x = rand(0, W); }
    else                       { y = H + off;  x = rand(0, W); }

    // 画面中央方向を基準に角度をばらつかせる
    const baseAng = Math.atan2(cy - y, cx - x);
    const ang = baseAng + (Math.random() * 2 - 1) * METEOR_ANGLE_SPREAD;
    const speed = base * METEOR_SPEED;

    const m = makeMeteor(x, y, r, rMul);
    m.vx = Math.cos(ang) * speed;
    m.vy = Math.sin(ang) * speed;
    planets.push(m);
  }

  // 隕石オブジェクト。表面の凹凸とクレーターは生成時に固定（パターン＝色違いの岩）。
  function makeMeteor(x, y, r, rMul) {
    const style = (Math.random() * METEOR_STYLES.length) | 0;
    const n = 9 + ((Math.random() * 4) | 0);       // 凹凸の頂点数
    const bumps = [];
    for (let i = 0; i < n; i++) bumps.push(0.78 + Math.random() * 0.3);
    const craters = [];
    const cn = 2 + ((Math.random() * 3) | 0);
    for (let i = 0; i < cn; i++) {
      craters.push({ a: Math.random() * Math.PI * 2, d: Math.random() * 0.5, s: 0.12 + Math.random() * 0.16 });
    }
    // ダメージ表示用のひび（半径比で保持。被弾数ぶん表示）。最大 METEOR_HP-1 本。
    const cracks = [];
    for (let i = 0; i < METEOR_HP - 1; i++) {
      const a = Math.random() * Math.PI * 2;
      const steps = 3 + ((Math.random() * 2) | 0);
      const seg = [];
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const rad = t * (0.85 + Math.random() * 0.1);
        const ang = a + (Math.random() - 0.5) * 0.18;
        seg.push({ fx: Math.cos(ang) * rad, fy: Math.sin(ang) * rad });
      }
      cracks.push(seg);
    }
    return {
      isMeteor: true, level: -1,
      x, y, vx: 0, vy: 0, r, rMul, style, bumps, craters, cracks,
      entered: false, out: 0, hits: 0,
      spin: Math.random() * Math.PI * 2,
      spinV: (Math.random() - 0.5) * 4,
      id: Math.random(),
    };
  }

  // 投げた惑星が枠に入らないまま画面外へ消えたら減点して除去する。
  function checkMissedThrows() {
    const m = base * 0.8;
    let changed = false;
    for (const p of planets) {
      if (p.isMeteor || p.blackhole || p.entered || !p.thrown) continue;
      if (p.x < -m || p.x > W + m || p.y < -m || p.y > H + m) {
        p.dead = true;
        changed = true;
        addScore(-MISS_PENALTY, clamp(p.x, 0, W), clamp(p.y, 0, H), '#ff6b7a');
        playMiss();
      }
    }
    if (changed) planets = planets.filter(q => !q.dead);
  }

  function addScore(pts, x, y, color) {
    score += pts;
    if (score < 0) score = 0;       // スコアはマイナスにしない
    updateScoreUI();
    const txt = (pts >= 0 ? '+' : '') + pts;
    scorePops.push({ x, y, txt, life: 1, vy: -base * 0.6, color: color || '#ffd95e' });
  }

  function updateScoreUI() {
    scoreEl.textContent = score;
    if (score > best) {
      best = score;
      localStorage.setItem('coro_best', best);
    }
    bestEl.textContent = best;
  }

  // ====================================================
  //  はみ出し危険度判定
  // ====================================================
  function computeDanger(dt) {
    const L = frame.x, R = frame.x + frame.w, T = frame.y, B = frame.y + frame.h;
    let danger = 0;
    for (const p of planets) {
      if (!p.entered) { p.out = 0; continue; }
      // 各壁のはみ出し量の最大
      const out = Math.max(
        0,
        L - (p.x - p.r),
        (p.x + p.r) - R,
        T - (p.y - p.r),
        (p.y + p.r) - B
      );
      // はみ出し率：最大はみ出し量(MAX_OUT_MUL*r)で1.0になるよう正規化
      const ratio = clamp(out / (p.r * MAX_OUT_MUL), 0, 1);
      p.out = ratio;
      danger += ratio;
    }

    // 警告表示
    if (danger >= WARN_DANGER) showWarning();
    else hideWarning();

    // ゲームオーバー判定（一定危険が継続 or 一気に超過）
    if (danger >= OVER_DANGER) {
      dangerTimer += dt;
    } else {
      dangerTimer = Math.max(0, dangerTimer - dt * 1.5);
    }
    if (dangerTimer >= OVER_TIME || danger >= INSTANT_OVER) {
      gameOver();
    }
  }

  function showWarning() {
    warningEl.classList.remove('hidden');
    setHint('はみださないように<b>星を入れよう！</b>');
  }
  function hideWarning() {
    warningEl.classList.add('hidden');
  }

  function gameOver() {
    if (!running) return;
    running = false;
    dragging = false;
    hideWarning();
    playGameOver();
    shake = 14;
    const isRecord = score >= best && score > 0;
    finalScoreEl.textContent = score;
    finalBestEl.textContent = best;
    newRecordEl.classList.toggle('hidden', !isRecord);
    setTimeout(() => gameoverEl.classList.remove('hidden'), 500);
  }

  // ====================================================
  //  描画
  // ====================================================
  function render() {
    ctx.clearRect(0, 0, W, H);

    // 画面シェイク
    let sx = 0, sy = 0;
    if (shake > 0) { sx = (Math.random()-0.5)*shake; sy = (Math.random()-0.5)*shake; }
    ctx.save();
    ctx.translate(sx, sy);

    drawBackground();
    drawFrame();
    drawGravityArrow();

    // 枠の外に出た部分も見えるよう、クリップせず描画
    for (const p of planets) drawPlanet(p);

    // 構え中の惑星＋投入ガイド
    if (staging && running && cooldown <= 0) drawStaging();

    drawParticles();
    drawScorePops();

    ctx.restore();
  }

  function drawBackground() {
    // 背景の星
    for (const st of stars) {
      const a = st.a * (0.6 + 0.4 * Math.sin(st.tw));
      ctx.globalAlpha = a;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawFrame() {
    const { x, y, w, h } = frame;
    const r = 18;
    ctx.save();
    // 内側のほのかな発光
    ctx.fillStyle = 'rgba(40,70,160,0.12)';
    roundRect(x, y, w, h, r); ctx.fill();
    // ネオン枠（二重）
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(69,231,255,0.25)';
    ctx.lineWidth = 10; roundRect(x, y, w, h, r); ctx.stroke();
    ctx.strokeStyle = '#7af0ff';
    ctx.lineWidth = 3.5;
    ctx.shadowColor = '#45e7ff';
    ctx.shadowBlur = 16;
    roundRect(x, y, w, h, r); ctx.stroke();
    ctx.restore();
  }

  // 枠内に出す大きな重力矢印（投入直後に一定時間表示）
  function drawGravityArrow() {
    if (gravArrowFade <= 0) return;
    const a = clamp(gravArrowFade / 1.4, 0, 1) * 0.5;
    const cx = frame.x + frame.w / 2, cy = frame.y + frame.h / 2;
    const len = base * 0.26;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.atan2(gravDir.y, gravDir.x));
    ctx.globalAlpha = a;
    ctx.fillStyle = '#ffd95e';
    ctx.shadowColor = '#ffd95e';
    ctx.shadowBlur = 18;
    // 矢印（棒＋三角）
    const bw = len * 0.5, bh = base * 0.07;
    ctx.beginPath();
    ctx.rect(-len*0.55, -bh/2, bw, bh);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(len*0.0, -bh*1.6);
    ctx.lineTo(len*0.55, 0);
    ctx.lineTo(len*0.0, bh*1.6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // 投入ガイド（構え中）：惑星本体＋内向きの矢印＋点線軌道
  function drawStaging() {
    const s = staging;
    const aim = s.aim || { x: 0, y: 1 };
    drawPlanetShape(s.x, s.y, s.r, s.level, 0);

    // この向きで枠に入るか（入らないなら赤＝投げられない警告）
    const ok = willEnterFrame(s.x, s.y, aim);
    const lineCol = ok ? 'rgba(122,240,255,0.5)' : 'rgba(255,90,108,0.7)';
    const arrowCol = ok ? '#7af0ff' : '#ff5e6c';
    const glowCol  = ok ? '#45e7ff' : '#ff5e6c';

    // 投げる向きの点線軌道（惑星から aim 方向へ、枠を横切るように）
    ctx.save();
    ctx.strokeStyle = lineCol;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.moveTo(s.x + aim.x * s.r, s.y + aim.y * s.r);
    ctx.lineTo(s.x + aim.x * base * 0.95, s.y + aim.y * base * 0.95);
    ctx.stroke();
    ctx.restore();

    // 投げる向きの矢印
    const ang = Math.atan2(aim.y, aim.x);
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(ang);
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = arrowCol;
    ctx.shadowColor = glowCol;
    ctx.shadowBlur = 10;
    const off = s.r + base * 0.02;
    ctx.beginPath();
    ctx.moveTo(off, -base*0.03);
    ctx.lineTo(off + base*0.06, 0);
    ctx.lineTo(off, base*0.03);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // 惑星の描画（はみ出し中は少し赤く危険表示）
  function drawPlanet(p) {
    if (p.isMeteor) { drawMeteor(p); return; }
    if (p.blackhole) { drawBlackhole(p); return; }
    const scale = p.merging > 0 ? 1 + p.merging * 0.18 : 1;
    drawPlanetShape(p.x, p.y, p.r * scale, p.level, p.spin, p.out);
    if (p.merging > 0) p.merging = Math.max(0, p.merging - 0.06);
  }

  // ブラックホール：渦巻く降着円盤＋暗いコア＋フォトンリング。
  // 寿命が近づくほど発光が強まり、わずかに膨張する（爆発前の予兆）。
  function drawBlackhole(p) {
    const r = p.r;
    const t = clamp(1 - p.fuse / BH_LIFE, 0, 1);       // 0(誕生)→1(爆発直前)
    const pulse = 1 + Math.sin(p.spin * 3) * 0.04 + t * 0.18;
    ctx.save();
    ctx.translate(p.x, p.y);

    // 外周の発光
    ctx.shadowColor = '#a06bff';
    ctx.shadowBlur = r * (0.9 + t * 1.2);

    // 降着円盤（回転する楕円リングを重ねる）
    ctx.rotate(p.spin);
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = 0.55 - i * 0.13;
      ctx.strokeStyle = i % 2 ? '#7af0ff' : '#c89bff';
      ctx.lineWidth = r * 0.16;
      ctx.beginPath();
      ctx.ellipse(0, 0, r * (1.15 + i * 0.13) * pulse, r * (0.46 + i * 0.07) * pulse, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.rotate(-p.spin);
    ctx.shadowBlur = 0;

    // 暗いコア
    const core = r * 0.78;
    const g = ctx.createRadialGradient(0, 0, core * 0.1, 0, 0, core);
    g.addColorStop(0, '#000000');
    g.addColorStop(0.7, '#0a0420');
    g.addColorStop(1, 'rgba(60,20,110,0.7)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, core, 0, Math.PI * 2); ctx.fill();

    // フォトンリング（明るい縁）
    ctx.strokeStyle = `rgba(210,190,255,${0.8 + t * 0.2})`;
    ctx.lineWidth = Math.max(1.5, r * 0.06);
    ctx.shadowColor = '#c89bff'; ctx.shadowBlur = r * 0.4;
    ctx.beginPath(); ctx.arc(0, 0, core, 0, Math.PI * 2); ctx.stroke();

    ctx.restore();
  }

  // 隕石：顔なし・ボコボコの岩。凹凸ポリゴン＋クレーターで岩肌を表現。
  function drawMeteor(p) {
    const st = METEOR_STYLES[p.style];
    const r = p.r, n = p.bumps.length;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.spin);

    // ボコボコの輪郭（半径を頂点ごとに変えたポリゴン）
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = (i % n) / n * Math.PI * 2;
      const rr = r * p.bumps[i % n];
      const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath();

    // 本体グラデーション
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = r * 0.3;
    const g = ctx.createRadialGradient(-r*0.3, -r*0.35, r*0.1, 0, 0, r);
    g.addColorStop(0, st.c1);
    g.addColorStop(0.6, st.c2);
    g.addColorStop(1, st.c3);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.shadowBlur = 0;

    // 輪郭線
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = Math.max(1, r * 0.05);
    ctx.stroke();

    // クレーター（輪郭でクリップして内側だけに）
    ctx.clip();
    for (const c of p.craters) {
      const cx = Math.cos(c.a) * c.d * r, cy = Math.sin(c.a) * c.d * r;
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      circleAt(cx, cy, c.s * r);
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      circleAt(cx - c.s*r*0.3, cy - c.s*r*0.3, c.s * r * 0.7);
    }

    // ダメージのひび（被弾数ぶん表示）。割れが進むほど濃く・太く。
    const hits = p.hits || 0;
    if (hits > 0 && p.cracks) {
      // 被弾で全体がやや暗く（傷んだ感じ）
      ctx.fillStyle = `rgba(20,12,6,${0.12 * hits})`;
      circleAt(0, 0, r);
      ctx.strokeStyle = 'rgba(15,10,6,0.9)';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let i = 0; i < hits && i < p.cracks.length; i++) {
        const seg = p.cracks[i];
        ctx.lineWidth = Math.max(1, r * (0.05 + i * 0.02));
        ctx.beginPath();
        for (let j = 0; j < seg.length; j++) {
          const px = seg[j].fx * r, py = seg[j].fy * r;
          j ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
        ctx.stroke();
      }
    }

    // はみ出し中の危険オーバーレイ
    if (p.out > 0.05) {
      ctx.globalAlpha = Math.min(0.5, p.out);
      ctx.fillStyle = '#ff5e6c';
      circleAt(0, 0, r);
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  // 実際の惑星グラフィック。kind ごとに模様を描き、顔をつける。
  function drawPlanetShape(x, y, r, level, spin, out = 0) {
    const def = PLANETS[level];
    ctx.save();
    ctx.translate(x, y);

    // 土星のリング（本体の後ろ側）
    if (def.kind === 'saturn') {
      ctx.save();
      ctx.rotate(-0.4);
      ctx.strokeStyle = 'rgba(255,230,180,0.85)';
      ctx.lineWidth = r * 0.16;
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 1.5, r * 0.5, 0, Math.PI*0.05, Math.PI*0.95);
      ctx.stroke();
      ctx.restore();
    }

    // 発光
    ctx.shadowColor = def.c2;
    ctx.shadowBlur = r * 0.5;

    // 本体（放射グラデーション）
    const g = ctx.createRadialGradient(-r*0.3, -r*0.35, r*0.1, 0, 0, r);
    g.addColorStop(0, def.c1);
    g.addColorStop(0.55, def.c2);
    g.addColorStop(1, def.c3);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // 模様（円でクリップ）
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.clip();
    drawPattern(def, r, spin);
    ctx.restore();

    // はみ出し中の危険オーバーレイ
    if (out > 0.05) {
      ctx.globalAlpha = Math.min(0.5, out);
      ctx.fillStyle = '#ff5e6c';
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI*2); ctx.fill();
      ctx.globalAlpha = 1;
    }

    // ハイライト
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(-r*0.32, -r*0.36, r*0.22, 0, Math.PI*2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // 顔（目は重力方向をちょっと見る）
    drawFace(r);

    // 縁取り
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = Math.max(1, r * 0.04);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI*2); ctx.stroke();

    ctx.restore();
  }

  function drawPattern(def, r, spin) {
    switch (def.kind) {
      case 'moon':
        ctx.fillStyle = 'rgba(120,130,150,0.5)';
        circleAt(-r*0.3, r*0.2, r*0.18);
        circleAt(r*0.25, -r*0.15, r*0.12);
        circleAt(r*0.1, r*0.35, r*0.09);
        break;
      case 'mars':
        ctx.fillStyle = 'rgba(150,40,25,0.4)';
        circleAt(-r*0.2, -r*0.2, r*0.22);
        circleAt(r*0.3, r*0.25, r*0.16);
        break;
      case 'striped':
      case 'saturn': {
        const bands = ['rgba(255,255,255,0.18)','rgba(120,70,20,0.22)'];
        for (let i = -3; i <= 3; i++) {
          ctx.fillStyle = bands[(i+3) % 2];
          ctx.fillRect(-r, i*r*0.28 - r*0.12, r*2, r*0.2);
        }
        break;
      }
      case 'earth':
        ctx.fillStyle = 'rgba(60,200,120,0.85)';
        blob(-r*0.25, -r*0.1, r*0.3);
        blob(r*0.2, r*0.25, r*0.26);
        blob(r*0.35, -r*0.3, r*0.16);
        break;
      case 'gas': {
        const bands = ['rgba(255,255,255,0.16)','rgba(80,40,150,0.3)'];
        for (let i = -3; i <= 3; i++) {
          ctx.fillStyle = bands[(i+3) % 2];
          ctx.fillRect(-r, i*r*0.3 - r*0.14, r*2, r*0.22);
        }
        // 大赤斑風
        ctx.fillStyle = 'rgba(255,120,150,0.5)';
        circleAt(r*0.3, r*0.1, r*0.18);
        break;
      }
      default: // plain (青小惑星)
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        circleAt(r*0.2, r*0.2, r*0.18);
    }
  }

  function drawFace(r) {
    const ex = r * 0.34, ey = -r * 0.05, er = r * 0.17;
    // 目（重力方向に少し寄せる）
    const lookx = gravDir.x * r * 0.05, looky = gravDir.y * r * 0.05;
    ctx.fillStyle = '#ffffff';
    circleAt(-ex, ey, er);
    circleAt(ex, ey, er);
    ctx.fillStyle = '#222';
    circleAt(-ex + lookx, ey + looky, er * 0.55);
    circleAt(ex + lookx, ey + looky, er * 0.55);
    // ほっぺ
    ctx.fillStyle = 'rgba(255,130,160,0.5)';
    circleAt(-ex - r*0.05, ey + r*0.28, r*0.12);
    circleAt(ex + r*0.05, ey + r*0.28, r*0.12);
    // 口（にっこり）
    ctx.strokeStyle = '#3a2230';
    ctx.lineWidth = Math.max(1.2, r * 0.05);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(0, ey + r*0.18, r*0.2, 0.15*Math.PI, 0.85*Math.PI);
    ctx.stroke();
  }

  // ====================================================
  //  演出（パーティクル・スコアポップ）
  // ====================================================
  // spread: 飛び散る勢いの倍率（大きいほど遠くまで広がる）
  function burst(x, y, color, n, spread = 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (Math.random() * 0.5 + 0.3) * base * spread;
      particles.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        r: Math.random() * base * 0.02 + base * 0.008,
        life: 1, color,
        star: Math.random() < 0.4,
      });
    }
  }
  function spawnTrail(p, dir) {
    for (let i = 0; i < 8; i++) {
      particles.push({
        x: p.x - dir.x * i * p.r * 0.3,
        y: p.y - dir.y * i * p.r * 0.3,
        vx: -dir.x * base * 0.1, vy: -dir.y * base * 0.1,
        r: p.r * (0.3 - i*0.03), life: 0.6, color: '#7af0ff', star: false,
      });
    }
  }
  function updateParticles(dt) {
    for (const pt of particles) {
      pt.x += pt.vx * dt; pt.y += pt.vy * dt;
      pt.vx *= 0.92; pt.vy *= 0.92;
      pt.life -= dt * 1.6;
    }
    particles = particles.filter(p => p.life > 0);
  }
  function drawParticles() {
    for (const pt of particles) {
      ctx.globalAlpha = Math.max(0, pt.life);
      ctx.fillStyle = pt.color;
      ctx.shadowColor = pt.color; ctx.shadowBlur = 8;
      if (pt.star) drawStarShape(pt.x, pt.y, pt.r * 1.6);
      else { ctx.beginPath(); ctx.arc(pt.x, pt.y, pt.r, 0, Math.PI*2); ctx.fill(); }
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  }
  function updateScorePops(dt) {
    for (const s of scorePops) { s.y += s.vy * dt; s.life -= dt; }
    scorePops = scorePops.filter(s => s.life > 0);
  }
  function drawScorePops() {
    ctx.textAlign = 'center';
    ctx.font = `bold ${Math.round(base*0.07)}px 'Baloo 2', sans-serif`;
    for (const s of scorePops) {
      const col = s.color || '#ffd95e';
      ctx.globalAlpha = Math.max(0, s.life);
      ctx.fillStyle = col;
      ctx.shadowColor = col; ctx.shadowBlur = 10;
      ctx.fillText(s.txt, s.x, s.y);
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  }

  // ====================================================
  //  描画ヘルパ
  // ====================================================
  function circleAt(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fill(); }
  function blob(x, y, r) {
    ctx.beginPath();
    for (let i = 0; i <= 8; i++) {
      const a = (i/8)*Math.PI*2;
      const rr = r * (0.8 + 0.2*Math.sin(i*2.3));
      const px = x + Math.cos(a)*rr, py = y + Math.sin(a)*rr;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath(); ctx.fill();
  }
  function drawStarShape(x, y, r) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (i/10)*Math.PI*2 - Math.PI/2;
      const rr = i % 2 ? r*0.45 : r;
      const px = x + Math.cos(a)*rr, py = y + Math.sin(a)*rr;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath(); ctx.fill();
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x+r, y);
    ctx.arcTo(x+w, y, x+w, y+h, r);
    ctx.arcTo(x+w, y+h, x, y+h, r);
    ctx.arcTo(x, y+h, x, y, r);
    ctx.arcTo(x, y, x+w, y, r);
    ctx.closePath();
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // ====================================================
  //  サウンド（WebAudioの簡易シンセ。外部ファイル不要）
  // ====================================================
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { audioCtx = null; }
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }
  function beep(freq, dur, type = 'sine', vol = 0.2) {
    if (!soundOn || !audioCtx) return;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.value = vol;
    o.connect(g); g.connect(audioCtx.destination);
    const t = audioCtx.currentTime;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.start(t); o.stop(t + dur);
  }
  function playThrow() { beep(420, 0.12, 'triangle', 0.18); }
  function playMerge(p) { beep(440 * p, 0.1, 'sine', 0.22); beep(660 * p, 0.12, 'sine', 0.16); }
  function playGameOver() { beep(300, 0.25, 'sawtooth', 0.2); setTimeout(()=>beep(200,0.4,'sawtooth',0.2),120); }
  // ブラックホール誕生：不穏に立ち上がる低音
  function playBlackholeBorn() { beep(180, 0.3, 'sawtooth', 0.18); beep(110, 0.55, 'sine', 0.14); }
  // ブラックホール爆発：低くうなって弾ける
  function playBlackholePop() { beep(90, 0.45, 'sawtooth', 0.26); setTimeout(()=>{ beep(60, 0.6, 'triangle', 0.22); beep(520, 0.18, 'sine', 0.16); }, 70); }
  // 枠に入らず減点：下降するブザー
  function playMiss() { beep(300, 0.14, 'sawtooth', 0.2); setTimeout(()=>beep(180, 0.22, 'sawtooth', 0.2), 90); }
  // 隕石のひび／破壊：硬い「コツッ」と「パキッ」
  function playMeteorCrack() { beep(260, 0.06, 'square', 0.14); }
  function playMeteorBreak() { beep(160, 0.12, 'square', 0.2); setTimeout(()=>beep(90, 0.18, 'sawtooth', 0.16), 50); }

  // ====================================================
  //  メインループ
  // ====================================================
  let lastT = 0;
  function loop(t) {
    const dt = Math.min((t - lastT) / 1000 || 0, 1/30);
    lastT = t;
    update(dt);
    render();
    requestAnimationFrame(loop);
  }

  // ====================================================
  //  UI（チュートリアル・各種ボタン）
  // ====================================================
  let tutSlide = 0;
  const tutTotal = 3;
  function showTutorialSlide(i) {
    tutSlide = i;
    document.querySelectorAll('.tut-slide').forEach(el => {
      el.classList.toggle('active', Number(el.dataset.slide) === i);
    });
    document.querySelectorAll('.dot').forEach(el => {
      el.classList.toggle('active', Number(el.dataset.dot) === i);
    });
    document.getElementById('tutNext').textContent = (i === tutTotal - 1) ? 'スタート！' : 'つぎへ';
  }
  function openTutorial() { tutorialEl.classList.remove('hidden'); showTutorialSlide(0); }
  function closeTutorial() {
    tutorialEl.classList.add('hidden');
    ensureAudio();
    if (!running) startGame();
  }

  function setHint(html) { hintTextEl.innerHTML = html; }

  function bindUI() {
    document.getElementById('tutNext').addEventListener('click', () => {
      if (tutSlide < tutTotal - 1) showTutorialSlide(tutSlide + 1);
      else closeTutorial();
    });
    document.getElementById('helpBtn').addEventListener('click', () => {
      // ヘルプ中は進行を止めない（モーダルで覆うだけ）
      openTutorial();
    });
    document.getElementById('retryBtn').addEventListener('click', () => {
      ensureAudio();
      startGame();
    });
    document.getElementById('gearBtn').addEventListener('click', (e) => {
      soundOn = !soundOn;
      localStorage.setItem('coro_sound', soundOn ? 'on' : 'off');
      e.currentTarget.classList.toggle('muted', !soundOn);
      e.currentTarget.textContent = soundOn ? '⚙️' : '🔇';
      if (soundOn) ensureAudio();
    });

    // ポインタ操作（タッチ＆マウス）
    stageEl.addEventListener('touchstart', onDown, { passive: false });
    stageEl.addEventListener('touchmove',  onMove, { passive: false });
    stageEl.addEventListener('touchend',   onUp,   { passive: false });
    stageEl.addEventListener('mousedown',  onDown);
    window.addEventListener('mousemove',   onMove);
    window.addEventListener('mouseup',     onUp);

    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => setTimeout(resize, 200));

    bindDebugPanel();
  }

  // デバッグパネル（隕石の有無・頻度）。画面の🛠ボタンで開閉。
  function bindDebugPanel() {
    const toggle   = document.getElementById('debugToggle');
    const body     = document.getElementById('debugBody');
    const chkMeteor= document.getElementById('dbgMeteor');
    const interval = document.getElementById('dbgInterval');
    const intervalVal = document.getElementById('dbgIntervalVal');
    const spawnNow = document.getElementById('dbgSpawnNow');

    // 初期表示を設定値に合わせる
    chkMeteor.checked = DEBUG.meteorsEnabled;
    interval.value = DEBUG.meteorInterval;
    intervalVal.textContent = Number(DEBUG.meteorInterval).toFixed(1);

    toggle.addEventListener('click', () => body.classList.toggle('hidden'));

    chkMeteor.addEventListener('change', () => {
      DEBUG.meteorsEnabled = chkMeteor.checked;
      if (DEBUG.meteorsEnabled) meteorTimer = meteorIntervalNow(); // すぐ降らせすぎない
    });

    interval.addEventListener('input', () => {
      DEBUG.meteorInterval = Number(interval.value);
      intervalVal.textContent = DEBUG.meteorInterval.toFixed(1);
    });

    spawnNow.addEventListener('click', () => { if (running) spawnMeteor(); });

    // パネル操作が投入操作に化けないようイベント伝播を止める
    ['pointerdown','touchstart','mousedown'].forEach(ev =>
      document.getElementById('debugPanel').addEventListener(ev, e => e.stopPropagation()));

    // コンソールからの手動発生も可能に
    window.coroSpawnMeteor = () => { if (running) spawnMeteor(); };
  }

  // iOS Safari はビューポート設定や touch-action を無視してダブルタップ／ピンチで
  // ズームすることがあるため、JSでもガードする。
  function preventZoomGestures() {
    // ダブルタップ：直前のタップから300ms以内の2回目はデフォルト動作（ズーム）を抑止
    let lastTouchEnd = 0;
    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTouchEnd <= 300) e.preventDefault();
      lastTouchEnd = now;
    }, { passive: false });

    // ピンチズーム（gestureイベントはiOS Safari独自）
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(ev =>
      document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));

    // ページ全体の touchmove を抑止：
    //  - 横スワイプによる「戻る」ナビゲーション（iOS/Android）
    //  - ピンチズーム・スクロール・引っぱって更新
    // ※デバッグパネル内（スライダー等）だけは通常動作させる
    document.addEventListener('touchmove', (e) => {
      if (e.target.closest && e.target.closest('#debugPanel')) return;
      e.preventDefault();
    }, { passive: false });
  }

  // ====================================================
  //  起動
  // ====================================================
  function init() {
    bestEl.textContent = best;
    document.getElementById('gearBtn').classList.toggle('muted', !soundOn);
    document.getElementById('gearBtn').textContent = soundOn ? '⚙️' : '🔇';
    preventZoomGestures();
    bindUI();
    resize();
    openTutorial();          // 最初はチュートリアルから
    requestAnimationFrame(loop);
  }

  // フォント読み込み後にレイアウトが変わることがあるので軽く待つ
  window.addEventListener('load', init);
})();
