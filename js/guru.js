/**
 * Portal Guru (3 Tab) - Terhubung ke Code.gs & Database Sistem MDTA
 * Header Banner "GURU PIKET" dengan nama guru yang login.
 * 1. Tab Presensi: Pemindaian QR-Code (html5-qrcode + fallback) + Panel Input Manual
 *    yang otomatis tersinkron ke Beranda Laporan Admin.
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

  let selectedStatus = 'Hadir';
  let selectedSantri = null;
  let activeAcIndex = -1;
  const sessionPresensiLogs = [];
  let serverTodayPresensi = [];

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

  function statusBadgeClass(status) {
    const s = String(status || '').toLowerCase();
    if (s.includes('hadir')) return 'status-hadir';
    if (s.includes('sakit')) return 'status-sakit';
    if (s.includes('izin')) return 'status-izin';
    return 'status-alpa';
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

  function getCombinedTodayPresensi() {
    const seenIds = new Set();
    const merged = [];

    sessionPresensiLogs.forEach((item) => {
      if (item.id_presensi) seenIds.add(item.id_presensi);
      merged.push(item);
    });

    serverTodayPresensi.forEach((srv) => {
      if (srv.id_presensi && seenIds.has(srv.id_presensi)) return;
      merged.push(srv);
    });

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
    if (prev && kelasAmpu.some((k) => k.toLowerCase() === prev.toLowerCase())) {
      const exact = kelasAmpu.find((k) => k.toLowerCase() === prev.toLowerCase());
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
                  : 'Pindai kartu QR santri atau gunakan form Input Manual di atas.',
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

  function applyGuruBootstrapData(bundle) {
    const CACHE = root.MDTA_CACHE;
    const today = UI.todayISO();

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
        bundle.presensi_hari_ini.map(API.normalizePresensi).filter((r) => !r.tanggal || r.tanggal === today),
        guruSession,
        'kelas'
      );
      STATE.presensiToday = serverTodayPresensi;
      if (CACHE) CACHE.write('presensiToday', serverTodayPresensi);
    }
    if (Array.isArray(bundle.nilai_raport)) {
      STATE.nilaiRaportSaved = API.filterByGuruScope(
        bundle.nilai_raport.map(API.normalizeNilaiRaport),
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

    const kelasAmpu = getGuruKelasAmpu();
    const statusEl = document.getElementById('guru-santri-sync-status');
    if (statusEl) {
      if (kelasAmpu.length === 0) {
        statusEl.textContent = 'Akun Anda belum dipetakan ke kelas mana pun.';
      } else if (STATE.santri.length > 0) {
        statusEl.textContent = `${STATE.santri.length} santri kelas ${kelasAmpu.join(', ')} siap untuk autocomplete dan verifikasi QR.`;
      } else {
        statusEl.textContent = `Belum ada santri aktif pada kelas ${kelasAmpu.join(', ')}.`;
      }
    }

    const santriChanged = !CACHE || CACHE.hasChanged(prevSantri, STATE.santri);
    const dataChanged =
      santriChanged ||
      CACHE.hasChanged(prevPresensi, serverTodayPresensi);

    populateManualKelasSelect();
    if (dataChanged || Array.isArray(bundle.kelas_ampu)) {
      renderSessionLogs();
    }
  }

  async function loadGuruBootstrapSWR(force) {
    const CACHE = root.MDTA_CACHE;
    if (CACHE) CACHE.hydrateState();
    const today = UI.todayISO();

    STATE.santri = API.filterByGuruScope(STATE.santri || [], guruSession, 'kelas');

    // Paint 0ms dari cache memori / localStorage (sudah terisolasi ke kelas ampu)
    if (Array.isArray(STATE.presensiToday) && STATE.presensiToday.length > 0) {
      serverTodayPresensi = API.filterByGuruScope(
        STATE.presensiToday.filter((r) => !r.tanggal || r.tanggal === today),
        guruSession,
        'kelas'
      );
    }
    populateManualKelasSelect();
    renderSessionLogs();

    const kelasAmpu = getGuruKelasAmpu();
    const statusEl = document.getElementById('guru-santri-sync-status');
    if (statusEl) {
      if (kelasAmpu.length === 0) {
        statusEl.textContent = 'Akun Anda belum dipetakan ke kelas mana pun.';
      } else {
        statusEl.textContent =
          STATE.santri.length > 0
            ? `${STATE.santri.length} santri kelas ${kelasAmpu.join(', ')} siap untuk autocomplete dan verifikasi QR.`
            : 'Memuat daftar santri kelas Anda dari database...';
      }
    }

    if (!force && STATE.loaded.guruPresensi && (STATE.santri.length > 0 || kelasAmpu.length === 0)) {
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
      applyGuruBootstrapData(bundle);
    } catch (err) {
      if (statusEl && STATE.santri.length === 0) {
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

    const waktu = UI.nowTimeHMS();
    const payload = {
      id_santri: matched ? matched.id_santri : '',
      qr_token: token,
      nama_santri: matched ? matched.nama_lengkap : '',
      status: 'Hadir',
      tanggal: UI.todayISO(),
      waktu,
      id_guru_piket: (guruSession && guruSession.id_user) || '',
      nama_guru_piket: (guruSession && (guruSession.nama_lengkap || guruSession.username)) || 'Guru Piket',
      metode: 'QR',
      catatan: catatanDefault || `Scan QR (${token})`,
    };

    const lastBox = document.getElementById('qr-last-scan-result');
    const resolvedKelas = matched ? matched.kelas : '-';
    const initialNama = matched ? matched.nama_lengkap : token;

    // Jika token santri dikenal dalam cache kelas ampu, pakai Optimistic UI seketika.
    // Jika belum dikenal di list lokal, verifikasi ke backend dulu agar tidak tampil palsu bila beda kelas.
    if (matched) {
      const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const optimisticEntry = {
        _tempId: tempId,
        id_presensi: '',
        waktu: waktu.slice(0, 5),
        nama_santri: initialNama,
        kelas: resolvedKelas,
        status: 'Hadir',
        metode: 'QR',
        catatan: payload.catatan,
      };

      sessionPresensiLogs.unshift(optimisticEntry);
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
          if (resolvedNama !== initialNama) {
            renderSessionLogs();
            if (lastBox) {
              lastBox.innerHTML = `<i data-lucide="check-circle-2" aria-hidden="true"></i><div><strong>Presensi Hadir Tercatat: ${UI.esc(resolvedNama)}</strong><div style="font-size:0.8rem;">${UI.esc(resolvedKelas)} · ${UI.esc(waktu)}</div></div>`;
              UI.refreshIcons(lastBox);
            }
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
      sessionPresensiLogs.unshift({
        id_presensi: d.id_presensi || '',
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
        'Library pemindai kamera html5-qrcode tidak tersedia. Gunakan Input Token QR Manual di bawah atau Panel Input Manual di samping.'
      );
      return;
    }

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      showCameraFallback(
        'Peramban atau koneksi (non-HTTPS) saat ini tidak mendukung akses kamera. Gunakan Input Token QR Manual atau Panel Input Manual.'
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
      let humanMsg = 'Kamera tidak dapat diakses. Gunakan Input Token QR Manual atau Panel Input Manual.';
      if (/NotAllowedError|Permission|denied/i.test(rawMsg)) {
        humanMsg =
          'Izin akses kamera ditolak oleh pengguna atau browser. Berikan izin kamera pada setelan browser atau gunakan Input Manual.';
      } else if (/NotFoundError|no camera|terdeteksi/i.test(rawMsg)) {
        humanMsg =
          'Perangkat kamera tidak ditemukan. Gunakan Input Token QR Manual atau Panel Input Manual.';
      } else if (rawMsg) {
        humanMsg = `Kamera gagal dimulai (${rawMsg}). Gunakan Input Manual di samping.`;
      }
      showCameraFallback(humanMsg);
      UI.toast('Pemindaian kamera tidak tersedia, fallback manual diaktifkan.', 'warn');
    } finally {
      UI.setButtonLoading(startBtn, false);
    }
  }

  // =========================================================================
  // PANEL INPUT MANUAL & LAPORAN KE KEPALA MADRASAH
  // =========================================================================
  function bindPresensiManualEvents() {
    const statusButtons = Array.from(document.querySelectorAll('#guru-status-choices .status-choice-btn'));
    const namaInput = document.getElementById('manual-santri-input');
    const acList = document.getElementById('manual-santri-autocomplete');
    const kelasInput = document.getElementById('manual-santri-kelas');
    const tanggalInput = document.getElementById('manual-presensi-tanggal');
    const ketInput = document.getElementById('manual-presensi-ket');
    const form = document.getElementById('form-presensi-manual');

    if (tanggalInput && !tanggalInput.value) {
      tanggalInput.value = UI.todayISO();
    }

    statusButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedStatus = btn.dataset.status || 'Hadir';
        statusButtons.forEach((b) => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
      });
    });

    function closeAutocomplete() {
      if (acList) acList.hidden = true;
      if (namaInput) namaInput.setAttribute('aria-expanded', 'false');
      activeAcIndex = -1;
    }

    function selectAutocompleteItem(santri) {
      selectedSantri = santri;
      if (namaInput) namaInput.value = santri.nama_lengkap;
      if (kelasInput && santri.kelas) {
        const matchOpt = Array.from(kelasInput.options || []).find(
          (o) => o.value.toLowerCase() === santri.kelas.toLowerCase()
        );
        if (matchOpt) kelasInput.value = matchOpt.value;
      }
      closeAutocomplete();
    }

    function renderAutocomplete(query) {
      if (!acList || !namaInput) return;
      const q = String(query || '').trim().toLowerCase();
      const pool = API.filterByGuruScope(STATE.santri || [], guruSession, 'kelas');
      const matches = (q
        ? pool.filter(
            (s) =>
              s.nama_lengkap.toLowerCase().includes(q) ||
              s.id_santri.toLowerCase().includes(q) ||
              s.kelas.toLowerCase().includes(q)
          )
        : pool
      ).slice(0, 8);

      if (matches.length === 0) {
        closeAutocomplete();
        return;
      }

      activeAcIndex = -1;
      acList.innerHTML = matches
        .map(
          (s, idx) => `
          <li role="presentation">
            <button type="button" role="option" class="autocomplete-item" data-ac-idx="${idx}" aria-selected="false">
              <span><strong>${UI.esc(s.nama_lengkap)}</strong></span>
              <span class="autocomplete-sub">${UI.esc(s.kelas || '-')} · ${UI.esc(s.id_santri || '-')}</span>
            </button>
          </li>
        `
        )
        .join('');

      acList.querySelectorAll('button[data-ac-idx]').forEach((optBtn) => {
        optBtn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const item = matches[Number(optBtn.dataset.acIdx)];
          if (item) selectAutocompleteItem(item);
        });
      });

      acList.hidden = false;
      namaInput.setAttribute('aria-expanded', 'true');
    }

    if (namaInput) {
      namaInput.addEventListener('input', () => {
        selectedSantri = null;
        renderAutocomplete(namaInput.value);
      });

      namaInput.addEventListener('focus', () => {
        if ((STATE.santri || []).length > 0) {
          renderAutocomplete(namaInput.value);
        }
      });

      namaInput.addEventListener('blur', () => {
        setTimeout(closeAutocomplete, 160);
      });

      namaInput.addEventListener('keydown', (e) => {
        if (!acList || acList.hidden) return;
        const options = Array.from(acList.querySelectorAll('[role="option"]'));
        if (options.length === 0) return;

        if (e.key === 'ArrowDown') {
          e.preventDefault();
          activeAcIndex = (activeAcIndex + 1) % options.length;
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          activeAcIndex = (activeAcIndex - 1 + options.length) % options.length;
        } else if (e.key === 'Enter' && activeAcIndex >= 0) {
          e.preventDefault();
          options[activeAcIndex].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          return;
        } else if (e.key === 'Escape') {
          closeAutocomplete();
          return;
        } else {
          return;
        }

        options.forEach((opt, i) => {
          opt.classList.toggle('is-active', i === activeAcIndex);
          opt.setAttribute('aria-selected', i === activeAcIndex ? 'true' : 'false');
        });
      });
    }

    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const kelasAmpu = getGuruKelasAmpu();
        if (kelasAmpu.length === 0) {
          UI.toast('Akun Anda belum dipetakan ke kelas mana pun. Hubungi Admin.', 'error');
          return;
        }

        const nama = (namaInput ? namaInput.value : '').trim();
        const kelas = (kelasInput ? kelasInput.value : '').trim();
        const tanggal = (tanggalInput ? tanggalInput.value : '') || UI.todayISO();
        const catatan = (ketInput ? ketInput.value : '').trim();

        if (!nama) {
          UI.toast('Pilih atau masukkan nama santri terlebih dahulu.', 'error');
          if (namaInput) namaInput.focus();
          return;
        }

        const matched =
          selectedSantri ||
          (STATE.santri || []).find((s) => s.nama_lengkap.toLowerCase() === nama.toLowerCase());

        if (matched && !API.isKelasAllowed(matched.kelas, kelasAmpu)) {
          UI.toast(`Akses ditolak: Santri "${matched.nama_lengkap}" (${matched.kelas}) berada di luar kelas ampu Anda.`, 'error');
          return;
        }

        const resolvedKelas = (matched && matched.kelas) || kelas || kelasAmpu[0];
        if (!API.isKelasAllowed(resolvedKelas, kelasAmpu)) {
          UI.toast(`Kelas "${resolvedKelas}" berada di luar kelas ampu Anda (${kelasAmpu.join(', ')}).`, 'error');
          return;
        }

        const statusChoice = selectedStatus;
        const waktu = UI.nowTimeHMS();
        const payload = {
          id_santri: matched ? matched.id_santri : '',
          qr_token: matched ? matched.qr_token : '',
          nama_santri: matched ? matched.nama_lengkap : nama,
          status: statusChoice,
          tanggal,
          waktu,
          id_guru_piket: (guruSession && guruSession.id_user) || '',
          nama_guru_piket: (guruSession && (guruSession.nama_lengkap || guruSession.username)) || 'Guru Piket',
          metode: 'Manual',
          catatan,
        };

        const prevInputs = { nama, kelas, catatan, santriObj: selectedSantri };
        const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const optimisticEntry = {
          _tempId: tempId,
          id_presensi: '',
          waktu: waktu.slice(0, 5),
          nama_santri: payload.nama_santri,
          kelas: resolvedKelas,
          status: statusChoice,
          metode: 'Manual',
          catatan,
        };

        // Optimistic UI: langsung tampilkan baris & ringkasan seketika
        sessionPresensiLogs.unshift(optimisticEntry);
        if (root.MDTA_CACHE) root.MDTA_CACHE.write('presensiToday', getCombinedTodayPresensi());
        renderSessionLogs();

        if (namaInput) namaInput.value = '';
        populateManualKelasSelect();
        if (ketInput) ketInput.value = '';
        selectedSantri = null;
        UI.toast(`Presensi ${payload.nama_santri} (${statusChoice}) dicatat.`, 'success');

        API.savePresensi(payload)
          .then((res) => {
            const d = res.data || res;
            const resolvedNama = API.pick(d, ['santri', 'nama_santri'], payload.nama_santri);
            optimisticEntry.id_presensi = d.id_presensi || '';
            optimisticEntry.nama_santri = resolvedNama;
            optimisticEntry.status = d.status || statusChoice;
            if (root.MDTA_CACHE) root.MDTA_CACHE.write('presensiToday', getCombinedTodayPresensi());
            invalidateAdminReportCache();
            if (resolvedNama !== payload.nama_santri || optimisticEntry.status !== statusChoice) {
              renderSessionLogs();
            }
          })
          .catch((err) => {
            const idx = sessionPresensiLogs.indexOf(optimisticEntry);
            if (idx >= 0) sessionPresensiLogs.splice(idx, 1);
            if (root.MDTA_CACHE) root.MDTA_CACHE.write('presensiToday', getCombinedTodayPresensi());
            renderSessionLogs();
            if (namaInput && !namaInput.value) namaInput.value = prevInputs.nama;
            if (kelasInput && prevInputs.kelas) kelasInput.value = prevInputs.kelas;
            if (ketInput && !ketInput.value) ketInput.value = prevInputs.catatan;
            selectedSantri = prevInputs.santriObj;
            UI.toast(`Gagal menyinkronkan presensi "${payload.nama_santri}": ${err.message}`, 'error');
          });
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
          'Mode input token manual diaktifkan. Masukkan kode token kartu QR santri di bawah atau pilih nama santri pada Panel Input Manual.'
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
        const namaInp = document.getElementById('manual-santri-input');
        if (namaInp) {
          namaInp.scrollIntoView({ behavior: 'smooth', block: 'center' });
          namaInp.focus();
        }
      });
    }
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
      lastScanToken = '';
      selectedSantri = null;
    }

    updateBanner(guruSession);
    populateManualKelasSelect();
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
  }

  function cleanup() {
    stopQRScanner();
  }

  root.MDTA_GURU = {
    init,
    cleanup,
  };
})(window);
