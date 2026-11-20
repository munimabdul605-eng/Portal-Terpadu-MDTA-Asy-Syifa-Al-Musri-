/**
 * Klien API Google Apps Script (Code.gs) & Utilitas UI Bersama
 * Semua request POST wajib memakai header 'Content-Type': 'text/plain;charset=utf-8'
 * agar bebas CORS preflight di GitHub Pages.
 */
(function (root) {
  'use strict';

  const CONFIG = root.MDTA_CONFIG;

  // =========================================================================
  // UTILITAS UI & AKSESIBILITAS (R-27, R-32, R-39)
  // =========================================================================
  function esc(value) {
    return String(value ?? '')
      .replace(/\s*\u2014\s*/g, ': ')
      .replace(/\u2014/g, ', ')
      .replace(/[&<>"']/g, function (c) {
        return {
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        }[c];
      });
  }

  function parseLocaleNumber(val, fallback) {
    if (typeof val === 'number') return Number.isFinite(val) ? val : (fallback ?? 0);
    if (val === null || val === undefined || val === '') return fallback ?? 0;
    const cleaned = String(val).trim().replace('%', '').replace(',', '.');
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : (fallback ?? 0);
  }

  function refreshIcons(scope) {
    if (root.lucide && typeof root.lucide.createIcons === 'function') {
      try {
        root.lucide.createIcons({
          root: scope || document,
          attrs: { 'aria-hidden': 'true' },
        });
      } catch (err) {
        // Abaikan jika ikon belum terpasang
      }
    }
  }

  function formatDateId(dateInput) {
    const d = dateInput ? new Date(dateInput) : new Date();
    if (Number.isNaN(d.getTime())) return String(dateInput || '-');
    return d.toLocaleDateString('id-ID', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  }

  function formatDateShort(dateInput) {
    if (!dateInput) return '-';
    const d = new Date(dateInput);
    if (Number.isNaN(d.getTime())) return String(dateInput);
    return d.toLocaleDateString('id-ID', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }

  function todayISO() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function nowTimeHMS() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function formatSheetDate(val) {
    if (!val) return '-';
    const s = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString('id-ID', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        timeZone: 'Asia/Jakarta',
      });
    }
    return s;
  }

  function formatSheetTime(val) {
    if (!val) return '';
    const s = String(val).trim();
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) return s;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleTimeString('id-ID', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Jakarta',
      });
    }
    return s;
  }

  // Toast Notification
  function toast(message, type) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const kind = type || 'info';
    const iconMap = {
      success: 'check-circle-2',
      error: 'alert-circle',
      warn: 'alert-triangle',
      info: 'info',
    };

    const el = document.createElement('div');
    el.className = `toast-item toast-${kind}`;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.innerHTML = `
      <i data-lucide="${iconMap[kind] || 'info'}" aria-hidden="true" style="width:18px;height:18px;flex-shrink:0;margin-top:2px;"></i>
      <div style="flex:1;min-width:0;">${esc(message)}</div>
      <button type="button" class="btn-icon-sm btn-secondary" aria-label="Tutup notifikasi" style="min-height:30px;min-width:30px;padding:0;border-radius:6px;">
        <i data-lucide="x" aria-hidden="true" style="width:14px;height:14px;"></i>
      </button>
    `;

    const closeBtn = el.querySelector('button');
    let timer = null;
    const removeToast = () => {
      if (timer) clearTimeout(timer);
      if (el.parentNode) el.parentNode.removeChild(el);
    };

    closeBtn.addEventListener('click', removeToast);
    container.appendChild(el);
    refreshIcons(el);
    timer = setTimeout(removeToast, 5200);
  }

  function setButtonLoading(btn, isLoading, loadingLabel) {
    if (!btn) return;
    if (isLoading) {
      if (!btn.dataset.origHtml) btn.dataset.origHtml = btn.innerHTML;
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      btn.innerHTML = `<i data-lucide="loader-2" class="spin-icon" aria-hidden="true"></i><span>${esc(
        loadingLabel || 'Memproses...'
      )}</span>`;
      refreshIcons(btn);
    } else {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      if (btn.dataset.origHtml) {
        btn.innerHTML = btn.dataset.origHtml;
        delete btn.dataset.origHtml;
        refreshIcons(btn);
      }
    }
  }

  function renderSkeletonRows(colCount, rowCount) {
    const rows = rowCount || 4;
    const cols = colCount || 5;
    let html = '';
    for (let r = 0; r < rows; r++) {
      html += '<tr class="table-skeleton-row">';
      for (let c = 0; c < cols; c++) {
        const w = c === 0 ? '42%' : c === cols - 1 ? '64%' : '78%';
        html += `<td><div class="skeleton-line" style="width:${w};"></div></td>`;
      }
      html += '</tr>';
    }
    return html;
  }

  function renderStateBox(opts) {
    const kind = opts.type || 'empty';
    const isErr = kind === 'error';
    const iconName = isErr ? 'alert-octagon' : kind === 'loading' ? 'loader-2' : 'inbox';
    const iconClass = kind === 'loading' ? 'spin-icon' : '';
    const actionBtn =
      opts.actionLabel && opts.actionId
        ? `<button type="button" id="${esc(opts.actionId)}" class="btn btn-secondary btn-sm" style="margin-top:6px;">
             <i data-lucide="${isErr ? 'rotate-cw' : 'plus'}" aria-hidden="true"></i>
             <span>${esc(opts.actionLabel)}</span>
           </button>`
        : '';

    return `
      <div class="state-box ${isErr ? 'state-box-error' : ''}" role="${isErr ? 'alert' : 'status'}">
        <i data-lucide="${iconName}" class="${iconClass}" aria-hidden="true" style="width:24px;height:24px;"></i>
        <strong style="font-size:0.95rem;">${esc(opts.title || 'Belum ada data')}</strong>
        <p style="margin:0;max-width:480px;font-size:0.85rem;" class="${isErr ? '' : 'text-muted'}">${esc(
      opts.message || ''
    )}</p>
        ${actionBtn}
      </div>
    `;
  }

  // =========================================================================
  // MODAL FOCUS TRAP & DIALOG KONFIRMASI
  // =========================================================================
  const modalStack = [];

  function getFocusable(container) {
    return Array.from(
      container.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => el.offsetParent !== null);
  }

  function openModal(modalId) {
    const backdrop = document.getElementById(modalId);
    if (!backdrop) return;

    const prevFocus = document.activeElement;
    backdrop.hidden = false;
    document.body.classList.add('modal-open');

    const panel = backdrop.querySelector('.modal-panel') || backdrop;
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeModal(modalId);
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = getFocusable(panel);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    function onBackdropClick(e) {
      if (e.target === backdrop) {
        closeModal(modalId);
      }
    }

    const entry = { id: modalId, prevFocus, onKeyDown, onBackdropClick };
    modalStack.push(entry);
    backdrop.addEventListener('keydown', onKeyDown);
    backdrop.addEventListener('click', onBackdropClick);

    refreshIcons(backdrop);
    requestAnimationFrame(() => {
      const focusable = getFocusable(panel);
      if (focusable.length > 0) focusable[0].focus();
    });
  }

  function closeModal(modalId) {
    const backdrop = document.getElementById(modalId);
    if (!backdrop || backdrop.hidden) return;

    backdrop.hidden = true;
    const idx = modalStack.findIndex((m) => m.id === modalId);
    if (idx >= 0) {
      const entry = modalStack.splice(idx, 1)[0];
      backdrop.removeEventListener('keydown', entry.onKeyDown);
      backdrop.removeEventListener('click', entry.onBackdropClick);
      if (entry.prevFocus && typeof entry.prevFocus.focus === 'function') {
        entry.prevFocus.focus();
      }
    }
    if (modalStack.length === 0) {
      document.body.classList.remove('modal-open');
    }
  }

  function confirmDialog(opts) {
    return new Promise((resolve) => {
      const modalId = 'modal-confirm';
      const titleEl = document.getElementById('confirm-modal-title');
      const msgEl = document.getElementById('confirm-modal-message');
      const okBtn = document.getElementById('btn-confirm-ok');
      const cancelBtn = document.getElementById('btn-confirm-cancel');
      const closeBtn = document.getElementById('btn-close-confirm-modal');

      if (!titleEl || !msgEl || !okBtn || !cancelBtn) {
        resolve(false);
        return;
      }

      titleEl.textContent = opts.title || 'Konfirmasi Tindakan';
      msgEl.textContent = opts.message || 'Apakah Anda yakin ingin melanjutkan tindakan ini?';
      okBtn.textContent = opts.confirmLabel || 'Lanjutkan';
      okBtn.className = opts.danger ? 'btn btn-danger' : 'btn btn-primary';

      let settled = false;
      const finish = (val) => {
        if (settled) return;
        settled = true;
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        if (closeBtn) closeBtn.removeEventListener('click', onCancel);
        closeModal(modalId);
        resolve(val);
      };

      const onOk = () => finish(true);
      const onCancel = () => finish(false);

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      if (closeBtn) closeBtn.addEventListener('click', onCancel);

      openModal(modalId);
    });
  }

  // =========================================================================
  // TABS DENGAN SLIDING PILL & DUKUNGAN KEYBOARD ARROW (R-32)
  // =========================================================================
  function initSlidingTabs(tablistEl, onSelect) {
    if (!tablistEl) return null;
    const tabs = Array.from(tablistEl.querySelectorAll('[role="tab"]'));
    const pill = tablistEl.querySelector('.tab-sliding-indicator');

    function positionPill(activeTab) {
      if (!pill || !activeTab) return;
      const x = activeTab.offsetLeft;
      const w = activeTab.offsetWidth;
      if (!w || w <= 0) {
        tablistEl.classList.remove('has-pill');
        pill.style.opacity = '0';
        return;
      }
      tablistEl.classList.add('has-pill');
      pill.style.width = `${w}px`;
      pill.style.transform = `translate3d(${x}px, 0, 0)`;
      pill.style.opacity = '1';
    }

    function activate(tabEl, emit) {
      if (!tabEl) return;
      tabs.forEach((t) => {
        const isTarget = t === tabEl;
        t.setAttribute('aria-selected', isTarget ? 'true' : 'false');
        t.setAttribute('tabindex', isTarget ? '0' : '-1');
        t.classList.toggle('active', isTarget);
        const panelId = t.getAttribute('aria-controls');
        if (panelId) {
          const panel = document.getElementById(panelId);
          if (panel) panel.hidden = !isTarget;
        }
      });
      requestAnimationFrame(() => positionPill(tabEl));
      if (emit && typeof onSelect === 'function') {
        onSelect(tabEl.dataset.tab || '', tabEl);
      }
    }

    tabs.forEach((tab, idx) => {
      tab.addEventListener('click', () => activate(tab, true));
      tab.addEventListener('keydown', (e) => {
        let nextIdx = idx;
        if (e.key === 'ArrowRight') nextIdx = (idx + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') nextIdx = 0;
        else if (e.key === 'End') nextIdx = tabs.length - 1;
        else return;
        e.preventDefault();
        tabs[nextIdx].focus();
        activate(tabs[nextIdx], true);
      });
    });

    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => {
        const current = tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0];
        positionPill(current);
      });
      ro.observe(tablistEl);
    }

    const initial = tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0];
    if (initial) activate(initial, false);

    return {
      selectByName: (name, emit) => {
        const found = tabs.find((t) => t.dataset.tab === name);
        if (found) activate(found, Boolean(emit));
      },
      reposition: () => {
        const current = tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0];
        positionPill(current);
      },
    };
  }

  const spotlightBound = new WeakSet();
  function bindSpotlights(scope) {
    const cards = (scope || document).querySelectorAll('.surface-card');
    cards.forEach((card) => {
      if (spotlightBound.has(card)) return;
      spotlightBound.add(card);
      card.addEventListener(
        'pointermove',
        (e) => {
          if (e.pointerType === 'touch') return;
          const r = card.getBoundingClientRect();
          card.style.setProperty('--mx', `${Math.round(e.clientX - r.left)}px`);
          card.style.setProperty('--my', `${Math.round(e.clientY - r.top)}px`);
        },
        { passive: true }
      );
    });
  }

  // =========================================================================
  // KLIEN FETCH GOOGLE APPS SCRIPT (SESUAI Code.gs)
  // =========================================================================
  async function parseGasResponse(response, action) {
    const text = await response.text();
    const trimmed = text.trim();

    if (!trimmed) {
      throw new Error(`Respons kosong dari server untuk aksi "${action}".`);
    }

    if (
      trimmed.startsWith('<!doctype') ||
      trimmed.startsWith('<!DOCTYPE') ||
      trimmed.startsWith('<html') ||
      (response.url && response.url.includes('accounts.google.com'))
    ) {
      const err = new Error(
        'Web App Google Apps Script masih mengarah ke login Google (302 ServiceLogin). Buka Google Sheets "Database Sistem MDTA" > Extensions > Apps Script > Deploy > Manage deployments dan set "Who has access" ke "Anyone".'
      );
      err.code = 'GAS_AUTH_REDIRECT';
      throw err;
    }

    let json;
    try {
      json = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`Format respons server tidak valid untuk "${action}".`);
    }

    if (
      json &&
      (json.status === 'error' ||
        json.ok === false ||
        json.success === false ||
        (typeof json.error === 'string' && json.error.length > 0))
    ) {
      throw new Error(json.message || json.error || `Permintaan "${action}" ditolak oleh server.`);
    }

    return json;
  }

  async function requestGet(action, params) {
    const url = new URL(CONFIG.GAS_WEB_APP_URL);
    url.searchParams.set('action', action);
    if (params && typeof params === 'object') {
      Object.keys(params).forEach((k) => {
        if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
          url.searchParams.set(k, String(params[k]));
        }
      });
    }

    let response;
    try {
      response = await fetch(url.toString(), {
        method: 'GET',
        redirect: 'follow',
      });
    } catch (err) {
      throw new Error(`Gagal terhubung ke server (${action}): periksa koneksi internet atau akses deployment Apps Script.`);
    }

    return parseGasResponse(response, action);
  }

  async function requestPost(action, payload) {
    let response;
    try {
      response = await fetch(CONFIG.GAS_WEB_APP_URL, {
        method: 'POST',
        redirect: 'follow',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8',
        },
        body: JSON.stringify(Object.assign({ action }, payload || {})),
      });
    } catch (err) {
      throw new Error(`Gagal mengirim data ke server (${action}): periksa koneksi internet atau akses Web App.`);
    }

    return parseGasResponse(response, action);
  }

  function pick(obj, keys, fallback) {
    if (!obj || typeof obj !== 'object') return fallback;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
        return obj[k];
      }
    }
    return fallback;
  }

  function extractArray(res, candidateKeys) {
    if (Array.isArray(res)) return res;
    if (!res || typeof res !== 'object') return [];
    const keys = (candidateKeys || []).concat(['data', 'items', 'rows', 'list', 'records', 'result']);
    for (let i = 0; i < keys.length; i++) {
      const v = res[keys[i]];
      if (Array.isArray(v)) return v;
    }
    if (res.data && typeof res.data === 'object') {
      for (let i = 0; i < keys.length; i++) {
        const v = res.data[keys[i]];
        if (Array.isArray(v)) return v;
      }
    }
    return [];
  }

  // Normalizer selaras kolom Database Sistem MDTA
  function normalizeSantri(raw) {
    const id = String(pick(raw, ['id_santri', 'id', 'nis'], ''));
    const nama = String(pick(raw, ['nama_lengkap', 'nama', 'name'], ''));
    const wa = String(pick(raw, ['no_wa_ortu', 'no_hp', 'hp', 'whatsapp'], ''));
    const token = String(pick(raw, ['qr_token', 'token', 'kode_qr'], id));
    return {
      id_santri: id,
      id: id,
      nama_lengkap: nama,
      nama: nama,
      kelas: String(pick(raw, ['kelas', 'rombel', 'class'], '')),
      no_wa_ortu: wa,
      no_hp: wa,
      qr_token: token,
      status: String(pick(raw, ['status', 'status_santri'], 'aktif')).toLowerCase(),
      created_at: String(pick(raw, ['created_at'], '')),
      raw: raw,
    };
  }

  function normalizeUser(raw) {
    const id = String(pick(raw, ['id_user', 'id', 'username'], ''));
    const nama = String(pick(raw, ['nama_lengkap', 'nama', 'name'], ''));
    return {
      id_user: id,
      id: id,
      username: String(pick(raw, ['username', 'user'], '')),
      nama_lengkap: nama,
      nama: nama,
      role: String(pick(raw, ['role', 'peran', 'level'], 'guru')).toLowerCase(),
      status_aktif: String(pick(raw, ['status_aktif', 'status'], 'aktif')).toLowerCase(),
      created_at: String(pick(raw, ['created_at'], '')),
      raw: raw,
    };
  }

  function normalizePresensi(raw) {
    return {
      id_presensi: String(pick(raw, ['id_presensi', 'id'], '')),
      tanggal: formatSheetDate(pick(raw, ['tanggal', 'tgl', 'date'], '')),
      waktu: formatSheetTime(pick(raw, ['waktu', 'jam', 'time'], '')),
      id_santri: String(pick(raw, ['id_santri'], '')),
      nama_santri: String(pick(raw, ['nama_santri', 'nama', 'santri'], '-')),
      kelas: String(pick(raw, ['kelas', 'rombel'], '-')),
      status: String(pick(raw, ['status', 'kehadiran'], 'Hadir')),
      id_guru_piket: String(pick(raw, ['id_guru_piket'], '')),
      nama_guru_piket: String(pick(raw, ['nama_guru_piket', 'guru_piket', 'guru'], '-')),
      metode: String(pick(raw, ['metode', 'sumber'], 'Manual')),
      catatan: String(pick(raw, ['catatan', 'keterangan'], '')),
    };
  }

  function normalizeRekap(raw) {
    const hadir = parseLocaleNumber(pick(raw, ['hadir', 'total_hadir'], 0), 0);
    const sakit = parseLocaleNumber(pick(raw, ['sakit', 'total_sakit'], 0), 0);
    const izin = parseLocaleNumber(pick(raw, ['izin', 'total_izin'], 0), 0);
    const alpa = parseLocaleNumber(pick(raw, ['alpa', 'alpha', 'total_alpa'], 0), 0);
    const total = parseLocaleNumber(pick(raw, ['total'], hadir + sakit + izin + alpa), 0);
    const rawPct = pick(raw, ['persentase', 'persen_kehadiran', 'persen'], null);
    const pct =
      rawPct !== null && rawPct !== ''
        ? Math.round(parseLocaleNumber(rawPct, 0) * 10) / 10
        : total > 0
        ? Math.round((hadir / total) * 1000) / 10
        : 0;

    return {
      id_santri: String(pick(raw, ['id_santri', 'id'], '')),
      nama_lengkap: String(pick(raw, ['nama_lengkap', 'nama', 'santri'], '-')),
      kelas: String(pick(raw, ['kelas', 'rombel'], '-')),
      hadir,
      sakit,
      izin,
      alpa,
      total,
      persentase: Number.isFinite(pct) ? pct : 0,
    };
  }

  function normalizeNilaiUAS(raw) {
    return {
      id_uas: String(pick(raw, ['id_uas', 'id'], '')),
      id_santri: String(pick(raw, ['id_santri'], '')),
      nama_santri: String(pick(raw, ['nama_santri', 'nama'], '-')),
      kelas: String(pick(raw, ['kelas'], '-')),
      periode: String(pick(raw, ['periode'], 'Ganjil 2026/2027')),
      skema_soal: String(pick(raw, ['skema_soal', 'skema'], '-')),
      pg_benar: parseLocaleNumber(pick(raw, ['pg_benar'], 0), 0),
      essay_benar: parseLocaleNumber(pick(raw, ['essay_benar'], 0), 0),
      setengah_benar: parseLocaleNumber(pick(raw, ['setengah_benar'], 0), 0),
      nilai_uas: parseLocaleNumber(pick(raw, ['nilai_uas'], 0), 0),
      id_guru: String(pick(raw, ['id_guru'], '')),
      updated_at: formatSheetDate(pick(raw, ['updated_at'], '')),
    };
  }

  function isSheetErrorValue(val) {
    if (val === null || val === undefined) return true;
    const s = String(val).trim();
    if (!s) return true;
    return /^#(ERROR!|NAME\?|VALUE!|REF!|DIV\/0!|N\/A|NUM!|NULL!)/i.test(s);
  }

  function computeRaportGrade(score) {
    const val = parseLocaleNumber(score, 0);
    if (val >= 90) {
      return { grade: 'A', code: 'A', keterangan: 'Sangat Baik', label: 'Sangat Baik', cls: 'status-hadir', isTuntas: true };
    }
    if (val >= 80) {
      return { grade: 'B', code: 'B', keterangan: 'Baik', label: 'Baik', cls: 'status-izin', isTuntas: true };
    }
    if (val >= 70) {
      return { grade: 'C', code: 'C', keterangan: 'Cukup', label: 'Cukup', cls: 'status-sakit', isTuntas: true };
    }
    return { grade: 'D', code: 'D', keterangan: 'Kurang', label: 'Kurang', cls: 'status-alpa', isTuntas: false };
  }

  function resolveRaportNilai(raw) {
    const src = raw || {};
    const nHarian = parseLocaleNumber(pick(src, ['n_harian', 'harian'], 0), 0);
    const nUas = parseLocaleNumber(pick(src, ['n_uas', 'uas'], 0), 0);
    const rawHadir = pick(src, ['n_kehadiran', 'kehadiran', 'absensi'], null);
    const nKehadiran = rawHadir !== null && rawHadir !== '' ? parseLocaleNumber(rawHadir, 100) : 100;
    const bH = parseLocaleNumber(pick(src, ['bobot_harian'], 40), 40);
    const bU = parseLocaleNumber(pick(src, ['bobot_uas'], 40), 40);
    const bK = parseLocaleNumber(pick(src, ['bobot_kehadiran'], 20), 20);
    const bSum = bH + bU + bK || 100;

    const computedAkhir = Math.round(((nHarian * bH + nUas * bU + nKehadiran * bK) / bSum) * 100) / 100;
    const rawAkhirVal = pick(src, ['n_akhir'], null);
    const parsedAkhir = !isSheetErrorValue(rawAkhirVal) ? parseLocaleNumber(rawAkhirVal, NaN) : NaN;
    const nAkhir = Number.isFinite(parsedAkhir) ? Math.round(parsedAkhir * 100) / 100 : computedAkhir;

    const pred = computeRaportGrade(nAkhir);
    const rawGrade = pick(src, ['grade'], null);
    const cleanGrade = !isSheetErrorValue(rawGrade) ? String(rawGrade).trim().toUpperCase() : '';
    const grade = ['A', 'B', 'C', 'D'].includes(cleanGrade) ? cleanGrade : pred.grade;

    const rawKet = pick(src, ['keterangan'], null);
    const keterangan = !isSheetErrorValue(rawKet) ? String(rawKet).trim() : computeRaportGrade(nAkhir).keterangan;

    return {
      n_harian: nHarian,
      n_uas: nUas,
      n_kehadiran: nKehadiran,
      bobot_harian: bH,
      bobot_uas: bU,
      bobot_kehadiran: bK,
      n_akhir: nAkhir,
      grade,
      keterangan,
      isTuntas: ['A', 'B', 'C'].includes(grade),
      cls: computeRaportGrade(nAkhir).cls,
    };
  }

  function normalizeNilaiRaport(raw) {
    const resolved = resolveRaportNilai(raw);
    return {
      id_raport: String(pick(raw, ['id_raport', 'id'], '')),
      id_santri: String(pick(raw, ['id_santri'], '')),
      nama_santri: String(pick(raw, ['nama_santri', 'nama'], '-')),
      kelas: String(pick(raw, ['kelas'], '')),
      periode: String(pick(raw, ['periode'], 'Ganjil 2026/2027')),
      n_harian: resolved.n_harian,
      n_uas: resolved.n_uas,
      n_kehadiran: resolved.n_kehadiran,
      bobot_harian: resolved.bobot_harian,
      bobot_uas: resolved.bobot_uas,
      bobot_kehadiran: resolved.bobot_kehadiran,
      n_akhir: resolved.n_akhir,
      grade: resolved.grade,
      keterangan: resolved.keterangan,
      updated_at: formatSheetDate(pick(raw, ['updated_at'], '')),
    };
  }

  function normalizeDokumen(raw) {
    const driveUrl = String(pick(raw, ['drive_url', 'url', 'webViewLink', 'link'], ''));
    const judul = String(pick(raw, ['judul', 'name', 'nama', 'title'], 'Tanpa Judul'));
    const isFolder = driveUrl.includes('/folders/') || /folder/i.test(judul);
    return {
      id_dokumen: String(pick(raw, ['id_dokumen', 'id'], '')),
      judul,
      kategori: String(pick(raw, ['kategori', 'category'], 'Arsip Resmi')),
      drive_id: String(pick(raw, ['drive_id', 'fileId'], '')),
      drive_url: driveUrl,
      diunggah_oleh: String(pick(raw, ['diunggah_oleh', 'uploader'], '-')),
      tanggal_upload: formatSheetDate(pick(raw, ['tanggal_upload', 'updated_at', 'date'], '')),
      isFolder,
    };
  }

  function normalizeLogSetoran(raw) {
    return {
      id_setoran: String(pick(raw, ['id_setoran', 'id'], '')),
      tanggal: String(pick(raw, ['tanggal'], '')),
      jenis_laporan: String(pick(raw, ['jenis_laporan'], '')),
      kelas: String(pick(raw, ['kelas'], 'Semua Kelas')),
      periode: String(pick(raw, ['periode'], '')),
      id_guru: String(pick(raw, ['id_guru'], '')),
      nama_guru: String(pick(raw, ['nama_guru'], '-')),
      ringkasan: String(pick(raw, ['ringkasan'], '')),
      waktu_submit: String(pick(raw, ['waktu_submit'], '')),
    };
  }

  function formatWhatsAppUrl(phone, text) {
    const rawDigits = String(phone || '').replace(/\D/g, '');
    if (!rawDigits) return '';
    let normalized = rawDigits;
    if (normalized.startsWith('0')) {
      normalized = '62' + normalized.slice(1);
    } else if (normalized.startsWith('8')) {
      normalized = '62' + normalized;
    }
    if (normalized.length < 9) return '';
    const msg = text ? `?text=${encodeURIComponent(text)}` : '';
    return `https://wa.me/${normalized}${msg}`;
  }

  root.MDTA_UI = {
    esc,
    parseLocaleNumber,
    refreshIcons,
    formatDateId,
    formatDateShort,
    todayISO,
    nowTimeHMS,
    toast,
    setButtonLoading,
    renderSkeletonRows,
    renderStateBox,
    openModal,
    closeModal,
    confirmDialog,
    initSlidingTabs,
    bindSpotlights,
  };

  root.MDTA_API = {
    requestGet,
    requestPost,
    pick,
    extractArray,
    parseLocaleNumber,
    isSheetErrorValue,
    computeRaportGrade,
    resolveRaportNilai,
    normalizeSantri,
    normalizeUser,
    normalizePresensi,
    normalizeRekap,
    normalizeNilaiUAS,
    normalizeNilaiRaport,
    normalizeDokumen,
    normalizeLogSetoran,
    formatWhatsAppUrl,

    ping: () => requestGet('ping'),
    login: (username, password) => requestPost('login', { username, password }),

    getDashboard: () => requestGet('getDashboard'),
    getUsers: () => requestGet('getUsers'),
    saveUser: (userData) => requestPost('saveUser', { data: userData }),
    deleteUser: (idUser) => requestPost('deleteUser', { id_user: idUser }),

    getSantri: () => requestGet('getSantri'),
    saveSantri: (santriData) => requestPost('saveSantri', { data: santriData }),
    deleteSantri: (idSantri) => requestPost('deleteSantri', { id_santri: idSantri }),

    getPresensi: () => requestGet('getPresensi'),
    savePresensi: (presensiData) => requestPost('savePresensi', { data: presensiData }),

    getRekapLaporan: (bulan, tahun) => requestGet('getRekapLaporan', { bulan, tahun }),

    getNilaiUAS: () => requestGet('getNilaiUAS'),
    saveNilaiUAS: (uasData) => requestPost('saveNilaiUAS', { data: uasData }),

    getNilaiRaport: () => requestGet('getNilaiRaport'),
    saveNilaiRaport: (itemsArray) => requestPost('saveNilaiRaport', { data: itemsArray }),

    getDokumenArsip: () => requestGet('getDokumenArsip'),
    uploadDokumenDrive: (docData) => requestPost('uploadDokumenDrive', { data: docData }),
    importNilaiAI: (aiData) => requestPost('importNilaiAI', { data: aiData }),

    submitLaporanGuru: (reportData) => requestPost('submitLaporanGuru', { data: reportData }),
    getLogSetoran: (params) => requestGet('getLogSetoran', params),
    getRekapKepsek: (tanggal, kelas) => requestGet('getRekapKepsek', { tanggal, kelas }),
  };
})(window);
