import {drop, models, rarity} from './physics.mjs';
import {rewardArt} from './reward-art.mjs';

// The neighbouring cards illustrate the published pool. Their sequence is repeatable
// for a given race. Only the settled asset supplied by the caller occupies the stop.
function makeStrip(race, part, stopIndex, length) {
  let seed = 2166136261;
  for (const char of `${race.id}/${race.address || race.driver}/${race.odds}/${race.pool}`) {
    seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  }
  function next() {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  }
  return Array.from({length}, (_, i) => i === stopIndex ? part :
    drop(race.rank, Math.floor(next() * 10000), Math.floor(next() * 12000)));
}

function makeCard(part) {
  const card = document.createElement('div');
  card.className = 'reward-card';
  card.dataset.model = part?.model ?? 0;
  card.dataset.edition = part?.edition ?? -1;
  const type = document.createElement('span');
  type.className = 'reward-rarity';
  type.textContent = part ? rarity[part.edition] : '无部件';
  const name = document.createElement('strong');
  name.textContent = part ? models[part.model] : '本场未掉落';
  let visual;
  if (part) {
    visual = document.createElement('img');
    visual.src = rewardArt(part.model);
    visual.alt = '';
    visual.draggable = false;
  } else {
    visual = document.createElement('span');
    visual.className = 'reward-empty-icon';
  }
  card.append(type, visual, name);
  return card;
}

export function mountRewardReel(host, {race, part, onReveal, sound}) {
  const firstIndex = 5, stopIndex = 27, durationMs = 4050;
  const panel = document.createElement('section');
  panel.className = 'reward-reel';
  panel.dataset.phase = 'rolling';
  panel.setAttribute('aria-label', '赛后奖箱');
  panel.innerHTML = '<div class="reward-top"><h3 class="reward-caption" role="status">正在开箱</h3>' +
    '</div><div class="reward-frame" aria-hidden="true">' +
    '<div class="reward-window"><div class="reward-strip"></div></div><div class="reward-pointer"></div></div>' +
    '<div class="reward-bottom"><button class="reward-skip ghost" type="button">跳过动画</button></div>';
  const viewport = panel.querySelector('.reward-window');
  const strip = panel.querySelector('.reward-strip');
  const skip = panel.querySelector('.reward-skip');
  const cards = makeStrip(race, part, stopIndex, stopIndex + 9).map(makeCard);
  strip.append(...cards);
  host.replaceChildren(panel);

  let progress = 0, firstCenter = 0, lastCenter = 0, frame = 0, hold = 0;
  let active = true, lastTick = firstIndex;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const started = performance.now();
  function paint() {
    const center = firstCenter + (lastCenter - firstCenter) * progress;
    strip.style.transform = `translate3d(${-center}px, 0, 0)`;
  }
  function measure() {
    // The strip begins at the fixed pointer. Measure only on mount and resize.
    const centerOf = card => card.offsetLeft + card.offsetWidth / 2;
    firstCenter = centerOf(cards[firstIndex]);
    lastCenter = centerOf(cards[stopIndex]);
    paint();
  }
  const resize = new ResizeObserver(measure);
  resize.observe(viewport);
  function dispose() {
    active = false;
    cancelAnimationFrame(frame);
    clearTimeout(hold);
    resize.disconnect();
    skip.removeEventListener('click', reveal);
    reduced.removeEventListener('change', handlePreference);
    document.removeEventListener('visibilitychange', handleVisibility);
  }
  function reveal() {
    if (!active) return;
    dispose();
    if (panel.isConnected) onReveal();
  }
  function handleVisibility() {
    if (document.hidden) reveal();
  }
  function handlePreference(event) {
    if (event.matches) reveal();
  }
  function step(now) {
    if (!active) return;
    if (!panel.isConnected) { dispose(); return; }
    const elapsed = Math.min(1, (now - started) / durationMs);
    progress = 1 - (1 - elapsed) ** 2.65;
    paint();
    const index = Math.round(firstIndex + (stopIndex - firstIndex) * progress);
    if (index !== lastTick) {
      lastTick = index;
      sound?.('tick');
    }
    if (elapsed < 1) {
      frame = requestAnimationFrame(step);
      return;
    }
    panel.dataset.phase = 'landed';
    const winner = cards[stopIndex];
    winner.classList.add('is-winner');
    if (part) winner.querySelector('strong').append(' #' + String(part.id).padStart(3, '0'));
    panel.querySelector('.reward-caption').textContent = part ? '获得部件' : '本场未掉落部件';
    sound?.(part ? 'win' : 'empty');
    hold = window.setTimeout(reveal, 620);
  }
  skip.addEventListener('click', reveal);
  reduced.addEventListener('change', handlePreference);
  document.addEventListener('visibilitychange', handleVisibility);
  measure();
  if (document.hidden || reduced.matches) queueMicrotask(reveal);
  else frame = requestAnimationFrame(step);
  return {destroy() { dispose(); panel.remove(); }};
}
