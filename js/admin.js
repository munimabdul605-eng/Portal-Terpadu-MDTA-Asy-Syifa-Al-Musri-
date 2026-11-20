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
    laporanPerKelas: [],
    editingUserId: null,
    editingUserOriginalUsername: '',
    editingSantriId: null,
    editingKelasId: null,
    editingKelasOriginalName: '',
    mappingKelasName: '',
    movingSantriId: '',
    selectedSantriIds: new Set(),
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
  // HELPER KELAS RESMI & PEMETAAN GURU
  // =========================================================================
  function getOfficialClasses() {
    if (Array.isArray(STATE.kelas) && STATE.kelas.length > 0) {
      return STATE.kelas
        .map(API.normalizeKelas)
        .filter((k) => k.nama_kelas)
        .sort((a, b) => a.nama_kelas.localeCompare(b.nama_kelas));
    }
    const set = new Set();
    (STATE.santri || []).forEach((s) => {
      if (s.kelas) set.add(s.kelas);
    });
    if (set.size === 0) {
      (CONFIG.KELAS_OPTIONS || []).forEach((k) => set.add(k));
    }
    return Array.from(set)
      .sort((a, b) => a.localeCompare(b))
      .map((namaKelas, idx) => ({
        id_kelas: `SYN-${String(idx + 1).padStart(3, '0')}`,
        nama_kelas: namaKelas,
        tingkat: '',
        keterangan: 'Sinkron dari data lokal',
        status: 'aktif',
        isSynthetic: true,
      }));
  }

  function getOfficialClassNames(includeInactive) {
    return getOfficialClasses()
      .filter((k) => includeInactive || k.status !== 'nonaktif')
      .map((k) => k.nama_kelas);
  }

  function getGurusForClass(kelasName) {
    return (STATE.users || []).filter(
      (u) =>
        String(u.role || '').trim().toLowerCase() === 'guru' &&
        String(u.status_aktif || 'aktif').trim().toLowerCase() === 'aktif' &&
        API.isKelasAllowed(kelasName, u.kelas_ampu)
    );
  }

  function populateClassSelect(el, names, opts) {
    if (!el) return;
    const cfg = opts || {};
    const cur = el.value;
    const list = Array.isArray(names) ? names : [];
    const htmlParts = [];
    if (cfg.firstLabel !== undefined) {
      htmlParts.push(`<option value="${UI.esc(cfg.firstValue || '')}">${UI.esc(cfg.firstLabel)}</option>`);
    }
    list.forEach((k) => {
      htmlParts.push(`<option value="${UI.esc(k)}">${UI.esc(k)}</option>`);
    });
    el.innerHTML = htmlParts.join('');
    if (cur && (cur === (cfg.firstValue || '') || list.includes(cur))) {
      el.value = cur;
    } else if (cfg.defaultToFirst && list.length > 0 && cfg.firstLabel === undefined) {
      el.value = list[0];
    }
  }

  // =========================================================================
  // TAB 1: BERANDA KEPALA MADRASAH (TERPISAH PER KELAS) & KELOLA AKUN
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

  function renderAbsentStudentListHtml(list, tanggal, compactEmpty) {
    if (!Array.isArray(list) || list.length === 0) {
      if (compactEmpty) {
        return `<div class="sub-surface text-muted" style="font-size:0.84rem;padding:12px 14px;">Semua santri kelas ini yang tercatat pada tanggal terpilih berstatus Hadir.</div>`;
      }
      return UI.renderStateBox({
        type: 'empty',
        title: 'Tidak ada santri absen pada tanggal ini',
        message: 'Seluruh santri yang tercatat pada tanggal terpilih berstatus Hadir, atau belum ada catatan ketidakhadiran.',
      });
    }

    const tglLabel = UI.formatDateShort(tanggal);
    return `<div class="absent-list">${list
      .map((item) => {
        const pesanWA = `Assalamu'alaikum Bapak/Ibu Wali Santri dari ananda ${item.nama_santri} (${item.kelas}). Menginformasikan dari ${CONFIG.INSTITUTION_NAME} bahwa pada tanggal ${tglLabel} ananda tercatat tidak hadir dengan status: ${item.status}${item.catatan ? ` (${item.catatan})` : ''}. Mohon konfirmasinya. Terima kasih.`;
        const waUrl = API.formatWhatsAppUrl(item.no_wa_ortu, pesanWA);

        return `
          <div class="absent-student-item">
            <div style="min-width:0;flex:1 1 200px;">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <strong style="font-size:0.92rem;">${UI.esc(item.nama_santri)}</strong>
                <span class="status-badge ${statusBadgeClass(item.status)}">${UI.esc(item.status)}</span>
              </div>
              <div class="text-muted" style="font-size:0.8rem;margin-top:4px;">
                ${item.catatan ? `Keterangan: ${UI.esc(item.catatan)} · ` : ''}Dicatat oleh ${UI.esc(item.nama_guru_piket || '-')}
              </div>
            </div>
            <div>
              ${
                waUrl
                  ? `<a href="${UI.esc(waUrl)}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">
                       <i data-lucide="message-circle" aria-hidden="true"></i>
                       <span>Hubungi WA Ortu</span>
                     </a>`
                  : `<span class="text-muted" style="font-size:0.78rem;">No. WA belum diisi</span>`
              }
            </div>
          </div>
        `;
      })
      .join('')}</div>`;
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

  function buildLaporanPerKelas(rk, targetTanggal, targetKelas) {
    if (rk && Array.isArray(rk.laporan_per_kelas) && rk.laporan_per_kelas.length > 0) {
      return rk.laporan_per_kelas
        .filter((blk) => !targetKelas || String(blk.kelas || '').toLowerCase() === targetKelas.toLowerCase())
        .map((blk) => {
          const gurus =
            Array.isArray(blk.guru_pengampu) && blk.guru_pengampu.length > 0
              ? blk.guru_pengampu
              : getGurusForClass(blk.kelas);
          const namaPengampu =
            gurus.length > 0 ? gurus.map((g) => g.nama_lengkap || g.username).join(', ') : 'Belum dipetakan';
          const cleanNilai = (Array.isArray(blk.rekap_nilai) ? blk.rekap_nilai : []).map(sanitizeRekapNilaiCard);
          return Object.assign({}, blk, {
            guru_pengampu: gurus,
            nama_guru_pengampu: namaPengampu,
            rekap_nilai: cleanNilai,
          });
        });
    }

    const statusList = Array.isArray(rk && rk.status_setoran_hari_ini) ? rk.status_setoran_hari_ini : [];
    const abs = (rk && rk.absensi_harian) || {};
    const allRiwayat = (Array.isArray(abs.riwayat) ? abs.riwayat : []).map(API.normalizePresensi);
    const allAbsent = Array.isArray(abs.santri_tidak_hadir) ? abs.santri_tidak_hadir : [];
    const allNilai = (Array.isArray(rk && rk.rekap_nilai) ? rk.rekap_nilai : []).map(sanitizeRekapNilaiCard);

    const nameSet = new Set(getOfficialClassNames(false));
    if (rk && Array.isArray(rk.daftar_kelas)) rk.daftar_kelas.forEach((k) => k && nameSet.add(k));
    statusList.forEach((s) => s && s.kelas && nameSet.add(s.kelas));
    allNilai.forEach((n) => n && n.kelas && n.kelas !== 'Semua Kelas' && nameSet.add(n.kelas));

    const classNames = Array.from(nameSet)
      .filter((k) => !targetKelas || k.toLowerCase() === targetKelas.toLowerCase())
      .sort((a, b) => a.localeCompare(b));

    return classNames.map((k) => {
      const kLower = k.toLowerCase();
      const gurus = getGurusForClass(k);
      const namaPengampu =
        gurus.length > 0 ? gurus.map((g) => g.nama_lengkap || g.username).join(', ') : 'Belum dipetakan';
      const stMatched = statusList.find((s) => String(s.kelas || '').toLowerCase() === kLower);
      const classRiwayat = allRiwayat.filter((r) => String(r.kelas || '').toLowerCase() === kLower);
      const classAbsent = allAbsent.filter((r) => String(r.kelas || '').toLowerCase() === kLower);
      const classAgregat = { Hadir: 0, Sakit: 0, Izin: 0, Alpa: 0, total: classRiwayat.length };
      classRiwayat.forEach((r) => {
        if (Object.prototype.hasOwnProperty.call(classAgregat, r.status)) classAgregat[r.status]++;
      });
      const classNilai = allNilai.filter((n) => String(n.kelas || '').toLowerCase() === kLower);
      const totalSantriAktif = (STATE.santri || []).filter(
        (s) => String(s.kelas || '').toLowerCase() === kLower && String(s.status || 'aktif').toLowerCase() === 'aktif'
      ).length;
      const totalNilaiSantri = classNilai.reduce((s, n) => s + Number(n.jumlah_santri || 0), 0);
      const totalTuntas = classNilai.reduce((s, n) => s + Number(n.jumlah_tuntas || 0), 0);
      const totalBimbingan = classNilai.reduce((s, n) => s + Number(n.jumlah_perlu_bimbingan || 0), 0);
      const weightedSum = classNilai.reduce((s, n) => s + Number(n.rata_rata || 0) * Number(n.jumlah_santri || 0), 0);
      const avgNilai =
        totalNilaiSantri > 0
          ? Math.round((weightedSum / totalNilaiSantri) * 100) / 100
          : classNilai[0]
          ? Number(classNilai[0].rata_rata || 0)
          : 0;

      return {
        kelas: k,
        jumlah_santri: stMatched ? Number(stMatched.jumlah_santri || 0) : totalSantriAktif,
        guru_pengampu: gurus,
        nama_guru_pengampu: namaPengampu,
        status_setoran: stMatched
          ? {
              sudah_setor: Boolean(stMatched.sudah_setor),
              id_setoran: stMatched.id_setoran || '',
              nama_guru: stMatched.nama_guru || '',
              waktu_submit: stMatched.waktu_submit || '',
              ringkasan: stMatched.ringkasan || '',
            }
          : { sudah_setor: false, id_setoran: '', nama_guru: '', waktu_submit: '', ringkasan: '' },
        agregat_absensi: classAgregat,
        santri_tidak_hadir: classAbsent,
        riwayat_absensi: classRiwayat,
        rekap_nilai: classNilai,
        ringkasan_nilai: {
          jumlah_santri: totalNilaiSantri,
          rata_rata: avgNilai,
          jumlah_tuntas: totalTuntas,
          jumlah_perlu_bimbingan: totalBimbingan,
          status_setoran: classNilai.some((n) => n.status_setoran === 'Sudah Disetor')
            ? 'Sudah Disetor'
            : classNilai.length > 0
            ? 'Draft'
            : 'Belum Ada Nilai',
          periode: classNilai[0] ? classNilai[0].periode : '-',
          nama_guru: classNilai[0] ? classNilai[0].nama_guru : namaPengampu,
        },
      };
    });
  }

  function renderKepsekSubtabs(allClassNames, activeKelas, statusList) {
    const bar = document.getElementById('kepsek-kelas-subtabs');
    if (!bar) return;

    const statusByKelas = new Map();
    (Array.isArray(statusList) ? statusList : []).forEach((s) => {
      if (s && s.kelas) statusByKelas.set(String(s.kelas).toLowerCase(), Boolean(s.sudah_setor));
    });

    const buttons = [
      `<button type="button" class="kelas-subtab" data-kepsek-subtab="" aria-pressed="${!activeKelas ? 'true' : 'false'}">Semua Kelas (${allClassNames.length})</button>`,
    ];
    allClassNames.forEach((k) => {
      const pressed = activeKelas && activeKelas.toLowerCase() === k.toLowerCase();
      const done = statusByKelas.get(k.toLowerCase());
      const dotHtml =
        done === undefined ? '' : `<span class="subtab-dot ${done ? 'is-done' : 'is-pending'}" aria-hidden="true"></span>`;
      buttons.push(
        `<button type="button" class="kelas-subtab" data-kepsek-subtab="${UI.esc(k)}" aria-pressed="${pressed ? 'true' : 'false'}">${dotHtml}<span>${UI.esc(k)}</span></button>`
      );
    });

    bar.innerHTML = buttons.join('');
    bar.querySelectorAll('button[data-kepsek-subtab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const chosen = btn.dataset.kepsekSubtab || '';
        const kelasSel = document.getElementById('kepsek-filter-kelas');
        if (kelasSel) {
          kelasSel.value = chosen;
          loadDashboard(false, { force: false });
        }
      });
    });
  }

  function renderLaporanPerKelas(blocks, targetTanggal) {
    const container = document.getElementById('kepsek-per-kelas-container');
    localState.laporanPerKelas = Array.isArray(blocks) ? blocks : [];

    const allNilaiCards = [];
    localState.laporanPerKelas.forEach((b) => {
      (b.rekap_nilai || []).forEach((n) => allNilaiCards.push(n));
    });
    localState.rekapNilaiList = allNilaiCards;

    if (!container) return;

    if (localState.laporanPerKelas.length === 0) {
      container.innerHTML = UI.renderStateBox({
        type: 'empty',
        title: 'Belum ada data kelas terdaftar',
        message: 'Tambahkan kelas di panel "Kelola Kelas & Pemetaan Guru" atau daftarkan santri terlebih dahulu.',
      });
      UI.refreshIcons(container);
      return;
    }

    container.innerHTML = localState.laporanPerKelas
      .map((blk, blkIdx) => {
        const st = blk.status_setoran || {};
        const jam = formatJamWIB(st.waktu_submit);
        const abs = blk.agregat_absensi || { Hadir: 0, Sakit: 0, Izin: 0, Alpa: 0 };
        const nilaiSum = blk.ringkasan_nilai || {};
        const primaryNilai = (blk.rekap_nilai && blk.rekap_nilai[0]) || null;
        const primaryNilaiIdx = primaryNilai ? localState.rekapNilaiList.indexOf(primaryNilai) : -1;
        const hasNilai = Boolean(primaryNilai && Number(nilaiSum.jumlah_santri || 0) > 0);
        const isNilaiSetor = nilaiSum.status_setoran === 'Sudah Disetor';

        return `
          <article class="kelas-report-block">
            <div class="kelas-report-header">
              <div style="min-width:0;flex:1 1 240px;">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                  <h4 class="heading-md">${UI.esc(blk.kelas)}</h4>
                  <span class="status-badge status-izin mono-num">${Number(blk.jumlah_santri || 0)} santri aktif</span>
                  <span class="status-badge ${st.sudah_setor ? 'status-hadir' : 'status-sakit'}">
                    <i data-lucide="${st.sudah_setor ? 'check-circle-2' : 'clock'}" aria-hidden="true" style="width:14px;height:14px;"></i>
                    <span>${st.sudah_setor ? `Sudah Setor${jam ? ` · ${jam}` : ''}` : 'Belum Setor Absensi'}</span>
                  </span>
                </div>
                <div class="text-secondary" style="font-size:0.84rem;margin-top:6px;">
                  Guru Pengampu: <strong>${UI.esc(blk.nama_guru_pengampu || 'Belum dipetakan')}</strong>
                  ${st.sudah_setor && st.nama_guru ? ` · Penyetor hari ini: <strong>${UI.esc(st.nama_guru)}</strong>` : ''}
                </div>
              </div>
              <div class="toolbar-actions" style="flex-shrink:0;">
                <button type="button" class="btn btn-secondary btn-sm" data-print-class-laporan="${blkIdx}">
                  <i data-lucide="printer" aria-hidden="true"></i>
                  <span>Cetak PDF Kelas</span>
                </button>
              </div>
            </div>

            <div class="kelas-mini-stats">
              <div class="nilai-kpi-box">
                <div class="nilai-kpi-val" style="color:var(--status-hadir-fg);">${Number(abs.Hadir || 0)}</div>
                <div class="nilai-kpi-lbl">Hadir</div>
              </div>
              <div class="nilai-kpi-box">
                <div class="nilai-kpi-val" style="color:var(--status-sakit-fg);">${Number(abs.Sakit || 0)}</div>
                <div class="nilai-kpi-lbl">Sakit</div>
              </div>
              <div class="nilai-kpi-box">
                <div class="nilai-kpi-val" style="color:var(--status-izin-fg);">${Number(abs.Izin || 0)}</div>
                <div class="nilai-kpi-lbl">Izin</div>
              </div>
              <div class="nilai-kpi-box">
                <div class="nilai-kpi-val" style="color:var(--status-alpa-fg);">${Number(abs.Alpa || 0)}</div>
                <div class="nilai-kpi-lbl">Alpa</div>
              </div>
            </div>

            <div class="kelas-report-split">
              <div class="stack-gap" style="gap:8px;">
                <div style="font-size:0.84rem;font-weight:700;color:var(--text-primary);">Santri Tidak Hadir (${(blk.santri_tidak_hadir || []).length})</div>
                ${renderAbsentStudentListHtml(blk.santri_tidak_hadir || [], targetTanggal, true)}
              </div>

              <div class="stack-gap" style="gap:10px;">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
                  <div style="font-size:0.84rem;font-weight:700;color:var(--text-primary);">Rekap Nilai &amp; Rata-Rata Kelas</div>
                  <span class="status-badge ${isNilaiSetor ? 'status-hadir' : 'status-sakit'}">${UI.esc(nilaiSum.status_setoran || 'Belum Ada Nilai')}</span>
                </div>
                <div class="nilai-kpi-strip">
                  <div class="nilai-kpi-box">
                    <div class="nilai-kpi-val">${hasNilai ? Number(nilaiSum.rata_rata || 0).toFixed(1) : '-'}</div>
                    <div class="nilai-kpi-lbl">Rata-rata</div>
                  </div>
                  <div class="nilai-kpi-box">
                    <div class="nilai-kpi-val" style="color:var(--status-hadir-fg);">${hasNilai ? Number(nilaiSum.jumlah_tuntas || 0) : '-'}</div>
                    <div class="nilai-kpi-lbl">Tuntas (A/B/C)</div>
                  </div>
                  <div class="nilai-kpi-box">
                    <div class="nilai-kpi-val" style="color:var(--status-alpa-fg);">${hasNilai ? Number(nilaiSum.jumlah_perlu_bimbingan || 0) : '-'}</div>
                    <div class="nilai-kpi-lbl">Bimbingan</div>
                  </div>
                </div>
                <div class="toolbar-actions">
                  ${
                    primaryNilaiIdx >= 0
                      ? `<button type="button" class="btn btn-secondary btn-sm" data-view-nilai-idx="${primaryNilaiIdx}">
                           <i data-lucide="eye" aria-hidden="true"></i>
                           <span>Detail Nilai</span>
                         </button>
                         <button type="button" class="btn btn-secondary btn-sm" data-print-nilai-idx="${primaryNilaiIdx}">
                           <i data-lucide="file-text" aria-hidden="true"></i>
                           <span>Cetak Nilai</span>
                         </button>`
                      : `<span class="text-muted" style="font-size:0.8rem;">Belum ada setoran nilai raport untuk kelas ini.</span>`
                  }
                </div>
              </div>
            </div>
          </article>
        `;
      })
      .join('');

    container.querySelectorAll('button[data-print-class-laporan]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const blk = localState.laporanPerKelas[Number(btn.dataset.printClassLaporan)];
        if (blk) printKepsekLaporan(blk.kelas, targetTanggal);
      });
    });

    container.querySelectorAll('button[data-view-nilai-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const card = localState.rekapNilaiList[Number(btn.dataset.viewNilaiIdx)];
        if (card) openDetailNilaiModal(card);
      });
    });

    container.querySelectorAll('button[data-print-nilai-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const card = localState.rekapNilaiList[Number(btn.dataset.printNilaiIdx)];
        if (card) printKepsekNilaiCard(card);
      });
    });

    UI.refreshIcons(container);
  }

  function printKepsekLaporan(onlyKelas, targetTanggal) {
    const printArea = document.getElementById('kepsek-laporan-print-area');
    if (!printArea) return;

    const blocks = (localState.laporanPerKelas || []).filter(
      (b) => !onlyKelas || String(b.kelas || '').toLowerCase() === String(onlyKelas).toLowerCase()
    );
    if (blocks.length === 0) {
      UI.toast('Belum ada laporan kelas yang siap dicetak.', 'warn');
      return;
    }

    const tglLabel = UI.formatDateShort(targetTanggal || UI.todayISO());
    printArea.innerHTML = blocks
      .map((blk) => {
        const st = blk.status_setoran || {};
        const abs = blk.agregat_absensi || { Hadir: 0, Sakit: 0, Izin: 0, Alpa: 0 };
        const absentRows = Array.isArray(blk.santri_tidak_hadir) ? blk.santri_tidak_hadir : [];
        const nilaiCard = (blk.rekap_nilai && blk.rekap_nilai[0]) || null;
        const nilaiRows = nilaiCard && Array.isArray(nilaiCard.detail_nilai) ? nilaiCard.detail_nilai : [];

        return `
          <div class="print-class-page">
            <div class="print-kop">
              <div>
                <h2 class="print-kop-title">${UI.esc(CONFIG.INSTITUTION_NAME)}</h2>
                <p class="print-kop-sub">Laporan Harian &amp; Akademik Kelas: <strong>${UI.esc(blk.kelas)}</strong> | Tanggal: ${UI.esc(tglLabel)}</p>
                <p class="print-kop-sub">Guru Pengampu: <strong>${UI.esc(blk.nama_guru_pengampu || 'Belum dipetakan')}</strong> | Status Setoran: ${st.sudah_setor ? `Sudah Setor (${UI.esc(st.nama_guru || 'Guru')})` : 'Belum Setor'}</p>
              </div>
            </div>

            <table class="data-table" style="margin-bottom:14px;">
              <thead>
                <tr>
                  <th>Jumlah Santri Aktif</th>
                  <th>Hadir</th>
                  <th>Sakit</th>
                  <th>Izin</th>
                  <th>Alpa</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>${Number(blk.jumlah_santri || 0)}</td>
                  <td>${Number(abs.Hadir || 0)}</td>
                  <td>${Number(abs.Sakit || 0)}</td>
                  <td>${Number(abs.Izin || 0)}</td>
                  <td>${Number(abs.Alpa || 0)}</td>
                </tr>
              </tbody>
            </table>

            ${
              absentRows.length > 0
                ? `<h4 style="margin:0 0 6px;font-size:11pt;">Daftar Santri Tidak Hadir</h4>
                   <table class="data-table" style="margin-bottom:14px;">
                     <thead><tr><th>No</th><th>Nama Santri</th><th>Status</th><th>Keterangan</th></tr></thead>
                     <tbody>${absentRows
                       .map(
                         (a, i) =>
                           `<tr><td>${i + 1}</td><td>${UI.esc(a.nama_santri)}</td><td>${UI.esc(a.status)}</td><td>${UI.esc(a.catatan || '-')}</td></tr>`
                       )
                       .join('')}</tbody>
                   </table>`
                : ''
            }

            ${
              nilaiRows.length > 0
                ? `<h4 style="margin:0 0 6px;font-size:11pt;">Rekap Nilai (${UI.esc(nilaiCard.periode || '-')})</h4>
                   <table class="data-table">
                     <thead><tr><th>No</th><th>Nama Santri</th><th>Harian</th><th>UAS</th><th>Hadir</th><th>Nilai Akhir</th><th>Predikat</th></tr></thead>
                     <tbody>${nilaiRows
                       .map(
                         (r, i) =>
                           `<tr><td>${i + 1}</td><td>${UI.esc(r.nama_santri)}</td><td>${UI.esc(r.n_harian)}</td><td>${UI.esc(r.n_uas)}</td><td>${UI.esc(r.n_kehadiran)}%</td><td><strong>${Number(r.n_akhir || 0).toFixed(2)}</strong></td><td>${UI.esc(r.grade)} (${UI.esc(r.keterangan)})</td></tr>`
                       )
                       .join('')}</tbody>
                   </table>`
                : ''
            }

            <div class="print-signatures">
              <div class="print-sign-box">
                <div>Mengetahui,</div>
                <div>Kepala Madrasah MDTA</div>
                <div class="print-sign-space"></div>
                <div><strong>( ____________________ )</strong></div>
              </div>
              <div class="print-sign-box">
                <div>Bojongsoang, ${UI.esc(tglLabel)}</div>
                <div>Guru Pengampu (${UI.esc(blk.kelas)})</div>
                <div class="print-sign-space"></div>
                <div><strong>${UI.esc(blk.nama_guru_pengampu && blk.nama_guru_pengampu !== 'Belum dipetakan' ? blk.nama_guru_pengampu : '( ____________________ )')}</strong></div>
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    document.body.classList.add('printing-kepsek-laporan');
    window.print();
    setTimeout(() => document.body.classList.remove('printing-kepsek-laporan'), 300);
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
          <td colspan="5">
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
      .map((u) => {
        const isAdm = String(u.role || '').toLowerCase() === 'admin';
        const ampuList = Array.isArray(u.kelas_ampu) ? u.kelas_ampu : API.parseKelasAmpu(u.kelas_ampu);
        const kelasCellHtml = isAdm
          ? '<span class="text-muted" style="font-size:0.8125rem;">Seluruh Kelas (Admin)</span>'
          : ampuList.length > 0
          ? `<div class="guru-pill-list">${ampuList
              .map((k) => `<span class="guru-pill">${UI.esc(k)}</span>`)
              .join('')}</div>`
          : '<span class="status-badge status-sakit">Belum dipetakan</span>';

        return `
        <tr>
          <td class="usr-nama" data-label="Pengguna">
            <div style="font-weight:600;">${UI.esc(u.nama_lengkap || u.username)}</div>
            <div class="text-muted mono-num" style="font-size:0.78rem;">@${UI.esc(u.username)}</div>
          </td>
          <td class="usr-role" data-label="Peran">
            <span class="status-badge ${isAdm ? 'status-hadir' : 'status-izin'}">
              ${isAdm ? 'Kepala Madrasah / Admin' : 'Guru'}
            </span>
          </td>
          <td class="usr-kelas" data-label="Kelas Ampu">${kelasCellHtml}</td>
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
      `;
      })
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
        const targetId = found ? (found.id_user || found.username || key) : key;
        const ok = await UI.confirmDialog({
          title: 'Hapus Akun Pengguna',
          message: `Akun "${label}" akan dihapus dari daftar akses portal. Lanjutkan?`,
          confirmLabel: 'Hapus Akun',
          danger: true,
        });
        if (!ok) return;

        // Optimistic UI: langsung hapus dari tampilan & cache sambil menghapus di server
        const prevUsers = [...STATE.users];
        STATE.users = STATE.users.filter((u) => (u.id_user || u.username) !== key);
        if (root.MDTA_CACHE) root.MDTA_CACHE.write('users', STATE.users);
        renderUsersTable();
        renderKelasManagement();
        UI.toast(`Pengguna "${label}" dihapus.`, 'success');

        try {
          await API.deleteUser(targetId);
        } catch (err) {
          STATE.users = prevUsers;
          if (root.MDTA_CACHE) root.MDTA_CACHE.write('users', STATE.users);
          renderUsersTable();
          renderKelasManagement();
          UI.toast(`Gagal menghapus "${label}": ${err.message}`, 'error');
        }
      });
    });

    UI.refreshIcons(tbody);
  }

  function syncKepsekClassFilter(classesFromServer) {
    const sel = document.getElementById('kepsek-filter-kelas');
    if (!sel) return [];
    const prev = sel.value;
    const set = new Set(getOfficialClassNames(false));
    (Array.isArray(classesFromServer) ? classesFromServer : []).forEach((k) => {
      if (k) set.add(k);
    });
    const sorted = Array.from(set).sort((a, b) => a.localeCompare(b));
    sel.innerHTML =
      '<option value="">Semua Kelas</option>' +
      sorted.map((k) => `<option value="${UI.esc(k)}">${UI.esc(k)}</option>`).join('');
    if (prev && sorted.includes(prev)) sel.value = prev;
    return sorted;
  }

  function renderKepsekBlockFromData(rk, targetTanggal) {
    const penyetorEl = document.getElementById('kepsek-absensi-penyetor');
    const summaryEl = document.getElementById('kepsek-setoran-summary');
    const kelasSel = document.getElementById('kepsek-filter-kelas');
    const activeKelas = kelasSel ? kelasSel.value : '';

    const allClassNames = syncKepsekClassFilter(rk.daftar_kelas);
    const statusList = Array.isArray(rk.status_setoran_hari_ini) ? rk.status_setoran_hari_ini : [];
    const doneCount = statusList.filter((item) => item.sudah_setor).length;

    if (summaryEl) {
      if (statusList.length === 0) {
        summaryEl.textContent = 'Belum ada kelas aktif';
        summaryEl.className = 'status-badge status-izin';
      } else {
        summaryEl.textContent = `${doneCount} dari ${statusList.length} kelas sudah menyetor laporan hari ini`;
        summaryEl.className = `status-badge ${doneCount === statusList.length ? 'status-hadir' : 'status-sakit'}`;
      }
    }

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

    renderKepsekSubtabs(allClassNames, activeKelas, statusList);
    const blocks = buildLaporanPerKelas(rk, targetTanggal, activeKelas);
    renderLaporanPerKelas(blocks, targetTanggal);

    localState.riwayatHarian = (abs.riwayat || []).map(API.normalizePresensi);
    renderRiwayatTable();
  }

  function applyBootstrapData(bundle, targetTanggal, targetKelas) {
    const CACHE = root.MDTA_CACHE;
    const key = `${targetTanggal}|${targetKelas}`;

    const prevKelas = STATE.kelas;
    const prevUsers = STATE.users;
    const prevSantri = STATE.santri;
    const prevRk = STATE.rekapKepsek;

    if (Array.isArray(bundle.kelas)) {
      STATE.kelas = bundle.kelas.map(API.normalizeKelas);
      STATE.loaded.kelas = true;
      if (CACHE) CACHE.write('kelas', STATE.kelas);
    }

    if (Array.isArray(bundle.santri)) {
      STATE.santri = bundle.santri.map(API.normalizeSantri);
      STATE.loaded.santri = true;
      if (CACHE) CACHE.write('santri', STATE.santri);
    }

    if (bundle.dashboard) {
      STATE.dashboard = bundle.dashboard;
      if (CACHE) CACHE.write('dashboard', STATE.dashboard);
    }

    const rawUsers =
      Array.isArray(bundle.users) && bundle.users.length > 0
        ? bundle.users
        : bundle.dashboard && Array.isArray(bundle.dashboard.daftar_pengguna)
        ? bundle.dashboard.daftar_pengguna
        : [];
    if (rawUsers.length > 0 || Array.isArray(bundle.users)) {
      STATE.users = rawUsers.map(API.normalizeUser);
      if (CACHE) CACHE.write('users', STATE.users);
    }

    if (Array.isArray(bundle.nilai_raport)) {
      STATE.nilaiRaportSaved = bundle.nilai_raport.map(API.normalizeNilaiRaport);
      if (CACHE) CACHE.write('nilaiRaportSaved', STATE.nilaiRaportSaved);
    }

    if (Array.isArray(bundle.dokumen_arsip)) {
      STATE.dokumenArsip = bundle.dokumen_arsip.map(API.normalizeDokumen);
      STATE.loaded.arsip = true;
      if (CACHE) CACHE.write('dokumenArsip', STATE.dokumenArsip);
    }

    if (Array.isArray(bundle.log_setoran)) {
      STATE.logSetoran = bundle.log_setoran.map(API.normalizeLogSetoran);
      if (CACHE) CACHE.write('logSetoran', STATE.logSetoran);
    }

    if (bundle.rekap_kepsek) {
      STATE.rekapKepsek = bundle.rekap_kepsek;
      STATE.rekapKepsekKey = key;
      if (CACHE) CACHE.write('rekapKepsek', { key, payload: bundle.rekap_kepsek });
    }

    STATE.loaded.bootstrap = true;
    STATE.loaded.dashboard = true;
    STATE.lastSyncAt = Date.now();

    return {
      kelasChanged: !CACHE || CACHE.hasChanged(prevKelas, STATE.kelas),
      usersChanged: !CACHE || CACHE.hasChanged(prevUsers, STATE.users),
      santriChanged: !CACHE || CACHE.hasChanged(prevSantri, STATE.santri),
      rkChanged: !CACHE || CACHE.hasChanged(prevRk, STATE.rekapKepsek),
    };
  }

  async function loadDashboard(showToastOnDone, opts) {
    const force = Boolean((opts && opts.force) || showToastOnDone);
    const CACHE = root.MDTA_CACHE;
    const refreshBtn = document.getElementById('btn-refresh-dashboard');
    const riwayatTbody = document.getElementById('admin-riwayat-tbody');
    const usersTbody = document.getElementById('admin-users-tbody');
    const updatedEl = document.getElementById('dashboard-last-updated');
    const noticeBox = document.getElementById('kepsek-backend-notice');
    const noticeMsg = document.getElementById('kepsek-backend-notice-msg');

    const tanggalInp = document.getElementById('kepsek-filter-tanggal');
    const kelasSel = document.getElementById('kepsek-filter-kelas');
    if (tanggalInp && !tanggalInp.value) tanggalInp.value = UI.todayISO();
    const targetTanggal = tanggalInp ? tanggalInp.value : UI.todayISO();
    const targetKelas = kelasSel ? kelasSel.value : '';
    const key = `${targetTanggal}|${targetKelas}`;

    if (CACHE) CACHE.hydrateState();

    const hasCachedRk = Boolean(STATE.rekapKepsek && STATE.rekapKepsekKey === key);
    const hasCachedUsers = Array.isArray(STATE.users) && STATE.users.length > 0;
    const hasAnyCache = hasCachedRk || Boolean(STATE.dashboard) || hasCachedUsers;

    syncClassFilterOptions();
    renderKelasManagement();

    // 1. Stale-While-Revalidate: Paint instan (0 ms) jika cache tersedia
    if (hasCachedRk) {
      renderKepsekBlockFromData(STATE.rekapKepsek, targetTanggal);
    } else if (STATE.dashboard) {
      const d = STATE.dashboard;
      renderDashboardStats(d.summary || {}, d.total_presensi);
      localState.riwayatHarian = (d.riwayat_presensi || []).map(API.normalizePresensi);
      renderRiwayatTable();
      const synthRk = {
        daftar_kelas: getOfficialClassNames(false),
        status_setoran_hari_ini: [],
        absensi_harian: {
          agregat: d.summary || {},
          setoran: [],
          santri_tidak_hadir: localState.riwayatHarian.filter((r) => ['Sakit', 'Izin', 'Alpa'].includes(r.status)),
          riwayat: localState.riwayatHarian,
        },
        rekap_nilai: [],
      };
      renderKepsekBlockFromData(synthRk, targetTanggal);
    } else if (riwayatTbody) {
      riwayatTbody.innerHTML = UI.renderSkeletonRows(6, 4);
    }

    if (hasCachedUsers) {
      renderUsersTable();
    } else if (usersTbody) {
      usersTbody.innerHTML = UI.renderSkeletonRows(5, 3);
    }

    if (noticeBox) noticeBox.hidden = true;

    // Jika sesi sudah memuat kombinasi tanggal/kelas ini & bukan manual refresh, hentikan
    if (!force && STATE.loaded.bootstrap && hasCachedRk) {
      if (updatedEl && STATE.dashboard) {
        const totalSantri = Number.isFinite(Number(STATE.dashboard.total_santri))
          ? ` · ${STATE.dashboard.total_santri} santri terdaftar`
          : '';
        updatedEl.textContent = `Tersinkron (${totalSantri.replace(/^ · /, '') || 'aktif'})`;
      }
      return;
    }

    if (force || !hasAnyCache) {
      UI.setButtonLoading(refreshBtn, true, 'Memuat...');
    }

    try {
      const needsFullBootstrap = force || !STATE.loaded.bootstrap;
      if (needsFullBootstrap && CACHE) {
        const bundle = await CACHE.fetchBootstrapSmart({
          role: 'admin',
          tanggal: targetTanggal,
          kelas: targetKelas,
        });
        const diff = applyBootstrapData(bundle, targetTanggal, targetKelas);

        if (bundle.rekap_kepsek) {
          if (!hasCachedRk || diff.rkChanged || diff.kelasChanged || diff.usersChanged) {
            renderKepsekBlockFromData(bundle.rekap_kepsek, targetTanggal);
          }
        } else if (bundle.dashboard) {
          if (noticeBox && noticeMsg) {
            noticeMsg.textContent =
              'Backend Apps Script Anda perlu diperbarui dengan kode terbaru (Code.gs) agar pemetaan kelas terpusat, isolasi guru & log setoran aktif penuh.';
            noticeBox.hidden = false;
          }
          const d = bundle.dashboard;
          localState.riwayatHarian = (d.riwayat_presensi || []).map(API.normalizePresensi);
          const fallbackRk = {
            daftar_kelas: getOfficialClassNames(false),
            status_setoran_hari_ini: [],
            absensi_harian: {
              agregat: d.summary || {},
              setoran: [],
              santri_tidak_hadir: localState.riwayatHarian.filter((r) => ['Sakit', 'Izin', 'Alpa'].includes(r.status)),
              riwayat: localState.riwayatHarian,
            },
            rekap_nilai: [],
          };
          renderKepsekBlockFromData(fallbackRk, targetTanggal);
        }

        if (!hasCachedUsers || diff.usersChanged) {
          renderUsersTable();
        }
        syncClassFilterOptions();
        renderKelasManagement();
      } else {
        // Pergantian filter tanggal/kelas saja: cukup fetch getRekapKepsek yang ringan & cached
        const rekapRes = await API.getRekapKepsek(targetTanggal, targetKelas);
        const rk = rekapRes.data || rekapRes;
        const rkChanged = !CACHE || CACHE.hasChanged(STATE.rekapKepsek, rk) || !hasCachedRk;
        STATE.rekapKepsek = rk;
        STATE.rekapKepsekKey = key;
        if (CACHE) CACHE.write('rekapKepsek', { key, payload: rk });
        if (rkChanged) {
          renderKepsekBlockFromData(rk, targetTanggal);
        }
      }

      if (updatedEl) {
        const d = STATE.dashboard || {};
        const totalSantri = Number.isFinite(Number(d.total_santri)) ? ` · ${d.total_santri} santri terdaftar` : '';
        updatedEl.textContent = `Terakhir diperbarui: ${new Date().toLocaleTimeString('id-ID')}${totalSantri}`;
      }
      if (showToastOnDone) {
        UI.toast('Laporan Kepala Madrasah berhasil diperbarui.', 'success');
      }
    } catch (err) {
      if (!hasAnyCache) {
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
          if (retryBtn) retryBtn.addEventListener('click', () => loadDashboard(false, { force: true }));
        }
      }
      if (force || !hasAnyCache) {
        UI.toast(err.message, 'error');
      }
    } finally {
      UI.setButtonLoading(refreshBtn, false);
    }
  }

  // =========================================================================
  // KELOLA KELAS RESMI & PEMETAAN GURU PENGAMPU
  // =========================================================================
  function renderKelasManagement() {
    const grid = document.getElementById('admin-kelas-grid');
    if (!grid) return;

    const classes = getOfficialClasses();
    if (classes.length === 0) {
      grid.innerHTML = UI.renderStateBox({
        type: 'empty',
        title: 'Belum ada daftar kelas resmi',
        message: 'Klik "Tambah Kelas" untuk membuat kelas resmi dan memetakan guru pengampu.',
      });
      UI.refreshIcons(grid);
      return;
    }

    grid.innerHTML = classes
      .map((kls) => {
        const countSantri = (STATE.santri || []).filter(
          (s) => String(s.kelas || '').trim().toLowerCase() === kls.nama_kelas.toLowerCase()
        ).length;
        const gurus = getGurusForClass(kls.nama_kelas);
        const guruHtml =
          gurus.length > 0
            ? `<div class="guru-pill-list">${gurus
                .map((g) => `<span class="guru-pill">${UI.esc(g.nama_lengkap || g.username)}</span>`)
                .join('')}</div>`
            : `<span class="text-muted" style="font-size:0.8rem;">Belum ada guru pengampu dipetakan</span>`;

        return `
          <article class="kelas-manage-card">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
              <div>
                <h4 class="heading-md">${UI.esc(kls.nama_kelas)}</h4>
                <div class="text-muted" style="font-size:0.78rem;margin-top:2px;">
                  ${kls.tingkat ? `${UI.esc(kls.tingkat)} · ` : ''}${countSantri} santri terdaftar
                </div>
              </div>
              <span class="status-badge ${kls.status !== 'nonaktif' ? 'status-hadir' : 'status-sakit'}">
                ${kls.status !== 'nonaktif' ? 'Aktif' : 'Nonaktif'}
              </span>
            </div>

            ${kls.keterangan ? `<div class="text-muted" style="font-size:0.8rem;">${UI.esc(kls.keterangan)}</div>` : ''}

            <div class="stack-gap" style="gap:4px;">
              <div style="font-size:0.76rem;font-weight:600;color:var(--text-muted);">Guru Pengampu:</div>
              ${guruHtml}
            </div>

            <div class="toolbar-actions">
              <button type="button" class="btn btn-secondary btn-sm" data-map-kelas="${UI.esc(kls.nama_kelas)}">
                <i data-lucide="user-check" aria-hidden="true"></i>
                <span>Atur Guru</span>
              </button>
              <button type="button" class="btn btn-secondary btn-sm" data-edit-kelas="${UI.esc(kls.id_kelas)}">
                <i data-lucide="pencil" aria-hidden="true"></i>
                <span>Edit</span>
              </button>
              <button type="button" class="btn btn-danger btn-icon-sm" data-delete-kelas="${UI.esc(kls.id_kelas)}" data-kelas-nama="${UI.esc(kls.nama_kelas)}" aria-label="Hapus kelas ${UI.esc(kls.nama_kelas)}">
                <i data-lucide="trash-2" aria-hidden="true"></i>
              </button>
            </div>
          </article>
        `;
      })
      .join('');

    grid.querySelectorAll('button[data-map-kelas]').forEach((btn) => {
      btn.addEventListener('click', () => openKelasGuruModal(btn.dataset.mapKelas));
    });

    grid.querySelectorAll('button[data-edit-kelas]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const found = classes.find((c) => c.id_kelas === btn.dataset.editKelas);
        if (found) openKelasModal(found);
      });
    });

    grid.querySelectorAll('button[data-delete-kelas]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idKls = btn.dataset.deleteKelas;
        const namaKls = btn.dataset.kelasNama;
        const found = classes.find((c) => c.id_kelas === idKls);
        if (found && found.isSynthetic) {
          UI.toast('Perbarui & deploy Code.gs terlebih dahulu lalu muat ulang halaman agar tab Kelas tersinkron.', 'warn');
          return;
        }
        const ok = await UI.confirmDialog({
          title: 'Hapus Kelas Resmi',
          message: `Kelas "${namaKls}" akan dihapus dari daftar kelas resmi (hanya bisa jika tidak ada santri di dalamnya). Lanjutkan?`,
          confirmLabel: 'Hapus Kelas',
          danger: true,
        });
        if (!ok) return;

        try {
          await API.deleteKelas({ id_kelas: idKls, nama_kelas: namaKls });
          STATE.kelas = STATE.kelas.filter((k) => k.id_kelas !== idKls);
          if (root.MDTA_CACHE) root.MDTA_CACHE.write('kelas', STATE.kelas);
          syncClassFilterOptions();
          renderKelasManagement();
          UI.toast(`Kelas "${namaKls}" berhasil dihapus.`, 'success');
          await loadDashboard(false, { force: true });
        } catch (err) {
          UI.toast(err.message, 'error');
        }
      });
    });

    UI.refreshIcons(grid);
  }

  function closeKelasModal() {
    localState.editingKelasId = null;
    localState.editingKelasOriginalName = '';
    const form = document.getElementById('form-kelas');
    if (form) form.reset();
    const idEl = document.getElementById('kelas-id');
    if (idEl) idEl.value = '';
    UI.closeModal('modal-kelas');
  }

  function openKelasModal(kelasObj) {
    const form = document.getElementById('form-kelas');
    if (form) form.reset();

    const title = document.getElementById('kelas-modal-title');
    const hint = document.getElementById('kelas-edit-hint');
    localState.editingKelasId = kelasObj ? (kelasObj.isSynthetic ? '' : kelasObj.id_kelas) : null;
    localState.editingKelasOriginalName = kelasObj ? kelasObj.nama_kelas : '';

    document.getElementById('kelas-id').value = localState.editingKelasId || '';
    document.getElementById('kelas-nama').value = kelasObj ? kelasObj.nama_kelas : '';
    document.getElementById('kelas-tingkat').value = kelasObj ? kelasObj.tingkat || '' : '';
    document.getElementById('kelas-keterangan').value = kelasObj ? kelasObj.keterangan || '' : '';
    document.getElementById('kelas-status').value = kelasObj ? kelasObj.status || 'aktif' : 'aktif';

    if (title) title.textContent = kelasObj && !kelasObj.isSynthetic ? `Edit Kelas (${kelasObj.nama_kelas})` : 'Tambah Kelas Resmi';
    if (hint) hint.hidden = !(kelasObj && !kelasObj.isSynthetic);
    UI.openModal('modal-kelas');
  }

  function closeKelasGuruModal() {
    localState.mappingKelasName = '';
    const targetEl = document.getElementById('kelas-guru-target-nama');
    if (targetEl) targetEl.value = '';
    UI.closeModal('modal-kelas-guru');
  }

  function openKelasGuruModal(kelasName) {
    localState.mappingKelasName = kelasName;
    const targetEl = document.getElementById('kelas-guru-target-nama');
    const titleEl = document.getElementById('kelas-guru-modal-title');
    const subEl = document.getElementById('kelas-guru-subtitle');
    const box = document.getElementById('kelas-guru-checkboxes');
    if (targetEl) targetEl.value = kelasName;
    if (titleEl) titleEl.textContent = `Atur Guru Pengampu (${kelasName})`;
    if (subEl) subEl.textContent = `Centang satu atau lebih akun guru yang mengampu kelas ${kelasName}.`;

    const gurus = (STATE.users || []).filter((u) => String(u.role || '').toLowerCase() === 'guru');
    if (box) {
      if (gurus.length === 0) {
        box.innerHTML = `<div class="text-muted" style="grid-column:1 / -1;font-size:0.84rem;">Belum ada akun berstatus Guru. Tambahkan akun guru di tabel Kelola Akun terlebih dahulu.</div>`;
      } else {
        box.innerHTML = gurus
          .map((g) => {
            const uid = g.id_user || g.username;
            const checked = API.isKelasAllowed(kelasName, g.kelas_ampu);
            const activeBadge = g.status_aktif === 'aktif' ? '' : ' (Nonaktif)';
            return `
              <label class="kelas-checkbox-item">
                <input type="checkbox" name="kelas-guru-id" value="${UI.esc(uid)}" ${checked ? 'checked' : ''} />
                <span><strong>${UI.esc(g.nama_lengkap || g.username)}</strong><br><span class="text-muted" style="font-size:0.74rem;">@${UI.esc(g.username)}${UI.esc(activeBadge)}</span></span>
              </label>
            `;
          })
          .join('');
      }
    }

    UI.openModal('modal-kelas-guru');
  }

  function bindKelasEvents() {
    const addKelasBtn = document.getElementById('btn-add-kelas');
    const closeKelasBtn = document.getElementById('btn-close-kelas-modal');
    const cancelKelasBtn = document.getElementById('btn-cancel-kelas-modal');
    const kelasForm = document.getElementById('form-kelas');
    const saveKelasBtn = document.getElementById('btn-save-kelas');

    const closeMapBtn = document.getElementById('btn-close-kelas-guru-modal');
    const cancelMapBtn = document.getElementById('btn-cancel-kelas-guru-modal');
    const mapForm = document.getElementById('form-kelas-guru');
    const saveMapBtn = document.getElementById('btn-save-kelas-guru');

    if (addKelasBtn) addKelasBtn.addEventListener('click', () => openKelasModal(null));
    if (closeKelasBtn) closeKelasBtn.addEventListener('click', closeKelasModal);
    if (cancelKelasBtn) cancelKelasBtn.addEventListener('click', closeKelasModal);

    if (closeMapBtn) closeMapBtn.addEventListener('click', closeKelasGuruModal);
    if (cancelMapBtn) cancelMapBtn.addEventListener('click', closeKelasGuruModal);

    if (kelasForm) {
      kelasForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const isEdit = Boolean(localState.editingKelasId);
        const namaKelas = document.getElementById('kelas-nama').value.trim();
        const tingkat = document.getElementById('kelas-tingkat').value.trim();
        const keterangan = document.getElementById('kelas-keterangan').value.trim();
        const status = document.getElementById('kelas-status').value || 'aktif';

        if (!namaKelas) {
          UI.toast('Nama kelas wajib diisi.', 'error');
          return;
        }

        const payload = {
          isEdit,
          id_kelas: localState.editingKelasId || '',
          original_nama_kelas: localState.editingKelasOriginalName || '',
          nama_kelas: namaKelas,
          tingkat,
          keterangan,
          status,
        };

        UI.setButtonLoading(saveKelasBtn, true, 'Menyimpan...');
        try {
          await API.saveKelas(payload);
          closeKelasModal();
          UI.toast(`Kelas "${namaKelas}" berhasil disimpan.`, 'success');
          await loadDashboard(false, { force: true });
        } catch (err) {
          UI.toast(err.message, 'error');
        } finally {
          UI.setButtonLoading(saveKelasBtn, false);
        }
      });
    }

    if (mapForm) {
      mapForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const namaKelas = localState.mappingKelasName || document.getElementById('kelas-guru-target-nama').value.trim();
        if (!namaKelas) return;
        const selectedIds = Array.from(mapForm.querySelectorAll('input[name="kelas-guru-id"]:checked')).map(
          (cb) => cb.value
        );

        UI.setButtonLoading(saveMapBtn, true, 'Menyimpan...');
        try {
          await API.saveKelasMapping({ nama_kelas: namaKelas, guru_ids: selectedIds });
          const selectedSet = new Set(selectedIds);
          STATE.users = (STATE.users || []).map((u) => {
            if (String(u.role || '').toLowerCase() === 'admin') return u;
            const uid = String(u.id_user || u.username);
            const shouldHave = selectedSet.has(uid) || selectedSet.has(String(u.username || ''));
            const curList = Array.isArray(u.kelas_ampu) ? u.kelas_ampu : [];
            const hasNow = API.isKelasAllowed(namaKelas, curList);
            let nextList = curList;
            if (shouldHave && !hasNow) nextList = curList.concat([namaKelas]);
            else if (!shouldHave && hasNow) {
              nextList = curList.filter((k) => k.toLowerCase() !== namaKelas.toLowerCase());
            }
            return Object.assign({}, u, {
              kelas_ampu: nextList,
              kelas_ampu_text: nextList.join(', '),
            });
          });
          if (root.MDTA_CACHE) root.MDTA_CACHE.write('users', STATE.users);
          closeKelasGuruModal();
          renderUsersTable();
          renderKelasManagement();
          if (STATE.rekapKepsek) {
            const tgl = document.getElementById('kepsek-filter-tanggal')?.value || UI.todayISO();
            renderKepsekBlockFromData(STATE.rekapKepsek, tgl);
          }
          UI.toast(`Pemetaan guru pengampu untuk "${namaKelas}" tersimpan.`, 'success');
          await loadDashboard(false, { force: true });
        } catch (err) {
          UI.toast(err.message, 'error');
        } finally {
          UI.setButtonLoading(saveMapBtn, false);
        }
      });
    }
  }

  function renderUserKelasCheckboxes(selectedList) {
    const box = document.getElementById('user-kelas-checkboxes');
    if (!box) return;
    const classes = getOfficialClassNames(false);
    const extraSelected = API.parseKelasAmpu(selectedList).filter(
      (k) => !classes.some((c) => c.toLowerCase() === k.toLowerCase())
    );
    const combined = classes.concat(extraSelected);

    if (combined.length === 0) {
      box.innerHTML = `<div class="text-muted" style="grid-column:1 / -1;font-size:0.8125rem;">Belum ada kelas aktif. Tambahkan kelas pada panel Kelola Kelas terlebih dahulu.</div>`;
      return;
    }

    box.innerHTML = combined
      .map((k) => {
        const checked = API.isKelasAllowed(k, selectedList || []);
        return `
          <label class="kelas-checkbox-item">
            <input type="checkbox" name="user-kelas-ampu" value="${UI.esc(k)}" ${checked ? 'checked' : ''} />
            <span>${UI.esc(k)}</span>
          </label>
        `;
      })
      .join('');
  }

  function toggleUserKelasVisibility() {
    const roleVal = String(document.getElementById('user-role')?.value || 'guru').toLowerCase();
    const group = document.getElementById('user-kelas-ampu-group');
    const note = document.getElementById('user-kelas-admin-note');
    const isGuru = roleVal !== 'admin';
    if (group) group.hidden = !isGuru;
    if (note) note.hidden = isGuru;
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

    let selectedKelas = [];
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
      selectedKelas = Array.isArray(user.kelas_ampu) ? user.kelas_ampu : API.parseKelasAmpu(user.kelas_ampu);
    } else {
      if (title) title.textContent = 'Tambah Pengguna / Guru';
      if (passHint) passHint.textContent = 'Wajib diisi untuk akun baru.';
    }

    renderUserKelasCheckboxes(selectedKelas);
    toggleUserKelasVisibility();
    UI.openModal('modal-user');
  }

  function bindDashboardEvents() {
    const refreshBtn = document.getElementById('btn-refresh-dashboard');
    const printAllBtn = document.getElementById('btn-print-all-kelas-laporan');
    const filterTanggal = document.getElementById('kepsek-filter-tanggal');
    const filterKelas = document.getElementById('kepsek-filter-kelas');
    const searchInput = document.getElementById('admin-riwayat-search');
    const addUserBtn = document.getElementById('btn-add-user');
    const closeUserBtn = document.getElementById('btn-close-user-modal');
    const cancelUserBtn = document.getElementById('btn-cancel-user-modal');
    const roleSelect = document.getElementById('user-role');
    const userForm = document.getElementById('form-user');
    const saveUserBtn = document.getElementById('btn-save-user');

    const closeDetailBtn = document.getElementById('btn-close-detail-nilai');
    const tutupDetailBtn = document.getElementById('btn-tutup-detail-nilai');
    const printDetailBtn = document.getElementById('btn-print-detail-nilai');

    if (filterTanggal && !filterTanggal.value) filterTanggal.value = UI.todayISO();
    if (filterTanggal) filterTanggal.addEventListener('change', () => loadDashboard(false, { force: false }));
    if (filterKelas) filterKelas.addEventListener('change', () => loadDashboard(false, { force: false }));
    if (refreshBtn) refreshBtn.addEventListener('click', () => loadDashboard(true, { force: true }));
    if (printAllBtn) {
      printAllBtn.addEventListener('click', () => {
        const tgl = (filterTanggal && filterTanggal.value) || UI.todayISO();
        printKepsekLaporan('', tgl);
      });
    }

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
    if (roleSelect) roleSelect.addEventListener('change', toggleUserKelasVisibility);

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
        const checkedKelas =
          role === 'admin'
            ? []
            : Array.from(userForm.querySelectorAll('input[name="user-kelas-ampu"]:checked')).map((cb) => cb.value);

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
          kelas_ampu: checkedKelas,
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
          await loadDashboard(false, { force: true });
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
    const santriFilter = document.getElementById('santri-kelas-filter');
    const rekapFilter = document.getElementById('rekap-kelas-filter');
    const modalSantriKelas = document.getElementById('santri-kelas');
    const bulkTargetSelect = document.getElementById('santri-bulk-target-kelas');
    const moveTargetSelect = document.getElementById('move-target-kelas');

    const officialNames = getOfficialClassNames(false);

    populateClassSelect(santriFilter, officialNames, { firstLabel: 'Semua Kelas', firstValue: '' });
    populateClassSelect(rekapFilter, officialNames, { firstLabel: 'Semua Kelas', firstValue: '' });
    populateClassSelect(modalSantriKelas, officialNames, { defaultToFirst: true });
    populateClassSelect(bulkTargetSelect, officialNames, { defaultToFirst: true });
    populateClassSelect(moveTargetSelect, officialNames, { defaultToFirst: true });
  }

  function updateBulkSantriBar(visibleSantriList) {
    const bulkBar = document.getElementById('santri-bulk-bar');
    const countEl = document.getElementById('santri-bulk-count');
    const selectAllEl = document.getElementById('santri-select-all');
    const existingIds = new Set((STATE.santri || []).map((s) => s.id_santri).filter(Boolean));
    Array.from(localState.selectedSantriIds).forEach((id) => {
      if (!existingIds.has(id)) localState.selectedSantriIds.delete(id);
    });

    const selectedCount = localState.selectedSantriIds.size;
    if (bulkBar) bulkBar.hidden = selectedCount === 0;
    if (countEl) countEl.textContent = `${selectedCount} santri dipilih`;

    if (selectAllEl) {
      const list = Array.isArray(visibleSantriList) ? visibleSantriList : [];
      const selectable = list.map((s) => s.id_santri).filter(Boolean);
      const selectedInView = selectable.filter((id) => localState.selectedSantriIds.has(id)).length;
      selectAllEl.checked = selectable.length > 0 && selectedInView === selectable.length;
      selectAllEl.indeterminate = selectedInView > 0 && selectedInView < selectable.length;
    }
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
      updateBulkSantriBar(filtered);
      tbody.innerHTML = `
        <tr class="table-state-row">
          <td colspan="8">
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
      .map((s) => {
        const sid = s.id_santri || s.qr_token;
        const isChecked = s.id_santri && localState.selectedSantriIds.has(s.id_santri);
        return `
        <tr>
          <td class="snt-check" data-label="Pilih">
            <input type="checkbox" class="santri-row-checkbox" data-select-santri="${UI.esc(s.id_santri || '')}" aria-label="Pilih ${UI.esc(s.nama_lengkap)}" ${isChecked ? 'checked' : ''} ${!s.id_santri ? 'disabled' : ''} />
          </td>
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
              <button type="button" class="btn btn-secondary btn-sm" data-qr-santri="${UI.esc(sid)}">
                <i data-lucide="qr-code" aria-hidden="true"></i>
                <span>Lihat QR</span>
              </button>
              <button type="button" class="btn btn-secondary btn-sm" data-move-santri="${UI.esc(sid)}" aria-label="Pindah kelas ${UI.esc(s.nama_lengkap)}">
                <i data-lucide="arrow-right-left" aria-hidden="true"></i>
                <span>Pindah</span>
              </button>
              <button type="button" class="btn btn-secondary btn-icon-sm" data-edit-santri="${UI.esc(sid)}" aria-label="Edit santri ${UI.esc(s.nama_lengkap)}">
                <i data-lucide="pencil" aria-hidden="true"></i>
                <span class="mobile-only-btn-label">Edit</span>
              </button>
              <button type="button" class="btn btn-danger btn-icon-sm" data-delete-santri="${UI.esc(sid)}" aria-label="Hapus santri ${UI.esc(s.nama_lengkap)}">
                <i data-lucide="trash-2" aria-hidden="true"></i>
                <span class="mobile-only-btn-label">Hapus</span>
              </button>
            </div>
          </td>
        </tr>
      `;
      })
      .join('');

    updateBulkSantriBar(filtered);

    const findSantri = (key) =>
      STATE.santri.find((s) => (s.id_santri || s.qr_token) === key);

    tbody.querySelectorAll('input[data-select-santri]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const sid = cb.dataset.selectSantri;
        if (!sid) return;
        if (cb.checked) localState.selectedSantriIds.add(sid);
        else localState.selectedSantriIds.delete(sid);
        updateBulkSantriBar(filtered);
      });
    });

    tbody.querySelectorAll('button[data-qr-santri]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const s = findSantri(btn.dataset.qrSantri);
        if (s) openQRModal(s);
      });
    });

    tbody.querySelectorAll('button[data-move-santri]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const s = findSantri(btn.dataset.moveSantri);
        if (s) openMoveKelasModal(s);
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

        // Optimistic UI: langsung perbarui UI & cache sambil menghapus di server
        const prevSantri = [...STATE.santri];
        STATE.santri = STATE.santri.filter((item) => item !== s);
        if (s.id_santri) localState.selectedSantriIds.delete(s.id_santri);
        if (root.MDTA_CACHE) root.MDTA_CACHE.write('santri', STATE.santri);
        renderSantriTable();
        renderKelasManagement();
        UI.toast(`Data santri "${s.nama_lengkap}" dihapus.`, 'success');

        try {
          await API.deleteSantri(s.id_santri);
        } catch (err) {
          STATE.santri = prevSantri;
          if (root.MDTA_CACHE) root.MDTA_CACHE.write('santri', STATE.santri);
          renderSantriTable();
          renderKelasManagement();
          UI.toast(`Gagal menghapus "${s.nama_lengkap}": ${err.message}`, 'error');
        }
      });
    });

    UI.refreshIcons(tbody);
  }

  async function loadSantri(showToast, opts) {
    const force = Boolean((opts && opts.force) || showToast);
    const CACHE = root.MDTA_CACHE;
    const tbody = document.getElementById('admin-santri-tbody');
    const refreshBtn = document.getElementById('btn-refresh-santri');

    if (CACHE) CACHE.hydrateState();
    const hasCache = Array.isArray(STATE.santri) && STATE.santri.length > 0;

    if (hasCache) {
      syncClassFilterOptions();
      renderSantriTable();
    } else if (tbody) {
      tbody.innerHTML = UI.renderSkeletonRows(8, 5);
    }

    if (!force && (STATE.loaded.santri || STATE.loaded.bootstrap) && hasCache) {
      return;
    }

    if (force || !hasCache) {
      UI.setButtonLoading(refreshBtn, true, 'Memuat...');
    }

    try {
      const prevSantri = STATE.santri;
      const res = await API.getSantri();
      const freshSantri = API.extractArray(res, ['santri', 'students']).map(API.normalizeSantri);
      const changed = !CACHE || CACHE.hasChanged(prevSantri, freshSantri);
      STATE.santri = freshSantri;
      STATE.loaded.santri = true;
      if (CACHE) CACHE.write('santri', freshSantri);
      if (changed || !hasCache) {
        syncClassFilterOptions();
        renderSantriTable();
        renderKelasManagement();
      }
      if (showToast) UI.toast(`${STATE.santri.length} data santri dimuat.`, 'success');
    } catch (err) {
      if (!hasCache && tbody) {
        tbody.innerHTML = `<tr class="table-state-row"><td colspan="8">${UI.renderStateBox({
          type: 'error',
          title: 'Gagal memuat database santri',
          message: err.message,
          actionLabel: 'Coba Lagi',
          actionId: 'btn-retry-santri',
        })}</td></tr>`;
        UI.refreshIcons(tbody);
        const retryBtn = document.getElementById('btn-retry-santri');
        if (retryBtn) retryBtn.addEventListener('click', () => loadSantri(false, { force: true }));
      }
      if (force || !hasCache) UI.toast(err.message, 'error');
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

    syncClassFilterOptions();
    const title = document.getElementById('santri-modal-title');
    const kelasSel = document.getElementById('santri-kelas');
    localState.editingSantriId = santri ? (santri.id_santri || '') : null;

    document.getElementById('santri-id').value = santri ? (santri.id_santri || '') : '';
    document.getElementById('santri-nama').value = santri ? (santri.nama_lengkap || '') : '';
    document.getElementById('santri-hp').value = santri ? (santri.no_wa_ortu || '') : '';
    document.getElementById('santri-qr-token').value =
      santri && santri.qr_token ? santri.qr_token : '';
    document.getElementById('santri-status').value = santri ? (santri.status || 'aktif') : 'aktif';

    if (kelasSel) {
      const desiredClass = santri ? (santri.kelas || '') : (localState.santriKelasFilter || '');
      if (desiredClass) {
        const hasOpt = Array.from(kelasSel.options).some((opt) => opt.value === desiredClass);
        if (!hasOpt) {
          const extraOpt = document.createElement('option');
          extraOpt.value = desiredClass;
          extraOpt.textContent = `${desiredClass} (Data Lama)`;
          kelasSel.appendChild(extraOpt);
        }
        kelasSel.value = desiredClass;
      } else if (kelasSel.options.length > 0) {
        kelasSel.selectedIndex = 0;
      }
    }

    if (title) title.textContent = santri ? `Edit Santri (${santri.id_santri})` : 'Tambah Santri Baru';
    UI.openModal('modal-santri');
  }

  function closeMoveKelasModal() {
    localState.movingSantriId = '';
    const form = document.getElementById('form-move-kelas');
    if (form) form.reset();
    UI.closeModal('modal-move-kelas');
  }

  function openMoveKelasModal(santri) {
    syncClassFilterOptions();
    localState.movingSantriId = santri.id_santri || '';
    const idEl = document.getElementById('move-santri-id');
    const labelEl = document.getElementById('move-santri-label');
    const targetSel = document.getElementById('move-target-kelas');
    if (idEl) idEl.value = localState.movingSantriId;
    if (labelEl) labelEl.textContent = `${santri.nama_lengkap} (${santri.kelas || 'Tanpa Kelas'})`;
    if (targetSel && targetSel.options.length > 0) {
      const other = Array.from(targetSel.options).find((o) => o.value !== santri.kelas);
      if (other) targetSel.value = other.value;
    }
    UI.openModal('modal-move-kelas');
  }

  async function executeMoveSantriKelas(ids, targetKelas) {
    if (!Array.isArray(ids) || ids.length === 0) {
      UI.toast('Pilih minimal satu santri untuk dipindahkan.', 'warn');
      return false;
    }
    if (!targetKelas) {
      UI.toast('Pilih kelas tujuan pemindahan terlebih dahulu.', 'error');
      return false;
    }

    try {
      await API.bulkMoveSantriKelas({ ids, target_kelas: targetKelas });
    } catch (err) {
      if (!/tidak dikenali/i.test(String(err.message || ''))) {
        throw err;
      }
      // Fallback bila Code.gs belum diperbarui
      for (let i = 0; i < ids.length; i++) {
        const s = (STATE.santri || []).find((item) => item.id_santri === ids[i]);
        if (!s) continue;
        await API.saveSantri({
          isEdit: true,
          id_santri: s.id_santri,
          nama_lengkap: s.nama_lengkap,
          kelas: targetKelas,
          no_wa_ortu: s.no_wa_ortu,
          qr_token: s.qr_token,
          status: s.status,
        });
      }
    }

    const idSet = new Set(ids);
    STATE.santri = (STATE.santri || []).map((s) =>
      idSet.has(s.id_santri) ? Object.assign({}, s, { kelas: targetKelas }) : s
    );
    if (root.MDTA_CACHE) root.MDTA_CACHE.write('santri', STATE.santri);
    localState.selectedSantriIds.clear();
    STATE.loaded.bootstrap = false;
    syncClassFilterOptions();
    renderSantriTable();
    renderKelasManagement();
    return true;
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
    const selectAllEl = document.getElementById('santri-select-all');
    const bulkClearBtn = document.getElementById('btn-bulk-clear-select');
    const bulkMoveBtn = document.getElementById('btn-bulk-move-kelas');
    const bulkTargetSel = document.getElementById('santri-bulk-target-kelas');
    const refreshBtn = document.getElementById('btn-refresh-santri');
    const addBtn = document.getElementById('btn-add-santri');
    const closeSantriBtn = document.getElementById('btn-close-santri-modal');
    const cancelSantriBtn = document.getElementById('btn-cancel-santri-modal');
    const genTokenBtn = document.getElementById('btn-regen-qr-token');
    const santriForm = document.getElementById('form-santri');
    const saveSantriBtn = document.getElementById('btn-save-santri');

    const closeMoveBtn = document.getElementById('btn-close-move-kelas-modal');
    const cancelMoveBtn = document.getElementById('btn-cancel-move-kelas-modal');
    const moveForm = document.getElementById('form-move-kelas');
    const saveMoveBtn = document.getElementById('btn-save-move-kelas');

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
    if (selectAllEl) {
      selectAllEl.addEventListener('change', () => {
        const q = localState.santriQuery.trim().toLowerCase();
        const kelasF = localState.santriKelasFilter;
        const visible = STATE.santri.filter((s) => {
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
        visible.forEach((s) => {
          if (!s.id_santri) return;
          if (selectAllEl.checked) localState.selectedSantriIds.add(s.id_santri);
          else localState.selectedSantriIds.delete(s.id_santri);
        });
        renderSantriTable();
      });
    }
    if (bulkClearBtn) {
      bulkClearBtn.addEventListener('click', () => {
        localState.selectedSantriIds.clear();
        renderSantriTable();
      });
    }
    if (bulkMoveBtn) {
      bulkMoveBtn.addEventListener('click', async () => {
        const ids = Array.from(localState.selectedSantriIds);
        const targetKelas = bulkTargetSel ? bulkTargetSel.value : '';
        if (ids.length === 0 || !targetKelas) {
          UI.toast('Pilih santri dan kelas tujuan pemindahan terlebih dahulu.', 'warn');
          return;
        }
        UI.setButtonLoading(bulkMoveBtn, true, 'Memindahkan...');
        try {
          const ok = await executeMoveSantriKelas(ids, targetKelas);
          if (ok) UI.toast(`${ids.length} santri berhasil dipindahkan ke ${targetKelas}.`, 'success');
        } catch (err) {
          UI.toast(err.message, 'error');
        } finally {
          UI.setButtonLoading(bulkMoveBtn, false);
        }
      });
    }

    if (closeMoveBtn) closeMoveBtn.addEventListener('click', closeMoveKelasModal);
    if (cancelMoveBtn) cancelMoveBtn.addEventListener('click', closeMoveKelasModal);
    if (moveForm) {
      moveForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const sid = localState.movingSantriId || document.getElementById('move-santri-id')?.value;
        const targetKelas = document.getElementById('move-target-kelas')?.value || '';
        if (!sid || !targetKelas) {
          UI.toast('Pilih kelas tujuan terlebih dahulu.', 'error');
          return;
        }
        UI.setButtonLoading(saveMoveBtn, true, 'Memindahkan...');
        try {
          const ok = await executeMoveSantriKelas([sid], targetKelas);
          if (ok) {
            closeMoveKelasModal();
            UI.toast(`Santri berhasil dipindahkan ke ${targetKelas}.`, 'success');
          }
        } catch (err) {
          UI.toast(err.message, 'error');
        } finally {
          UI.setButtonLoading(saveMoveBtn, false);
        }
      });
    }

    if (refreshBtn) refreshBtn.addEventListener('click', () => loadSantri(true, { force: true }));
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
        if (!kelas) {
          UI.toast('Pilih kelas resmi santri terlebih dahulu.', 'error');
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
          STATE.loaded.bootstrap = false;
          UI.toast(`Data santri "${namaLengkap}" berhasil disimpan.`, 'success');
          await loadSantri(false, { force: true });
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
  // TAB 3: REKAP LAPORAN BULANAN (TERPISAH PER KELAS + CETAK PER HALAMAN)
  // =========================================================================
  function getFilteredRekapRows(onlyKelas) {
    const kelasF = onlyKelas !== undefined ? onlyKelas : document.getElementById('rekap-kelas-filter')?.value || '';
    return STATE.rekap.filter((r) =>
      !kelasF ? true : String(r.kelas || '').trim().toLowerCase() === kelasF.trim().toLowerCase()
    );
  }

  function groupRekapByClass(rows) {
    const groups = new Map();
    (Array.isArray(rows) ? rows : []).forEach((r) => {
      const k = String(r.kelas || 'Tanpa Kelas').trim() || 'Tanpa Kelas';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    });

    const officialOrder = getOfficialClassNames(false);
    const orderedKeys = Array.from(groups.keys()).sort((a, b) => {
      const idxA = officialOrder.indexOf(a);
      const idxB = officialOrder.indexOf(b);
      if (idxA >= 0 && idxB >= 0) return idxA - idxB;
      if (idxA >= 0) return -1;
      if (idxB >= 0) return 1;
      return a.localeCompare(b);
    });

    return orderedKeys.map((k) => {
      const classRows = groups.get(k) || [];
      const gurus = getGurusForClass(k);
      const guruNames =
        gurus.length > 0 ? gurus.map((g) => g.nama_lengkap || g.username).join(', ') : 'Belum dipetakan';
      const totalHadir = classRows.reduce((s, r) => s + Number(r.hadir || 0), 0);
      const totalSakit = classRows.reduce((s, r) => s + Number(r.sakit || 0), 0);
      const totalIzin = classRows.reduce((s, r) => s + Number(r.izin || 0), 0);
      const totalAlpa = classRows.reduce((s, r) => s + Number(r.alpa || 0), 0);
      const totalAll = totalHadir + totalSakit + totalIzin + totalAlpa;
      const avgPct = totalAll > 0 ? Math.round((totalHadir / totalAll) * 100) : 0;

      return {
        kelas: k,
        guru_pengampu_names: guruNames,
        rows: classRows,
        totalHadir,
        totalSakit,
        totalIzin,
        totalAlpa,
        avgPct,
      };
    });
  }

  function renderRekapSubtabs() {
    const bar = document.getElementById('rekap-kelas-subtabs');
    const kelasSelect = document.getElementById('rekap-kelas-filter');
    if (!bar) return;

    const activeKelas = kelasSelect ? kelasSelect.value : '';
    const allGroups = groupRekapByClass(STATE.rekap);
    const nameSet = new Set(getOfficialClassNames(false));
    allGroups.forEach((g) => nameSet.add(g.kelas));
    const names = Array.from(nameSet).sort((a, b) => a.localeCompare(b));

    const buttons = [
      `<button type="button" class="kelas-subtab" data-rekap-subtab="" aria-pressed="${!activeKelas ? 'true' : 'false'}">Semua Kelas (${STATE.rekap.length} santri)</button>`,
    ];
    names.forEach((k) => {
      const grp = allGroups.find((g) => g.kelas.toLowerCase() === k.toLowerCase());
      const cnt = grp ? grp.rows.length : 0;
      const pressed = activeKelas && activeKelas.toLowerCase() === k.toLowerCase();
      buttons.push(
        `<button type="button" class="kelas-subtab" data-rekap-subtab="${UI.esc(k)}" aria-pressed="${pressed ? 'true' : 'false'}">${UI.esc(k)} (${cnt})</button>`
      );
    });

    bar.innerHTML = buttons.join('');
    bar.querySelectorAll('button[data-rekap-subtab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (kelasSelect) {
          kelasSelect.value = btn.dataset.rekapSubtab || '';
          renderRekapTable();
        }
      });
    });
  }

  function renderRekapTable() {
    const container = document.getElementById('admin-rekap-grouped-container');
    const periodEl = document.getElementById('rekap-period-label');
    if (!container) return;

    const bulan = Number(document.getElementById('rekap-bulan').value) || 1;
    const tahun = Number(document.getElementById('rekap-tahun').value) || new Date().getFullYear();
    const bulanNama = CONFIG.MONTH_NAMES[bulan - 1] || String(bulan);
    const rows = getFilteredRekapRows();
    const grouped = groupRekapByClass(rows);

    if (periodEl) {
      periodEl.textContent = `Periode: ${bulanNama} ${tahun} (${rows.length} santri dalam ${grouped.length} kelas)`;
    }

    renderRekapSubtabs();

    if (rows.length === 0) {
      container.innerHTML = UI.renderStateBox({
        type: 'empty',
        title: 'Belum ada data rekap pada periode ini',
        message: `Tidak ditemukan data presensi untuk bulan ${bulanNama} ${tahun}. Pilih periode lain atau muat ulang.`,
      });
      UI.refreshIcons(container);
      return;
    }

    container.innerHTML = grouped
      .map(
        (grp) => `
        <article class="rekap-kelas-card">
          <div class="rekap-kelas-header">
            <div style="min-width:0;flex:1 1 240px;">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <h3 class="heading-md">${UI.esc(grp.kelas)}</h3>
                <span class="status-badge status-izin mono-num">${grp.rows.length} santri</span>
                <span class="status-badge mono-num ${grp.avgPct >= 80 ? 'status-hadir' : grp.avgPct >= 60 ? 'status-sakit' : 'status-alpa'}">
                  Kehadiran: ${grp.avgPct}%
                </span>
              </div>
              <div class="text-secondary" style="font-size:0.84rem;margin-top:4px;">
                Guru Pengampu: <strong>${UI.esc(grp.guru_pengampu_names)}</strong> · H: ${grp.totalHadir} · S: ${grp.totalSakit} · I: ${grp.totalIzin} · A: ${grp.totalAlpa}
              </div>
            </div>
            <div class="toolbar-actions" style="flex-shrink:0;">
              <button type="button" class="btn btn-secondary btn-sm" data-export-rekap-kelas="${UI.esc(grp.kelas)}">
                <i data-lucide="file-spreadsheet" aria-hidden="true"></i>
                <span>CSV Kelas</span>
              </button>
              <button type="button" class="btn btn-secondary btn-sm" data-print-rekap-kelas="${UI.esc(grp.kelas)}">
                <i data-lucide="printer" aria-hidden="true"></i>
                <span>Cetak PDF Kelas</span>
              </button>
            </div>
          </div>

          <div class="table-scroll mobile-cards-wrap">
            <table class="data-table mobile-cards-table mobile-cards-rekap">
              <thead>
                <tr>
                  <th style="width:48px;">No</th>
                  <th>ID Santri</th>
                  <th>Nama Santri</th>
                  <th>Kelas</th>
                  <th>Hadir</th>
                  <th>Sakit</th>
                  <th>Izin</th>
                  <th>Alpa</th>
                  <th>Kehadiran</th>
                </tr>
              </thead>
              <tbody>
                ${grp.rows
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
                  .join('')}
              </tbody>
            </table>
          </div>
        </article>
      `
      )
      .join('');

    container.querySelectorAll('button[data-export-rekap-kelas]').forEach((btn) => {
      btn.addEventListener('click', () => exportRekapCSV(btn.dataset.exportRekapKelas));
    });

    container.querySelectorAll('button[data-print-rekap-kelas]').forEach((btn) => {
      btn.addEventListener('click', () => printRekapPDF(btn.dataset.printRekapKelas));
    });

    UI.refreshIcons(container);
  }

  async function loadRekapLaporan(showToast, opts) {
    const force = Boolean((opts && opts.force) || showToast);
    const CACHE = root.MDTA_CACHE;
    const container = document.getElementById('admin-rekap-grouped-container');
    const fetchBtn = document.getElementById('btn-fetch-rekap');
    const bulan = document.getElementById('rekap-bulan').value;
    const tahun = document.getElementById('rekap-tahun').value;

    if (CACHE && STATE.rekap.length === 0) {
      const c = CACHE.read('rekap');
      if (c && c.data && Array.isArray(c.data.rows)) {
        STATE.rekap = c.data.rows;
        STATE.lastRekapPeriod = c.data.period || null;
      }
    }

    const samePeriod =
      STATE.lastRekapPeriod &&
      String(STATE.lastRekapPeriod.bulan) === String(bulan) &&
      String(STATE.lastRekapPeriod.tahun) === String(tahun);
    const hasCache = Array.isArray(STATE.rekap) && STATE.rekap.length > 0 && samePeriod;

    if (hasCache) {
      renderRekapTable();
      if (!force && STATE.loaded.rekap) return;
    } else if (container) {
      container.innerHTML = UI.renderStateBox({
        type: 'loading',
        title: 'Memuat Rekap Laporan Bulanan',
        message: 'Mengambil rekap presensi santri dan mengelompokkan per kelas...',
      });
      UI.refreshIcons(container);
    }

    if (force || !hasCache) {
      UI.setButtonLoading(fetchBtn, true, 'Memuat...');
    }

    try {
      const prevRekap = STATE.rekap;
      const res = await API.getRekapLaporan(bulan, tahun);
      const freshRekap = API.extractArray(res, ['rekap', 'laporan', 'summary']).map(API.normalizeRekap);
      const changed = !CACHE || CACHE.hasChanged(prevRekap, freshRekap) || !samePeriod;
      STATE.rekap = freshRekap;
      STATE.lastRekapPeriod = { bulan, tahun };
      STATE.loaded.rekap = true;
      if (CACHE) CACHE.write('rekap', { period: STATE.lastRekapPeriod, rows: freshRekap });
      if (changed || !hasCache) renderRekapTable();
      if (showToast) UI.toast(`Rekap laporan ${CONFIG.MONTH_NAMES[Number(bulan) - 1]} ${tahun} dimuat.`, 'success');
    } catch (err) {
      if (!hasCache) {
        STATE.rekap = [];
        if (container) {
          container.innerHTML = UI.renderStateBox({
            type: 'error',
            title: 'Gagal memuat rekap laporan',
            message: err.message,
            actionLabel: 'Coba Lagi',
            actionId: 'btn-retry-rekap',
          });
          UI.refreshIcons(container);
          const retryBtn = document.getElementById('btn-retry-rekap');
          if (retryBtn) retryBtn.addEventListener('click', () => loadRekapLaporan(false, { force: true }));
        }
      }
      if (force || !hasCache) UI.toast(err.message, 'error');
    } finally {
      UI.setButtonLoading(fetchBtn, false);
    }
  }

  function exportRekapCSV(onlyKelas) {
    const rows = getFilteredRekapRows(onlyKelas);
    if (rows.length === 0) {
      UI.toast('Belum ada data rekap untuk diekspor ke CSV.', 'warn');
      return;
    }

    const grouped = groupRekapByClass(rows);
    const bulan = Number(document.getElementById('rekap-bulan').value) || 1;
    const tahun = document.getElementById('rekap-tahun').value;
    const bulanNama = CONFIG.MONTH_NAMES[bulan - 1] || String(bulan);

    const escapeCsv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const headers = [
      'No',
      'Kelas',
      'Guru Pengampu',
      'ID Santri',
      'Nama Lengkap',
      'Hadir',
      'Sakit',
      'Izin',
      'Alpa',
      'Total Pertemuan',
      'Persentase Kehadiran (%)',
    ];
    const lines = [headers.map(escapeCsv).join(',')];

    let no = 1;
    grouped.forEach((grp) => {
      grp.rows.forEach((r) => {
        lines.push(
          [
            no++,
            grp.kelas,
            grp.guru_pengampu_names,
            r.id_santri || '-',
            r.nama_lengkap,
            r.hadir,
            r.sakit,
            r.izin,
            r.alpa,
            r.total,
            `${r.persentase}%`,
          ]
            .map(escapeCsv)
            .join(',')
        );
      });
    });

    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const suffix = onlyKelas ? `-${onlyKelas.replace(/[^a-zA-Z0-9]+/g, '-')}` : '';
    a.download = `Rekap-Presensi-MDTA${suffix}-${bulanNama}-${tahun}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    UI.toast(`File CSV Rekap ${onlyKelas ? `${onlyKelas} ` : ''}${bulanNama} ${tahun} berhasil diunduh.`, 'success');
  }

  function printRekapPDF(onlyKelas) {
    const printContainer = document.getElementById('rekap-print-pages');
    if (!printContainer) return;

    const bulan = Number(document.getElementById('rekap-bulan').value) || 1;
    const tahun = document.getElementById('rekap-tahun').value;
    const bulanNama = CONFIG.MONTH_NAMES[bulan - 1] || String(bulan);
    const rows = getFilteredRekapRows(onlyKelas);
    const grouped = groupRekapByClass(rows);

    if (grouped.length === 0) {
      UI.toast('Belum ada data rekap untuk dicetak.', 'warn');
      return;
    }

    printContainer.innerHTML = grouped
      .map(
        (grp) => `
        <div class="print-class-page">
          <div class="print-kop">
            <div>
              <h2 class="print-kop-title">${UI.esc(CONFIG.INSTITUTION_NAME)}</h2>
              <p class="print-kop-sub">Rekapitulasi Kehadiran Santri (${UI.esc(CONFIG.INSTITUTION_LOCATION)})</p>
              <p class="print-kop-sub">Kelas: <strong>${UI.esc(grp.kelas)}</strong> | Guru Pengampu: <strong>${UI.esc(grp.guru_pengampu_names)}</strong> | Periode: ${UI.esc(bulanNama)} ${UI.esc(tahun)}</p>
            </div>
          </div>

          <table class="data-table">
            <thead>
              <tr>
                <th style="width:42px;">No</th>
                <th>ID Santri</th>
                <th>Nama Santri</th>
                <th>Hadir</th>
                <th>Sakit</th>
                <th>Izin</th>
                <th>Alpa</th>
                <th>Kehadiran</th>
              </tr>
            </thead>
            <tbody>
              ${grp.rows
                .map(
                  (r, idx) => `
                <tr>
                  <td>${idx + 1}</td>
                  <td>${UI.esc(r.id_santri || '-')}</td>
                  <td><strong>${UI.esc(r.nama_lengkap)}</strong></td>
                  <td>${r.hadir}</td>
                  <td>${r.sakit}</td>
                  <td>${r.izin}</td>
                  <td>${r.alpa}</td>
                  <td>${r.persentase}%</td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>

          <div class="print-signatures">
            <div class="print-sign-box">
              <div>Mengetahui,</div>
              <div>Kepala Madrasah MDTA</div>
              <div class="print-sign-space"></div>
              <div><strong>( ____________________ )</strong></div>
            </div>
            <div class="print-sign-box">
              <div>${UI.esc(CONFIG.INSTITUTION_LOCATION)}</div>
              <div>Guru Pengampu (${UI.esc(grp.kelas)})</div>
              <div class="print-sign-space"></div>
              <div><strong>${UI.esc(grp.guru_pengampu_names !== 'Belum dipetakan' ? grp.guru_pengampu_names : '( ____________________ )')}</strong></div>
            </div>
          </div>
        </div>
      `
      )
      .join('');

    document.body.classList.add('printing-rekap');
    window.print();
    setTimeout(() => document.body.classList.remove('printing-rekap'), 300);
  }

  function generateRekapPDFBase64(bulanNama, tahun) {
    if (!root.jspdf || typeof root.jspdf.jsPDF !== 'function') {
      throw new Error('Library jsPDF belum termuat. Gunakan opsi unggah berkas PDF dari perangkat Anda.');
    }
    const grouped = groupRekapByClass(getFilteredRekapRows());
    const doc = new root.jspdf.jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    const drawClassHeader = (grp) => {
      doc.setFontSize(14);
      doc.text(CONFIG.INSTITUTION_NAME, 14, 18);
      doc.setFontSize(11);
      doc.text(`Rekap Laporan Presensi MDTA: ${bulanNama} ${tahun} - ${grp.kelas}`, 14, 25);
      doc.setFontSize(9);
      doc.text(`Guru Pengampu: ${grp.guru_pengampu_names} | Dicetak: ${UI.formatDateShort(new Date())}`, 14, 31);

      const y = 40;
      doc.text('No', 14, y);
      doc.text('ID', 24, y);
      doc.text('Nama Santri', 44, y);
      doc.text('H', 132, y);
      doc.text('S', 145, y);
      doc.text('I', 158, y);
      doc.text('A', 171, y);
      doc.text('%', 184, y);
      doc.line(14, y + 2, 196, y + 2);
      return y + 8;
    };

    grouped.forEach((grp, grpIdx) => {
      if (grpIdx > 0) doc.addPage();
      let y = drawClassHeader(grp);

      grp.rows.forEach((r, idx) => {
        if (y > 275) {
          doc.addPage();
          y = drawClassHeader(grp);
        }
        doc.text(String(idx + 1), 14, y);
        doc.text(String(r.id_santri || '-').slice(0, 8), 24, y);
        doc.text(String(r.nama_lengkap).slice(0, 36), 44, y);
        doc.text(String(r.hadir), 132, y);
        doc.text(String(r.sakit), 145, y);
        doc.text(String(r.izin), 158, y);
        doc.text(String(r.alpa), 171, y);
        doc.text(`${r.persentase}%`, 184, y);
        y += 7;
      });
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
    if (csvBtn) csvBtn.addEventListener('click', () => exportRekapCSV());
    if (printBtn) printBtn.addEventListener('click', () => printRekapPDF());

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
      bindKelasEvents();
      bindSantriEvents();
      bindRekapEvents();

      tabController = UI.initSlidingTabs(tablist, (tabName) => {
        if (tabName === 'santri') {
          if (STATE.santri.length > 0) {
            syncClassFilterOptions();
            renderSantriTable();
          }
          if (!STATE.loaded.santri && !STATE.loaded.bootstrap) {
            loadSantri(false);
          }
        } else if (tabName === 'rekap') {
          if (STATE.rekap.length > 0) {
            renderRekapTable();
          }
          if (!STATE.loaded.rekap) {
            loadRekapLaporan(false);
          }
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

    loadDashboard(false, { force: false });
  }

  root.MDTA_ADMIN = {
    init,
    loadDashboard,
    loadSantri,
    loadRekapLaporan,
  };
})(window);
