const layers = new WeakMap();
const validRects = range => {
  const rows = [];
  for (const rect of [...range.getClientRects()].filter(rect => rect.height > 0 && rect.width >= 0)) {
    const row = rows.find(row => Math.abs(row.bottom - rect.bottom) < 2 && row.left <= rect.right + 1 && row.right >= rect.left - 1);
    if (row) { row.left = Math.min(row.left, rect.left); row.right = Math.max(row.right, rect.right); row.width = row.right - row.left; }
    else rows.push(Object.fromEntries(['left', 'right', 'top', 'bottom', 'width', 'height'].map(key => [key, rect[key]])));
  }
  return rows;
};

function textNodes(element, text = element.innerText ?? element.textContent) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const nodes = []; let node, offset = 0;
  while ((node = walker.nextNode())) {
    if (node.parentElement.closest('.nocturne-bookmark-layer')) continue;
    const found = text.indexOf(node.textContent, offset);
    if (found >= 0) offset = found;
    nodes.push({ node, from: offset, to: offset + node.textContent.length }); offset += node.textContent.length;
  }
  return nodes;
}
export function textRangeOffsets(element, range, text) {
  const nodes = textNodes(element, text);
  const offset = (node, position) => {
    if (node.nodeType === Node.TEXT_NODE) return (nodes.find(entry => entry.node === node)?.from ?? 0) + position;
    const child = node.childNodes[position];
    return nodes.find(entry => child?.contains(entry.node))?.from ?? nodes.findLast(entry => node.contains(entry.node))?.to ?? 0;
  };
  return { from: offset(range.startContainer, range.startOffset), to: offset(range.endContainer, range.endOffset) };
}
export function rangeInText(element, from, to = from, text) {
  const nodes = textNodes(element, text);
  const locate = pos => nodes.find(entry => pos >= entry.from && pos <= entry.to) || nodes.find(entry => pos < entry.from) || nodes.at(-1);
  const start = locate(from), end = locate(to);
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start.node, Math.min(start.node.length, Math.max(0, from - start.from)));
  range.setEnd(end.node, Math.min(end.node.length, Math.max(0, to - end.from)));
  return range;
}

export function clearBookmarkLayer(root) {
  const layer = layers.get(root);
  if (layer) { cancelAnimationFrame(layer.raf); layer.element.remove(); layer.events?.abort(); }
  layers.delete(root);
}

export function drawBookmarkLayer(root, bookmarks, { rangeAt, paragraphAt, onJump, onEdit, activeId, settings = {}, ownerKey = '', clipRect = null }) {
  if (!root.isConnected) return;
  if (!bookmarks.some(bookmark => bookmark.parts?.some(part => part.anchor.status === 'attached'))) { clearBookmarkLayer(root); return; }
  let record = layers.get(root);
  if (!record) {
    const element = document.createElement('div'); element.className = 'nocturne-bookmark-layer'; element.dataset.bookmarkOwner = ownerKey;
    const host = root.parentElement;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.append(element);
    record = { element, raf: 0, hitRects: [], events: new AbortController() }; layers.set(root, record);
    root.addEventListener('pointermove', event => {
      const ids = new Set(record.hitRects.filter(entry => event.clientX >= entry.rect.left - 5 && event.clientX <= entry.rect.right + 5 && event.clientY >= entry.rect.top && event.clientY <= entry.rect.bottom + 8).map(entry => entry.id));
      for (const group of record.element.children) group.classList.toggle('text-hover', ids.has(group.dataset.bookmarkId));
    }, { passive: true, signal: record.events.signal });
    root.addEventListener('pointerleave', () => { for (const group of record.element.children) group.classList.remove('text-hover'); }, { passive: true, signal: record.events.signal });
  }
  cancelAnimationFrame(record.raf);
  record.raf = requestAnimationFrame(() => {
    if (!root.isConnected) return;
    const layer = record.element, base = layer.getBoundingClientRect();
    const scale = base.width / (layer.offsetWidth || base.width || 1);
    const clip = clipRect?.();
    layer.style.clipPath = clip ? `inset(${Math.max(0, clip.top - base.top) / scale}px ${Math.max(0, base.right - clip.right) / scale}px ${Math.max(0, base.bottom - clip.bottom) / scale}px ${Math.max(0, clip.left - base.left) / scale}px)` : '';
    const relative = rect => ({ left: (rect.left - base.left) / scale, top: (rect.top - base.top) / scale, width: rect.width / scale, height: rect.height / scale, bottom: (rect.bottom - base.top) / scale });
    const fragment = document.createDocumentFragment(); record.hitRects = [];
    for (const bookmark of bookmarks) {
      const group = document.createElement('div'); group.className = `bookmark-mark-group${bookmark.id === activeId ? ' active' : ''}`;
      group.dataset.highlight = settings.bookmarkHighlight || 'jump';
      if (record.flashId === bookmark.id && record.flashUntil > performance.now()) group.classList.add('bookmark-jump-flash', 'show-icon');
      group.dataset.bookmarkId = bookmark.id;
      const always = settings.bookmarkVisibility === 'always' || settings.bookmarkVisibility === 'active' && bookmark.id === activeId;
      group.dataset.persistentIcon = String(always);
      group.classList.toggle('show-icon', always || record.flashId === bookmark.id && record.flashUntil > performance.now());
      const drawn = [];
      for (const part of bookmark.parts) {
        const { anchor } = part;
        if (anchor.status !== 'attached') continue;
        let range;
        try { range = rangeAt(anchor.from, anchor.to); } catch { continue; }
        if (!range) continue;
        let rects = validRects(range);
        if (!rects.length && anchor.kind === 'point') {
          try { rects = validRects(rangeAt(Math.max(0, anchor.from - 1), anchor.from)); } catch { continue; }
          if (rects.length) rects = [{ ...Object.fromEntries(['left', 'right', 'top', 'bottom', 'width', 'height'].map(key => [key, rects.at(-1)[key]])), left: rects.at(-1).right, width: 0 }];
        }
        if (!rects.length) continue;
        const firstChild = group.childElementCount;
        for (const rect of rects) record.hitRects.push({ id: bookmark.id, rect });
        const lastBottom = Math.max(...rects.map(rect => rect.bottom));
        const last = rects.filter(rect => Math.abs(rect.bottom - lastBottom) < 3);
        const minLeft = Math.min(...last.map(rect => rect.left)), maxRight = Math.max(...last.map(rect => rect.right));
        let point = { left: (minLeft + maxRight) / 2, top: lastBottom + 2 };
        if (anchor.kind === 'range') {
          for (const rect of rects.filter(rect => rect.width > 0)) {
            const line = document.createElement('span'); line.className = 'bookmark-range-line';
            const position = relative(rect);
            Object.assign(line.style, { left: `${position.left}px`, top: `${position.bottom + 2}px`, width: `${position.width}px` });
            group.append(line);
            for (const other of drawn) if (Math.abs(other.bottom - rect.bottom) < 3 && other.left < rect.right && other.right > rect.left) {
              const intersection = document.createElement('span'); intersection.className = 'bookmark-range-line overlap';
              Object.assign(intersection.style, { left: `${(Math.max(other.left, rect.left) - base.left) / scale}px`, top: `${position.bottom + 2}px`, width: `${(Math.min(other.right, rect.right) - Math.max(other.left, rect.left)) / scale}px` });
              group.append(intersection);
            }
            drawn.push(rect);
          }
        } else if (anchor.kind === 'paragraph') {
          const paragraph = paragraphAt?.(anchor.from);
          if (paragraph) {
            const rect = paragraph.getBoundingClientRect(), position = relative(rect);
            const fill = document.createElement('span'); fill.className = 'bookmark-paragraph-fill';
            Object.assign(fill.style, { left: `${position.left}px`, top: `${position.top}px`, width: `${position.width}px`, height: `${position.height}px` });
            const bracket = document.createElement('button'); bracket.type = 'button'; bracket.className = 'bookmark-paragraph-bracket'; bracket.setAttribute('aria-label', `Закладка абзаца: ${part.title}`);
            bracket.innerHTML = '<svg viewBox="0 0 12 100" preserveAspectRatio="none" aria-hidden="true"><path d="M11 1 Q4 1 4 12 L4 39 Q4 48 1 50 Q4 52 4 61 L4 88 Q4 99 11 99" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>';
            Object.assign(bracket.style, { left: `${position.left - 18}px`, top: `${position.top}px`, height: `${position.height}px` });
            bracket.addEventListener('pointerdown', event => event.preventDefault()); bracket.onclick = () => onJump(bookmark.id);
            group.append(fill, bracket); point = { left: rect.right + 12, top: rect.bottom - 10 };
          }
        }
        const marker = document.createElement('button'); marker.type = 'button';
        marker.className = `bookmark-position-mark bookmark-kind-${anchor.kind}`;
        marker.setAttribute('aria-label', `${part.title}. Перейти к закладке`); marker.title = part.title;
        const position = relative({ left: point.left, top: point.top, width: 0, height: 0, bottom: point.top });
        Object.assign(marker.style, { left: `${position.left}px`, top: `${position.top}px` });
        const small = document.createElement('span'); small.className = 'bookmark-position-tick';
        const icon = document.createElement('span'); icon.className = 'bookmark-position-icon'; icon.innerHTML = '<i class="bx bxs-bookmark" aria-hidden="true"></i>';
        marker.append(small, icon);
        marker.onpointerdown = event => { event.preventDefault(); event.stopPropagation(); };
        marker.onclick = event => { event.stopPropagation(); onJump(bookmark.id); group.classList.add('show-icon'); };
        marker.oncontextmenu = event => { event.preventDefault(); event.stopPropagation(); onEdit(bookmark.id); };
        group.append(marker);
        for (const child of [...group.children].slice(firstChild)) child.style.setProperty('--bookmark-color', part.color || 'var(--accent)');
      }
      if (group.childElementCount) {
        const existing = [...layer.children].find(value => value.dataset.bookmarkId === bookmark.id);
        fragment.append(existing?.outerHTML === group.outerHTML ? existing : group);
      }
    }
    layer.replaceChildren(fragment);
  });
}

export function flashBookmark(root, id, reduce = false) {
  const record = layers.get(root);
  if (record) { record.flashId = id; record.flashUntil = performance.now() + (reduce ? 800 : 1800); }
  const marker = root.parentElement?.querySelector(`.bookmark-mark-group[data-bookmark-id="${CSS.escape(id)}"]`);
  if (!marker) return;
  marker.classList.add('bookmark-jump-flash', 'show-icon');
  setTimeout(() => { record?.element.querySelectorAll('.bookmark-jump-flash').forEach(element => { element.classList.remove('bookmark-jump-flash'); element.classList.toggle('show-icon', element.dataset.persistentIcon === 'true'); }); }, reduce ? 800 : 1800);
}
