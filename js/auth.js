/**
 * Autentikasi, Manajemen Sesi (sessionStorage), Tema Terang/Gelap,
 * Indikator Progress Gulir Header, Cek Status Backend, dan Modal Arsip Dokumen Drive
 */
(function (root) {
  'use strict';

  const CONFIG = root.MDTA_CONFIG;
  const API = root.MDTA_API;
  const UI = root.MDTA_UI;

  let currentSession = null;
  const arsipState = {
    items: [],
    query: '',
    category: 'Semua',
  };

  // =========================================================================
  // TEMA TERANG / GELAP
  // =========================================================================
  function syncThemeUI() {
    const isDark = document.documentElement.classList.contains('dark');
    const btn = document.getElementById('btn-theme-toggle');
    const label = document.getElementById('theme-toggle-label');
    const iconHolder = document.getElementById('theme-toggle-icon-wrap');

    if (iconHolder) {
      iconHolder.innerHTML = `<i data-lucide="${isDark ? 'sun' : 'moon'}" aria-hidden="true"></i>`;
      UI.refreshIcons(iconHolder);
    }
    if (label) {
      label.textContent = isDark ? 'Terang' : 'Gelap';
    }
    if (btn) {
      btn.setAttribute('aria-pressed', isDark ? 'true' : 'false');
      btn.setAttribute('aria-label', isDark ? 'Aktifkan mode terang' : 'Aktifkan mode gelap');
    }
  }

  function initTheme() {
    syncThemeUI();
    const btn = document.getElementById('btn-theme-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const nextDark = !document.documentElement.classList.contains('dark');
      document.documentElement.classList.toggle('dark', nextDark);
      document.documentElement.classList.toggle('light', !nextDark);
      try {
        localStorage.setItem(CONFIG.THEME_KEY, nextDark ? 'dark' : 'light');
      } catch (err) {
        // Abaikan pembatasan penyimpanan lokal
      }
      syncThemeUI();
    });
  }

  // =========================================================================
  // INDIKATOR PROGRESS BAR GULIR DI ATAS HEADER
  // =========================================================================
  function initScrollProgress() {
    const bar = document.getElementById('scroll-progress-bar');
    if (!bar) return;

    let ticking = false;
    function updateBar() {
      ticking = false;
      const doc = document.documentElement;
      const maxScroll = Math.max(0, doc.scrollHeight - doc.clientHeight);
      const ratio = maxScroll > 0 ? Math.min(1, Math.max(0, window.scrollY / maxScroll)) : 0;
      bar.style.transform = `scaleX(${ratio})`;
    }

    function onScroll() {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(updateBar);
      }
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    updateBar();
  }

  // =========================================================================
  // CEK KONEKSI BACKEND GOOGLE APPS SCRIPT (?action=ping)
  // =========================================================================
  async function checkBackendHealth() {
    const banner = document.getElementById('api-status-banner');
    const textEl = document.getElementById('api-status-text');
    const iconEl = document.getElementById('api-status-icon');
    const retryBtn = document.getElementById('btn-recheck-api');
    if (!banner || !textEl) return;

    banner.hidden = false;
    banner.className = 'inline-alert inline-alert-info';
    if (iconEl) iconEl.innerHTML = '<i data-lucide="loader-2" class="spin-icon" aria-hidden="true" style="width:17px;height:17px;"></i>';
    textEl.textContent = 'Memeriksa koneksi Web App Google Apps Script...';
    UI.refreshIcons(banner);
    if (retryBtn) retryBtn.hidden = true;

    try {
      const res = await API.ping();
      banner.className = 'inline-alert inline-alert-success';
      if (iconEl) iconEl.innerHTML = '<i data-lucide="check-circle-2" aria-hidden="true" style="width:17px;height:17px;"></i>';
      textEl.textContent = res.message || 'API Sistem MDTA aktif dan siap digunakan.';
      if (retryBtn) retryBtn.hidden = true;
      UI.refreshIcons(banner);
    } catch (err) {
      banner.className = 'inline-alert inline-alert-warn';
      if (iconEl) iconEl.innerHTML = '<i data-lucide="alert-triangle" aria-hidden="true" style="width:17px;height:17px;"></i>';
      textEl.textContent = err.message;
      if (retryBtn) retryBtn.hidden = false;
      UI.refreshIcons(banner);
    }
  }

  // =========================================================================
  // ARSIP DOKUMEN GOOGLE DRIVE (GET getDokumenArsip)
  // =========================================================================
  function renderArsipList() {
    const container = document.getElementById('arsip-drive-list');
    if (!container) return;

    const q = arsipState.query.trim().toLowerCase();
    const cat = arsipState.category;

    const filtered = arsipState.items.filter((item) => {
      const matchCat =
        cat === 'Semua' || item.kategori.toLowerCase() === cat.toLowerCase();
      const matchQuery =
        !q ||
        item.judul.toLowerCase().includes(q) ||
        item.kategori.toLowerCase().includes(q) ||
        item.diunggah_oleh.toLowerCase().includes(q);
      return matchCat && matchQuery;
    });

    if (filtered.length === 0) {
      container.innerHTML = UI.renderStateBox({
        type: 'empty',
        title: q || cat !== 'Semua' ? 'Dokumen tidak ditemukan' : 'Arsip dokumen masih kosong',
        message:
          q || cat !== 'Semua'
            ? 'Tidak ada dokumen atau folder arsip yang cocok dengan filter saat ini.'
            : 'Belum ada entri pada sheet Dokumen_Arsip.',
      });
      UI.refreshIcons(container);
      return;
    }

    container.innerHTML = filtered
      .map((item) => {
        const iconName = item.isFolder
          ? 'folder'
          : item.kategori.toLowerCase().includes('pdf')
            ? 'file-text'
            : item.kategori.toLowerCase().includes('ai')
              ? 'scan-text'
              : 'file';

        const metaParts = [item.kategori];
        if (item.diunggah_oleh && item.diunggah_oleh !== '-') metaParts.push(`Oleh ${item.diunggah_oleh}`);
        if (item.tanggal_upload && item.tanggal_upload !== '-') metaParts.push(item.tanggal_upload);

        return `
          <div class="drive-item">
            <div class="drive-item-meta">
              <div class="stat-icon-pill status-izin" style="flex-shrink:0;">
                <i data-lucide="${iconName}" aria-hidden="true" style="width:17px;height:17px;"></i>
              </div>
              <div style="min-width:0;">
                <div class="drive-item-title">${UI.esc(item.judul)}</div>
                <div class="text-muted" style="font-size:0.78rem;">${UI.esc(metaParts.join(' · '))}</div>
              </div>
            </div>
            ${item.drive_url
            ? `<a href="${UI.esc(item.drive_url)}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">
                     <i data-lucide="external-link" aria-hidden="true"></i>
                     <span>${item.isFolder ? 'Buka Folder' : 'Buka Berkas'}</span>
                   </a>`
            : `<span class="text-muted" style="font-size:0.78rem;">Tautan kosong</span>`
          }
          </div>
        `;
      })
      .join('');

    UI.refreshIcons(container);
  }

  function isAdminSession(session) {
    return Boolean(session && String(session.role || '').trim().toLowerCase() === 'admin');
  }

  async function loadDokumenArsip(opts) {
    if (!isAdminSession(currentSession || getSession())) {
      UI.closeModal('modal-arsip-drive');
      UI.toast('Arsip Dokumen Drive hanya tersedia pada halaman Administrator.', 'warn');
      return;
    }
    const force = Boolean(opts && opts.force);
    const STATE = root.MDTA_STATE;
    const CACHE = root.MDTA_CACHE;
    const container = document.getElementById('arsip-drive-list');
    const folderLink = document.getElementById('arsip-drive-root-link');
    if (folderLink) {
      folderLink.href = CONFIG.DRIVE_ROOT_URL;
      folderLink.hidden = false;
    }
    if (!container) return;

    if (STATE && STATE.dokumenArsip.length === 0 && CACHE) {
      const cached = CACHE.read('dokumenArsip');
      if (cached && Array.isArray(cached.data)) STATE.dokumenArsip = cached.data;
    }

    const cachedItems = STATE && Array.isArray(STATE.dokumenArsip) ? STATE.dokumenArsip : [];
    if (cachedItems.length > 0) {
      arsipState.items = cachedItems.slice();
      renderArsipList();
    } else {
      container.innerHTML = UI.renderStateBox({
        type: 'loading',
        title: 'Memuat Arsip Dokumen Drive',
        message: 'Mengambil indeks dokumen dan folder dari Google Sheets Dokumen_Arsip...',
      });
      UI.refreshIcons(container);
    }

    if (!force && STATE && STATE.loaded && STATE.loaded.arsip && cachedItems.length > 0) {
      // Tetap sinkron diam-diam saat modal dibuka; tanpa spinner pemblokir
      API.getDokumenArsip()
        .then((res) => {
          const freshItems = API.extractArray(res, ['dokumen', 'arsip', 'files', 'folders']).map(API.normalizeDokumen);
          const changed = !CACHE || CACHE.hasChanged(arsipState.items, freshItems);
          if (STATE) {
            STATE.dokumenArsip = freshItems;
            if (STATE.loaded) STATE.loaded.arsip = true;
          }
          if (CACHE) CACHE.write('dokumenArsip', freshItems);
          if (changed) {
            arsipState.items = freshItems;
            renderArsipList();
          }
        })
        .catch(() => { });
      return;
    }

    try {
      const res = await API.getDokumenArsip();
      const rawItems = API.extractArray(res, ['dokumen', 'arsip', 'files', 'folders']);
      const freshItems = rawItems.map(API.normalizeDokumen);
      const changed = !CACHE || CACHE.hasChanged(arsipState.items, freshItems);
      if (STATE) {
        STATE.dokumenArsip = freshItems;
        if (STATE.loaded) STATE.loaded.arsip = true;
      }
      if (CACHE) CACHE.write('dokumenArsip', freshItems);
      if (changed || arsipState.items.length === 0) {
        arsipState.items = freshItems;
        renderArsipList();
      }
    } catch (err) {
      if (arsipState.items.length === 0) {
        container.innerHTML = UI.renderStateBox({
          type: 'error',
          title: 'Gagal Memuat Arsip Drive',
          message: err.message,
          actionLabel: 'Coba Lagi',
          actionId: 'btn-retry-arsip',
        });
        UI.refreshIcons(container);
        const retryBtn = document.getElementById('btn-retry-arsip');
        if (retryBtn) {
          retryBtn.addEventListener('click', () => loadDokumenArsip({ force: true }));
        }
      } else if (force) {
        UI.toast(err.message, 'error');
      }
    }
  }

  function initArsipModal() {
    const openBtn = document.getElementById('btn-arsip-drive');
    const closeBtn = document.getElementById('btn-close-arsip-modal');
    const refreshBtn = document.getElementById('btn-refresh-arsip');
    const searchInput = document.getElementById('arsip-search-input');
    const filterGroup = document.getElementById('arsip-category-filters');

    if (openBtn) {
      openBtn.addEventListener('click', () => {
        if (!isAdminSession(currentSession || getSession())) {
          UI.closeModal('modal-arsip-drive');
          UI.toast('Arsip Dokumen Drive hanya tersedia pada halaman Administrator.', 'warn');
          return;
        }
        arsipState.query = '';
        arsipState.category = 'Semua';
        if (searchInput) searchInput.value = '';
        if (filterGroup) {
          filterGroup.querySelectorAll('.filter-chip').forEach((c) => {
            c.setAttribute('aria-pressed', c.dataset.arsipCat === 'Semua' ? 'true' : 'false');
          });
        }
        UI.openModal('modal-arsip-drive');
        loadDokumenArsip({ force: false });
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', () => UI.closeModal('modal-arsip-drive'));
    }

    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => loadDokumenArsip({ force: true }));
    }

    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        arsipState.query = e.target.value || '';
        renderArsipList();
      });
    }

    if (filterGroup) {
      filterGroup.querySelectorAll('.filter-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          arsipState.category = chip.dataset.arsipCat || 'Semua';
          filterGroup.querySelectorAll('.filter-chip').forEach((c) => {
            c.setAttribute('aria-pressed', c === chip ? 'true' : 'false');
          });
          renderArsipList();
        });
      });
    }
  }

  // =========================================================================
  // SESI & ROUTING PORTAL (ADMIN / GURU / LOGIN)
  // =========================================================================
  function getSession() {
    try {
      const raw = sessionStorage.getItem(CONFIG.SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.role) return null;
      return parsed;
    } catch (err) {
      return null;
    }
  }

  function saveSession(sessionObj) {
    currentSession = sessionObj;
    sessionStorage.setItem(CONFIG.SESSION_KEY, JSON.stringify(sessionObj));
  }

  function updateSession(partial) {
    const base = currentSession || getSession();
    if (!base || !partial || typeof partial !== 'object') return base;
    const updated = Object.assign({}, base, partial);
    if (updated.kelas_ampu !== undefined) {
      updated.kelas_ampu = API.parseKelasAmpu(updated.kelas_ampu);
    }
    saveSession(updated);
    return updated;
  }

  function clearSession() {
    currentSession = null;
    sessionStorage.removeItem(CONFIG.SESSION_KEY);
    if (root.MDTA_CACHE && typeof root.MDTA_CACHE.clearAll === 'function') {
      root.MDTA_CACHE.clearAll();
    }
  }

  function updateHeaderAuthUI(session) {
    const chip = document.getElementById('header-user-chip');
    const nameEl = document.getElementById('header-user-name');
    const roleEl = document.getElementById('header-user-role');
    const logoutBtn = document.getElementById('btn-logout');
    const arsipBtn = document.getElementById('btn-arsip-drive');
    const adminAllowed = isAdminSession(session);

    if (arsipBtn) arsipBtn.hidden = !adminAllowed;
    if (!adminAllowed) {
      UI.closeModal('modal-arsip-drive');
    }

    if (session) {
      if (chip) chip.hidden = false;
      if (nameEl) nameEl.textContent = session.nama_lengkap || session.nama || session.username || 'Pengguna';
      if (roleEl) roleEl.textContent = session.role === 'admin' ? 'Admin' : 'Guru';
      if (logoutBtn) logoutBtn.hidden = false;
    } else {
      if (chip) chip.hidden = true;
      if (logoutBtn) logoutBtn.hidden = true;
    }
  }

  function routeToPortal(session) {
    const loginView = document.getElementById('view-login');
    const adminView = document.getElementById('view-admin');
    const guruView = document.getElementById('view-guru');

    if (!session) {
      if (root.MDTA_ADMIN && typeof root.MDTA_ADMIN.cleanup === 'function') {
        root.MDTA_ADMIN.cleanup();
      }
      if (root.MDTA_GURU && typeof root.MDTA_GURU.cleanup === 'function') {
        root.MDTA_GURU.cleanup();
      }
      if (loginView) loginView.hidden = false;
      if (adminView) adminView.hidden = true;
      if (guruView) guruView.hidden = true;
      updateHeaderAuthUI(null);
      return;
    }

    const role = String(session.role || '').toLowerCase();
    updateHeaderAuthUI(session);

    if (role === 'admin') {
      if (root.MDTA_GURU && typeof root.MDTA_GURU.cleanup === 'function') {
        root.MDTA_GURU.cleanup();
      }
      if (loginView) loginView.hidden = true;
      if (guruView) guruView.hidden = true;
      if (adminView) adminView.hidden = false;
      if (root.MDTA_ADMIN && typeof root.MDTA_ADMIN.init === 'function') {
        root.MDTA_ADMIN.init(session);
      }
    } else if (role === 'guru') {
      if (root.MDTA_ADMIN && typeof root.MDTA_ADMIN.cleanup === 'function') {
        root.MDTA_ADMIN.cleanup();
      }
      if (loginView) loginView.hidden = true;
      if (adminView) adminView.hidden = true;
      if (guruView) guruView.hidden = false;
      if (root.MDTA_GURU && typeof root.MDTA_GURU.init === 'function') {
        root.MDTA_GURU.init(session);
      }
    } else {
      clearSession();
      routeToPortal(null);
      UI.toast(`Peran akun "${session.role}" tidak dikenali oleh sistem.`, 'error');
    }

    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function extractSessionFromLoginResponse(res, fallbackUsername) {
    const dataBlock = (res && res.data) || res || {};
    const userObj = dataBlock.user || dataBlock.profile || dataBlock;
    const rawRole = String(API.pick(userObj, ['role', 'peran', 'level'], dataBlock.role || '')).trim().toLowerCase();
    const role = rawRole === 'admin' || rawRole === 'administrator' ? 'admin' : rawRole === 'guru' ? 'guru' : rawRole;
    if (!role) {
      throw new Error('Respons login tidak menyertakan role pengguna (admin atau guru).');
    }
    const namaLengkap = String(API.pick(userObj, ['nama_lengkap', 'nama', 'name'], fallbackUsername));
    const kelasAmpu = API.parseKelasAmpu(API.pick(userObj, ['kelas_ampu'], []));
    return {
      token: String(API.pick(dataBlock, ['token'], '')),
      id_user: String(API.pick(userObj, ['id_user', 'id'], '')),
      username: String(API.pick(userObj, ['username', 'user'], fallbackUsername)),
      nama_lengkap: namaLengkap,
      nama: namaLengkap,
      role,
      kelas_ampu: role === 'admin' ? [] : kelasAmpu,
      loginAt: new Date().toISOString(),
    };
  }

  function initLoginAndLogout() {
    const form = document.getElementById('form-login');
    const usernameInput = document.getElementById('login-username');
    const passwordInput = document.getElementById('login-password');
    const toggleBtn = document.getElementById('btn-toggle-password');
    const submitBtn = document.getElementById('btn-login-submit');
    const errorBox = document.getElementById('login-error-box');
    const errorMsg = document.getElementById('login-error-msg');
    const logoutBtn = document.getElementById('btn-logout');
    const recheckBtn = document.getElementById('btn-recheck-api');

    function showLoginError(msg) {
      if (!errorBox || !errorMsg) return;
      if (msg) {
        errorMsg.textContent = msg;
        errorBox.hidden = false;
      } else {
        errorMsg.textContent = '';
        errorBox.hidden = true;
      }
    }

    if (recheckBtn) {
      recheckBtn.addEventListener('click', checkBackendHealth);
    }

    if (toggleBtn && passwordInput) {
      toggleBtn.addEventListener('click', () => {
        const isPassword = passwordInput.type === 'password';
        passwordInput.type = isPassword ? 'text' : 'password';
        toggleBtn.setAttribute('aria-pressed', isPassword ? 'true' : 'false');
        toggleBtn.setAttribute('aria-label', isPassword ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi');
        toggleBtn.innerHTML = `<i data-lucide="${isPassword ? 'eye-off' : 'eye'}" aria-hidden="true"></i>`;
        UI.refreshIcons(toggleBtn);
      });
    }

    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        showLoginError('');

        const username = (usernameInput ? usernameInput.value : '').trim();
        const password = passwordInput ? passwordInput.value : '';

        if (!username || !password) {
          showLoginError('Masukkan username dan kata sandi terlebih dahulu.');
          if (!username && usernameInput) usernameInput.focus();
          else if (passwordInput) passwordInput.focus();
          return;
        }

        UI.setButtonLoading(submitBtn, true, 'Memverifikasi...');
        try {
          const res = await API.login(username, password);
          const session = extractSessionFromLoginResponse(res, username);
          saveSession(session);
          UI.toast(`Selamat datang, ${session.nama_lengkap}.`, 'success');
          routeToPortal(session);
        } catch (err) {
          showLoginError(err.message);
          UI.toast(err.message, 'error');
        } finally {
          UI.setButtonLoading(submitBtn, false);
        }
      });
    }

    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        if (root.MDTA_ADMIN && typeof root.MDTA_ADMIN.cleanup === 'function') {
          root.MDTA_ADMIN.cleanup();
        }
        if (root.MDTA_GURU && typeof root.MDTA_GURU.cleanup === 'function') {
          root.MDTA_GURU.cleanup();
        }
        clearSession();
        if (usernameInput) usernameInput.value = '';
        if (passwordInput) {
          passwordInput.value = '';
          passwordInput.type = 'password';
        }
        if (toggleBtn) {
          toggleBtn.setAttribute('aria-pressed', 'false');
          toggleBtn.setAttribute('aria-label', 'Tampilkan kata sandi');
          toggleBtn.innerHTML = '<i data-lucide="eye" aria-hidden="true"></i>';
          UI.refreshIcons(toggleBtn);
        }
        showLoginError('');
        routeToPortal(null);
        UI.toast('Anda telah keluar dari sistem.', 'info');
        if (usernameInput) usernameInput.focus();
      });
    }
  }

  // =========================================================================
  // INISIALISASI APLIKASI
  // =========================================================================
  document.addEventListener('DOMContentLoaded', () => {
    UI.refreshIcons(document);
    UI.bindSpotlights(document);
    initTheme();
    initScrollProgress();
    initArsipModal();
    initLoginAndLogout();
    checkBackendHealth();

    const footerYear = document.getElementById('footer-year');
    if (footerYear) {
      footerYear.textContent = String(new Date().getFullYear());
    }

    const existingSession = getSession();
    if (existingSession) {
      currentSession = existingSession;
      routeToPortal(existingSession);
    } else {
      routeToPortal(null);
    }
  });

  root.MDTA_AUTH = {
    getSession: () => currentSession || getSession(),
    updateSession,
    routeToPortal,
    checkBackendHealth,
  };
})(window);
