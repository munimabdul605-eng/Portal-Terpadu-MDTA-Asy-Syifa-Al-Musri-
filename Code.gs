/**
 * ============================================================================
 * BACKEND GOOGLE APPS SCRIPT - SISTEM MADRASAH (MDTA ASY SYIFA AL MUSRI')
 * Terhubung ke:
 * - Google Sheets: Database Sistem MDTA (1AL5a6m1aIcJvODOlTZ1DzPghddz34bRT3bfOBfBxrqY)
 * - Google Drive : Sistem MDTA - Database & Dokumen (1mgtcD4ipQjBjiqL6omZjBnJyuz3QAT_6)
 * ============================================================================
 */

const CONFIG = {
  SPREADSHEET_ID: '1AL5a6m1aIcJvODOlTZ1DzPghddz34bRT3bfOBfBxrqY',
  FOLDER_ARSIP_ID: '1FtDyo6Nxq0iX5tv7iKeSWrT_XPToK0Nh',
  FOLDER_UPLOAD_AI_ID: '1x-F9wQThtTcXIz-XgDIMmXzBelMrQXot',
  FOLDER_LAPORAN_PDF_ID: '1neoKIVTmIhKV71sOzmANg3D7wy9Xutgy',
  GEMINI_MODEL: 'gemini-2.5-flash'
};

const LOG_SETORAN_HEADERS = [
  'id_setoran',
  'tanggal',
  'jenis_laporan',
  'kelas',
  'periode',
  'id_guru',
  'nama_guru',
  'ringkasan',
  'waktu_submit'
];

/**
 * Helper untuk merespons JSON dengan format standar
 */
function jsonResponse(success, data, message = '') {
  return ContentService
    .createTextOutput(JSON.stringify({
      success: success,
      message: message,
      data: data,
      timestamp: new Date().toISOString()
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Helper parsing angka aman (mendukung desimal koma Indonesia "88,6")
 */
function parseNumSafe(val, fallback = 0) {
  if (typeof val === 'number') return isFinite(val) ? val : fallback;
  if (val === null || val === undefined || val === '') return fallback;
  const parsed = Number(String(val).trim().replace('%', '').replace(',', '.'));
  return isFinite(parsed) ? parsed : fallback;
}

/**
 * Helper mendeteksi nilai error spreadsheet (#ERROR!, #NAME?, dll) atau sel kosong
 */
function isSheetErrorValue(val) {
  if (val === null || val === undefined) return true;
  const s = String(val).trim();
  if (!s) return true;
  return /^#(ERROR!|NAME\?|VALUE!|REF!|DIV\/0!|N\/A|NUM!|NULL!)/i.test(s);
}

/**
 * Menghitung grade dan keterangan raport murni dalam JavaScript (tanpa rumus Sheets)
 */
function computeRaportGrade(nAkhir) {
  const score = parseNumSafe(nAkhir, 0);
  if (score >= 90) return { grade: 'A', keterangan: 'Sangat Baik' };
  if (score >= 80) return { grade: 'B', keterangan: 'Baik' };
  if (score >= 70) return { grade: 'C', keterangan: 'Cukup' };
  return { grade: 'D', keterangan: 'Kurang' };
}

/**
 * Menormalkan satu baris nilai raport termasuk memulihkan data lama #ERROR!
 */
function resolveRaportRowValues(r) {
  const nHarian = parseNumSafe(r.n_harian, 0);
  const nUas = parseNumSafe(r.n_uas, 0);
  const nHadir = parseNumSafe(r.n_kehadiran, 0);
  const bH = parseNumSafe(r.bobot_harian, 40);
  const bU = parseNumSafe(r.bobot_uas, 40);
  const bK = parseNumSafe(r.bobot_kehadiran, 20);
  const bSum = (bH + bU + bK) || 100;
  const computedAkhir = Math.round(((nHarian * bH + nUas * bU + nHadir * bK) / bSum) * 100) / 100;

  const rawAkhir = parseNumSafe(r.n_akhir, NaN);
  const nAkhir = (!isSheetErrorValue(r.n_akhir) && isFinite(rawAkhir))
    ? Math.round(rawAkhir * 100) / 100
    : computedAkhir;

  const computed = computeRaportGrade(nAkhir);
  const rawGrade = !isSheetErrorValue(r.grade) ? String(r.grade).trim().toUpperCase() : '';
  const grade = ['A', 'B', 'C', 'D'].indexOf(rawGrade) >= 0 ? rawGrade : computed.grade;
  const keterangan = !isSheetErrorValue(r.keterangan) ? String(r.keterangan).trim() : computed.keterangan;

  return {
    n_harian: nHarian,
    n_uas: nUas,
    n_kehadiran: nHadir,
    bobot_harian: bH,
    bobot_uas: bU,
    bobot_kehadiran: bK,
    n_akhir: nAkhir,
    grade: grade,
    keterangan: keterangan
  };
}

/**
 * Menghasilkan ID berurutan unik berdasarkan angka tertinggi yang ada + 1 (anti-timpa)
 */
function generateUniqueSequentialId(rows, fieldName, prefix, padLen, extraUsedSet) {
  const used = new Set(extraUsedSet || []);
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('^' + escapedPrefix + '(\\d+)$', 'i');
  let maxNum = 0;

  (rows || []).forEach(r => {
    const val = String(r[fieldName] || '').trim();
    if (!val) return;
    used.add(val);
    const m = val.match(pattern);
    if (m) {
      const num = parseInt(m[1], 10);
      if (isFinite(num) && num > maxNum) maxNum = num;
    }
  });

  used.forEach(val => {
    const m = String(val).match(pattern);
    if (m) {
      const num = parseInt(m[1], 10);
      if (isFinite(num) && num > maxNum) maxNum = num;
    }
  });

  let next = maxNum + 1;
  let candidate = prefix + String(next).padStart(padLen, '0');
  while (used.has(candidate)) {
    next++;
    candidate = prefix + String(next).padStart(padLen, '0');
  }
  if (extraUsedSet) {
    extraUsedSet.add(candidate);
  }
  return candidate;
}

/**
 * Helper format tanggal WIB yyyy-MM-dd dari Date atau string
 */
function formatDateOnlyWIB(val) {
  if (!val) return '';
  if (val instanceof Date) {
    return Utilities.formatDate(val, 'Asia/Jakarta', 'yyyy-MM-dd');
  }
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return Utilities.formatDate(d, 'Asia/Jakarta', 'yyyy-MM-dd');
  }
  return s;
}

/**
 * Helper format waktu WIB HH:mm:ss dari Date atau string
 */
function formatTimeOnlyWIB(val) {
  if (!val) return '';
  if (val instanceof Date) {
    return Utilities.formatDate(val, 'Asia/Jakarta', 'HH:mm:ss');
  }
  const s = String(val).trim();
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) return s;
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return Utilities.formatDate(d, 'Asia/Jakarta', 'HH:mm:ss');
  }
  return s;
}

/**
 * Memastikan sheet Log_Setoran tersedia beserta header kolomnya
 */
function ensureLogSetoranSheet() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let sheet = ss.getSheetByName('Log_Setoran');
  if (!sheet) {
    sheet = ss.insertSheet('Log_Setoran');
    sheet.appendRow(LOG_SETORAN_HEADERS);
    sheet.getRange(1, 1, 1, LOG_SETORAN_HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(LOG_SETORAN_HEADERS);
    sheet.getRange(1, 1, 1, LOG_SETORAN_HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Helper untuk membaca seluruh baris sheet menjadi array of objects
 */
function getSheetData(sheetName) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet && sheetName === 'Log_Setoran') {
    sheet = ensureLogSetoranSheet();
  }
  if (!sheet) throw new Error('Sheet tidak ditemukan: ' + sheetName);
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];

  const headers = values[0].map(h => String(h).trim());
  return values.slice(1).map((row, idx) => {
    const obj = { _rowIndex: idx + 2 };
    headers.forEach((h, colIdx) => {
      obj[h] = row[colIdx];
    });
    return obj;
  });
}

/**
 * Helper untuk mendapatkan header dan sheet object
 */
function getSheetAndHeaders(sheetName) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet && sheetName === 'Log_Setoran') {
    sheet = ensureLogSetoranSheet();
  }
  if (!sheet) throw new Error('Sheet tidak ditemukan: ' + sheetName);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  return { sheet, headers };
}

/**
 * Endpoint GET untuk pembacaan data cepat, pengecekan API, & rekap Kepsek
 */
function doGet(e) {
  try {
    const params = (e && e.parameter) ? e.parameter : {};
    const action = params.action ? params.action : 'ping';

    switch (action) {
      case 'ping':
        return jsonResponse(true, { status: 'online' }, 'API Sistem MDTA aktif.');
      case 'getDashboard':
        return jsonResponse(true, handleGetDashboard());
      case 'getUsers':
        return jsonResponse(true, handleGetUsers());
      case 'getSantri':
        return jsonResponse(true, getSheetData('Santri'));
      case 'getPresensi':
        return jsonResponse(true, getSheetData('Presensi'));
      case 'getRekapLaporan':
        return jsonResponse(true, handleGetRekapLaporan(params.bulan, params.tahun));
      case 'getNilaiUAS':
        return jsonResponse(true, getSheetData('Nilai_UAS'));
      case 'getNilaiRaport':
        return jsonResponse(true, handleGetNilaiRaport());
      case 'getDokumenArsip':
        return jsonResponse(true, getSheetData('Dokumen_Arsip'));
      case 'getLogSetoran':
        return jsonResponse(true, handleGetLogSetoran(params));
      case 'getRekapKepsek':
        return jsonResponse(true, handleGetRekapKepsek(params.tanggal, params.kelas));
      default:
        return jsonResponse(false, null, 'Action GET tidak dikenali: ' + action);
    }
  } catch (err) {
    return jsonResponse(false, null, err.message);
  }
}

/**
 * Endpoint POST untuk login, mutasi data (CRUD), upload Drive, Impor AI, & Setoran Guru
 * Menggunakan text/plain JSON body agar bebas dari masalah CORS preflight
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    const payload = JSON.parse(e.postData.contents || '{}');
    const action = payload.action;

    switch (action) {
      case 'login':
        return jsonResponse(true, handleLogin(payload));
      case 'saveUser':
        return jsonResponse(true, handleSaveUser(payload.data), 'Data pengguna tersimpan.');
      case 'deleteUser':
        return jsonResponse(true, handleDeleteById('Users', 'id_user', payload.id_user), 'Pengguna dihapus.');
      case 'saveSantri':
        return jsonResponse(true, handleSaveSantri(payload.data), 'Data santri tersimpan.');
      case 'deleteSantri':
        return jsonResponse(true, handleDeleteById('Santri', 'id_santri', payload.id_santri), 'Data santri dihapus.');
      case 'savePresensi':
        return jsonResponse(true, handleSavePresensi(payload.data), 'Presensi berhasil dicatat.');
      case 'saveNilaiUAS':
        return jsonResponse(true, handleSaveNilaiUAS(payload.data), 'Nilai UAS tersimpan.');
      case 'saveNilaiRaport':
        return jsonResponse(true, handleSaveNilaiRaport(payload.data), 'Nilai raport tersimpan.');
      case 'uploadDokumenDrive':
        return jsonResponse(true, handleUploadDokumenDrive(payload.data), 'Dokumen berhasil diunggah ke Drive.');
      case 'importNilaiAI':
        return jsonResponse(true, handleImportNilaiAI(payload.data), 'Analisis AI selesai.');
      case 'submitLaporanGuru':
        return jsonResponse(true, handleSubmitLaporanGuru(payload.data), 'Laporan guru berhasil dikirim ke Kepala Madrasah.');
      default:
        return jsonResponse(false, null, 'Action POST tidak dikenali: ' + action);
    }
  } catch (err) {
    return jsonResponse(false, null, err.message);
  } finally {
    lock.releaseLock();
  }
}

/* ============================================================================
 * HANDLER MODUL
 * ============================================================================ */

function handleLogin(payload) {
  const { username, password } = payload;
  if (!username || !password) throw new Error('Username dan kata sandi wajib diisi.');

  const users = getSheetData('Users');
  const found = users.find(u =>
    String(u.username).trim() === String(username).trim() &&
    String(u.password) === String(password)
  );

  if (!found) throw new Error('Username atau kata sandi salah.');
  if (String(found.status_aktif).toLowerCase() !== 'aktif') {
    throw new Error('Akun Anda sedang nonaktif. Hubungi Administrator.');
  }

  const token = Utilities.base64EncodeWebSafe(found.id_user + ':' + Date.now());
  return {
    token: token,
    user: {
      id_user: found.id_user,
      username: found.username,
      nama_lengkap: found.nama_lengkap,
      role: found.role
    }
  };
}

function handleGetUsers() {
  return getSheetData('Users').map(u => ({
    id_user: u.id_user,
    username: u.username,
    nama_lengkap: u.nama_lengkap,
    role: u.role,
    status_aktif: u.status_aktif,
    created_at: u.created_at
  }));
}

function handleGetNilaiRaport() {
  return getSheetData('Nilai_Raport').map(r => {
    const resolved = resolveRaportRowValues(r);
    return {
      id_raport: String(r.id_raport || ''),
      id_santri: String(r.id_santri || ''),
      nama_santri: String(r.nama_santri || ''),
      kelas: String(r.kelas || ''),
      periode: String(r.periode || 'Ganjil 2026/2027'),
      n_harian: resolved.n_harian,
      n_uas: resolved.n_uas,
      n_kehadiran: resolved.n_kehadiran,
      bobot_harian: resolved.bobot_harian,
      bobot_uas: resolved.bobot_uas,
      bobot_kehadiran: resolved.bobot_kehadiran,
      n_akhir: resolved.n_akhir,
      grade: resolved.grade,
      keterangan: resolved.keterangan,
      updated_at: formatDateOnlyWIB(r.updated_at)
    };
  });
}

function handleGetDashboard() {
  const presensi = getSheetData('Presensi');
  const users = handleGetUsers();
  const santri = getSheetData('Santri');

  const summary = { Hadir: 0, Sakit: 0, Izin: 0, Alpa: 0 };
  presensi.forEach(p => {
    if (Object.prototype.hasOwnProperty.call(summary, p.status)) summary[p.status]++;
  });

  const recentPresensi = presensi.slice().reverse().slice(0, 50);
  return {
    summary: summary,
    total_santri: santri.length,
    total_presensi: presensi.length,
    riwayat_presensi: recentPresensi,
    daftar_pengguna: users
  };
}

function handleSaveUser(data) {
  const { sheet, headers } = getSheetAndHeaders('Users');
  const rows = getSheetData('Users');
  const now = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  const username = String((data && data.username) || '').trim();
  const namaLengkap = String((data && data.nama_lengkap) || '').trim();

  if (!username || !namaLengkap) {
    throw new Error('Nama lengkap dan username wajib diisi.');
  }

  const isEdit = Boolean(data && data.isEdit === true);
  const targetId = String((data && data.id_user) || '').trim();

  if (isEdit) {
    if (!targetId) {
      throw new Error('ID pengguna tidak valid untuk mode edit.');
    }
    let existing = rows.find(r => String(r.id_user || '').trim() === targetId);
    if (!existing) {
      const origUser = String((data && data.original_username) || targetId).trim().toLowerCase();
      existing = rows.find(
        r => String(r.id_user || '').trim() === '' && String(r.username || '').trim().toLowerCase() === origUser
      );
    }
    if (!existing) {
      throw new Error('Data pengguna yang akan diubah tidak ditemukan.');
    }

    const dupUsername = rows.some(
      r => r._rowIndex !== existing._rowIndex && String(r.username || '').trim().toLowerCase() === username.toLowerCase()
    );
    if (dupUsername) {
      throw new Error('Username "' + username + '" sudah dipakai oleh akun lain.');
    }

    const finalId = String(existing.id_user || '').trim() || generateUniqueSequentialId(rows, 'id_user', 'USR-', 3);
    const updated = headers.map(h => {
      if (h === 'id_user') return finalId;
      if (h === 'username') return username;
      if (h === 'nama_lengkap') return namaLengkap;
      if (h === 'password') return data.password ? String(data.password) : existing.password;
      if (h === 'created_at') return existing.created_at || now;
      return data[h] !== undefined ? data[h] : existing[h];
    });
    sheet.getRange(existing._rowIndex, 1, 1, headers.length).setValues([updated]);
    return { id_user: finalId, updated: true };
  }

  const dupNewUsername = rows.some(
    r => String(r.username || '').trim().toLowerCase() === username.toLowerCase()
  );
  if (dupNewUsername) {
    throw new Error('Username "' + username + '" sudah digunakan oleh akun lain. Gunakan username berbeda.');
  }

  const newId = generateUniqueSequentialId(rows, 'id_user', 'USR-', 3);
  const newRowValues = {
    id_user: newId,
    username: username,
    password: (data && data.password) ? String(data.password) : '123456',
    nama_lengkap: namaLengkap,
    role: (data && data.role) ? String(data.role).trim() : 'guru',
    status_aktif: (data && data.status_aktif) ? String(data.status_aktif).trim() : 'aktif',
    created_at: now
  };
  sheet.appendRow(headers.map(h => newRowValues[h] !== undefined ? newRowValues[h] : ''));
  return { id_user: newId, created: true };
}

function handleSaveSantri(data) {
  const { sheet, headers } = getSheetAndHeaders('Santri');
  const rows = getSheetData('Santri');
  const now = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  const namaLengkap = String((data && data.nama_lengkap) || '').trim();

  if (!namaLengkap) {
    throw new Error('Nama lengkap santri wajib diisi.');
  }

  const isEdit = Boolean(data && data.isEdit === true);
  const targetId = String((data && data.id_santri) || '').trim();

  if (isEdit) {
    if (!targetId) {
      throw new Error('ID santri tidak valid untuk mode edit.');
    }
    const existing = rows.find(r => String(r.id_santri || '').trim() === targetId);
    if (!existing) {
      throw new Error('Data santri yang akan diubah tidak ditemukan.');
    }

    const finalQrToken = String((data && data.qr_token) || '').trim() ||
      String(existing.qr_token || '').trim() ||
      ('QR-MDTA-' + existing.id_santri.replace(/[^a-zA-Z0-9]/g, ''));

    const updated = headers.map(h => {
      if (h === 'id_santri') return existing.id_santri;
      if (h === 'nama_lengkap') return namaLengkap;
      if (h === 'qr_token') return finalQrToken;
      if (h === 'created_at') return existing.created_at || now;
      return data[h] !== undefined ? data[h] : existing[h];
    });
    sheet.getRange(existing._rowIndex, 1, 1, headers.length).setValues([updated]);
    return { id_santri: existing.id_santri, qr_token: finalQrToken, updated: true };
  }

  const idSantri = generateUniqueSequentialId(rows, 'id_santri', 'S-', 3);
  const existingQr = new Set(rows.map(r => String(r.qr_token || '').trim()).filter(Boolean));
  let qrToken = String((data && data.qr_token) || '').trim() ||
    ('QR-MDTA-' + idSantri.replace(/[^a-zA-Z0-9]/g, ''));
  if (existingQr.has(qrToken)) {
    qrToken = 'QR-MDTA-' + idSantri.replace(/[^a-zA-Z0-9]/g, '') + '-' + String(Date.now()).slice(-4);
  }

  sheet.appendRow([
    idSantri,
    namaLengkap,
    String((data && data.kelas) || '').trim(),
    String((data && data.no_wa_ortu) || '').trim(),
    qrToken,
    String((data && data.status) || 'aktif').trim(),
    now
  ]);
  return { id_santri: idSantri, qr_token: qrToken, created: true };
}

function handleSavePresensi(data) {
  const { sheet } = getSheetAndHeaders('Presensi');
  const rows = getSheetData('Presensi');
  const santriList = getSheetData('Santri');

  const santri = santriList.find(s =>
    s.id_santri === data.id_santri ||
    s.qr_token === data.qr_token ||
    String(s.nama_lengkap).toLowerCase() === String(data.nama_santri || '').toLowerCase()
  );

  if (!santri) throw new Error('Data santri tidak ditemukan di database.');

  const now = new Date();
  const tanggal = data.tanggal || Utilities.formatDate(now, 'Asia/Jakarta', 'yyyy-MM-dd');
  const waktu = data.waktu || Utilities.formatDate(now, 'Asia/Jakarta', 'HH:mm:ss');
  const newId = 'PRS-' + String(rows.length + 1).padStart(4, '0');

  sheet.appendRow([
    newId,
    tanggal,
    waktu,
    santri.id_santri,
    santri.nama_lengkap,
    santri.kelas,
    data.status || 'Hadir',
    data.id_guru_piket || '',
    data.nama_guru_piket || '',
    data.metode || 'Manual',
    data.catatan || ''
  ]);

  return { id_presensi: newId, santri: santri.nama_lengkap, status: data.status || 'Hadir' };
}

function handleGetRekapLaporan(bulan, tahun) {
  const santriList = getSheetData('Santri');
  const presensi = getSheetData('Presensi');
  const targetBulan = bulan ? String(bulan).padStart(2, '0') : null;
  const targetTahun = tahun ? String(tahun) : null;

  const filteredPresensi = presensi.filter(p => {
    const tglStr = formatDateOnlyWIB(p.tanggal);
    const parts = tglStr.split('-');
    if (targetTahun && parts[0] !== targetTahun) return false;
    if (targetBulan && parts[1] !== targetBulan) return false;
    return true;
  });

  return santriList.map(s => {
    const logs = filteredPresensi.filter(p => p.id_santri === s.id_santri);
    const count = { Hadir: 0, Sakit: 0, Izin: 0, Alpa: 0 };
    logs.forEach(l => {
      if (Object.prototype.hasOwnProperty.call(count, l.status)) count[l.status]++;
    });
    const total = count.Hadir + count.Sakit + count.Izin + count.Alpa;
    const persentase = total > 0 ? Math.round((count.Hadir / total) * 100) : 0;

    return {
      id_santri: s.id_santri,
      nama_lengkap: s.nama_lengkap,
      kelas: s.kelas,
      hadir: count.Hadir,
      sakit: count.Sakit,
      izin: count.Izin,
      alpa: count.Alpa,
      total: total,
      persentase: persentase
    };
  });
}

function handleSaveNilaiUAS(data) {
  const { sheet } = getSheetAndHeaders('Nilai_UAS');
  const rows = getSheetData('Nilai_UAS');
  const now = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  const newId = 'UAS-' + String(rows.length + 1).padStart(3, '0');

  sheet.appendRow([
    newId,
    data.id_santri || '',
    data.nama_santri,
    data.kelas || '',
    data.periode || 'Ganjil 2026/2027',
    data.skema_soal,
    Number(data.pg_benar || 0),
    Number(data.essay_benar || 0),
    Number(data.setengah_benar || 0),
    Number(data.nilai_uas || 0),
    data.id_guru || '',
    now
  ]);
  return { id_uas: newId };
}

function handleSaveNilaiRaport(items) {
  const { sheet } = getSheetAndHeaders('Nilai_Raport');
  const rows = getSheetData('Nilai_Raport');
  const list = Array.isArray(items) ? items : [items];
  const now = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  const usedIds = new Set(rows.map(r => String(r.id_raport || '').trim()).filter(Boolean));

  list.forEach(item => {
    const incomingId = String((item && item.id_raport) || '').trim();
    const existing = incomingId ? rows.find(r => String(r.id_raport || '').trim() === incomingId) : null;
    let newId = existing ? existing.id_raport : '';
    if (!newId) {
      if (incomingId && !usedIds.has(incomingId)) {
        usedIds.add(incomingId);
        newId = incomingId;
      } else {
        newId = generateUniqueSequentialId(rows, 'id_raport', 'RPT-', 3, usedIds);
      }
    }

    const nHarian = parseNumSafe(item.n_harian, 0);
    const nUas = parseNumSafe(item.n_uas, 0);
    const nKehadiran = parseNumSafe(item.n_kehadiran, 0);
    const bHarian = parseNumSafe(item.bobot_harian, 40);
    const bUas = parseNumSafe(item.bobot_uas, 40);
    const bKehadiran = parseNumSafe(item.bobot_kehadiran, 20);
    const totalBobot = (bHarian + bUas + bKehadiran) || 100;
    const nAkhir = Math.round(((nHarian * bHarian + nUas * bUas + nKehadiran * bKehadiran) / totalBobot) * 100) / 100;
    const pred = computeRaportGrade(nAkhir);

    const rowValues = [
      newId,
      item.id_santri || '',
      item.nama_santri,
      item.kelas || '',
      item.periode || 'Ganjil 2026/2027',
      nHarian,
      nUas,
      nKehadiran,
      bHarian,
      bUas,
      bKehadiran,
      nAkhir,
      pred.grade,
      pred.keterangan,
      now
    ];

    if (existing) {
      sheet.getRange(existing._rowIndex, 1, 1, rowValues.length).setValues([rowValues]);
    } else {
      sheet.appendRow(rowValues);
    }
  });

  return { savedCount: list.length };
}

function handleDeleteById(sheetName, idColumn, idValue) {
  const { sheet } = getSheetAndHeaders(sheetName);
  const rows = getSheetData(sheetName);
  const target = String(idValue || '').trim();
  if (!target) throw new Error('ID data tidak valid.');

  let found = rows.find(r => String(r[idColumn] || '').trim() === target);
  if (!found && sheetName === 'Users') {
    found = rows.find(r => String(r.id_user || '').trim() === '' && String(r.username || '').trim() === target);
  }
  if (!found) throw new Error('Data tidak ditemukan.');
  sheet.deleteRow(found._rowIndex);
  return { deletedId: target };
}

function handleUploadDokumenDrive(data) {
  const { filename, mimeType, base64Content, kategori, judul, diunggah_oleh } = data;
  if (!base64Content || !filename) throw new Error('File tidak lengkap.');

  let targetFolderId = CONFIG.FOLDER_ARSIP_ID;
  if (kategori === 'Impor AI') targetFolderId = CONFIG.FOLDER_UPLOAD_AI_ID;
  if (kategori === 'Laporan PDF') targetFolderId = CONFIG.FOLDER_LAPORAN_PDF_ID;

  const decoded = Utilities.base64Decode(base64Content);
  const blob = Utilities.newBlob(decoded, mimeType || 'application/pdf', filename);
  const file = DriveApp.getFolderById(targetFolderId).createFile(blob);

  const { sheet } = getSheetAndHeaders('Dokumen_Arsip');
  const rows = getSheetData('Dokumen_Arsip');
  const newId = 'DOK-' + String(rows.length + 1).padStart(3, '0');
  const now = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');

  sheet.appendRow([
    newId,
    judul || filename,
    kategori || 'Arsip Resmi',
    file.getId(),
    file.getUrl(),
    diunggah_oleh || 'System',
    now
  ]);

  return {
    id_dokumen: newId,
    drive_id: file.getId(),
    drive_url: file.getUrl()
  };
}

/**
 * Proxy Aman untuk Asisten Impor Nilai AI (Gemini 2.5 Flash)
 */
function handleImportNilaiAI(data) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY belum diatur pada Script Properties Apps Script.');
  }

  let uploadedFileInfo = null;
  if (data.base64Content && data.filename) {
    uploadedFileInfo = handleUploadDokumenDrive({
      filename: data.filename,
      mimeType: data.mimeType,
      base64Content: data.base64Content,
      kategori: 'Impor AI',
      judul: 'Sumber Impor Nilai AI - ' + data.filename,
      diunggah_oleh: data.diunggah_oleh || 'Guru'
    });
  }

  const prompt = 'Ekstrak daftar nilai santri dari input berikut menjadi array JSON dengan properti tepat: nama_lengkap (string), n_harian (number 0-100), n_uas (number 0-100), n_kehadiran (number 0-100). Jika nilai tidak tersedia isi 0.\n\nTeks mentah:\n' + (data.rawText || '');

  const parts = [{ text: prompt }];
  if (data.base64Content && data.mimeType) {
    parts.push({
      inline_data: {
        mime_type: data.mimeType,
        data: data.base64Content
      }
    });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      contents: [{ parts: parts }],
      generationConfig: { responseMimeType: 'application/json' }
    }),
    muteHttpExceptions: true
  });

  const resJson = JSON.parse(response.getContentText());
  if (resJson.error) throw new Error('Gemini API Error: ' + resJson.error.message);

  const rawOutput = resJson.candidates[0].content.parts[0].text;
  return {
    extracted: JSON.parse(rawOutput),
    archive_record: uploadedFileInfo
  };
}

/* ============================================================================
 * REKAPAN & PELAPORAN GURU KE KEPALA MADRASAH (Log_Setoran)
 * ============================================================================ */

function handleSubmitLaporanGuru(data) {
  if (!data || !data.jenis_laporan) {
    throw new Error('Jenis laporan (Absensi Harian atau Nilai Raport) wajib diisi.');
  }

  const sheet = ensureLogSetoranSheet();
  const rows = getSheetData('Log_Setoran');
  const now = new Date();
  const tanggal = formatDateOnlyWIB(data.tanggal) || Utilities.formatDate(now, 'Asia/Jakarta', 'yyyy-MM-dd');
  const waktuSubmit = data.waktu_submit || Utilities.formatDate(now, 'Asia/Jakarta', 'yyyy-MM-dd HH:mm:ss');
  const newId = 'STR-' + String(rows.length + 1).padStart(4, '0');
  const ringkasanStr = typeof data.ringkasan === 'string'
    ? data.ringkasan
    : JSON.stringify(data.ringkasan || {});

  const record = [
    newId,
    tanggal,
    String(data.jenis_laporan).trim(),
    String(data.kelas || 'Semua Kelas').trim(),
    String(data.periode || '').trim(),
    String(data.id_guru || '').trim(),
    String(data.nama_guru || 'Guru Piket').trim(),
    ringkasanStr,
    waktuSubmit
  ];

  sheet.appendRow(record);

  return {
    id_setoran: newId,
    tanggal: tanggal,
    jenis_laporan: record[2],
    kelas: record[3],
    periode: record[4],
    id_guru: record[5],
    nama_guru: record[6],
    ringkasan: ringkasanStr,
    waktu_submit: waktuSubmit
  };
}

function handleGetLogSetoran(params) {
  ensureLogSetoranSheet();
  const rows = getSheetData('Log_Setoran');
  const filterTanggal = params && params.tanggal ? formatDateOnlyWIB(params.tanggal) : '';
  const filterJenis = params && params.jenis_laporan ? String(params.jenis_laporan).trim().toLowerCase() : '';
  const filterGuru = params && params.id_guru ? String(params.id_guru).trim() : '';
  const filterKelas = params && params.kelas ? String(params.kelas).trim() : '';

  return rows
    .map(r => ({
      id_setoran: String(r.id_setoran || ''),
      tanggal: formatDateOnlyWIB(r.tanggal),
      jenis_laporan: String(r.jenis_laporan || ''),
      kelas: String(r.kelas || ''),
      periode: String(r.periode || ''),
      id_guru: String(r.id_guru || ''),
      nama_guru: String(r.nama_guru || ''),
      ringkasan: String(r.ringkasan || ''),
      waktu_submit: String(r.waktu_submit || '')
    }))
    .filter(r => {
      if (filterTanggal && r.tanggal !== filterTanggal) return false;
      if (filterJenis && r.jenis_laporan.toLowerCase() !== filterJenis) return false;
      if (filterGuru && r.id_guru !== filterGuru) return false;
      if (filterKelas && r.kelas !== filterKelas) return false;
      return true;
    })
    .reverse();
}

function handleGetRekapKepsek(tanggalParam, kelasParam) {
  ensureLogSetoranSheet();
  const now = new Date();
  const targetTanggal = formatDateOnlyWIB(tanggalParam) || Utilities.formatDate(now, 'Asia/Jakarta', 'yyyy-MM-dd');
  const targetKelas = String(kelasParam || '').trim();
  const isAllClasses = !targetKelas || targetKelas.toLowerCase() === 'semua kelas';

  const santriList = getSheetData('Santri');
  const presensiList = getSheetData('Presensi');
  const raportList = getSheetData('Nilai_Raport');
  const logList = getSheetData('Log_Setoran').map(r => ({
    id_setoran: String(r.id_setoran || ''),
    tanggal: formatDateOnlyWIB(r.tanggal),
    jenis_laporan: String(r.jenis_laporan || ''),
    kelas: String(r.kelas || 'Semua Kelas'),
    periode: String(r.periode || ''),
    id_guru: String(r.id_guru || ''),
    nama_guru: String(r.nama_guru || ''),
    ringkasan: String(r.ringkasan || ''),
    waktu_submit: String(r.waktu_submit || '')
  }));

  const santriById = {};
  const santriByName = {};
  const kelasCountMap = {};

  santriList.forEach(s => {
    const id = String(s.id_santri || '').trim();
    const nama = String(s.nama_lengkap || '').trim();
    const k = String(s.kelas || '').trim();
    if (id) santriById[id] = s;
    if (nama) santriByName[nama.toLowerCase()] = s;
    if (k && String(s.status || 'aktif').toLowerCase() === 'aktif') {
      kelasCountMap[k] = (kelasCountMap[k] || 0) + 1;
    }
  });

  const daftarKelas = Object.keys(kelasCountMap).sort();

  // 1. Setoran Absensi Harian pada tanggal terpilih
  const setoranAbsensiHariIni = logList
    .filter(l => l.jenis_laporan.toLowerCase() === 'absensi harian' && l.tanggal === targetTanggal)
    .reverse();

  const setoranSemuaKelas = setoranAbsensiHariIni.find(
    l => !l.kelas || l.kelas.toLowerCase() === 'semua kelas'
  );

  const statusSetoranHariIni = daftarKelas
    .filter(k => isAllClasses || k === targetKelas)
    .map(k => {
      const exact = setoranAbsensiHariIni.find(l => l.kelas === k);
      const matched = exact || setoranSemuaKelas || null;
      return {
        kelas: k,
        jumlah_santri: kelasCountMap[k] || 0,
        sudah_setor: Boolean(matched),
        id_setoran: matched ? matched.id_setoran : '',
        nama_guru: matched ? matched.nama_guru : '',
        waktu_submit: matched ? matched.waktu_submit : '',
        ringkasan: matched ? matched.ringkasan : ''
      };
    });

  // 2. Agregat & daftar santri tidak hadir pada tanggal terpilih
  const presensiFiltered = presensiList.filter(p => {
    const tgl = formatDateOnlyWIB(p.tanggal);
    if (tgl !== targetTanggal) return false;
    if (!isAllClasses && String(p.kelas || '').trim() !== targetKelas) return false;
    return true;
  });

  const agregat = { Hadir: 0, Sakit: 0, Izin: 0, Alpa: 0, total: presensiFiltered.length };
  const santriTidakHadir = [];
  const riwayatTanggal = [];

  presensiFiltered.forEach(p => {
    const st = String(p.status || 'Hadir');
    if (Object.prototype.hasOwnProperty.call(agregat, st)) {
      agregat[st]++;
    }
    const santriRef = santriById[String(p.id_santri || '').trim()] ||
      santriByName[String(p.nama_santri || '').trim().toLowerCase()] || null;
    const item = {
      id_presensi: String(p.id_presensi || ''),
      tanggal: formatDateOnlyWIB(p.tanggal),
      waktu: formatTimeOnlyWIB(p.waktu),
      id_santri: String(p.id_santri || ''),
      nama_santri: String(p.nama_santri || '-'),
      kelas: String(p.kelas || '-'),
      status: st,
      metode: String(p.metode || 'Manual'),
      nama_guru_piket: String(p.nama_guru_piket || '-'),
      catatan: String(p.catatan || ''),
      no_wa_ortu: santriRef ? String(santriRef.no_wa_ortu || '') : ''
    };
    riwayatTanggal.push(item);
    if (st === 'Sakit' || st === 'Izin' || st === 'Alpa') {
      santriTidakHadir.push(item);
    }
  });

  const setoranAbsensiFiltered = setoranAbsensiHariIni.filter(l =>
    isAllClasses || !l.kelas || l.kelas.toLowerCase() === 'semua kelas' || l.kelas === targetKelas
  );

  // 3. Rekap Nilai Disetor Guru (gabungan Nilai_Raport & Log_Setoran Nilai Raport)
  const nilaiGroups = {};
  raportList.forEach(r => {
    const k = String(r.kelas || 'Tanpa Kelas').trim();
    const per = String(r.periode || 'Ganjil 2026/2027').trim();
    if (!isAllClasses && k !== targetKelas) return;
    const key = k + '||' + per;
    if (!nilaiGroups[key]) {
      nilaiGroups[key] = { kelas: k, periode: per, rows: [] };
    }
    const resolved = resolveRaportRowValues(r);

    nilaiGroups[key].rows.push({
      id_raport: String(r.id_raport || ''),
      id_santri: String(r.id_santri || ''),
      nama_santri: String(r.nama_santri || '-'),
      kelas: k,
      periode: per,
      n_harian: resolved.n_harian,
      n_uas: resolved.n_uas,
      n_kehadiran: resolved.n_kehadiran,
      bobot_harian: resolved.bobot_harian,
      bobot_uas: resolved.bobot_uas,
      bobot_kehadiran: resolved.bobot_kehadiran,
      n_akhir: resolved.n_akhir,
      grade: resolved.grade,
      keterangan: resolved.keterangan,
      updated_at: formatDateOnlyWIB(r.updated_at)
    });
  });

  const setoranNilaiList = logList
    .filter(l => l.jenis_laporan.toLowerCase() === 'nilai raport')
    .reverse();

  // Pastikan grup yang baru disetor melalui Log_Setoran tetap tampil walau filter kelas berbeda/kosong
  setoranNilaiList.forEach(s => {
    const k = s.kelas || 'Semua Kelas';
    const per = s.periode || 'Ganjil 2026/2027';
    if (!isAllClasses && k.toLowerCase() !== 'semua kelas' && k !== targetKelas) return;
    if (k.toLowerCase() === 'semua kelas') return;
    const key = k + '||' + per;
    if (!nilaiGroups[key]) {
      nilaiGroups[key] = { kelas: k, periode: per, rows: [] };
    }
  });

  const rekapNilai = Object.keys(nilaiGroups).map(key => {
    const g = nilaiGroups[key];
    const matchedLog = setoranNilaiList.find(s =>
      (s.kelas === g.kelas || !s.kelas || s.kelas.toLowerCase() === 'semua kelas') &&
      (!s.periode || s.periode === g.periode)
    );
    const jumlahSantri = g.rows.length;
    const totalNilai = g.rows.reduce((sum, item) => sum + item.n_akhir, 0);
    const rataRata = jumlahSantri > 0 ? Math.round((totalNilai / jumlahSantri) * 100) / 100 : 0;
    const jumlahTuntas = g.rows.filter(item => ['A', 'B', 'C'].includes(item.grade.toUpperCase())).length;
    const jumlahPerluBimbingan = jumlahSantri - jumlahTuntas;

    return {
      id_setoran: matchedLog ? matchedLog.id_setoran : '',
      kelas: g.kelas,
      periode: g.periode,
      status_setoran: matchedLog ? 'Sudah Disetor' : 'Draft',
      id_guru: matchedLog ? matchedLog.id_guru : '',
      nama_guru: matchedLog ? matchedLog.nama_guru : 'Belum Disetor Guru',
      tanggal_setor: matchedLog ? matchedLog.tanggal : (g.rows[0] ? g.rows[0].updated_at : '-'),
      waktu_submit: matchedLog ? matchedLog.waktu_submit : '',
      ringkasan: matchedLog ? matchedLog.ringkasan : '',
      jumlah_santri: jumlahSantri,
      rata_rata: rataRata,
      jumlah_tuntas: jumlahTuntas,
      jumlah_perlu_bimbingan: jumlahPerluBimbingan,
      detail_nilai: g.rows
    };
  });

  return {
    tanggal: targetTanggal,
    kelas_filter: targetKelas,
    daftar_kelas: daftarKelas,
    status_setoran_hari_ini: statusSetoranHariIni,
    absensi_harian: {
      tanggal: targetTanggal,
      agregat: agregat,
      setoran: setoranAbsensiFiltered,
      santri_tidak_hadir: santriTidakHadir,
      riwayat: riwayatTanggal.slice().reverse()
    },
    rekap_nilai: rekapNilai
  };
}
