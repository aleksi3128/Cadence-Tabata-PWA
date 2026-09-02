'use strict';

/* ═══════════════════════════════════════
   EXERCISE MODEL
   An exercise is either time-based  { name, work: 30, rest: 10 }
   or rep-based                      { name, reps: 15, rest: 15 }
   ═══════════════════════════════════════ */

// Rep-based exercises have no known duration. This per-rep guess is used ONLY
// to estimate session/round totals — never to end a phase.
const REP_EST_SECONDS = 2;

const isReps = ex => !!ex && Number(ex.reps) > 0;

/** Seconds an exercise is expected to take (an estimate when rep-based). */
const exDuration = ex => isReps(ex)
  ? Math.max(10, Math.round(Number(ex.reps) * REP_EST_SECONDS))
  : Math.max(0, Number(ex.work) || 0);

const seriesHasReps = s => !!s?.exercises?.some(isReps);

/* ═══════════════════════════════════════
   WORKOUT LINK — a whole workout encoded in the URL
   ?w=Full+Body~8~60~Crunch:30s:10~Push+ups:15x:15:20+kg
      name ~ rounds ~ round_rest ~ exercise:duration:rest[:note] ~ …
      30s = 30 seconds (time based)    15x = 15 reps (rep based)
      note = free text shown under the exercise name; optional, may be empty
   ═══════════════════════════════════════ */
const WorkoutLink = (() => {
  const PARAM = 'w';

  // Origine utilisée quand on construit un lien hors du web : le build natif
  // iOS tourne sur capacitor://localhost et un lien pointant là est
  // inouvrable. Valeur injectée depuis .env (PUBLIC_BASE_URL).
  const publicBase = () => window.TABATA_CONFIG?.publicBaseUrl || '';

  // encodeURIComponent escapes ':' but leaves '~' alone, so escape that by
  // hand; '+' for spaces keeps the link readable.
  const enc = s => encodeURIComponent(String(s ?? ''))
    .replace(/~/g, '%7E')
    .replace(/%20/g, '+');

  const dec = s => {
    try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); }
    catch (_) { return String(s); }
  };

  // Read the raw, still-encoded value: URLSearchParams would turn %7E back
  // into a '~' and corrupt the split.
  const _raw = (search = location.search) => {
    const m = new RegExp('[?&]' + PARAM + '=([^&]*)').exec(search);
    return m ? m[1] : null;
  };

  const has = (search = location.search) => _raw(search) !== null;

  function encode(series) {
    const head = [
      enc(series.name || 'Workout'),
      Math.max(1, parseInt(series.rounds, 10) || 1),
      Math.max(0, parseInt(series.round_rest, 10) || 0),
    ];
    const exs = (series.exercises || []).map(ex => {
      const f = [
        enc(ex.name || 'Exercise'),
        isReps(ex) ? `${Math.max(1, Math.round(ex.reps))}x` : `${Math.max(1, Math.round(ex.work))}s`,
        Math.max(0, Math.round(ex.rest) || 0),
      ];
      // Champ omis quand la note est vide : inutile d'alourdir chaque lien
      // d'un deux-points de plus pour l'immense majorité des exercices.
      const note = String(ex.note ?? '').trim();
      if (note) f.push(enc(note));
      return f.join(':');
    });
    return head.concat(exs).join('~');
  }

  function decode(search = location.search) {
    const raw = _raw(search);
    if (!raw) return null;

    const parts = raw.split('~');
    if (parts.length < 4) return null;

    const exercises = [];
    for (const token of parts.slice(3)) {
      const f = token.split(':');
      const name = dec(f[0] || '').trim();
      if (!name) continue;
      const durTok = (f[1] || '20s').trim().toLowerCase();
      const value  = Math.min(999, Math.max(1, parseInt(durTok, 10) || 20));
      const rest   = Math.min(999, Math.max(0, parseInt(f[2], 10) || 0));
      // Un lien à trois champs reste valide : la note est simplement absente.
      // f.slice(3) et non f[3] : un deux-points non échappé dans la note ne
      // doit pas la tronquer silencieusement.
      const note = f.length > 3 ? dec(f.slice(3).join(':')).trim() : '';
      const base = durTok.endsWith('x')
        ? { name, reps: value, rest }
        : { name, work: value, rest };
      exercises.push(note ? { ...base, note } : base);
    }
    if (!exercises.length) return null;

    return {
      name:       dec(parts[0]).trim() || 'Workout',
      rounds:     Math.min(99,  Math.max(1, parseInt(parts[1], 10) || 1)),
      round_rest: Math.min(900, Math.max(0, parseInt(parts[2], 10) || 0)),
      exercises,
    };
  }

  /** Absolute shareable URL for a series. */
  function build(series) {
    const onWeb = location.protocol === 'https:' || location.protocol === 'http:';
    const base = (!onWeb && publicBase())
      ? publicBase().replace(/\/+$/, '') + '/'
      : location.origin + location.pathname;
    return `${base}?${PARAM}=${encode(series)}`;
  }

  /** Drop ?w= from the address bar so a reload doesn't reopen the preview. */
  function clear() {
    if (!has()) return;
    const p = new URLSearchParams(location.search);
    p.delete(PARAM);
    const q = p.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
  }

  return { PARAM, has, encode, decode, build, clear };
})();

/* ═══════════════════════════════════════
   AUDIO ENGINE
   ═══════════════════════════════════════ */

// Paliers signalés pendant un décompte. Le nombre de bips donne le palier —
// trois à 30 s, deux à 20 s, un à 10 s — et la hauteur monte à l'approche.
// Un fichier par marqueur, sans déclinaison de langue : sounds/mark_<mark>.wav
// (voir scripts/gen-marks.py). Des bips remplacent les annonces vocales de
// synthèse, qui sonnaient mécanique et demandaient un fichier par langue.
const MARKS = [30, 20, 10];

class AudioEngine {
  constructor() {
    this.enabled  = true;
    this._ctx     = null;
    this._buffers = {};
    this._ready   = false;
    this._load();
  }

  get _isNative() { return !!(window.webkit?.messageHandlers?.nativeAudio); }

  _ctx_get() {
    if (!this._ctx) this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    return this._ctx;
  }

  async _load() {
    const ctx = this._ctx_get();
    const names = ['countdown', 'go', 'work', 'rest', 'round_rest', 'complete']
      .concat(MARKS.map(v => `mark_${v}`));
    await Promise.all(names.map(async n => {
      try {
        const ab = await (await fetch(`sounds/${n}.wav`)).arrayBuffer();
        this._buffers[n] = await ctx.decodeAudioData(ab);
      } catch (_) {}
    }));
    this._ready = true;
  }

  unlock() {
    this._ctx_get().resume().catch(() => {});
  }

  play(event) {
    if (!this.enabled) return;
    // Use native AVAudioPlayer bridge when running inside the iOS app —
    // it bypasses Web Audio API routing issues on WKWebView entirely.
    if (this._isNative) {
      window.webkit.messageHandlers.nativeAudio.postMessage({ sound: event });
      return;
    }
    // Web Audio API fallback (browser / simulator)
    if (!this._ready) return;
    const buf = this._buffers[event];
    if (!buf) return;
    const ctx = this._ctx_get();
    if (ctx.state === 'suspended') {
      ctx.resume().then(() => {
        try {
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(ctx.destination);
          src.start(0);
        } catch (_) {}
      }).catch(() => {});
      return;
    }
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    } catch (_) {}
  }
}

/* ═══════════════════════════════════════
   TABATA TIMER
   ═══════════════════════════════════════ */
class TabataTimer {
  constructor(audio) {
    this._audio = audio;
    this._series = null;
    this._round = 1;
    this._exIdx = 0;
    this._phase = 'idle';
    this._timeRem = 0;
    this._timeTotal = 0;
    this._countUp = false;
    this._running = false;
    this._iid = null;
    this._lastTick = 0;
    this._countdownBeeps = new Set();
    this._marksPlayed = new Set();
    this._sessionElapsed = 0;
    this._roundElapsed = 0;
    this._sessionTotal = 0;
    this._roundTotal   = 0;
  }

  get isRunning() { return this._running; }
  get phase() { return this._phase; }
  get series() { return this._series; }
  /** True while a rep-based exercise is waiting on "I finished". */
  get isRepPhase() { return this._countUp && this._phase === 'work'; }

  load(series) {
    this._series = series;
    const d = this._calcDurations(series);
    this._sessionTotal = d.sessionTotal;
    this._roundTotal   = d.roundTotal;
    this.reset();
  }

  _calcDurations(series) {
    if (!series?.exercises?.length) return { sessionTotal: 0, roundTotal: 0 };
    const roundTotal = series.exercises.reduce((s, ex) => s + exDuration(ex) + ex.rest, 0);
    const sessionTotal = roundTotal * series.rounds + series.round_rest * Math.max(0, series.rounds - 1);
    return { sessionTotal, roundTotal };
  }

  reset() {
    this._stop_interval();
    this._running = false;
    this._round = 1;
    this._exIdx = 0;
    this._sessionElapsed = 0;
    this._roundElapsed = 0;
    this._setPhase('idle', 0);
  }

  toggle() {
    if (this._running) {
      this.pause();
    } else {
      this.start();
    }
  }

  start() {
    if (!this._series || !this._series.exercises.length) return;
    if (this._phase === 'complete') { this.reset(); return; }
    if (this._phase === 'idle') {
      this._setPhase('ready', 3);
    }
    this._running = true;
    this._lastTick = Date.now();
    this._iid = setInterval(() => this._tick(), 80);
    this._emit();
  }

  pause() {
    this._stop_interval();
    this._running = false;
    this._emit();
  }

  skip() {
    if (this._phase === 'idle') return;
    this._advance();
  }

  _stop_interval() {
    if (this._iid) { clearInterval(this._iid); this._iid = null; }
  }

  _setPhase(phase, duration, countUp = false) {
    this._phase = phase;
    this._countUp = countUp;
    this._timeRem = countUp ? 0 : duration;
    this._timeTotal = duration;
    this._countdownBeeps.clear();
    this._marksPlayed.clear();
    this._emit();
  }

  _tick() {
    const now = Date.now();
    const elapsed = (now - this._lastTick) / 1000;
    this._lastTick = now;

    if (this._phase === 'idle' || this._phase === 'complete') return;

    if (this._phase === 'work' || this._phase === 'rest' || this._phase === 'round_rest') {
      this._sessionElapsed += elapsed;
    }
    if (this._phase === 'work' || this._phase === 'rest') {
      this._roundElapsed += elapsed;
    }

    const prevRem = this._timeRem;

    // Rep-based work: count elapsed time up and wait for "I finished".
    // No countdown beeps, no auto-advance.
    if (this._countUp) {
      this._timeRem = prevRem + elapsed;
      this._emit();
      return;
    }

    this._timeRem = Math.max(0, prevRem - elapsed);

    // Signal every mark (30, 20, 10) crossed downward in this tick.
    for (const v of MARKS) {
      if (prevRem > v && this._timeRem <= v && !this._marksPlayed.has(v)) {
        this._marksPlayed.add(v);
        this._audio.play(`mark_${v}`);
      }
    }

    // Fire a beep for every second mark (3, 2, 1) crossed downward in this tick.
    // Using threshold-crossing instead of Math.ceil handles slow/skipped ticks correctly.
    for (let v = 3; v >= 1; v--) {
      if (prevRem > v && this._timeRem <= v && !this._countdownBeeps.has(v)) {
        this._countdownBeeps.add(v);
        this._audio.play('countdown');
      }
    }

    if (this._timeRem <= 0) {
      this._advance();
    } else {
      this._emit();
    }
  }

  _advance() {
    if (!this._series) return;
    const exs = this._series.exercises;
    const curEx = exs[this._exIdx];

    if (this._phase === 'ready') {
      this._startWork(curEx, 'go');
      return;
    }

    if (this._phase === 'work') {
      const isLastEx    = this._exIdx >= this._series.exercises.length - 1;
      const isLastRound = this._round >= this._series.rounds;
      if (isLastEx && isLastRound) {
        this._nextExOrRound();
      } else if (curEx.rest > 0) {
        this._setPhase('rest', curEx.rest);
        this._audio.play('rest');
      } else {
        this._nextExOrRound();
      }
      return;
    }

    if (this._phase === 'rest') {
      this._nextExOrRound();
      return;
    }

    if (this._phase === 'round_rest') {
      this._exIdx = 0;
      this._roundElapsed = 0;
      this._startWork(exs[0], 'work');
      return;
    }
  }

  _startWork(ex, sound) {
    this._setPhase('work', exDuration(ex), isReps(ex));
    this._audio.play(sound);
  }

  /** "I finished" tapped on a rep-based exercise. */
  finishReps() {
    if (!this.isRepPhase) return;
    this._advance();
  }

  _nextExOrRound() {
    const exs = this._series.exercises;

    if (this._exIdx < exs.length - 1) {
      this._exIdx++;
      this._startWork(exs[this._exIdx], 'work');
      return;
    }

    if (this._round < this._series.rounds) {
      this._round++;
      if (this._series.round_rest > 0) {
        this._setPhase('round_rest', this._series.round_rest);
        this._audio.play('round_rest');
      } else {
        this._exIdx = 0;
        this._startWork(exs[0], 'work');
      }
    } else {
      this._stop_interval();
      this._running = false;
      this._setPhase('complete', 0);
      this._audio.play('complete');
    }
  }

  _emit() {
    const ex = this._series?.exercises[this._exIdx] || null;
    const nextEx = this._series?.exercises[this._exIdx + 1] || null;
    document.dispatchEvent(new CustomEvent('timerUpdate', {
      detail: {
        phase: this._phase,
        round: this._round,
        totalRounds: this._series?.rounds || 0,
        exIdx: this._exIdx,
        totalEx: this._series?.exercises.length || 0,
        exercise: ex,
        nextExercise: nextEx,
        timeRem: this._timeRem,
        timeTotal: this._timeTotal,
        progress: this._timeTotal <= 0 ? 0
                : this._countUp ? Math.min(1, this._timeRem / this._timeTotal)
                : 1 - this._timeRem / this._timeTotal,
        isRunning: this._running,
        isRepPhase: this.isRepPhase,
        estimated: seriesHasReps(this._series),
        series: this._series,
        ...this._calcRemaining(),
        sessionTotal: this._sessionTotal,
        roundTotal:   this._roundTotal,
      }
    }));
  }

  _calcRemaining() {
    const exs = this._series?.exercises;
    if (!exs?.length || ['idle', 'complete', 'ready'].includes(this._phase)) {
      return { sessionRemaining: this._sessionTotal, roundRemaining: this._roundTotal };
    }
    const R = this._series.rounds;
    const rr = this._series.round_rest;
    const r = this._round;
    const i = this._exIdx;
    const isLastRound = r >= R;
    const roundsAfter = R - r;

    let roundRem;
    if (this._phase === 'round_rest') {
      roundRem = this._roundTotal;
    } else {
      // In a rep phase _timeRem counts up, so fall back to the estimate.
      roundRem = this._countUp ? Math.max(0, this._timeTotal - this._timeRem) : this._timeRem;
      if (this._phase === 'work') {
        const isLastEx = i >= exs.length - 1;
        if (!(isLastEx && isLastRound)) roundRem += exs[i].rest;
      }
      for (let j = i + 1; j < exs.length; j++) {
        const isLastJ = j === exs.length - 1 && isLastRound;
        roundRem += exDuration(exs[j]) + (isLastJ ? 0 : exs[j].rest);
      }
    }

    let sessionRem;
    if (this._phase === 'round_rest') {
      sessionRem = this._timeRem
                 + roundsAfter * this._roundTotal
                 + Math.max(0, roundsAfter - 1) * rr;
    } else {
      sessionRem = roundRem + roundsAfter * (rr + this._roundTotal);
    }

    return {
      sessionRemaining: Math.max(0, sessionRem),
      roundRemaining:   Math.max(0, roundRem),
    };
  }

  getState() {
    const ex = this._series?.exercises[this._exIdx] || null;
    return { phase: this._phase, round: this._round, isRunning: this._running, exercise: ex };
  }
}

/* ═══════════════════════════════════════
   EXERCISE DB — 1324 exercices, vignette + GIF animé + instructions FR/EN
   Contenu de www/exercise-db/, généré par `npm run fetch:exercises`.
   Absent du dépôt : tout ici doit se dégrader proprement s'il manque.
   Médias © Gym visual — https://gymvisual.com/
   ═══════════════════════════════════════ */
const ExerciseDB = (() => {
  const BASE = 'exercise-db/';

  let _cat     = null;          // catalog.json, facettes déjà triées
  let _loading = null;          // load() est appelé de partout : une seule requête
  let _failed  = false;
  const _byId   = new Map();
  const _byName = new Map();    // nom normalisé → exercice
  const _steps  = {};           // langue → { id: [étapes] }
  const _stepsLoading = {};
  const _resolved = new Map();  // nom libre → exercice | null (résolution coûteuse)
  let _df = new Map();          // mot → nombre d'exercices qui le portent

  /* ── Normalisation ────────────────────────────────────────────────── */

  // « Push-Ups (male) » et « push ups » doivent tomber sur la même clé.
  const norm = s => String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  /**
   * Le dataset est intégralement en anglais, l'app est francophone : sans ce
   * pont, taper « pompes » ou « gainage » ne remonte rien. La traduction se
   * fait mot à mot, un mot pouvant donner plusieurs équivalents anglais.
   */
  const FR_EN = {
    pompe: 'push up', pompes: 'push up',
    traction: 'pull up', tractions: 'pull up',
    fente: 'lunge', fentes: 'lunge',
    gainage: 'plank', planche: 'plank',
    abdo: 'abs crunch', abdos: 'abs crunch', abdominaux: 'abs crunch',
    releve: 'raise', releves: 'raise',
    souleve: 'deadlift',
    developpe: 'press', couche: 'bench press', militaire: 'military press',
    tirage: 'pulldown row', rowing: 'row', rameur: 'row',
    elevation: 'raise', elevations: 'raise',
    extension: 'extension', extensions: 'extension',
    flexion: 'curl', flexions: 'curl',
    epaule: 'shoulder delts', epaules: 'shoulder delts',
    bras: 'arm', jambe: 'leg', jambes: 'leg',
    dos: 'back', poitrine: 'chest', pec: 'pectorals', pecs: 'pectorals',
    pectoraux: 'pectorals', ventre: 'abs', taille: 'waist', cou: 'neck',
    fessier: 'glutes', fessiers: 'glutes',
    mollet: 'calf', mollets: 'calf',
    cuisse: 'quads thigh', cuisses: 'quads thigh',
    ischio: 'hamstrings', ischios: 'hamstrings',
    dorsaux: 'lats', trapeze: 'traps', trapezes: 'traps',
    avantbras: 'forearms', poignet: 'wrist', poignets: 'wrist',
    hanche: 'hip', hanches: 'hip', genou: 'knee', genoux: 'knee',
    cheville: 'ankle', talon: 'heel', talons: 'heel',
    haltere: 'dumbbell', halteres: 'dumbbell',
    barre: 'barbell', poulie: 'cable', elastique: 'band',
    machine: 'machine', banc: 'bench', corde: 'rope',
    kettlebell: 'kettlebell', lest: 'weighted', leste: 'weighted',
    ballon: 'ball', roue: 'wheel roller', rouleau: 'roller',
    velo: 'bike', course: 'run', marche: 'walk', tapis: 'treadmill',
    saut: 'jump', sauts: 'jump', saute: 'jump', sautee: 'jump', sauter: 'jump',
    montee: 'step up', escalade: 'climber',
    chaise: 'wall sit', oiseau: 'rear delt fly',
    russe: 'russian', lateral: 'lateral',
    laterale: 'lateral', lateraux: 'lateral', cote: 'side',
    incline: 'incline', inclinee: 'incline',
    decline: 'decline', declinee: 'decline',
    debout: 'standing', assis: 'seated', assise: 'seated',
    allonge: 'lying', allongee: 'lying', couchee: 'lying',
    inverse: 'reverse', inversee: 'reverse',
    avant: 'front', arriere: 'rear back',
    large: 'wide', serre: 'close grip', serree: 'close grip',
    prise: 'grip', tendu: 'straight arm',
    unilateral: 'one arm', alterne: 'alternating', alternee: 'alternating',
    etirement: 'stretch', etirements: 'stretch',
    rotation: 'rotation', torsion: 'twist',
    suspendu: 'hanging', suspendue: 'hanging',
    ciseaux: 'scissor',
    grimpeur: 'mountain climber', burpee: 'burpee', burpees: 'burpee',
  };

  /**
   * Les variantes d'un mot de recherche : lui-même, son pluriel/singulier, et
   * sa traduction. « crunchs » doit atteindre « crunch floor », « pompes »
   * doit atteindre « push-up ».
   */
  function _variants(token) {
    const out = new Set([token]);
    // Seuil à 3 lettres et non 4 : « ups » doit donner « up », sans quoi
    // « push ups wide grip » ne retrouve jamais un « push-up ».
    if (token.length > 2) {
      // « crunches » → « crunch » : sans le cas -es, on obtient « crunche »,
      // qui n'est un préfixe de rien et fait rater tout le mot.
      if (token.endsWith('ies'))     out.add(token.slice(0, -3) + 'y');
      else if (token.endsWith('es')) out.add(token.slice(0, -2));
      if (token.endsWith('s'))       out.add(token.slice(0, -1));
      else                           out.add(token + 's');
    }
    const fr = FR_EN[token];
    if (fr) for (const w of fr.split(' ')) out.add(w);
    return [...out];
  }

  /**
   * Les mots exploitables d'une requête. Les mots d'une lettre sont écartés :
   * le « a » de « corde a sauter » ne porte aucun sens mais, dans un ET, il
   * suffit à ne rien renvoyer du tout.
   */
  function _tokenize(q) {
    const all = norm(q).split(' ').filter(Boolean);
    const solid = all.filter(t => t.length > 1);
    // « V-ups » n'a que le « v » pour se distinguer : on ne jette les mots
    // d'une lettre que s'il reste au moins deux mots pour porter la requête.
    return (solid.length >= 2 ? solid : all).map(t => {
      const vars = _variants(t);
      return { vars, idf: _idf(vars) };
    });
  }

  /* ── Chargement ───────────────────────────────────────────────────── */

  async function load() {
    if (_cat || _failed) return _cat;
    if (_loading) return _loading;

    _loading = (async () => {
      try {
        const res = await fetch(`${BASE}catalog.json`);
        if (!res.ok) throw new Error(res.status);
        const cat = await res.json();
        if (!Array.isArray(cat?.exercises) || !cat.exercises.length) throw new Error('vide');

        // Les bottes de foin sont calculées une fois : les recalculer à chaque
        // frappe reviendrait à normaliser 1324 chaînes par caractère tapé.
        for (const ex of cat.exercises) {
          ex.hay  = norm(ex.n);
          ex.tok  = ex.hay.split(' ').filter(Boolean);
          ex.flat = ex.hay.replace(/ /g, '');   // « push up » → « pushup »
          ex.meta = norm([
            cat.equipment[ex.e], cat.targets[ex.t], cat.bodyParts[ex.b],
            ...(ex.s || []).map(i => cat.muscles[i]),
          ].filter(Boolean).join(' '));
          _byId.set(ex.i, ex);
          if (!_byName.has(ex.hay)) _byName.set(ex.hay, ex);
          for (const t of new Set(ex.tok)) _df.set(t, (_df.get(t) || 0) + 1);
        }
        _cat = cat;
      } catch (_) {
        // Le dossier est hors git : une install fraîche n'a pas encore lancé
        // `npm run fetch:exercises`. L'app doit rester utilisable sans images.
        _failed = true;
      } finally {
        _loading = null;
      }
      return _cat;
    })();

    return _loading;
  }

  const ready   = () => !!_cat;
  const missing = () => _failed;
  const all     = () => _cat?.exercises || [];
  const count   = () => _cat?.exercises.length || 0;
  const get     = id => _byId.get(String(id)) || null;
  const attribution = () => _cat?.attribution || '';

  const bodyParts = () => _cat?.bodyParts || [];
  const equipment = () => _cat?.equipment || [];

  /** Étiquettes lisibles d'un exercice, pour les puces de la fiche. */
  function labels(ex) {
    if (!ex || !_cat) return {};
    return {
      bodyPart:  _cat.bodyParts[ex.b] || '',
      equipment: _cat.equipment[ex.e] || '',
      target:    _cat.targets[ex.t] || '',
      secondary: (ex.s || []).map(i => _cat.muscles[i]).filter(Boolean),
    };
  }

  /** Chemins des deux médias — la vignette s'affiche pendant que le GIF charge. */
  function media(ex) {
    if (!ex || !_cat) return null;
    return {
      thumb: `${_cat.media.thumb}${ex.f}.jpg`,
      gif:   `${_cat.media.gif}${ex.f}.gif`,
    };
  }

  /* ── Recherche ────────────────────────────────────────────────────── */

  /**
   * Poids d'un mot selon sa rareté dans le catalogue. « skater » n'apparaît
   * qu'une fois et identifie donc un exercice à lui seul ; « jump » revient
   * partout et ne dit presque rien. Sans ça, « skater jumps » se résout en
   * « jump rope » plutôt qu'en « skater hops ».
   */
  function _idf(variants) {
    // La fréquence d'un mot est celle de sa graphie la PLUS répandue : sinon
    // « squats » passerait pour rare parce que le catalogue écrit « squat »,
    // et « split squats » sortirait avant « squat jerk » sur la requête
    // « squat ».
    const df = Math.max(...variants.map(v => _df.get(v) || 0));
    const n = _cat.exercises.length;
    return 0.5 + Math.log(n / (1 + df)) / Math.log(n);
  }

  /**
   * Ce que vaut un mot de recherche sur un exercice donné.
   *   raw  force brute du rapprochement, seuil de « vrai mot du nom » à 3
   *   val  la même, pondérée par la rareté — c'est elle qui classe
   */
  const NO_HIT = { raw: 0, val: 0 };

  function _tokenScore(ex, tok) {
    let best = NO_HIT;
    for (const v of tok.vars) {
      let raw = 0;
      if (ex.hay === v) raw = 10;
      else if (ex.hay.startsWith(v)) raw = 6;
      else if (ex.hay.includes(` ${v}`)) raw = 4;
      else if (ex.hay.includes(v)) raw = 3;
      // Le matériel et les muscles comptent, mais moins que le nom : chercher
      // « dumbbell » doit remonter les exercices qui le portent dans leur nom
      // avant ceux qui l'ont seulement en équipement.
      // « pushup » et « situp » s'écrivent aussi bien collés : la forme sans
      // espaces rattrape ces graphies, mais sans le crédit d'un vrai mot.
      else if (v.length > 4 && ex.flat.includes(v)) raw = 3;
      else if (ex.meta.includes(v)) raw = 1;
      else continue;

      if (raw > best.raw) best = { raw, val: raw * tok.idf };
    }
    return best;
  }

  /**
   * Ce que vaut un exercice pour une requête entière.
   *
   *   hits     mots de la requête retrouvés dans le NOM (pas juste le matériel)
   *   score    somme des scores par mot
   *   covered  mots du nom atteints par la requête
   *
   * `covered` est ce qui sépare « plank » de « power point plank » pour la
   * requête « plank hold » : les deux ne retrouvent qu'un mot, mais le premier
   * n'a rien d'autre dans son nom, donc c'est lui qu'on cherchait.
   */
  function _rank(ex, tokens) {
    let score = 0, hits = 0;
    for (const tok of tokens) {
      const { raw, val } = _tokenScore(ex, tok);
      score += val;
      if (raw >= 3) hits++;
    }

    let covered = 0;
    for (const t of ex.tok) {
      if (tokens.some(tk => tk.vars.some(v => t.startsWith(v) || v.startsWith(t)))) covered++;
    }

    return { score, hits, weight: score + (covered / ex.tok.length) * 8 };
  }

  // Le nombre de mots retrouvés prime sur leur score cumulé : un exercice qui
  // répond aux quatre mots de « push ups wide grip » passe devant un « wide
  // grip pull-up » qui n'en couvre que trois, même très fort.
  const _better = (a, b) =>
    b.hits - a.hits ||
    b.weight - a.weight ||
    a.ex.hay.length - b.ex.hay.length ||
    (a.ex.n < b.ex.n ? -1 : 1);

  /**
   * Recherche du sélecteur : tous les mots doivent porter (un ET), triée par
   * pertinence puis par nom le plus court — « squat » avant « band squat row ».
   */
  function search(query, opts = {}) {
    if (!_cat) return [];
    const { bodyPart = -1, equipment: equip = -1, limit = 0 } = opts;
    const tokens = _tokenize(query);

    const hits = [];
    for (const ex of _cat.exercises) {
      if (bodyPart >= 0 && ex.b !== bodyPart) continue;
      if (equip >= 0 && ex.e !== equip) continue;

      if (!tokens.length) { hits.push({ ex, hits: 0, weight: 0 }); continue; }

      let ok = true;
      for (const tok of tokens) {
        if (!_tokenScore(ex, tok).raw) { ok = false; break; }
      }
      if (ok) hits.push({ ex, ..._rank(ex, tokens) });
    }

    if (tokens.length) hits.sort(_better);

    const out = hits.map(h => h.ex);
    return limit > 0 ? out.slice(0, limit) : out;
  }

  /**
   * Retrouve l'exercice derrière un nom libre — une série sauvegardée avant
   * l'arrivée du catalogue, ou un lien ?w= écrit à la main.
   *
   * Contrairement à search(), aucun mot n'est obligatoire : « Plank Hold »
   * doit trouver « plank ». Mais il faut qu'au moins la moitié des mots
   * portent vraiment sur le NOM, sinon « Reverse Snow Angels » attraperait
   * n'importe quel exercice commençant par « reverse ». Mieux vaut pas
   * d'image qu'une image fausse.
   */
  function resolve(...names) {
    if (!_cat) return null;

    for (const raw of names) {
      if (!raw) continue;
      if (_resolved.has(raw)) {
        const hit = _resolved.get(raw);
        if (hit) return hit;
        continue;
      }

      const found = _resolveOne(raw);
      _resolved.set(raw, found);
      if (found) return found;
    }
    return null;
  }

  function _resolveOne(raw) {
    // Un exercice choisi dans le sélecteur porte son id : chemin direct.
    const byId = _byId.get(String(raw).trim());
    if (byId) return byId;

    const key = norm(raw);
    if (!key) return null;

    const exact = _byName.get(key);
    if (exact) return exact;

    const tokens = _tokenize(key);
    if (!tokens.length) return null;

    let best = null;
    for (const ex of _cat.exercises) {
      const cand = { ex, ..._rank(ex, tokens) };
      if (!cand.hits) continue;           // un vrai mot du nom, pas juste le matériel
      if (!best || _better(cand, best) < 0) best = cand;
    }

    if (!best) return null;
    return best.hits / tokens.length >= 0.5 ? best.ex : null;
  }

  /* ── Instructions ─────────────────────────────────────────────────── */

  /** Les deux langues font 1,3 Mo : chargées à l'ouverture d'une fiche, pas au boot. */
  async function steps(id, lang) {
    const l = (lang === 'fr' || lang === 'en') ? lang : 'en';
    if (!_steps[l]) {
      if (!_stepsLoading[l]) {
        _stepsLoading[l] = (async () => {
          try {
            const res = await fetch(`${BASE}instructions-${l}.json`);
            _steps[l] = res.ok ? await res.json() : {};
          } catch (_) { _steps[l] = {}; }
          finally { delete _stepsLoading[l]; }
        })();
      }
      await _stepsLoading[l];
    }
    return _steps[l]?.[String(id)] || [];
  }

  return {
    load, ready, missing, all, count, get, media, labels, attribution,
    bodyParts, equipment, search, resolve, steps, norm,
  };
})();

/* ═══════════════════════════════════════
   EXERCISE PREVIEW (popup during REST)
   ═══════════════════════════════════════ */
class ExercisePreview {
  constructor() {
    this._el   = document.getElementById('exPreview');
    this._img  = document.getElementById('previewImg');
    this._bar  = document.getElementById('previewBar');
    this._name = document.getElementById('previewName');
    this._note = document.getElementById('previewNote');
    this._rafId   = null;
    this._timerId = null;
    this._start   = null;
    this._dur     = 10_000;
    this.enabled  = true;
    this._seq     = 0;      // un repos peut en chasser un autre avant l'arrivée du GIF
    this._initSwipe();
  }

  async show(exercise, durationMs = 10_000) {
    if (!this.enabled || !exercise?.name) return;

    const seq = ++this._seq;
    await ExerciseDB.load();
    if (seq !== this._seq) return;

    const ex = ExerciseDB.resolve(exercise.id, exercise.alias, exercise.name);
    if (!ex) return;
    const m = ExerciseDB.media(ex);

    // La vignette (8 ko) s'affiche immédiatement, le GIF (90 ko) la remplace
    // dès qu'il est décodé : un repos dure dix secondes, la carte ne peut pas
    // rester vide pendant que le réseau travaille.
    this._img.src = m.thumb;
    const gif = new Image();
    gif.onload = () => { if (seq === this._seq) this._img.src = m.gif; };
    gif.src = m.gif;

    this._dur = durationMs;
    this._name.textContent = exercise.name;
    this._note.textContent = exercise.note || '';
    this._el.style.transform = '';
    this._el.style.opacity   = '';
    this._el.style.transition = '';
    this._el.classList.remove('hiding');
    this._el.style.display = '';

    cancelAnimationFrame(this._rafId);
    clearTimeout(this._timerId);
    this._start = Date.now();
    this._bar.style.width = '0%';
    this._animate();
    this._timerId = setTimeout(() => this.hide(), durationMs);
  }

  hide() {
    this._seq++;                  // un GIF encore en vol ne doit plus rien remplacer
    clearTimeout(this._timerId);
    cancelAnimationFrame(this._rafId);
    if (!this._el || this._el.style.display === 'none') return;
    this._el.style.transform  = '';
    this._el.style.opacity    = '';
    this._el.style.transition = '';
    this._el.classList.add('hiding');
    setTimeout(() => {
      this._el.style.display = 'none';
      this._el.classList.remove('hiding');
      this._bar.style.width = '0%';
    }, 270);
  }

  _swipeAway() {
    this._seq++;                  // un GIF encore en vol ne doit plus rien remplacer
    clearTimeout(this._timerId);
    cancelAnimationFrame(this._rafId);
    if (!this._el) return;
    this._el.style.transition = 'transform 0.28s ease, opacity 0.28s ease';
    this._el.style.transform  = 'translateX(160px)';
    this._el.style.opacity    = '0';
    setTimeout(() => {
      this._el.style.display    = 'none';
      this._el.style.transform  = '';
      this._el.style.opacity    = '';
      this._el.style.transition = '';
      this._bar.style.width     = '0%';
    }, 300);
  }

  _animate() {
    const pct = Math.min(100, (Date.now() - this._start) / this._dur * 100);
    this._bar.style.width = `${pct}%`;
    if (pct < 100) this._rafId = requestAnimationFrame(() => this._animate());
  }

  _initSwipe() {
    let startX = null;
    const THRESHOLD = 60;

    const onMove = (x) => {
      const dx = x - startX;
      if (dx > 0) {
        this._el.style.transform = `translateX(${Math.min(dx, 220)}px)`;
        this._el.style.opacity   = `${Math.max(0.2, 1 - dx / 200)}`;
      }
    };

    const onEnd = (x) => {
      const dx = x - startX;
      startX = null;
      this._el.style.cursor = '';
      if (dx > THRESHOLD) {
        this._swipeAway();
      } else {
        this._el.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
        this._el.style.transform  = '';
        this._el.style.opacity    = '';
        setTimeout(() => { this._el.style.transition = ''; }, 260);
      }
    };

    this._el.addEventListener('pointerdown', e => {
      startX = e.clientX;
      this._el.style.transition = 'none';
      this._el.style.cursor = 'grabbing';
    });

    document.addEventListener('pointermove', e => {
      if (startX !== null) onMove(e.clientX);
    }, { passive: true });

    document.addEventListener('pointerup', e => {
      if (startX === null) return;
      this._el.style.cursor = '';
      onEnd(e.clientX);
    });

    document.addEventListener('pointercancel', () => {
      if (startX === null) return;
      startX = null;
      this._el.style.transform  = '';
      this._el.style.opacity    = '';
      this._el.style.transition = '';
      this._el.style.cursor     = '';
    });
  }
}

/* ═══════════════════════════════════════
   SERIES MANAGER — localStorage
   ═══════════════════════════════════════ */
class SeriesManager {
  constructor() {
    this._KEY = 'tabata_series_v1';
    this._ready = null;
  }

  async all() {
    await this._init();
    return JSON.parse(localStorage.getItem(this._KEY) || '[]');
  }

  async save(series) {
    const all = await this.all();
    const filename = this._slug(series.name) + '.json';
    const idx = all.findIndex(s => s._filename === filename);
    const entry = { ...series, _filename: filename };
    if (idx >= 0) all[idx] = entry; else all.push(entry);
    localStorage.setItem(this._KEY, JSON.stringify(all));
    return { success: true, filename };
  }

  async delete(filename) {
    const all = await this.all();
    localStorage.setItem(this._KEY, JSON.stringify(all.filter(s => s._filename !== filename)));
    return { success: true };
  }

  // Seed localStorage from bundled exercises on first launch
  _init() {
    if (this._ready) return this._ready;
    this._ready = (async () => {
      if (localStorage.getItem(this._KEY) !== null) return;
      try {
        const res = await fetch('exercises/index.json');
        const filenames = await res.json();
        const series = [];
        for (const fn of filenames) {
          try {
            const r = await fetch(`exercises/${fn}`);
            const data = await r.json();
            series.push({ ...this._validate(data), _filename: fn });
          } catch (_) {}
        }
        localStorage.setItem(this._KEY, JSON.stringify(series));
      } catch (_) {
        localStorage.setItem(this._KEY, '[]');
      }
    })();
    return this._ready;
  }

  _validate(data) {
    return {
      name: String(data.name || 'Série'),
      rounds: Math.max(1, parseInt(data.rounds) || 8),
      round_rest: Math.max(0, parseInt(data.round_rest) || 60),
      exercises: (data.exercises || []).map(ex => ({
        name: String(ex.name || 'Exercice'),
        ...(Number(ex.reps) > 0
          ? { reps: Math.min(999, Math.max(1, parseInt(ex.reps))) }
          : { work: Math.min(999, Math.max(1, parseInt(ex.work) || 20)) }),
        rest: Math.max(0, parseInt(ex.rest) || 0),
        ...(ex.id ? { id: String(ex.id) } : {}),
        ...(ex.alias ? { alias: String(ex.alias) } : {}),
        ...(String(ex.note ?? '').trim() ? { note: String(ex.note).trim() } : {}),
      })),
    };
  }

  _slug(name) {
    return name.toLowerCase()
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'serie';
  }
}

/* ═══════════════════════════════════════
   UI MANAGER
   ═══════════════════════════════════════ */
class UI {
  constructor(timer, seriesManager, audio) {
    this._timer = timer;
    this._sm = seriesManager;
    this._audio = audio;
    this._panelOpen = false;
    this._confirmOpen = false;
    this._exercises = [{ name: '', work: 20, rest: 10 }];
    this._lastPhase = 'idle';
    this._preview = new ExercisePreview();

    this._$ = id => document.getElementById(id);
    this._pickerTarget = null;
    this._pickerChoice = null;

    this._bind();
    this._renderExerciseList();
    this._updatePanel();
    // Le catalogue est utile bien avant qu'on ouvre le sélecteur : l'aperçu
    // de repos en a besoin dès le premier exercice.
    ExerciseDB.load();
  }

  _bind() {
    this._$('btnPlay').addEventListener('click', () => {
      this._audio._ctx_get();
      this._timer.toggle();
    });
    this._$('btnReset').addEventListener('click', () => {
      const p = this._timer.phase;
      if (p === 'idle') return;
      const wasRunning = this._timer.isRunning;
      if (wasRunning) this._timer.pause();
      this._confirm(
        'Recommencer depuis le début ?',
        () => this._timer.reset(),
        { okLabel: 'Recommencer', onCancel: () => { if (wasRunning) this._timer.start(); } }
      );
    });
    this._$('btnSkip').addEventListener('click', () => this._timer.skip());
    this._$('btnRepDone').addEventListener('click', () => this._timer.finishReps());

    this._$('panelToggle').addEventListener('click', () => this._togglePanel());
    this._$('closePanel').addEventListener('click', () => this._closePanel());

    this._$('btnHome').addEventListener('click', () => {
      this._timer.pause();
      this._closePanel();
      document.dispatchEvent(new Event('showWelcome'));
    });

    this._$('soundBtn').addEventListener('click', () => {
      this._audio.enabled = !this._audio.enabled;
      this._$('icoSoundOn').style.display = this._audio.enabled ? '' : 'none';
      this._$('icoSoundOff').style.display = this._audio.enabled ? 'none' : '';
    });

    this._$('themeBtn').addEventListener('click', () => this._toggleTheme());
    this._initTheme();

    this._$('seriesName').addEventListener('input', () => this._updatePanel());
    this._$('seriesRounds').addEventListener('change', () => this._updatePanel());
    this._$('seriesRoundRest').addEventListener('change', () => this._updatePanel());

    document.querySelectorAll('.num-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.field;
        const dir = parseInt(btn.dataset.dir, 10);
        const inputId = field === 'rounds' ? 'seriesRounds' : 'seriesRoundRest';
        const input = this._$(inputId);
        input.value = Math.max(parseInt(input.min || 0), Math.min(parseInt(input.max || 9999), parseInt(input.value || 0) + dir));
        this._updatePanel();
      });
    });

    this._$('togglePreview').addEventListener('click', () => {
      this._preview.enabled = !this._preview.enabled;
      this._$('togglePreview').dataset.on = this._preview.enabled;
      if (!this._preview.enabled) this._preview.hide();
    });

    this._$('btnAddExercise').addEventListener('click', () => {
      this._exercises.push({ name: '', work: 20, rest: 10 });
      this._renderExerciseList();
    });

    this._$('btnSave').addEventListener('click', async () => {
      const series = this._buildSeries();
      if (!series.name.trim()) { this._toast('Donnez un nom à la série', 'error'); return; }
      try {
        await this._sm.save(series);
        this._toast('Série sauvegardée !', 'success');
      } catch (err) {
        this._toast(err.message, 'error');
      }
    });

    this._$('btnLoadSeries').addEventListener('click', () => this._openSavedModal());
    this._$('closeSavedModal').addEventListener('click', () => this._$('savedModal').style.display = 'none');
    this._$('savedModal').addEventListener('click', e => { if (e.target === this._$('savedModal')) this._$('savedModal').style.display = 'none'; });

    /* ── Sélecteur d'exercices ── */
    this._$('closePicker').addEventListener('click', () => this._closePicker());
    this._$('pickerModal').addEventListener('click', e => {
      if (e.target === this._$('pickerModal')) this._closePicker();
    });
    this._$('pickerBack').addEventListener('click', () => this._showPickerList());
    this._$('pickerChoose').addEventListener('click', () => this._choosePickerExercise());

    // La recherche balaie 1324 entrées en moins d'une milliseconde ; c'est le
    // rendu de la grille qu'on espace, pas le filtrage.
    let pickerDebounce = null;
    this._$('pickerQuery').addEventListener('input', () => {
      clearTimeout(pickerDebounce);
      pickerDebounce = setTimeout(() => {
        this._pickerShown = UI.PICKER_PAGE;
        this._renderPicker();
      }, 110);
    });
    this._$('pickerQuery').addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const first = this._$('pickerGrid').querySelector('.picker-card');
      if (first) this._openPickerDetail(first.dataset.id);
    });

    for (const id of ['pickerBody', 'pickerEquip']) {
      this._$(id).addEventListener('change', () => {
        this._pickerShown = UI.PICKER_PAGE;
        this._renderPicker();
      });
    }
    this._$('pickerReset').addEventListener('click', () => {
      this._$('pickerQuery').value = '';
      this._$('pickerBody').value = '-1';
      this._$('pickerEquip').value = '-1';
      this._pickerShown = UI.PICKER_PAGE;
      this._renderPicker();
    });

    this._$('btnHistory').addEventListener('click', () => this._openHistoryModal());
    this._$('closeHistoryModal').addEventListener('click', () => this._$('historyModal').style.display = 'none');
    this._$('historyModal').addEventListener('click', e => { if (e.target === this._$('historyModal')) this._$('historyModal').style.display = 'none'; });

    this._$('importFile').addEventListener('change', e => this._handleImport(e));

    this._$('btnExport').addEventListener('click', () => {
      const menu = this._$('exportMenu');
      menu.style.display = menu.style.display === 'none' ? '' : 'none';
    });

    document.querySelectorAll('#exportMenu button').forEach(btn => {
      btn.addEventListener('click', () => {
        this._$('exportMenu').style.display = 'none';
        this._handleExport(btn.dataset.fmt);
      });
    });

    document.addEventListener('click', e => {
      if (!e.target.closest('.export-wrap')) this._$('exportMenu').style.display = 'none';
    });

    this._$('closeLinkModal').addEventListener('click', () => this._$('linkModal').style.display = 'none');
    this._$('linkModal').addEventListener('click', e => { if (e.target === this._$('linkModal')) this._$('linkModal').style.display = 'none'; });
    this._$('linkCopyBtn').addEventListener('click', () => this._copyLink());
    this._$('linkShareBtn').addEventListener('click', () => {
      const url = this._$('linkUrl').value;
      navigator.share?.({ title: this._$('seriesName').value || 'Tabata', url }).catch(() => {});
    });

    this._$('btnRestart').addEventListener('click', () => {
      this._$('completionScreen').style.display = 'none';
      this._timer.reset();
    });

    this._$('btnCompletionMenu').addEventListener('click', () => {
      this._$('completionScreen').style.display = 'none';
      this._timer.reset();
      document.dispatchEvent(new CustomEvent('showWelcome'));
    });

    document.addEventListener('timerUpdate', e => this._onUpdate(e.detail));
  }

  _onUpdate(state) {
    const { phase, round, totalRounds, exIdx, totalEx, exercise, nextExercise, timeRem, timeTotal, progress, isRunning, series } = state;

    const isRepPhase = !!state.isRepPhase;
    const phaseClass = 'phase-' + (phase === 'round_rest' ? 'round-rest' : phase);
    document.body.className = phaseClass + (isRepPhase ? ' mode-reps' : '');

    if (phase !== this._lastPhase) {
      this._lastPhase = phase;
      if (phase === 'complete') {
        this._preview.hide();
        this._showCompletion(series);
        return;
      }
      if (phase === 'idle') {
        this._preview.hide();
        this._$('completionScreen').style.display = 'none';
      } else if (phase === 'ready' && exercise) {
        this._preview.show(exercise, timeTotal * 1000 + 5000);
      } else if (phase === 'rest' && nextExercise) {
        this._preview.show(nextExercise, timeTotal * 1000 + 5000);
      }
    }

    const CIRC = 879.6;
    const fillPct = phase === 'idle' ? 0 : progress;
    const dash = fillPct * CIRC;
    this._$('ringFill').setAttribute('stroke-dasharray', `${dash.toFixed(1)} ${CIRC}`);

    // A rep phase counts up, so floor the elapsed seconds — ceiling them would
    // show "1" the instant the exercise starts.
    const secs = isRepPhase ? Math.floor(timeRem) : Math.ceil(timeRem);
    this._$('timerDigits').textContent = phase === 'idle' ? '—' : (phase === 'complete' ? 'FIN' : this._fmt(secs));

    const labels = { idle: 'PRÊT ?', ready: 'PRÊT', work: 'WORK', rest: 'REPOS', round_rest: 'REPOS ROUND', complete: 'TERMINÉ' };
    this._$('phaseLabel').textContent = isRepPhase
      ? `${exercise.reps} ${i18n.t('panel.reps', 'REPS')}`
      : (labels[phase] || '');

    this._$('btnRepDone').style.display = isRepPhase ? '' : 'none';

    this._$('roundDisplay').textContent = totalRounds ? `${round}/${totalRounds}` : '—';
    this._$('exerciseDisplay').textContent = totalEx ? `${exIdx + 1}/${totalEx}` : '—';

    // La note n'accompagne que l'exercice en cours ; toute autre phase la vide.
    this._$('exerciseNote').textContent =
      (phase === 'work' && exercise) ? (exercise.note || '') : '';

    if (phase === 'work' && exercise) {
      this._$('exerciseName').textContent = exercise.name || 'Exercice';
      this._$('exerciseSub').textContent = nextExercise ? `Prochain : ${nextExercise.name}` : 'Dernier exercice du set';
    } else if (phase === 'rest' && exercise) {
      this._$('exerciseName').textContent = 'REPOS';
      this._$('exerciseSub').textContent = nextExercise ? `→ ${nextExercise.name}` : `→ Fin du round ${round}`;
    } else if (phase === 'round_rest') {
      this._$('exerciseName').textContent = `REPOS ROUND ${round - 1}`;
      this._$('exerciseSub').textContent = `Round ${round} dans…`;
    } else if (phase === 'ready') {
      this._$('exerciseName').textContent = series?.name || '';
      this._$('exerciseSub').textContent = 'Prépare-toi !';
    } else if (phase === 'idle') {
      if (series) {
        this._$('exerciseName').textContent = series.name;
        this._$('exerciseSub').textContent = exercise ? `→ ${exercise.name}` : '';
      } else {
        this._$('exerciseName').textContent = 'Chargez une série';
        this._$('exerciseSub').textContent = '→ Utilisez le panneau de droite';
      }
    }

    this._renderDots(exIdx, totalEx, phase);

    const { sessionRemaining, roundRemaining, sessionTotal, roundTotal } = state;
    const active = phase !== 'idle';
    const strip = this._$('sessionStrip');
    if (strip) strip.classList.toggle('active', active && isRunning);
    // Totals are estimates as soon as one exercise is rep-based.
    const approx = state.estimated ? '~' : '';
    this._$('sessionTime').textContent = approx + this._fmtTime(active ? sessionRemaining : sessionTotal);
    this._$('roundTime').textContent   = approx + this._fmtTime(active ? roundRemaining   : roundTotal);

    this._$('btnPlay').querySelector('.ico-play').style.display = isRunning ? 'none' : '';
    this._$('btnPlay').querySelector('.ico-pause').style.display = isRunning ? '' : 'none';
  }

  _renderDots(activeIdx, total, phase) {
    const row = this._$('dotsRow');
    if (!total) { row.innerHTML = ''; return; }
    row.innerHTML = '';
    for (let i = 0; i < total; i++) {
      const d = document.createElement('div');
      d.className = 'dot' + (i < activeIdx ? ' done' : i === activeIdx && phase !== 'idle' ? ' active' : '');
      row.appendChild(d);
    }
  }

  _fmt(secs) {
    if (secs < 0) secs = 0;
    if (secs >= 60) {
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      return `${m}:${String(s).padStart(2, '0')}`;
    }
    return String(secs);
  }

  _buildSeries() {
    return {
      name: this._$('seriesName').value.trim() || 'Ma Série',
      rounds: Math.max(1, parseInt(this._$('seriesRounds').value) || 8),
      round_rest: Math.max(0, parseInt(this._$('seriesRoundRest').value) || 60),
      exercises: this._exercises.map(ex => ({
        name: ex.name || 'Exercice',
        ...(isReps(ex) ? { reps: Math.max(1, ex.reps) } : { work: Math.max(1, ex.work) }),
        rest: Math.max(0, ex.rest),
        // Référence au catalogue : c'est elle qui garantit la bonne
        // démonstration même après un renommage.
        ...(ex.id ? { id: String(ex.id) } : {}),
        ...(ex.alias ? { alias: String(ex.alias) } : {}),
        // Le panneau n'a pas de champ pour la note : sans ce report, charger un
        // lien puis le réexporter la perdrait en silence.
        ...(String(ex.note ?? '').trim() ? { note: String(ex.note).trim() } : {}),
      })),
    };
  }

  _updatePanel() {
    if (this._timer.phase === 'idle' || this._timer.phase === 'complete') {
      const s = this._buildSeries();
      this._timer.load(s);
    }
  }

  _loadSeriesIntoPanel(series) {
    this._$('seriesName').value = series.name;
    this._$('seriesRounds').value = series.rounds;
    this._$('seriesRoundRest').value = series.round_rest;
    this._exercises = series.exercises.map(ex => ({ ...ex }));
    this._renderExerciseList();
    this._timer.load(series);
  }

  _renderExerciseList() {
    const list = this._$('exerciseList');
    list.innerHTML = '';
    this._exercises.forEach((ex, i) => {
      const item = document.createElement('div');
      item.className = 'ex-item';
      item.innerHTML = `
        <div class="ex-num">${i + 1}</div>
        <div class="ex-fields">
          <div class="ex-name-row">
            <input type="text" class="ex-name-input" placeholder="${this._esc(i18n.t('panel.ex_placeholder', "Nom de l'exercice"))}" value="${this._esc(ex.name)}" autocomplete="off">
            <button type="button" class="ex-browse${ex.id ? ' linked' : ''}" data-action="browse"
                    title="${this._esc(i18n.t('picker.browse', 'Parcourir la bibliothèque'))}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </button>
          </div>
          <div class="ex-times">
            <div class="ex-time-group">
              <button type="button" class="ex-time-label work ex-mode-btn" data-action="mode"
                      data-mode="${isReps(ex) ? 'reps' : 'time'}"
                      title="${this._esc(i18n.t('panel.mode_hint', 'Basculer temps / répétitions'))}">${isReps(ex) ? i18n.t('panel.reps', 'REPS') : i18n.t('panel.work', 'WORK')}</button>
              <input type="number" class="ex-time-input" value="${isReps(ex) ? ex.reps : ex.work}" min="1" max="999">
              <span class="ex-time-unit">${isReps(ex) ? '\u00D7' : 's'}</span>
            </div>
            <div class="ex-time-group">
              <span class="ex-time-label rest">REST</span>
              <input type="number" class="ex-time-input" value="${ex.rest}" min="0" max="999">
              <span class="ex-time-unit">s</span>
            </div>
          </div>
        </div>
        <div class="ex-actions">
          <button class="ex-btn" data-action="up" title="Monter"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg></button>
          <button class="ex-btn del" data-action="del" title="Supprimer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>
          <button class="ex-btn" data-action="down" title="Descendre"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
        </div>
      `;

      const nameInput = item.querySelector('.ex-name-input');
      const [workInput, restInput] = item.querySelectorAll('.ex-time-input');

      nameInput.addEventListener('input', () => {
        const ex = this._exercises[i];
        if (ex.id && nameInput.value.trim() !== ExerciseDB.get(ex.id)?.n) {
          delete ex.id;
          item.querySelector('.ex-browse').classList.remove('linked');
        }
        ex.name = nameInput.value;
        this._updatePanel();
      });

      item.querySelector('[data-action="browse"]').addEventListener('click', () => this._openPicker(i));
      workInput.addEventListener('change', () => {
        const v = Math.min(999, Math.max(1, parseInt(workInput.value) || 20));
        if (isReps(this._exercises[i])) this._exercises[i].reps = v; else this._exercises[i].work = v;
        this._updatePanel();
      });

      // Time-based (30s) <-> rep-based (30x). The number carries over.
      item.querySelector('[data-action="mode"]').addEventListener('click', () => {
        const ex = this._exercises[i];
        if (isReps(ex)) { ex.work = ex.reps; delete ex.reps; }
        else            { ex.reps = ex.work; delete ex.work; }
        this._renderExerciseList();
      });
      restInput.addEventListener('change', () => { this._exercises[i].rest = Math.max(0, parseInt(restInput.value) || 0); this._updatePanel(); });

      item.querySelector('[data-action="up"]').addEventListener('click', () => {
        if (i === 0) return;
        [this._exercises[i - 1], this._exercises[i]] = [this._exercises[i], this._exercises[i - 1]];
        this._renderExerciseList(); this._updatePanel();
      });
      item.querySelector('[data-action="down"]').addEventListener('click', () => {
        if (i === this._exercises.length - 1) return;
        [this._exercises[i + 1], this._exercises[i]] = [this._exercises[i], this._exercises[i + 1]];
        this._renderExerciseList(); this._updatePanel();
      });
      item.querySelector('[data-action="del"]').addEventListener('click', () => {
        if (this._exercises.length === 1) { this._toast('Il faut au moins un exercice', 'error'); return; }
        this._exercises.splice(i, 1);
        this._renderExerciseList(); this._updatePanel();
      });

      list.appendChild(item);
    });
    this._updatePanel();
  }

  _togglePanel() {
    this._panelOpen = !this._panelOpen;
    const panel = this._$('seriesPanel');
    if (this._panelOpen) panel.classList.remove('hidden'); else panel.classList.add('hidden');
  }

  _closePanel() {
    this._panelOpen = false;
    this._$('seriesPanel').classList.add('hidden');
  }

  _openPanel() {
    this._panelOpen = true;
    this._$('seriesPanel').classList.remove('hidden');
  }

  /* ── SÉLECTEUR D'EXERCICES ─────────────────────────────────────────
     Une liste déroulante de 1324 entrées serait inutilisable : le catalogue
     s'explore dans une modale, par recherche et par filtres, avec la
     démonstration animée sous les yeux. Le champ texte reste libre — on peut
     toujours saisir un nom qui n'existe nulle part.
     ────────────────────────────────────────────────────────────────── */

  static PICKER_PAGE = 60;      // au-delà, le rendu de la grille se voit

  async _openPicker(index) {
    this._pickerTarget = index;
    this._pickerShown  = UI.PICKER_PAGE;
    this._$('pickerModal').style.display = 'flex';
    this._showPickerList();

    await ExerciseDB.load();
    this._fillPickerFilters();

    // Pré-remplir avec ce qui est déjà tapé : ouvrir le sélecteur depuis une
    // ligne nommée « pompes » doit montrer des pompes, pas tout le catalogue.
    const typed = (this._exercises[index]?.name || '').trim();
    const q = this._$('pickerQuery');
    q.value = this._exercises[index]?.id ? '' : typed;

    this._renderPicker();
    // Le focus déclenche le clavier logiciel : sur mobile il masquerait la
    // grille avant même qu'on l'ait vue.
    if (!matchMedia('(hover: none)').matches) q.focus();
  }

  _closePicker() {
    this._$('pickerModal').style.display = 'none';
    this._pickerTarget = null;
  }

  _showPickerList() {
    this._$('pickerBrowse').style.display = 'flex';
    this._$('pickerDetail').style.display = 'none';
  }

  /** Les listes de filtres viennent des facettes du catalogue, déjà triées. */
  _fillPickerFilters() {
    if (this._pickerFiltersReady || !ExerciseDB.ready()) return;
    this._pickerFiltersReady = true;

    const fill = (id, allLabel, values) => {
      const sel = this._$(id);
      sel.innerHTML = `<option value="-1">${this._esc(allLabel)}</option>` +
        values.map((v, i) => `<option value="${i}">${this._esc(v)}</option>`).join('');
    };
    fill('pickerBody',  i18n.t('picker.body_all',  'Toutes les zones'), ExerciseDB.bodyParts());
    fill('pickerEquip', i18n.t('picker.equip_all', 'Tout le matériel'), ExerciseDB.equipment());

    const credit = ExerciseDB.attribution();
    if (credit) this._$('pickerCredit').textContent = credit;
  }

  _renderPicker() {
    const grid  = this._$('pickerGrid');
    const count = this._$('pickerCount');

    if (!ExerciseDB.ready()) {
      count.textContent = '';
      // Le dossier est hors dépôt : dire quoi lancer plutôt que rester vide.
      grid.innerHTML = `<p class="empty-msg">${this._esc(i18n.t('picker.missing',
        'Bibliothèque absente — lancer « npm run fetch:exercises »'))}</p>`;
      return;
    }

    const results = ExerciseDB.search(this._$('pickerQuery').value, {
      bodyPart:  parseInt(this._$('pickerBody').value, 10),
      equipment: parseInt(this._$('pickerEquip').value, 10),
    });

    count.textContent = i18n.t('picker.results', '{n} exercices').replace('{n}', results.length);

    if (!results.length) {
      grid.innerHTML = `<p class="empty-msg">${this._esc(i18n.t('picker.empty', 'Aucun exercice trouvé.'))}</p>`;
      return;
    }

    const page = results.slice(0, this._pickerShown);
    grid.innerHTML = page.map(ex => {
      const m = ExerciseDB.media(ex);
      const l = ExerciseDB.labels(ex);
      return `<button class="picker-card" data-id="${this._esc(ex.i)}">
        <img class="picker-card-img" src="${this._esc(m.thumb)}" alt="" loading="lazy" decoding="async">
        <div class="picker-card-name">${this._esc(ex.n)}</div>
        <div class="picker-card-meta">${this._esc(l.equipment)}</div>
      </button>`;
    }).join('');

    if (results.length > page.length) {
      const more = document.createElement('button');
      more.className = 'picker-more';
      more.textContent = i18n.t('picker.more', 'Voir plus')
        .replace('{n}', results.length - page.length);
      more.addEventListener('click', () => {
        this._pickerShown += UI.PICKER_PAGE;
        this._renderPicker();
      });
      grid.appendChild(more);
    }

    grid.querySelectorAll('.picker-card').forEach(card => {
      card.addEventListener('click', () => this._openPickerDetail(card.dataset.id));
    });
  }

  async _openPickerDetail(id) {
    const ex = ExerciseDB.get(id);
    if (!ex) return;

    this._pickerChoice = ex;
    this._$('pickerBrowse').style.display = 'none';
    this._$('pickerDetail').style.display = 'flex';
    this._$('pickerDetail').querySelector('.picker-detail-scroll').scrollTop = 0;

    const m = ExerciseDB.media(ex);
    const l = ExerciseDB.labels(ex);
    this._$('pickerDetailImg').src = m.gif;     // la fiche montre le mouvement
    this._$('pickerDetailName').textContent = ex.n;

    const chips = [
      ...(l.target ? [`<span class="picker-chip target">${this._esc(l.target)}</span>`] : []),
      ...(l.bodyPart ? [`<span class="picker-chip">${this._esc(l.bodyPart)}</span>`] : []),
      ...(l.equipment ? [`<span class="picker-chip">${this._esc(l.equipment)}</span>`] : []),
      ...l.secondary.map(m2 => `<span class="picker-chip">${this._esc(m2)}</span>`),
    ];
    this._$('pickerDetailChips').innerHTML = chips.join('');

    const box = this._$('pickerDetailSteps');
    box.innerHTML = '';
    const steps = await ExerciseDB.steps(ex.i, i18n.lang());
    // La fiche a pu changer pendant le chargement des instructions.
    if (this._pickerChoice !== ex) return;
    box.innerHTML = steps.length
      ? `<ol class="picker-steps">${steps.map(t => `<li>${this._esc(t)}</li>`).join('')}</ol>`
      : `<p class="empty-msg">${this._esc(i18n.t('picker.no_steps', 'Pas d\'instructions pour cet exercice.'))}</p>`;
  }

  /**
   * L'exercice retenu garde son id : renommer « barbell full squat » en
   * « Squat barre » ne doit pas faire perdre sa démonstration.
   */
  _choosePickerExercise() {
    const ex = this._pickerChoice;
    const i  = this._pickerTarget;
    if (!ex || i == null || !this._exercises[i]) return;

    this._exercises[i].name = ex.n;
    this._exercises[i].id   = ex.i;
    delete this._exercises[i].alias;      // l'id le remplace avantageusement

    this._closePicker();
    this._renderExerciseList();
    this._updatePanel();
  }

  async _openSavedModal() {
    const container = this._$('savedList');
    container.innerHTML = '<p class="empty-msg">Chargement…</p>';
    this._$('savedModal').style.display = 'flex';

    let list = [];
    try {
      list = await this._sm.all();
    } catch (err) {
      container.innerHTML = `<p class="empty-msg" style="color:var(--c-work)">${err.message}</p>`;
      return;
    }

    container.innerHTML = '';
    if (!list.length) {
      container.innerHTML = '<p class="empty-msg">Aucune série sauvegardée.</p>';
      return;
    }

    list.forEach(series => {
      const item = document.createElement('div');
      item.className = 'saved-item';
      item.innerHTML = `
        <div>
          <div class="saved-item-name">${this._esc(series.name)}</div>
          <div class="saved-item-meta">${series.rounds} rounds · ${series.exercises.length} exercices · ${series.round_rest}s repos</div>
        </div>
        <button class="saved-item-del" title="Supprimer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>
      `;
      item.addEventListener('click', e => {
        if (e.target.closest('.saved-item-del')) return;
        const { _filename, ...clean } = series;
        this._loadSeriesIntoPanel(clean);
        this._$('savedModal').style.display = 'none';
        this._toast(`"${series.name}" chargée`);
      });
      item.querySelector('.saved-item-del').addEventListener('click', async () => {
        try {
          await this._sm.delete(series._filename);
          this._openSavedModal();
        } catch (err) {
          this._toast(err.message, 'error');
        }
      });
      container.appendChild(item);
    });
  }

  async _handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';

    try {
      const text = await file.text();
      let series;

      if (file.name.toLowerCase().endsWith('.json')) {
        const data = JSON.parse(text);
        if (!data || typeof data !== 'object' || !Array.isArray(data.exercises))
          throw new Error('Format JSON invalide');
        series = this._sm._validate(data);

      } else if (file.name.toLowerCase().endsWith('.csv')) {
        series = this._parseCSV(text);

      } else {
        throw new Error('Format non supporté. Utilisez .json ou .csv');
      }

      this._loadSeriesIntoPanel(series);
      this._toast(`"${series.name}" importée !`, 'success');
    } catch (err) {
      this._toast(err.message || 'Erreur import', 'error');
    }
  }

  _parseCSV(text) {
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
    if (lines.length < 2) throw new Error('Fichier CSV vide');

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const getCol = (row, keys) => {
      for (const k of keys) {
        const idx = headers.indexOf(k);
        if (idx >= 0 && row[idx]?.trim()) return row[idx].trim();
      }
      return '';
    };

    const rows = lines.slice(1).map(l => l.split(','));
    const first = rows[0];
    const name       = getCol(first, ['series_name', 'nom_serie', 'name', 'nom']) || 'Série importée';
    const rounds     = parseInt(getCol(first, ['rounds', 'tours']) || '8');
    const round_rest = parseInt(getCol(first, ['round_rest', 'repos_tour', 'roundrest']) || '60');

    const exercises = [];
    for (const row of rows) {
      const exName = getCol(row, ['exercise', 'exercice', 'name', 'nom']);
      if (!exName) continue;
      const reps = parseInt(getCol(row, ['reps', 'repetitions', 'répétitions']) || '0');
      exercises.push({
        name: exName,
        ...(reps > 0
          ? { reps: Math.min(999, reps) }
          : { work: Math.max(1, parseInt(getCol(row, ['work', 'travail']) || '20')) }),
        rest: Math.max(0, parseInt(getCol(row, ['rest', 'repos']) || '10')),
      });
    }
    return { name, rounds: Math.max(1, rounds), round_rest: Math.max(0, round_rest), exercises };
  }

  _handleExport(fmt) {
    const series = this._buildSeries();

    if (fmt === 'link') { this._shareLink(series); return; }

    try {
      const safeName = series.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'tabata_series';
      let content, mime, filename;

      if (fmt === 'json') {
        content = JSON.stringify(series, null, 2);
        mime = 'application/json';
        filename = `${safeName}.json`;
      } else if (fmt === 'csv') {
        const rows = [['series_name', 'rounds', 'round_rest', 'exercise', 'work', 'reps', 'rest']];
        series.exercises.forEach((ex, i) => {
          rows.push([
            i === 0 ? series.name   : '',
            i === 0 ? series.rounds : '',
            i === 0 ? series.round_rest : '',
            ex.name,
            isReps(ex) ? '' : ex.work,
            isReps(ex) ? ex.reps : '',
            ex.rest,
          ]);
        });
        content = rows.map(r => r.join(',')).join('\n');
        mime = 'text/csv';
        filename = `${safeName}.csv`;
      } else {
        return;
      }

      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.download = filename;
      a.href = url;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      this._toast('Série exportée !', 'success');
    } catch (err) {
      this._toast(err.message || 'Erreur export', 'error');
    }
  }

  /** Build the shareable URL for a series and offer copy / native share. */
  _shareLink(series) {
    const url = WorkoutLink.build(series);
    const input = this._$('linkUrl');
    input.value = url;

    const shareBtn = this._$('linkShareBtn');
    shareBtn.style.display = navigator.share ? '' : 'none';

    this._$('linkModal').style.display = 'flex';
    // Defer so the modal is laid out before we select the text.
    requestAnimationFrame(() => { input.focus(); input.select(); });
  }

  _copyLink() {
    const input = this._$('linkUrl');
    input.select();
    input.setSelectionRange(0, input.value.length);   // iOS needs the explicit range

    const done = () => this._toast(i18n.t('toast.link_copied', 'Lien copié !'), 'success');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(input.value).then(done, () => {
        this._toast(i18n.t('toast.link_manual', 'Copiez le lien à la main'), 'error');
      });
    } else {
      this._toast(i18n.t('toast.link_manual', 'Copiez le lien à la main'), 'error');
    }
  }

  _showCompletion(series) {
    this._$('completionSeriesName').textContent = series?.name || '';
    this._$('completionStats').textContent = `${series?.rounds || ''} rounds · ${series?.exercises?.length || ''} exercices`;
    this._$('completionScreen').style.display = 'flex';
    document.body.className = 'phase-complete';
    if (series) this._saveHistory(series);
  }

  _saveHistory(series) {
    const history = JSON.parse(localStorage.getItem('tabata_history') || '[]');
    history.unshift({
      date: new Date().toISOString(),
      name: series.name,
      rounds: series.rounds,
      exercises: (series.exercises || []).map(e => e.name),
      totalWork: (series.exercises || []).reduce((s, e) => s + exDuration(e) * (series.rounds || 1), 0),
    });
    if (history.length > 50) history.length = 50;
    localStorage.setItem('tabata_history', JSON.stringify(history));
  }

  _openHistoryModal() {
    const container = this._$('historyList');
    this._$('historyModal').style.display = 'flex';
    this._renderHistory(container);
  }

  _renderHistory(container) {
    const history = JSON.parse(localStorage.getItem('tabata_history') || '[]');
    container.innerHTML = '';
    if (!history.length) {
      container.innerHTML = `<p class="empty-msg">${i18n.t('history.empty')}</p>`;
      return;
    }
    history.forEach((entry, idx) => {
      const d = new Date(entry.date);
      const dayName  = d.toLocaleDateString('fr-FR', { weekday: 'long' });
      const dateStr  = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
      const timeStr  = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      const totalWork = entry.totalWork || 0;
      const wMins = Math.floor(totalWork / 60);
      const wSecs = totalWork % 60;
      const workStr = wMins > 0 ? `${wMins}min${wSecs > 0 ? ' ' + wSecs + 's' : ''}` : `${wSecs}s`;
      const item = document.createElement('div');
      item.className = 'history-item';
      item.innerHTML = `
        <div class="history-item-index">#${history.length - idx}</div>
        <div class="history-item-body">
          <div class="history-item-name">${this._esc(entry.name)}</div>
          <div class="history-item-datetime">
            <span class="history-day">${dayName.charAt(0).toUpperCase() + dayName.slice(1)}</span>
            <span class="history-date">${dateStr}</span>
            <span class="history-time">${timeStr}</span>
          </div>
          <div class="history-item-stats">
            <span class="history-stat"><strong>${entry.rounds}</strong> ${i18n.t('history.rounds')}</span>
            <span class="history-dot">·</span>
            <span class="history-stat"><strong>${entry.exercises.length}</strong> ${i18n.t('history.exercises')}</span>
            <span class="history-dot">·</span>
            <span class="history-stat"><strong>${workStr}</strong> ${i18n.t('history.work')}</span>
          </div>
          <div class="history-item-exos">${entry.exercises.map(n => `<span class="history-exo-tag">${this._esc(n)}</span>`).join('')}</div>
        </div>
        <button class="history-delete-btn" title="${i18n.t('history.delete')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
          </svg>
        </button>
      `;
      item.querySelector('.history-delete-btn').addEventListener('click', () => {
        const h = JSON.parse(localStorage.getItem('tabata_history') || '[]');
        h.splice(idx, 1);
        localStorage.setItem('tabata_history', JSON.stringify(h));
        item.classList.add('history-item-removing');
        setTimeout(() => this._renderHistory(container), 260);
      });
      container.appendChild(item);
    });
  }

  _toast(msg, type = '') {
    const t = document.createElement('div');
    t.className = 'toast' + (type ? ' ' + type : '');
    t.textContent = msg;
    this._$('toastWrap').appendChild(t);
    setTimeout(() => t.remove(), 3100);
  }

  _fmtTime(secs) {
    const s = Math.floor(Math.max(0, secs));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  _initTheme() {
    const saved = localStorage.getItem('tabata_theme') || 'dark';
    this._applyTheme(saved);
  }

  _toggleTheme() {
    const current = document.documentElement.dataset.theme || 'dark';
    this._applyTheme(current === 'dark' ? 'light' : 'dark');
  }

  _applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('tabata_theme', theme);
    this._$('icoSun').style.display  = theme === 'dark'  ? '' : 'none';
    this._$('icoMoon').style.display = theme === 'light' ? '' : 'none';
  }

  _confirm(msg, onOk, { okLabel = 'Confirmer', onCancel = null } = {}) {
    if (this._confirmOpen) return;
    this._confirmOpen = true;

    const modal  = this._$('confirmModal');
    const ok     = this._$('confirmOk');
    const cancel = this._$('confirmCancel');

    this._$('confirmMsg').textContent = msg;
    ok.textContent = okLabel;
    modal.style.display = 'flex';

    const close = (confirmed) => {
      this._confirmOpen = false;
      modal.style.display = 'none';
      ok.removeEventListener('click', handleOk);
      cancel.removeEventListener('click', handleCancel);
      modal.removeEventListener('click', handleBackdrop);
      if (!confirmed && onCancel) onCancel();
    };
    const handleOk       = () => { close(true);  onOk(); };
    const handleCancel   = () => close(false);
    const handleBackdrop = e => { if (e.target === modal) close(false); };

    ok.addEventListener('click', handleOk);
    cancel.addEventListener('click', handleCancel);
    modal.addEventListener('click', handleBackdrop);
  }

  /** Échappe aussi les guillemets : ces chaînes finissent dans des attributs. */
  _esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

/* ═══════════════════════════════════════
   WELCOME SCREEN
   ═══════════════════════════════════════ */
class WelcomeScreen {
  constructor(sm, onSelect) {
    this._sm = sm;
    this._onSelect = onSelect;
    this._el   = document.getElementById('welcomeScreen');
    this._grid = document.getElementById('welcomeGrid');
  }

  show() {
    this._el.classList.remove('closing');
    this._el.style.display = 'flex';
    this._loadPrograms();
  }

  hide() {
    this._el.classList.add('closing');
    setTimeout(() => { this._el.style.display = 'none'; }, 420);
  }

  async _loadPrograms() {
    this._grid.innerHTML = '<p class="welcome-msg">Chargement…</p>';
    try {
      const list = await this._sm.all();
      this._grid.innerHTML = '';
      if (!list.length) {
        this._grid.innerHTML = '<p class="welcome-msg">Aucun programme disponible.</p>';
        return;
      }
      list.forEach((series, i) => {
        const card = this._makeCard(series, i);
        this._grid.appendChild(card);
      });
    } catch (err) {
      this._grid.innerHTML = `<p class="welcome-msg" style="color:var(--c-work)">${err.message}</p>`;
    }
  }

  _makeCard(series, idx) {
    const roundTotal   = series.exercises.reduce((s, ex) => s + exDuration(ex) + ex.rest, 0);
    const sessionTotal = roundTotal * series.rounds + series.round_rest * Math.max(0, series.rounds - 1);
    const m = Math.floor(sessionTotal / 60);
    const s = sessionTotal % 60;
    const duration = (seriesHasReps(series) ? '~' : '') +
      `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

    const card = document.createElement('div');
    card.className = 'welcome-card';
    card.style.animationDelay = `${0.12 + idx * 0.07}s`;
    card.innerHTML = `
      <div class="welcome-card-info">
        <div class="welcome-card-name">${this._esc(series.name)}</div>
        <div class="welcome-card-meta">
          <span>${series.rounds} rounds</span>
          <span class="meta-dot">·</span>
          <span>${series.exercises.length} exercices</span>
        </div>
        <div class="welcome-card-duration">${duration}</div>
      </div>
      <div class="welcome-card-arrow">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
        </svg>
      </div>
    `;
    card.addEventListener('click', () => {
      const { _filename, ...clean } = series;
      this._onSelect(clean);
      this.hide();
    });
    return card;
  }

  _esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

/* ═══════════════════════════════════════
   RUNNER HOME — accueil du build « lite »
   Le build lite n'embarque aucune bibliothèque de programmes : il exécute
   des séances construites ailleurs (autre app, agent) et reçues par lien
   ?w=. L'accueil explique donc le format, accepte un lien collé, et liste
   les séances que l'utilisateur a lui-même enregistrées.
   ═══════════════════════════════════════ */
class RunnerHome {
  constructor(sm, { onOpen, onCreate }) {
    this._sm = sm;
    this._onOpen = onOpen;
    this._onCreate = onCreate;
    this._el = document.getElementById('runnerHome');

    this._$('rhGo').addEventListener('click', () => this._submit());
    this._$('rhInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this._submit(); }
    });
    this._$('rhInput').addEventListener('input', () => this._error(''));
    this._$('rhCreate').addEventListener('click', () => {
      this.hide();
      this._onCreate();
    });
  }

  _$(id) { return document.getElementById(id); }

  show() {
    this._el.classList.remove('closing');
    this._el.style.display = 'flex';
    this._error('');
    this._renderSaved();
  }

  hide() {
    this._el.classList.add('closing');
    setTimeout(() => { this._el.style.display = 'none'; }, 420);
  }

  _error(msg) {
    const el = this._$('rhError');
    el.textContent = msg;
    el.style.display = msg ? '' : 'none';
  }

  /**
   * Accepte ce que l'utilisateur a sous la main : une URL complète, une
   * query string seule, ou la charge utile brute copiée sans le `?w=`.
   */
  _parse(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;

    if (text.includes('?')) {
      const found = WorkoutLink.decode(text.slice(text.indexOf('?')));
      if (found) return found;
    }
    // Collé sans le préfixe : « Nom~8~60~Pompes:30s:10 »
    return WorkoutLink.decode(`?${WorkoutLink.PARAM}=${text.replace(/ /g, '+')}`);
  }

  _submit() {
    const series = this._parse(this._$('rhInput').value);
    if (!series) {
      this._error(i18n.t('runner.invalid', 'Lien illisible — vérifie que tu as copié l\'adresse entière.'));
      return;
    }
    this._$('rhInput').value = '';
    this._error('');
    this.hide();
    this._onOpen(series);
  }

  /** Les séances enregistrées localement — absentes tant qu'on n'en a créé aucune. */
  async _renderSaved() {
    const wrap = this._$('rhSaved');
    const list = this._$('rhSavedList');
    let saved = [];
    try { saved = await this._sm.all(); } catch (_) { saved = []; }

    if (!saved.length) { wrap.style.display = 'none'; return; }

    list.innerHTML = '';
    saved.forEach(series => {
      const roundTotal   = series.exercises.reduce((a, ex) => a + exDuration(ex) + ex.rest, 0);
      const total = roundTotal * series.rounds + series.round_rest * Math.max(0, series.rounds - 1);
      const mm = String(Math.floor(total / 60)).padStart(2, '0');
      const ss = String(total % 60).padStart(2, '0');

      const row = document.createElement('button');
      row.className = 'rh-saved-row';
      row.innerHTML = `
        <span class="rh-saved-name">${this._esc(series.name)}</span>
        <span class="rh-saved-meta">${series.rounds} × ${series.exercises.length}</span>
        <span class="rh-saved-dur">${seriesHasReps(series) ? '~' : ''}${mm}:${ss}</span>
      `;
      row.addEventListener('click', () => {
        const { _filename, ...clean } = series;
        this.hide();
        this._onOpen(clean);
      });
      list.appendChild(row);
    });
    wrap.style.display = '';
  }

  _esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

/* ═══════════════════════════════════════
   LINK PREVIEW — landing screen for a shared ?w= workout
   ═══════════════════════════════════════ */
class LinkPreview {
  constructor(sm, { onStart, onEdit }) {
    this._sm = sm;
    this._onStart = onStart;
    this._onEdit = onEdit;
    this._series = null;
    this._el = document.getElementById('linkPreviewScreen');

    this._$('lpStart').addEventListener('click', () => {
      const s = this._series;
      this.hide();
      this._onStart(s);
    });
    this._$('lpEdit').addEventListener('click', () => {
      const s = this._series;
      this.hide();
      this._onEdit(s);
    });
    this._$('lpSave').addEventListener('click', () => this._save());
  }

  _$(id) { return document.getElementById(id); }

  show(series) {
    this._series = series;
    const hasReps = seriesHasReps(series);

    const roundTotal   = series.exercises.reduce((s, ex) => s + exDuration(ex) + ex.rest, 0);
    const sessionTotal = roundTotal * series.rounds + series.round_rest * Math.max(0, series.rounds - 1);

    this._$('lpName').textContent = series.name;
    this._$('lpMeta').innerHTML = [
      `<span>${series.rounds} ${i18n.t('history.rounds', 'rounds')}</span>`,
      `<span>${series.exercises.length} ${i18n.t('history.exercises', 'exercices')}</span>`,
      `<span>${series.round_rest}s ${i18n.t('link.round_rest', 'repos round')}</span>`,
    ].join('<span class="meta-dot">·</span>');

    const mm = String(Math.floor(sessionTotal / 60)).padStart(2, '0');
    const ss = String(sessionTotal % 60).padStart(2, '0');
    this._$('lpDuration').textContent = (hasReps ? '~' : '') + `${mm}:${ss}`;
    this._$('lpEstimateNote').style.display = hasReps ? '' : 'none';

    const list = this._$('lpList');
    list.innerHTML = '';
    series.exercises.forEach((ex, i) => {
      const row = document.createElement('div');
      row.className = 'lp-row';
      row.innerHTML = `
        <span class="lp-row-num">${String(i + 1).padStart(2, '0')}</span>
        <span class="lp-row-name">${this._esc(ex.name)}</span>
        <span class="lp-row-dur ${isReps(ex) ? 'reps' : ''}">${isReps(ex) ? ex.reps + '\u00D7' : ex.work + 's'}</span>
        <span class="lp-row-rest">+${ex.rest}s</span>
      `;
      list.appendChild(row);
    });

    this._el.style.display = 'flex';
  }

  hide() { this._el.style.display = 'none'; }

  async _save() {
    try {
      await this._sm.save(this._series);
      this._$('lpSave').disabled = true;
      this._$('lpSave').textContent = i18n.t('link.saved', 'Ajouté à mes séries ✓');
    } catch (err) {
      this._$('lpSave').textContent = err.message;
    }
  }

  _esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

/* ═══════════════════════════════════════
   SPOTIFY WEB — OAuth PKCE + pilotage à distance via la Web API

   Le build natif iOS parle au SDK App Remote par le pont Swift. Sur le web
   il n'existe pas de pont : on pilote à la place l'app Spotify de
   l'utilisateur (téléphone, PC, enceinte) avec les endpoints /me/player.
   La musique ne sort donc PAS de la PWA — elle sort de Spotify.

   PKCE ne demande aucun client secret : le client ID est public par
   conception, rien de sensible ne transite ici.
   ═══════════════════════════════════════ */
const SpotifyWeb = (() => {
  const AUTH_URL  = 'https://accounts.spotify.com/authorize';
  const TOKEN_URL = 'https://accounts.spotify.com/api/token';
  const API       = 'https://api.spotify.com/v1';
  const SCOPES    = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';

  const TOK_KEY      = 'tabata_sp_token';
  const VERIFIER_KEY = 'tabata_sp_verifier';
  const STATE_KEY    = 'tabata_sp_state';
  const RETURN_KEY   = 'tabata_sp_return';

  const cfg = () => window.TABATA_CONFIG?.spotify || {};

  const _read = () => { try { return JSON.parse(localStorage.getItem(TOK_KEY) || 'null'); } catch (_) { return null; } };
  const _write = t => localStorage.setItem(TOK_KEY, JSON.stringify(t));
  const _forget = () => localStorage.removeItem(TOK_KEY);

  /** Utilisable ici ? Il faut un client ID et un contexte http(s) —
      le build Capacitor tourne sur capacitor:// et garde son pont natif. */
  const available = () =>
    !!cfg().clientId && (location.protocol === 'https:' || location.protocol === 'http:');

  const isConnected = () => !!_read();

  const _redirectUri = () => cfg().redirectUri || (location.origin + location.pathname);

  function _rand(n) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const bytes = new Uint8Array(n);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
  }

  const _b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  /** Démarre le flux : quitte la page vers Spotify, qui nous renverra ici. */
  async function authorize() {
    if (!available()) return;
    const verifier = _rand(64);
    const state = _rand(16);
    sessionStorage.setItem(VERIFIER_KEY, verifier);
    sessionStorage.setItem(STATE_KEY, state);
    // L'aller-retour OAuth réécrit la query string : on met de côté la
    // séance partagée (?w=…) pour la restaurer au retour.
    sessionStorage.setItem(RETURN_KEY, location.search + location.hash);

    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const params = new URLSearchParams({
      client_id: cfg().clientId,
      response_type: 'code',
      redirect_uri: _redirectUri(),
      code_challenge_method: 'S256',
      code_challenge: _b64url(digest),
      scope: SCOPES,
      state,
    });
    location.href = `${AUTH_URL}?${params}`;
  }

  async function _exchange(body) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error_description || json.error || `HTTP ${res.status}`);
    const tok = {
      access:  json.access_token,
      refresh: json.refresh_token || _read()?.refresh || null,
      // 60 s de marge pour ne pas partir en requête avec un jeton qui expire
      expires: Date.now() + ((json.expires_in || 3600) - 60) * 1000,
    };
    _write(tok);
    return tok;
  }

  /** À appeler au démarrage. Retourne 'connected' | 'denied' | null. */
  async function handleRedirect() {
    const q = new URLSearchParams(location.search);
    const code = q.get('code');
    const err  = q.get('error');
    if (!code && !err) return null;

    const back = sessionStorage.getItem(RETURN_KEY) || '';
    const restore = () => {
      sessionStorage.removeItem(VERIFIER_KEY);
      sessionStorage.removeItem(STATE_KEY);
      sessionStorage.removeItem(RETURN_KEY);
      history.replaceState(null, '', location.pathname + back);
    };

    if (err) { restore(); return 'denied'; }

    const verifier = sessionStorage.getItem(VERIFIER_KEY);
    const expected = sessionStorage.getItem(STATE_KEY);
    if (!verifier || q.get('state') !== expected) { restore(); return 'denied'; }

    try {
      await _exchange({
        grant_type: 'authorization_code',
        code,
        redirect_uri: _redirectUri(),
        client_id: cfg().clientId,
        code_verifier: verifier,
      });
      restore();
      return 'connected';
    } catch (e) {
      console.warn('[spotify] échec de l\'échange du code :', e.message);
      restore();
      return 'denied';
    }
  }

  async function _accessToken() {
    const tok = _read();
    if (!tok) return null;
    if (Date.now() < tok.expires) return tok.access;
    if (!tok.refresh) { _forget(); return null; }
    try {
      const fresh = await _exchange({
        grant_type: 'refresh_token',
        refresh_token: tok.refresh,
        client_id: cfg().clientId,
      });
      return fresh.access;
    } catch (_) {
      _forget();
      return null;
    }
  }

  /** Retourne { status, json } ; status 0 = pas de réseau / pas de jeton. */
  async function _api(method, path, { retry = true } = {}) {
    const access = await _accessToken();
    if (!access) return { status: 0, json: null };
    let res;
    try {
      res = await fetch(API + path, { method, headers: { Authorization: 'Bearer ' + access } });
    } catch (_) {
      return { status: 0, json: null };
    }
    // Jeton révoqué côté Spotify : on rafraîchit et on rejoue une fois.
    if (res.status === 401 && retry) {
      const tok = _read();
      if (tok) { tok.expires = 0; _write(tok); }
      return _api(method, path, { retry: false });
    }
    if (res.status === 204) return { status: 204, json: null };
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  /** Normalise /me/player vers la même forme que l'état poussé par Swift. */
  async function state() {
    if (!isConnected()) return { connected: false };
    const { status, json } = await _api('GET', '/me/player');
    if (status === 0) return { connected: false };
    // 204 = authentifié, mais aucun appareil Spotify actif à piloter.
    if (status === 204 || !json?.item) return { connected: true, idle: true };
    const it = json.item;
    return {
      connected: true,
      idle: false,
      playing:  !!json.is_playing,
      track:    it.name,
      artist:   (it.artists || []).map(a => a.name).join(', '),
      duration: it.duration_ms,
      position: json.progress_ms || 0,
      artwork:  it.album?.images?.[0]?.url || '',
      device:   json.device?.name || '',
    };
  }

  /** Retourne 'ok' | 'no_device' | 'forbidden' | 'error'. */
  async function command(action, data = {}) {
    const routes = {
      play:     ['PUT',  '/me/player/play'],
      pause:    ['PUT',  '/me/player/pause'],
      next:     ['POST', '/me/player/next'],
      previous: ['POST', '/me/player/previous'],
      seek:     ['PUT',  `/me/player/seek?position_ms=${Math.max(0, Math.floor(data.position || 0))}`],
    };
    const route = routes[action];
    if (!route) return 'error';
    const { status } = await _api(route[0], route[1]);
    if (status === 404) return 'no_device';   // aucun appareil actif
    if (status === 403) return 'forbidden';   // Premium requis, ou action interdite
    if (status >= 200 && status < 300) return 'ok';
    return 'error';
  }

  function logout() { _forget(); }

  return { available, isConnected, authorize, handleRedirect, state, command, logout };
})();

/* ═══════════════════════════════════════
   SPOTIFY MINI-PLAYER  (App Remote natif, ou Web API sur le web)
   ═══════════════════════════════════════ */
class SpotifyPlayer {
  constructor() {
    this._connected  = false;
    this._state      = null;   // {playing, track, artist, position, duration, artwork}
    this._positionMs = 0;
    this._fetchedAt  = 0;
    this._collapsed  = true;
    this._tickId     = null;
    this._pollId     = null;
    this._idle       = false;    // authentifié, mais aucun appareil actif
    this._notice     = '';       // message d'erreur de la dernière commande

    // Native push: Swift calls window.__spStateUpdate(state)
    window.__spStateUpdate = s => this._onNativeState(s);

    // Sur le web on pilote l'app Spotify de l'utilisateur via la Web API.
    this._isWeb = !this._isNative && SpotifyWeb.available();

    // Ni pont natif ni client ID : le lecteur n'a rien à piloter, on le retire.
    if (!this._isNative && !this._isWeb) {
      const wrap = this._$('spWrap');
      if (wrap) wrap.style.display = 'none';
      return;
    }

    this._bind();
    this._applyView();
    if (this._isWeb) this._startWeb();
  }

  get _isNative() { return !!(window.webkit?.messageHandlers?.spotify); }

  /** Achemine une commande vers le pont natif ou la Web API. */
  async _cmd(action, data = {}) {
    if (this._isNative) return this._native(action, data);
    if (!this._isWeb) return;

    const res = await SpotifyWeb.command(action, data);
    this._notice = res === 'no_device' ? 'no_device'
                 : res === 'forbidden' ? 'forbidden'
                 : res === 'error'     ? 'error' : '';
    // L'état côté Spotify met un instant à refléter la commande.
    setTimeout(() => this._pollWeb(), 350);
    this._applyView();
  }

  /** Démarre le suivi web : sondage périodique, en pause hors écran. */
  _startWeb() {
    const sync = () => { if (!document.hidden) this._pollWeb(); };
    this._pollId = setInterval(sync, 5000);
    document.addEventListener('visibilitychange', sync);
    sync();
  }

  async _pollWeb() {
    if (!this._isWeb) return;
    const s = await SpotifyWeb.state();
    this._connected = !!s.connected;
    this._idle = !!s.idle;

    if (s.connected && !s.idle) {
      this._state      = s;
      this._positionMs = s.position || 0;
      this._fetchedAt  = Date.now();
      if (!this._tickId) this._tickId = setInterval(() => this._tick(), 1000);
      this._notice = '';
    } else {
      this._state = null;
      clearInterval(this._tickId);
      this._tickId = null;
    }
    this._applyView();
  }

  _native(action, data = {}) {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      window.__spCb = window.__spCb || {};
      window.__spCb[id] = { resolve, reject };
      window.webkit.messageHandlers.spotify.postMessage({ action, data, id });
    });
  }

  _$(id) { return document.getElementById(id); }

  _bind() {
    this._$('spPill').addEventListener('click', () => {
      this._collapsed = false;
      this._applyView();
    });
    this._$('spCollapseBtn').addEventListener('click', () => {
      this._collapsed = true;
      this._applyView();
    });
    this._$('spPrev').addEventListener('click',      () => this._cmd('previous'));
    this._$('spNext').addEventListener('click',      () => this._cmd('next'));
    this._$('spPlayPause').addEventListener('click', () => {
      if (this._state?.playing) this._cmd('pause');
      else                      this._cmd('play');
    });

    const connectBtn = this._$('spConnect');
    if (connectBtn) {
      connectBtn.addEventListener('click', () => {
        if (SpotifyWeb.isConnected()) {   // le bouton sert alors à se déconnecter
          SpotifyWeb.logout();
          this._connected = false;
          this._state = null;
          this._applyView();
        } else {
          SpotifyWeb.authorize();
        }
      });
    }
    this._$('spBar').addEventListener('click', e => this._seek(e));

    let _touchX = 0;
    this._$('spCard').addEventListener('touchstart', e => { _touchX = e.touches[0].clientX; }, { passive: true });
    this._$('spCard').addEventListener('touchend', e => {
      if (e.changedTouches[0].clientX - _touchX < -50) {
        this._collapsed = true;
        this._applyView();
      }
    }, { passive: true });
  }

  _onNativeState(s) {
    const wasConnected = this._connected;
    this._connected  = !!s.connected;

    if (this._connected && s.track) {
      this._state      = s;
      this._positionMs = s.position || 0;
      this._fetchedAt  = Date.now();
      if (!this._tickId) {
        this._tickId = setInterval(() => this._tick(), 1000);
      }
    } else if (!this._connected) {
      this._state = null;
      clearInterval(this._tickId);
      this._tickId = null;
    }

    // Auto-expand card on first connection
    if (!wasConnected && this._connected) {
      this._collapsed = false;
    }

    this._applyView();
  }

  _tick() {
    if (!this._state?.playing) return;
    const elapsed    = Date.now() - this._fetchedAt;
    this._positionMs = (this._state.position || 0) + elapsed;
    this._renderProgress();
  }

  _seek(e) {
    const dur = this._state?.duration;
    if (!dur || (!this._isNative && !this._isWeb)) return;
    const rect       = e.currentTarget.getBoundingClientRect();
    const pct        = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const ms         = Math.floor(pct * dur);
    this._positionMs = ms;
    this._fetchedAt  = Date.now();
    this._snapBar();
    this._renderProgress();
    this._cmd('seek', { position: ms });
  }

  _snapBar() {
    const fill = this._$('spBarFill');
    if (!fill) return;
    fill.style.transition = 'none';
    requestAnimationFrame(() => { fill.style.transition = ''; });
  }

  _applyView() {
    const wrap = this._$('spWrap');
    if (!wrap) return;
    wrap.classList.toggle('sp-collapsed', this._collapsed);

    const s    = this._state;
    const hint = this._$('spHint');

    this._updateConnectUI();

    if (!this._connected || !s?.track) {
      this._$('spTrack').textContent  = '—';
      this._$('spArtist').textContent = '';
      this._$('spArt').removeAttribute('src');
      this._$('spArt').style.display  = 'none';
      this._$('spArtPlaceholder').classList.remove('hidden');
      const pt2 = this._$('spPillTrack'); if (pt2) pt2.textContent = '';
      this._$('spEq').classList.remove('playing');
      this._$('spPlayPause').querySelector('.sp-ico-play').style.display  = '';
      this._$('spPlayPause').querySelector('.sp-ico-pause').style.display = 'none';
      if (hint) { hint.textContent = this._hintText(); hint.style.display = ''; }
      this._renderProgress();
      return;
    }

    if (hint) {
      // Une commande refusée reste affichée même quand un titre est chargé.
      const notice = this._noticeText();
      hint.textContent = notice;
      hint.style.display = notice ? '' : 'none';
    }
    this._$('spTrack').textContent  = s.track  || '—';
    this._$('spArtist').textContent = s.artist || '';
    const artUrl = s.artwork || '';
    const art = this._$('spArt');
    if (artUrl) { art.src = artUrl; art.style.display = ''; }
    else        { art.removeAttribute('src'); art.style.display = 'none'; }
    this._$('spArtPlaceholder').classList.toggle('hidden', !!artUrl);
    const pt = this._$('spPillTrack'); if (pt) pt.textContent = s.track || '';
    this._$('spTimeDur').textContent = this._fmtMs(s.duration || 0);

    const playing = !!s.playing;
    this._$('spPlayPause').querySelector('.sp-ico-play').style.display  = playing ? 'none' : '';
    this._$('spPlayPause').querySelector('.sp-ico-pause').style.display = playing ? ''     : 'none';
    this._$('spEq').classList.toggle('playing', playing);

    this._renderProgress();
  }

  /** Le bouton sert à connecter, puis à déconnecter le compte. */
  _updateConnectUI() {
    const btn = this._$('spConnect');
    if (!btn) return;
    if (!this._isWeb) { btn.style.display = 'none'; return; }

    const linked = SpotifyWeb.isConnected();
    btn.style.display = '';
    btn.classList.toggle('sp-connect-linked', linked);
    btn.textContent = linked
      ? i18n.t('spotify.disconnect', 'Déconnecter')
      : i18n.t('spotify.connect', 'Connecter Spotify');
  }

  _noticeText() {
    if (this._notice === 'no_device') return i18n.t('spotify.no_device', 'Aucun appareil actif — lance la lecture dans Spotify');
    if (this._notice === 'forbidden') return i18n.t('spotify.premium', 'Spotify Premium requis pour piloter la lecture');
    if (this._notice === 'error')     return i18n.t('spotify.error', 'Commande refusée par Spotify');
    return '';
  }

  _hintText() {
    const notice = this._noticeText();
    if (notice) return notice;
    if (!this._isWeb) return i18n.t('spotify.hint_native', 'Appuie sur ▶ pour connecter Spotify');
    if (!SpotifyWeb.isConnected()) return i18n.t('spotify.hint_connect', 'Connecte ton compte pour piloter la lecture');
    return i18n.t('spotify.hint_idle', 'Lance un morceau dans l\'app Spotify');
  }

  _renderProgress() {
    const dur = this._state?.duration || 0;
    const pos = Math.max(0, Math.min(this._positionMs, dur));
    const pct = dur ? (pos / dur) * 100 : 0;
    this._$('spBarFill').style.width = `${pct.toFixed(2)}%`;
    this._$('spTimePos').textContent = this._fmtMs(pos);
    if (dur) this._$('spTimeDur').textContent = this._fmtMs(dur);
  }

  _fmtMs(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
}

/* ═══════════════════════════════════════
   I18N
   ═══════════════════════════════════════ */
const i18n = (() => {
  let _strings = {};
  const _lang = () => localStorage.getItem('tabata_lang') || 'fr';

  async function load(lang) {
    try {
      const res = await fetch(`locales/${lang}.json`);
      if (res.ok) _strings = await res.json();
    } catch (_) {}
    localStorage.setItem('tabata_lang', lang);
    document.documentElement.lang = lang;
    _applyAll();
  }

  function t(key, fallback = key) {
    return _strings[key] !== undefined ? _strings[key] : fallback;
  }

  function _applyAll() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      el.innerHTML = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(el => {
      el.placeholder = t(el.dataset.i18nPh);
    });
  }

  async function init() { await load(_lang()); }
  function toggle() { load(_lang() === 'fr' ? 'en' : 'fr'); return _lang(); }

  return { init, load, t, toggle, lang: _lang };
})();

/* ═══════════════════════════════════════
   WEBDAV — Nextcloud metrics storage
   ═══════════════════════════════════════ */
const WebDAV = (() => {
  // Identifiants injectés au build depuis .env (voir scripts/gen-config.mjs).
  // Absents du build PWA par défaut : servis au navigateur, ils seraient
  // lisibles par n'importe quel visiteur du site.
  const _cfg = () => window.TABATA_CONFIG?.webdav || null;

  /** Sans identifiants, « Mes mesures » fonctionne en local uniquement. */
  const enabled = () => !!_cfg()?.url;

  const _authHeader = () => {
    const c = _cfg();
    return 'Basic ' + btoa(`${c.user}:${c.pass}`);
  };
  const _isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  // Returns { status, text }. Uses native CapacitorHttp on device (bypasses CORS),
  // plain fetch in a dev browser.
  async function _req(method, file, body) {
    if (!enabled()) throw new Error('WebDAV non configuré');
    const url = _cfg().url + (file || '');
    const headers = { Authorization: _authHeader() };
    if (body != null) headers['Content-Type'] = 'text/csv; charset=utf-8';

    if (_isNative()) {
      const http = window.Capacitor.Plugins.CapacitorHttp;
      const res = await http.request({ method, url, headers, data: body });
      const text = typeof res.data === 'string' ? res.data : (res.data == null ? '' : JSON.stringify(res.data));
      return { status: res.status, text };
    }

    const res = await fetch(url, { method, headers, body });
    const text = await res.text().catch(() => '');
    return { status: res.status, text };
  }

  // Create the metrics/ collection if missing. 405 = already exists → ignore.
  async function ensureDir() {
    try { await _req('MKCOL', ''); } catch (_) {}
  }

  // Returns the file content, or null if it does not exist yet (404).
  async function read(file) {
    const { status, text } = await _req('GET', file);
    if (status === 404) return null;
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
    return text;
  }

  // Append one CSV row. Reads existing content (seeding the header if absent), then PUTs the whole file.
  async function append(file, header, row) {
    let existing = null;
    try { existing = await read(file); } catch (_) { existing = null; }

    const esc = v => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rowLine = row.map(esc).join(',');

    let content;
    if (existing && existing.trim()) {
      content = existing.replace(/\s+$/, '') + '\n' + rowLine + '\n';
    } else {
      content = header.join(',') + '\n' + rowLine + '\n';
    }

    const { status } = await _req('PUT', file, content);
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
  }

  return { enabled, ensureDir, read, append };
})();

/* ═══════════════════════════════════════
   METRICS SCREEN — body / strength / running / notes → CSV on Nextcloud
   ═══════════════════════════════════════ */
class MetricsScreen {
  constructor() {
    this._el = document.getElementById('metricsScreen');
    this._cats = ['body', 'strength', 'running', 'notes'];
    this._curCat = null;
    this._files = {
      body:     { name: 'body.csv',     header: ['date', 'weight_kg', 'height_cm', 'bmi'] },
      strength: { name: 'strength.csv', header: ['date', 'exercise', 'reps', 'weight_kg'] },
      running:  { name: 'running.csv',  header: ['date', 'distance_km', 'duration_min', 'pace_min_per_km'] },
      notes:    { name: 'notes.csv',    header: ['date', 'metric', 'value'] },
    };
    // Which CSV column to plot on each category's chart.
    this._chartCfg = {
      body:     { col: 'weight_kg',       unit: 'kg' },
      strength: { col: 'weight_kg',       unit: 'kg' },
      running:  { col: 'pace_min_per_km', unit: '', pace: true, lowerBetter: true },
      notes:    { col: 'value',           unit: '' },
    };
    this._bind();
  }

  _$(id) { return document.getElementById(id); }

  _bind() {
    this._$('metricsHomeBack').addEventListener('click', () => {
      this.hide();
      document.dispatchEvent(new Event('showWelcome'));
    });

    this._el.querySelectorAll('.metrics-cat-card').forEach(card => {
      card.addEventListener('click', () => this._openCategory(card.dataset.cat));
    });
    this._el.querySelectorAll('[data-back]').forEach(btn => {
      btn.addEventListener('click', () => this._showHub());
    });

    this._$('saveBody').addEventListener('click',     () => this._saveBody());
    this._$('saveStrength').addEventListener('click', () => this._saveStrength());
    this._$('saveRunning').addEventListener('click',  () => this._saveRunning());
    this._$('saveNotes').addEventListener('click',    () => this._saveNotes());
  }

  show() {
    this._el.classList.remove('closing');
    this._el.style.display = 'flex';
    if (WebDAV.enabled()) WebDAV.ensureDir();
    this._showHub();
  }

  hide() {
    this._el.classList.add('closing');
    setTimeout(() => { this._el.style.display = 'none'; }, 420);
  }

  /* ── Navigation ── */
  _showHub() {
    this._curCat = null;
    this._$('metricsHub').style.display = 'flex';
    this._cats.forEach(c => this._$('page-' + c).style.display = 'none');
    this._el.scrollTop = 0;
  }

  _openCategory(cat) {
    this._curCat = cat;
    this._$('metricsHub').style.display = 'none';
    this._cats.forEach(c => this._$('page-' + c).style.display = c === cat ? 'flex' : 'none');
    this._el.scrollTop = 0;
    this._loadCategory(cat);
  }

  /* ── Saves ── */
  async _saveBody() {
    const weight = parseFloat(this._$('mWeight').value);
    const height = parseFloat(this._$('mHeight').value);
    if (!weight && !height) return this._toast(i18n.t('metrics.toast.empty'), 'error');
    let bmi = '';
    if (weight && height) bmi = (weight / Math.pow(height / 100, 2)).toFixed(1);
    await this._persist('body', [this._now(), weight || '', height || '', bmi], () => {
      this._$('mWeight').value = '';
      this._$('mHeight').value = '';
    });
  }

  async _saveStrength() {
    const exercise = this._$('mExercise').value.trim();
    const reps = parseInt(this._$('mReps').value);
    const load = parseFloat(this._$('mLoad').value);
    if (!exercise) return this._toast(i18n.t('metrics.toast.empty'), 'error');
    await this._persist('strength', [this._now(), exercise, reps || '', load || ''], () => {
      this._$('mExercise').value = '';
      this._$('mReps').value = '';
      this._$('mLoad').value = '';
    });
  }

  async _saveRunning() {
    const dist = parseFloat(this._$('mDist').value);
    const dur = parseFloat(this._$('mDur').value);
    if (!dist || !dur) return this._toast(i18n.t('metrics.toast.empty'), 'error');
    await this._persist('running', [this._now(), dist, dur, this._minToPace(dur / dist)], () => {
      this._$('mDist').value = '';
      this._$('mDur').value = '';
    });
  }

  async _saveNotes() {
    const metric = this._$('mMetric').value.trim();
    const value = this._$('mValue').value.trim();
    if (!metric || !value) return this._toast(i18n.t('metrics.toast.empty'), 'error');
    await this._persist('notes', [this._now(), metric, value], () => {
      this._$('mMetric').value = '';
      this._$('mValue').value = '';
    });
  }

  async _persist(cat, row, onSuccess) {
    const { name, header } = this._files[cat];
    // Mirror locally first so a failed sync never loses the entry.
    this._cacheLocal(cat, row);

    if (!WebDAV.enabled()) {
      onSuccess && onSuccess();
      this._toast(i18n.t('metrics.toast.local', 'Enregistré sur cet appareil'), 'success');
      this._loadCategory(cat);
      return;
    }

    try {
      await WebDAV.append(name, header, row);
      onSuccess && onSuccess();
      this._toast(i18n.t('metrics.toast.saved'), 'success');
      this._loadCategory(cat);
    } catch (err) {
      this._toast(i18n.t('metrics.toast.error'), 'error');
    }
  }

  /** Lignes du cache local, remises dans l'ordre du CSV (plus ancienne d'abord). */
  _localRows(cat) {
    try {
      return JSON.parse(localStorage.getItem(`tabata_metrics_${cat}`) || '[]').slice().reverse();
    } catch (_) { return []; }
  }

  _cacheLocal(cat, row) {
    const key = `tabata_metrics_${cat}`;
    const arr = JSON.parse(localStorage.getItem(key) || '[]');
    arr.unshift(row);
    if (arr.length > 100) arr.length = 100;
    localStorage.setItem(key, JSON.stringify(arr));
  }

  /* ── Load a category: chart + history (single read) ── */
  async _loadCategory(cat) {
    const histBox = this._$(`hist-${cat}`);
    const chartBox = this._$(`chart-${cat}`);
    histBox.innerHTML = `<p class="metrics-hist-msg">${i18n.t('metrics.loading')}</p>`;
    chartBox.innerHTML = '';
    try {
      let rows;
      if (WebDAV.enabled()) {
        const text = await WebDAV.read(this._files[cat].name);
        rows = (text && text.trim()) ? this._parseCSV(text) : [];
      } else {
        rows = this._localRows(cat);
      }
      this._renderChart(cat, rows, chartBox);
      this._renderHistory(cat, rows, histBox);
    } catch (err) {
      chartBox.innerHTML = '';
      histBox.innerHTML = `<p class="metrics-hist-msg">${i18n.t('metrics.hist_error')}</p>`;
    }
  }

  _renderHistory(cat, rows, box) {
    if (rows.length <= 1) {
      box.innerHTML = `<p class="metrics-hist-msg">${i18n.t('metrics.hist_empty')}</p>`;
      return;
    }
    const header = rows[0];
    const last = rows.slice(1).slice(-12).reverse();
    box.innerHTML = last.map(r => {
      const cells = r.map((c, i) => c
        ? `<span class="metrics-hist-cell"><em>${this._esc(this._labelFor(header[i]))}</em> ${this._esc(c)}</span>`
        : '').join('');
      return `<div class="metrics-hist-row">${cells}</div>`;
    }).join('');
  }

  /* ── SVG performance chart ── */
  _renderChart(cat, rows, box) {
    const cfg = this._chartCfg[cat];
    if (rows.length <= 1) {
      box.innerHTML = `<p class="metrics-chart-empty">${i18n.t('metrics.chart_empty')}</p>`;
      return;
    }
    const header = rows[0];
    const idx = header.indexOf(cfg.col);
    const series = idx < 0 ? [] : rows.slice(1)
      .map(r => cfg.pace ? this._paceToMin(r[idx]) : parseFloat(r[idx]))
      .filter(v => Number.isFinite(v));

    if (series.length === 0) {
      box.innerHTML = `<p class="metrics-chart-empty">${i18n.t('metrics.chart_empty')}</p>`;
      return;
    }

    const fmt = v => cfg.pace ? this._minToPace(v) : (Math.round(v * 10) / 10) + (cfg.unit ? ' ' + cfg.unit : '');
    const cur = series[series.length - 1];
    const min = Math.min(...series);
    const max = Math.max(...series);

    const summary = `
      <div class="metrics-chart-head">
        <span class="metrics-chart-stat"><em>${i18n.t('metrics.chart_current')}</em><b>${this._esc(fmt(cur))}</b></span>
        <span class="metrics-chart-stat"><em>${i18n.t('metrics.chart_min')}</em><b>${this._esc(fmt(min))}</b></span>
        <span class="metrics-chart-stat"><em>${i18n.t('metrics.chart_max')}</em><b>${this._esc(fmt(max))}</b></span>
      </div>`;

    box.innerHTML = summary + this._svgChart(cat, series, min, max, !!cfg.lowerBetter);
  }

  _svgChart(cat, series, min, max, lowerBetter) {
    const W = 320, H = 120, padL = 10, padR = 10, padT = 14, padB = 14;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const n = series.length;
    const range = (max - min) || 1;
    const x = i => n === 1 ? W / 2 : padL + i * plotW / (n - 1);
    const y = v => {
      const t = (v - min) / range;            // 0 at min, 1 at max
      const up = lowerBetter ? t : 1 - t;      // fraction from bottom
      return padT + (1 - up) * plotH;
    };

    const pts = series.map((v, i) => [x(i), y(v)]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    const bottom = H - padB;
    const area = n > 1
      ? `M${pts[0][0].toFixed(1)} ${bottom} ` +
        pts.map(p => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ') +
        ` L${pts[n - 1][0].toFixed(1)} ${bottom} Z`
      : '';
    const dots = pts.map((p, i) =>
      `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${i === n - 1 ? 3.6 : 2.2}" class="${i === n - 1 ? 'metrics-dot-last' : 'metrics-dot'}"/>`
    ).join('');
    const gid = `mgrad-${cat}`;

    return `
      <svg class="metrics-chart-svg" viewBox="0 0 ${W} ${H}" role="img">
        <defs>
          <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="currentColor" stop-opacity="0.28"/>
            <stop offset="100%" stop-color="currentColor" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${area ? `<path d="${area}" fill="url(#${gid})" stroke="none"/>` : ''}
        ${n > 1 ? `<path d="${line}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>` : ''}
        ${dots}
      </svg>`;
  }

  _paceToMin(str) {
    if (str == null) return NaN;
    const s = String(str).trim();
    if (s.includes(':')) {
      const [m, sec] = s.split(':');
      return parseInt(m, 10) + (parseInt(sec, 10) || 0) / 60;
    }
    return parseFloat(s);
  }

  _minToPace(min) {
    const m = Math.floor(min);
    const s = Math.round((min - m) * 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  _labelFor(col) {
    if (col === 'date') return '';
    return i18n.t('metrics.col.' + col, col);
  }

  _parseCSV(text) {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
      .filter(l => l.trim())
      .map(l => this._parseLine(l));
  }

  // CSV line parser that respects quoted fields (matches WebDAV.append's escaping).
  _parseLine(line) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
        } else cur += ch;
      } else if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"') { q = true; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }

  _now() { return new Date().toISOString().slice(0, 16).replace('T', ' '); }

  _toast(msg, type = '') {
    const t = document.createElement('div');
    t.className = 'toast' + (type ? ' ' + type : '');
    t.textContent = msg;
    document.getElementById('toastWrap').appendChild(t);
    setTimeout(() => t.remove(), 3100);
  }

  _esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

/* ═══════════════════════════════════════
   BOOT
   ═══════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  // Le retour OAuth de Spotify arrive sur ?code=… et écrase la query string.
  // On le traite en premier : handleRedirect() restaure l'URL d'origine, donc
  // un éventuel ?w= est de nouveau lisible juste après.
  const spotifyAuth = SpotifyWeb.available() ? await SpotifyWeb.handleRedirect() : null;

  await i18n.init();

  const audio = new AudioEngine();
  const timer = new TabataTimer(audio);
  const sm    = new SeriesManager();
  const ui    = new UI(timer, sm, audio);

  document.addEventListener('touchstart', () => audio.unlock(), { passive: true, once: true });
  document.addEventListener('touchend',   () => audio.unlock(), { passive: true, once: true });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      timer.pause();
    } else {
      // Resume AudioContext each time the app comes to foreground —
      // iOS suspends it on background and it must be woken up again.
      audio.unlock();
    }
  });

  // Le build « lite » (npm run build:lite) n'embarque ni bibliothèque de
  // programmes, ni historique, ni stockage serveur : son accueil explique le
  // format de lien et attend une séance construite ailleurs.
  const LITE = window.TABATA_CONFIG?.target === 'lite';

  // A ?w= link opens straight onto its own preview screen instead of the
  // welcome grid. Starting needs a tap anyway — browsers keep audio muted
  // until a user gesture.
  const shared = WorkoutLink.decode();
  const linkPreview = new LinkPreview(sm, {
    onStart: series => {
      ui._loadSeriesIntoPanel(series);
      audio.unlock();
      timer.start();
    },
    onEdit: series => {
      ui._loadSeriesIntoPanel(series);
      ui._openPanel();
    },
  });

  const home = LITE
    ? new RunnerHome(sm, {
        onOpen:   series => linkPreview.show(series),
        onCreate: () => ui._openPanel(),
      })
    : new WelcomeScreen(sm, series => ui._loadSeriesIntoPanel(series));

  document.addEventListener('showWelcome', () => {
    WorkoutLink.clear();   // the address bar should stop advertising the shared workout
    home.show();
  });

  if (LITE) {
    // Pas d'historique dans le build lite : retirer son entrée de la barre.
    const histBtn = document.getElementById('btnHistory');
    if (histBtn) histBtn.style.display = 'none';
  } else {
    document.getElementById('welcomeSkip').addEventListener('click', () => {
      home.hide();
      ui._openPanel();
    });
    document.getElementById('welcomeHistoryBtn').addEventListener('click', () => {
      home.hide();
      ui._openHistoryModal();
    });

    /* ⟨metrics⟩ — bloc retiré par scripts/build-lite.mjs (aucun stockage serveur) */
    const metrics = new MetricsScreen();
    document.getElementById('welcomeMetricsBtn').addEventListener('click', () => {
      home.hide();
      metrics.show();
    });
    /* ⟨/metrics⟩ */
  }

  const langBtn = document.getElementById('langBtn');
  langBtn.textContent = i18n.lang().toUpperCase();
  langBtn.addEventListener('click', () => {
    i18n.toggle();
    langBtn.textContent = i18n.lang().toUpperCase();
  });

  // Retour d'autorisation Spotify : confirmer visuellement avant tout le reste.
  if (spotifyAuth === 'connected') ui._toast(i18n.t('spotify.linked', 'Spotify connecté'), 'success');
  else if (spotifyAuth === 'denied') ui._toast(i18n.t('spotify.denied', 'Connexion Spotify annulée'), 'error');

  if (shared) {
    // The home screen is visible straight from the markup, so take it out
    // before the preview opens — otherwise it reappears underneath once the
    // preview closes and covers the running timer.
    document.getElementById(LITE ? 'runnerHome' : 'welcomeScreen').style.display = 'none';
    linkPreview.show(shared);
  } else {
    home.show();
  }

  new SpotifyPlayer();

  // PWA: offline shell. Skipped inside the Capacitor wrapper, which serves the
  // same files from a custom scheme and has no use for a service worker.
  const isNative = !!(window.Capacitor?.isNativePlatform?.());
  if ('serviceWorker' in navigator && !isNative && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});
