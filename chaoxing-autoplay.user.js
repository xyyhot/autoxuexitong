// ==UserScript==
// @name         学习通连续播放助手
// @namespace    local.chaoxing.playback
// @version      1.0.1
// @description  静音连续播放，跳过已完成及非视频内容；允许时使用原生二倍速，否则保持原速。
// @match        https://*.chaoxing.com/mycourse/studentstudy*
// @match        https://*.chaoxing.com/mooc-ans/mycourse/studentstudy*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  if (window.top !== window.self || document.getElementById('cx-autoplay-helper')) return;

  const $ = (s, root = document) => root?.querySelector(s);
  const all = (s, root = document) => [...(root?.querySelectorAll(s) || [])];
  const text = e => (e?.textContent || '').trim();
  const now = () => Date.now();
  const LOAD_TIMEOUT = 30000, STALL_TIMEOUT = 60000;
  const context = () => {
    const p = new URL(location.href).searchParams;
    return `${p.get('courseId') || p.get('courseid') || ''}:${p.get('clazzid') || p.get('clazzId') || ''}`;
  };
  const catalog = () => all('.posCatalog_select').filter(e => $('.posCatalog_name', e));
  const chapterId = row => row?.id?.match(/^cur(\d+)$/)?.[1] || '';
  const activeRow = () => $('.posCatalog_select.posCatalog_active');
  const chapterDone = row => !!$('.icon_Completed', row);
  const chapterName = row => $('.posCatalog_name', row)?.getAttribute('title') || text($('.posCatalog_name', row));
  const tabs = () => all('.prev_ul li[onclick*="changeDisplayContent("]');
  const source = v => v.currentSrc || v.getAttribute('src') || '';
  const visible = e => {
    if (!e?.isConnected || !e.getClientRects().length) return false;
    const win = e.ownerDocument.defaultView;
    for (let n = e; n && n.nodeType === 1; n = n.parentElement) {
      const style = win.getComputedStyle(n);
      if (n.hidden || n.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };

  let course = context(), running = false, state = '待启动', skipped = 0;
  let bound = null, pending = null, waiting = null, generation = 0, ticking = false;
  let currentChapter = '', restore = null, lastCheck = 0, inspectedContent = null, contentSeenAt = 0;
  const watch = new Map(), optionalEnded = new WeakSet();
  const storageKey = () => `cx-autoplay-v1:${course}`;
  function read(key) { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; } }
  function write(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch {} }
  function save(expected = '') {
    write(storageKey(), { running, chapter: currentChapter || chapterId(activeRow()), expected });
    write('cx-autoplay-context-v1', course);
  }

  const panel = document.createElement('aside');
  panel.id = 'cx-autoplay-helper';
  panel.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;width:290px;box-sizing:border-box;padding:16px;background:#152238;color:#fff;border-radius:12px;font:14px/1.65 sans-serif;box-shadow:0 4px 24px #0005';
  panel.innerHTML = '<strong>学习通连续播放 v1.0.1 · 静音</strong><div data-name></div><div data-status role="status" aria-live="polite"></div><div data-count></div><button type="button" data-start>开始</button> <button type="button" data-stop>暂停</button>';
  for (const b of all('button', panel)) b.style.cssText = 'margin-top:8px;padding:4px 14px;cursor:pointer;border:0;border-radius:5px;background:#eef4ff;color:#152238;font:inherit';
  document.body.append(panel);
  function render() {
    for (const [sel, value] of [
      ['[data-name]', chapterName(activeRow()) || '等待章节目录'],
      ['[data-status]', state], ['[data-count]', `已跳过 ${skipped} 项`]
    ]) if (text($(sel, panel)) !== value) $(sel, panel).textContent = value;
    $('[data-start]', panel).disabled = running;
  }
  function detach(pause = false) {
    const old = bound;
    bound = null; generation++;
    if (old) {
      for (const [name, handler] of old.listeners) old.v.removeEventListener(name, handler);
      old.doc.removeEventListener('click', old.userClick, true);
      if (pause) { try { old.v.pause(); } catch {} }
    }
  }
  function stop(reason) {
    running = false; pending = null; waiting = null; restore = null;
    detach(true); state = reason; save(); render();
  }
  function setState(value) { state = value; render(); }
  function waitFor(key, message, timeout = LOAD_TIMEOUT) {
    if (!waiting || waiting.key !== key) waiting = { key, at: now() };
    if (now() - waiting.at >= timeout) return stop(`${message}超时，请检查页面后点击开始`);
    setState(`等待${message}`);
  }
  function frameDocument(frame) {
    try {
      const doc = frame?.contentDocument;
      if (!doc) {
        const target = new URL(frame.getAttribute('src') || 'about:blank', frame.ownerDocument.URL);
        return target.origin === location.origin ? { loading: true } : { error: '无法访问嵌套页面（可能跨域或需要登录）' };
      }
      if (!doc.body || doc.readyState !== 'complete' || !doc.body.children.length || doc.URL === 'about:blank') return { loading: true };
      return { doc };
    } catch { return { error: '无法访问嵌套页面，请检查登录及页面权限' }; }
  }
  function synchronizeObservers(docs) {
    for (const [doc, observer] of watch) if (!docs.has(doc)) { observer.disconnect(); watch.delete(doc); }
    for (const doc of docs) {
      if (watch.has(doc) || !doc.body) continue;
      const observer = new MutationObserver(records => {
        if (records.some(r => !panel.contains(r.target))) schedule();
      });
      observer.observe(doc.body, { subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['class', 'src', 'aria-label', 'aria-hidden', 'style', 'hidden'] });
      watch.set(doc, observer);
    }
  }
  function blocked(docs) {
    for (const doc of docs) {
      if (/passport|\/login\b/i.test(doc.URL) || all('input[type="password"]', doc).some(visible)) return '页面需要登录，请手动处理后点击开始';
      const selector = '[role="dialog"],.el-dialog__wrapper,.layui-layer,.popDiv,.popdiv,.popUp,.ans-videoquiz,.ans-videoquiz-container,.videoquiz,#videoquiz,#videoquizpanel,#topicList,.quizWrap,#validate,.yidun_panel,.geetest_panel';
      for (const el of all(selector, doc)) {
        if (visible(el) && /答题|题目|单选|多选|判断|测验|考试|验证|登录|继续学习|是否继续|播放已暂停/.test(text(el))) return '页面需要答题、验证、登录或确认，请手动处理后点击开始';
      }
    }
    return '';
  }
  function taskDone(task) {
    if (optionalEnded.has(task.frame)) return true;
    const icon = $('.ans-job-icon', task.container);
    return !!icon && (/已完成/.test(icon.getAttribute('aria-label') || '') ||
      icon.classList.contains('ans-job-finished') || task.container.classList.contains('ans-job-finished'));
  }
  function speedPolicy(task) {
    let data = {};
    try { data = JSON.parse(task.frame.getAttribute('data') || '{}'); } catch {}
    const condition = text($('.task-condition', task.container));
    return data.doublespeed === 0 || data.doublespeed === '0' || /不可倍速|禁止倍速|不允许倍速/.test(condition) ? 'locked' : 'available';
  }
  function rateItem(doc, rate) {
    return all('.vjs-playback-rate .vjs-menu-item', doc).find(e => {
      const label = text($('.vjs-menu-item-text', e)) || text(e);
      return new RegExp(`^${rate}(?:\\.0+)?\\s*(?:x|×|倍)?$`, 'i').test(label);
    });
  }
  function applyMute(b) {
    if (!b.v.muted && b.v.volume !== 0) {
      const control = $('button.vjs-mute-control', b.doc);
      if (control && control.getAttribute('aria-disabled') !== 'true') control.click();
    }
    // 音量为零不等于 muted；新 iframe 自动播放前始终显式设置媒体静音。
    b.v.defaultMuted = true;
    if (!b.v.muted) b.v.muted = true;
    return b.v.muted;
  }
  function requestPlayback(b) {
    if (!running || bound !== b || b.seenPlaying || !b.v.paused || b.v.ended) return;
    if (b.lastPlayAt !== null && now() - b.lastPlayAt < (b.playPending ? 2000 : 1000)) return;
    if (now() - b.at >= LOAD_TIMEOUT) return;
    const request = ++b.playRequest;
    b.lastPlayAt = now(); b.playPending = true;
    applyMute(b);
    // Video.js 的大播放按钮还负责播放器初始化，不能只调用底层 video.play()。
    const button = $('button.vjs-big-play-button', b.doc);
    if (button && visible(button) && button.getAttribute('aria-disabled') !== 'true') button.click();
    applyMute(b);
    if (!b.v.paused) { b.playPending = false; return; }
    const failed = error => {
      if (!running || bound !== b || request !== b.playRequest) return;
      b.playPending = false;
      b.lastPlayError = /^(?:NotAllowedError|AbortError|NotSupportedError|InvalidStateError|NetworkError)$/.test(error?.name) ? error.name : '播放请求未就绪';
      // 切节初始化可能中止首次请求。保留运行状态，在加载事件或后续 tick 中重试。
      schedule();
    };
    try {
      Promise.resolve(b.v.play()).then(() => {
        if (bound === b && request === b.playRequest) { b.playPending = false; schedule(); }
      }, failed);
    } catch (error) { failed(error); }
  }
  function applySpeed(b) {
    if (b.speed === 'locked') { b.speedText = '原速（本视频禁止倍速）'; return; }
    if (b.speed === 'fallback') return;
    if (b.speed === 'checking') {
      if (now() - b.speedAt < 1500) return;
      if (b.v.playbackRate === 2) { b.speed = 'applied'; b.speedText = '原生2倍速'; return; }
      b.speed = 'fallback'; b.speedText = '保持原速（倍速未生效）';
      const normal = rateItem(b.doc, 1);
      if (normal) normal.click();
      return;
    }
    if (b.speed === 'applied') {
      if (b.v.playbackRate !== 2) { b.speed = 'fallback'; b.speedText = '保持原速（网站已恢复速度）'; }
      return;
    }
    const menu = $('.vjs-playback-rate.vjs-control', b.doc);
    const item = rateItem(b.doc, 2);
    if (!menu || menu.classList.contains('vjs-hidden') || !visible(menu) || !item || item.getAttribute('aria-disabled') === 'true') {
      b.speed = 'fallback'; b.speedText = '原速（无可用二倍速选项）'; return;
    }
    // 只使用播放器公开的原生菜单，不强设 playbackRate 或绕过课程限制。
    b.speed = 'checking'; b.speedAt = now(); b.speedText = '正在设置二倍速';
    $('button.vjs-playback-rate', menu)?.click(); item.click();
  }
  function bind(task, doc, v) {
    detach(true);
    const token = generation;
    const b = bound = { task, doc, v, token, src: source(v), listeners: [], speed: speedPolicy(task),
      speedText: '原速', at: now(), lastTime: v.currentTime, movement: now(), endedAt: null, seenPlaying: false,
      playRequest: 0, lastPlayAt: null, playPending: false, lastPlayError: '', userPauseRequested: false };
    const on = (event, handler) => { v.addEventListener(event, handler); b.listeners.push([event, handler]); };
    on('ended', () => { if (bound === b) { b.endedAt ??= now(); schedule(); } });
    on('error', () => { if (bound === b) stop('视频加载失败，请检查网络后点击开始'); });
    on('playing', () => { b.seenPlaying = true; b.movement = now(); b.playPending = false; schedule(); });
    for (const event of ['loadedmetadata', 'loadeddata', 'canplay']) on(event, schedule);
    b.userClick = event => {
      if (event.isTrusted && !v.paused && event.target?.closest('button.vjs-play-control,video')) b.userPauseRequested = true;
    };
    doc.addEventListener('click', b.userClick, true);
    on('volumechange', schedule);
    on('ratechange', schedule);
    on('pause', () => {
      setTimeout(() => {
        if (!running || bound !== b || token !== generation || !v.paused || v.ended || taskDone(task)) return;
        if (!b.seenPlaying && !b.userPauseRequested) { schedule(); return; }
        stop('播放已暂停，请处理页面提示后点击开始');
      }, 200);
    });
    applyMute(b);
    setState('正在加载并播放视频');
    requestPlayback(b);
  }
  function transition(target, kind, doc) {
    if (!running || pending) return;
    pending = { kind, targetId: kind === 'chapter' ? chapterId(target) : target.id,
      oldDoc: doc, at: now(), fromChapter: currentChapter };
    detach(true); waiting = null;
    save(kind === 'chapter' ? pending.targetId : currentChapter);
    setState(kind === 'chapter' ? '正在切换下一章节' : '正在切换下一内容页');
    (kind === 'chapter' ? $('.posCatalog_name', target) : target).click();
  }
  function nextPageOrChapter(doc) {
    const pages = tabs(), index = pages.findIndex(e => e.classList.contains('active'));
    if (pages.length > 1 && index < 0) return stop('无法识别当前内容页，请重新打开章节');
    if (index >= 0 && index + 1 < pages.length) return transition(pages[index + 1], 'page', doc);
    nextChapter(doc);
  }
  function nextChapter(doc) {
    const rows = catalog(), index = rows.indexOf(activeRow());
    if (index < 0) return stop('无法识别当前章节，请重新打开章节视频页');
    let next = index + 1;
    while (next < rows.length && chapterDone(rows[next])) { skipped++; next++; }
    if (next >= rows.length) return stop('后续视频已处理完毕');
    transition(rows[next], 'chapter', doc);
  }
  function tick() {
    if (!running || ticking) return;
    ticking = true;
    try { update(); } catch (error) {
      console.warn('[学习通连续播放助手]', error?.name || 'Error');
      stop('页面结构发生变化，已暂停；请重新打开章节后重试');
    } finally { ticking = false; }
  }
  function update() {
    lastCheck = now();
    if (context() !== course) {
      stop('已切换课程，请点击开始'); course = context(); currentChapter = ''; skipped = 0; save(); return;
    }
    const docs = new Set([document]), row = activeRow(), id = chapterId(row);
    const outerBlock = blocked(docs);
    if (outerBlock) return stop(outerBlock);
    if (!id) return waitFor('catalog', '章节目录');
    if (restore) {
      const accepted = id === restore.chapter || id === restore.expected;
      restore = null;
      if (!accepted) return stop('检测到章节已切换，请点击开始');
    }
    if (currentChapter && id !== currentChapter && (!pending || pending.kind !== 'chapter' || pending.targetId !== id)) return stop('检测到手动切换章节，请点击开始');
    if (!currentChapter) { currentChapter = id; save(); }
    const contentFrame = $('#iframe');
    if (!pending && chapterDone(row)) { skipped++; return nextChapter(contentFrame?.contentDocument); }
    if (!contentFrame) return waitFor('content', '章节内容');
    const content = frameDocument(contentFrame);
    if (content.error) return stop(content.error);
    if (pending && now() - pending.at >= LOAD_TIMEOUT) return stop('下一项加载超时，请检查页面后点击开始');
    if (!content.doc) return waitFor('content', '章节内容');
    const doc = content.doc;
    const loadedId = new URL(doc.URL, location.href).searchParams.get('knowledgeid');
    const requestedId = new URL(contentFrame.getAttribute('src'), location.href).searchParams.get('knowledgeid');
    if (loadedId !== id || requestedId !== id) return waitFor('identity', '当前章节内容');
    if (pending) {
      const p = pending;
      const targetOK = p.kind === 'chapter' ? id === p.targetId : tabs().some(e => e.id === p.targetId && e.classList.contains('active'));
      if (!targetOK || doc === p.oldDoc) { setState('等待新章节或内容页加载'); return; }
      currentChapter = id; pending = null; waiting = null; save();
    }
    docs.add(doc);
    const tasks = all('iframe.ans-insertvideo-online,iframe[src*="/ananas/modules/video/"]', doc).map(frame => ({
      frame, container: frame.closest('.ans-attach-ct') || frame.parentElement
    }));
    for (const task of tasks) {
      const result = frameDocument(task.frame);
      if (result.doc) docs.add(result.doc);
    }
    synchronizeObservers(docs);
    const reason = blocked(docs);
    if (reason) return stop(reason);
    if (inspectedContent !== doc) { inspectedContent = doc; contentSeenAt = now(); }
    if (bound && taskDone(bound.task)) detach(true);
    // 完成状态只来自当前已校验的章节及任务 DOM，不根据播放比例推测。
    if (chapterDone(row)) { skipped++; return nextChapter(doc); }
    const task = tasks.find(t => !taskDone(t));
    if (!task) {
      // 留出附件异步挂载时间；正文还没插入视频时不能立即误判为非视频页。
      if (!tasks.length && now() - contentSeenAt < 1500) { setState('正在检查本页视频内容'); return; }
      skipped += tasks.length ? 0 : 1;
      return nextPageOrChapter(doc);
    }
    const result = frameDocument(task.frame);
    if (result.error) return stop(result.error);
    if (!result.doc) return waitFor('player', '播放器');
    const v = $('video', result.doc);
    if (!v) return waitFor('video', '视频元素');
    if (bound && (bound.task.frame !== task.frame || bound.v !== v || bound.doc !== result.doc)) detach(true);
    if (bound && bound.src && source(v) && bound.src !== source(v)) return stop('检测到视频源切换，请点击开始');
    if (!bound) bind(task, result.doc, v);
    if (!running || !bound) return;
    const b = bound;
    b.src ||= source(v);
    if (v.error) return stop('视频加载失败，请检查网络后点击开始');
    if (v.ended) b.endedAt ??= now();
    if (b.endedAt !== null) {
      if (!$('.ans-job-icon', task.container)) {
        // 无任务点视频以自然结束为准；记录仅绑定当前 DOM，不能污染新页面。
        return finishOptionalVideo(task);
      }
      if (now() - b.endedAt >= LOAD_TIMEOUT) return stop('视频已结束，但网站尚未确认任务完成，请检查任务点后点击开始');
      setState('视频已结束，等待网站确认任务完成'); return;
    }
    if (v.readyState < 2 || !b.seenPlaying && v.paused) {
      if (now() - b.at >= LOAD_TIMEOUT) return stop(b.lastPlayError ?
        `视频自动启动失败（${b.lastPlayError}），请手动播放后点击开始` : '视频加载超时，请检查网络后点击开始');
      requestPlayback(b);
      setState(b.lastPlayError ? `正在重试启动视频（${b.lastPlayError}）` : '正在加载视频'); return;
    }
    waiting = null;
    applyMute(b); applySpeed(b);
    if (v.currentTime !== b.lastTime) { b.lastTime = v.currentTime; b.movement = now(); }
    if (now() - b.movement >= STALL_TIMEOUT) return stop('播放超过60秒未前进，请检查网络或页面提示');
    setState(`播放中 · ${b.speedText} / 静音`);
  }
  // 无任务点的视频也按顺序播放；用 WeakSet 保存自然结束状态，不更改网站任务状态。
  function finishOptionalVideo(task) {
    optionalEnded.add(task.frame); detach(true); schedule();
  }
  let scheduled = false;
  function schedule() {
    if (!running || scheduled) return;
    scheduled = true;
    // 合并短时间内的 DOM/媒体事件，避免播放器频繁更新引起高占用。
    setTimeout(() => { scheduled = false; tick(); }, Math.max(50, 200 - (now() - lastCheck)));
  }
  function start() {
    if (running) return;
    const changedCourse = context() !== course;
    if (changedCourse) { course = context(); skipped = 0; }
    detach(true); pending = null; waiting = null; currentChapter = ''; inspectedContent = null;
    running = true; save(); tick();
  }
  $('[data-start]', panel).addEventListener('click', start);
  $('[data-stop]', panel).addEventListener('click', () => stop('已暂停'));
  window.addEventListener('pagehide', () => {
    save(pending?.kind === 'chapter' ? pending.targetId : '');
    detach(true); for (const observer of watch.values()) observer.disconnect(); watch.clear();
  });
  setInterval(() => {
    if (!running && context() !== course) { course = context(); skipped = 0; currentChapter = ''; save(); }
    tick();
  }, 1000);
  synchronizeObservers(new Set([document])); render();
  const saved = read(storageKey()), previousContext = read('cx-autoplay-context-v1');
  if (saved?.running && previousContext === course) { restore = saved; start(); }
})();
