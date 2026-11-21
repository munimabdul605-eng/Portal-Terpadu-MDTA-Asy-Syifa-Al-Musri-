/**
 * Portal Guru (3 Tab) - Terhubung ke Code.gs & Database Sistem MDTA
 * Header Banner "GURU PIKET" dengan nama guru yang login.
 * 1. Tab Presensi: Halaman utama Scan QR + Daftar Presensi Hari Ini,
 *    dengan tombol/toggle ke halaman khusus Absensi Manual (Daftar Kelas).
 * 2. Tab Kalkulator UAS (berbagi modul MDTA_CALC, otomatis tampil di Beranda Laporan).
 * 3. Tab Kalkulator Raport (berbagi modul MDTA_CALC, otomatis tampil di Beranda Laporan).
 */
(function (root) {
  'use strict';

  const CONFIG = root.MDTA_CONFIG;
  const STATE = root.MDTA_STATE;
  const API = root.MDTA_API;
  const UI = root.MDTA_UI;

  let initialized = false;
  let guruSession = null;
  let lastGuruKey = '';
  let tabController = null;

  let qrScannerInstance = null;
  let scannerRunning = false;
  let lastScanToken = '';
  let lastScanTime = 0;

  let presensiMode = 'qr';
  let activeDateWib = UI.todayISO();
  const manualDraftMap = new Map();
  const sessionPresensiLogs = [];
  let serverTodayPresensi = [];

  let guruSyncTimer = null;
  let guruSyncActive = false;
  let guruSyncUnsupported = false;
  let guruSyncCheckInFlight = false;
  let guruSyncRefreshInFlight = false;
  let guruSyncVisibilityBound = false;
  let localGuruSyncTs = null;

  function recordGuruSyncTs(tsVal) {
    if (tsVal === null || tsVal === undefined || tsVal === '') return;
    const nextStr = String(tsVal);
    localGuruSyncTs = nextStr;
    STATE.localSyncTs = nextStr;
  }

  function invalidateAdminReportCache() {
    STATE.rekapKepsek = null;
    STATE.rekapKepsekKey = '';
    STATE.loaded.bootstrap = false;
    if (root.MDTA_CACHE) {
      root.MDTA_CACHE.remove('rekapKepsek');
      root.MDTA_CACHE.remove('dashboard');
    }
  }

  function getGuruKelasAmpu() {
    return API.parseKelasAmpu(guruSession && guruSession.kelas_ampu);
  }

  function normKelasKey(val) {
    return String(val || '').trim().toLowerCase();
  }

  function getSantriUniqueKey(s) {
    const id = String((s && s.id_santri) || '').trim();
    if (id) return `ID:${id}`;
    return `N:${String((s && (s.nama_lengkap || s.nama_santri)) || '').trim().toLowerCase()}`;
  }

  function statusBadgeClass(status) {
    const s = String(status || '').toLowerCase();
    if (s.includes('hadir')) return 'status-hadir';
    if (s.includes('sakit')) return 'status-sakit';
    if (s.includes('izin')) return 'status-izin';
    return 'status-alpa';
  }

  function checkGuruDayRollover(opts) {
    const todayWib = UI.todayISO();
    if (todayWib === activeDateWib) return false;

    activeDateWib = todayWib;
    sessionPresensiLogs.length = 0;
    serverTodayPresensi = [];
    STATE.presensiToday = [];
    manualDraftMap.clear();
    if (root.MDTA_CACHE) root.MDTA_CACHE.remove('presensiToday');

    const tglInp = document.getElementById('manual-presensi-tanggal');
    if (tglInp) tglInp.value = todayWib;

    renderSessionLogs();
    if (presensiMode === 'manual') {
      renderManualRoster();
    }

    if (opts && opts.triggerFetch) {
      loadGuruBootstrapSWR(true, { silentSync: true });
    }
    return true;
  }

  function updateBanner(session) {
    const sess = session || guruSession || {};
    const nameEl = document.getElementById('guru-piket-name');
    const dateEl = document.getElementById('guru-piket-date');
    const countEl = document.getElementById('guru-piket-count');
    const ampuBadge = document.getElementById('guru-kelas-ampu-badge');
    const ampuText = document.getElementById('guru-kelas-ampu-text');
    const unmappedAlert = document.getElementById('guru-unmapped-alert');
    const unmappedMsg = document.getElementById('guru-unmapped-alert-msg');

    if (nameEl) nameEl.textContent = sess.nama_lengkap || sess.nama || sess.username || 'Guru Piket';
    if (dateEl) dateEl.textContent = UI.formatDateId();
    const combinedCount = getCombinedTodayPresensi().length;
    if (countEl) countEl.textContent = `${combinedCount} presensi tercatat hari ini`;

    const kelasAmpu = API.parseKelasAmpu(sess.kelas_ampu);
    if (ampuBadge && ampuText) {
      if (kelasAmpu.length > 0) {
        ampuBadge.className = 'status-badge status-izin';
        ampuText.textContent = `Pengampu: ${kelasAmpu.join(', ')}`;
      } else {
        ampuBadge.className = 'status-badge status-sakit';
        ampuText.textContent = 'Belum dipetakan ke kelas';
      }
    }
    if (unmappedAlert && unmappedMsg) {
      if (kelasAmpu.length === 0) {
        unmappedMsg.textContent =
          'Akun Anda belum dipetakan ke kelas mana pun. Hubungi Kepala Madrasah / Admin untuk menetapkan kelas ampu Anda.';
        unmappedAlert.hidden = false;
      } else {
        unmappedAlert.hidden = true;
      }
    }
  }

  function buildPresensiDedupKey(item) {
    if (!item) return '';
    const sid = String(item.id_santri || '').trim();
    if (sid) return `SID:${sid}`;
    const nama = String(item.nama_santri || '').trim().toLowerCase();
    const kls = normKelasKey(item.kelas);
    if (nama) return `NM:${nama}||${kls}`;
    return item.id_presensi ? `PID:${item.id_presensi}` : '';
  }

  function upsertSessionPresensiLog(entry) {
    const entryKey = buildPresensiDedupKey(entry);
    const idx = sessionPresensiLogs.findIndex((existing) => {
      if (entry.id_presensi && existing.id_presensi && existing.id_presensi === entry.id_presensi) return true;
      if (entryKey && buildPresensiDedupKey(existing) === entryKey) return true;
      return false;
    });
    if (idx >= 0) {
      sessionPresensiLogs.splice(idx, 1);
    }
    sessionPresensiLogs.unshift(entry);
  }

  function getCombinedTodayPresensi() {
    const todayWib = UI.todayISO();
    const seenKeys = new Set();
    const seenIds = new Set();
    const merged = [];

    const acceptItem = (item) => {
      if (!item) return;
      const itemDate = API.normalizeISODate(item.tanggal);
      if (itemDate && itemDate !== todayWib) return;
      const pid = String(item.id_presensi || '').trim();
      const dKey = buildPresensiDedupKey(item);
      if (pid && seenIds.has(pid)) return;
      if (dKey && seenKeys.has(dKey)) return;
      if (pid) seenIds.add(pid);
      if (dKey) seenKeys.add(dKey);
      merged.push(item);
    };

    sessionPresensiLogs.forEach(acceptItem);
    serverTodayPresensi.forEach(acceptItem);

    return merged;
  }

  function populateManualKelasSelect() {
    const sel = document.getElementById('manual-santri-kelas');
    if (!sel) return;
    const prev = sel.value;
    const kelasAmpu = getGuruKelasAmpu();
    if (kelasAmpu.length === 0) {
      sel.innerHTML = '<option value="">Belum ada kelas ampu</option>';
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    sel.innerHTML = kelasAmpu
      .map((k) => `<option value="${UI.esc(k)}">${UI.esc(k)}</option>`)
      .join('');
    if (prev && kelasAmpu.some((k) => normKelasKey(k) === normKelasKey(prev))) {
      const exact = kelasAmpu.find((k) => normKelasKey(k) === normKelasKey(prev));
      if (exact) sel.value = exact;
    } else {
      sel.value = kelasAmpu[0];
    }
  }

  function updateAbsensiCountsUI() {
    const list = getCombinedTodayPresensi();
    const counts = { Hadir: 0, Sakit: 0, Izin: 0, Alpa: 0 };
    list.forEach((item) => {
      const st = String(item.status || 'Hadir');
      if (Object.prototype.hasOwnProperty.call(counts, st)) counts[st]++;
    });

    const elH = document.getElementById('guru-sum-hadir');
    const elS = document.getElementById('guru-sum-sakit');
    const elI = document.getElementById('guru-sum-izin');
    const elA = document.getElementById('guru-sum-alpa');
    if (elH) elH.textContent = String(counts.Hadir);
    if (elS) elS.textContent = String(counts.Sakit);
    if (elI) elI.textContent = String(counts.Izin);
    if (elA) elA.textContent = String(counts.Alpa);

    return counts;
  }

  function renderSessionLogs() {
    const tbody = document.getElementById('guru-session-log-tbody');
    updateBanner(guruSession || {});
    updateAbsensiCountsUI();
    if (!tbody) return;

    const combined = getCombinedTodayPresensi();
    if (combined.length === 0) {
      tbody.innerHTML = `
        <tr class="table-state-row">
          <td colspan="5">
            ${UI.renderStateBox({
              type: 'empty',
              title: 'Belum ada presensi dicatat hari ini',
              message:
                getGuruKelasAmpu().length === 0
                  ? 'Akun Anda belum dipetakan ke kelas mana pun. Hubungi Admin.'
                  : 'Pindai kartu QR santri atau klik "Buka Presensi Manual (Daftar Kelas)" untuk mengabsen satu kelas sekaligus.',
            })}
          </td>
        </tr>
      `;
      UI.refreshIcons(tbody);
      return;
    }

    tbody.innerHTML = combined
      .map(
        (item) => `
        <tr>
          <td class="mono-num" data-label="Waktu">${UI.esc(item.waktu || '-')}</td>
          <td class="mc-primary" data-label="Nama Santri"><strong>${UI.esc(item.nama_santri)}</strong></td>
          <td data-label="Kelas">${UI.esc(item.kelas || '-')}</td>
          <td class="mc-status" data-label="Status"><span class="status-badge ${statusBadgeClass(item.status)}">${UI.esc(item.status)}</span></td>
          <td data-label="Metode &amp; Catatan">${UI.esc(item.metode)}${item.catatan ? ` · ${UI.esc(item.catatan)}` : ''}</td>
        </tr>
      `
      )
      .join('');
  }

  function updateGuruSyncStatusBanner() {
    const kelasAmpu = getGuruKelasAmpu();
    const activeCount = (STATE.santri || []).filter(
      (s) => API.isActiveSantri(s) && API.isKelasAllowed(s.kelas, kelasAmpu)
    ).length;
    const statusEl = document.getElementById('guru-santri-sync-status');
    if (!statusEl) return;

    if (kelasAmpu.length === 0) {
      statusEl.textContent = 'Akun Anda belum dipetakan ke kelas mana pun.';
    } else if (activeCount > 0) {
      statusEl.textContent = `${activeCount} santri aktif pada kelas ${kelasAmpu.join(', ')} siap diabsen.`;
    } else {
      statusEl.textContent = `Belum ada santri aktif pada kelas ${kelasAmpu.join(', ')}.`;
    }
  }

  function getActiveMappedSantriForClass(selectedKelas) {
    const kelasAmpu = getGuruKelasAmpu();
    if (kelasAmpu.length === 0) return [];
    const targetKey = normKelasKey(selectedKelas);
    return (STATE.santri || [])
      .filter((s) => {
        if (!API.isActiveSantri(s)) return false;
        if (!API.isKelasAllowed(s.kelas, kelasAmpu)) return false;
        if (targetKey && normKelasKey(s.kelas) !== targetKey) return false;
        return true;
      })
      .sort((a, b) => String(a.nama_lengkap || '').localeCompare(String(b.nama_lengkap || ''), 'id'));
  }

  function resolveManualRowState(santri, tanggal, todayRecordedMap) {
    const sKey = getSantriUniqueKey(santri);
    const dKey = `${tanggal}|${sKey}`;
    const draft = manualDraftMap.get(dKey);
    const recorded =
      todayRecordedMap.get(String(santri.id_santri || '').trim()) ||
      todayRecordedMap.get(String(santri.nama_lengkap || '').trim().toLowerCase()) ||
      null;

    if (draft) {
      return {
        sKey,
        dKey,
        status: draft.status || '',
        catatan: draft.catatan || '',
        recordedToday: Boolean(recorded),
      };
    }

    if (recorded) {
      return {
        sKey,
        dKey,
        status: String(recorded.status || 'Hadir').trim() || 'Hadir',
        catatan: String(recorded.catatan || '').trim(),
        recordedToday: true,
      };
    }

    return { sKey, dKey, status: '', catatan: '', recordedToday: false };
  }

  function updateManualRosterSummary(roster, tanggal, todayRecordedMap) {
    const sumEl = document.getElementById('manual-roster-summary');
    if (!sumEl) return;
    if (!Array.isArray(roster) || roster.length === 0) {
      sumEl.textContent = '0 santri aktif';
      return;
    }

    const counts = { Hadir: 0, Izin: 0, Sakit: 0, Alpa: 0 };
    let selectedTotal = 0;
    roster.forEach((s) => {
      const st = resolveManualRowState(s, tanggal, todayRecordedMap).status;
      if (Object.prototype.hasOwnProperty.call(counts, st)) {
        counts[st]++;
        selectedTotal++;
      }
    });

    sumEl.textContent = `${roster.length} santri aktif · Terpilih ${selectedTotal}/${roster.length} (H:${counts.Hadir} I:${counts.Izin} S:${counts.Sakit} A:${counts.Alpa})`;
  }

  function renderManualRoster() {
    const listEl = document.getElementById('guru-manual-roster-list');
    const kelasSel = document.getElementById('manual-santri-kelas');
    const tglInp = document.getElementById('manual-presensi-tanggal');
    const markAllBtn = document.getElementById('btn-manual-mark-all-hadir');
    const submitBtn = document.getElementById('btn-submit-presensi-manual');

    if (tglInp && !tglInp.value) {
      tglInp.value = UI.todayISO();
    }
    const targetTanggal = (tglInp && tglInp.value) || UI.todayISO();
    const selectedKelas = (kelasSel && kelasSel.value) || '';
    const kelasAmpu = getGuruKelasAmpu();

    const todayWib = UI.todayISO();
    const todayRecordedMap = new Map();
    if (targetTanggal === todayWib) {
      getCombinedTodayPresensi().forEach((item) => {
        if (selectedKelas && normKelasKey(item.kelas) !== normKelasKey(selectedKelas)) return;
        const sid = String(item.id_santri || '').trim();
        const sname = String(item.nama_santri || '').trim().toLowerCase();
        if (sid && !todayRecordedMap.has(sid)) todayRecordedMap.set(sid, item);
        if (sname && !todayRecordedMap.has(sname)) todayRecordedMap.set(sname, item);
      });
    }

    const roster = getActiveMappedSantriForClass(selectedKelas);
    updateManualRosterSummary(roster, targetTanggal, todayRecordedMap);

    if (!listEl) return;

    if (kelasAmpu.length === 0 || roster.length === 0) {
      if (markAllBtn) markAllBtn.disabled = true;
      if (submitBtn) submitBtn.disabled = true;
      listEl.innerHTML = UI.renderStateBox({
        type: 'empty',
        title: kelasAmpu.length === 0 ? 'Belum ada kelas ampu' : 'Belum ada santri aktif di kelas ini',
        message:
          kelasAmpu.length === 0
            ? 'Hubungi Kepala Madrasah / Admin untuk memetakan kelas ampu Anda.'
            : `Belum ditemukan santri berstatus Aktif untuk ${selectedKelas || 'kelas terpilih'}.`,
      });
      UI.refreshIcons(listEl);
      return;
    }

    if (markAllBtn) markAllBtn.disabled = false;
    if (submitBtn) submitBtn.disabled = false;

    const statusChoices = ['Hadir', 'Izin', 'Sakit', 'Alpa'];

    listEl.innerHTML = roster
      .map((s, idx) => {
        const stState = resolveManualRowState(s, targetTanggal, todayRecordedMap);
        const curStatus = stState.status;
        const isNonHadir = Boolean(curStatus && curStatus !== 'Hadir');
        const subParts = [];
        if (s.kelas) subParts.push(s.kelas);
        if (s.id_santri) subParts.push(s.id_santri);

        const togglesHtml = statusChoices
          .map((choice) => {
            const pressed = curStatus === choice;
            return `<button type="button" class="manual-status-btn" data-status-val="${UI.esc(choice)}" data-manual-toggle="${UI.esc(stState.sKey)}" aria-pressed="${pressed ? 'true' : 'false'}">${UI.esc(choice)}</button>`;
          })
          .join('');

        return `
          <article class="manual-roster-card" data-manual-card="${UI.esc(stState.sKey)}">
            <div class="manual-roster-head">
              <div class="manual-roster-info">
                <span class="manual-roster-num mono-num">${idx + 1}.</span>
                <div style="min-width:0;flex:1;">
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <strong class="manual-roster-name">${UI.esc(s.nama_lengkap)}</strong>
                    ${
                      stState.recordedToday
                        ? '<span class="status-badge status-hadir">Tercatat</span>'
                        : ''
                    }
                  </div>
                  <div class="text-muted" style="font-size:0.78rem;">${UI.esc(subParts.join(' · ') || '-')}</div>
                </div>
              </div>
              <div class="manual-status-toggles" role="group" aria-label="Status kehadiran ${UI.esc(s.nama_lengkap)}">
                ${togglesHtml}
              </div>
            </div>
            <div class="manual-ket-wrap" data-manual-ket-wrap="${UI.esc(stState.sKey)}"${isNonHadir ? '' : ' hidden'}>
              <label class="field-label" for="ket-${UI.esc(stState.sKey)}" style="font-size:0.76rem;">Keterangan (${UI.esc(curStatus || 'Ketidakhadiran')})</label>
              <input
                id="ket-${UI.esc(stState.sKey)}"
                type="text"
                class="input-control manual-ket-input"
                data-manual-ket="${UI.esc(stState.sKey)}"
                value="${UI.esc(stState.catatan)}"
                placeholder="Contoh: Surat izin orang tua atau demam"
              />
            </div>
          </article>
        `;
      })
      .join('');

    listEl.querySelectorAll('button[data-manual-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sKey = btn.dataset.manualToggle || '';
        const nextStatus = btn.dataset.statusVal || 'Hadir';
        const santri = roster.find((item) => getSantriUniqueKey(item) === sKey);
        if (!santri) return;

        const dKey = `${targetTanggal}|${sKey}`;
        const prevState = resolveManualRowState(santri, targetTanggal, todayRecordedMap);
        const nextCatatan = nextStatus === 'Hadir' ? '' : prevState.catatan;
        manualDraftMap.set(dKey, { status: nextStatus, catatan: nextCatatan });

        const card = btn.closest('.manual-roster-card');
        if (card) {
          card.querySelectorAll('button[data-manual-toggle]').forEach((b) => {
            b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
          });
          const ketWrap = card.querySelector('.manual-ket-wrap');
          const ketLabel = ketWrap ? ketWrap.querySelector('label') : null;
          const ketInp = ketWrap ? ketWrap.querySelector('.manual-ket-input') : null;
          const needKet = nextStatus !== 'Hadir';
          if (ketWrap) ketWrap.hidden = !needKet;
          if (ketLabel) ketLabel.textContent = `Keterangan (${nextStatus})`;
          if (needKet && ketInp && typeof ketInp.focus === 'function') {
            ketInp.focus();
          }
        }
        updateManualRosterSummary(roster, targetTanggal, todayRecordedMap);
      });
    });

    listEl.querySelectorAll('input[data-manual-ket]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const sKey = inp.dataset.manualKet || '';
        const santri = roster.find((item) => getSantriUniqueKey(item) === sKey);
        if (!santri) return;
        const dKey = `${targetTanggal}|${sKey}`;
        const prevState = resolveManualRowState(santri, targetTanggal, todayRecordedMap);
        manualDraftMap.set(dKey, {
          status: prevState.status || 'Izin',
          catatan: inp.value,
        });
      });
    });

    UI.refreshIcons(listEl);
  }

  function setPresensiMode(mode) {
    presensiMode = mode === 'manual' ? 'manual' : 'qr';
    const isManual = presensiMode === 'manual';

    const qrView = document.getElementById('guru-presensi-qr-view');
    const manualView = document.getElementById('guru-presensi-manual-view');
    const qrBtn = document.getElementById('btn-guru-mode-qr');
    const manualBtn = document.getElementById('btn-guru-mode-manual');

    if (qrView) qrView.hidden = isManual;
    if (manualView) manualView.hidden = !isManual;
    if (qrBtn) qrBtn.setAttribute('aria-pressed', isManual ? 'false' : 'true');
    if (manualBtn) manualBtn.setAttribute('aria-pressed', isManual ? 'true' : 'false');

    if (isManual) {
      stopQRScanner();
      const tglInp = document.getElementById('manual-presensi-tanggal');
      if (tglInp && !tglInp.value) tglInp.value = UI.todayISO();
      populateManualKelasSelect();
      updateGuruSyncStatusBanner();
      renderManualRoster();
    }
  }

  function applyGuruBootstrapData(bundle, opts) {
    const CACHE = root.MDTA_CACHE;
    const today = UI.todayISO();
    const prevAmpu = getGuruKelasAmpu().slice();

    if (bundle && bundle.sync_ts !== undefined && bundle.sync_ts !== null && bundle.sync_ts !== '') {
      recordGuruSyncTs(bundle.sync_ts);
    }

    if (Array.isArray(bundle.kelas_ampu)) {
      const nextAmpu = API.parseKelasAmpu(bundle.kelas_ampu);
      guruSession.kelas_ampu = nextAmpu;
      if (root.MDTA_AUTH && typeof root.MDTA_AUTH.updateSession === 'function') {
        guruSession = root.MDTA_AUTH.updateSession({ kelas_ampu: nextAmpu }) || guruSession;
      }
      updateBanner(guruSession);
    }

    if (Array.isArray(bundle.kelas)) {
      STATE.kelas = bundle.kelas.map(API.normalizeKelas);
      STATE.loaded.kelas = true;
      if (CACHE) CACHE.write('kelas', STATE.kelas);
    }

    const prevSantri = STATE.santri || [];
    const prevPresensi = serverTodayPresensi;

    if (Array.isArray(bundle.santri)) {
      STATE.santri = API.filterByGuruScope(bundle.santri.map(API.normalizeSantri), guruSession, 'kelas');
      STATE.loaded.santri = true;
      if (CACHE) CACHE.write('santri', STATE.santri);
    }
    if (Array.isArray(bundle.presensi_hari_ini)) {
      serverTodayPresensi = API.filterByGuruScope(
        bundle.presensi_hari_ini
          .map(API.normalizePresensi)
          .filter((r) => !r.tanggal || API.normalizeISODate(r.tanggal) === today),
        guruSession,
        'kelas'
      );
      STATE.presensiToday = serverTodayPresensi;
      if (CACHE) CACHE.write('presensiToday', serverTodayPresensi);
    }
    if (Array.isArray(bundle.nilai_raport)) {
      STATE.nilaiRaportSaved = API.filterByGuruScope(
        bundle.nilai_raport
          .map(API.normalizeNilaiRaport)
          .filter((r) => String(r.nama_santri || '').trim() && String(r.nama_santri).trim() !== '-'),
        guruSession,
        'kelas'
      );
      if (CACHE) CACHE.write('nilaiRaportSaved', STATE.nilaiRaportSaved);
    }
    if (Array.isArray(bundle.nilai_uas)) {
      STATE.nilaiUAS = API.filterByGuruScope(
        bundle.nilai_uas.map(API.normalizeNilaiUAS).reverse(),
        guruSession,
        'kelas'
      );
      STATE.loaded.uas = true;
      if (CACHE) CACHE.write('nilaiUAS', STATE.nilaiUAS);
    }

    STATE.loaded.guruPresensi = true;
    updateGuruSyncStatusBanner();

    const santriChanged = !CACHE || CACHE.hasChanged(prevSantri, STATE.santri);
    const dataChanged =
      santriChanged ||
      CACHE.hasChanged(prevPresensi, serverTodayPresensi);

    populateManualKelasSelect();
    if (dataChanged || Array.isArray(bundle.kelas_ampu)) {
      renderSessionLogs();
      if (presensiMode === 'manual') {
        renderManualRoster();
      }
    }

    if (root.MDTA_CALC && typeof root.MDTA_CALC.refreshScope === 'function') {
      root.MDTA_CALC.refreshScope('guru', guruSession, {
        silentBackground: Boolean(opts && opts.silentSync),
        skipFetch: true,
      });
    }

    if (opts && opts.silentSync) {
      const nextAmpu = getGuruKelasAmpu();
      const ampuChanged = !CACHE || CACHE.hasChanged(prevAmpu, nextAmpu);
      if (ampuChanged) {
        UI.toast('Pemetaan kelas ampu Anda diperbarui oleh Administrator.', 'info');
      }
    }
  }

  async function loadGuruBootstrapSWR(force, opts) {
    checkGuruDayRollover({ triggerFetch: false });
    const isSilentSync = Boolean(opts && opts.silentSync);
    const CACHE = root.MDTA_CACHE;
    if (CACHE) CACHE.hydrateState();
    const today = UI.todayISO();

    STATE.santri = API.filterByGuruScope(STATE.santri || [], guruSession, 'kelas');

    if (!isSilentSync) {
      if (Array.isArray(STATE.presensiToday) && STATE.presensiToday.length > 0) {
        serverTodayPresensi = API.filterByGuruScope(
          STATE.presensiToday.filter((r) => !r.tanggal || API.normalizeISODate(r.tanggal) === today),
          guruSession,
          'kelas'
        );
      } else {
        serverTodayPresensi = [];
      }
      populateManualKelasSelect();
      renderSessionLogs();
      if (presensiMode === 'manual') {
        renderManualRoster();
      }
    }

    const kelasAmpu = getGuruKelasAmpu();
    updateGuruSyncStatusBanner();

    if (!force && STATE.loaded.guruPresensi && STATE.santri.length > 0 && kelasAmpu.length > 0) {
      return;
    }

    try {
      const bundle = CACHE
        ? await CACHE.fetchBootstrapSmart({
            role: 'guru',
            tanggal: today,
            id_user: (guruSession && guruSession.id_user) || '',
            username: (guruSession && guruSession.username) || '',
          })
        : {};
      applyGuruBootstrapData(bundle, opts);
    } catch (err) {
      const statusEl = document.getElementById('guru-santri-sync-status');
      if (statusEl && !isSilentSync && STATE.santri.length === 0) {
        statusEl.textContent = `Gagal memuat daftar santri (${err.message}).`;
      }
    }
  }

  // =========================================================================
  // PANEL PEMINDAIAN QR-CODE (html5-qrcode + FALLBACK KAMERA)
  // =========================================================================
  function showCameraFallback(reasonText) {
    const fallback = document.getElementById('qr-camera-fallback');
    const reasonEl = document.getElementById('qr-fallback-reason');
    const idleBox = document.getElementById('qr-camera-idle');

    if (idleBox) idleBox.hidden = true;
    if (reasonEl) reasonEl.textContent = reasonText;
    if (fallback) fallback.hidden = false;
  }

  function hideCameraFallback() {
    const fallback = document.getElementById('qr-camera-fallback');
    if (fallback) fallback.hidden = true;
  }

  function updateScannerButtons(running) {
    const startBtn = document.getElementById('btn-qr-start');
    const stopBtn = document.getElementById('btn-qr-stop');
    const idleBox = document.getElementById('qr-camera-idle');

    if (startBtn) startBtn.hidden = running;
    if (stopBtn) stopBtn.hidden = !running;
    if (idleBox) idleBox.hidden = running;
  }

  async function stopQRScanner() {
    if (qrScannerInstance && scannerRunning) {
      try {
        await qrScannerInstance.stop();
        qrScannerInstance.clear();
      } catch (err) {
        // Abaikan error saat menghentikan stream kamera yang sudah berhenti
      }
    }
    scannerRunning = false;
    updateScannerButtons(false);
  }

  async function submitQRTokenPresensi(rawToken, catatanDefault) {
    checkGuruDayRollover({ triggerFetch: false });
    const token = String(rawToken || '').trim();
    if (!token) {
      UI.toast('Kode QR atau ID santri kosong.', 'warn');
      return;
    }

    const kelasAmpu = getGuruKelasAmpu();
    if (kelasAmpu.length === 0) {
      UI.toast('Akun Anda belum dipetakan ke kelas mana pun. Hubungi Admin.', 'error');
      return;
    }

    const nowMs = Date.now();
    if (token === lastScanToken && nowMs - lastScanTime < 3500) {
      return;
    }
    lastScanToken = token;
    lastScanTime = nowMs;

    const matched = (STATE.santri || []).find(
      (s) =>
        s.qr_token.toLowerCase() === token.toLowerCase() ||
        s.id_santri.toLowerCase() === token.toLowerCase()
    );

    if (matched && !API.isKelasAllowed(matched.kelas, kelasAmpu)) {
      UI.toast(`Akses ditolak: Santri "${matched.nama_lengkap}" (${matched.kelas}) berada di luar kelas ampu Anda.`, 'error');
      return;
    }

    const todayWib = UI.todayISO();
    const waktu = UI.nowTimeHMS();
    const payload = {
      id_santri: matched ? matched.id_santri : '',
      qr_token: token,
      nama_santri: matched ? matched.nama_lengkap : '',
      status: 'Hadir',
      tanggal: todayWib,
      waktu,
      id_guru_piket: (guruSession && guruSession.id_user) || '',
      nama_guru_piket: (guruSession && (guruSession.nama_lengkap || guruSession.username)) || 'Guru Piket',
      metode: 'QR',
      catatan: catatanDefault || `Scan QR (${token})`,
    };

    const lastBox = document.getElementById('qr-last-scan-result');
    const resolvedKelas = matched ? matched.kelas : '-';
    const initialNama = matched ? matched.nama_lengkap : token;

    if (matched) {
      const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const optimisticEntry = {
        _tempId: tempId,
        id_presensi: '',
        id_santri: matched.id_santri,
        tanggal: todayWib,
        waktu: waktu.slice(0, 5),
        nama_santri: initialNama,
        kelas: resolvedKelas,
        status: 'Hadir',
        metode: 'QR',
        catatan: payload.catatan,
      };

      upsertSessionPresensiLog(optimisticEntry);
      if (root.MDTA_CACHE) root.MDTA_CACHE.write('presensiToday', getCombinedTodayPresensi());
      renderSessionLogs();

      if (lastBox) {
        lastBox.hidden = false;
        lastBox.className = 'inline-alert inline-alert-success';
        lastBox.innerHTML = `<i data-lucide="check-circle-2" aria-hidden="true"></i><div><strong>Presensi Hadir Tercatat: ${UI.esc(initialNama)}</strong><div style="font-size:0.8rem;">${UI.esc(resolvedKelas)} · ${UI.esc(waktu)}</div></div>`;
        UI.refreshIcons(lastBox);
      }
      UI.toast(`Presensi QR "${initialNama}" (Hadir) dicatat.`, 'success');

      API.savePresensi(payload)
        .then((res) => {
          const d = res.data || res;
          const resolvedNama = API.pick(d, ['santri', 'nama_santri'], initialNama);
          optimisticEntry.id_presensi = d.id_presensi || '';
          optimisticEntry.nama_santri = resolvedNama;
          optimisticEntry.status = d.status || 'Hadir';
          if (root.MDTA_CACHE) root.MDTA_CACHE.write('presensiToday', getCombinedTodayPresensi());
          invalidateAdminReportCache();
          renderSessionLogs();
          if (resolvedNama !== initialNama && lastBox) {
            lastBox.innerHTML = `<i data-lucide="check-circle-2" aria-hidden="true"></i><div><strong>Presensi Hadir Tercatat: ${UI.esc(resolvedNama)}</strong><div style="font-size:0.8rem;">${UI.esc(resolvedKelas)} · ${UI.esc(waktu)}</div></div>`;
            UI.refreshIcons(lastBox);
          }
        })
        .catch((err) => {
          const idx = sessionPresensiLogs.indexOf(optimisticEntry);
          if (idx >= 0) sessionPresensiLogs.splice(idx, 1);
          if (root.MDTA_CACHE) root.MDTA_CACHE.write('presensiToday', getCombinedTodayPresensi());
          renderSessionLogs();
          if (lastBox) {
            lastBox.className = 'inline-alert inline-alert-error';
            lastBox.innerHTML = `<i data-lucide="alert-circle" aria-hidden="true"></i><span>${UI.esc(err.message)}</span>`;
            UI.refreshIcons(lastBox);
          }
          UI.toast(`Gagal menyimpan presensi "${initialNama}": ${err.message}`, 'error');
        });
      return;
    }

    try {
      const res = await API.savePresensi(payload);
      const d = res.data || res;
      const confirmedNama = API.pick(d, ['santri', 'nama_santri'], token);
      const confirmedKelas = API.pick(d, ['kelas'], kelasAmpu[0] || '-');
      upsertSessionPresensiLog({
        id_presensi: d.id_presensi || '',
        id_santri: d.id_santri || '',
        tanggal: todayWib,
        waktu: waktu.slice(0, 5),
        nama_santri: confirmedNama,
        kelas: confirmedKelas,
        status: d.status || 'Hadir',
        metode: 'QR',
        catatan: payload.catatan,
      });
      if (root.MDTA_CACHE) root.MDTA_CACHE.write('presensiToday', getCombinedTodayPresensi());
      invalidateAdminReportCache();
      renderSessionLogs();
      if (lastBox) {
        lastBox.hidden = false;
        lastBox.className = 'inline-alert inline-alert-success';
        lastBox.innerHTML = `<i data-lucide="check-circle-2" aria-hidden="true"></i><div><strong>Presensi Hadir Tercatat: ${UI.esc(confirmedNama)}</strong><div style="font-size:0.8rem;">${UI.esc(confirmedKelas)} · ${UI.esc(waktu)}</div></div>`;
        UI.refreshIcons(lastBox);
      }
      UI.toast(`Presensi QR "${confirmedNama}" (Hadir) dicatat.`, 'success');
    } catch (err) {
      if (lastBox) {
        lastBox.hidden = false;
        lastBox.className = 'inline-alert inline-alert-error';
        lastBox.innerHTML = `<i data-lucide="alert-circle" aria-hidden="true"></i><span>${UI.esc(err.message)}</span>`;
        UI.refreshIcons(lastBox);
      }
      UI.toast(err.message, 'error');
    }
  }

  async function startQRScanner() {
    hideCameraFallback();

    if (typeof root.Html5Qrcode !== 'function') {
      showCameraFallback(
        'Library pemindai kamera html5-qrcode tidak tersedia. Gunakan Input Token QR Manual di bawah atau buka halaman Absensi Manual.'
      );
      return;
    }

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      showCameraFallback(
        'Peramban atau koneksi (non-HTTPS) saat ini tidak mendukung akses kamera. Gunakan Input Token QR Manual atau halaman Absensi Manual.'
      );
      return;
    }

    const startBtn = document.getElementById('btn-qr-start');
    UI.setButtonLoading(startBtn, true, 'Menyiapkan Kamera...');

    try {
      const cameras = await root.Html5Qrcode.getCameras();
      const selectEl = document.getElementById('qr-camera-select');
      if (!cameras || cameras.length === 0) {
        throw new Error('Tidak ada perangkat kamera yang terdeteksi pada perangkat ini.');
      }

      if (selectEl) {
        const prev = selectEl.value;
        selectEl.innerHTML = cameras
          .map((cam, idx) => `<option value="${UI.esc(cam.id)}">${UI.esc(cam.label || `Kamera ${idx + 1}`)}</option>`)
          .join('');
        if (prev && cameras.some((c) => c.id === prev)) {
          selectEl.value = prev;
        } else {
          const backCam = cameras.find((c) => /back|rear|belakang|environment/i.test(c.label));
          if (backCam) selectEl.value = backCam.id;
        }
        selectEl.hidden = false;
      }

      const cameraId = selectEl && selectEl.value ? selectEl.value : cameras[0].id;
      if (!qrScannerInstance) {
        qrScannerInstance = new root.Html5Qrcode('qr-reader');
      }

      const idleBox = document.getElementById('qr-camera-idle');
      if (idleBox) idleBox.hidden = true;

      await qrScannerInstance.start(
        cameraId,
        {
          fps: 10,
          aspectRatio: 1.0,
          qrbox: (viewfinderWidth, viewfinderHeight) => {
            const side = Math.max(160, Math.min(240, Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.72)));
            return { width: side, height: side };
          },
        },
        (decodedText) => submitQRTokenPresensi(decodedText, 'Scan kamera QR'),
        () => {}
      );

      scannerRunning = true;
      updateScannerButtons(true);
    } catch (err) {
      scannerRunning = false;
      updateScannerButtons(false);
      const rawMsg = String((err && err.message) || err || '');
      let humanMsg = 'Kamera tidak dapat diakses. Gunakan Input Token QR Manual atau buka Absensi Manual.';
      if (/NotAllowedError|Permission|denied/i.test(rawMsg)) {
        humanMsg =
          'Izin akses kamera ditolak oleh pengguna atau browser. Berikan izin kamera pada setelan browser atau buka Absensi Manual.';
      } else if (/NotFoundError|no camera|terdeteksi/i.test(rawMsg)) {
        humanMsg =
          'Perangkat kamera tidak ditemukan. Gunakan Input Token QR Manual atau buka Absensi Manual.';
      } else if (rawMsg) {
        humanMsg = `Kamera gagal dimulai (${rawMsg}). Gunakan Absensi Manual.`;
      }
      showCameraFallback(humanMsg);
      UI.toast('Pemindaian kamera tidak tersedia, fallback manual diaktifkan.', 'warn');
    } finally {
      UI.setButtonLoading(startBtn, false);
    }
  }

  // =========================================================================
  // HALAMAN KHUSUS ABSENSI MANUAL (BATCH PER KELAS AMPU) & BERSIHKAN LOG
  // =========================================================================
  function bindPresensiManualEvents() {
    const modeQrBtn = document.getElementById('btn-guru-mode-qr');
    const modeManualBtn = document.getElementById('btn-guru-mode-manual');
    const openManualBtn = document.getElementById('btn-open-presensi-manual');
    const backQrBtn = document.getElementById('btn-guru-back-to-qr');
    const kelasSel = document.getElementById('manual-santri-kelas');
    const tanggalInp = document.getElementById('manual-presensi-tanggal');
    const markAllBtn = document.getElementById('btn-manual-mark-all-hadir');
    const submitBatchBtn = document.getElementById('btn-submit-presensi-manual');
    const clearDailyBtn = document.getElementById('btn-guru-clear-presensi-harian');

    if (tanggalInp && !tanggalInp.value) {
      tanggalInp.value = UI.todayISO();
    }

    if (modeQrBtn) modeQrBtn.addEventListener('click', () => setPresensiMode('qr'));
    if (modeManualBtn) modeManualBtn.addEventListener('click', () => setPresensiMode('manual'));
    if (openManualBtn) openManualBtn.addEventListener('click', () => setPresensiMode('manual'));
    if (backQrBtn) backQrBtn.addEventListener('click', () => setPresensiMode('qr'));

    if (kelasSel) {
      kelasSel.addEventListener('change', () => renderManualRoster());
    }
    if (tanggalInp) {
      tanggalInp.addEventListener('change', () => renderManualRoster());
    }

    if (markAllBtn) {
      markAllBtn.addEventListener('click', () => {
        const selectedKelas = (kelasSel && kelasSel.value) || '';
        const targetTanggal = (tanggalInp && tanggalInp.value) || UI.todayISO();
        const roster = getActiveMappedSantriForClass(selectedKelas);
        if (roster.length === 0) {
          UI.toast('Tidak ada santri aktif pada kelas terpilih.', 'warn');
          return;
        }
        roster.forEach((s) => {
          const dKey = `${targetTanggal}|${getSantriUniqueKey(s)}`;
          manualDraftMap.set(dKey, { status: 'Hadir', catatan: '' });
        });
        renderManualRoster();
        UI.toast(`${roster.length} santri kelas ${selectedKelas} ditandai Hadir.`, 'info');
      });
    }

    if (submitBatchBtn) {
      submitBatchBtn.addEventListener('click', async () => {
        const kelasAmpu = getGuruKelasAmpu();
        if (kelasAmpu.length === 0) {
          UI.toast('Akun Anda belum dipetakan ke kelas mana pun. Hubungi Admin.', 'error');
          return;
        }

        const selectedKelas = (kelasSel && kelasSel.value) || kelasAmpu[0] || '';
        if (!API.isKelasAllowed(selectedKelas, kelasAmpu)) {
          UI.toast(`Kelas "${selectedKelas}" berada di luar kelas ampu Anda.`, 'error');
          return;
        }

        const targetTanggal = (tanggalInp && tanggalInp.value) || UI.todayISO();
        const roster = getActiveMappedSantriForClass(selectedKelas);
        if (roster.length === 0) {
          UI.toast('Belum ada santri aktif di kelas ini.', 'warn');
          return;
        }

        const todayWib = UI.todayISO();
        const todayRecordedMap = new Map();
        if (targetTanggal === todayWib) {
          getCombinedTodayPresensi().forEach((item) => {
            if (normKelasKey(item.kelas) !== normKelasKey(selectedKelas)) return;
            const sid = String(item.id_santri || '').trim();
            const sname = String(item.nama_santri || '').trim().toLowerCase();
            if (sid && !todayRecordedMap.has(sid)) todayRecordedMap.set(sid, item);
            if (sname && !todayRecordedMap.has(sname)) todayRecordedMap.set(sname, item);
          });
        }

        const waktu = UI.nowTimeHMS();
        const idGuruPiket = (guruSession && guruSession.id_user) || '';
        const namaGuruPiket =
          (guruSession && (guruSession.nama_lengkap || guruSession.username)) || 'Guru Piket';

        const entriesToSubmit = [];
        const submittedDraftKeys = [];

        roster.forEach((s) => {
          const resolved = resolveManualRowState(s, targetTanggal, todayRecordedMap);
          if (!['Hadir', 'Izin', 'Sakit', 'Alpa'].includes(resolved.status)) return;
          submittedDraftKeys.push(resolved.dKey);
          entriesToSubmit.push({
            id_santri: s.id_santri || '',
            qr_token: s.qr_token || '',
            nama_santri: s.nama_lengkap,
            kelas: s.kelas || selectedKelas,
            status: resolved.status,
            tanggal: targetTanggal,
            waktu,
            id_guru_piket: idGuruPiket,
            nama_guru_piket: namaGuruPiket,
            metode: 'Manual',
            catatan: resolved.status === 'Hadir' ? '' : String(resolved.catatan || '').trim(),
          });
        });

        if (entriesToSubmit.length === 0) {
          UI.toast('Pilih status kehadiran minimal satu santri atau klik "Tandai Semua Hadir" terlebih dahulu.', 'warn');
          return;
        }

        UI.setButtonLoading(submitBatchBtn, true, 'Menyimpan Presensi...');
        try {
          const res = await API.savePresensi(entriesToSubmit);
          const d = res.data || res || {};
          const savedItems = Array.isArray(d.items) && d.items.length > 0 ? d.items : entriesToSubmit;

          submittedDraftKeys.forEach((dk) => manualDraftMap.delete(dk));

          if (targetTanggal === UI.todayISO()) {
            savedItems.forEach((sv) => {
              const norm = API.normalizePresensi(
                Object.assign({}, sv, {
                  nama_santri: sv.nama_santri || sv.santri,
                  tanggal: sv.tanggal || targetTanggal,
                  waktu: (sv.waktu || waktu).slice(0, 5),
                })
              );
              upsertSessionPresensiLog(norm);
              const srvIdx = serverTodayPresensi.findIndex(
                (r) =>
                  (norm.id_presensi && r.id_presensi === norm.id_presensi) ||
                  buildPresensiDedupKey(r) === buildPresensiDedupKey(norm)
              );
              if (srvIdx >= 0) serverTodayPresensi[srvIdx] = norm;
              else serverTodayPresensi.unshift(norm);
            });
            STATE.presensiToday = serverTodayPresensi;
            if (root.MDTA_CACHE) root.MDTA_CACHE.write('presensiToday', getCombinedTodayPresensi());
          }

          invalidateAdminReportCache();
          renderSessionLogs();
          renderManualRoster();
          UI.toast(
            `${d.savedCount || savedItems.length} presensi kelas ${selectedKelas} berhasil disimpan dan tersinkron ke Admin.`,
            'success'
          );
        } catch (err) {
          UI.toast(`Gagal menyimpan presensi kelas: ${err.message}`, 'error');
        } finally {
          UI.setButtonLoading(submitBatchBtn, false);
        }
      });
    }

    if (clearDailyBtn) {
      clearDailyBtn.addEventListener('click', async () => {
        const kelasAmpu = getGuruKelasAmpu();
        if (kelasAmpu.length === 0) {
          UI.toast('Akun Anda belum dipetakan ke kelas mana pun.', 'warn');
          return;
        }

        const todayWib = UI.todayISO();
        const confirmed = await UI.confirmDialog({
          title: 'Bersihkan Log Presensi Hari Ini',
          message: `Hapus seluruh catatan presensi tanggal ${UI.formatDateShort(todayWib)} untuk kelas ${kelasAmpu.join(', ')}? Data tanggal sebelumnya untuk Rekap Bulanan tetap aman.`,
          confirmLabel: 'Bersihkan Log Harian',
          danger: true,
        });
        if (!confirmed) return;

        UI.setButtonLoading(clearDailyBtn, true, 'Membersihkan...');
        try {
          const res = await API.clearPresensiHarian({ tanggal: todayWib });
          const d = res.data || res || {};

          sessionPresensiLogs.length = 0;
          serverTodayPresensi = [];
          STATE.presensiToday = [];
          Array.from(manualDraftMap.keys()).forEach((k) => {
            if (k.startsWith(`${todayWib}|`)) manualDraftMap.delete(k);
          });
          if (root.MDTA_CACHE) root.MDTA_CACHE.remove('presensiToday');
          invalidateAdminReportCache();

          renderSessionLogs();
          if (presensiMode === 'manual') {
            renderManualRoster();
          }
          UI.toast(
            `Log presensi hari ini dibersihkan (${d.deletedCount ?? 0} catatan dihapus). Rekap bulanan sebelumnya tetap aman.`,
            'success'
          );
        } catch (err) {
          UI.toast(`Gagal membersihkan log harian: ${err.message}`, 'error');
        } finally {
          UI.setButtonLoading(clearDailyBtn, false);
        }
      });
    }
  }

  function bindQRPanelEvents() {
    const startBtn = document.getElementById('btn-qr-start');
    const stopBtn = document.getElementById('btn-qr-stop');
    const camSelect = document.getElementById('qr-camera-select');
    const fallbackManualForm = document.getElementById('form-qr-token-fallback');
    const fallbackTokenInput = document.getElementById('qr-token-manual-input');
    const focusManualBtn = document.getElementById('btn-focus-manual-presensi');
    const openManualFallbackBtn = document.getElementById('btn-show-token-fallback');

    if (startBtn) startBtn.addEventListener('click', startQRScanner);
    if (stopBtn) stopBtn.addEventListener('click', stopQRScanner);

    if (camSelect) {
      camSelect.addEventListener('change', async () => {
        if (scannerRunning) {
          await stopQRScanner();
          startQRScanner();
        }
      });
    }

    if (openManualFallbackBtn) {
      openManualFallbackBtn.addEventListener('click', () => {
        showCameraFallback(
          'Mode input token manual diaktifkan. Masukkan kode token kartu QR santri di bawah atau buka Absensi Manual.'
        );
        if (fallbackTokenInput) fallbackTokenInput.focus();
      });
    }

    if (fallbackManualForm) {
      fallbackManualForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const token = fallbackTokenInput ? fallbackTokenInput.value.trim() : '';
        if (!token) {
          UI.toast('Masukkan kode token QR santri terlebih dahulu.', 'warn');
          return;
        }
        await submitQRTokenPresensi(token, `Input token QR (${token})`);
        if (fallbackTokenInput) fallbackTokenInput.value = '';
      });
    }

    if (focusManualBtn) {
      focusManualBtn.addEventListener('click', () => {
        setPresensiMode('manual');
      });
    }
  }

  // =========================================================================
  // SMART POLLING REAL-TIME GURU (5 DETIK VIA getSyncVersion)
  // =========================================================================
  function clearGuruSyncTimer() {
    if (guruSyncTimer !== null) {
      clearInterval(guruSyncTimer);
      guruSyncTimer = null;
    }
  }

  function scheduleGuruSyncInterval() {
    clearGuruSyncTimer();
    const intervalMs = Math.max(2000, Number(CONFIG.SYNC_POLL_INTERVAL_MS) || 5000);
    guruSyncTimer = setInterval(pollGuruSyncVersion, intervalMs);
  }

  async function pollGuruSyncVersion() {
    if (checkGuruDayRollover({ triggerFetch: true })) return;
    if (!guruSyncActive || guruSyncUnsupported || guruSyncCheckInFlight || guruSyncRefreshInFlight) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    const guruView = document.getElementById('view-guru');
    if (!guruView || guruView.hidden) return;

    guruSyncCheckInFlight = true;
    try {
      const res = await API.getSyncVersion();
      const d = (res && res.data) || res || {};
      const serverTs = String(d.ts !== undefined ? d.ts : (d.last_sync_ts !== undefined ? d.last_sync_ts : '0'));

      if (localGuruSyncTs === null) {
        recordGuruSyncTs(serverTs);
      } else if (serverTs !== localGuruSyncTs) {
        guruSyncRefreshInFlight = true;
        try {
          await loadGuruBootstrapSWR(true, { silentSync: true });
          recordGuruSyncTs(serverTs);
        } finally {
          guruSyncRefreshInFlight = false;
        }
      }
    } catch (err) {
      if (/tidak dikenali/i.test(String((err && err.message) || ''))) {
        guruSyncUnsupported = true;
        clearGuruSyncTimer();
      }
    } finally {
      guruSyncCheckInFlight = false;
    }
  }

  function handleGuruVisibilityChange() {
    if (!guruSyncActive || guruSyncUnsupported) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      clearGuruSyncTimer();
    } else {
      const rolledOver = checkGuruDayRollover({ triggerFetch: true });
      scheduleGuruSyncInterval();
      if (!rolledOver) pollGuruSyncVersion();
    }
  }

  function startGuruLiveSync() {
    guruSyncActive = true;
    guruSyncUnsupported = false;
    if (!guruSyncVisibilityBound && typeof document !== 'undefined') {
      guruSyncVisibilityBound = true;
      document.addEventListener('visibilitychange', handleGuruVisibilityChange);
    }
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      scheduleGuruSyncInterval();
    } else {
      clearGuruSyncTimer();
    }
  }

  function stopGuruLiveSync() {
    guruSyncActive = false;
    clearGuruSyncTimer();
    localGuruSyncTs = null;
  }

  // =========================================================================
  // INISIALISASI & CLEANUP PORTAL GURU (3 TAB)
  // =========================================================================
  function init(session) {
    guruSession = session || {};
    const nextKey = String((guruSession && (guruSession.id_user || guruSession.username)) || '');
    if (nextKey !== lastGuruKey) {
      lastGuruKey = nextKey;
      sessionPresensiLogs.length = 0;
      serverTodayPresensi = [];
      manualDraftMap.clear();
      lastScanToken = '';
      localGuruSyncTs = null;
      activeDateWib = UI.todayISO();
    } else {
      checkGuruDayRollover({ triggerFetch: false });
    }

    updateBanner(guruSession);
    populateManualKelasSelect();
    setPresensiMode('qr');
    const tablist = document.getElementById('guru-tablist');

    if (!initialized) {
      initialized = true;
      bindQRPanelEvents();
      bindPresensiManualEvents();

      tabController = UI.initSlidingTabs(tablist, (tabName) => {
        if (tabName !== 'presensi') {
          stopQRScanner();
        }
        if (tabName === 'uas') {
          root.MDTA_CALC.mountUAS(document.getElementById('guru-uas-mount'), {
            scope: 'guru',
            session: guruSession,
          });
        } else if (tabName === 'raport') {
          root.MDTA_CALC.mountRaport(document.getElementById('guru-raport-mount'), {
            scope: 'guru',
            session: guruSession,
          });
        }
      });
    } else if (tabController) {
      tabController.selectByName('presensi', false);
    }

    loadGuruBootstrapSWR(false);
    startGuruLiveSync();
  }

  function cleanup() {
    stopQRScanner();
    stopGuruLiveSync();
  }

  root.MDTA_GURU = {
    init,
    cleanup,
    checkDayRollover: checkGuruDayRollover,
    setPresensiMode,
  };
})(window);
