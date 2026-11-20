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

const KELAS_HEADERS = [
  'id_kelas',
  'nama_kelas',
  'tingkat',
  'keterangan',
  'status',
  'created_at'
];

const SANTRI_EXTRA_COLUMNS = [
  'nis',
  'nik',
  'tempat_lahir',
  'tanggal_lahir'
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

const CACHE_TTL_SECONDS = 120;
const CACHE_VERSION_KEY = 'mdta_cache_ver';
const STATIC_CACHE_KEYS = [
  'mdta_getDashboard',
  'mdta_getSantri',
  'mdta_getUsers',
  'mdta_getDokumenArsip',
  'mdta_getNilaiRaport',
  'mdta_getLogSetoran_all',
  'mdta_getKelas'
];

let _requestSpreadsheet = null;
let _requestSheetData = {};
let _requestEnsured = {};

function resetRequestContext() {
  _requestSpreadsheet = null;
  _requestSheetData = {};
  _requestEnsured = {};
}

function getSpreadsheet() {
  if (!_requestSpreadsheet) {
    _requestSpreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  }
  return _requestSpreadsheet;
}

function getScriptCacheSafe() {
  try {
    if (typeof CacheService !== 'undefined' && CacheService && typeof CacheService.getScriptCache === 'function') {
      return CacheService.getScriptCache();
    }
  } catch (err) {
    // Abaikan jika CacheService tidak tersedia
  }
  return null;
}

function getCacheVersion() {
  const cache = getScriptCacheSafe();
  if (!cache) return '1';
  try {
    return cache.get(CACHE_VERSION_KEY) || '1';
  } catch (err) {
    return '1';
  }
}

function cacheGetJson(key) {
  const cache = getScriptCacheSafe();
  if (!cache) return null;
  try {
    const raw = cache.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function cachePutJson(key, data, ttlSeconds) {
  const cache = getScriptCacheSafe();
  if (!cache) return;
  try {
    const str = JSON.stringify(data);
    if (str.length < 95000) {
      cache.put(key, str, ttlSeconds || CACHE_TTL_SECONDS);
    }
  } catch (err) {
    // Abaikan error ukuran atau kuota cache
  }
}

function cachedRead(cacheKey, loaderFn) {
  const cached = cacheGetJson(cacheKey);
  if (cached !== null) return cached;
  const fresh = loaderFn();
  cachePutJson(cacheKey, fresh, CACHE_TTL_SECONDS);
  return fresh;
}

function invalidateScriptCache() {
  _requestSheetData = {};
  const cache = getScriptCacheSafe();
  if (!cache) return;
  try {
    if (typeof cache.removeAll === 'function') {
      cache.removeAll(STATIC_CACHE_KEYS);
    } else if (typeof cache.remove === 'function') {
      STATIC_CACHE_KEYS.forEach(k => cache.remove(k));
    }
    const nextVer = String(Date.now()) + '_' + String(Math.floor(Math.random() * 1000));
    cache.put(CACHE_VERSION_KEY, nextVer, 21600);
  } catch (err) {
    // Abaikan jika gagal menghapus cache
  }
}

/**
 * Helper Auto-Schema: memastikan kolom tertentu ada di baris header suatu sheet
 */
function ensureColumn(sheet, columnName) {
  const targetName = String(columnName || '').trim();
  if (!sheet || !targetName) return -1;

  const sheetName = typeof sheet.getName === 'function' ? sheet.getName() : '';
  if (sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) {
    sheet.appendRow([targetName]);
    sheet.getRange(1, 1, 1, 1).setFontWeight('bold');
    if (sheetName) delete _requestSheetData[sheetName];
    return 1;
  }

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || '').trim());
  const existingIdx = headers.findIndex(h => h.toLowerCase() === targetName.toLowerCase());
  if (existingIdx >= 0) {
    return existingIdx + 1;
  }

  const newCol = headers.length + 1;
  if (typeof sheet.getMaxColumns === 'function' && typeof sheet.insertColumnAfter === 'function' && newCol > sheet.getMaxColumns()) {
    sheet.insertColumnAfter(sheet.getMaxColumns());
  }
  sheet.getRange(1, newCol).setValue(targetName).setFontWeight('bold');
  if (sheetName) delete _requestSheetData[sheetName];
  return newCol;
}

/**
 * Helper Auto-Schema: memastikan sheet beserta kolom header-nya ada
 */
function ensureSheet(sheetName, headers) {
  const ss = getSpreadsheet();
  const hdrs = Array.isArray(headers) ? headers.slice() : [];
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    if (hdrs.length > 0) {
      sheet.appendRow(hdrs);
      sheet.getRange(1, 1, 1, hdrs.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
    delete _requestSheetData[sheetName];
    return sheet;
  }

  if (sheet.getLastRow() === 0 && hdrs.length > 0) {
    sheet.appendRow(hdrs);
    sheet.getRange(1, 1, 1, hdrs.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    delete _requestSheetData[sheetName];
    return sheet;
  }

  hdrs.forEach(h => ensureColumn(sheet, h));
  return sheet;
}

function normalizeKelasName(val) {
  return String(val || '').trim().toLowerCase();
}

function parseKelasAmpu(raw) {
  const list = Array.isArray(raw)
    ? raw
    : String(raw || '').split(/[;,]/);
  const seen = new Set();
  const out = [];
  list.forEach(item => {
    const clean = String(item || '').trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(clean);
    }
  });
  return out;
}

function formatKelasAmpu(raw) {
  return parseKelasAmpu(raw).join(', ');
}

function isKelasAllowed(kelasVal, allowedList) {
  const target = normalizeKelasName(kelasVal);
  if (!target || !Array.isArray(allowedList) || allowedList.length === 0) return false;
  return allowedList.some(k => normalizeKelasName(k) === target);
}

/**
 * Memastikan sheet Users memiliki kolom kelas_ampu
 */
function ensureUsersSchema() {
  if (_requestEnsured.users) return _requestEnsured.users;
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName('Users');
  if (sheet) {
    ensureColumn(sheet, 'kelas_ampu');
  }
  _requestEnsured.users = sheet || true;
  return sheet;
}

/**
 * Memastikan sheet Santri memiliki kolom nis, nik, tempat_lahir, dan tanggal_lahir
 */
function ensureSantriSchema() {
  if (_requestEnsured.santri) return _requestEnsured.santri;
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName('Santri');
  if (sheet) {
    SANTRI_EXTRA_COLUMNS.forEach(col => ensureColumn(sheet, col));
  }
  _requestEnsured.santri = sheet || true;
  return sheet;
}

/**
 * Memastikan sheet Kelas tersedia dan melakukan sinkronisasi awal dari Santri/Users jika baru dibuat
 */
function ensureKelasSheet() {
  if (_requestEnsured.kelas) return _requestEnsured.kelas;
  const ss = getSpreadsheet();
  const existing = ss.getSheetByName('Kelas');
  const hadData = Boolean(existing && existing.getLastRow() > 1);
  const sheet = ensureSheet('Kelas', KELAS_HEADERS);

  if (!hadData) {
    const uniqueMap = {};
    const santriSheet = ss.getSheetByName('Santri');
    if (santriSheet) {
      getSheetData('Santri').forEach(s => {
        const clean = String(s.kelas || '').trim();
        if (clean && !uniqueMap[clean.toLowerCase()]) {
          uniqueMap[clean.toLowerCase()] = clean;
        }
      });
    }
    const usersSheet = ss.getSheetByName('Users');
    if (usersSheet) {
      getSheetData('Users').forEach(u => {
        parseKelasAmpu(u.kelas_ampu).forEach(k => {
          if (k && !uniqueMap[k.toLowerCase()]) {
            uniqueMap[k.toLowerCase()] = k;
          }
        });
      });
    }

    const now = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
    const sortedNames = Object.keys(uniqueMap).map(k => uniqueMap[k]).sort();
    sortedNames.forEach((namaKelas, idx) => {
      const idKls = 'KLS-' + String(idx + 1).padStart(3, '0');
      sheet.appendRow([idKls, namaKelas, '', 'Sinkron otomatis dari data santri', 'aktif', now]);
    });
    delete _requestSheetData['Kelas'];
  }

  _requestEnsured.kelas = sheet;
  return sheet;
}

/**
 * Memastikan sheet Log_Setoran tersedia beserta header kolomnya
 */
function ensureLogSetoranSheet() {
  if (_requestEnsured.logSetoran) return _requestEnsured.logSetoran;
  const sheet = ensureSheet('Log_Setoran', LOG_SETORAN_HEADERS);
  _requestEnsured.logSetoran = sheet;
  return sheet;
}

function resolveGuruScope(ctx) {
  const c = ctx || {};
  const role = String(c.role || '').trim().toLowerCase();
  const idUser = String(c.id_user || c.id_guru || c.id_guru_piket || '').trim();
  const username = String(c.username || '').trim();

  if (!idUser && !username && role !== 'guru') {
    return { isGuru: false, user: null, id_user: '', username: '', kelas_ampu: [] };
  }

  const users = cachedRead('mdta_getUsers', () => handleGetUsers());
  let found = null;
  if (idUser) {
    found = users.find(u => String(u.id_user || '').trim() === idUser);
  }
  if (!found && username) {
    found = users.find(u => String(u.username || '').trim().toLowerCase() === username.toLowerCase());
  }

  if (found) {
    const foundRole = String(found.role || '').trim().toLowerCase();
    if (foundRole === 'admin') {
      return {
        isGuru: false,
        user: found,
        id_user: String(found.id_user || ''),
        username: String(found.username || ''),
        kelas_ampu: []
      };
    }
    return {
      isGuru: true,
      user: found,
      id_user: String(found.id_user || ''),
      username: String(found.username || ''),
      kelas_ampu: parseKelasAmpu(found.kelas_ampu)
    };
  }

  if (role === 'guru') {
    return {
      isGuru: true,
      user: null,
      id_user: idUser,
      username: username,
      kelas_ampu: parseKelasAmpu(c.kelas_ampu)
    };
  }

  return { isGuru: false, user: null, id_user: '', username: '', kelas_ampu: [] };
}

function filterRowsByGuruScope(rows, scope, kelasField) {
  const list = Array.isArray(rows) ? rows : [];
  if (!scope || !scope.isGuru) return list;
  if (!Array.isArray(scope.kelas_ampu) || scope.kelas_ampu.length === 0) return [];
  const field = kelasField || 'kelas';
  return list.filter(item => isKelasAllowed(item && item[field], scope.kelas_ampu));
}

function attachScopeContext(dataObj, rootPayload) {
  if (!dataObj || typeof dataObj !== 'object' || Array.isArray(dataObj)) return dataObj;
  const p = rootPayload || {};
  const merged = Object.assign({}, dataObj);
  if (!merged.role && p.role) merged.role = p.role;
  if (!merged.id_user && p.id_user) merged.id_user = p.id_user;
  if (!merged.username && p.username) merged.username = p.username;
  return merged;
}

/**
 * Helper untuk membaca seluruh baris sheet menjadi array of objects (dengan memoization per request)
 */
function getSheetData(sheetName, forceFresh) {
  if (!forceFresh && Object.prototype.hasOwnProperty.call(_requestSheetData, sheetName)) {
    return _requestSheetData[sheetName];
  }
  const ss = getSpreadsheet();
  if (sheetName === 'Users') ensureUsersSchema();
  if (sheetName === 'Santri') ensureSantriSchema();
  if (sheetName === 'Kelas') ensureKelasSheet();
  if (sheetName === 'Log_Setoran') ensureLogSetoranSheet();

  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet tidak ditemukan: ' + sheetName);
  const values = sheet.getDataRange().getValues();
  const mapped = values.length <= 1
    ? []
    : (function () {
        const headers = values[0].map(h => String(h).trim());
        return values.slice(1).map((row, idx) => {
          const obj = { _rowIndex: idx + 2 };
          headers.forEach((h, colIdx) => {
            obj[h] = row[colIdx];
          });
          return obj;
        });
      })();
  _requestSheetData[sheetName] = mapped;
  return mapped;
}

/**
 * Helper untuk mendapatkan header dan sheet object
 */
function getSheetAndHeaders(sheetName) {
  const ss = getSpreadsheet();
  if (sheetName === 'Users') ensureUsersSchema();
  if (sheetName === 'Santri') ensureSantriSchema();
  if (sheetName === 'Kelas') ensureKelasSheet();
  if (sheetName === 'Log_Setoran') ensureLogSetoranSheet();

  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet tidak ditemukan: ' + sheetName);
  const lastCol = Math.max(1, sheet.getLastColumn());
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  return { sheet, headers };
}

/**
 * Endpoint GET untuk pembacaan data cepat, pengecekan API, cache 120s, & bootstrap 1-request
 */
function doGet(e) {
  try {
    const params = (e && e.parameter) ? e.parameter : {};
    const action = params.action ? params.action : 'ping';
    const ver = getCacheVersion();
    const scope = resolveGuruScope(params);
    const guruCacheSuffix = scope.isGuru
      ? '_g_' + (scope.id_user || scope.username || 'anon') + '_' + scope.kelas_ampu.join('|')
      : '';

    switch (action) {
      case 'ping':
        return jsonResponse(true, { status: 'online' }, 'API Sistem MDTA aktif.');
      case 'getDashboard':
        return jsonResponse(true, cachedRead('mdta_getDashboard', () => handleGetDashboard()));
      case 'getUsers':
        return jsonResponse(true, cachedRead('mdta_getUsers', () => handleGetUsers()));
      case 'getKelas': {
        const klsCacheKey = scope.isGuru ? ('mdta_kelas_v' + ver + guruCacheSuffix) : 'mdta_getKelas';
        return jsonResponse(true, cachedRead(klsCacheKey, () => handleGetKelas(scope)));
      }
      case 'getSantri': {
        const sCacheKey = scope.isGuru ? ('mdta_santri_v' + ver + guruCacheSuffix) : 'mdta_getSantri';
        return jsonResponse(true, cachedRead(sCacheKey, () => handleGetSantri(scope)));
      }
      case 'getPresensi':
        return jsonResponse(true, filterRowsByGuruScope(getSheetData('Presensi'), scope, 'kelas'));
      case 'getRekapLaporan':
        return jsonResponse(true, handleGetRekapLaporan(params.bulan, params.tahun, scope));
      case 'getNilaiUAS':
        return jsonResponse(true, filterRowsByGuruScope(getSheetData('Nilai_UAS'), scope, 'kelas'));
      case 'getNilaiRaport': {
        const rptCacheKey = scope.isGuru ? ('mdta_nilaiRaport_v' + ver + guruCacheSuffix) : 'mdta_getNilaiRaport';
        return jsonResponse(true, cachedRead(rptCacheKey, () => handleGetNilaiRaport(scope)));
      }
      case 'getDokumenArsip':
        return jsonResponse(true, cachedRead('mdta_getDokumenArsip', () => getSheetData('Dokumen_Arsip')));
      case 'getLogSetoran': {
        const hasFilters = params.tanggal || params.jenis_laporan || params.id_guru || params.kelas;
        const rawLogs = hasFilters
          ? handleGetLogSetoran(params)
          : cachedRead('mdta_getLogSetoran_all', () => handleGetLogSetoran({}));
        const filteredLogs = scope.isGuru
          ? rawLogs.filter(l => isKelasAllowed(l.kelas, scope.kelas_ampu))
          : rawLogs;
        return jsonResponse(true, filteredLogs);
      }
      case 'getRekapKepsek': {
        const tglKey = formatDateOnlyWIB(params.tanggal) || Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
        const klsKey = String(params.kelas || '').trim().toLowerCase();
        const cacheKey = 'mdta_rekapKepsek_v' + ver + '_' + tglKey + '_' + klsKey;
        return jsonResponse(true, cachedRead(cacheKey, () => handleGetRekapKepsek(params.tanggal, params.kelas)));
      }
      case 'getBootstrapData': {
        const roleKey = scope.isGuru ? 'guru' : String(params.role || 'admin').trim().toLowerCase();
        const tglKey = formatDateOnlyWIB(params.tanggal) || Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
        const klsKey = String(params.kelas || '').trim().toLowerCase();
        const cacheKey = 'mdta_bootstrap_v' + ver + '_' + roleKey + '_' + tglKey + '_' + klsKey + guruCacheSuffix;
        return jsonResponse(true, cachedRead(cacheKey, () => handleGetBootstrapData(params, scope)));
      }
      default:
        return jsonResponse(false, null, 'Action GET tidak dikenali: ' + action);
    }
  } catch (err) {
    return jsonResponse(false, null, err.message);
  } finally {
    resetRequestContext();
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
    const rootScope = {
      role: payload.role,
      id_user: payload.id_user || payload.id_guru || payload.id_guru_piket,
      username: payload.username
    };

    switch (action) {
      case 'login':
        return jsonResponse(true, handleLogin(payload));
      case 'saveUser': {
        const res = handleSaveUser(payload.data);
        invalidateScriptCache();
        return jsonResponse(true, res, 'Data pengguna tersimpan.');
      }
      case 'deleteUser': {
        const res = handleDeleteById('Users', 'id_user', payload.id_user);
        invalidateScriptCache();
        return jsonResponse(true, res, 'Pengguna dihapus.');
      }
      case 'saveKelas': {
        const res = handleSaveKelas(payload.data);
        invalidateScriptCache();
        return jsonResponse(true, res, 'Data kelas tersimpan.');
      }
      case 'deleteKelas': {
        const res = handleDeleteKelas(payload);
        invalidateScriptCache();
        return jsonResponse(true, res, 'Kelas berhasil dihapus.');
      }
      case 'saveKelasMapping': {
        const res = handleSaveKelasMapping(payload.data);
        invalidateScriptCache();
        return jsonResponse(true, res, 'Pemetaan guru kelas berhasil disimpan.');
      }
      case 'bulkMoveSantriKelas': {
        const res = handleBulkMoveSantriKelas(payload.data);
        invalidateScriptCache();
        return jsonResponse(true, res, 'Kelas santri berhasil diperbarui.');
      }
      case 'saveSantri': {
        const res = handleSaveSantri(payload.data);
        invalidateScriptCache();
        return jsonResponse(true, res, 'Data santri tersimpan.');
      }
      case 'deleteSantri': {
        const res = handleDeleteById('Santri', 'id_santri', payload.id_santri);
        invalidateScriptCache();
        return jsonResponse(true, res, 'Data santri dihapus.');
      }
      case 'savePresensi': {
        const res = handleSavePresensi(attachScopeContext(payload.data, rootScope));
        invalidateScriptCache();
        return jsonResponse(true, res, 'Presensi berhasil dicatat.');
      }
      case 'saveNilaiUAS': {
        const res = handleSaveNilaiUAS(attachScopeContext(payload.data, rootScope));
        invalidateScriptCache();
        return jsonResponse(true, res, 'Nilai UAS tersimpan.');
      }
      case 'saveNilaiRaport': {
        const res = handleSaveNilaiRaport(payload.data, rootScope);
        invalidateScriptCache();
        return jsonResponse(true, res, 'Nilai raport tersimpan.');
      }
      case 'uploadDokumenDrive': {
        const res = handleUploadDokumenDrive(payload.data);
        invalidateScriptCache();
        return jsonResponse(true, res, 'Dokumen berhasil diunggah ke Drive.');
      }
      case 'importNilaiAI': {
        const res = handleImportNilaiAI(payload.data);
        invalidateScriptCache();
        return jsonResponse(true, res, 'Analisis AI selesai.');
      }
      case 'submitLaporanGuru': {
        const res = handleSubmitLaporanGuru(attachScopeContext(payload.data, rootScope));
        invalidateScriptCache();
        return jsonResponse(true, res, 'Laporan guru berhasil dikirim ke Kepala Madrasah.');
      }
      default:
        return jsonResponse(false, null, 'Action POST tidak dikenali: ' + action);
    }
  } catch (err) {
    return jsonResponse(false, null, err.message);
  } finally {
    resetRequestContext();
    lock.releaseLock();
  }
}

/* ============================================================================
 * HANDLER MODUL
 * ============================================================================ */

function handleLogin(payload) {
  const { username, password } = payload;
  if (!username || !password) throw new Error('Username dan kata sandi wajib diisi.');

  ensureUsersSchema();
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
      role: found.role,
      kelas_ampu: parseKelasAmpu(found.kelas_ampu)
    }
  };
}

function handleGetUsers() {
  ensureUsersSchema();
  return getSheetData('Users').map(u => {
    const kelasAmpu = parseKelasAmpu(u.kelas_ampu);
    return {
      id_user: u.id_user,
      username: u.username,
      nama_lengkap: u.nama_lengkap,
      role: u.role,
      status_aktif: u.status_aktif,
      kelas_ampu: kelasAmpu,
      kelas_ampu_text: kelasAmpu.join(', '),
      created_at: u.created_at
    };
  });
}

function handleGetNilaiRaport(scope) {
  const rows = filterRowsByGuruScope(getSheetData('Nilai_Raport'), scope, 'kelas');
  return rows.map(r => {
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
  ensureUsersSchema();
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

    const nextRole = String((data && data.role) || existing.role || 'guru').trim().toLowerCase();
    const rawKelasAmpu = data && data.kelas_ampu !== undefined ? data.kelas_ampu : existing.kelas_ampu;
    const kelasAmpuStr = nextRole === 'admin' ? '' : formatKelasAmpu(rawKelasAmpu);
    const finalId = String(existing.id_user || '').trim() || generateUniqueSequentialId(rows, 'id_user', 'USR-', 3);

    const updated = headers.map(h => {
      if (h === 'id_user') return finalId;
      if (h === 'username') return username;
      if (h === 'nama_lengkap') return namaLengkap;
      if (h === 'role') return nextRole;
      if (h === 'kelas_ampu') return kelasAmpuStr;
      if (h === 'password') return data.password ? String(data.password) : existing.password;
      if (h === 'created_at') return existing.created_at || now;
      return data[h] !== undefined ? data[h] : existing[h];
    });
    sheet.getRange(existing._rowIndex, 1, 1, headers.length).setValues([updated]);
    delete _requestSheetData['Users'];
    return { id_user: finalId, kelas_ampu: parseKelasAmpu(kelasAmpuStr), updated: true };
  }

  const dupNewUsername = rows.some(
    r => String(r.username || '').trim().toLowerCase() === username.toLowerCase()
  );
  if (dupNewUsername) {
    throw new Error('Username "' + username + '" sudah digunakan oleh akun lain. Gunakan username berbeda.');
  }

  const nextRole = (data && data.role) ? String(data.role).trim().toLowerCase() : 'guru';
  const kelasAmpuStr = nextRole === 'admin' ? '' : formatKelasAmpu(data && data.kelas_ampu);
  const newId = generateUniqueSequentialId(rows, 'id_user', 'USR-', 3);
  const newRowValues = {
    id_user: newId,
    username: username,
    password: (data && data.password) ? String(data.password) : '123456',
    nama_lengkap: namaLengkap,
    role: nextRole,
    status_aktif: (data && data.status_aktif) ? String(data.status_aktif).trim() : 'aktif',
    kelas_ampu: kelasAmpuStr,
    created_at: now
  };
  sheet.appendRow(headers.map(h => newRowValues[h] !== undefined ? newRowValues[h] : ''));
  delete _requestSheetData['Users'];
  return { id_user: newId, kelas_ampu: parseKelasAmpu(kelasAmpuStr), created: true };
}

/* ============================================================================
 * PEMETAAN & PENGELOLAAN KELAS TERPUSAT (Kelas, Users.kelas_ampu, Santri)
 * ============================================================================ */

function handleGetKelas(scope) {
  ensureKelasSheet();
  const list = getSheetData('Kelas')
    .map(k => ({
      id_kelas: String(k.id_kelas || ''),
      nama_kelas: String(k.nama_kelas || '').trim(),
      tingkat: String(k.tingkat || '').trim(),
      keterangan: String(k.keterangan || '').trim(),
      status: String(k.status || 'aktif').trim().toLowerCase(),
      created_at: formatDateOnlyWIB(k.created_at)
    }))
    .filter(k => Boolean(k.nama_kelas));

  const scoped = (scope && scope.isGuru)
    ? list.filter(k => isKelasAllowed(k.nama_kelas, scope.kelas_ampu))
    : list;

  return scoped.sort((a, b) => a.nama_kelas.localeCompare(b.nama_kelas));
}

function handleSaveKelas(data) {
  ensureKelasSheet();
  const { sheet, headers } = getSheetAndHeaders('Kelas');
  const rows = getSheetData('Kelas');
  const now = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  const namaKelas = String((data && data.nama_kelas) || '').trim();
  const tingkat = String((data && data.tingkat) || '').trim();
  const keterangan = String((data && data.keterangan) || '').trim();
  const status = String((data && data.status) || 'aktif').trim().toLowerCase();

  if (!namaKelas) {
    throw new Error('Nama kelas wajib diisi.');
  }

  const isEdit = Boolean(data && data.isEdit === true);
  const targetId = String((data && data.id_kelas) || '').trim();

  if (isEdit) {
    if (!targetId) {
      throw new Error('ID kelas tidak valid untuk mode edit.');
    }
    let existing = rows.find(r => String(r.id_kelas || '').trim() === targetId);
    if (!existing && data && data.original_nama_kelas) {
      const origNorm = normalizeKelasName(data.original_nama_kelas);
      existing = rows.find(r => normalizeKelasName(r.nama_kelas) === origNorm);
    }
    if (!existing) {
      throw new Error('Data kelas yang akan diubah tidak ditemukan.');
    }

    const dup = rows.some(
      r => r._rowIndex !== existing._rowIndex && normalizeKelasName(r.nama_kelas) === normalizeKelasName(namaKelas)
    );
    if (dup) {
      throw new Error('Nama kelas "' + namaKelas + '" sudah terdaftar.');
    }

    const oldName = String(existing.nama_kelas || '').trim();
    const updated = headers.map(h => {
      if (h === 'id_kelas') return existing.id_kelas;
      if (h === 'nama_kelas') return namaKelas;
      if (h === 'tingkat') return tingkat;
      if (h === 'keterangan') return keterangan;
      if (h === 'status') return status;
      if (h === 'created_at') return existing.created_at || now;
      return existing[h] !== undefined ? existing[h] : '';
    });
    sheet.getRange(existing._rowIndex, 1, 1, headers.length).setValues([updated]);
    delete _requestSheetData['Kelas'];

    // Cascade rename ke Santri & Users.kelas_ampu bila nama kelas berubah
    if (oldName && normalizeKelasName(oldName) !== normalizeKelasName(namaKelas)) {
      const santriMeta = getSheetAndHeaders('Santri');
      const santriKelasCol = santriMeta.headers.findIndex(h => h.toLowerCase() === 'kelas') + 1;
      if (santriKelasCol > 0) {
        getSheetData('Santri').forEach(s => {
          if (normalizeKelasName(s.kelas) === normalizeKelasName(oldName)) {
            santriMeta.sheet.getRange(s._rowIndex, santriKelasCol).setValue(namaKelas);
          }
        });
        delete _requestSheetData['Santri'];
      }

      ensureUsersSchema();
      const usersMeta = getSheetAndHeaders('Users');
      const kelasAmpuCol = usersMeta.headers.findIndex(h => h.toLowerCase() === 'kelas_ampu') + 1;
      if (kelasAmpuCol > 0) {
        getSheetData('Users').forEach(u => {
          const list = parseKelasAmpu(u.kelas_ampu);
          let changed = false;
          const replaced = list.map(k => {
            if (normalizeKelasName(k) === normalizeKelasName(oldName)) {
              changed = true;
              return namaKelas;
            }
            return k;
          });
          if (changed) {
            usersMeta.sheet.getRange(u._rowIndex, kelasAmpuCol).setValue(formatKelasAmpu(replaced));
          }
        });
        delete _requestSheetData['Users'];
      }
    }

    return {
      id_kelas: existing.id_kelas,
      nama_kelas: namaKelas,
      renamed_from: normalizeKelasName(oldName) !== normalizeKelasName(namaKelas) ? oldName : '',
      updated: true
    };
  }

  const dupNew = rows.some(r => normalizeKelasName(r.nama_kelas) === normalizeKelasName(namaKelas));
  if (dupNew) {
    throw new Error('Nama kelas "' + namaKelas + '" sudah terdaftar.');
  }

  const newId = generateUniqueSequentialId(rows, 'id_kelas', 'KLS-', 3);
  const newRowValues = {
    id_kelas: newId,
    nama_kelas: namaKelas,
    tingkat: tingkat,
    keterangan: keterangan,
    status: status || 'aktif',
    created_at: now
  };
  sheet.appendRow(headers.map(h => newRowValues[h] !== undefined ? newRowValues[h] : ''));
  delete _requestSheetData['Kelas'];
  return { id_kelas: newId, nama_kelas: namaKelas, created: true };
}

function handleDeleteKelas(payload) {
  ensureKelasSheet();
  const { sheet } = getSheetAndHeaders('Kelas');
  const rows = getSheetData('Kelas');
  const targetId = String((payload && payload.id_kelas) || '').trim();
  const targetName = String((payload && payload.nama_kelas) || '').trim();

  let found = null;
  if (targetId) {
    found = rows.find(r => String(r.id_kelas || '').trim() === targetId);
  }
  if (!found && targetName) {
    found = rows.find(r => normalizeKelasName(r.nama_kelas) === normalizeKelasName(targetName));
  }
  if (!found) {
    throw new Error('Data kelas tidak ditemukan.');
  }

  const namaKelas = String(found.nama_kelas || '').trim();
  const santriInClass = getSheetData('Santri').filter(
    s => normalizeKelasName(s.kelas) === normalizeKelasName(namaKelas)
  );
  if (santriInClass.length > 0) {
    throw new Error(
      'Kelas "' + namaKelas + '" masih memiliki ' + santriInClass.length +
      ' santri. Pindahkan santri ke kelas lain terlebih dahulu sebelum menghapus kelas.'
    );
  }

  sheet.deleteRow(found._rowIndex);
  delete _requestSheetData['Kelas'];

  ensureUsersSchema();
  const usersMeta = getSheetAndHeaders('Users');
  const kelasAmpuCol = usersMeta.headers.findIndex(h => h.toLowerCase() === 'kelas_ampu') + 1;
  if (kelasAmpuCol > 0) {
    getSheetData('Users').forEach(u => {
      const list = parseKelasAmpu(u.kelas_ampu);
      const filtered = list.filter(k => normalizeKelasName(k) !== normalizeKelasName(namaKelas));
      if (filtered.length !== list.length) {
        usersMeta.sheet.getRange(u._rowIndex, kelasAmpuCol).setValue(formatKelasAmpu(filtered));
      }
    });
    delete _requestSheetData['Users'];
  }

  return { deletedId: String(found.id_kelas || targetId), nama_kelas: namaKelas };
}

function handleSaveKelasMapping(data) {
  const namaKelas = String((data && data.nama_kelas) || '').trim();
  if (!namaKelas) throw new Error('Nama kelas untuk pemetaan wajib diisi.');

  ensureUsersSchema();
  const { sheet, headers } = getSheetAndHeaders('Users');
  const colIdx = headers.findIndex(h => h.toLowerCase() === 'kelas_ampu') + 1;
  if (colIdx <= 0) throw new Error('Kolom kelas_ampu tidak ditemukan pada sheet Users.');

  const rows = getSheetData('Users');
  const targetGuruIds = new Set(
    (Array.isArray(data && data.guru_ids) ? data.guru_ids : [])
      .map(id => String(id || '').trim())
      .filter(Boolean)
  );

  let updatedCount = 0;
  rows.forEach(u => {
    const role = String(u.role || '').trim().toLowerCase();
    if (role === 'admin') return;

    const uid = String(u.id_user || '').trim();
    const uname = String(u.username || '').trim();
    const shouldAssign = (uid && targetGuruIds.has(uid)) || (uname && targetGuruIds.has(uname));

    const currentList = parseKelasAmpu(u.kelas_ampu);
    const hasClass = isKelasAllowed(namaKelas, currentList);
    let nextList = currentList;

    if (shouldAssign && !hasClass) {
      nextList = currentList.concat([namaKelas]);
    } else if (!shouldAssign && hasClass) {
      nextList = currentList.filter(k => normalizeKelasName(k) !== normalizeKelasName(namaKelas));
    } else {
      return;
    }

    sheet.getRange(u._rowIndex, colIdx).setValue(formatKelasAmpu(nextList));
    updatedCount++;
  });

  delete _requestSheetData['Users'];
  return { nama_kelas: namaKelas, updatedCount: updatedCount };
}

function handleBulkMoveSantriKelas(data) {
  const ids = Array.isArray(data && data.ids)
    ? data.ids.map(x => String(x || '').trim()).filter(Boolean)
    : [];
  const targetKelas = String((data && (data.target_kelas || data.kelas)) || '').trim();

  if (ids.length === 0) throw new Error('Pilih minimal satu santri untuk dipindahkan.');
  if (!targetKelas) throw new Error('Kelas tujuan wajib dipilih.');

  ensureKelasSheet();
  const officialKelas = getSheetData('Kelas').find(
    k => normalizeKelasName(k.nama_kelas) === normalizeKelasName(targetKelas)
  );
  if (!officialKelas) {
    throw new Error('Kelas tujuan "' + targetKelas + '" belum terdaftar pada daftar kelas resmi.');
  }
  const canonicalKelas = String(officialKelas.nama_kelas || targetKelas).trim();

  const { sheet, headers } = getSheetAndHeaders('Santri');
  const kelasCol = headers.findIndex(h => h.toLowerCase() === 'kelas') + 1;
  if (kelasCol <= 0) throw new Error('Kolom kelas tidak ditemukan pada sheet Santri.');

  const idSet = new Set(ids);
  const rows = getSheetData('Santri');
  let updatedCount = 0;

  rows.forEach(s => {
    const sid = String(s.id_santri || '').trim();
    if (sid && idSet.has(sid)) {
      sheet.getRange(s._rowIndex, kelasCol).setValue(canonicalKelas);
      updatedCount++;
    }
  });

  delete _requestSheetData['Santri'];
  return { updatedCount: updatedCount, target_kelas: canonicalKelas };
}

function formatSantriTextCols(sheet, headers, rowIndex, valuesByHeader) {
  if (!sheet || !Array.isArray(headers) || !rowIndex || rowIndex < 2) return;
  ['nis', 'nik', 'no_wa_ortu', 'tanggal_lahir'].forEach(colName => {
    const colIdx = headers.findIndex(h => h.toLowerCase() === colName) + 1;
    if (colIdx <= 0) return;
    const cell = sheet.getRange(rowIndex, colIdx, 1, 1);
    if (typeof cell.setNumberFormat === 'function') {
      cell.setNumberFormat('@');
    }
    if (valuesByHeader && valuesByHeader[colName] !== undefined) {
      cell.setValue(valuesByHeader[colName]);
    }
  });
}

function handleGetSantri(scope) {
  ensureSantriSchema();
  const rows = filterRowsByGuruScope(getSheetData('Santri'), scope, 'kelas');
  return rows.map(s => ({
    id_santri: String(s.id_santri || '').trim(),
    nama_lengkap: String(s.nama_lengkap || ''),
    nis: String(s.nis || '').trim(),
    nik: String(s.nik || '').trim(),
    tempat_lahir: String(s.tempat_lahir || '').trim(),
    tanggal_lahir: formatDateOnlyWIB(s.tanggal_lahir),
    kelas: String(s.kelas || '').trim(),
    no_wa_ortu: String(s.no_wa_ortu || '').trim(),
    qr_token: String(s.qr_token || '').trim(),
    status: String(s.status || 'aktif').trim(),
    created_at: formatDateOnlyWIB(s.created_at)
  }));
}

function handleSaveSantri(data) {
  const { sheet, headers } = getSheetAndHeaders('Santri');
  const rows = getSheetData('Santri');
  const now = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  const namaLengkap = String((data && data.nama_lengkap) || '').trim();

  if (!namaLengkap) {
    throw new Error('Nama lengkap santri wajib diisi.');
  }

  const nisVal = data && data.nis !== undefined ? String(data.nis || '').trim() : undefined;
  const nikVal = data && data.nik !== undefined ? String(data.nik || '').replace(/\s+/g, '').trim() : undefined;
  const tempatLahirVal = data && data.tempat_lahir !== undefined ? String(data.tempat_lahir || '').trim() : undefined;
  const tanggalLahirVal = data && data.tanggal_lahir !== undefined ? formatDateOnlyWIB(data.tanggal_lahir) : undefined;

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

    const finalNis = nisVal !== undefined ? nisVal : String(existing.nis || '').trim();
    const finalNik = nikVal !== undefined ? nikVal : String(existing.nik || '').replace(/\s+/g, '').trim();
    const finalTempatLahir = tempatLahirVal !== undefined ? tempatLahirVal : String(existing.tempat_lahir || '').trim();
    const finalTanggalLahir = tanggalLahirVal !== undefined ? tanggalLahirVal : formatDateOnlyWIB(existing.tanggal_lahir);

    const updated = headers.map(h => {
      if (h === 'id_santri') return existing.id_santri;
      if (h === 'nama_lengkap') return namaLengkap;
      if (h === 'nis') return finalNis;
      if (h === 'nik') return finalNik;
      if (h === 'tempat_lahir') return finalTempatLahir;
      if (h === 'tanggal_lahir') return finalTanggalLahir;
      if (h === 'qr_token') return finalQrToken;
      if (h === 'created_at') return existing.created_at || now;
      return data[h] !== undefined ? data[h] : existing[h];
    });
    formatSantriTextCols(sheet, headers, existing._rowIndex, null);
    sheet.getRange(existing._rowIndex, 1, 1, headers.length).setValues([updated]);
    delete _requestSheetData['Santri'];
    return {
      id_santri: existing.id_santri,
      nis: finalNis,
      nik: finalNik,
      tempat_lahir: finalTempatLahir,
      tanggal_lahir: finalTanggalLahir,
      qr_token: finalQrToken,
      updated: true
    };
  }

  const idSantri = generateUniqueSequentialId(rows, 'id_santri', 'S-', 3);
  const existingQr = new Set(rows.map(r => String(r.qr_token || '').trim()).filter(Boolean));
  let qrToken = String((data && data.qr_token) || '').trim() ||
    ('QR-MDTA-' + idSantri.replace(/[^a-zA-Z0-9]/g, ''));
  if (existingQr.has(qrToken)) {
    qrToken = 'QR-MDTA-' + idSantri.replace(/[^a-zA-Z0-9]/g, '') + '-' + String(Date.now()).slice(-4);
  }

  const newRowValues = {
    id_santri: idSantri,
    nama_lengkap: namaLengkap,
    kelas: String((data && data.kelas) || '').trim(),
    no_wa_ortu: String((data && data.no_wa_ortu) || '').trim(),
    qr_token: qrToken,
    status: String((data && data.status) || 'aktif').trim(),
    created_at: now,
    nis: nisVal || '',
    nik: nikVal || '',
    tempat_lahir: tempatLahirVal || '',
    tanggal_lahir: tanggalLahirVal || ''
  };
  sheet.appendRow(headers.map(h => newRowValues[h] !== undefined ? newRowValues[h] : ''));
  formatSantriTextCols(sheet, headers, sheet.getLastRow(), newRowValues);
  delete _requestSheetData['Santri'];
  return {
    id_santri: idSantri,
    nis: newRowValues.nis,
    nik: newRowValues.nik,
    tempat_lahir: newRowValues.tempat_lahir,
    tanggal_lahir: newRowValues.tanggal_lahir,
    qr_token: qrToken,
    created: true
  };
}

function handleSavePresensi(data) {
  const { sheet } = getSheetAndHeaders('Presensi');
  const rows = getSheetData('Presensi');
  const santriList = getSheetData('Santri');

  const santri = santriList.find(s =>
    (data.id_santri && String(s.id_santri).trim() === String(data.id_santri).trim()) ||
    (data.qr_token && String(s.qr_token).trim().toLowerCase() === String(data.qr_token).trim().toLowerCase()) ||
    (data.nama_santri && String(s.nama_lengkap).trim().toLowerCase() === String(data.nama_santri).trim().toLowerCase())
  );

  if (!santri) throw new Error('Data santri tidak ditemukan di database.');

  const scope = resolveGuruScope(data);
  if (scope.isGuru) {
    if (scope.kelas_ampu.length === 0) {
      throw new Error('Akun guru Anda belum dipetakan ke kelas mana pun. Hubungi Kepala Madrasah / Admin untuk mengatur kelas ampu.');
    }
    if (!isKelasAllowed(santri.kelas, scope.kelas_ampu)) {
      throw new Error(
        'Akses ditolak: Santri "' + santri.nama_lengkap + '" berada di ' + (santri.kelas || 'Tanpa Kelas') +
        ', di luar kelas ampu Anda (' + scope.kelas_ampu.join(', ') + ').'
      );
    }
  }

  const now = new Date();
  const tanggal = data.tanggal || Utilities.formatDate(now, 'Asia/Jakarta', 'yyyy-MM-dd');
  const waktu = data.waktu || Utilities.formatDate(now, 'Asia/Jakarta', 'HH:mm:ss');
  const newId = generateUniqueSequentialId(rows, 'id_presensi', 'PRS-', 4);

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
  delete _requestSheetData['Presensi'];

  return { id_presensi: newId, santri: santri.nama_lengkap, kelas: santri.kelas, status: data.status || 'Hadir' };
}

function handleGetRekapLaporan(bulan, tahun, scope) {
  const santriList = filterRowsByGuruScope(getSheetData('Santri'), scope, 'kelas');
  const presensi = filterRowsByGuruScope(getSheetData('Presensi'), scope, 'kelas');
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
  const santriList = getSheetData('Santri');
  const matched = santriList.find(s =>
    (data.id_santri && String(s.id_santri).trim() === String(data.id_santri).trim()) ||
    (data.nama_santri && String(s.nama_lengkap).trim().toLowerCase() === String(data.nama_santri).trim().toLowerCase())
  );
  const targetKelas = String((data && data.kelas) || (matched && matched.kelas) || '').trim();

  const scope = resolveGuruScope(data);
  if (scope.isGuru) {
    if (scope.kelas_ampu.length === 0) {
      throw new Error('Akun guru Anda belum dipetakan ke kelas mana pun.');
    }
    if (!targetKelas || !isKelasAllowed(targetKelas, scope.kelas_ampu)) {
      throw new Error(
        'Akses ditolak: Anda hanya dapat menyimpan nilai UAS untuk kelas ampu Anda (' + scope.kelas_ampu.join(', ') + ').'
      );
    }
  }

  const now = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  const newId = generateUniqueSequentialId(rows, 'id_uas', 'UAS-', 3);

  sheet.appendRow([
    newId,
    data.id_santri || (matched ? matched.id_santri : ''),
    data.nama_santri,
    targetKelas,
    data.periode || 'Ganjil 2026/2027',
    data.skema_soal,
    Number(data.pg_benar || 0),
    Number(data.essay_benar || 0),
    Number(data.setengah_benar || 0),
    Number(data.nilai_uas || 0),
    data.id_guru || '',
    now
  ]);
  delete _requestSheetData['Nilai_UAS'];
  return { id_uas: newId };
}

function handleSaveNilaiRaport(items, metaCtx) {
  const { sheet } = getSheetAndHeaders('Nilai_Raport');
  const rows = getSheetData('Nilai_Raport');
  const list = Array.isArray(items) ? items : [items];
  const scope = resolveGuruScope(metaCtx || (list[0] || {}));

  if (scope.isGuru) {
    if (scope.kelas_ampu.length === 0) {
      throw new Error('Akun guru Anda belum dipetakan ke kelas mana pun.');
    }
    list.forEach(item => {
      const k = String((item && item.kelas) || '').trim();
      if (!k || !isKelasAllowed(k, scope.kelas_ampu)) {
        throw new Error(
          'Akses ditolak: Nilai raport santri "' + ((item && item.nama_santri) || '-') +
          '" berada di luar kelas ampu Anda (' + scope.kelas_ampu.join(', ') + ').'
        );
      }
    });
  }

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

  delete _requestSheetData['Nilai_Raport'];
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
  delete _requestSheetData[sheetName];
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

  const scope = resolveGuruScope(data);
  const kelasVal = String(data.kelas || 'Semua Kelas').trim();
  if (scope.isGuru) {
    if (scope.kelas_ampu.length === 0) {
      throw new Error('Akun guru Anda belum dipetakan ke kelas mana pun.');
    }
    if (kelasVal.toLowerCase() === 'semua kelas' || !isKelasAllowed(kelasVal, scope.kelas_ampu)) {
      throw new Error(
        'Akses ditolak: Anda hanya dapat mengirim laporan untuk kelas ampu Anda (' + scope.kelas_ampu.join(', ') + ').'
      );
    }
  }

  const sheet = ensureLogSetoranSheet();
  const rows = getSheetData('Log_Setoran');
  const now = new Date();
  const tanggal = formatDateOnlyWIB(data.tanggal) || Utilities.formatDate(now, 'Asia/Jakarta', 'yyyy-MM-dd');
  const waktuSubmit = data.waktu_submit || Utilities.formatDate(now, 'Asia/Jakarta', 'yyyy-MM-dd HH:mm:ss');
  const newId = generateUniqueSequentialId(rows, 'id_setoran', 'STR-', 4);
  const ringkasanStr = typeof data.ringkasan === 'string'
    ? data.ringkasan
    : JSON.stringify(data.ringkasan || {});

  const record = [
    newId,
    tanggal,
    String(data.jenis_laporan).trim(),
    kelasVal,
    String(data.periode || '').trim(),
    String(data.id_guru || '').trim(),
    String(data.nama_guru || 'Guru Piket').trim(),
    ringkasanStr,
    waktuSubmit
  ];

  sheet.appendRow(record);
  delete _requestSheetData['Log_Setoran'];

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
      if (filterKelas && normalizeKelasName(r.kelas) !== normalizeKelasName(filterKelas)) return false;
      return true;
    })
    .reverse();
}

function handleGetRekapKepsek(tanggalParam, kelasParam) {
  ensureKelasSheet();
  ensureUsersSchema();
  ensureLogSetoranSheet();
  const now = new Date();
  const targetTanggal = formatDateOnlyWIB(tanggalParam) || Utilities.formatDate(now, 'Asia/Jakarta', 'yyyy-MM-dd');
  const targetKelas = String(kelasParam || '').trim();
  const isAllClasses = !targetKelas || targetKelas.toLowerCase() === 'semua kelas';

  const officialKelasList = handleGetKelas(null);
  const usersList = handleGetUsers();
  const santriList = getSheetData('Santri');
  const presensiList = getSheetData('Presensi');
  const raportList = getSheetData('Nilai_Raport');
  const uasList = getSheetData('Nilai_UAS');
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
  const classNameSet = {};

  function registerClassName(rawName) {
    const clean = String(rawName || '').trim();
    if (!clean || clean.toLowerCase() === 'semua kelas' || clean.toLowerCase() === 'tanpa kelas') return;
    const key = clean.toLowerCase();
    if (!classNameSet[key]) classNameSet[key] = clean;
  }

  officialKelasList.forEach(k => {
    if (String(k.status || 'aktif').toLowerCase() !== 'nonaktif') {
      registerClassName(k.nama_kelas);
    }
  });

  santriList.forEach(s => {
    const id = String(s.id_santri || '').trim();
    const nama = String(s.nama_lengkap || '').trim();
    const k = String(s.kelas || '').trim();
    if (id) santriById[id] = s;
    if (nama) santriByName[nama.toLowerCase()] = s;
    if (k && String(s.status || 'aktif').toLowerCase() === 'aktif') {
      registerClassName(k);
      kelasCountMap[k] = (kelasCountMap[k] || 0) + 1;
    }
  });

  presensiList.forEach(p => {
    if (formatDateOnlyWIB(p.tanggal) === targetTanggal) registerClassName(p.kelas);
  });
  raportList.forEach(r => registerClassName(r.kelas));
  uasList.forEach(u => registerClassName(u.kelas));

  const daftarKelas = Object.keys(classNameSet).map(key => classNameSet[key]).sort();

  const guruMapByKelas = {};
  daftarKelas.forEach(k => {
    const gurus = usersList
      .filter(u =>
        String(u.role || '').trim().toLowerCase() === 'guru' &&
        String(u.status_aktif || 'aktif').trim().toLowerCase() === 'aktif' &&
        isKelasAllowed(k, u.kelas_ampu)
      )
      .map(u => ({
        id_user: String(u.id_user || ''),
        nama_lengkap: String(u.nama_lengkap || u.username || ''),
        username: String(u.username || '')
      }));
    guruMapByKelas[k] = gurus;
  });

  const userById = {};
  usersList.forEach(u => {
    const uid = String(u.id_user || '').trim();
    if (uid) userById[uid] = u;
  });

  // 1. Setoran Absensi Harian pada tanggal terpilih
  const setoranAbsensiHariIni = logList
    .filter(l => l.jenis_laporan.toLowerCase() === 'absensi harian' && l.tanggal === targetTanggal)
    .reverse();

  const setoranSemuaKelas = setoranAbsensiHariIni.find(
    l => !l.kelas || l.kelas.toLowerCase() === 'semua kelas'
  );

  const statusSetoranHariIni = daftarKelas
    .filter(k => isAllClasses || normalizeKelasName(k) === normalizeKelasName(targetKelas))
    .map(k => {
      const exact = setoranAbsensiHariIni.find(l => normalizeKelasName(l.kelas) === normalizeKelasName(k));
      const matched = exact || setoranSemuaKelas || null;
      const gurus = guruMapByKelas[k] || [];
      return {
        kelas: k,
        jumlah_santri: kelasCountMap[k] || 0,
        guru_pengampu: gurus,
        nama_guru_pengampu: gurus.length > 0 ? gurus.map(g => g.nama_lengkap).join(', ') : 'Belum dipetakan',
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
    if (!isAllClasses && normalizeKelasName(p.kelas) !== normalizeKelasName(targetKelas)) return false;
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
    isAllClasses || !l.kelas || l.kelas.toLowerCase() === 'semua kelas' || normalizeKelasName(l.kelas) === normalizeKelasName(targetKelas)
  );

  // 3. Rekap Nilai Otomatis (Nilai_Raport + Nilai_UAS per kelas & periode)
  const nilaiGroups = {};
  raportList.forEach(r => {
    const k = String(r.kelas || 'Tanpa Kelas').trim();
    const per = String(r.periode || 'Ganjil 2026/2027').trim();
    if (!isAllClasses && normalizeKelasName(k) !== normalizeKelasName(targetKelas)) return;
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
      jenis_nilai: 'Nilai Raport',
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

  setoranNilaiList.forEach(s => {
    const k = s.kelas || 'Semua Kelas';
    const per = s.periode || 'Ganjil 2026/2027';
    if (!isAllClasses && k.toLowerCase() !== 'semua kelas' && normalizeKelasName(k) !== normalizeKelasName(targetKelas)) return;
    if (k.toLowerCase() === 'semua kelas') return;
    const key = k + '||' + per;
    if (!nilaiGroups[key]) {
      nilaiGroups[key] = { kelas: k, periode: per, rows: [] };
    }
  });

  const rekapRaport = Object.keys(nilaiGroups).map(key => {
    const g = nilaiGroups[key];
    const matchedLog = setoranNilaiList.find(s =>
      (normalizeKelasName(s.kelas) === normalizeKelasName(g.kelas) || !s.kelas || s.kelas.toLowerCase() === 'semua kelas') &&
      (!s.periode || s.periode === g.periode)
    );
    const classGurus = guruMapByKelas[g.kelas] || [];
    const fallbackGuruName = classGurus.length > 0
      ? classGurus.map(x => x.nama_lengkap).join(', ')
      : 'Guru Pengampu';
    let latestUpdatedAt = '';
    g.rows.forEach(item => {
      if (item.updated_at && (!latestUpdatedAt || item.updated_at > latestUpdatedAt)) {
        latestUpdatedAt = item.updated_at;
      }
    });
    const logTanggal = matchedLog ? matchedLog.tanggal : '';
    const effectiveTanggal = (logTanggal && (!latestUpdatedAt || logTanggal > latestUpdatedAt))
      ? logTanggal
      : (latestUpdatedAt || logTanggal || '-');

    const jumlahSantri = g.rows.length;
    const totalNilai = g.rows.reduce((sum, item) => sum + item.n_akhir, 0);
    const rataRata = jumlahSantri > 0 ? Math.round((totalNilai / jumlahSantri) * 100) / 100 : 0;
    const jumlahTuntas = g.rows.filter(item => ['A', 'B', 'C'].includes(item.grade.toUpperCase())).length;
    const jumlahPerluBimbingan = jumlahSantri - jumlahTuntas;

    return {
      id_setoran: matchedLog ? matchedLog.id_setoran : '',
      jenis_nilai: 'Nilai Raport',
      kelas: g.kelas,
      periode: g.periode,
      status_setoran: matchedLog ? 'Sudah Disetor' : 'Tersimpan',
      id_guru: matchedLog ? matchedLog.id_guru : '',
      nama_guru: matchedLog ? matchedLog.nama_guru : fallbackGuruName,
      tanggal_setor: effectiveTanggal,
      waktu_submit: matchedLog ? matchedLog.waktu_submit : '',
      ringkasan: matchedLog ? matchedLog.ringkasan : '',
      jumlah_santri: jumlahSantri,
      rata_rata: rataRata,
      jumlah_tuntas: jumlahTuntas,
      jumlah_perlu_bimbingan: jumlahPerluBimbingan,
      detail_nilai: g.rows
    };
  });

  const uasGroups = {};
  uasList.forEach(u => {
    const k = String(u.kelas || 'Tanpa Kelas').trim() || 'Tanpa Kelas';
    const per = String(u.periode || 'Ganjil 2026/2027').trim();
    if (!isAllClasses && normalizeKelasName(k) !== normalizeKelasName(targetKelas)) return;
    const key = k + '||' + per;
    if (!uasGroups[key]) {
      uasGroups[key] = { kelas: k, periode: per, rowMap: {}, order: [], latestDate: '', latestGuruId: '' };
    }
    const g = uasGroups[key];
    const score = Math.round(parseNumSafe(u.nilai_uas, 0) * 100) / 100;
    const pred = computeRaportGrade(score);
    const updatedAt = formatDateOnlyWIB(u.updated_at);
    const idGuru = String(u.id_guru || '').trim();
    const dedupKey = String(u.id_santri || '').trim() ||
      String(u.nama_santri || '').trim().toLowerCase() ||
      ('row_' + u._rowIndex);

    if (!Object.prototype.hasOwnProperty.call(g.rowMap, dedupKey)) {
      g.order.push(dedupKey);
    }
    g.rowMap[dedupKey] = {
      id_uas: String(u.id_uas || ''),
      id_santri: String(u.id_santri || ''),
      nama_santri: String(u.nama_santri || '-'),
      kelas: k,
      periode: per,
      jenis_nilai: 'Nilai UAS',
      skema_soal: String(u.skema_soal || '-'),
      pg_benar: parseNumSafe(u.pg_benar, 0),
      essay_benar: parseNumSafe(u.essay_benar, 0),
      setengah_benar: parseNumSafe(u.setengah_benar, 0),
      n_harian: null,
      n_uas: score,
      n_kehadiran: null,
      n_akhir: score,
      grade: pred.grade,
      keterangan: pred.keterangan,
      id_guru: idGuru,
      updated_at: updatedAt
    };

    if (updatedAt && (!g.latestDate || updatedAt >= g.latestDate)) {
      g.latestDate = updatedAt;
      if (idGuru) g.latestGuruId = idGuru;
    } else if (!g.latestGuruId && idGuru) {
      g.latestGuruId = idGuru;
    }
  });

  const rekapUas = Object.keys(uasGroups).map(key => {
    const g = uasGroups[key];
    const uasRows = g.order.map(dk => g.rowMap[dk]);
    const uasCount = uasRows.length;
    const uasSum = uasRows.reduce((sum, item) => sum + item.n_akhir, 0);
    const uasAvg = uasCount > 0 ? Math.round((uasSum / uasCount) * 100) / 100 : 0;
    const uasTuntas = uasRows.filter(item => ['A', 'B', 'C'].includes(item.grade.toUpperCase())).length;

    const guruById = g.latestGuruId && userById[g.latestGuruId];
    const classGurus = guruMapByKelas[g.kelas] || [];
    const resolvedUasGuruName = guruById
      ? String(guruById.nama_lengkap || guruById.username || 'Guru Pengampu')
      : (classGurus.length > 0 ? classGurus.map(x => x.nama_lengkap).join(', ') : 'Guru Pengampu');

    return {
      id_setoran: '',
      jenis_nilai: 'Nilai UAS',
      kelas: g.kelas,
      periode: g.periode,
      status_setoran: 'Tersimpan',
      id_guru: g.latestGuruId || '',
      nama_guru: resolvedUasGuruName,
      tanggal_setor: g.latestDate || '-',
      waktu_submit: '',
      ringkasan: '',
      jumlah_santri: uasCount,
      rata_rata: uasAvg,
      jumlah_tuntas: uasTuntas,
      jumlah_perlu_bimbingan: uasCount - uasTuntas,
      detail_nilai: uasRows
    };
  });

  const rekapNilai = rekapRaport.concat(rekapUas);

  // 4. Laporan Terstruktur Per Kelas
  const laporanPerKelas = statusSetoranHariIni.map(stItem => {
    const k = stItem.kelas;
    const classRiwayat = riwayatTanggal.filter(r => normalizeKelasName(r.kelas) === normalizeKelasName(k));
    const classAbsent = santriTidakHadir.filter(r => normalizeKelasName(r.kelas) === normalizeKelasName(k));
    const classAgregat = { Hadir: 0, Sakit: 0, Izin: 0, Alpa: 0, total: classRiwayat.length };
    const metodeAbsensi = { qr: 0, manual: 0 };
    classRiwayat.forEach(r => {
      if (Object.prototype.hasOwnProperty.call(classAgregat, r.status)) classAgregat[r.status]++;
      if (String(r.metode || '').trim().toLowerCase() === 'qr') metodeAbsensi.qr++;
      else metodeAbsensi.manual++;
    });
    const classNilai = rekapNilai.filter(n => normalizeKelasName(n.kelas) === normalizeKelasName(k));
    const totalNilaiSantri = classNilai.reduce((s, n) => s + Number(n.jumlah_santri || 0), 0);
    const totalTuntas = classNilai.reduce((s, n) => s + Number(n.jumlah_tuntas || 0), 0);
    const totalBimbingan = classNilai.reduce((s, n) => s + Number(n.jumlah_perlu_bimbingan || 0), 0);
    const weightedSum = classNilai.reduce((s, n) => s + Number(n.rata_rata || 0) * Number(n.jumlah_santri || 0), 0);
    const avgNilai = totalNilaiSantri > 0
      ? Math.round((weightedSum / totalNilaiSantri) * 100) / 100
      : (classNilai[0] ? Number(classNilai[0].rata_rata || 0) : 0);

    return {
      kelas: k,
      jumlah_santri: stItem.jumlah_santri,
      guru_pengampu: stItem.guru_pengampu,
      nama_guru_pengampu: stItem.nama_guru_pengampu,
      status_setoran: {
        sudah_setor: stItem.sudah_setor,
        id_setoran: stItem.id_setoran,
        nama_guru: stItem.nama_guru,
        waktu_submit: stItem.waktu_submit,
        ringkasan: stItem.ringkasan
      },
      agregat_absensi: classAgregat,
      metode_absensi: metodeAbsensi,
      santri_tidak_hadir: classAbsent,
      riwayat_absensi: classRiwayat.slice().reverse(),
      rekap_nilai: classNilai,
      ringkasan_nilai: {
        jumlah_santri: totalNilaiSantri,
        rata_rata: avgNilai,
        jumlah_tuntas: totalTuntas,
        jumlah_perlu_bimbingan: totalBimbingan,
        status_setoran: classNilai.some(n => n.status_setoran === 'Sudah Disetor')
          ? 'Sudah Disetor'
          : (classNilai.length > 0 ? 'Draft' : 'Belum Ada Nilai'),
        periode: classNilai[0] ? classNilai[0].periode : '-',
        nama_guru: classNilai[0] ? classNilai[0].nama_guru : stItem.nama_guru_pengampu
      }
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
    rekap_nilai: rekapNilai,
    laporan_per_kelas: laporanPerKelas
  };
}

function handleGetPresensiByDate(tanggalParam, scope) {
  const targetTanggal = formatDateOnlyWIB(tanggalParam) || Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  return filterRowsByGuruScope(getSheetData('Presensi'), scope, 'kelas')
    .filter(p => formatDateOnlyWIB(p.tanggal) === targetTanggal)
    .reverse();
}

function handleGetBootstrapData(params, scope) {
  const activeScope = scope || resolveGuruScope(params);
  const isGuruOnly = Boolean(activeScope && activeScope.isGuru);
  const targetTanggal = params && params.tanggal;
  const targetKelas = params && params.kelas;

  if (isGuruOnly) {
    const allLogs = handleGetLogSetoran({});
    return {
      dashboard: null,
      rekap_kepsek: null,
      kelas: handleGetKelas(activeScope),
      kelas_ampu: activeScope.kelas_ampu,
      santri: handleGetSantri(activeScope),
      users: [],
      nilai_raport: handleGetNilaiRaport(activeScope),
      nilai_uas: filterRowsByGuruScope(getSheetData('Nilai_UAS'), activeScope, 'kelas'),
      dokumen_arsip: [],
      log_setoran: allLogs.filter(l => isKelasAllowed(l.kelas, activeScope.kelas_ampu)),
      presensi_hari_ini: handleGetPresensiByDate(targetTanggal, activeScope),
      fetched_at: new Date().toISOString()
    };
  }

  return {
    dashboard: handleGetDashboard(),
    rekap_kepsek: handleGetRekapKepsek(targetTanggal, targetKelas),
    kelas: handleGetKelas(null),
    kelas_ampu: [],
    santri: handleGetSantri(null),
    users: handleGetUsers(),
    nilai_raport: handleGetNilaiRaport(null),
    nilai_uas: getSheetData('Nilai_UAS'),
    dokumen_arsip: getSheetData('Dokumen_Arsip'),
    log_setoran: handleGetLogSetoran({}),
    presensi_hari_ini: [],
    fetched_at: new Date().toISOString()
  };
}
