/* The void: faint twinkling stars and slowly drifting wireframe solids. Pure canvas, no dependencies. */
(() => {
  const cv = document.getElementById("bg");
  const ctx = cv.getContext("2d");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let W = 0, H = 0, dpr = 1, stars = [], shapes = [], mx = 0, my = 0, tx = 0, ty = 0;

  const rand = (a, b) => a + Math.random() * (b - a);

  /* ---- unit solids: [vertices, edges] ---- */
  const phi = (1 + Math.sqrt(5)) / 2;
  const ico = (() => {
    const v = [[-1, phi, 0], [1, phi, 0], [-1, -phi, 0], [1, -phi, 0], [0, -1, phi], [0, 1, phi], [0, -1, -phi], [0, 1, -phi], [phi, 0, -1], [phi, 0, 1], [-phi, 0, -1], [-phi, 0, 1]];
    const n = Math.hypot(1, phi), V = v.map(p => p.map(c => c / n));
    const E = []; for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) {
      const d = Math.hypot(V[i][0] - V[j][0], V[i][1] - V[j][1], V[i][2] - V[j][2]); if (d < 1.07 / n * 2 * 0.62 + 0.6 && d < 1.12) E.push([i, j]);
    } return [V, E];
  })();
  const cube = (() => {
    const V = []; for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) V.push([x * .62, y * .62, z * .62]);
    const E = []; for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) { const d = (i ^ j); if (d === 1 || d === 2 || d === 4) E.push([i, j]); } return [V, E];
  })();
  const octa = (() => {
    const V = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const E = []; for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) if (V[i].reduce((s, c, k) => s + c * V[j][k], 0) === 0) E.push([i, j]); return [V, E];
  })();
  const ring = (() => {
    const V = [], E = [], N = 28; for (let i = 0; i < N; i++) { const a = i / N * Math.PI * 2; V.push([Math.cos(a), Math.sin(a), 0]); E.push([i, (i + 1) % N]); }
    for (let i = 0; i < N; i++) { const a = i / N * Math.PI * 2; V.push([Math.cos(a) * .6, 0, Math.sin(a) * .6]); E.push([N + i, N + (i + 1) % N]); } return [V, E];
  })();
  const kinds = [ico, cube, octa, ring, ico, octa];

  function build() {
    const area = W * H;
    const nStars = Math.round(Math.min(260, Math.max(90, area / 9000)));
    stars = Array.from({ length: nStars }, () => ({
      x: Math.random() * W, y: Math.random() * H, r: rand(0.35, 1.15), a: rand(0.12, 0.5),
      p: rand(0, 6.28), s: rand(0.18, 0.55), spark: Math.random() < 0.07, z: rand(0.2, 1),
    }));
    const nShapes = W < 700 ? 4 : 6;
    shapes = Array.from({ length: nShapes }, (_, i) => ({
      k: kinds[i % kinds.length], x: rand(0.05, 0.95) * W, y: rand(0.05, 0.95) * H, s: rand(46, 118),
      rx: rand(0, 6.28), ry: rand(0, 6.28), vx: rand(0.12, 0.3) * (Math.random() < .5 ? -1 : 1), vy: rand(0.12, 0.3) * (Math.random() < .5 ? -1 : 1),
      wx: rand(0.04, 0.1), wy: rand(0.05, 0.12), a: rand(0.07, 0.16), z: rand(0.3, 1),
    }));
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    W = innerWidth; H = innerHeight;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    build();
    if (reduce) frame(0);
  }

  function drawShape(sh, t) {
    const [V, E] = sh.k;
    const cx = sh.x + tx * 18 * sh.z, cy = sh.y + ty * 14 * sh.z;
    const ax = sh.rx + t * sh.wx, ay = sh.ry + t * sh.wy;
    const sx = Math.sin(ax), cxn = Math.cos(ax), sy = Math.sin(ay), cyn = Math.cos(ay);
    const P = V.map(([x, y, z]) => {
      let y1 = y * cxn - z * sx, z1 = y * sx + z * cxn;
      let x2 = x * cyn + z1 * sy, z2 = -x * sy + z1 * cyn;
      const f = 1 / (1 + z2 * 0.18);
      return [cx + x2 * sh.s * f, cy + y1 * sh.s * f, z2];
    });
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = `rgba(150,160,255,${sh.a})`;
    ctx.beginPath();
    for (const [i, j] of E) { ctx.moveTo(P[i][0], P[i][1]); ctx.lineTo(P[j][0], P[j][1]); }
    ctx.stroke();
    ctx.fillStyle = `rgba(200,205,255,${sh.a * 1.6})`;
    for (const p of P) { ctx.beginPath(); ctx.arc(p[0], p[1], 1, 0, 6.283); ctx.fill(); }
  }

  let last = 0, running = true;
  function frame(ms) {
    const t = ms / 1000, dt = Math.min(0.05, (ms - last) / 1000 || 0.016); last = ms;
    tx += (mx - tx) * 0.02; ty += (my - ty) * 0.02;
    ctx.clearRect(0, 0, W, H);
    // stars
    for (const s of stars) {
      const tw = reduce ? 0.8 : 0.55 + 0.45 * Math.sin(t * s.s + s.p);
      const a = s.a * tw;
      const x = s.x + tx * 8 * s.z, y = s.y + ty * 6 * s.z;
      ctx.fillStyle = `rgba(215,220,255,${a})`;
      ctx.beginPath(); ctx.arc(x, y, s.r, 0, 6.283); ctx.fill();
      if (s.spark) {
        const L = 4 + 5 * tw; ctx.strokeStyle = `rgba(215,220,255,${a * 0.55})`; ctx.lineWidth = 0.6;
        ctx.beginPath(); ctx.moveTo(x - L, y); ctx.lineTo(x + L, y); ctx.moveTo(x, y - L); ctx.lineTo(x, y + L); ctx.stroke();
      }
    }
    // shapes
    for (const sh of shapes) {
      if (!reduce) {
        sh.x += sh.vx * dt * 6; sh.y += sh.vy * dt * 6;
        const m = sh.s * 1.4;
        if (sh.x < -m) sh.x = W + m; if (sh.x > W + m) sh.x = -m;
        if (sh.y < -m) sh.y = H + m; if (sh.y > H + m) sh.y = -m;
      }
      drawShape(sh, t);
    }
    if (!reduce && running) requestAnimationFrame(frame);
  }

  addEventListener("resize", resize);
  if (!reduce) {
    addEventListener("pointermove", e => { mx = e.clientX / W - 0.5; my = e.clientY / H - 0.5; }, { passive: true });
    document.addEventListener("visibilitychange", () => { running = !document.hidden; if (running) requestAnimationFrame(frame); });
  }
  resize();
  if (!reduce) requestAnimationFrame(frame);
})();
