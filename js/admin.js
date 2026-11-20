/**
 * Portal Kepala Madrasah / Administrator (5 Tab) - MDTA ASY SYIFA AL MUSRI'
 * 1. Beranda Laporan:
 *    - Kartu Status Setoran Hari Ini (per kelas: Sudah Setor / Belum Setor)
 *    - Panel Rekap Absensi Harian (Filter Tanggal & Kelas, Hadir/Sakit/Izin/Alpa, Santri Tidak Hadir + Hubungi WA Orang Tua)
 *    - Panel Rekap Nilai Disetor Guru (Kartu per kelas, Lihat Detail Nilai, Cetak PDF Rekap)
 *    - Riwayat Lengkap Absensi & Kelola Akun Guru/Admin
 * 2. Database Santri (Pencarian real-time, Tambah/Edit/Hapus, Lihat/Unduh/Cetak Kartu QR)
 * 3. Rekap Laporan Bulanan (Filter Bulan/Tahun, Ekspor CSV, Cetak PDF, Unggah PDF ke Drive)
 * 4. Kalkulator UAS (modul bersama MDTA_CALC)
 * 5. Kalkulator Raport (modul bersama MDTA_CALC)
 */
(function (root) {
  'use strict';

  const CONFIG = root.MDTA_CONFIG;
  const STATE = root.MDTA_STATE;
  const API = root.MDTA_API;
  const UI = root.MDTA_UI;

  let initialized = false;
  let adminSession = null;
  let tabController = null;

  const localState = {
    riwayatHarian: [],
    riwayatFilterStatus: 'Semua',
    riwayatQuery: '',
    santriQuery: '',
    santriKelasFilter: '',
    currentQRData: null,
    rekapNilaiList: [],
    selectedNilaiCard: null,
    editingUserId: null,
    editingUserOriginalUsername: '',
    editingSantriId: null,
  };

  function statusBadgeClass(status) {
    const s = String(status || '').toLowerCase();
    if (s.includes('hadir')) return 'status-hadir';
    if (s.includes('sakit')) return 'status-sakit';
    if (s.includes('izin')) return 'status-izin';
    if (s.includes('alpa') || s.includes('alpha')) return 'status-alpa';
    return 'status-izin';
  }

  function gradeBadgeClass(grade) {
    const g = String(grade || '').trim().toUpperCase();
    if (g === 'A') return 'status-hadir';
    if (g === 'B') return 'status-izin';
    if (g === 'C') return 'status-sakit';
    return 'status-alpa';
  }

  function formatJamWIB(waktuStr) {
    if (!waktuStr) return '';
    const m = String(waktuStr).match(/(\d{1,2}):(\d{2})/);
    if (m) return `${m[1].padStart(2, '0')}.${m[2]} WIB`;
    return String(waktuStr);
  }

  function generateNextLocalId(list, field, prefix, padLen) {
    const used = new Set();
    const escapedPrefix = String(prefix || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp('^' + escapedPrefix + '(\\d+)$', 'i');
    let maxNum = 0;

    (Array.isArray(list) ? list : []).forEach((item) => {
      const val = String((item && item[field]) || '').trim();
      if (!val) return;
      used.add(val);
      const m = val.match(pattern);
      if (m) {
        const num = parseInt(m[1], 10);
        if (Number.isFinite(num) && num > maxNum) maxNum = num;
      }
    });

    let next = maxNum + 1;
    let candidate = prefix + String(next).padStart(padLen, '0');
    while (used.has(candidate)) {
      next++;
      candidate = prefix + String(next).padStart(padLen, '0');
    }
    return candidate;
  }

  // =========================================================================
  // TAB 1: BERANDA KEPALA MADRASAH & KELOLA AKUN
  // =========================================================================
  function renderDashboardStats(summary, totalCatatan) {
    const hadir = Number(summary.Hadir ?? summary.hadir);
    const sakit = Number(summary.Sakit ?? summary.sakit);
    const izin = Number(summary.Izin ?? summary.izin);
    const alpa = Number(summary.Alpa ?? summary.alpa);

    const hasNumbers = [hadir, sakit, izin, alpa].every((n) => Number.isFinite(n));
    const total = hasNumbers ? hadir + sakit + izin + alpa : (Number(totalCatatan) || 0);

    const map = [
      { id: 'stat-hadir', val: summary.Hadir ?? summary.hadir, pctId: 'stat-hadir-foot', label: 'Santri hadir' },
      { id: 'stat-sakit', val: summary.Sakit ?? summary.sakit, pctId: 'stat-sakit-foot', label: 'Keterangan sakit' },
      { id: 'stat-izin', val: summary.Izin ?? summary.izin, pctId: 'stat-izin-foot', label: 'Izin resmi' },
      { id: 'stat-alpa', val: summary.Alpa ?? summary.alpa, pctId: 'stat-alpa-foot', label: 'Tanpa keterangan' },
    ];

    map.forEach((item) => {
      const valEl = document.getElementById(item.id);
      const footEl = document.getElementById(item.pctId);
      const num = Number(item.val);
      if (valEl) valEl.textContent = Number.isFinite(num) ? String(num) : '-';
      if (footEl) {
        if (Number.isFinite(num) && total > 0) {
          const pct = Math.round((num / total) * 1000) / 10;
          footEl.textContent = `${pct}% dari ${total} catatan`;
        } else {
          footEl.textContent = item.label;
        }
      }
    });
  }

  function renderStatusSetoranHariIni(statusList) {
    const grid = document.getElementById('kepsek-setoran-grid');
    const summaryEl = document.getElementById('kepsek-setoran-summary');
    if (!grid) return;

    if (!Array.isArray(statusList) || statusList.length === 0) {
      if (summaryEl) summaryEl.textContent = 'Belum ada daftar kelas santri.';
      grid.innerHTML = UI.renderStateBox({
        type: 'empty',
        title: 'Belum ada data kelas terdaftar',
        message: 'Tambahkan data santri beserta kelasnya di tab Database Santri agar status setoran per kelas muncul.',
      });
      UI.refreshIcons(grid);
      return;
    }

    const doneCount = statusList.filter((item) => item.sudah_setor).length;
    if (summaryEl) {
      summaryEl.textContent = `${doneCount} dari ${statusList.length} kelas sudah menyetor laporan absensi hari ini`;
      summaryEl.className = `status-badge ${doneCount === statusList.length ? 'status-hadir' : 'status-sakit'}`;
    }

    grid.innerHTML = statusList
      .map((item) => {
        const jam = formatJamWIB(item.waktu_submit);
        return `
          <div class="setoran-class-card ${item.sudah_setor ? 'is-done' : 'is-pending'}">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
              <strong style="font-size:0.95rem;">${UI.esc(item.kelas)}</strong>
              <span class="status-badge ${item.sudah_setor ? 'status-hadir' : 'status-sakit'}">
                <i data-lucide="${item.sudah_setor ? 'check-circle-2' : 'clock'}" aria-hidden="true" style="width:14px;height:14px;"></i>
                <span>${item.sudah_setor ? 'Sudah Setor' : 'Belum Setor'}</span>
              </span>
            </div>
            <div class="text-muted" style="font-size:0.8125rem;">
              ${item.jumlah_santri} santri aktif
            </div>
            <div style="font-size:0.8125rem;">
              ${
                item.sudah_setor
                  ? `<span>Disetor oleh <strong>${UI.esc(item.nama_guru || 'Guru Piket')}</strong>${jam ? ` (${UI.esc(jam)})` : ''}</span>`
                  : `<span class="text-muted">Menunggu kiriman laporan dari guru piket.</span>`
              }
            </div>
          </div>
        `;
      })
      .join('');

    UI.refreshIcons(grid);
  }

  function renderSantriTidakHadir(list, tanggal) {
    const container = document.getElementById('kepsek-tidak-hadir-list');
    if (!container) return;

    if (!Array.isArray(list) || list.length === 0) {
      container.innerHTML = UI.renderStateBox({
        type: 'empty',
        title: 'Tidak ada santri absen pada tanggal ini',
        message: 'Seluruh santri yang tercatat pada tanggal terpilih berstatus Hadir, atau belum ada catatan ketidakhadiran.',
      });
      UI.refreshIcons(container);
      return;
    }

    const tglLabel = UI.formatDateShort(tanggal);
    container.innerHTML = `<div class="absent-list">${list
      .map((item) => {
        const pesanWA = `Assalamu'alaikum Bapak/Ibu Wali Santri dari ananda ${item.nama_santri} (${item.kelas}). Menginformasikan dari ${CONFIG.INSTITUTION_NAME} bahwa pada tanggal ${tglLabel} ananda tercatat tidak hadir dengan status: ${item.status}${item.catatan ? ` (${item.catatan})` : ''}. Mohon konfirmasinya. Terima kasih.`;
        const waUrl = API.formatWhatsAppUrl(item.no_wa_ortu, pesanWA);

        return `
          <div class="absent-student-item">
            <div style="min-width:0;flex:1 1 220px;">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <strong style="font-size:0.95rem;">${UI.esc(item.nama_santri)}</strong>
                <span class="text-muted" style="font-size:0.8125rem;">(${UI.esc(item.kelas)})</span>
                <span class="status-badge ${statusBadgeClass(item.status)}">${UI.esc(item.status)}</span>
              </div>
              <div class="text-muted" style="font-size:0.8125rem;margin-top:4px;">
                ${item.catatan ? `Keterangan: ${UI.esc(item.catatan)} · ` : ''}Dicatat oleh ${UI.esc(item.nama_guru_piket || '-')}
              </div>
            </div>
            <div>
              ${
                waUrl
                  ? `<a href="${UI.esc(waUrl)}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">
                       <i data-lucide="message-circle" aria-hidden="true"></i>
                       <span>Hubungi WA Orang Tua</span>
                     </a>`
                  : `<span class="text-muted" style="font-size:0.78rem;">No. WA orang tua belum diisi</span>`
              }
            </div>
          </div>
        `;
      })
      .join('')}</div>`;

    UI.refreshIcons(container);
  }

  function sanitizeRekapNilaiCard(card) {
    const rawRows = Array.isArray(card && card.detail_nilai) ? card.detail_nilai : [];
    const detailRows = rawRows.map((r) => {
      const resolved = API.resolveRaportNilai(r);
      return {
        id_raport: String(r.id_raport || ''),
        id_santri: String(r.id_santri || ''),
        nama_santri: String(r.nama_santri || '-'),
        kelas: String(r.kelas || (card && card.kelas) || ''),
        periode: String(r.periode || (card && card.periode) || ''),
        n_harian: resolved.n_harian,
        n_uas: resolved.n_uas,
        n_kehadiran: resolved.n_kehadiran,
        bobot_harian: resolved.bobot_harian,
        bobot_uas: resolved.bobot_uas,
        bobot_kehadiran: resolved.bobot_kehadiran,
        n_akhir: resolved.n_akhir,
        grade: resolved.grade,
        keterangan: resolved.keterangan,
        updated_at: String(r.updated_at || ''),
      };
    });

    const jumlahSantri = detailRows.length;
    const rataRata =
      jumlahSantri > 0
        ? Math.round((detailRows.reduce((s, item) => s + item.n_akhir, 0) / jumlahSantri) * 100) / 100
        : Number((card && card.rata_rata) || 0);
    const jumlahTuntas =
      jumlahSantri > 0
        ? detailRows.filter((item) => ['A', 'B', 'C'].includes(String(item.grade).toUpperCase())).length
        : Number((card && card.jumlah_tuntas) || 0);
    const jumlahPerluBimbingan =
      jumlahSantri > 0
        ? jumlahSantri - jumlahTuntas
        : Number((card && card.jumlah_perlu_bimbingan) || 0);

    return Object.assign({}, card, {
      jumlah_santri: jumlahSantri > 0 ? jumlahSantri : Number((card && card.jumlah_santri) || 0),
      rata_rata: rataRata,
      jumlah_tuntas: jumlahTuntas,
      jumlah_perlu_bimbingan: jumlahPerluBimbingan,
      detail_nilai: detailRows,
    });
  }

  function renderRekapNilaiDisetor(cards) {
    const grid = document.getElementById('kepsek-rekap-nilai-grid');
    localState.rekapNilaiList = (Array.isArray(cards) ? cards : []).map(sanitizeRekapNilaiCard);
    if (!grid) return;

    if (localState.rekapNilaiList.length === 0) {
      grid.innerHTML = UI.renderStateBox({
        type: 'empty',
        title: 'Belum ada rekapan nilai disetor',
        message: 'Nilai raport yang disetor oleh guru dari menu Kalkulator Raport atau UAS akan tampil otomatis di sini.',
      });
      UI.refreshIcons(grid);
      return;
    }

    grid.innerHTML = localState.rekapNilaiList
      .map((card, idx) => {
        const isSetor = card.status_setoran === 'Sudah Disetor';
        return `
          <article class="nilai-rekap-card">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
              <div>
                <h4 class="heading-md">${UI.esc(card.kelas)}</h4>
                <div class="text-muted" style="font-size:0.8125rem;">Periode ${UI.esc(card.periode || '-')}</div>
              </div>
              <span class="status-badge ${isSetor ? 'status-hadir' : 'status-sakit'}">
                ${UI.esc(card.status_setoran || 'Draft')}
              </span>
            </div>

            <div class="text-secondary" style="font-size:0.84rem;">
              <div>Guru Penyetor: <strong>${UI.esc(card.nama_guru || '-')}</strong></div>
              <div class="text-muted" style="font-size:0.78rem;">Tanggal Setor: ${UI.esc(UI.formatDateShort(card.tanggal_setor))}${card.waktu_submit ? ` (${UI.esc(formatJamWIB(card.waktu_submit))})` : ''}</div>
            </div>

            <div class="nilai-kpi-strip">
              <div class="nilai-kpi-box">
                <div class="nilai-kpi-val">${Number(card.rata_rata || 0).toFixed(1)}</div>
                <div class="nilai-kpi-lbl">Rata-rata Kelas</div>
              </div>
              <div class="nilai-kpi-box">
                <div class="nilai-kpi-val" style="color:var(--status-hadir-fg);">${Number(card.jumlah_tuntas || 0)}</div>
                <div class="nilai-kpi-lbl">Tuntas (A/B/C)</div>
              </div>
              <div class="nilai-kpi-box">
                <div class="nilai-kpi-val" style="color:var(--status-alpa-fg);">${Number(card.jumlah_perlu_bimbingan || 0)}</div>
                <div class="nilai-kpi-lbl">Perlu Bimbingan</div>
              </div>
            </div>

            <div class="toolbar-actions" style="justify-content:flex-end;">
              <button type="button" class="btn btn-secondary btn-sm" data-view-nilai-idx="${idx}">
                <i data-lucide="eye" aria-hidden="true"></i>
                <span>Lihat Detail Nilai</span>
              </button>
              <button type="button" class="btn btn-primary btn-sm" data-print-nilai-idx="${idx}">
                <i data-lucide="printer" aria-hidden="true"></i>
                <span>Cetak PDF Rekap</span>
              </button>
            </div>
          </article>
        `;
      })
      .join('');

    grid.querySelectorAll('button[data-view-nilai-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const card = localState.rekapNilaiList[Number(btn.dataset.viewNilaiIdx)];
        if (card) openDetailNilaiModal(card);
      });
    });

    grid.querySelectorAll('button[data-print-nilai-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const card = localState.rekapNilaiList[Number(btn.dataset.printNilaiIdx)];
        if (card) printKepsekNilaiCard(card);
      });
    });

    UI.refreshIcons(grid);
  }

  function openDetailNilaiModal(rawCard) {
    const card = sanitizeRekapNilaiCard(rawCard || {});
    localState.selectedNilaiCard = card;
    const title = document.getElementById('detail-nilai-modal-title');
    const sub = document.getElementById('detail-nilai-subtitle');
    const tbody = document.getElementById('detail-nilai-tbody');

    if (title) title.textContent = `Detail Nilai ${card.kelas}`;
    if (sub) {
      sub.textContent = `Periode ${card.periode} · Penyetor: ${card.nama_guru} · Rata-rata: ${Number(card.rata_rata || 0).toFixed(2)}`;
    }

    const rows = Array.isArray(card.detail_nilai) ? card.detail_nilai : [];
    if (tbody) {
      if (rows.length === 0) {
        tbody.innerHTML = `<tr class="table-state-row"><td colspan="7">${UI.renderStateBox({
          type: 'empty',
          title: 'Belum ada rincian nilai santri',
          message: 'Ringkasan setoran: ' + (card.ringkasan || 'Belum ada data nilai tersimpan untuk kelas ini.'),
        })}</td></tr>`;
        UI.refreshIcons(tbody);
      } else {
        tbody.innerHTML = rows
          .map(
            (r, idx) => `
            <tr>
              <td class="mono-num dn-no" data-label="No">${idx + 1}</td>
              <td class="dn-nama" data-label="Nama Santri"><strong>${UI.esc(r.nama_santri)}</strong></td>
              <td class="mono-num dn-harian" data-label="N. Harian">${UI.esc(r.n_harian)}</td>
              <td class="mono-num dn-uas" data-label="N. UAS">${UI.esc(r.n_uas)}</td>
              <td class="mono-num dn-hadir" data-label="Kehadiran">${UI.esc(r.n_kehadiran)}%</td>
              <td class="mono-num dn-akhir" data-label="Nilai Akhir"><strong>${Number(r.n_akhir || 0).toFixed(2)}</strong></td>
              <td class="dn-pred" data-label="Predikat"><span class="status-badge ${gradeBadgeClass(r.grade)} mono-num">${UI.esc(r.grade)} (${UI.esc(r.keterangan)})</span></td>
            </tr>
          `
          )
          .join('');
      }
    }

    UI.openModal('modal-detail-nilai');
  }

  function printKepsekNilaiCard(rawCard) {
    const card = sanitizeRekapNilaiCard(rawCard || {});
    const printMeta = document.getElementById('kepsek-nilai-print-meta');
    const printTbody = document.getElementById('kepsek-nilai-print-tbody');
    if (printMeta) {
      printMeta.textContent = `Kelas: ${card.kelas} · Periode: ${card.periode} · Penyetor: ${card.nama_guru} · Rata-rata Kelas: ${Number(card.rata_rata || 0).toFixed(2)}`;
    }
    if (printTbody) {
      const rows = Array.isArray(card.detail_nilai) ? card.detail_nilai : [];
      printTbody.innerHTML = rows
        .map(
          (r, i) => `
          <tr>
            <td>${i + 1}</td>
            <td>${UI.esc(r.nama_santri)}</td>
            <td>${UI.esc(r.n_harian)}</td>
            <td>${UI.esc(r.n_uas)}</td>
            <td>${UI.esc(r.n_kehadiran)}%</td>
            <td><strong>${Number(r.n_akhir || 0).toFixed(2)}</strong></td>
            <td>${UI.esc(r.grade)} (${UI.esc(r.keterangan)})</td>
          </tr>
        `
        )
        .join('');
    }
    document.body.classList.add('printing-kepsek-nilai');
    window.print();
    setTimeout(() => document.body.classList.remove('printing-kepsek-nilai'), 300);
  }

  function renderRiwayatTable() {
    const tbody = document.getElementById('admin-riwayat-tbody');
    if (!tbody) return;

    const q = localState.riwayatQuery.trim().toLowerCase();
    const st = localState.riwayatFilterStatus;
    const filtered = localState.riwayatHarian.filter((row) => {
      const matchStatus =
        st === 'Semua' || row.status.toLowerCase().includes(st.toLowerCase());
      const matchQuery =
        !q ||
        row.nama_santri.toLowerCase().includes(q) ||
        row.kelas.toLowerCase().includes(q) ||
        row.nama_guru_piket.toLowerCase().includes(q);
      return matchStatus && matchQuery;
    });

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr class="table-state-row">
          <td colspan="6">
            ${UI.renderStateBox({
              type: 'empty',
              title: 'Belum ada catatan presensi yang cocok',
              message:
                localState.riwayatHarian.length === 0
                  ? 'Belum ada catatan presensi untuk filter tanggal dan kelas saat ini.'
                  : 'Ubah filter status atau kata kunci pencarian untuk melihat data lainnya.',
            })}
          </td>
        </tr>
      `;
      UI.refreshIcons(tbody);
      return;
    }

    tbody.innerHTML = filtered
      .map(
        (r) => `
        <tr>
          <td class="mono-num" data-label="Tanggal &amp; Jam">${UI.esc(r.tanggal || '-')}${r.waktu ? ` <span class="text-muted">${UI.esc(r.waktu)}</span>` : ''}</td>
          <td class="mc-primary" data-label="Nama Santri"><strong>${UI.esc(r.nama_santri)}</strong></td>
          <td data-label="Kelas">${UI.esc(r.kelas)}</td>
          <td class="mc-status" data-label="Status"><span class="status-badge ${statusBadgeClass(r.status)}">${UI.esc(r.status)}</span></td>
          <td data-label="Metode">${UI.esc(r.metode)}</td>
          <td data-label="Guru Piket">${UI.esc(r.nama_guru_piket)}</td>
        </tr>
      `
      )
      .join('');
  }

  function renderUsersTable() {
    const tbody = document.getElementById('admin-users-tbody');
    if (!tbody) return;

    if (STATE.users.length === 0) {
      tbody.innerHTML = `
        <tr class="table-state-row">
          <td colspan="4">
            ${UI.renderStateBox({
              type: 'empty',
              title: 'Daftar akun belum tersedia',
              message: 'Klik "Tambah Pengguna" untuk mendaftarkan akun Kepala Madrasah atau Guru.',
            })}
          </td>
        </tr>
      `;
      UI.refreshIcons(tbody);
      return;
    }

    tbody.innerHTML = STATE.users
      .map(
        (u) => `
        <tr>
          <td class="usr-nama" data-label="Pengguna">
            <div style="font-weight:600;">${UI.esc(u.nama_lengkap || u.username)}</div>
            <div class="text-muted mono-num" style="font-size:0.78rem;">@${UI.esc(u.username)}</div>
          </td>
          <td class="usr-role" data-label="Peran">
            <span class="status-badge ${u.role === 'admin' ? 'status-hadir' : 'status-izin'}">
              ${u.role === 'admin' ? 'Kepala Madrasah / Admin' : 'Guru'}
            </span>
          </td>
          <td class="usr-status" data-label="Status">
            <span class="status-badge ${u.status_aktif === 'aktif' ? 'status-hadir' : 'status-sakit'}">
              ${u.status_aktif === 'aktif' ? 'Aktif' : 'Nonaktif'}
            </span>
          </td>
          <td class="usr-actions" data-label="Aksi">
            <div class="table-actions-cell">
              <button type="button" class="btn btn-secondary btn-icon-sm" data-edit-user="${UI.esc(u.id_user || u.username)}" aria-label="Edit pengguna ${UI.esc(u.nama_lengkap || u.username)}">
                <i data-lucide="pencil" aria-hidden="true"></i>
                <span class="mobile-only-btn-label">Edit</span>
              </button>
              <button type="button" class="btn btn-danger btn-icon-sm" data-delete-user="${UI.esc(u.id_user || u.username)}" data-user-label="${UI.esc(u.nama_lengkap || u.username)}" aria-label="Hapus pengguna ${UI.esc(u.nama_lengkap || u.username)}">
                <i data-lucide="trash-2" aria-hidden="true"></i>
                <span class="mobile-only-btn-label">Hapus</span>
              </button>
            </div>
          </td>
        </tr>
      `
      )
      .join('');

    tbody.querySelectorAll('button[data-edit-user]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.editUser;
        const found = STATE.users.find((u) => (u.id_user || u.username) === key);
        if (found) openUserModal(found);
      });
    });

    tbody.querySelectorAll('button[data-delete-user]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.deleteUser;
        const label = btn.dataset.userLabel || key;
        const found = STATE.users.find((u) => (u.id_user || u.username) === key);
        const targetId = found ? found.id_user : key;
        const ok = await UI.confirmDialog({
          title: 'Hapus Akun Pengguna',
          message: `Akun "${label}" akan dihapus dari daftar akses portal. Lanjutkan?`,
          confirmLabel: 'Hapus Akun',
          danger: true,
        });
        if (!ok) return;

        try {
          await API.deleteUser(targetId);
          STATE.users = STATE.users.filter((u) => (u.id_user || u.username) !== key);
          renderUsersTable();
          UI.toast(`Pengguna "${label}" berhasil dihapus.`, 'success');
        } catch (err) {
          UI.toast(err.message, 'error');
        }
      });
    });

    UI.refreshIcons(tbody);
  }

  function syncKepsekClassFilter(classesFromServer) {
    const sel = document.getElementById('kepsek-filter-kelas');
    if (!sel) return;
    const prev = sel.value;
    const set = new Set(Array.isArray(classesFromServer) ? classesFromServer : []);
    (STATE.santri || []).forEach((s) => {
      if (s.kelas) set.add(s.kelas);
    });
    sel.innerHTML =
      '<option value="">Semua Kelas</option>' +
      Array.from(set)
        .sort()
        .map((k) => `<option value="${UI.esc(k)}">${UI.esc(k)}</option>`)
        .join('');
    if (prev && set.has(prev)) sel.value = prev;
  }

  async function loadDashboard(showToastOnDone) {
    const refreshBtn = document.getElementById('btn-refresh-dashboard');
    const riwayatTbody = document.getElementById('admin-riwayat-tbody');
    const usersTbody = document.getElementById('admin-users-tbody');
    const updatedEl = document.getElementById('dashboard-last-updated');
    const noticeBox = document.getElementById('kepsek-backend-notice');
    const noticeMsg = document.getElementById('kepsek-backend-notice-msg');
    const penyetorEl = document.getElementById('kepsek-absensi-penyetor');

    const tanggalInp = document.getElementById('kepsek-filter-tanggal');
    const kelasSel = document.getElementById('kepsek-filter-kelas');
    if (tanggalInp && !tanggalInp.value) tanggalInp.value = UI.todayISO();
    const targetTanggal = tanggalInp ? tanggalInp.value : UI.todayISO();
    const targetKelas = kelasSel ? kelasSel.value : '';

    if (riwayatTbody) riwayatTbody.innerHTML = UI.renderSkeletonRows(6, 4);
    if (usersTbody) usersTbody.innerHTML = UI.renderSkeletonRows(4, 3);
    if (noticeBox) noticeBox.hidden = true;
    UI.setButtonLoading(refreshBtn, true, 'Memuat...');

    try {
      // 1. Coba muat Rekap Kepala Madrasah (getRekapKepsek)
      let kepsekOk = false;
      try {
        const rekapRes = await API.getRekapKepsek(targetTanggal, targetKelas);
        const rk = rekapRes.data || rekapRes;
        kepsekOk = true;

        syncKepsekClassFilter(rk.daftar_kelas);
        renderStatusSetoranHariIni(rk.status_setoran_hari_ini);

        const abs = rk.absensi_harian || {};
        renderDashboardStats(abs.agregat || {}, abs.agregat ? abs.agregat.total : 0);

        const setoranList = Array.isArray(abs.setoran) ? abs.setoran : [];
        if (penyetorEl) {
          if (setoranList.length > 0) {
            const latest = setoranList[0];
            penyetorEl.textContent = `Disetor oleh ${latest.nama_guru} (${latest.kelas}) pukul ${formatJamWIB(latest.waktu_submit) || '-'}`;
            penyetorEl.className = 'status-badge status-hadir';
          } else {
            penyetorEl.textContent = `Belum ada laporan absensi dikirim guru untuk ${UI.formatDateShort(targetTanggal)}`;
            penyetorEl.className = 'status-badge status-sakit';
          }
        }

        renderSantriTidakHadir(abs.santri_tidak_hadir || [], targetTanggal);
        renderRekapNilaiDisetor(rk.rekap_nilai || []);

        localState.riwayatHarian = (abs.riwayat || []).map(API.normalizePresensi);
      } catch (kErr) {
        if (noticeBox && noticeMsg) {
          noticeMsg.textContent =
            'Backend Apps Script Anda perlu diperbarui dengan kode terbaru (Code.gs) agar log setoran guru & filter tanggal aktif penuh. Ringkasan di bawah menampilkan data yang tersedia saat ini.';
          noticeBox.hidden = false;
        }
      }

      // 2. Muat data Dashboard & Pengguna
      const dashRes = await API.getDashboard();
      const d = dashRes.data || dashRes;
      STATE.dashboard = d;

      if (!kepsekOk) {
        renderDashboardStats(d.summary || {}, d.total_presensi);
        const rawRiwayat = Array.isArray(d.riwayat_presensi)
          ? d.riwayat_presensi
          : API.extractArray(dashRes, ['riwayat_presensi']);
        localState.riwayatHarian = rawRiwayat.map(API.normalizePresensi);
        renderSantriTidakHadir(
          localState.riwayatHarian.filter((r) => ['Sakit', 'Izin', 'Alpa'].includes(r.status)),
          targetTanggal
        );
        renderStatusSetoranHariIni([]);
        renderRekapNilaiDisetor([]);
      }

      renderRiwayatTable();

      const embeddedUsers = Array.isArray(d.daftar_pengguna)
        ? d.daftar_pengguna
        : API.extractArray(dashRes, ['daftar_pengguna', 'users']);
      if (embeddedUsers.length > 0) {
        STATE.users = embeddedUsers.map(API.normalizeUser);
        renderUsersTable();
      } else {
        const usersRes = await API.getUsers();
        STATE.users = API.extractArray(usersRes, ['daftar_pengguna', 'users']).map(API.normalizeUser);
        renderUsersTable();
      }

      if (updatedEl) {
        const totalSantri = Number.isFinite(Number(d.total_santri)) ? ` · ${d.total_santri} santri terdaftar` : '';
        updatedEl.textContent = `Terakhir diperbarui: ${new Date().toLocaleTimeString('id-ID')}${totalSantri}`;
      }
      if (showToastOnDone) {
        UI.toast('Laporan Kepala Madrasah berhasil diperbarui.', 'success');
      }
    } catch (err) {
      renderDashboardStats({ Hadir: null, Sakit: null, Izin: null, Alpa: null }, 0);
      if (riwayatTbody) {
        riwayatTbody.innerHTML = `<tr class="table-state-row"><td colspan="6">${UI.renderStateBox({
          type: 'error',
          title: 'Gagal memuat laporan',
          message: err.message,
          actionLabel: 'Muat Ulang',
          actionId: 'btn-retry-dashboard',
        })}</td></tr>`;
        UI.refreshIcons(riwayatTbody);
        const retryBtn = document.getElementById('btn-retry-dashboard');
        if (retryBtn) retryBtn.addEventListener('click', () => loadDashboard(false));
      }
      UI.toast(err.message, 'error');
    } finally {
      UI.setButtonLoading(refreshBtn, false);
    }
  }

  function closeUserModal() {
    localState.editingUserId = null;
    localState.editingUserOriginalUsername = '';
    const form = document.getElementById('form-user');
    if (form) form.reset();
    const idField = document.getElementById('user-id');
    if (idField) idField.value = '';
    UI.closeModal('modal-user');
  }

  function openUserModal(user) {
    const form = document.getElementById('form-user');
    if (form) form.reset();

    const title = document.getElementById('user-modal-title');
    const idField = document.getElementById('user-id');
    const namaField = document.getElementById('user-nama');
    const usernameField = document.getElementById('user-username');
    const passField = document.getElementById('user-password');
    const passHint = document.getElementById('user-password-hint');
    const roleField = document.getElementById('user-role');
    const statusField = document.getElementById('user-status');

    localState.editingUserId = null;
    localState.editingUserOriginalUsername = '';
    if (idField) idField.value = '';
    if (namaField) namaField.value = '';
    if (usernameField) usernameField.value = '';
    if (passField) {
      passField.value = '';
      passField.required = true;
    }
    if (roleField) roleField.value = 'guru';
    if (statusField) statusField.value = 'aktif';

    if (user) {
      localState.editingUserId = user.id_user || user.username || '';
      localState.editingUserOriginalUsername = user.username || '';
      if (title) title.textContent = 'Edit Pengguna / Guru';
      if (idField) idField.value = localState.editingUserId;
      if (namaField) namaField.value = user.nama_lengkap || '';
      if (usernameField) usernameField.value = user.username || '';
      if (passField) {
        passField.value = '';
        passField.required = false;
      }
      if (passHint) passHint.textContent = 'Kosongkan jika tidak ingin mengubah kata sandi.';
      if (roleField) roleField.value = user.role || 'guru';
      if (statusField) statusField.value = user.status_aktif || 'aktif';
    } else {
      if (title) title.textContent = 'Tambah Pengguna / Guru';
      if (passHint) passHint.textContent = 'Wajib diisi untuk akun baru.';
    }

    UI.openModal('modal-user');
  }

  function bindDashboardEvents() {
    const refreshBtn = document.getElementById('btn-refresh-dashboard');
    const filterTanggal = document.getElementById('kepsek-filter-tanggal');
    const filterKelas = document.getElementById('kepsek-filter-kelas');
    const searchInput = document.getElementById('admin-riwayat-search');
    const addUserBtn = document.getElementById('btn-add-user');
    const closeUserBtn = document.getElementById('btn-close-user-modal');
    const cancelUserBtn = document.getElementById('btn-cancel-user-modal');
    const userForm = document.getElementById('form-user');
    const saveUserBtn = document.getElementById('btn-save-user');

    const closeDetailBtn = document.getElementById('btn-close-detail-nilai');
    const tutupDetailBtn = document.getElementById('btn-tutup-detail-nilai');
    const printDetailBtn = document.getElementById('btn-print-detail-nilai');

    if (filterTanggal && !filterTanggal.value) filterTanggal.value = UI.todayISO();
    if (filterTanggal) filterTanggal.addEventListener('change', () => loadDashboard(false));
    if (filterKelas) filterKelas.addEventListener('change', () => loadDashboard(false));
    if (refreshBtn) refreshBtn.addEventListener('click', () => loadDashboard(true));

    if (closeDetailBtn) closeDetailBtn.addEventListener('click', () => UI.closeModal('modal-detail-nilai'));
    if (tutupDetailBtn) tutupDetailBtn.addEventListener('click', () => UI.closeModal('modal-detail-nilai'));
    if (printDetailBtn) {
      printDetailBtn.addEventListener('click', () => {
        if (localState.selectedNilaiCard) {
          printKepsekNilaiCard(localState.selectedNilaiCard);
        }
      });
    }

    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        localState.riwayatQuery = e.target.value || '';
        renderRiwayatTable();
      });
    }

    document.querySelectorAll('#admin-riwayat-status-filters .filter-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        localState.riwayatFilterStatus = chip.dataset.statusFilter || 'Semua';
        document.querySelectorAll('#admin-riwayat-status-filters .filter-chip').forEach((c) => {
          c.setAttribute('aria-pressed', c === chip ? 'true' : 'false');
        });
        renderRiwayatTable();
      });
    });

    if (addUserBtn) addUserBtn.addEventListener('click', () => openUserModal(null));
    if (closeUserBtn) closeUserBtn.addEventListener('click', closeUserModal);
    if (cancelUserBtn) cancelUserBtn.addEventListener('click', closeUserModal);

    if (userForm) {
      userForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const isEdit = Boolean(localState.editingUserId);
        const idUser = isEdit ? localState.editingUserId : generateNextLocalId(STATE.users || [], 'id_user', 'USR-', 3);
        const namaLengkap = document.getElementById('user-nama').value.trim();
        const username = document.getElementById('user-username').value.trim();
        const password = document.getElementById('user-password').value;
        const role = document.getElementById('user-role').value;
        const statusAktif = document.getElementById('user-status').value || 'aktif';

        if (!namaLengkap || !username) {
          UI.toast('Nama lengkap dan username wajib diisi.', 'error');
          return;
        }
        if (!isEdit && !password) {
          UI.toast('Kata sandi wajib diisi untuk pengguna baru.', 'error');
          return;
        }

        const dupUser = (STATE.users || []).find((u) => {
          const sameUsername = String(u.username || '').trim().toLowerCase() === username.toLowerCase();
          if (!sameUsername) return false;
          if (!isEdit) return true;
          return (u.id_user || u.username) !== localState.editingUserId;
        });
        if (dupUser) {
          UI.toast(`Username "${username}" sudah digunakan oleh akun lain.`, 'error');
          return;
        }

        const payload = {
          isEdit,
          id_user: idUser,
          username,
          nama_lengkap: namaLengkap,
          role,
          status_aktif: statusAktif,
        };
        if (isEdit && localState.editingUserOriginalUsername) {
          payload.original_username = localState.editingUserOriginalUsername;
        }
        if (password) payload.password = password;

        UI.setButtonLoading(saveUserBtn, true, 'Menyimpan...');
        try {
          await API.saveUser(payload);
          closeUserModal();
          UI.toast(`Akun "${namaLengkap}" berhasil disimpan.`, 'success');
          await loadDashboard(false);
        } catch (err) {
          UI.toast(err.message, 'error');
        } finally {
          UI.setButtonLoading(saveUserBtn, false);
        }
      });
    }
  }

  // =========================================================================
  // TAB 2: DATABASE SANTRI & KARTU QR (qrcode.js)
  // =========================================================================
  function generateQRToken(idHint) {
    if (idHint) return `QR-MDTA-${String(idHint).replace(/[^a-zA-Z0-9]/g, '')}`;
    const stamp = Date.now().toString(36).toUpperCase().slice(-4);
    return `QR-MDTA-S${stamp}`;
  }

  function syncClassFilterOptions() {
    const select = document.getElementById('santri-kelas-filter');
    const rekapSelect = document.getElementById('rekap-kelas-filter');
    const datalist = document.getElementById('modal-santri-kelas-list');

    const dynamicSet = new Set(CONFIG.KELAS_OPTIONS);
    (STATE.santri || []).forEach((s) => {
      if (s.kelas) dynamicSet.add(s.kelas);
    });
    const allClasses = Array.from(dynamicSet);

    if (datalist) {
      datalist.innerHTML = allClasses.map((k) => `<option value="${UI.esc(k)}"></option>`).join('');
    }
    [select, rekapSelect].forEach((el) => {
      if (!el) return;
      const cur = el.value;
      el.innerHTML =
        '<option value="">Semua Kelas</option>' +
        allClasses.map((k) => `<option value="${UI.esc(k)}">${UI.esc(k)}</option>`).join('');
      if (cur && allClasses.includes(cur)) el.value = cur;
    });
  }

  function renderSantriTable() {
    const tbody = document.getElementById('admin-santri-tbody');
    const countEl = document.getElementById('santri-count-label');
    if (!tbody) return;

    const q = localState.santriQuery.trim().toLowerCase();
    const kelasF = localState.santriKelasFilter;
    const filtered = STATE.santri.filter((s) => {
      const matchKelas = !kelasF || s.kelas === kelasF;
      const matchQ =
        !q ||
        s.nama_lengkap.toLowerCase().includes(q) ||
        s.id_santri.toLowerCase().includes(q) ||
        s.kelas.toLowerCase().includes(q) ||
        s.no_wa_ortu.toLowerCase().includes(q) ||
        s.qr_token.toLowerCase().includes(q);
      return matchKelas && matchQ;
    });

    if (countEl) {
      countEl.textContent = `Menampilkan ${filtered.length} dari ${STATE.santri.length} santri`;
    }

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr class="table-state-row">
          <td colspan="7">
            ${UI.renderStateBox({
              type: 'empty',
              title: STATE.santri.length === 0 ? 'Belum ada data santri' : 'Santri tidak ditemukan',
              message:
                STATE.santri.length === 0
                  ? 'Klik "Tambah Santri" untuk mendaftarkan santri baru.'
                  : 'Coba ubah kata kunci pencarian atau filter kelas.',
            })}
          </td>
        </tr>
      `;
      UI.refreshIcons(tbody);
      return;
    }

    tbody.innerHTML = filtered
      .map(
        (s) => `
        <tr>
          <td class="mono-num snt-id" data-label="ID Santri">${UI.esc(s.id_santri || '-')}</td>
          <td class="snt-nama" data-label="Nama Santri"><strong>${UI.esc(s.nama_lengkap)}</strong></td>
          <td class="snt-kelas" data-label="Kelas">${UI.esc(s.kelas || '-')}</td>
          <td class="mono-num snt-wa" data-label="No. WA Ortu">${UI.esc(s.no_wa_ortu || '-')}</td>
          <td class="snt-token" data-label="Token QR"><code class="mono-num" style="font-size:0.78rem;">${UI.esc(s.qr_token || '-')}</code></td>
          <td class="snt-status" data-label="Status">
            <span class="status-badge ${s.status === 'aktif' ? 'status-hadir' : 'status-sakit'}">
              ${s.status === 'aktif' ? 'Aktif' : UI.esc(s.status)}
            </span>
          </td>
          <td class="snt-actions" data-label="Aksi">
            <div class="table-actions-cell">
              <button type="button" class="btn btn-secondary btn-sm" data-qr-santri="${UI.esc(s.id_santri || s.qr_token)}">
                <i data-lucide="qr-code" aria-hidden="true"></i>
                <span>Lihat QR</span>
              </button>
              <button type="button" class="btn btn-secondary btn-icon-sm" data-edit-santri="${UI.esc(s.id_santri || s.qr_token)}" aria-label="Edit santri ${UI.esc(s.nama_lengkap)}">
                <i data-lucide="pencil" aria-hidden="true"></i>
                <span class="mobile-only-btn-label">Edit</span>
              </button>
              <button type="button" class="btn btn-danger btn-icon-sm" data-delete-santri="${UI.esc(s.id_santri || s.qr_token)}" aria-label="Hapus santri ${UI.esc(s.nama_lengkap)}">
                <i data-lucide="trash-2" aria-hidden="true"></i>
                <span class="mobile-only-btn-label">Hapus</span>
              </button>
            </div>
          </td>
        </tr>
      `
      )
      .join('');

    const findSantri = (key) =>
      STATE.santri.find((s) => (s.id_santri || s.qr_token) === key);

    tbody.querySelectorAll('button[data-qr-santri]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const s = findSantri(btn.dataset.qrSantri);
        if (s) openQRModal(s);
      });
    });

    tbody.querySelectorAll('button[data-edit-santri]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const s = findSantri(btn.dataset.editSantri);
        if (s) openSantriModal(s);
      });
    });

    tbody.querySelectorAll('button[data-delete-santri]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const s = findSantri(btn.dataset.deleteSantri);
        if (!s) return;
        const ok = await UI.confirmDialog({
          title: 'Hapus Data Santri',
          message: `Data santri "${s.nama_lengkap}" (${s.id_santri}) akan dihapus permanen. Lanjutkan?`,
          confirmLabel: 'Hapus Santri',
          danger: true,
        });
        if (!ok) return;

        try {
          await API.deleteSantri(s.id_santri);
          STATE.santri = STATE.santri.filter((item) => item !== s);
          renderSantriTable();
          UI.toast(`Data santri "${s.nama_lengkap}" berhasil dihapus.`, 'success');
        } catch (err) {
          UI.toast(err.message, 'error');
        }
      });
    });

    UI.refreshIcons(tbody);
  }

  async function loadSantri(showToast) {
    const tbody = document.getElementById('admin-santri-tbody');
    const refreshBtn = document.getElementById('btn-refresh-santri');
    if (tbody) tbody.innerHTML = UI.renderSkeletonRows(7, 5);
    UI.setButtonLoading(refreshBtn, true, 'Memuat...');

    try {
      const res = await API.getSantri();
      STATE.santri = API.extractArray(res, ['santri', 'students']).map(API.normalizeSantri);
      syncClassFilterOptions();
      renderSantriTable();
      if (showToast) UI.toast(`${STATE.santri.length} data santri dimuat.`, 'success');
    } catch (err) {
      if (tbody) {
        tbody.innerHTML = `<tr class="table-state-row"><td colspan="7">${UI.renderStateBox({
          type: 'error',
          title: 'Gagal memuat database santri',
          message: err.message,
          actionLabel: 'Coba Lagi',
          actionId: 'btn-retry-santri',
        })}</td></tr>`;
        UI.refreshIcons(tbody);
        const retryBtn = document.getElementById('btn-retry-santri');
        if (retryBtn) retryBtn.addEventListener('click', () => loadSantri(false));
      }
      UI.toast(err.message, 'error');
    } finally {
      UI.setButtonLoading(refreshBtn, false);
    }
  }

  function closeSantriModal() {
    localState.editingSantriId = null;
    const form = document.getElementById('form-santri');
    if (form) form.reset();
    const idEl = document.getElementById('santri-id');
    if (idEl) idEl.value = '';
    UI.closeModal('modal-santri');
  }

  function openSantriModal(santri) {
    const form = document.getElementById('form-santri');
    if (form) form.reset();

    const title = document.getElementById('santri-modal-title');
    localState.editingSantriId = santri ? (santri.id_santri || '') : null;

    document.getElementById('santri-id').value = santri ? (santri.id_santri || '') : '';
    document.getElementById('santri-nama').value = santri ? (santri.nama_lengkap || '') : '';
    document.getElementById('santri-kelas').value = santri ? (santri.kelas || '') : '';
    document.getElementById('santri-hp').value = santri ? (santri.no_wa_ortu || '') : '';
    document.getElementById('santri-qr-token').value =
      santri && santri.qr_token ? santri.qr_token : '';
    document.getElementById('santri-status').value = santri ? (santri.status || 'aktif') : 'aktif';

    if (title) title.textContent = santri ? `Edit Santri (${santri.id_santri})` : 'Tambah Santri Baru';
    UI.openModal('modal-santri');
  }

  function openQRModal(santri) {
    const token = santri.qr_token || santri.id_santri || santri.nama_lengkap;
    localState.currentQRData = {
      id_santri: santri.id_santri || '-',
      nama: santri.nama_lengkap,
      kelas: santri.kelas || '-',
      token,
    };

    document.getElementById('qr-card-nama').textContent = santri.nama_lengkap;
    document.getElementById('qr-card-meta').textContent = `${santri.kelas || '-'} · ID: ${santri.id_santri || '-'}`;
    document.getElementById('qr-card-token').textContent = token;

    const qrBox = document.getElementById('qr-render-target');
    qrBox.innerHTML = '';

    if (typeof root.QRCode === 'function') {
      new root.QRCode(qrBox, {
        text: token,
        width: 200,
        height: 200,
        colorDark: '#09090b',
        colorLight: '#ffffff',
        correctLevel: root.QRCode.CorrectLevel.H,
      });
    } else {
      qrBox.innerHTML = `<div class="text-muted" style="padding:20px;">Library qrcode.js belum termuat.</div>`;
    }

    UI.openModal('modal-qr');
  }

  function downloadQRCardPNG() {
    const data = localState.currentQRData;
    const qrBox = document.getElementById('qr-render-target');
    if (!data || !qrBox) return;

    const qrCanvas = qrBox.querySelector('canvas');
    const qrImg = qrBox.querySelector('img');

    const cardCanvas = document.createElement('canvas');
    cardCanvas.width = 480;
    cardCanvas.height = 600;
    const ctx = cardCanvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cardCanvas.width, cardCanvas.height);

    ctx.strokeStyle = '#09090b';
    ctx.lineWidth = 4;
    ctx.strokeRect(16, 16, cardCanvas.width - 32, cardCanvas.height - 32);

    ctx.fillStyle = '#09090b';
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('KARTU PRESENSI SANTRI MDTA', cardCanvas.width / 2, 62);

    ctx.fillStyle = '#52525b';
    ctx.font = '14px sans-serif';
    ctx.fillText("MDTA ASY SYIFA AL MUSRI' · Bojongsoang, Kab. Bandung", cardCanvas.width / 2, 88);

    const drawQrSource = (src) => {
      if (src) ctx.drawImage(src, 120, 120, 240, 240);
      ctx.fillStyle = '#09090b';
      ctx.font = 'bold 20px sans-serif';
      ctx.fillText(data.nama.slice(0, 32), cardCanvas.width / 2, 412);

      ctx.fillStyle = '#27272a';
      ctx.font = '15px sans-serif';
      ctx.fillText(`${data.kelas} | ID: ${data.id_santri}`, cardCanvas.width / 2, 444);

      ctx.fillStyle = '#52525b';
      ctx.font = '14px monospace';
      ctx.fillText(data.token, cardCanvas.width / 2, 484);

      const link = document.createElement('a');
      const safeName = data.nama.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      link.download = `Kartu-QR-${safeName || 'santri'}.png`;
      link.href = cardCanvas.toDataURL('image/png');
      link.click();
      UI.toast(`Kartu QR "${data.nama}" berhasil diunduh.`, 'success');
    };

    if (qrCanvas) {
      drawQrSource(qrCanvas);
    } else if (qrImg && qrImg.complete) {
      drawQrSource(qrImg);
    } else {
      UI.toast('Kode QR belum siap untuk diunduh.', 'warn');
    }
  }

  function bindSantriEvents() {
    const searchInput = document.getElementById('santri-search-input');
    const kelasSelect = document.getElementById('santri-kelas-filter');
    const refreshBtn = document.getElementById('btn-refresh-santri');
    const addBtn = document.getElementById('btn-add-santri');
    const closeSantriBtn = document.getElementById('btn-close-santri-modal');
    const cancelSantriBtn = document.getElementById('btn-cancel-santri-modal');
    const genTokenBtn = document.getElementById('btn-regen-qr-token');
    const santriForm = document.getElementById('form-santri');
    const saveSantriBtn = document.getElementById('btn-save-santri');

    const closeQrBtn = document.getElementById('btn-close-qr-modal');
    const downloadQrBtn = document.getElementById('btn-download-qr-png');
    const printQrBtn = document.getElementById('btn-print-qr-card');

    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        localState.santriQuery = e.target.value || '';
        renderSantriTable();
      });
    }
    if (kelasSelect) {
      kelasSelect.addEventListener('change', (e) => {
        localState.santriKelasFilter = e.target.value || '';
        renderSantriTable();
      });
    }
    if (refreshBtn) refreshBtn.addEventListener('click', () => loadSantri(true));
    if (addBtn) addBtn.addEventListener('click', () => openSantriModal(null));
    if (closeSantriBtn) closeSantriBtn.addEventListener('click', closeSantriModal);
    if (cancelSantriBtn) cancelSantriBtn.addEventListener('click', closeSantriModal);
    if (genTokenBtn) {
      genTokenBtn.addEventListener('click', () => {
        const idHint = localState.editingSantriId || document.getElementById('santri-id').value.trim();
        document.getElementById('santri-qr-token').value = generateQRToken(idHint);
      });
    }

    if (santriForm) {
      santriForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const isEdit = Boolean(localState.editingSantriId);
        const idSantri = isEdit ? localState.editingSantriId : generateNextLocalId(STATE.santri || [], 'id_santri', 'S-', 3);
        const namaLengkap = document.getElementById('santri-nama').value.trim();
        const kelas = document.getElementById('santri-kelas').value.trim();
        const noWaOrtu = document.getElementById('santri-hp').value.trim();
        const qrToken = document.getElementById('santri-qr-token').value.trim();
        const status = document.getElementById('santri-status').value || 'aktif';

        if (!namaLengkap) {
          UI.toast('Nama lengkap santri wajib diisi.', 'error');
          return;
        }

        const payload = {
          isEdit,
          id_santri: idSantri,
          nama_lengkap: namaLengkap,
          kelas,
          no_wa_ortu: noWaOrtu,
          qr_token: qrToken,
          status,
        };

        UI.setButtonLoading(saveSantriBtn, true, 'Menyimpan...');
        try {
          await API.saveSantri(payload);
          closeSantriModal();
          UI.toast(`Data santri "${namaLengkap}" berhasil disimpan.`, 'success');
          await loadSantri(false);
        } catch (err) {
          UI.toast(err.message, 'error');
        } finally {
          UI.setButtonLoading(saveSantriBtn, false);
        }
      });
    }

    if (closeQrBtn) closeQrBtn.addEventListener('click', () => UI.closeModal('modal-qr'));
    if (downloadQrBtn) downloadQrBtn.addEventListener('click', downloadQRCardPNG);
    if (printQrBtn) {
      printQrBtn.addEventListener('click', () => {
        document.body.classList.add('printing-qr-card');
        window.print();
        setTimeout(() => document.body.classList.remove('printing-qr-card'), 300);
      });
    }
  }

  // =========================================================================
  // TAB 3: REKAP LAPORAN BULANAN
  // =========================================================================
  function getFilteredRekapRows() {
    const kelasF = document.getElementById('rekap-kelas-filter')?.value || '';
    return STATE.rekap.filter((r) => (!kelasF ? true : r.kelas === kelasF));
  }

  function renderRekapTable() {
    const tbody = document.getElementById('admin-rekap-tbody');
    const periodEl = document.getElementById('rekap-period-label');
    if (!tbody) return;

    const bulan = Number(document.getElementById('rekap-bulan').value) || 1;
    const tahun = Number(document.getElementById('rekap-tahun').value) || new Date().getFullYear();
    const bulanNama = CONFIG.MONTH_NAMES[bulan - 1] || String(bulan);
    const rows = getFilteredRekapRows();

    if (periodEl) {
      periodEl.textContent = `Periode: ${bulanNama} ${tahun} (${rows.length} santri)`;
    }

    if (rows.length === 0) {
      tbody.innerHTML = `
        <tr class="table-state-row">
          <td colspan="9">
            ${UI.renderStateBox({
              type: 'empty',
              title: 'Belum ada data rekap pada periode ini',
              message: `Tidak ditemukan data presensi untuk bulan ${bulanNama} ${tahun}. Pilih periode lain atau muat ulang.`,
            })}
          </td>
        </tr>
      `;
      UI.refreshIcons(tbody);
      return;
    }

    tbody.innerHTML = rows
      .map(
        (r, idx) => `
        <tr>
          <td class="mono-num rkp-no" data-label="No">${idx + 1}</td>
          <td class="mono-num rkp-id" data-label="ID Santri">${UI.esc(r.id_santri || '-')}</td>
          <td class="rkp-nama" data-label="Nama Santri"><strong>${UI.esc(r.nama_lengkap)}</strong></td>
          <td class="rkp-kelas" data-label="Kelas">${UI.esc(r.kelas)}</td>
          <td class="mono-num rkp-h" data-label="Hadir">${r.hadir}</td>
          <td class="mono-num rkp-s" data-label="Sakit">${r.sakit}</td>
          <td class="mono-num rkp-i" data-label="Izin">${r.izin}</td>
          <td class="mono-num rkp-a" data-label="Alpa">${r.alpa}</td>
          <td class="rkp-pct" data-label="Kehadiran">
            <span class="status-badge mono-num ${r.persentase >= 80 ? 'status-hadir' : r.persentase >= 60 ? 'status-sakit' : 'status-alpa'}">
              ${r.persentase}%
            </span>
          </td>
        </tr>
      `
      )
      .join('');
  }

  async function loadRekapLaporan(showToast) {
    const tbody = document.getElementById('admin-rekap-tbody');
    const fetchBtn = document.getElementById('btn-fetch-rekap');
    const bulan = document.getElementById('rekap-bulan').value;
    const tahun = document.getElementById('rekap-tahun').value;

    if (tbody) tbody.innerHTML = UI.renderSkeletonRows(9, 5);
    UI.setButtonLoading(fetchBtn, true, 'Memuat...');

    try {
      const res = await API.getRekapLaporan(bulan, tahun);
      STATE.rekap = API.extractArray(res, ['rekap', 'laporan', 'summary']).map(API.normalizeRekap);
      STATE.lastRekapPeriod = { bulan, tahun };
      renderRekapTable();
      if (showToast) UI.toast(`Rekap laporan ${CONFIG.MONTH_NAMES[Number(bulan) - 1]} ${tahun} dimuat.`, 'success');
    } catch (err) {
      STATE.rekap = [];
      if (tbody) {
        tbody.innerHTML = `<tr class="table-state-row"><td colspan="9">${UI.renderStateBox({
          type: 'error',
          title: 'Gagal memuat rekap laporan',
          message: err.message,
          actionLabel: 'Coba Lagi',
          actionId: 'btn-retry-rekap',
        })}</td></tr>`;
        UI.refreshIcons(tbody);
        const retryBtn = document.getElementById('btn-retry-rekap');
        if (retryBtn) retryBtn.addEventListener('click', () => loadRekapLaporan(false));
      }
      UI.toast(err.message, 'error');
    } finally {
      UI.setButtonLoading(fetchBtn, false);
    }
  }

  function exportRekapCSV() {
    const rows = getFilteredRekapRows();
    if (rows.length === 0) {
      UI.toast('Belum ada data rekap untuk diekspor ke CSV.', 'warn');
      return;
    }

    const bulan = Number(document.getElementById('rekap-bulan').value) || 1;
    const tahun = document.getElementById('rekap-tahun').value;
    const bulanNama = CONFIG.MONTH_NAMES[bulan - 1] || String(bulan);

    const escapeCsv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const headers = ['No', 'ID Santri', 'Nama Lengkap', 'Kelas', 'Hadir', 'Sakit', 'Izin', 'Alpa', 'Total Pertemuan', 'Persentase Kehadiran (%)'];
    const lines = [headers.map(escapeCsv).join(',')];

    rows.forEach((r, idx) => {
      lines.push(
        [idx + 1, r.id_santri || '-', r.nama_lengkap, r.kelas, r.hadir, r.sakit, r.izin, r.alpa, r.total, `${r.persentase}%`]
          .map(escapeCsv)
          .join(',')
      );
    });

    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Rekap-Presensi-MDTA-${bulanNama}-${tahun}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    UI.toast(`File CSV Rekap ${bulanNama} ${tahun} berhasil diunduh.`, 'success');
  }

  function generateRekapPDFBase64(bulanNama, tahun) {
    if (!root.jspdf || typeof root.jspdf.jsPDF !== 'function') {
      throw new Error('Library jsPDF belum termuat. Gunakan opsi unggah berkas PDF dari perangkat Anda.');
    }
    const rows = getFilteredRekapRows();
    const doc = new root.jspdf.jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    doc.setFontSize(14);
    doc.text(CONFIG.INSTITUTION_NAME, 14, 18);
    doc.setFontSize(11);
    doc.text(`Rekap Laporan Presensi MDTA: ${bulanNama} ${tahun}`, 14, 25);
    doc.setFontSize(9);
    doc.text(`Dicetak pada: ${UI.formatDateShort(new Date())}`, 14, 31);

    let y = 40;
    doc.setFontSize(9);
    doc.text('No', 14, y);
    doc.text('ID', 24, y);
    doc.text('Nama Santri', 42, y);
    doc.text('Kelas', 108, y);
    doc.text('H', 136, y);
    doc.text('S', 148, y);
    doc.text('I', 160, y);
    doc.text('A', 172, y);
    doc.text('%', 186, y);
    doc.line(14, y + 2, 196, y + 2);
    y += 8;

    rows.forEach((r, idx) => {
      if (y > 275) {
        doc.addPage();
        y = 20;
      }
      doc.text(String(idx + 1), 14, y);
      doc.text(String(r.id_santri || '-').slice(0, 8), 24, y);
      doc.text(String(r.nama_lengkap).slice(0, 32), 42, y);
      doc.text(String(r.kelas || '-').slice(0, 14), 108, y);
      doc.text(String(r.hadir), 136, y);
      doc.text(String(r.sakit), 148, y);
      doc.text(String(r.izin), 160, y);
      doc.text(String(r.alpa), 172, y);
      doc.text(`${r.persentase}%`, 186, y);
      y += 7;
    });

    const dataUri = doc.output('datauristring');
    return dataUri.includes(',') ? dataUri.split(',')[1] : dataUri;
  }

  function bindRekapEvents() {
    const bulanSelect = document.getElementById('rekap-bulan');
    const tahunInput = document.getElementById('rekap-tahun');
    const kelasSelect = document.getElementById('rekap-kelas-filter');
    const fetchBtn = document.getElementById('btn-fetch-rekap');
    const csvBtn = document.getElementById('btn-export-rekap-csv');
    const printBtn = document.getElementById('btn-print-rekap-pdf');
    const openUploadBtn = document.getElementById('btn-open-upload-pdf');

    const closeUploadBtn = document.getElementById('btn-close-upload-pdf-modal');
    const cancelUploadBtn = document.getElementById('btn-cancel-upload-pdf');
    const uploadForm = document.getElementById('form-upload-pdf');
    const fileInput = document.getElementById('upload-pdf-file');
    const submitUploadBtn = document.getElementById('btn-submit-upload-pdf');

    const now = new Date();
    if (bulanSelect) bulanSelect.value = String(now.getMonth() + 1);
    if (tahunInput) tahunInput.value = String(now.getFullYear());

    if (kelasSelect) kelasSelect.addEventListener('change', renderRekapTable);
    if (fetchBtn) fetchBtn.addEventListener('click', () => loadRekapLaporan(true));
    if (csvBtn) csvBtn.addEventListener('click', exportRekapCSV);
    if (printBtn) {
      printBtn.addEventListener('click', () => {
        const bulan = Number(bulanSelect.value) || 1;
        const tahun = tahunInput.value;
        const metaEl = document.getElementById('rekap-print-meta');
        if (metaEl) {
          metaEl.textContent = `Periode: ${CONFIG.MONTH_NAMES[bulan - 1] || bulan} ${tahun}`;
        }
        document.body.classList.add('printing-rekap');
        window.print();
        setTimeout(() => document.body.classList.remove('printing-rekap'), 300);
      });
    }

    if (openUploadBtn) {
      openUploadBtn.addEventListener('click', () => {
        const bulan = Number(bulanSelect.value) || 1;
        const tahun = tahunInput.value;
        const bulanNama = CONFIG.MONTH_NAMES[bulan - 1] || String(bulan);
        const nameInp = document.getElementById('upload-pdf-filename');
        if (nameInp) nameInp.value = `Rekap-Presensi-MDTA-${bulanNama}-${tahun}.pdf`;
        if (fileInput) fileInput.value = '';
        UI.openModal('modal-upload-pdf');
      });
    }

    if (closeUploadBtn) closeUploadBtn.addEventListener('click', () => UI.closeModal('modal-upload-pdf'));
    if (cancelUploadBtn) cancelUploadBtn.addEventListener('click', () => UI.closeModal('modal-upload-pdf'));

    if (uploadForm) {
      uploadForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const filename = document.getElementById('upload-pdf-filename').value.trim() || 'Rekap-Presensi-MDTA.pdf';
        const mode = document.querySelector('input[name="uploadPdfMode"]:checked')?.value || 'snapshot';
        const bulan = Number(bulanSelect.value) || 1;
        const tahun = tahunInput.value;
        const bulanNama = CONFIG.MONTH_NAMES[bulan - 1] || String(bulan);

        let base64Content = '';
        try {
          if (mode === 'file') {
            const f = fileInput && fileInput.files && fileInput.files[0];
            if (!f) {
              UI.toast('Pilih berkas PDF hasil cetak terlebih dahulu.', 'error');
              return;
            }
            base64Content = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                const s = String(reader.result || '');
                resolve(s.includes(',') ? s.split(',')[1] : s);
              };
              reader.onerror = () => reject(new Error('Gagal membaca berkas PDF.'));
              reader.readAsDataURL(f);
            });
          } else {
            if (getFilteredRekapRows().length === 0) {
              UI.toast('Belum ada data rekap untuk dibuat menjadi PDF. Muat rekap terlebih dahulu.', 'warn');
              return;
            }
            base64Content = generateRekapPDFBase64(bulanNama, tahun);
          }
        } catch (prepErr) {
          UI.toast(prepErr.message, 'error');
          return;
        }

        UI.setButtonLoading(submitUploadBtn, true, 'Mengunggah ke Drive...');
        try {
          const res = await API.uploadDokumenDrive({
            filename,
            mimeType: 'application/pdf',
            base64Content,
            kategori: 'Laporan PDF',
            judul: `Rekap Presensi ${bulanNama} ${tahun}`,
            diunggah_oleh: (adminSession && (adminSession.nama_lengkap || adminSession.username)) || 'Administrator',
          });
          UI.closeModal('modal-upload-pdf');
          const d = res.data || res;
          UI.toast(
            d.drive_url
              ? `PDF "${filename}" berhasil diunggah ke Drive & disimpan di arsip.`
              : `PDF "${filename}" selesai diunggah ke Google Drive.`,
            'success'
          );
        } catch (err) {
          UI.toast(err.message, 'error');
        } finally {
          UI.setButtonLoading(submitUploadBtn, false);
        }
      });
    }
  }

  // =========================================================================
  // INISIALISASI PORTAL KEPALA MADRASAH / ADMIN (5 TAB)
  // =========================================================================
  function init(session) {
    adminSession = session || {};
    const tablist = document.getElementById('admin-tablist');

    if (!initialized) {
      initialized = true;
      bindDashboardEvents();
      bindSantriEvents();
      bindRekapEvents();

      tabController = UI.initSlidingTabs(tablist, (tabName) => {
        if (tabName === 'santri' && STATE.santri.length === 0) {
          loadSantri(false);
        } else if (tabName === 'rekap' && STATE.rekap.length === 0) {
          loadRekapLaporan(false);
        } else if (tabName === 'uas') {
          root.MDTA_CALC.mountUAS(document.getElementById('admin-uas-mount'), {
            scope: 'admin',
            session: adminSession,
          });
        } else if (tabName === 'raport') {
          root.MDTA_CALC.mountRaport(document.getElementById('admin-raport-mount'), {
            scope: 'admin',
            session: adminSession,
          });
        }
      });
    } else if (tabController) {
      tabController.selectByName('dashboard', false);
    }

    loadDashboard(false);
  }

  root.MDTA_ADMIN = {
    init,
    loadDashboard,
    loadSantri,
    loadRekapLaporan,
  };
})(window);
