/**
 * Modul Bersama Kalkulator UAS & Kalkulator Raport (+ Asisten Impor Nilai AI & Setoran ke Kepala Madrasah)
 * Terhubung ke Code.gs, sheet Nilai_UAS, Nilai_Raport, dan Log_Setoran.
 */
(function (root) {
  'use strict';

  const CONFIG = root.MDTA_CONFIG;
  const STATE = root.MDTA_STATE;
  const API = root.MDTA_API;
  const UI = root.MDTA_UI;

  const raportInstances = new Map();
  let activeRaportScope = null;
  let aiModalInitialized = false;
  let nilaiSetoranLogs = [];

  function getPredicate(score) {
    return API.computeRaportGrade(score);
  }

  function clampNum(v, min, max) {
    const n = UI.parseLocaleNumber(v, min);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  function buildSantriDatalistOptions() {
    if (!Array.isArray(STATE.santri) || STATE.santri.length === 0) return '';
    return STATE.santri
      .map((s) => `<option value="${UI.esc(s.nama_lengkap)}">${UI.esc(s.kelas || '')} (${UI.esc(s.id_santri)})</option>`)
      .join('');
  }

  function findNilaiSetoran(kelas, periode) {
    const targetK = (kelas || 'Semua Kelas').trim();
    const targetP = (periode || '').trim();
    return nilaiSetoranLogs.find((log) => {
      const matchK =
        log.kelas === targetK ||
        (targetK === 'Semua Kelas' && log.kelas === 'Semua Kelas') ||
        (targetK !== 'Semua Kelas' && log.kelas === 'Semua Kelas');
      const matchP = !targetP || !log.periode || log.periode === targetP;
      return matchK && matchP;
    });
  }

  async function refreshNilaiSetoranLogs() {
    try {
      const res = await API.getLogSetoran({ jenis_laporan: 'Nilai Raport' });
      nilaiSetoranLogs = API.extractArray(res, ['log_setoran']).map(API.normalizeLogSetoran);
    } catch (err) {
      // Abaikan jika Log_Setoran belum tersedia pada deployment lama
    }
    raportInstances.forEach((inst) => {
      if (typeof inst.updateSetoranBadge === 'function') inst.updateSetoranBadge();
    });
  }

  // =========================================================================
  // KALKULATOR UAS (Selaras skemaUasData & Nilai_UAS + Submit ke Kepala Madrasah)
  // =========================================================================
  function mountUAS(container, opts) {
    if (!container) return;
    const scope = opts.scope || 'admin';
    const session = opts.session || {};

    if (container.dataset.mounted === 'true') {
      const dl = document.getElementById(`${scope}-uas-santri-datalist`);
      if (dl) dl.innerHTML = buildSantriDatalistOptions();
      return;
    }

    const schemeOptions = CONFIG.UAS_SCHEMES.map(
      (s) => `<option value="${UI.esc(s.id)}">${UI.esc(s.label)}</option>`
    ).join('');
    const kelasOptions = CONFIG.KELAS_OPTIONS.map(
      (k) => `<option value="${UI.esc(k)}"></option>`
    ).join('');

    container.innerHTML = `
      <div class="uas-grid">
        <section class="surface-card">
          <div class="card-spotlight-layer" aria-hidden="true"></div>
          <div class="section-toolbar">
            <div>
              <span class="eyebrow-label">Penilaian Ujian Akhir Semester</span>
              <h2 class="heading-lg">Kalkulator Skor UAS</h2>
            </div>
            <div class="toolbar-actions">
              <span id="${scope}-uas-setoran-badge" class="status-badge status-sakit">Draft</span>
              <button type="button" id="${scope}-uas-reset" class="btn btn-secondary btn-sm">
                <i data-lucide="rotate-ccw" aria-hidden="true"></i>
                <span>Reset</span>
              </button>
            </div>
          </div>

          <form id="${scope}-uas-form" class="stack-gap" novalidate>
            <div class="form-grid">
              <div class="field-group">
                <label class="field-label" for="${scope}-uas-santri">Nama Santri</label>
                <input id="${scope}-uas-santri" list="${scope}-uas-santri-datalist" type="text" class="input-control" placeholder="Ketik atau pilih nama santri" required />
                <datalist id="${scope}-uas-santri-datalist">${buildSantriDatalistOptions()}</datalist>
              </div>
              <div class="field-group">
                <label class="field-label" for="${scope}-uas-kelas">Kelas</label>
                <input id="${scope}-uas-kelas" list="${scope}-uas-kelas-list" type="text" class="input-control" placeholder="Contoh: Kelas 7A" />
                <datalist id="${scope}-uas-kelas-list">${kelasOptions}</datalist>
              </div>
            </div>

            <div class="form-grid">
              <div class="field-group">
                <label class="field-label" for="${scope}-uas-semester">Semester</label>
                <select id="${scope}-uas-semester" class="select-control">
                  <option value="Ganjil">Ganjil</option>
                  <option value="Genap">Genap</option>
                </select>
              </div>
              <div class="field-group">
                <label class="field-label" for="${scope}-uas-tahun">Tahun Ajaran</label>
                <input id="${scope}-uas-tahun" type="text" class="input-control" value="2026/2027" />
              </div>
            </div>

            <div class="field-group">
              <label class="field-label" for="${scope}-uas-skema">Skema Soal UAS</label>
              <select id="${scope}-uas-skema" class="select-control">${schemeOptions}</select>
            </div>

            <div id="${scope}-uas-custom-box" class="sub-surface form-grid" hidden>
              <div class="field-group">
                <label class="field-label" for="${scope}-uas-c-pg-max">Maks Soal PG</label>
                <input id="${scope}-uas-c-pg-max" type="number" min="1" step="1" value="25" class="input-control mono-num" />
              </div>
              <div class="field-group">
                <label class="field-label" for="${scope}-uas-c-es-max">Maks Soal Essay</label>
                <input id="${scope}-uas-c-es-max" type="number" min="1" step="1" value="10" class="input-control mono-num" />
              </div>
              <div class="field-group">
                <label class="field-label" for="${scope}-uas-c-pg-w">Bobot PG (%)</label>
                <input id="${scope}-uas-c-pg-w" type="number" min="0" max="100" step="1" value="70" class="input-control mono-num" />
              </div>
              <div class="field-group">
                <label class="field-label" for="${scope}-uas-c-es-w">Bobot Essay (%)</label>
                <input id="${scope}-uas-c-es-w" type="number" min="0" max="100" step="1" value="30" class="input-control mono-num" />
              </div>
            </div>

            <div class="form-grid">
              <div class="field-group">
                <label class="field-label" for="${scope}-uas-pg">PG Benar <span id="${scope}-uas-pg-hint" class="text-muted"></span></label>
                <input id="${scope}-uas-pg" type="number" min="0" step="1" value="0" class="input-control mono-num" />
              </div>
              <div class="field-group">
                <label class="field-label" for="${scope}-uas-essay">Essay Benar <span id="${scope}-uas-essay-hint" class="text-muted"></span></label>
                <input id="${scope}-uas-essay" type="number" min="0" step="1" value="0" class="input-control mono-num" />
              </div>
              <div class="field-group">
                <label class="field-label" for="${scope}-uas-half">Setengah Benar <span id="${scope}-uas-half-hint" class="text-muted"></span></label>
                <input id="${scope}-uas-half" type="number" min="0" step="1" value="0" class="input-control mono-num" />
              </div>
            </div>

            <p id="${scope}-uas-validation" class="field-error-text" hidden></p>

            <div class="toolbar-actions">
              <button type="submit" id="${scope}-uas-save" class="btn btn-accent">
                <i data-lucide="database" aria-hidden="true"></i>
                <span>Simpan ke Database</span>
              </button>
              <button type="button" id="${scope}-uas-submit-kepsek" class="btn btn-primary">
                <i data-lucide="send" aria-hidden="true"></i>
                <span>Submit Rekap Nilai ke Kepala Madrasah</span>
              </button>
              <button type="button" id="${scope}-uas-send-raport" class="btn btn-secondary">
                <i data-lucide="arrow-right-circle" aria-hidden="true"></i>
                <span>Salin Nilai ke Raport</span>
              </button>
            </div>
          </form>
        </section>

        <aside class="surface-card score-focal-panel">
          <div class="card-spotlight-layer" aria-hidden="true"></div>
          <div>
            <span class="eyebrow-label">Hasil Perhitungan Real-Time</span>
            <h3 class="heading-md">Ringkasan Nilai UAS</h3>
          </div>

          <div class="score-big-box">
            <div>
              <div class="text-muted" style="font-size:0.8125rem;">Nilai Ujian UAS (Skala 100)</div>
              <div id="${scope}-uas-final-score" class="score-big-value">0.0</div>
            </div>
            <div style="text-align:right;">
              <span id="${scope}-uas-predikat" class="predicate-pill status-alpa">D</span>
              <div id="${scope}-uas-predikat-label" class="text-muted" style="font-size:0.78rem;margin-top:6px;">Kurang</div>
            </div>
          </div>

          <div class="stack-gap" style="gap:12px;">
            <div>
              <div style="display:flex;justify-content:space-between;font-size:0.84rem;margin-bottom:4px;">
                <span>Skor Pilihan Ganda (<span id="${scope}-uas-pg-w-txt">70</span>%)</span>
                <strong id="${scope}-uas-pg-score" class="mono-num">0.0</strong>
              </div>
              <div class="meter-track"><div id="${scope}-uas-pg-bar" class="meter-fill" style="width:0%;"></div></div>
            </div>
            <div>
              <div style="display:flex;justify-content:space-between;font-size:0.84rem;margin-bottom:4px;">
                <span>Skor Essay &amp; Setengah Benar (<span id="${scope}-uas-es-w-txt">30</span>%)</span>
                <strong id="${scope}-uas-essay-score" class="mono-num">0.0</strong>
              </div>
              <div class="meter-track"><div id="${scope}-uas-essay-bar" class="meter-fill" style="width:0%;"></div></div>
            </div>
            <div class="sub-surface" style="display:flex;justify-content:space-between;align-items:center;">
              <span class="text-secondary" style="font-size:0.84rem;">Rumus Skema Aktif</span>
              <strong id="${scope}-uas-formula-txt" class="mono-num" style="font-size:0.78rem;">25 PG (70%) + 10 Essay (30%)</strong>
            </div>
          </div>

          <div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
              <h4 class="heading-md" style="font-size:0.95rem;">Riwayat Nilai UAS</h4>
              <button type="button" id="${scope}-uas-refresh-hist" class="btn btn-secondary btn-sm" aria-label="Muat ulang riwayat UAS">
                <i data-lucide="refresh-cw" aria-hidden="true"></i>
              </button>
            </div>
            <div id="${scope}-uas-history"></div>
          </div>
        </aside>
      </div>
    `;

    container.dataset.mounted = 'true';
    UI.refreshIcons(container);
    UI.bindSpotlights(container);

    const form = document.getElementById(`${scope}-uas-form`);
    const santriInput = document.getElementById(`${scope}-uas-santri`);
    const kelasInput = document.getElementById(`${scope}-uas-kelas`);
    const semSelect = document.getElementById(`${scope}-uas-semester`);
    const tahunInput = document.getElementById(`${scope}-uas-tahun`);
    const skemaSelect = document.getElementById(`${scope}-uas-skema`);
    const customBox = document.getElementById(`${scope}-uas-custom-box`);

    const cPgMax = document.getElementById(`${scope}-uas-c-pg-max`);
    const cEsMax = document.getElementById(`${scope}-uas-c-es-max`);
    const cPgW = document.getElementById(`${scope}-uas-c-pg-w`);
    const cEsW = document.getElementById(`${scope}-uas-c-es-w`);

    const pgInput = document.getElementById(`${scope}-uas-pg`);
    const essayInput = document.getElementById(`${scope}-uas-essay`);
    const halfInput = document.getElementById(`${scope}-uas-half`);
    const validationEl = document.getElementById(`${scope}-uas-validation`);
    const saveBtn = document.getElementById(`${scope}-uas-save`);
    const submitKepsekBtn = document.getElementById(`${scope}-uas-submit-kepsek`);
    const sendRaportBtn = document.getElementById(`${scope}-uas-send-raport`);
    const resetBtn = document.getElementById(`${scope}-uas-reset`);
    const refreshHistBtn = document.getElementById(`${scope}-uas-refresh-hist`);
    const uasSetoranBadge = document.getElementById(`${scope}-uas-setoran-badge`);

    function updateUasSetoranBadge() {
      if (!uasSetoranBadge) return;
      const kelas = kelasInput.value.trim() || 'Semua Kelas';
      const periode = `${semSelect.value} ${tahunInput.value.trim()}`;
      const matched = findNilaiSetoran(kelas, periode);
      if (matched) {
        uasSetoranBadge.className = 'status-badge status-hadir';
        uasSetoranBadge.textContent = 'Sudah Disetor';
      } else {
        uasSetoranBadge.className = 'status-badge status-sakit';
        uasSetoranBadge.textContent = 'Draft';
      }
    }

    function getActiveScheme() {
      const id = skemaSelect.value;
      if (id === 'custom') {
        const maxPg = Math.max(1, Number(cPgMax.value) || 25);
        const maxEssay = Math.max(1, Number(cEsMax.value) || 10);
        const bobotPg = Math.max(0, Number(cPgW.value) || 0);
        const bobotEssay = Math.max(0, Number(cEsW.value) || 0);
        return {
          id: 'custom',
          label: `Kustom (${maxPg} PG [${bobotPg}%] & ${maxEssay} Essay [${bobotEssay}%])`,
          maxPg,
          maxEssay,
          bobotPg,
          bobotEssay,
        };
      }
      return CONFIG.UAS_SCHEMES.find((s) => s.id === id) || CONFIG.UAS_SCHEMES[0];
    }

    function calculateUAS() {
      const scheme = getActiveScheme();
      customBox.hidden = scheme.id !== 'custom';

      const pgVal = Math.max(0, Number(pgInput.value) || 0);
      const essayVal = Math.max(0, Number(essayInput.value) || 0);
      const halfVal = Math.max(0, Number(halfInput.value) || 0);

      document.getElementById(`${scope}-uas-pg-hint`).textContent = `(Maks ${scheme.maxPg})`;
      document.getElementById(`${scope}-uas-essay-hint`).textContent = `(Maks ${scheme.maxEssay})`;
      document.getElementById(`${scope}-uas-half-hint`).textContent = `(0.5x Essay)`;

      const errors = [];
      if (pgVal > scheme.maxPg) {
        errors.push(`PG Benar (${pgVal}) melebihi maksimal ${scheme.maxPg} soal.`);
      }
      if (essayVal + halfVal > scheme.maxEssay) {
        errors.push(`Total Essay Benar + Setengah Benar (${essayVal + halfVal}) melebihi ${scheme.maxEssay} soal.`);
      }
      if (scheme.id === 'custom' && scheme.bobotPg + scheme.bobotEssay !== 100) {
        errors.push(`Total bobot PG + Essay kustom saat ini ${scheme.bobotPg + scheme.bobotEssay}% (harus 100%).`);
      }

      if (errors.length > 0) {
        validationEl.textContent = errors[0];
        validationEl.hidden = false;
      } else {
        validationEl.textContent = '';
        validationEl.hidden = true;
      }

      const clampedPg = Math.min(scheme.maxPg, pgVal);
      const clampedEsTotal = Math.min(scheme.maxEssay, essayVal + halfVal * 0.5);
      const scorePg = (clampedPg / scheme.maxPg) * scheme.bobotPg;
      const scoreEssay = (clampedEsTotal / scheme.maxEssay) * scheme.bobotEssay;
      const nilaiAkhir = Math.round((scorePg + scoreEssay) * 10) / 10;
      const pred = getPredicate(nilaiAkhir);

      document.getElementById(`${scope}-uas-final-score`).textContent = nilaiAkhir.toFixed(1);
      const predEl = document.getElementById(`${scope}-uas-predikat`);
      predEl.textContent = pred.code;
      predEl.className = `predicate-pill ${pred.cls}`;
      document.getElementById(`${scope}-uas-predikat-label`).textContent = pred.label;

      document.getElementById(`${scope}-uas-pg-w-txt`).textContent = String(scheme.bobotPg);
      document.getElementById(`${scope}-uas-es-w-txt`).textContent = String(scheme.bobotEssay);
      document.getElementById(`${scope}-uas-pg-score`).textContent = `${scorePg.toFixed(1)} / ${scheme.bobotPg}`;
      document.getElementById(`${scope}-uas-essay-score`).textContent = `${scoreEssay.toFixed(1)} / ${scheme.bobotEssay}`;
      document.getElementById(`${scope}-uas-formula-txt`).textContent = `${scheme.maxPg} PG (${scheme.bobotPg}%) + ${scheme.maxEssay} Essay (${scheme.bobotEssay}%)`;

      document.getElementById(`${scope}-uas-pg-bar`).style.width = `${scheme.bobotPg > 0 ? Math.min(100, (scorePg / scheme.bobotPg) * 100) : 0}%`;
      document.getElementById(`${scope}-uas-essay-bar`).style.width = `${scheme.bobotEssay > 0 ? Math.min(100, (scoreEssay / scheme.bobotEssay) * 100) : 0}%`;

      return {
        scheme,
        pgVal,
        essayVal,
        halfVal,
        nilaiAkhir,
        predikat: pred.code,
        hasError: errors.length > 0,
      };
    }

    function renderUASHistory() {
      const box = document.getElementById(`${scope}-uas-history`);
      if (!box) return;
      if (!Array.isArray(STATE.nilaiUAS) || STATE.nilaiUAS.length === 0) {
        box.innerHTML = UI.renderStateBox({
          type: 'empty',
          title: 'Belum ada riwayat nilai UAS',
          message: 'Isi rincian skor di samping lalu klik "Simpan ke Database".',
        });
        UI.refreshIcons(box);
        return;
      }

      box.innerHTML = `<div class="stack-gap" style="gap:8px;">${STATE.nilaiUAS
        .slice(0, 6)
        .map((item) => {
          const pred = getPredicate(item.nilai_uas);
          return `
            <div class="sub-surface" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;">
              <div style="min-width:0;">
                <div style="font-weight:600;font-size:0.875rem;">${UI.esc(item.nama_santri)}</div>
                <div class="text-muted" style="font-size:0.78rem;">${UI.esc(item.kelas || '-')} · ${UI.esc(item.skema_soal)}</div>
              </div>
              <span class="status-badge ${pred.cls} mono-num">${UI.esc(item.nilai_uas)} (${pred.code})</span>
            </div>
          `;
        })
        .join('')}</div>`;
    }

    async function loadUASHistory(silent) {
      try {
        if (STATE.santri.length === 0) {
          const sRes = await API.getSantri();
          STATE.santri = API.extractArray(sRes, ['santri']).map(API.normalizeSantri);
          const dl = document.getElementById(`${scope}-uas-santri-datalist`);
          if (dl) dl.innerHTML = buildSantriDatalistOptions();
        }
        const res = await API.getNilaiUAS();
        STATE.nilaiUAS = API.extractArray(res, ['nilai_uas']).map(API.normalizeNilaiUAS).reverse();
        renderUASHistory();
        await refreshNilaiSetoranLogs();
        updateUasSetoranBadge();
      } catch (err) {
        if (!silent) UI.toast(err.message, 'error');
        renderUASHistory();
      }
    }

    async function saveUASRecord() {
      const nama = santriInput.value.trim();
      const calc = calculateUAS();
      if (!nama) {
        UI.toast('Nama santri wajib diisi.', 'error');
        santriInput.focus();
        return null;
      }
      if (calc.hasError) {
        UI.toast('Periksa validasi skema dan jumlah soal terlebih dahulu.', 'error');
        return null;
      }

      const matchedSantri = (STATE.santri || []).find((s) => s.nama_lengkap.toLowerCase() === nama.toLowerCase());
      const periode = `${semSelect.value} ${tahunInput.value.trim()}`;
      const payload = {
        id_santri: matchedSantri ? matchedSantri.id_santri : '',
        nama_santri: matchedSantri ? matchedSantri.nama_lengkap : nama,
        kelas: kelasInput.value.trim() || (matchedSantri ? matchedSantri.kelas : ''),
        periode,
        skema_soal: calc.scheme.label,
        pg_benar: calc.pgVal,
        essay_benar: calc.essayVal,
        setengah_benar: calc.halfVal,
        nilai_uas: calc.nilaiAkhir,
        id_guru: session.id_user || '',
      };

      const res = await API.saveNilaiUAS(payload);
      const d = res.data || res;
      STATE.nilaiUAS.unshift(
        Object.assign({}, payload, {
          id_uas: d.id_uas || 'Baru',
          updated_at: UI.todayISO(),
        })
      );
      renderUASHistory();
      return payload;
    }

    santriInput.addEventListener('change', () => {
      const val = santriInput.value.trim().toLowerCase();
      const match = (STATE.santri || []).find((s) => s.nama_lengkap.toLowerCase() === val);
      if (match && match.kelas && !kelasInput.value.trim()) {
        kelasInput.value = match.kelas;
        updateUasSetoranBadge();
      }
    });

    [kelasInput, semSelect, tahunInput].forEach((el) => {
      el.addEventListener('change', updateUasSetoranBadge);
    });

    [skemaSelect, cPgMax, cEsMax, cPgW, cEsW, pgInput, essayInput, halfInput].forEach((el) => {
      el.addEventListener('input', calculateUAS);
      el.addEventListener('change', calculateUAS);
    });

    resetBtn.addEventListener('click', () => {
      pgInput.value = '0';
      essayInput.value = '0';
      halfInput.value = '0';
      calculateUAS();
    });

    if (refreshHistBtn) {
      refreshHistBtn.addEventListener('click', () => loadUASHistory(false));
    }

    sendRaportBtn.addEventListener('click', () => {
      const nama = santriInput.value.trim();
      if (!nama) {
        UI.toast('Isi nama santri terlebih dahulu sebelum menyalin ke raport.', 'warn');
        santriInput.focus();
        return;
      }
      const calc = calculateUAS();
      if (calc.hasError) {
        UI.toast('Perbaiki jumlah jawaban yang melebihi batas skema terlebih dahulu.', 'error');
        return;
      }
      injectUASScoreToRaport({
        nama_lengkap: nama,
        kelas: kelasInput.value.trim(),
        uas: calc.nilaiAkhir,
      });
      UI.toast(`Nilai UAS ${nama} (${calc.nilaiAkhir}) disalin ke tabel Kalkulator Raport.`, 'success');
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      UI.setButtonLoading(saveBtn, true, 'Menyimpan...');
      try {
        const saved = await saveUASRecord();
        if (saved) {
          UI.toast(`Nilai UAS ${saved.nama_santri} (${saved.nilai_uas}) berhasil disimpan ke database.`, 'success');
        }
      } catch (err) {
        UI.toast(err.message, 'error');
      } finally {
        UI.setButtonLoading(saveBtn, false);
      }
    });

    if (submitKepsekBtn) {
      submitKepsekBtn.addEventListener('click', async () => {
        UI.setButtonLoading(submitKepsekBtn, true, 'Menyetor ke Kepala Madrasah...');
        try {
          let kelas = kelasInput.value.trim() || 'Semua Kelas';
          let periode = `${semSelect.value} ${tahunInput.value.trim()}`;
          let summaryText = '';

          if (santriInput.value.trim()) {
            const saved = await saveUASRecord();
            if (!saved) return;
            injectUASScoreToRaport({
              nama_lengkap: saved.nama_santri,
              kelas: saved.kelas,
              uas: saved.nilai_uas,
            });
            kelas = saved.kelas || kelas;
            periode = saved.periode || periode;
            summaryText = `Setoran UAS: ${saved.nama_santri} (${saved.nilai_uas})`;
          } else {
            const classItems = STATE.nilaiUAS.filter((n) => kelas === 'Semua Kelas' || n.kelas === kelas);
            if (classItems.length === 0) {
              UI.toast('Isi nilai santri terlebih dahulu atau pastikan riwayat UAS kelas sudah tersedia.', 'warn');
              return;
            }
            const avg =
              Math.round((classItems.reduce((s, x) => s + (Number(x.nilai_uas) || 0), 0) / classItems.length) * 10) / 10;
            summaryText = `Rekap UAS ${classItems.length} santri, rata-rata ${avg}`;
          }

          const logRes = await API.submitLaporanGuru({
            tanggal: UI.todayISO(),
            jenis_laporan: 'Nilai Raport',
            kelas,
            periode,
            id_guru: session.id_user || '',
            nama_guru: session.nama_lengkap || session.username || 'Guru',
            ringkasan: summaryText,
          });
          nilaiSetoranLogs.unshift(API.normalizeLogSetoran(logRes.data || logRes));
          updateUasSetoranBadge();
          raportInstances.forEach((inst) => {
            if (typeof inst.updateSetoranBadge === 'function') inst.updateSetoranBadge();
          });
          UI.toast(`Rekap nilai ${kelas} (${periode}) berhasil disetor ke Kepala Madrasah.`, 'success');
        } catch (err) {
          UI.toast(err.message, 'error');
        } finally {
          UI.setButtonLoading(submitKepsekBtn, false);
        }
      });
    }

    calculateUAS();
    renderUASHistory();
    loadUASHistory(true);
  }

  // =========================================================================
  // KALKULATOR RAPORT + ASISTEN IMPOR NILAI AI + SETORAN KEPALA MADRASAH
  // =========================================================================
  function injectUASScoreToRaport(entry) {
    const idx = STATE.raportRows.findIndex(
      (r) => r.nama_santri.trim().toLowerCase() === entry.nama_lengkap.trim().toLowerCase()
    );
    if (idx >= 0) {
      STATE.raportRows[idx].n_uas = clampNum(entry.uas, 0, 100);
      if (entry.kelas && !STATE.raportRows[idx].kelas) {
        STATE.raportRows[idx].kelas = entry.kelas;
      }
    } else {
      const matched = (STATE.santri || []).find(
        (s) => s.nama_lengkap.toLowerCase() === entry.nama_lengkap.trim().toLowerCase()
      );
      STATE.raportRows.push({
        uid: `row-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        id_raport: '',
        id_santri: matched ? matched.id_santri : '',
        nama_santri: entry.nama_lengkap,
        kelas: entry.kelas || (matched ? matched.kelas : ''),
        n_harian: 0,
        n_uas: clampNum(entry.uas, 0, 100),
        n_kehadiran: 100,
      });
    }
    raportInstances.forEach((inst) => inst.renderRows());
  }

  function mergeImportedRows(incomingRows) {
    if (!Array.isArray(incomingRows) || incomingRows.length === 0) return 0;
    let count = 0;

    incomingRows.forEach((raw) => {
      const nama = String(API.pick(raw, ['nama_lengkap', 'nama', 'nama_santri', 'santri'], '')).trim();
      if (!nama) return;

      const harianRaw = API.pick(raw, ['n_harian', 'harian', 'nilai_harian'], null);
      const uasRaw = API.pick(raw, ['n_uas', 'uas', 'nilai_uas'], null);
      const absensiRaw = API.pick(raw, ['n_kehadiran', 'kehadiran', 'absensi'], null);
      const kelasVal = String(API.pick(raw, ['kelas', 'rombel'], '')).trim();

      const existing = STATE.raportRows.find((r) => r.nama_santri.trim().toLowerCase() === nama.toLowerCase());
      if (existing) {
        if (harianRaw !== null && harianRaw !== '') existing.n_harian = clampNum(harianRaw, 0, 100);
        if (uasRaw !== null && uasRaw !== '') existing.n_uas = clampNum(uasRaw, 0, 100);
        if (absensiRaw !== null && absensiRaw !== '') existing.n_kehadiran = clampNum(absensiRaw, 0, 100);
        if (kelasVal && !existing.kelas) existing.kelas = kelasVal;
      } else {
        const matchedSantri = (STATE.santri || []).find((s) => s.nama_lengkap.toLowerCase() === nama.toLowerCase());
        STATE.raportRows.push({
          uid: `row-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          id_raport: '',
          id_santri: matchedSantri ? matchedSantri.id_santri : '',
          nama_santri: matchedSantri ? matchedSantri.nama_lengkap : nama,
          kelas: kelasVal || (matchedSantri ? matchedSantri.kelas : ''),
          n_harian: harianRaw !== null && harianRaw !== '' ? clampNum(harianRaw, 0, 100) : 0,
          n_uas: uasRaw !== null && uasRaw !== '' ? clampNum(uasRaw, 0, 100) : 0,
          n_kehadiran: absensiRaw !== null && absensiRaw !== '' ? clampNum(absensiRaw, 0, 100) : 100,
        });
      }
      count++;
    });

    raportInstances.forEach((inst) => inst.renderRows());
    return count;
  }

  function parseStructuredTextLocally(text) {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const parsed = [];

    lines.forEach((line) => {
      if (/^nama[\s,;|]/i.test(line) && /harian|uas|absensi|kehadiran/i.test(line)) return;
      const parts = line.split(/[,;\t|]+/).map((p) => p.trim());
      if (parts.length >= 2 && parts[0]) {
        const nums = parts.slice(1).map((v) => UI.parseLocaleNumber(v, NaN)).filter((n) => Number.isFinite(n));
        if (nums.length > 0) {
          parsed.push({
            nama_lengkap: parts[0],
            n_harian: nums[0] ?? 0,
            n_uas: nums[1] ?? 0,
            n_kehadiran: nums[2] ?? 100,
          });
          return;
        }
      }
      const m = line.match(/^([A-Za-z'\.\s-]+?)[\s:\-]+(\d+(?:[.,]\d+)?)(?:[\s,;]+(\d+(?:[.,]\d+)?))?(?:[\s,;]+(\d+(?:[.,]\d+)?))?%?$/);
      if (m) {
        parsed.push({
          nama_lengkap: m[1].trim(),
          n_harian: UI.parseLocaleNumber(m[2], 0),
          n_uas: m[3] ? UI.parseLocaleNumber(m[3], 0) : 0,
          n_kehadiran: m[4] ? UI.parseLocaleNumber(m[4], 100) : 100,
        });
      }
    });

    return parsed;
  }

  function initAIImportModal(session) {
    if (aiModalInitialized) return;
    aiModalInitialized = true;

    const form = document.getElementById('form-import-ai');
    const fileInput = document.getElementById('import-ai-file');
    const fileStatus = document.getElementById('import-ai-file-status');
    const textInput = document.getElementById('import-ai-text');
    const submitBtn = document.getElementById('btn-import-ai-submit');
    const localBtn = document.getElementById('btn-import-ai-local');
    const closeBtn = document.getElementById('btn-close-import-ai-modal');
    const cancelBtn = document.getElementById('btn-cancel-import-ai');
    const errorBox = document.getElementById('import-ai-error');

    let selectedFilePayload = null;

    function setError(msg) {
      if (!errorBox) return;
      if (msg) {
        errorBox.textContent = msg;
        errorBox.hidden = false;
      } else {
        errorBox.textContent = '';
        errorBox.hidden = true;
      }
    }

    if (closeBtn) closeBtn.addEventListener('click', () => UI.closeModal('modal-import-ai'));
    if (cancelBtn) cancelBtn.addEventListener('click', () => UI.closeModal('modal-import-ai'));

    if (fileInput) {
      fileInput.addEventListener('change', () => {
        setError('');
        const file = fileInput.files && fileInput.files[0];
        if (!file) {
          selectedFilePayload = null;
          if (fileStatus) fileStatus.textContent = 'Belum ada berkas dipilih.';
          return;
        }
        if (file.size > 6 * 1024 * 1024) {
          selectedFilePayload = null;
          fileInput.value = '';
          setError('Ukuran berkas maksimal 6 MB agar dapat diproses oleh Apps Script.');
          return;
        }
        if (fileStatus) {
          fileStatus.textContent = `${file.name} (${Math.round(file.size / 1024)} KB) siap dikirim ke Gemini 2.5 Flash.`;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const resultStr = String(reader.result || '');
          const base64Content = resultStr.includes(',') ? resultStr.split(',')[1] : resultStr;
          selectedFilePayload = {
            filename: file.name,
            mimeType: file.type || 'application/octet-stream',
            base64Content,
          };
        };
        reader.readAsDataURL(file);
      });
    }

    if (localBtn) {
      localBtn.addEventListener('click', () => {
        setError('');
        const rawText = (textInput ? textInput.value : '').trim();
        if (!rawText) {
          setError('Tempel teks nilai terlebih dahulu untuk penguraian lokal.');
          if (textInput) textInput.focus();
          return;
        }
        const parsed = parseStructuredTextLocally(rawText);
        if (parsed.length === 0) {
          setError('Format teks tidak dikenali. Gunakan pola "Nama Santri, Harian, UAS, Kehadiran" per baris.');
          return;
        }
        const added = mergeImportedRows(parsed);
        UI.closeModal('modal-import-ai');
        UI.toast(`${added} baris nilai berhasil diurai dari teks ke Kalkulator Raport.`, 'success');
      });
    }

    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        setError('');
        const rawText = (textInput ? textInput.value : '').trim();

        if (!rawText && !selectedFilePayload) {
          setError('Unggah berkas PDF/foto nilai atau tempel teks daftar nilai terlebih dahulu.');
          return;
        }

        UI.setButtonLoading(submitBtn, true, 'Mengekstrak via AI...');
        try {
          const res = await API.importNilaiAI({
            rawText,
            filename: selectedFilePayload ? selectedFilePayload.filename : '',
            mimeType: selectedFilePayload ? selectedFilePayload.mimeType : '',
            base64Content: selectedFilePayload ? selectedFilePayload.base64Content : '',
            diunggah_oleh: (session && (session.nama_lengkap || session.username)) || 'Guru',
          });
          const d = res.data || res;
          const rows = Array.isArray(d.extracted)
            ? d.extracted
            : API.extractArray(res, ['extracted', 'nilai', 'raport']);
          const count = mergeImportedRows(rows);
          if (count === 0) {
            setError('Gemini AI tidak menemukan baris nilai santri yang dapat dimasukkan ke tabel.');
            return;
          }
          if (fileInput) fileInput.value = '';
          if (fileStatus) fileStatus.textContent = 'Belum ada berkas dipilih.';
          selectedFilePayload = null;
          if (textInput) textInput.value = '';
          UI.closeModal('modal-import-ai');
          UI.toast(`${count} baris nilai berhasil diekstrak AI & diisi ke tabel raport.`, 'success');
        } catch (err) {
          setError(err.message);
          UI.toast(err.message, 'error');
        } finally {
          UI.setButtonLoading(submitBtn, false);
        }
      });
    }
  }

  function mountRaport(container, opts) {
    if (!container) return;
    const scope = opts.scope || 'admin';
    const session = opts.session || {};
    initAIImportModal(session);

    if (container.dataset.mounted === 'true') {
      activeRaportScope = scope;
      const inst = raportInstances.get(scope);
      if (inst) {
        inst.renderRows();
        inst.updateSetoranBadge();
      }
      refreshNilaiSetoranLogs();
      return;
    }

    const mapelOptions = CONFIG.MAPEL_OPTIONS.map(
      (m) => `<option value="${UI.esc(m)}"></option>`
    ).join('');
    const kelasOptions = CONFIG.KELAS_OPTIONS.map(
      (k) => `<option value="${UI.esc(k)}">${UI.esc(k)}</option>`
    ).join('');

    container.innerHTML = `
      <section class="surface-card stack-gap">
        <div class="card-spotlight-layer" aria-hidden="true"></div>

        <!-- Kop Cetak PDF Khusus -->
        <div class="print-only-block">
          <div class="print-kop">
            <div>
              <h2 class="print-kop-title">${UI.esc(CONFIG.INSTITUTION_NAME)}</h2>
              <p class="print-kop-sub">Laporan Rekapitulasi Nilai Raport Santri Madrasah Diniyah Takmiliyah Awaliyah (MDTA)</p>
              <p id="${scope}-raport-print-meta" class="print-kop-sub"></p>
            </div>
            <div style="text-align:right;font-size:9pt;">
              <div>Dicetak: ${UI.esc(UI.formatDateId())}</div>
            </div>
          </div>
        </div>

        <div class="section-toolbar no-print">
          <div>
            <span class="eyebrow-label">Rekapitulasi Penilaian Akhir</span>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:2px;">
              <h2 class="heading-lg">Kalkulator Raport Terpadu</h2>
              <span id="${scope}-raport-setoran-badge" class="status-badge status-sakit">Draft</span>
            </div>
          </div>
          <div class="toolbar-actions">
            <button type="button" id="${scope}-raport-sync" class="btn btn-secondary btn-sm">
              <i data-lucide="refresh-cw" aria-hidden="true"></i>
              <span>Sinkronkan Santri &amp; Kehadiran</span>
            </button>
            <button type="button" id="${scope}-raport-ai" class="btn btn-secondary btn-sm">
              <i data-lucide="scan-text" aria-hidden="true"></i>
              <span>Asisten Impor Nilai AI</span>
            </button>
          </div>
        </div>

        <!-- Pengaturan Bobot (Default 40 / 40 / 20) -->
        <div class="sub-surface no-print">
          <div class="section-toolbar" style="margin-bottom:10px;">
            <strong style="font-size:0.9rem;">Pengaturan Bobot Penilaian (%)</strong>
            <div class="toolbar-actions">
              <span id="${scope}-raport-weight-badge" class="status-badge status-hadir mono-num">Total: 100%</span>
              <button type="button" id="${scope}-raport-weight-reset" class="btn btn-secondary btn-sm">Reset 40/40/20</button>
            </div>
          </div>
          <div class="weights-bar">
            <div class="field-group">
              <label class="field-label" for="${scope}-w-harian">Bobot Harian (%)</label>
              <input id="${scope}-w-harian" type="number" min="0" max="100" value="40" class="input-control mono-num" />
            </div>
            <div class="field-group">
              <label class="field-label" for="${scope}-w-uas">Bobot UAS (%)</label>
              <input id="${scope}-w-uas" type="number" min="0" max="100" value="40" class="input-control mono-num" />
            </div>
            <div class="field-group">
              <label class="field-label" for="${scope}-w-absensi">Bobot Kehadiran (%)</label>
              <input id="${scope}-w-absensi" type="number" min="0" max="100" value="20" class="input-control mono-num" />
            </div>
            <div class="field-group">
              <label class="field-label" for="${scope}-raport-mapel">Mata Pelajaran (Cetak/WA)</label>
              <input id="${scope}-raport-mapel" list="${scope}-raport-mapel-list" type="text" class="input-control" placeholder="Contoh: Fiqih" />
              <datalist id="${scope}-raport-mapel-list">${mapelOptions}</datalist>
            </div>
          </div>
          <div class="form-grid" style="margin-top:12px;">
            <div class="field-group">
              <label class="field-label" for="${scope}-raport-kelas-filter">Filter Kelas</label>
              <select id="${scope}-raport-kelas-filter" class="select-control">
                <option value="">Semua Kelas</option>
                ${kelasOptions}
              </select>
            </div>
            <div class="field-group">
              <label class="field-label" for="${scope}-raport-semester">Semester</label>
              <select id="${scope}-raport-semester" class="select-control">
                <option value="Ganjil">Ganjil</option>
                <option value="Genap">Genap</option>
              </select>
            </div>
            <div class="field-group">
              <label class="field-label" for="${scope}-raport-tahun">Tahun Ajaran</label>
              <input id="${scope}-raport-tahun" type="text" value="2026/2027" class="input-control" />
            </div>
          </div>
        </div>

        <!-- Toolbar Aksi Tabel -->
        <div class="section-toolbar no-print" style="margin-bottom:0;">
          <div class="toolbar-actions">
            <button type="button" id="${scope}-raport-add-row" class="btn btn-secondary">
              <i data-lucide="plus" aria-hidden="true"></i>
              <span>Tambah Baris</span>
            </button>
            <button type="button" id="${scope}-raport-copy-wa" class="btn btn-secondary">
              <i data-lucide="copy" aria-hidden="true"></i>
              <span>Salin Format WA</span>
            </button>
            <button type="button" id="${scope}-raport-print" class="btn btn-secondary">
              <i data-lucide="printer" aria-hidden="true"></i>
              <span>Cetak Laporan</span>
            </button>
          </div>
          <div class="toolbar-actions">
            <button type="button" id="${scope}-raport-save-sheets" class="btn btn-accent">
              <i data-lucide="save" aria-hidden="true"></i>
              <span>Simpan ke Database</span>
            </button>
            <button type="button" id="${scope}-raport-submit-kepsek" class="btn btn-primary">
              <i data-lucide="send" aria-hidden="true"></i>
              <span>Submit Rekap Nilai ke Kepala Madrasah</span>
            </button>
          </div>
        </div>

        <!-- Tabel Interaktif Raport -->
        <datalist id="${scope}-raport-santri-list">${buildSantriDatalistOptions()}</datalist>
        <div class="table-scroll mobile-cards-wrap">
          <table class="data-table mobile-cards-table mobile-cards-raport">
            <thead>
              <tr>
                <th style="width:48px;">No</th>
                <th>Nama Santri</th>
                <th style="width:140px;">Kelas</th>
                <th style="width:104px;">Harian</th>
                <th style="width:104px;">UAS</th>
                <th style="width:116px;">Kehadiran (%)</th>
                <th style="width:110px;">Nilai Akhir</th>
                <th style="width:165px;">Predikat</th>
                <th class="no-print" style="width:74px;">Aksi</th>
              </tr>
            </thead>
            <tbody id="${scope}-raport-tbody"></tbody>
          </table>
        </div>

        <!-- Ringkasan Statistik Kelas -->
        <div id="${scope}-raport-summary" class="summary-bar">
          <div class="summary-metrics">
            <div><span class="text-muted">Jumlah Santri:</span> <strong id="${scope}-sum-count" class="mono-num">0</strong></div>
            <div><span class="text-muted">Rata-rata Nilai:</span> <strong id="${scope}-sum-avg" class="mono-num">-</strong></div>
            <div><span class="text-muted">Tuntas (A/B/C):</span> <strong id="${scope}-sum-tuntas" class="mono-num">-</strong></div>
            <div><span class="text-muted">Perlu Bimbingan (D):</span> <strong id="${scope}-sum-bimbingan" class="mono-num">-</strong></div>
          </div>
          <span id="${scope}-raport-setoran-note" class="text-muted" style="font-size:0.8125rem;">Status: Draft (belum disetor ke Kepala Madrasah).</span>
        </div>

        <!-- Blok Tanda Tangan Cetak -->
        <div class="print-only-block">
          <div class="print-signatures">
            <div class="print-sign-box">
              <div>Mengetahui,</div>
              <div>Kepala Madrasah MDTA</div>
              <div class="print-sign-space"></div>
              <div><strong>( ____________________ )</strong></div>
            </div>
            <div class="print-sign-box">
              <div>Bojongsoang, ${UI.esc(UI.formatDateShort(new Date()))}</div>
              <div>Guru Pengampu / Wali Kelas</div>
              <div class="print-sign-space"></div>
              <div><strong>${UI.esc(session.nama_lengkap || session.username || '( ____________________ )')}</strong></div>
            </div>
          </div>
        </div>
      </section>
    `;

    container.dataset.mounted = 'true';
    activeRaportScope = scope;
    UI.refreshIcons(container);
    UI.bindSpotlights(container);

    const wHarian = document.getElementById(`${scope}-w-harian`);
    const wUas = document.getElementById(`${scope}-w-uas`);
    const wAbsensi = document.getElementById(`${scope}-w-absensi`);
    const weightBadge = document.getElementById(`${scope}-raport-weight-badge`);
    const resetWeightBtn = document.getElementById(`${scope}-raport-weight-reset`);
    const kelasFilter = document.getElementById(`${scope}-raport-kelas-filter`);
    const mapelInput = document.getElementById(`${scope}-raport-mapel`);
    const semSelect = document.getElementById(`${scope}-raport-semester`);
    const tahunInput = document.getElementById(`${scope}-raport-tahun`);
    const syncBtn = document.getElementById(`${scope}-raport-sync`);
    const aiBtn = document.getElementById(`${scope}-raport-ai`);
    const addRowBtn = document.getElementById(`${scope}-raport-add-row`);
    const copyWaBtn = document.getElementById(`${scope}-raport-copy-wa`);
    const printBtn = document.getElementById(`${scope}-raport-print`);
    const saveBtn = document.getElementById(`${scope}-raport-save-sheets`);
    const submitKepsekBtn = document.getElementById(`${scope}-raport-submit-kepsek`);
    const setoranBadge = document.getElementById(`${scope}-raport-setoran-badge`);
    const setoranNote = document.getElementById(`${scope}-raport-setoran-note`);
    const tbody = document.getElementById(`${scope}-raport-tbody`);

    function updateSetoranBadge() {
      const kelas = kelasFilter.value || 'Semua Kelas';
      const periode = `${semSelect.value} ${tahunInput.value.trim()}`;
      const matched = findNilaiSetoran(kelas, periode);
      if (setoranBadge) {
        if (matched) {
          setoranBadge.className = 'status-badge status-hadir';
          setoranBadge.textContent = 'Sudah Disetor';
        } else {
          setoranBadge.className = 'status-badge status-sakit';
          setoranBadge.textContent = 'Draft';
        }
      }
      if (setoranNote) {
        if (matched) {
          setoranNote.textContent = `Sudah disetor oleh ${matched.nama_guru} pada ${matched.tanggal} (${matched.kelas}).`;
        } else {
          setoranNote.textContent = `Status ${kelas} (${periode}): Draft (belum disetor ke Kepala Madrasah).`;
        }
      }
    }

    function syncRaportClassFilterOptions() {
      const set = new Set(CONFIG.KELAS_OPTIONS);
      (STATE.santri || []).forEach((s) => {
        if (s.kelas) set.add(s.kelas);
      });
      STATE.raportRows.forEach((r) => {
        if (r.kelas) set.add(r.kelas);
      });
      const cur = kelasFilter.value;
      kelasFilter.innerHTML =
        '<option value="">Semua Kelas</option>' +
        Array.from(set)
          .map((k) => `<option value="${UI.esc(k)}">${UI.esc(k)}</option>`)
          .join('');
      if (cur && set.has(cur)) kelasFilter.value = cur;
    }

    function getWeights() {
      const harian = Math.max(0, Number(wHarian.value) || 0);
      const uas = Math.max(0, Number(wUas.value) || 0);
      const absensi = Math.max(0, Number(wAbsensi.value) || 0);
      const total = harian + uas + absensi;
      return { harian, uas, absensi, total };
    }

    function computeRowScore(row, w) {
      const sumW = w.total > 0 ? w.total : 100;
      const raw = (Number(row.n_harian) || 0) * w.harian + (Number(row.n_uas) || 0) * w.uas + (Number(row.n_kehadiran) || 0) * w.absensi;
      return Math.round((raw / sumW) * 100) / 100;
    }

    function updateWeightUI() {
      const w = getWeights();
      weightBadge.textContent = w.total === 100 ? 'Total: 100%' : `Total: ${w.total}% (harus 100%)`;
      weightBadge.className = `status-badge mono-num ${w.total === 100 ? 'status-hadir' : 'status-sakit'}`;
      return w;
    }

    function updateSummaryAndScores() {
      const w = updateWeightUI();
      const filterK = kelasFilter.value;
      const visible = STATE.raportRows.filter((r) => (!filterK ? true : r.kelas === filterK));
      const scores = [];
      let tuntas = 0;
      let bimbingan = 0;

      visible.forEach((row) => {
        const finalScore = computeRowScore(row, w);
        scores.push(finalScore);
        const pred = getPredicate(finalScore);
        if (['A', 'B', 'C'].includes(pred.code)) tuntas++;
        else bimbingan++;

        const scoreCell = tbody.querySelector(`[data-score-for="${row.uid}"]`);
        const predCell = tbody.querySelector(`[data-pred-for="${row.uid}"]`);
        if (scoreCell) scoreCell.textContent = finalScore.toFixed(2);
        if (predCell) {
          predCell.textContent = `${pred.code} (${pred.label})`;
          predCell.className = `status-badge ${pred.cls} mono-num`;
        }
      });

      document.getElementById(`${scope}-sum-count`).textContent = String(visible.length);
      if (scores.length > 0) {
        const avg = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100;
        document.getElementById(`${scope}-sum-avg`).textContent = avg.toFixed(2);
        document.getElementById(`${scope}-sum-tuntas`).textContent = String(tuntas);
        document.getElementById(`${scope}-sum-bimbingan`).textContent = String(bimbingan);
        return { count: visible.length, avg, tuntas, bimbingan };
      } else {
        document.getElementById(`${scope}-sum-avg`).textContent = '-';
        document.getElementById(`${scope}-sum-tuntas`).textContent = '-';
        document.getElementById(`${scope}-sum-bimbingan`).textContent = '-';
        return { count: 0, avg: 0, tuntas: 0, bimbingan: 0 };
      }
    }

    function renderRows() {
      const dl = document.getElementById(`${scope}-raport-santri-list`);
      if (dl) dl.innerHTML = buildSantriDatalistOptions();
      syncRaportClassFilterOptions();

      const w = updateWeightUI();
      const filterK = kelasFilter.value;
      const visible = STATE.raportRows.filter((r) => (!filterK ? true : r.kelas === filterK));

      if (visible.length === 0) {
        tbody.innerHTML = `
          <tr class="table-state-row">
            <td colspan="9">
              ${UI.renderStateBox({
                type: 'empty',
                title: 'Belum ada baris nilai santri',
                message: 'Klik "Sinkronkan Santri & Kehadiran", "Tambah Baris", atau gunakan "Asisten Impor Nilai AI".',
              })}
            </td>
          </tr>
        `;
        UI.refreshIcons(tbody);
        updateSummaryAndScores();
        return;
      }

      tbody.innerHTML = visible
        .map((row, idx) => {
          const finalScore = computeRowScore(row, w);
          const pred = getPredicate(finalScore);
          return `
            <tr data-row-uid="${UI.esc(row.uid)}">
              <td class="mono-num rc-no" data-label="No">${idx + 1}</td>
              <td class="rc-nama" data-label="Nama Santri">
                <input type="text" list="${scope}-raport-santri-list" class="table-input table-input-name" data-field="nama_santri" value="${UI.esc(row.nama_santri)}" aria-label="Nama santri baris ${idx + 1}" placeholder="Nama santri" />
              </td>
              <td class="rc-kelas" data-label="Kelas">
                <input type="text" class="table-input" data-field="kelas" value="${UI.esc(row.kelas)}" aria-label="Kelas baris ${idx + 1}" placeholder="Kelas" />
              </td>
              <td class="rc-harian" data-label="N. Harian">
                <input type="number" min="0" max="100" step="0.1" class="table-input table-input-num" data-field="n_harian" value="${UI.esc(row.n_harian)}" aria-label="Nilai harian ${UI.esc(row.nama_santri || `baris ${idx + 1}`)}" />
              </td>
              <td class="rc-uas" data-label="N. UAS">
                <input type="number" min="0" max="100" step="0.1" class="table-input table-input-num" data-field="n_uas" value="${UI.esc(row.n_uas)}" aria-label="Nilai UAS ${UI.esc(row.nama_santri || `baris ${idx + 1}`)}" />
              </td>
              <td class="rc-hadir" data-label="Kehadiran (%)">
                <input type="number" min="0" max="100" step="0.1" class="table-input table-input-num" data-field="n_kehadiran" value="${UI.esc(row.n_kehadiran)}" aria-label="Persentase kehadiran ${UI.esc(row.nama_santri || `baris ${idx + 1}`)}" />
              </td>
              <td class="mono-num rc-akhir" style="font-weight:700;" data-label="Nilai Akhir" data-score-for="${UI.esc(row.uid)}">${finalScore.toFixed(2)}</td>
              <td class="rc-pred" data-label="Predikat"><span class="status-badge ${pred.cls} mono-num" data-pred-for="${UI.esc(row.uid)}">${pred.code} (${pred.label})</span></td>
              <td class="no-print rc-del" data-label="Hapus">
                <button type="button" class="btn btn-danger btn-icon-sm" data-delete-uid="${UI.esc(row.uid)}" aria-label="Hapus baris ${UI.esc(row.nama_santri || `nomor ${idx + 1}`)}">
                  <i data-lucide="trash-2" aria-hidden="true"></i>
                </button>
              </td>
            </tr>
          `;
        })
        .join('');

      tbody.querySelectorAll('input[data-field]').forEach((inp) => {
        inp.addEventListener('input', () => {
          const tr = inp.closest('tr');
          const uid = tr ? tr.dataset.rowUid : '';
          const targetRow = STATE.raportRows.find((r) => r.uid === uid);
          if (!targetRow) return;
          const field = inp.dataset.field;
          if (field === 'nama_santri') {
            targetRow.nama_santri = inp.value;
            const match = (STATE.santri || []).find(
              (s) => s.nama_lengkap.toLowerCase() === inp.value.trim().toLowerCase()
            );
            if (match) {
              targetRow.id_santri = match.id_santri;
              if (!targetRow.kelas && match.kelas) {
                targetRow.kelas = match.kelas;
                const kInp = tr.querySelector('input[data-field="kelas"]');
                if (kInp) kInp.value = match.kelas;
              }
            }
          } else if (field === 'kelas') {
            targetRow.kelas = inp.value;
          } else {
            targetRow[field] = clampNum(inp.value, 0, 100);
          }
          updateSummaryAndScores();
        });
      });

      tbody.querySelectorAll('button[data-delete-uid]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const uid = btn.dataset.deleteUid;
          STATE.raportRows = STATE.raportRows.filter((r) => r.uid !== uid);
          renderRows();
        });
      });

      UI.refreshIcons(tbody);
      updateSummaryAndScores();
      updateSetoranBadge();
    }

    async function syncSantriAndKehadiran(silent) {
      UI.setButtonLoading(syncBtn, true, 'Menyinkronkan...');
      try {
        const now = new Date();
        const santriRes = await API.getSantri();
        const santriList = API.extractArray(santriRes, ['santri']).map(API.normalizeSantri);
        STATE.santri = santriList;

        let rekapMap = new Map();
        try {
          const rekapRes = await API.getRekapLaporan(now.getMonth() + 1, now.getFullYear());
          const rekapList = API.extractArray(rekapRes, ['rekap']).map(API.normalizeRekap);
          rekapList.forEach((rk) => {
            if (rk.total > 0) {
              if (rk.id_santri) rekapMap.set(rk.id_santri, rk.persentase);
              rekapMap.set(rk.nama_lengkap.trim().toLowerCase(), rk.persentase);
            }
          });
        } catch (err) {
          // Gunakan nilai raport tersimpan bila rekap bulan belum tersedia
        }

        let savedRaportList = [];
        try {
          const rptRes = await API.getNilaiRaport();
          savedRaportList = API.extractArray(rptRes, ['raport']).map(API.normalizeNilaiRaport);
        } catch (err) {
          savedRaportList = [];
        }

        const savedBySantri = new Map();
        savedRaportList.forEach((sr) => {
          if (sr.id_santri) savedBySantri.set(sr.id_santri, sr);
          savedBySantri.set(sr.nama_santri.trim().toLowerCase(), sr);
        });

        await refreshNilaiSetoranLogs();

        if (santriList.length === 0 && savedRaportList.length === 0) {
          if (!silent) UI.toast('Database santri dan raport saat ini kosong.', 'warn');
          renderRows();
          return;
        }

        santriList.forEach((s) => {
          if (!s.nama_lengkap) return;
          const pct = rekapMap.get(s.id_santri) ?? rekapMap.get(s.nama_lengkap.trim().toLowerCase());
          const saved = savedBySantri.get(s.id_santri) ?? savedBySantri.get(s.nama_lengkap.trim().toLowerCase());
          const existing = STATE.raportRows.find(
            (r) =>
              (r.id_santri && r.id_santri === s.id_santri) ||
              r.nama_santri.trim().toLowerCase() === s.nama_lengkap.trim().toLowerCase()
          );

          if (existing) {
            existing.id_santri = s.id_santri;
            existing.kelas = s.kelas || existing.kelas;
            if (saved) {
              existing.id_raport = saved.id_raport || existing.id_raport;
              if (!existing.n_harian) existing.n_harian = saved.n_harian;
              if (!existing.n_uas) existing.n_uas = saved.n_uas;
            }
            if (pct !== undefined) existing.n_kehadiran = pct;
            else if (saved && saved.n_kehadiran !== undefined) existing.n_kehadiran = saved.n_kehadiran;
          } else {
            STATE.raportRows.push({
              uid: `row-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              id_raport: saved ? saved.id_raport : '',
              id_santri: s.id_santri,
              nama_santri: s.nama_lengkap,
              kelas: s.kelas,
              n_harian: saved ? saved.n_harian : 0,
              n_uas: saved ? saved.n_uas : 0,
              n_kehadiran: pct !== undefined ? pct : saved ? saved.n_kehadiran : 100,
            });
          }
        });

        renderRows();
        if (!silent) {
          UI.toast(`${santriList.length} santri, data nilai, dan persentase kehadiran berhasil disinkronkan.`, 'success');
        }
      } catch (err) {
        if (!silent) UI.toast(err.message, 'error');
      } finally {
        UI.setButtonLoading(syncBtn, false);
      }
    }

    async function saveRaportToSheets() {
      const w = getWeights();
      if (w.total !== 100) {
        UI.toast(`Total bobot saat ini ${w.total}%. Ubah hingga tepat 100% sebelum menyimpan.`, 'error');
        return null;
      }
      const filterK = kelasFilter.value;
      const validRows = STATE.raportRows.filter((r) => (!filterK ? true : r.kelas === filterK) && r.nama_santri.trim());
      if (validRows.length === 0) {
        UI.toast('Minimal satu baris nama santri harus diisi sebelum menyimpan.', 'warn');
        return null;
      }

      const periode = `${semSelect.value} ${tahunInput.value.trim()}`;
      const itemsArray = validRows.map((r) => {
        const finalScore = computeRowScore(r, w);
        const pred = getPredicate(finalScore);
        return {
          id_raport: r.id_raport || '',
          id_santri: r.id_santri || '',
          nama_santri: r.nama_santri.trim(),
          kelas: r.kelas.trim(),
          periode,
          n_harian: Number(r.n_harian) || 0,
          n_uas: Number(r.n_uas) || 0,
          n_kehadiran: Number(r.n_kehadiran) || 0,
          bobot_harian: w.harian,
          bobot_uas: w.uas,
          bobot_kehadiran: w.absensi,
          n_akhir: finalScore,
          grade: pred.code,
          keterangan: pred.label,
        };
      });

      const res = await API.saveNilaiRaport(itemsArray);
      const d = res.data || res;
      return { count: d.savedCount || itemsArray.length, periode, filterK: filterK || 'Semua Kelas' };
    }

    [wHarian, wUas, wAbsensi].forEach((inp) => {
      inp.addEventListener('input', updateSummaryAndScores);
    });

    resetWeightBtn.addEventListener('click', () => {
      wHarian.value = String(CONFIG.DEFAULT_RAPORT_WEIGHTS.harian);
      wUas.value = String(CONFIG.DEFAULT_RAPORT_WEIGHTS.uas);
      wAbsensi.value = String(CONFIG.DEFAULT_RAPORT_WEIGHTS.absensi);
      updateSummaryAndScores();
      UI.toast('Bobot penilaian dikembalikan ke 40% Harian, 40% UAS, 20% Kehadiran.', 'info');
    });

    kelasFilter.addEventListener('change', () => {
      renderRows();
      updateSetoranBadge();
    });
    [semSelect, tahunInput].forEach((el) => el.addEventListener('change', updateSetoranBadge));

    syncBtn.addEventListener('click', () => syncSantriAndKehadiran(false));

    addRowBtn.addEventListener('click', () => {
      STATE.raportRows.push({
        uid: `row-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        id_raport: '',
        id_santri: '',
        nama_santri: '',
        kelas: kelasFilter.value || '',
        n_harian: 0,
        n_uas: 0,
        n_kehadiran: 100,
      });
      renderRows();
      const inputs = tbody.querySelectorAll('input[data-field="nama_santri"]');
      const last = inputs[inputs.length - 1];
      if (last) last.focus();
    });

    aiBtn.addEventListener('click', () => {
      activeRaportScope = scope;
      UI.openModal('modal-import-ai');
    });

    copyWaBtn.addEventListener('click', async () => {
      const w = getWeights();
      const filterK = kelasFilter.value;
      const visible = STATE.raportRows.filter((r) => (!filterK ? true : r.kelas === filterK) && r.nama_santri.trim());
      if (visible.length === 0) {
        UI.toast('Tidak ada baris santri bernilai untuk disalin.', 'warn');
        return;
      }

      const mapel = mapelInput.value.trim() || 'Penilaian MDTA';
      const lines = [
        `*REKAP NILAI RAPORT MDTA ASY SYIFA AL MUSRI'*`,
        `Mapel: ${mapel} | Kelas: ${filterK || 'Semua'} | ${semSelect.value} ${tahunInput.value.trim()}`,
        `Bobot: Harian ${w.harian}% / UAS ${w.uas}% / Kehadiran ${w.absensi}%`,
        '----------------------------------------',
      ];
      visible.forEach((r, idx) => {
        const finalScore = computeRowScore(r, w);
        const pred = getPredicate(finalScore);
        lines.push(`${idx + 1}. ${r.nama_santri} (${r.kelas || '-'}) = *${finalScore.toFixed(2)}* [${pred.code}] (H:${r.n_harian}, U:${r.n_uas}, K:${r.n_kehadiran}%)`);
      });

      try {
        await navigator.clipboard.writeText(lines.join('\n'));
        UI.toast('Format laporan WhatsApp berhasil disalin ke clipboard.', 'success');
      } catch (err) {
        UI.toast('Gagal menyalin otomatis. Izinkan akses clipboard pada browser Anda.', 'error');
      }
    });

    printBtn.addEventListener('click', () => {
      const panel = container.closest('.tab-panel');
      const metaEl = document.getElementById(`${scope}-raport-print-meta`);
      if (metaEl) {
        metaEl.textContent = `Mapel: ${mapelInput.value.trim() || '-'} · Kelas: ${kelasFilter.value || 'Semua Kelas'} · Semester ${semSelect.value} ${tahunInput.value.trim()}`;
      }
      if (panel) panel.classList.add('is-raport-print-target');
      document.body.classList.add('printing-raport');
      window.print();
      setTimeout(() => {
        document.body.classList.remove('printing-raport');
        if (panel) panel.classList.remove('is-raport-print-target');
      }, 300);
    });

    saveBtn.addEventListener('click', async () => {
      UI.setButtonLoading(saveBtn, true, 'Menyimpan...');
      try {
        const res = await saveRaportToSheets();
        if (res) {
          UI.toast(`${res.count} baris nilai raport berhasil disimpan ke database.`, 'success');
        }
      } catch (err) {
        UI.toast(err.message, 'error');
      } finally {
        UI.setButtonLoading(saveBtn, false);
      }
    });

    if (submitKepsekBtn) {
      submitKepsekBtn.addEventListener('click', async () => {
        UI.setButtonLoading(submitKepsekBtn, true, 'Menyetor ke Kepala Madrasah...');
        try {
          const saved = await saveRaportToSheets();
          if (!saved) return;

          const stats = updateSummaryAndScores();
          const logRes = await API.submitLaporanGuru({
            tanggal: UI.todayISO(),
            jenis_laporan: 'Nilai Raport',
            kelas: saved.filterK,
            periode: saved.periode,
            id_guru: session.id_user || '',
            nama_guru: session.nama_lengkap || session.username || 'Guru',
            ringkasan: `${stats.count} santri, Rata-rata ${stats.avg.toFixed(2)}, Tuntas ${stats.tuntas}, Perlu Bimbingan ${stats.bimbingan}`,
          });
          nilaiSetoranLogs.unshift(API.normalizeLogSetoran(logRes.data || logRes));
          updateSetoranBadge();
          UI.toast(`Rekap Nilai ${saved.filterK} (${saved.periode}) berhasil disetor ke Kepala Madrasah.`, 'success');
        } catch (err) {
          UI.toast(err.message, 'error');
        } finally {
          UI.setButtonLoading(submitKepsekBtn, false);
        }
      });
    }

    raportInstances.set(scope, { renderRows, getWeights, updateSetoranBadge });
    renderRows();
    refreshNilaiSetoranLogs();

    if (STATE.raportRows.length === 0) {
      syncSantriAndKehadiran(true);
    }
  }

  root.MDTA_CALC = {
    mountUAS,
    mountRaport,
    getPredicate,
  };
})(window);
