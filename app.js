'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $('fileInput'),
  status: $('status'),
  fileName: $('fileName'),
  pageNav: $('pageNav'),
  prevPage: $('prevPage'),
  nextPage: $('nextPage'),
  pageInput: $('pageInput'),
  pageCount: $('pageCount'),
  text: $('text'),
  controls: $('controls'),
  playPause: $('playPause'),
  stop: $('stop'),
  prevSentence: $('prevSentence'),
  nextSentence: $('nextSentence'),
  rate: $('rate'),
  rateLabel: $('rateLabel'),
  voice: $('voice'),
};

const synth = window.speechSynthesis;

const state = {
  pdf: null,
  docKey: '',
  page: 1,
  sentences: [],
  index: 0,
  playing: false,
  // 古い発話のonendを無視するための番号
  token: 0,
  pageCache: new Map(),
  voices: [],
};

// ---------- 保存（この端末のブラウザ内だけ） ----------

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch (e) {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // プライベートブラウズ等では保存できなくても動くようにする
  }
}

function savePosition() {
  if (state.docKey) save('pos:' + state.docKey, { page: state.page, index: state.index });
}

// ---------- テキスト抽出 ----------

const CJK = /[　-ヿ㐀-鿿豈-﫿＀-￯]/;
const SENTENCE_END = /[。．！？!?]/;

function itemsToText(items) {
  let raw = '';
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const prev = raw.slice(-1);
    const next = item.str.charAt(0);
    // 英単語同士がくっつかないようにする
    if (prev && next && /[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next)) raw += ' ';
    raw += item.str;
    if (item.hasEOL) raw += '\n';
  }

  // PDFの行末改行を文の途中ではつなげる
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  let out = '';
  for (const line of lines) {
    if (!out) {
      out = line;
      continue;
    }
    const last = out.slice(-1);
    if (SENTENCE_END.test(last) || /[」』）)]$/.test(out)) {
      out += '\n' + line;
    } else if (CJK.test(last) || CJK.test(line.charAt(0))) {
      out += line;
    } else if (last === '-') {
      out = out.slice(0, -1) + line;
    } else {
      out += ' ' + line;
    }
  }
  return out;
}

function splitSentences(text) {
  const result = [];
  let buf = '';
  const push = () => {
    const s = buf.trim();
    if (s) result.push(buf);
    else if (buf && result.length) result[result.length - 1] += buf;
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    buf += ch;
    if (ch === '\n') {
      push();
      continue;
    }
    const isEnd = SENTENCE_END.test(ch) || (ch === '.' && /\s/.test(text[i + 1] || ' '));
    if (isEnd) {
      // 直後の閉じかっこも同じ文に含める
      while (i + 1 < text.length && /[」』）)"'”]/.test(text[i + 1])) buf += text[++i];
      push();
    } else if (buf.length > 160 && /[、，,\s]/.test(ch)) {
      // 長すぎる文は読点で区切る（iPhoneで長い発話が途切れるのを防ぐ）
      push();
    }
  }
  push();
  return result;
}

async function getPageSentences(pageNum) {
  if (state.pageCache.has(pageNum)) return state.pageCache.get(pageNum);
  const page = await state.pdf.getPage(pageNum);
  const content = await page.getTextContent();
  const sentences = splitSentences(itemsToText(content.items));
  state.pageCache.set(pageNum, sentences);
  return sentences;
}

// ---------- 表示 ----------

function render() {
  els.text.textContent = '';
  if (state.sentences.length === 0) {
    const p = document.createElement('span');
    p.className = 'status';
    p.textContent = '（このページには読み取れる文字がありません）';
    els.text.appendChild(p);
  }
  state.sentences.forEach((s, i) => {
    const span = document.createElement('span');
    span.className = 'sentence';
    span.dataset.i = String(i);
    span.textContent = s;
    els.text.appendChild(span);
  });
  els.pageInput.value = String(state.page);
  els.prevPage.disabled = state.page <= 1;
  els.nextPage.disabled = state.page >= state.pdf.numPages;
  highlight();
}

function highlight() {
  const prev = els.text.querySelector('.sentence.current');
  if (prev) prev.classList.remove('current');
  const cur = els.text.querySelector(`.sentence[data-i="${state.index}"]`);
  if (cur) {
    cur.classList.add('current');
    if (state.playing) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function updatePlayButton() {
  els.playPause.textContent = state.playing ? '❚❚' : '▶︎';
  els.playPause.setAttribute('aria-label', state.playing ? '一時停止' : '再生');
}

// ---------- 読み上げ ----------

function selectedVoice() {
  return state.voices.find((v) => v.voiceURI === els.voice.value) || null;
}

function speakCurrent() {
  const token = ++state.token;
  const text = state.sentences[state.index];
  if (text === undefined) {
    goToNextPageAndContinue(token);
    return;
  }
  const u = new SpeechSynthesisUtterance(text);
  const voice = selectedVoice();
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  } else {
    u.lang = 'ja-JP';
  }
  u.rate = Number(els.rate.value);
  u.onend = () => {
    if (token !== state.token || !state.playing) return;
    state.index++;
    savePosition();
    if (state.index < state.sentences.length) {
      highlight();
      speakCurrent();
    } else {
      goToNextPageAndContinue(token);
    }
  };
  u.onerror = (e) => {
    if (token !== state.token) return;
    if (e.error === 'interrupted' || e.error === 'canceled') return;
    stopPlaying();
    els.status.textContent = '読み上げでエラーが起きました: ' + e.error;
  };
  highlight();
  synth.speak(u);
}

async function goToNextPageAndContinue(token) {
  if (state.page >= state.pdf.numPages) {
    stopPlaying();
    state.index = 0;
    els.status.textContent = '最後まで読み終わりました。';
    return;
  }
  await showPage(state.page + 1, 0);
  if (token === state.token && state.playing) speakCurrent();
}

function startPlaying() {
  if (!state.pdf) return;
  state.playing = true;
  updatePlayButton();
  synth.cancel();
  // iPhoneのSafariはcancel直後のspeakを無視することがあるので少し待つ
  setTimeout(() => {
    if (state.playing) speakCurrent();
  }, 60);
}

function stopPlaying() {
  state.playing = false;
  state.token++;
  synth.cancel();
  updatePlayButton();
  savePosition();
}

function restartIfPlaying() {
  if (state.playing) startPlaying();
  else highlight();
}

// ---------- ページ移動 ----------

async function showPage(pageNum, index) {
  pageNum = Math.min(Math.max(1, pageNum), state.pdf.numPages);
  state.page = pageNum;
  state.sentences = await getPageSentences(pageNum);
  state.index = Math.min(Math.max(0, index), Math.max(0, state.sentences.length - 1));
  render();
  savePosition();
  // 次のページを先読みしておく
  if (pageNum < state.pdf.numPages) getPageSentences(pageNum + 1).catch(() => {});
}

async function jumpToPage(pageNum) {
  const wasPlaying = state.playing;
  if (wasPlaying) stopPlaying();
  await showPage(pageNum, 0);
  if (wasPlaying) startPlaying();
}

// ---------- ファイル読み込み ----------

async function openFile(file) {
  stopPlaying();
  els.status.textContent = '読み込み中…';
  els.text.textContent = '';
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({
      data,
      cMapUrl: 'vendor/pdfjs/cmaps/',
      cMapPacked: true,
    }).promise;
    if (state.pdf) state.pdf.destroy();
    state.pdf = pdf;
    state.pageCache = new Map();
    state.docKey = file.name + ':' + file.size;
    els.fileName.textContent = file.name;
    els.pageCount.textContent = String(pdf.numPages);
    els.pageInput.max = String(pdf.numPages);
    els.pageNav.hidden = false;
    els.controls.hidden = false;

    const pos = load('pos:' + state.docKey, { page: 1, index: 0 });
    await showPage(pos.page, pos.index);
    const resumed = pos.page > 1 || pos.index > 0;
    els.status.textContent = resumed
      ? `前回の続き（${state.page}ページ）から読めます。▶︎で再生します。`
      : '▶︎で読み上げを始めます。文をタップするとそこから読みます。';
    checkHasText();
  } catch (err) {
    console.error(err);
    els.status.textContent = 'PDFを開けませんでした: ' + (err && err.message ? err.message : err);
  }
}

async function checkHasText() {
  // 最初の数ページに文字がなければ、画像だけのPDF（スキャン）と判断して知らせる
  const pdf = state.pdf;
  const n = Math.min(pdf.numPages, 3);
  for (let p = 1; p <= n; p++) {
    const s = await getPageSentences(p);
    if (state.pdf !== pdf) return;
    if (s.length > 0) return;
  }
  els.status.textContent =
    'このPDFには文字データが見つかりません。スキャンした画像のPDFは読み上げできません。';
}

// ---------- 声の一覧 ----------

function loadVoices() {
  const voices = synth.getVoices();
  if (!voices.length) return;
  const ja = voices.filter((v) => v.lang.toLowerCase().startsWith('ja'));
  const others = voices.filter((v) => !v.lang.toLowerCase().startsWith('ja'));
  state.voices = [...ja, ...others];
  const saved = load('voice', '');
  els.voice.textContent = '';
  for (const v of state.voices) {
    const opt = document.createElement('option');
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} (${v.lang})`;
    els.voice.appendChild(opt);
  }
  if (saved && state.voices.some((v) => v.voiceURI === saved)) els.voice.value = saved;
  else if (ja.length) els.voice.value = ja[0].voiceURI;
}

// ---------- イベント ----------

els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files && els.fileInput.files[0];
  if (file) openFile(file);
  els.fileInput.value = '';
});

els.playPause.addEventListener('click', () => {
  if (state.playing) stopPlaying();
  else startPlaying();
});

els.stop.addEventListener('click', () => {
  stopPlaying();
  state.index = 0;
  savePosition();
  highlight();
});

els.prevSentence.addEventListener('click', async () => {
  if (state.index > 0) {
    state.index--;
  } else if (state.page > 1) {
    const wasPlaying = state.playing;
    if (wasPlaying) stopPlaying();
    const prev = await getPageSentences(state.page - 1);
    await showPage(state.page - 1, prev.length - 1);
    if (wasPlaying) startPlaying();
    return;
  }
  savePosition();
  restartIfPlaying();
});

els.nextSentence.addEventListener('click', async () => {
  if (state.index < state.sentences.length - 1) {
    state.index++;
    savePosition();
    restartIfPlaying();
  } else if (state.page < state.pdf.numPages) {
    await jumpToPage(state.page + 1);
  }
});

els.prevPage.addEventListener('click', () => jumpToPage(state.page - 1));
els.nextPage.addEventListener('click', () => jumpToPage(state.page + 1));
els.pageInput.addEventListener('change', () => {
  const n = parseInt(els.pageInput.value, 10);
  if (!Number.isNaN(n)) jumpToPage(n);
});

els.text.addEventListener('click', (e) => {
  const span = e.target.closest('.sentence');
  if (!span) return;
  state.index = Number(span.dataset.i);
  savePosition();
  startPlaying();
});

els.rate.addEventListener('input', () => {
  els.rateLabel.textContent = Number(els.rate.value).toFixed(1);
});
els.rate.addEventListener('change', () => {
  save('rate', Number(els.rate.value));
  restartIfPlaying();
});

els.voice.addEventListener('change', () => {
  save('voice', els.voice.value);
  restartIfPlaying();
});

// 初期化
els.rate.value = String(load('rate', 1));
els.rateLabel.textContent = Number(els.rate.value).toFixed(1);
loadVoices();
if ('onvoiceschanged' in synth) synth.addEventListener('voiceschanged', loadVoices);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
