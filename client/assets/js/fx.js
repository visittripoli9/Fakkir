/* FAKKIR — premium game-feel engine (self-contained, no external assets)
 * Exposes window.FX:
 *   FX.setEnabled(bool)        toggle all audio
 *   FX.tone(freq,start,dur,t)  low-level oscillator (back-compat for beep())
 *   FX.sound(name)             named SFX: click, select, correct, wrong, steal,
 *                              pass, tick, golden, start, win, lose
 *   FX.confetti(opts)          canvas celebration burst
 *   FX.countUp(el, to, ms)     animate a number element to a new value
 *   FX.haptic(pattern)         vibration on supported devices
 *   FX.pop(el)                 quick scale "pop" on any element
 */
window.FX = (function () {
  let ac = null, master = null, enabled = true;

  function ctx() {
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ac = new AC();
      master = ac.createGain();
      master.gain.value = 0.85;
      master.connect(ac.destination);
    }
    if (ac.state === 'suspended') { try { ac.resume(); } catch (e) {} }
    return ac;
  }

  function setEnabled(v) { enabled = !!v; }

  // one enveloped oscillator voice
  function voice(freq, start, dur, type, peak, glideTo) {
    if (!enabled) return;
    const a = ctx(); if (!a) return;
    const t = a.currentTime + Math.max(0, start);
    const o = a.createOscillator(), g = a.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, glideTo), t + dur);
    o.connect(g); g.connect(master);
    const p = Math.max(0.0001, peak == null ? 0.18 : peak);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(p, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.03);
  }

  // back-compat shim for the old beep(freq,dur,type) signature
  function tone(freq, start, dur, type) { voice(freq, start || 0, dur || 0.15, type, 0.18); }

  const A = { C5: 523.25, E5: 659.25, G5: 783.99, C6: 1046.5, A5: 880, D5: 587.33, F5: 698.46, B5: 987.77, G4: 392 };

  function sound(name) {
    if (!enabled) return;
    switch (name) {
      case 'click':   voice(420, 0, 0.06, 'triangle', 0.10); break;
      case 'select':  voice(660, 0, 0.07, 'triangle', 0.12); voice(990, 0.04, 0.08, 'sine', 0.08); break;
      case 'correct': // bright rising major arpeggio
        [A.C5, A.E5, A.G5, A.C6].forEach((f, i) => voice(f, i * 0.075, 0.22, 'triangle', 0.16));
        voice(A.C6 * 2, 0.3, 0.18, 'sine', 0.06);
        break;
      case 'wrong':   // descending buzz
        voice(220, 0, 0.32, 'sawtooth', 0.16, 90);
        voice(160, 0.05, 0.30, 'square', 0.08, 70);
        break;
      case 'steal':   voice(A.G4, 0, 0.12, 'triangle', 0.14); voice(A.C5, 0.1, 0.16, 'triangle', 0.14); break;
      case 'pass':    voice(500, 0, 0.10, 'sine', 0.10); voice(380, 0.08, 0.12, 'sine', 0.08); break;
      case 'tick':    voice(1180, 0, 0.045, 'square', 0.08); break;
      case 'golden':  // shimmering sparkle
        [1318, 1568, 1760, 2093, 2637].forEach((f, i) => voice(f, i * 0.06, 0.5, 'sine', 0.07));
        break;
      case 'start':   [A.C5, A.G5, A.C6].forEach((f, i) => voice(f, i * 0.06, 0.2, 'triangle', 0.15)); break;
      case 'win': {   // triumphant fanfare
        const seq = [[A.C5, 0], [A.E5, 0.12], [A.G5, 0.24], [A.C6, 0.36], [A.G5, 0.5], [A.C6, 0.62]];
        seq.forEach(([f, s]) => voice(f, s, 0.34, 'triangle', 0.17));
        voice(A.C5 / 2, 0.36, 0.6, 'sine', 0.12);
        break;
      }
      case 'lose':    voice(A.E5, 0, 0.2, 'triangle', 0.12, A.C5); voice(A.C5, 0.18, 0.4, 'triangle', 0.12, A.G4); break;
      default: break;
    }
  }

  /* ---- confetti ---- */
  let cvs = null, cctx = null, parts = [], raf = 0;
  function ensureCanvas() {
    if (cvs) return;
    cvs = document.createElement('canvas');
    cvs.id = 'fxConfetti';
    cvs.setAttribute('aria-hidden', 'true');
    Object.assign(cvs.style, {
      position: 'fixed', inset: '0', width: '100%', height: '100%',
      pointerEvents: 'none', zIndex: '9999'
    });
    document.body.appendChild(cvs);
    cctx = cvs.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
  }
  function resize() {
    if (!cvs) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cvs.width = innerWidth * dpr; cvs.height = innerHeight * dpr;
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function confetti(opts = {}) {
    ensureCanvas();
    const colors = opts.colors || ['#d7a018', '#1f7bff', '#d83a45', '#2b9e5b', '#7756c6', '#f0bd3e'];
    const n = opts.count || 160;
    for (let i = 0; i < n; i++) {
      parts.push({
        x: innerWidth * (0.2 + Math.random() * 0.6),
        y: -20 - Math.random() * innerHeight * 0.3,
        vx: (Math.random() - 0.5) * 7,
        vy: 2 + Math.random() * 5,
        g: 0.12 + Math.random() * 0.08,
        size: 6 + Math.random() * 8,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        color: colors[(Math.random() * colors.length) | 0],
        life: 0, max: 140 + Math.random() * 80,
        shape: Math.random() < 0.5 ? 'rect' : 'circle'
      });
    }
    if (!raf) loop();
  }
  function loop() {
    raf = requestAnimationFrame(loop);
    cctx.clearRect(0, 0, innerWidth, innerHeight);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life++; p.vy += p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vx *= 0.992;
      const alpha = p.life > p.max - 40 ? Math.max(0, (p.max - p.life) / 40) : 1;
      cctx.save();
      cctx.globalAlpha = alpha;
      cctx.translate(p.x, p.y); cctx.rotate(p.rot);
      cctx.fillStyle = p.color;
      if (p.shape === 'rect') cctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      else { cctx.beginPath(); cctx.arc(0, 0, p.size / 2, 0, Math.PI * 2); cctx.fill(); }
      cctx.restore();
      if (p.life > p.max || p.y > innerHeight + 40) parts.splice(i, 1);
    }
    if (!parts.length) { cancelAnimationFrame(raf); raf = 0; cctx.clearRect(0, 0, innerWidth, innerHeight); }
  }

  /* ---- number count-up ---- */
  function countUp(el, to, ms) {
    if (!el) return;
    to = Math.trunc(Number(to) || 0);
    const from = Math.trunc(Number(String(el.textContent).replace(/[^\d-]/g, '')) || 0);
    if (from === to) { el.textContent = to; return; }
    const dur = ms || 600, t0 = performance.now();
    function step(now) {
      const k = Math.min(1, (now - t0) / dur);
      const ease = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(from + (to - from) * ease);
      if (k < 1) requestAnimationFrame(step); else { el.textContent = to; pop(el); }
    }
    requestAnimationFrame(step);
  }

  function pop(el) {
    if (!el) return;
    el.classList.remove('fx-pop'); void el.offsetWidth; el.classList.add('fx-pop');
  }

  function haptic(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
  }

  return { setEnabled, tone, sound, confetti, countUp, pop, haptic };
})();
