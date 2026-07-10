/* Impri landing — interactions. No external deps, CSP-safe (script-src 'self'). */
(() => {
  'use strict';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ---- scroll progress + nav state ---- */
  const progress = $('#progress');
  const nav = $('#nav');
  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const st = window.scrollY || document.documentElement.scrollTop;
      const h = document.documentElement.scrollHeight - window.innerHeight;
      if (progress) progress.style.width = (h > 0 ? (st / h) * 100 : 0) + '%';
      if (nav) nav.classList.toggle('scrolled', st > 24);
      ticking = false;
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---- reveal on scroll ---- */
  const reveals = $$('.reveal');
  if (reduce || !('IntersectionObserver' in window)) {
    reveals.forEach((el) => el.classList.add('in'));
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
        });
      },
      { threshold: 0.16, rootMargin: '0px 0px -8% 0px' },
    );
    reveals.forEach((el) => io.observe(el));
  }

  /* ---- magnetic buttons ---- */
  if (!reduce && window.matchMedia('(pointer:fine)').matches) {
    $$('.magnetic').forEach((btn) => {
      btn.addEventListener('mousemove', (ev) => {
        const r = btn.getBoundingClientRect();
        const mx = ev.clientX - r.left - r.width / 2;
        const my = ev.clientY - r.top - r.height / 2;
        btn.style.transform = `translate(${mx * 0.18}px, ${my * 0.28}px)`;
      });
      btn.addEventListener('mouseleave', () => { btn.style.transform = ''; });
    });
  }

  /* ---- hero parallax (aurora + card) ---- */
  const aurora = $('.bg-aurora');
  const card = $('.card-stage');
  if (!reduce) {
    let px = false;
    window.addEventListener('scroll', () => {
      if (px) return; px = true;
      requestAnimationFrame(() => {
        const y = window.scrollY;
        if (aurora && y < window.innerHeight * 1.2) aurora.style.transform = `translateY(${y * 0.12}px)`;
        if (card && y < window.innerHeight) card.style.transform = `translateY(${y * -0.04}px)`;
        px = false;
      });
    }, { passive: true });
  }

  /* ---- live approval card state machine ---- */
  const pill = $('#pill'), pillText = $('#pill-text'), pillGlyph = $('#pill-glyph');
  const approveBtn = $('#approve-btn'), stamp = $('#stamp');
  const ICONS = {
    pending: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 8v4l3 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    approved: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    executed: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M13 3L4 14h7l-1 7 9-11h-7l1-7z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  function setState(state, label) {
    if (!pill) return;
    pill.className = 'status-pill status-' + state;
    if (pillGlyph) pillGlyph.innerHTML = ICONS[state];
    if (pillText) pillText.textContent = label;
  }
  if (pill && !reduce) {
    const cycle = () => {
      setState('pending', 'Pending review');
      approveBtn && approveBtn.classList.remove('active');
      stamp && stamp.classList.remove('show');
      setTimeout(() => { approveBtn && approveBtn.classList.add('active'); }, 1500);
      setTimeout(() => { setState('approved', 'Approved'); stamp && stamp.classList.add('show'); }, 1850);
      setTimeout(() => { setState('executed', 'Executed'); }, 3600);
      setTimeout(cycle, 6000);
    };
    setTimeout(cycle, 900);
  }

  /* ---- terminal typing ---- */
  const term = $('#term');
  const LINES = [
    '<span class="tok-flag">$</span> <span class="tok-cmd">curl</span> -X POST <span class="tok-url">https://api.impri.dev/v1/actions</span> \\',
    '    -H <span class="tok-str">"Authorization: Bearer im_…"</span> \\',
    '    -d <span class="tok-punc">\'{</span>',
    '      <span class="tok-key">"kind"</span><span class="tok-punc">:</span> <span class="tok-str">"reddit.comment"</span><span class="tok-punc">,</span>',
    '      <span class="tok-key">"title"</span><span class="tok-punc">:</span> <span class="tok-str">"Reply: loan-option calls"</span><span class="tok-punc">,</span>',
    '      <span class="tok-key">"preview"</span><span class="tok-punc">:</span> <span class="tok-punc">{</span> <span class="tok-key">"body"</span><span class="tok-punc">:</span> <span class="tok-str">"blocking wont do much…"</span> <span class="tok-punc">},</span>',
    '      <span class="tok-key">"editable"</span><span class="tok-punc">:</span> <span class="tok-punc">[</span><span class="tok-str">"preview.body"</span><span class="tok-punc">]</span>',
    '    <span class="tok-punc">}\'</span>',
    '',
    '<span class="tok-ok">→ 201</span> <span class="tok-punc">{</span> <span class="tok-key">"id"</span><span class="tok-punc">:</span> <span class="tok-str">"act_9f3c"</span><span class="tok-punc">,</span> <span class="tok-key">"status"</span><span class="tok-punc">:</span> <span class="tok-str">"pending"</span> <span class="tok-punc">}</span>',
    '<span class="tok-flag"># …human approves in the inbox…</span>',
    '<span class="tok-ok">→ approved</span>  <span class="tok-flag">agent executes ✓</span>',
  ];
  function typeTerminal() {
    if (!term) return;
    if (reduce) { term.innerHTML = LINES.join('\n'); return; }
    let li = 0, out = '';
    (function nextLine() {
      if (li >= LINES.length) { term.innerHTML = out; return; }
      const line = LINES[li];
      // Reveal per-line (fast) — typing char-by-char through HTML tags is fragile,
      // so we reveal whole styled lines with a short cadence for a live feel.
      out += (li ? '\n' : '') + line;
      term.innerHTML = out + '<span class="cursor"></span>';
      li++;
      setTimeout(nextLine, line.trim() === '' ? 120 : 230);
    })();
  }
  if (term) {
    if (reduce || !('IntersectionObserver' in window)) {
      typeTerminal();
    } else {
      const tio = new IntersectionObserver((entries, obs) => {
        entries.forEach((e) => { if (e.isIntersecting) { typeTerminal(); obs.disconnect(); } });
      }, { threshold: 0.4 });
      tio.observe(term);
    }
  }

  /* ---- constellation canvas ---- */
  const canvas = $('#constellation');
  if (canvas && !reduce) {
    const ctx = canvas.getContext('2d');
    let w, h, dpr, nodes, raf, running = true;
    const COUNT = () => Math.min(70, Math.floor((window.innerWidth * window.innerHeight) / 22000));

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.width = Math.floor(window.innerWidth * dpr);
      h = canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
    }
    function seed() {
      nodes = [];
      const n = COUNT();
      for (let i = 0; i < n; i++) {
        nodes.push({
          x: Math.random() * w, y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.22 * dpr,
          vy: (Math.random() - 0.5) * 0.22 * dpr,
          r: (Math.random() * 1.4 + 0.6) * dpr,
        });
      }
    }
    const LINK = 130;
    function frame() {
      if (!running) return;
      ctx.clearRect(0, 0, w, h);
      const link = LINK * dpr;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        a.x += a.vx; a.y += a.vy;
        if (a.x < 0 || a.x > w) a.vx *= -1;
        if (a.y < 0 || a.y > h) a.vy *= -1;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d = Math.hypot(dx, dy);
          if (d < link) {
            const o = (1 - d / link) * 0.5;
            ctx.strokeStyle = `rgba(129,140,248,${o})`;
            ctx.lineWidth = dpr * 0.6;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
        }
      }
      for (const a of nodes) {
        ctx.beginPath();
        ctx.fillStyle = 'rgba(167,139,250,0.85)';
        ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    }
    function start() { if (!running) { running = true; frame(); } }
    function stop() { running = false; if (raf) cancelAnimationFrame(raf); }

    resize(); seed(); frame();
    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { resize(); seed(); }, 200); });
    document.addEventListener('visibilitychange', () => { document.hidden ? stop() : start(); });
    // Pause the canvas once scrolled well past the hero (it's mostly hidden anyway).
    const heroIo = new IntersectionObserver((e) => { e[0].isIntersecting ? start() : stop(); }, { threshold: 0 });
    const hero = $('.hero'); if (hero) heroIo.observe(hero);
  }
})();
