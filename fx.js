// 小小的五彩紙屑動畫(不需要任何外部套件)。成功訊息(以 ✅ 開頭的提示)會自動撒花。
(function () {
  'use strict';
  const COLORS = ['#6f97b2', '#a9c3d3', '#f0dcbd', '#e6c1bc', '#b8d4c2', '#ffffff'];
  let canvas, ctx, parts = [], raf = 0;

  function ensure() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.id = 'fx-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
  }
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function tick() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    parts = parts.filter((p) => p.life > 0 && p.y < innerHeight + 30);
    parts.forEach((p) => {
      p.vy += 0.16; p.vx *= 0.992; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life -= 1;
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.globalAlpha = Math.min(1, p.life / 30);
      ctx.fillStyle = p.color;
      if (p.shape === 0) ctx.fillRect(-p.s / 2, -p.s / 3, p.s, p.s * 0.6);
      else { ctx.beginPath(); ctx.arc(0, 0, p.s / 2.4, 0, 6.3); ctx.fill(); }
      ctx.restore();
    });
    if (parts.length) raf = requestAnimationFrame(tick);
    else { cancelAnimationFrame(raf); raf = 0; ctx.clearRect(0, 0, innerWidth, innerHeight); }
  }

  function confetti(x, y) {
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    ensure();
    const cx = x == null ? innerWidth / 2 : x, cy = y == null ? innerHeight * 0.4 : y;
    for (let i = 0; i < 46; i++) {
      const a = Math.random() * Math.PI * 2, sp = 3 + Math.random() * 6;
      parts.push({
        x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 4, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
        s: 6 + Math.random() * 7, color: COLORS[(Math.random() * COLORS.length) | 0], shape: Math.random() < 0.6 ? 0 : 1, life: 70 + Math.random() * 40
      });
    }
    if (!raf) raf = requestAnimationFrame(tick);
  }

  window.fx = { confetti };
})();
