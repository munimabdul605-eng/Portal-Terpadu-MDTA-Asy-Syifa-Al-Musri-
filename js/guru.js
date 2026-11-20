/**
 * Portal Guru (3 Tab) - Terhubung ke Code.gs & Database Sistem MDTA
 * Header Banner "GURU PIKET" dengan nama guru yang login.
 * 1. Tab Presensi: Pemindaian QR-Code (html5-qrcode + fallback) + Panel Input Manual
 *    + Ringkasan otomatis & Tombol "Kirim Laporan Absensi Hari Ini ke Kepala Madrasah".
 * 2. Tab Kalkulator UAS (berbagi modul MDTA_CALC + tombol Submit Rekap Nilai).
 * 3. Tab Kalkulator Raport (berbagi modul MDTA_CALC + tombol Submit Rekap Nilai).
 */
(function (root) {
  'use strict';

  const CONFIG = root.MDTA_CONFIG;
  const STATE = root.MDTA_STATE;
  const API = root.MDTA_API;
  const UI = root.MDTA_UI;

  let initialized = false;
  let guruSession = null;
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
  let todaySetoranLogs = [];

  function statusBadgeClass(status) {
    const s = String(status || '').toLowerCase();
    if (s.includes('hadir')) return 'status-hadir';
    if (s.includes('sakit')) return 'status-sakit';
    if (s.includes('izin')) return 'status-izin';
    return 'status-alpa';
  }

  function toISODateWIB(val) {
    if (!val) return '';
    const s = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(d);
      const y = parts.find((p) => p.type === 'year')?.value;
      const m = parts.find((p) => p.type === 'month')?.value;
      const day = parts.find((p) => p.type === 'day')?.value;
      if (y && m && day) return `${y}-${m}-${day}`;
    }
    return s;
  }

  function formatJamWIB(waktuStr) {
    if (!waktuStr) return '';
    const s = String(waktuStr).trim();
    const m = s.match(/(\d{1,2}):(\d{2})/);
    if (m) return `${m[1].padStart(2, '0')}.${m[2]} WIB`;
    return s;
  }

  function updateBanner(session) {
    const nameEl = document.getElementById('guru-piket-name');
    const dateEl = document.getElementById('guru-piket-date');
    const countEl = document.getElementById('guru-piket-count');
    if (nameEl) nameEl.textContent = session.nama_lengkap || session.nama || session.username || 'Guru Piket';
    if (dateEl) dateEl.textContent = UI.formatDateId();
    const combinedCount = getCombinedTodayPresensi().length;
    if (countEl) countEl.textContent = `${combinedCount} presensi tercatat hari ini`;
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

  function populateLaporanKelasOptions() {
    const sel = document.getElementById('guru-laporan-kelas');
    if (!sel) return;
    const prev = sel.value;
    const set = new Set();
    (STATE.santri || []).forEach((s) => {
      if (s.kelas) set.add(s.kelas);
    });
    if (set.size === 0) {
      CONFIG.KELAS_OPTIONS.slice(0, 6).forEach((k) => set.add(k));
    }
    sel.innerHTML =
      '<option value="Semua Kelas">Semua Kelas</option>' +
      Array.from(set)
        .sort()
        .map((k) => `<option value="${UI.esc(k)}">${UI.esc(k)}</option>`)
        .join('');
    if (prev && (prev === 'Semua Kelas' || set.has(prev))) {
      sel.value = prev;
    }
  }

  function updateAbsensiReportSummaryUI() {
    const kelasSel = document.getElementById('guru-laporan-kelas');
    const targetKelas = kelasSel ? kelasSel.value : 'Semua Kelas';
    const list = getCombinedTodayPresensi().filter((item) =>
      targetKelas === 'Semua Kelas' || !targetKelas ? true : item.kelas === targetKelas
    );

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

    const badge = document.getElementById('guru-absensi-submit-badge');
    const infoEl = document.getElementById('guru-absensi-submit-info');
    if (badge) {
      const matched = todaySetoranLogs.find(
        (log) =>
          log.kelas === targetKelas ||
          (targetKelas !== 'Semua Kelas' && log.kelas === 'Semua Kelas')
      );
      if (matched) {
        const jam = formatJamWIB(matched.waktu_submit);
        badge.className = 'status-badge status-hadir';
        badge.textContent = jam ? `Sudah Dikirim · ${jam}` : 'Sudah Dikirim';
        if (infoEl) {
          infoEl.textContent = `Disetor oleh ${matched.nama_guru} (${matched.kelas}).`;
        }
      } else {
        badge.className = 'status-badge status-sakit';
        badge.textContent = 'Belum Dikirim';
        if (infoEl) {
          infoEl.textContent = 'Klik tombol di bawah jika pencatatan absensi hari ini sudah selesai.';
        }
      }
    }

    return counts;
  }

  function renderSessionLogs() {
    const tbody = document.getElementById('guru-session-log-tbody');
    updateBanner(guruSession || {});
    updateAbsensiReportSummaryUI();
    if (!tbody) return;

    const combined = getCombinedTodayPresensi();
    if (combined.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5">
            ${UI.renderStateBox({
              type: 'empty',
              title: 'Belum ada presensi dicatat hari ini',
              message: 'Pindai kartu QR santri atau gunakan form Input Manual di atas.',
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
          <td class="mono-num">${UI.esc(item.waktu || '-')}</td>
          <td><strong>${UI.esc(item.nama_santri)}</strong></td>
          <td>${UI.esc(item.kelas || '-')}</td>
          <td><span class="status-badge ${statusBadgeClass(item.status)}">${UI.esc(item.status)}</span></td>
          <td>${UI.esc(item.metode)}${item.catatan ? ` · ${UI.esc(item.catatan)}` : ''}</td>
        </tr>
      `
      )
      .join('');
  }

  async function loadTodayPresensiAndSetoran() {
    const today = UI.todayISO();
    try {
      const presRes = await API.getPresensi();
      const raw = API.extractArray(presRes, ['presensi']);
      serverTodayPresensi = raw
        .filter((r) => toISODateWIB(r.tanggal) === today)
        .map(API.normalizePresensi)
        .reverse();
    } catch (err) {
      serverTodayPresensi = [];
    }

    try {
      const logRes = await API.getLogSetoran({ tanggal: today, jenis_laporan: 'Absensi Harian' });
      todaySetoranLogs = API.extractArray(logRes, ['log_setoran']).map(API.normalizeLogSetoran);
    } catch (err) {
      todaySetoranLogs = [];
    }

    renderSessionLogs();
  }

  async function ensureSantriLoaded() {
    if (STATE.santri.length > 0) {
      const statusEl = document.getElementById('guru-santri-sync-status');
      if (statusEl) {
        statusEl.textContent = `${STATE.santri.length} santri aktif siap untuk autocomplete dan verifikasi QR.`;
      }
      populateLaporanKelasOptions();
      return;
    }

    const statusEl = document.getElementById('guru-santri-sync-status');
    if (statusEl) statusEl.textContent = 'Memuat daftar santri dari database...';

    try {
      const res = await API.getSantri();
      STATE.santri = API.extractArray(res, ['santri', 'students']).map(API.normalizeSantri);
      populateLaporanKelasOptions();
      if (statusEl) {
        statusEl.textContent =
          STATE.santri.length > 0
            ? `${STATE.santri.length} santri aktif siap untuk autocomplete dan verifikasi QR.`
            : 'Database santri kosong. Pastikan santri sudah didaftarkan oleh Admin.';
      }
    } catch (err) {
      populateLaporanKelasOptions();
      if (statusEl) {
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
    if (lastBox) {
      lastBox.hidden = false;
      lastBox.className = 'inline-alert inline-alert-info';
      lastBox.innerHTML = `<i data-lucide="loader-2" class="spin-icon" aria-hidden="true"></i><span>Memproses presensi token <strong>${UI.esc(token)}</strong>...</span>`;
      UI.refreshIcons(lastBox);
    }

    try {
      const res = await API.savePresensi(payload);
      const d = res.data || res;
      const resolvedNama = API.pick(d, ['santri', 'nama_santri'], matched ? matched.nama_lengkap : token);
      const resolvedKelas = matched ? matched.kelas : '-';

      sessionPresensiLogs.unshift({
        id_presensi: d.id_presensi || '',
        waktu: waktu.slice(0, 5),
        nama_santri: resolvedNama,
        kelas: resolvedKelas,
        status: d.status || 'Hadir',
        metode: 'QR',
        catatan: payload.catatan,
      });
      renderSessionLogs();

      if (lastBox) {
        lastBox.className = 'inline-alert inline-alert-success';
        lastBox.innerHTML = `<i data-lucide="check-circle-2" aria-hidden="true"></i><div><strong>Presensi Hadir Tercatat: ${UI.esc(resolvedNama)}</strong><div style="font-size:0.8rem;">${UI.esc(resolvedKelas)} · ${UI.esc(waktu)}</div></div>`;
        UI.refreshIcons(lastBox);
      }
      UI.toast(`Presensi QR "${resolvedNama}" (Hadir) berhasil disimpan.`, 'success');
    } catch (err) {
      if (lastBox) {
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
        { fps: 10, qrbox: { width: 230, height: 230 } },
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
    const submitBtn = document.getElementById('btn-submit-presensi-manual');

    const laporanKelasSel = document.getElementById('guru-laporan-kelas');
    const laporanCatatanInp = document.getElementById('guru-laporan-catatan');
    const submitKepsekBtn = document.getElementById('btn-submit-absensi-kepsek');

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
      if (kelasInput) kelasInput.value = santri.kelas || '';
      closeAutocomplete();
    }

    function renderAutocomplete(query) {
      if (!acList || !namaInput) return;
      const q = String(query || '').trim().toLowerCase();
      const pool = STATE.santri || [];
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
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
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

        const waktu = UI.nowTimeHMS();
        const payload = {
          id_santri: matched ? matched.id_santri : '',
          qr_token: matched ? matched.qr_token : '',
          nama_santri: matched ? matched.nama_lengkap : nama,
          status: selectedStatus,
          tanggal,
          waktu,
          id_guru_piket: (guruSession && guruSession.id_user) || '',
          nama_guru_piket: (guruSession && (guruSession.nama_lengkap || guruSession.username)) || 'Guru Piket',
          metode: 'Manual',
          catatan,
        };

        UI.setButtonLoading(submitBtn, true, 'Menyimpan Presensi...');
        try {
          const res = await API.savePresensi(payload);
          const d = res.data || res;
          const resolvedNama = API.pick(d, ['santri', 'nama_santri'], payload.nama_santri);
          sessionPresensiLogs.unshift({
            id_presensi: d.id_presensi || '',
            waktu: waktu.slice(0, 5),
            nama_santri: resolvedNama,
            kelas: kelas || (matched ? matched.kelas : '-'),
            status: d.status || selectedStatus,
            metode: 'Manual',
            catatan,
          });
          renderSessionLogs();

          if (namaInput) namaInput.value = '';
          if (kelasInput) kelasInput.value = '';
          if (ketInput) ketInput.value = '';
          selectedSantri = null;
          UI.toast(`Presensi ${resolvedNama} (${selectedStatus}) berhasil disimpan.`, 'success');
        } catch (err) {
          UI.toast(err.message, 'error');
        } finally {
          UI.setButtonLoading(submitBtn, false);
        }
      });
    }

    if (laporanKelasSel) {
      laporanKelasSel.addEventListener('change', updateAbsensiReportSummaryUI);
    }

    if (submitKepsekBtn) {
      submitKepsekBtn.addEventListener('click', async () => {
        const kelas = laporanKelasSel ? laporanKelasSel.value : 'Semua Kelas';
        const counts = updateAbsensiReportSummaryUI();
        const catatan = laporanCatatanInp ? laporanCatatanInp.value.trim() : '';
        const summaryText = `Hadir ${counts.Hadir}, Sakit ${counts.Sakit}, Izin ${counts.Izin}, Alpa ${counts.Alpa}${catatan ? ` | Catatan: ${catatan}` : ''}`;

        UI.setButtonLoading(submitKepsekBtn, true, 'Mengirim ke Kepala Madrasah...');
        try {
          const res = await API.submitLaporanGuru({
            tanggal: UI.todayISO(),
            jenis_laporan: 'Absensi Harian',
            kelas,
            periode: '',
            id_guru: (guruSession && guruSession.id_user) || '',
            nama_guru: (guruSession && (guruSession.nama_lengkap || guruSession.username)) || 'Guru Piket',
            ringkasan: summaryText,
          });
          const saved = API.normalizeLogSetoran(res.data || res);
          todaySetoranLogs.unshift(saved);
          if (laporanCatatanInp) laporanCatatanInp.value = '';
          updateAbsensiReportSummaryUI();
          UI.toast(`Laporan Absensi Harian (${kelas}) berhasil dikirim ke Kepala Madrasah.`, 'success');
        } catch (err) {
          UI.toast(err.message, 'error');
        } finally {
          UI.setButtonLoading(submitKepsekBtn, false);
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
    updateBanner(guruSession);
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

    renderSessionLogs();
    ensureSantriLoaded();
    loadTodayPresensiAndSetoran();
  }

  function cleanup() {
    stopQRScanner();
  }

  root.MDTA_GURU = {
    init,
    cleanup,
  };
})(window);
