/* Rapiboy · "A rota que chega" · motor da página (vanilla) */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const smoothstep = (p, e0, e1) => { const t = clamp((p - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  const reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');

  /* ───────── ambiente: janelas piscando só quando a aba está visível ───────── */
  const ambient = $('.ambient');
  const setAmbient = () => ambient && ambient.classList.toggle('live', !document.hidden && !reduceMQ.matches);
  document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('paused', document.hidden);
    setAmbient();
  });
  setAmbient();

  /* ───────── nav ───────── */
  const nav = $('#nav');
  let navStuck = null;
  const updateNav = () => {
    const s = scrollY > 40;
    if (s !== navStuck) { navStuck = s; nav.classList.toggle('stuck', s); }
  };
  addEventListener('scroll', updateNav, { passive: true });
  updateNav();

  /* ───────── divisão de texto (semente fixa: mesmos offsets em todo carregamento) ───────── */
  function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
  function splitWords(el, fx, seed) {
    const text = el.textContent.trim();
    const rand = rng(seed);
    const words = text.split(/\s+/);
    const sr = document.createElement('span'); sr.className = 'sr-only'; sr.textContent = text;
    const vis = document.createElement('span'); vis.setAttribute('aria-hidden', 'true'); vis.className = 'sharp';
    words.forEach((w, i) => {
      const span = document.createElement('span'); span.className = 'w'; span.textContent = w + (i < words.length - 1 ? ' ' : '');
      const th = (i / words.length) * 0.55 + rand() * 0.06;
      span.style.setProperty('--th', th.toFixed(3));
      vis.appendChild(span);
    });
    el.textContent = '';
    el.appendChild(sr); el.appendChild(vis);
    if (fx === 'blur') { const soft = vis.cloneNode(true); soft.className = 'soft'; el.appendChild(soft); }
  }
  $$('.band .t[data-split]').forEach((el, i) => splitWords(el, el.closest('.band').dataset.fx, 1000 + i * 97));

  /* ───────── hero: estado ───────── */
  const stage = $('#stage');
  const hero = $('.hero');
  const video = $('#heroVideo');
  const poster = $('.poster');
  const ring = $('.ring');
  const bands = $$('.band').map(el => ({ el, a: +el.dataset.a, b: +el.dataset.b, op: -1, k: -1 }));
  const VIDEO_URL = 'assets/hero-scrub.mp4';
  const VIDEO_BYTES = 6414587; // tamanho real de assets/hero-scrub.mp4, recuo quando Content-Length falta

  let scrubOn = false, heroOnScreen = true, initDone = false, started = false;
  let target = 0, shown = 0, rafId = null, lastTick = 0, loadK = 0, loadStart = 0;
  let seekBusy = false, pendingTime = null;

  const heroProgress = () => {
    const r = hero.getBoundingClientRect();
    const range = r.height - innerHeight;
    return range > 0 ? clamp(-r.top / range, 0, 1) : 0;
  };

  function requestSeek(t) {
    if (!video.duration || !isFinite(t)) return;
    if (seekBusy) { pendingTime = t; return; }
    seekBusy = true;
    video.currentTime = t;
  }
  video.addEventListener('seeked', () => {
    seekBusy = false;
    if (pendingTime !== null) { const t = pendingTime; pendingTime = null; requestSeek(t); }
  });
  video.addEventListener('error', () => { seekBusy = false; pendingTime = null; failVideo(); });

  function updateCaptions(p) {
    for (const b of bands) {
      const f = Math.min(0.02, (b.b - b.a) / 3);
      const fadeIn = b.a === 0 ? 1 : smoothstep(p, b.a, b.a + f);
      const fadeOut = b.b >= 1 ? 1 : 1 - smoothstep(p, b.b - f, b.b);
      const op = +(fadeIn * fadeOut).toFixed(3);
      if (op !== b.op) { b.op = op; b.el.style.opacity = op; }
      const ramp = Math.min(0.025, (b.b - b.a) * 0.35);
      let k = clamp((p - b.a) / ramp, 0, 1);
      if (b.a === 0) k = Math.max(k, loadK);
      if (Math.abs(k - b.k) > 0.008 || (k === 1 && b.k !== 1) || (k === 0 && b.k !== 0)) { b.k = k; b.el.style.setProperty('--k', k.toFixed(3)); }
    }
    const scrolled = p > 0.04;
    if (scrolled !== stage.classList.contains('scrolled')) stage.classList.toggle('scrolled', scrolled);
  }

  function tick(now) {
    const dt = Math.min(100, now - (lastTick || now));
    lastTick = now;
    if (loadK < 1) { loadK = clamp((now - loadStart) / 900, 0, 1); }
    const kf = 0.16;
    shown += (target - shown) * (1 - Math.pow(1 - kf, dt / 16.667));
    const converged = Math.abs(target - shown) < 0.0005 && loadK >= 1;
    if (converged) { shown = target; rafId = null; lastTick = 0; }
    else rafId = requestAnimationFrame(tick);
    if (video.duration) requestSeek(shown * video.duration);
    updateCaptions(shown);
  }
  function onScroll() {
    target = heroProgress();
    if (rafId === null && heroOnScreen) rafId = requestAnimationFrame(tick);
  }

  new IntersectionObserver(entries => {
    heroOnScreen = entries[0].isIntersecting;
    if (heroOnScreen && scrubOn) onScroll();
  }, { threshold: 0 }).observe(hero);

  /* ───────── carregamento do vídeo como Blob (pôster primeiro, anel honesto) ───────── */
  function startBlobFetch() {
    if (started) return; started = true;
    loadHeroBlob().catch(failVideo);
  }
  async function loadHeroBlob() {
    const ctrl = new AbortController();
    let watchdog = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(VIDEO_URL, { priority: 'low', signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error('video fetch failed');
    const total = Number(res.headers.get('Content-Length')) || VIDEO_BYTES;
    const reader = res.body.getReader();
    const chunks = []; let got = 0, lastRing = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      clearTimeout(watchdog); watchdog = setTimeout(() => ctrl.abort(), 20000);
      chunks.push(value); got += value.length;
      const frac = Math.min(1, got / total), now = performance.now();
      if (now - lastRing > 100 || frac === 1) { lastRing = now; ring.style.setProperty('--ld', Math.round(126 * (1 - frac))); }
    }
    clearTimeout(watchdog);
    ring.style.setProperty('--ld', 0);
    video.src = URL.createObjectURL(new Blob(chunks, { type: 'video/mp4' }));
    video.load();
    video.addEventListener('canplay', () => {
      requestSeek(heroProgress() * video.duration);
      stage.classList.add('video-ready');
    }, { once: true });
  }
  function failVideo() {
    if (stage.classList.contains('video-failed')) return;
    stage.classList.add('video-failed');
  }

  function initHeroOnce() {
    if (initDone) return; initDone = true;
    poster.style.backgroundImage = "url('assets/hero-poster.jpg')";
    const img = new Image();
    img.onload = startBlobFetch; img.onerror = startBlobFetch;
    img.src = 'assets/hero-poster.jpg';
    setTimeout(startBlobFetch, 4000);
  }

  /* ───────── os cinco portões, idênticos ao CSS, reavaliados ao vivo ───────── */
  const GATES = [
    '(max-width: 720px)',
    '(orientation: portrait) and (max-width: 1024px)',
    '(orientation: portrait) and (pointer: coarse)',
    '(orientation: landscape) and (pointer: coarse) and (max-height: 560px)',
    '(prefers-reduced-motion: reduce)'
  ];
  function enableScrub() {
    if (scrubOn) return; scrubOn = true;
    initHeroOnce();
    loadStart = performance.now(); loadK = 0;
    addEventListener('scroll', onScroll, { passive: true });
    bands.forEach(b => { b.op = -1; b.k = -1; });
    unpinFinalStates();
    updateCaptions(heroProgress());
    onScroll();
  }
  function disableScrub() {
    if (!scrubOn) return; scrubOn = false;
    removeEventListener('scroll', onScroll);
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  }
  function applyHeroMode() {
    if (GATES.some(q => matchMedia(q).matches)) disableScrub(); else enableScrub();
  }
  const MQLS = GATES.map(q => matchMedia(q));
  MQLS.forEach(m => m.addEventListener('change', applyHeroMode));

  /* ───────── a rota ciano que se traça com o scroll ───────── */
  const route = $('#route');
  const page = $('#page');
  let routeLen = 0, lastOffset = -1, pinned = false;
  function measureRoute() {
    routeLen = route.getTotalLength();
    route.style.strokeDasharray = `${routeLen}`;
    lastOffset = -1;
    updateRoute();
  }
  function updateRoute() {
    if (!routeLen) return;
    let p = 1;
    if (!pinned) {
      const r = page.getBoundingClientRect();
      p = clamp((innerHeight * 0.8 - r.top) / r.height, 0, 1);
    }
    const off = Math.round(routeLen * (1 - p) * 2) / 2;
    if (off !== lastOffset) { lastOffset = off; route.style.strokeDashoffset = `${off}`; }
  }
  addEventListener('scroll', updateRoute, { passive: true });
  addEventListener('resize', measureRoute);

  /* ───────── entradas coreografadas ───────── */
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      const el = e.target;
      el.classList.add('in');
      io.unobserve(el);
      setTimeout(() => el.classList.add('settled'), 1400);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
  $$('.rv').forEach(el => io.observe(el));
  $$('.stop').forEach(el => io.observe(el));

  /* ───────── player do carton: toca só quando o visitante pede ─────────
     busca como Blob antes de tocar: alguns hosts servem mal o pedido por
     partes (Range) que o <video src> nativo depende, e o carregamento
     trava sem aviso (o mesmo motivo do hero usar Blob). O clipe é
     pequeno, então a busca simples de uma vez basta. */
  const player = $('#player');
  const carton = $('#cartonVideo');
  const playBtn = $('.play', player);
  let cartonBlobUrl = null, cartonLoading = false;
  playBtn.addEventListener('click', async () => {
    if (cartonLoading) return;
    if (cartonBlobUrl) {
      carton.play().then(() => player.classList.add('playing')).catch(() => {});
      return;
    }
    cartonLoading = true;
    player.classList.add('loading');
    try {
      const res = await fetch('assets/carton.mp4');
      if (!res.ok) throw new Error('carton fetch failed');
      cartonBlobUrl = URL.createObjectURL(await res.blob());
      carton.src = cartonBlobUrl;
      await carton.play();
      player.classList.add('playing');
    } catch {
      carton.src = 'assets/carton.mp4';
      carton.play().then(() => player.classList.add('playing')).catch(() => {});
    } finally {
      cartonLoading = false;
      player.classList.remove('loading');
    }
  });
  carton.addEventListener('click', () => { if (!carton.paused) { carton.pause(); player.classList.remove('playing'); } });
  new IntersectionObserver(entries => { if (!entries[0].isIntersecting && !carton.paused) { carton.pause(); player.classList.remove('playing'); } }).observe(player);

  /* ───────── momento interativo: segurar para montar o time ───────── */
  const hold = $('#holdBtn');
  const riders = $$('.riders i');
  const result = $('#holdResult');
  let hp = 0, holding = false, holdRaf = null, holdLast = 0, done = false, ridersOn = -1;
  function paintHold() {
    hold.style.setProperty('--p', hp.toFixed(3));
    const n = Math.round(hp * riders.length);
    if (n !== ridersOn) { ridersOn = n; riders.forEach((r, i) => r.classList.toggle('on', i < n)); }
  }
  function holdTick(now) {
    const dt = Math.min(100, now - (holdLast || now)); holdLast = now;
    if (done) { hp = 1; paintHold(); holdRaf = null; holdLast = 0; return; }
    hp = clamp(hp + (holding ? dt / 1500 : -dt / 900), 0, 1);
    paintHold();
    if (hp >= 1) { completeHold(); return; }
    if ((holding && hp < 1) || (!holding && hp > 0)) holdRaf = requestAnimationFrame(holdTick);
    else { holdRaf = null; holdLast = 0; }
  }
  function completeHold() {
    done = true; hp = 1; paintHold();
    hold.classList.add('done');
    $('.hold-label', hold).textContent = 'Time montado';
    result.classList.add('show');
    holdRaf = null; holdLast = 0;
  }
  function startHold(e) { if (done) return; if (e && e.preventDefault) e.preventDefault(); holding = true; if (holdRaf === null) holdRaf = requestAnimationFrame(holdTick); }
  function endHold() { holding = false; if (holdRaf === null && hp > 0 && !done) holdRaf = requestAnimationFrame(holdTick); }
  hold.addEventListener('pointerdown', startHold);
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => hold.addEventListener(ev, endHold));
  hold.addEventListener('keydown', e => { if (e.code === 'Space' || e.code === 'Enter') { startHold(e); } });
  hold.addEventListener('keyup', e => { if (e.code === 'Space' || e.code === 'Enter') endHold(); });
  hold.addEventListener('contextmenu', e => e.preventDefault());

  /* ───────── perguntas ───────── */
  $$('.faq-q').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.faq-item');
      const open = item.classList.contains('open');
      $$('.faq-item.open').forEach(o => { o.classList.remove('open'); $('.faq-q', o).setAttribute('aria-expanded', 'false'); });
      if (!open) { item.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); }
    });
  });

  /* ───────── movimento reduzido nas duas direções ───────── */
  function pinToFinalStates() {
    pinned = true; updateRoute();
    $$('.rv, .stop').forEach(el => el.classList.add('in', 'settled'));
    if (!done) completeHold();
    setAmbient();
  }
  function unpinFinalStates() {
    pinned = false; updateRoute();
    setAmbient();
  }
  reduceMQ.addEventListener('change', e => { if (e.matches) pinToFinalStates(); else applyHeroMode(); });

  /* ───────── arranque ───────── */
  measureRoute();
  applyHeroMode();
  if (reduceMQ.matches) pinToFinalStates();
})();
