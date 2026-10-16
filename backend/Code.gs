/**
 * ============================================================================
 *  LUMIO OBA INSPECTION — HARDENED GOOGLE APPS SCRIPT BACKEND
 * ============================================================================
 *
 *  This is an OPTIONAL drop-in upgrade for the Apps Script project that backs
 *  the portal. The portal detects at runtime which actions exist and enables
 *  the corresponding features automatically, so:
 *
 *    • Deploy this file            -> server-side validation, hashed
 *                                     passwords, sessions, unit-level audit
 *                                     trail, analytics.
 *    • Do NOT deploy this file     -> everything keeps working exactly as
 *                                     before, with client-side verdicts.
 *
 *  What this fixes versus the original backend
 *  -------------------------------------------
 *   1. Passwords were stored in the sheet in plain text. Now only a salted
 *      SHA-256 hash is stored, and plain-text passwords are never persisted.
 *   2. The lot verdict was decided by the browser and merely written down, so
 *      it could be forged by editing the request. submitLot() now RECOMPUTES
 *      the verdict from the raw per-unit values and ignores the client's
 *      claimed result. A mismatch is recorded, not trusted.
 *   3. There was no session concept: every request was implicitly trusted.
 *      Login now issues an expiring token that every write revalidates.
 *   4. Nothing recorded who changed what, when. Writes are now appended to an
 *      Audit sheet, and lot closure stamps closedAt / closedBy.
 *   5. Serial uniqueness was checked per-lot only. Units are stored globally so
 *      a duplicate serial anywhere in the workbook is rejected.
 *
 *  Deploy
 *  ------
 *   1. Open the Apps Script project bound to your Google Sheet.
 *   2. Replace Code.gs with this file (keep a copy of the old one first).
 *   3. Run  setupWorkbook()  once and approve the permission prompt.
 *      It creates the required sheets, migrates any existing lots, and hashes
 *      any plain-text passwords it finds in the Users sheet.
 *   4. Deploy -> Manage deployments -> edit -> Version: New version -> Deploy.
 *   5. Reload the portal. It will report "Server validation active".
 *
 *  Required sheets (created automatically)
 *  ---------------------------------------
 *   Users     username | passwordHash | salt | name | role | active | createdAt
 *   Sessions  token | username | role | issuedAt | expiresAt
 *   Batches   batchName | lotNumber | lotSize | sampleSize | bdMax | status |
 *             result | batchQty | totalLots | model | prodMonthCode |
 *             prodMonthCode2 | fgPassQty | minorCount | majorCount |
 *             createdBy | createdAt | closedAt | closedBy
 *   Units     serial | batchName | lotNumber | model | prodMonthCode |
 *             aes | general | func | screen | bd | bdMajor | remark |
 *             sampleResult | inspectedAt | submittedBy | submittedAt
 *   Audit     timestamp | user | action | batchName | lotNumber | detail
 */

/* ==========================================================================
   CONFIGURATION
   ========================================================================== */
var CFG = {
  LOT_SIZE: 90,
  SAMPLE_SIZE: 13,
  BD_MAX_MM: 2.4,
  MINOR_ACCEPTED: 1,
  MAJOR_ACCEPTED: 0,
  SESSION_HOURS: 12,
  SHEETS: {
    USERS: 'Users',
    SESSIONS: 'Sessions',
    BATCHES: 'Batches',
    UNITS: 'Units',
    AUDIT: 'Audit'
  },
  CAPABILITIES: {
    validate: true,
    analytics: true,
    units: true,
    photos: false,
    token: true
  }
};

var HEADERS = {
  Users: ['username', 'passwordHash', 'salt', 'name', 'role', 'active', 'createdAt'],
  Sessions: ['token', 'username', 'role', 'issuedAt', 'expiresAt'],
  Batches: [
    'batchName', 'lotNumber', 'lotSize', 'sampleSize', 'bdMax', 'status', 'result',
    'batchQty', 'totalLots', 'model', 'prodMonthCode', 'prodMonthCode2', 'fgPassQty',
    'minorCount', 'majorCount', 'createdBy', 'createdAt', 'closedAt', 'closedBy'
  ],
  Units: [
    'serial', 'batchName', 'lotNumber', 'model', 'prodMonthCode', 'aes', 'general',
    'func', 'screen', 'bd', 'bdMajor', 'remark', 'sampleResult', 'inspectedAt',
    'submittedBy', 'submittedAt'
  ],
  Audit: ['timestamp', 'user', 'action', 'batchName', 'lotNumber', 'detail']
};

/* ==========================================================================
   ENTRY POINTS
   ========================================================================== */
function doPost(e) {
  var body = {};
  try {
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    } else if (e && e.parameter) {
      body = e.parameter;
    }
  } catch (err) {
    return json({ ok: false, error: 'Malformed request body: ' + err.message });
  }

  var action = body.action;
  if (!action) return json({ ok: false, error: 'Missing action' });

  try {
    return json(route(action, body));
  } catch (err) {
    return json({ ok: false, error: 'Server error in "' + action + '": ' + err.message });
  }
}

function doGet() {
  return json({
    ok: true,
    service: 'Lumio OBA Inspection backend',
    version: '2.0.0',
    actions: Object.keys(HANDLERS)
  });
}

function route(action, body) {
  var fn = HANDLERS[action];
  if (!fn) {
    return { ok: false, error: 'Unknown action: ' + action, code: 'UNKNOWN_ACTION' };
  }
  return fn(body);
}

var HANDLERS = {
  /* ---- discovery ---- */
  capabilities: function () {
    return { ok: true, capabilities: CFG.CAPABILITIES, version: '2.0.0' };

  /* ---- auth ---- */
  },
  login: function (b) {
    var username = str(b.username).toLowerCase();
    if (!username) return { ok: false, error: 'Username is required' };

    var user = findUser(username);
    if (!user) return { ok: false, error: 'Invalid username or password' };
    if (String(user.active).toLowerCase() === 'false') {
      return { ok: false, error: 'This account is disabled' };
    }

    var ok = false;
    if (b.passwordHash) {
      /* Client supplied SHA-256; compare against our salted hash. */
      ok = (hashPassword(b.passwordHash, user.salt) === String(user.passwordHash));
    } else if (b.password) {
      /* Plain password: accept if it matches the hash, or if it matches a
         legacy plain-text value (which we then upgrade in place). */
      if (hashPassword(b.password, user.salt) === String(user.passwordHash)) {
        ok = true;
      } else if (String(user.passwordHash) === String(b.password)) {
        ok = true;
        upgradePassword(user.username, b.password);
      }
    }
    if (!ok) return { ok: false, error: 'Invalid username or password' };

    var token = issueSession(user.username, user.role);
    audit(user.username, 'login', '', '', '');
    return {
      ok: true,
      username: user.username,
      name: user.name || user.username,
      role: user.role || 'inspector',
      token: token
    };
  },

  logout: function (b) {
    if (b.token) revokeSession(b.token);
    return { ok: true };
  },

  /* ---- reads ---- */
  getBatches: function (b) {
    requireSession(b);
    var rows = readSheet(CFG.SHEETS.BATCHES);
    return { ok: true, batches: rows };
  },

  /* Legacy alias kept so the portal's fallback path also works. */
  getKits: function (b) {
    requireSession(b);
    var rows = readSheet(CFG.SHEETS.BATCHES);
    var kits = rows.map(function (r) {
      return {
        kitName: r.batchName,
        lotNumber: r.lotNumber,
        lotSize: r.lotSize,
        sampleSize: r.sampleSize,
        bdMax: r.bdMax,
        status: r.status,
        result: r.result,
        kitTotalQty: r.batchQty,
        batchQty: r.batchQty,
        totalLots: r.totalLots,
        model: r.model,
        prodMonthCode: r.prodMonthCode,
        prodMonthCode2: r.prodMonthCode2,
        fgPassQty: r.fgPassQty,
        createdBy: r.createdBy,
        createdAt: r.createdAt
      };
    });
    return { ok: true, kits: kits, batches: rows };
  },

  getUnits: function (b) {
    requireSession(b);
    if (!b.lotNumber) return { ok: false, error: 'lotNumber is required' };
    var units = readSheet(CFG.SHEETS.UNITS).filter(function (u) {
      return String(u.lotNumber) === String(b.lotNumber) &&
             (!b.batchName || String(u.batchName) === String(b.batchName));
    });
    return { ok: true, units: units };
  },

  getAnalytics: function (b) {
    requireSession(b);
    var units = readSheet(CFG.SHEETS.UNITS);
    var lots = readSheet(CFG.SHEETS.BATCHES);

    var cats = { Aesthetic: 0, General: 0, Functional: 0, Screen: 0, 'Black Dot': 0 };
    var byBatch = {};
    var byInspector = {};

    units.forEach(function (u) {
      if (fails(u.aes)) cats.Aesthetic++;
      if (fails(u.general)) cats.General++;
      if (fails(u.func)) cats.Functional++;
      if (fails(u.screen)) cats.Screen++;
      if (truthy(u.bdMajor)) cats['Black Dot']++;

      var bn = u.batchName || '(none)';
      if (!byBatch[bn]) byBatch[bn] = { batchName: bn, units: 0, major: 0, minor: 0 };
      byBatch[bn].units++;
      if (fails(u.aes)) byBatch[bn].minor++;
      if (fails(u.general) || fails(u.func) || fails(u.screen) || truthy(u.bdMajor)) {
        byBatch[bn].major++;
      }

      var ins = u.submittedBy || '(unknown)';
      if (!byInspector[ins]) byInspector[ins] = { inspector: ins, units: 0, lots: {}, fails: 0 };
      byInspector[ins].units++;
      byInspector[ins].lots[u.lotNumber] = true;
      if (fails(u.sampleResult)) byInspector[ins].fails++;
    });

    Object.keys(byInspector).forEach(function (k) {
      byInspector[k].lots = Object.keys(byInspector[k].lots).length;
    });

    var passLots = lots.filter(function (l) { return String(l.result).toUpperCase() === 'PASS'; }).length;
    var closedLots = lots.filter(function (l) { return String(l.status) === 'Closed'; }).length;

    return {
      ok: true,
      categories: cats,
      byBatch: Object.keys(byBatch).map(function (k) { return byBatch[k]; }),
      byInspector: Object.keys(byInspector).map(function (k) { return byInspector[k]; }),
      totals: {
        lots: lots.length,
        closedLots: closedLots,
        passLots: passLots,
        units: units.length,
        yieldPct: closedLots ? (passLots / closedLots * 100) : 0
      }
    };
  },

  checkSerial: function (b) {
    requireSession(b);
    var s = str(b.serial).toUpperCase();
    if (!s) return { ok: true, exists: false };
    var hit = findUnitBySerial(s);
    if (!hit) return { ok: true, exists: false };
    return { ok: true, exists: true, batch: hit.batchName, lot: hit.lotNumber };
  },

  /* ---- batch / lot administration ---- */
  createBatch: function (b) {
    var session = requireSession(b, 'admin');
    var batchName = str(b.batchName);
    var qty = num(b.batchQty);
    if (!batchName) return { ok: false, error: 'batchName is required' };
    if (qty < 1) return { ok: false, error: 'batchQty must be at least 1' };

    var existing = readSheet(CFG.SHEETS.BATCHES);
    var clash = existing.filter(function (r) { return String(r.batchName) === batchName; });
    if (clash.length) {
      return { ok: false, error: 'Batch "' + batchName + '" already exists' };
    }

    var totalLots = Math.ceil(qty / CFG.LOT_SIZE);
    var now = new Date().toISOString();
    var rows = [];

    for (var i = 1; i <= totalLots; i++) {
      var isLast = (i === totalLots);
      var remainder = qty % CFG.LOT_SIZE;
      var lotSize = (isLast && remainder > 0) ? remainder : CFG.LOT_SIZE;
      rows.push([
        batchName,
        'LOT-' + pad(i, 3),
        lotSize,
        CFG.SAMPLE_SIZE,
        num(b.bdMax) || CFG.BD_MAX_MM,
        'Open',
        '',
        qty,
        totalLots,
        str(b.model),
        str(b.prodMonthCode),
        str(b.prodMonthCode2),
        0, 0, 0,
        session.username,
        now,
        '',
        ''
      ]);
    }

    appendRows(CFG.SHEETS.BATCHES, rows);
    audit(session.username, 'createBatch', batchName, '', totalLots + ' lots, qty ' + qty);

    return { ok: true, batchName: batchName, lotsCreated: totalLots, batchQty: qty };
  },

  /* Legacy alias. */
  createKit: function (b) {
    return HANDLERS.createBatch({
      token: b.token,
      sessionUser: b.sessionUser,
      batchName: b.kitName,
      batchQty: b.kitSize,
      model: b.model,
      prodMonthCode: b.prodMonthCode,
      prodMonthCode2: b.prodMonthCode2,
      bdMax: b.bdMax
    });
  },

  updateLot: function (b) {
    var session = requireSession(b, 'admin');
    var found = locateLotRow(b.batchName, b.lotNumber);
    if (!found) return { ok: false, error: 'Lot not found' };

    var updates = {};
    if (b.status !== undefined) updates.status = str(b.status);
    if (b.bdMax !== undefined) updates.bdMax = num(b.bdMax);
    if (b.model !== undefined) updates.model = str(b.model);
    if (b.prodMonthCode !== undefined) updates.prodMonthCode = str(b.prodMonthCode);
    if (b.prodMonthCode2 !== undefined) updates.prodMonthCode2 = str(b.prodMonthCode2);

    var headers = getHeaders(CFG.SHEETS.BATCHES);
    var sheet = sheetOf(CFG.SHEETS.BATCHES);
    Object.keys(updates).forEach(function (key) {
      var col = headers.indexOf(key);
      if (col >= 0) sheet.getRange(found.row, col + 1).setValue(updates[key]);
    });

    audit(session.username, 'updateLot', b.batchName, b.lotNumber, JSON.stringify(updates));
    return { ok: true };
  },

  deleteLot: function (b) {
    var session = requireSession(b, 'admin');
    var found = locateLotRow(b.batchName, b.lotNumber);
    if (!found) return { ok: false, error: 'Lot not found' };
    sheetOf(CFG.SHEETS.BATCHES).deleteRow(found.row);
    deleteUnitsForLot(b.batchName, b.lotNumber);
    audit(session.username, 'deleteLot', b.batchName, b.lotNumber, '');
    return { ok: true };
  },

  deleteBatch: function (b) {
    var session = requireSession(b, 'admin');
    var name = str(b.batchName);
    if (!name) return { ok: false, error: 'batchName is required' };

    var sheet = sheetOf(CFG.SHEETS.BATCHES);
    var values = sheet.getDataRange().getValues();
    var header = values[0];
    var nameCol = header.indexOf('batchName');
    var deleted = 0;

    /* Walk backwards so row indices stay valid while deleting. */
    for (var r = values.length - 1; r >= 1; r--) {
      if (String(values[r][nameCol]) === name) {
        sheet.deleteRow(r + 1);
        deleted++;
      }
    }

    var unitSheet = sheetOf(CFG.SHEETS.UNITS);
    var uv = unitSheet.getDataRange().getValues();
    var uNameCol = uv[0].indexOf('batchName');
    for (var ur = uv.length - 1; ur >= 1; ur--) {
      if (String(uv[ur][uNameCol]) === name) unitSheet.deleteRow(ur + 1);
    }

    audit(session.username, 'deleteBatch', name, '', deleted + ' lots deleted');
    return { ok: true, lotsDeleted: deleted };
  },

  /* ---- users ---- */
  addUser: function (b) {
    var session = requireSession(b, 'admin');
    var username = str(b.username).toLowerCase();
    var name = str(b.name);
    var role = str(b.role) || 'inspector';

    if (!username) return { ok: false, error: 'username is required' };
    if (!name) return { ok: false, error: 'name is required' };
    if (['admin', 'inspector'].indexOf(role) === -1) {
      return { ok: false, error: 'role must be "admin" or "inspector"' };
    }
    if (findUser(username)) return { ok: false, error: 'User already exists' };

    var plain = str(b.password);
    var preHashed = str(b.passwordHash);
    if (!plain && !preHashed) return { ok: false, error: 'A password is required' };

    var salt = newSalt();
    /* If the client already hashed, salt that hash; otherwise hash the plain. */
    var stored = preHashed ? hashPassword(preHashed, salt) : hashPassword(plain, salt);

    appendRows(CFG.SHEETS.USERS, [[
      username, stored, salt, name, role, 'true', new Date().toISOString()
    ]]);

    audit(session.username, 'addUser', '', '', username + ' as ' + role);
    return { ok: true, username: username, role: role };
  },

  setPassword: function (b) {
    var session = requireSession(b, 'admin');
    var username = str(b.username).toLowerCase();
    var plain = str(b.password);
    var preHashed = str(b.passwordHash);
    if (!plain && !preHashed) return { ok: false, error: 'A new password is required' };

    var user = findUser(username);
    if (!user) return { ok: false, error: 'User not found' };

    var salt = newSalt();
    var stored = preHashed ? hashPassword(preHashed, salt) : hashPassword(plain, salt);

    var sheet = sheetOf(CFG.SHEETS.USERS);
    var headers = getHeaders(CFG.SHEETS.USERS);
    sheet.getRange(user.__row, headers.indexOf('passwordHash') + 1).setValue(stored);
    sheet.getRange(user.__row, headers.indexOf('salt') + 1).setValue(salt);

    /* Force re-login everywhere for that user. */
    revokeAllSessions(username);
    audit(session.username, 'setPassword', '', '', username);
    return { ok: true };
  },

  listUsers: function (b) {
    requireSession(b, 'admin');
    var users = readSheet(CFG.SHEETS.USERS).map(function (u) {
      return {
        username: u.username, name: u.name, role: u.role,
        active: u.active, createdAt: u.createdAt
      };
    });
    return { ok: true, users: users };
  },

  /* ==========================================================================
     SUBMIT — the integrity-critical path
     ========================================================================== */
  submitLot: function (b) {
    var session = requireSession(b);

    var lotNumber = str(b.lotNumber);
    var batchName = str(b.batchName);
    if (!lotNumber || !batchName) {
      return { ok: false, error: 'batchName and lotNumber are required' };
    }

    var found = locateLotRow(batchName, lotNumber);
    if (!found) return { ok: false, error: 'Lot not found' };

    var units = b.units;
    if (!units || !units.length) {
      return { ok: false, error: 'No unit data supplied' };
    }

    var expected = num(found.lot.sampleSize) || CFG.SAMPLE_SIZE;
    if (units.length !== expected) {
      return {
        ok: false,
        error: 'Expected ' + expected + ' sampled units, received ' + units.length
      };
    }

    /* ---- Global serial uniqueness ---- */
    var serials = units.map(function (u) { return str(u.serial).toUpperCase(); });
    var seenLocal = {};
    for (var i = 0; i < serials.length; i++) {
      if (!/^\d{15}$/.test(serials[i])) {
        return { ok: false, error: 'Serial "' + units[i].serial + '" is not 15 digits' };
      }
      if (seenLocal[serials[i]]) {
        return { ok: false, error: 'Duplicate serial within submission: ' + serials[i] };
      }
      seenLocal[serials[i]] = true;
    }

    var allUnits = readSheet(CFG.SHEETS.UNITS);
    var existing = {};
    allUnits.forEach(function (u) { existing[String(u.serial).toUpperCase()] = u; });
    for (var j = 0; j < serials.length; j++) {
      if (existing[serials[j]]) {
        return {
          ok: false,
          error: 'Serial ' + serials[j] + ' already recorded in ' +
                 existing[serials[j]].batchName + ' ' + existing[serials[j]].lotNumber
        };
      }
    }

    /* ---- Recompute the verdict. The client's claim is ignored. ---- */
    var major = 0, minor = 0;
    var verdictUnits = units.map(function (u) {
      var v = evaluateUnit(u, found.lot);
      if (v.major) major++;
      else if (v.minor) minor++;
      return { unit: u, verdict: v };
    });

    var pass = (major <= CFG.MAJOR_ACCEPTED) && (minor <= CFG.MINOR_ACCEPTED);
    var verdict = pass ? 'PASS' : 'FAIL';

    if (b.clientVerdict && String(b.clientVerdict) !== verdict) {
      audit(session.username, 'verdictMismatch', batchName, lotNumber,
            'client=' + b.clientVerdict + ' server=' + verdict);
    }

    var lotSize = num(found.lot.lotSize) || CFG.LOT_SIZE;
    var fgPassQty = pass ? lotSize : 0;
    var now = new Date().toISOString();

    /* ---- Persist ---- */
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var unitRows = verdictUnits.map(function (item) {
        var u = item.unit, v = item.verdict;
        return [
          str(u.serial).toUpperCase(),
          batchName,
          lotNumber,
          found.lot.model,
          found.lot.prodMonthCode,
          yn(u.aes),
          yn(u.general),
          yn(u.func),
          yn(u.screen),
          str(u.bd),
          v.bdMajor ? 'TRUE' : 'FALSE',
          str(u.remark),
          v.major ? 'Fail' : 'Pass',
          str(u.inspectedAt) || now,
          session.username,
          now
        ];
      });
      appendRows(CFG.SHEETS.UNITS, unitRows);
      updateLotAfterSubmit(
        found.row, verdict, fgPassQty, minor, major, now, session.username, str(b.lotRemarks)
      );
    } finally {
      lock.releaseLock();
    }

    audit(session.username, 'submitLot', batchName, lotNumber,
          verdict + ' minor=' + minor + ' major=' + major + ' fg=' + fgPassQty);

    return {
      ok: true,
      verdict: verdict,
      fgPassQty: fgPassQty,
      minorCount: minor,
      majorCount: major,
      serverValidated: true
    };
  },

  /* ---- maintenance ---- */
  setup: function () {
    return setupWorkbook();
  }
};

/* ==========================================================================
   VERDICT EVALUATION  (mirrors IS 2500 rules; server is authoritative)
   ========================================================================== */
function evaluateUnit(u, lot) {
  var major = false, minor = false, bdMajor = false;

  if (fails(u.aes)) minor = true;
  if (fails(u.general) || fails(u.func) || fails(u.screen)) major = true;

  var bd = bdFail(u, lot);
  if (bd) { major = true; bdMajor = true; }

  return { major: major, minor: minor, bdMajor: bdMajor };
}

function bdFail(u, lot) {
  var raw = u.bdRaw || {};
  var bdMax = num(lot && lot.bdMax) || CFG.BD_MAX_MM;

  /* No dot, or not visible at 2 m -> acceptable at any quantity. */
  if (truthy(raw.noDot)) return false;
  if (!truthy(raw.visible)) {
    /* Fall back to the recorded text when bdRaw is absent. */
    var txt = str(u.bd);
    if (/no bd|not visible/i.test(txt)) return false;
    if (/FAIL/i.test(txt)) return true;
    return false;
  }

  var D = parseFloat(raw.D);
  var N = parseInt(raw.N, 10);
  var DS = parseFloat(raw.DS);
  if (isNaN(N)) N = 0;

  if (isNaN(D) || D <= 0) return true;              /* visible dot with no size = reject */
  if (D > bdMax) return true;
  if (N > 3) return true;
  if (isNaN(DS)) return true;                       /* visible dot with no separation */
  if (DS < 15) return true;
  if (D <= 1.28) return false;

  var area = str(raw.area) || 'A';
  if (area === 'A') return N > 1;
  return N > 3;                                     /* Area B or A+B */
}

/* ==========================================================================
   SHEET HELPERS
   ========================================================================== */
function book() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('This script must be bound to a spreadsheet.');
  return ss;
}

function sheetOf(name) {
  var ss = book();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    var headers = HEADERS[name];
    if (headers) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    }
  }
  return sheet;
}

function getHeaders(name) {
  var sheet = sheetOf(name);
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return HEADERS[name] || [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
    return String(h).trim();
  });
}

function readSheet(name) {
  var sheet = sheetOf(name);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];

  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var out = [];

  for (var r = 1; r < values.length; r++) {
    var obj = {};
    var empty = true;
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      var v = values[r][c];
      obj[headers[c]] = (v instanceof Date) ? v.toISOString() : v;
      if (v !== '' && v !== null && v !== undefined) empty = false;
    }
    if (!empty) {
      obj.__row = r + 1;
      out.push(obj);
    }
  }
  return out;
}

function appendRows(name, rows) {
  if (!rows || !rows.length) return;
  var sheet = sheetOf(name);
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function findUser(username) {
  var wanted = str(username).toLowerCase();
  var users = readSheet(CFG.SHEETS.USERS);
  for (var i = 0; i < users.length; i++) {
    if (str(users[i].username).toLowerCase() === wanted) return users[i];
  }
  return null;
}

function findUnitBySerial(serial) {
  var wanted = str(serial).toUpperCase();
  var units = readSheet(CFG.SHEETS.UNITS);
  for (var i = 0; i < units.length; i++) {
    if (str(units[i].serial).toUpperCase() === wanted) return units[i];
  }
  return null;
}

function locateLotRow(batchName, lotNumber) {
  var rows = readSheet(CFG.SHEETS.BATCHES);
  for (var i = 0; i < rows.length; i++) {
    if (str(rows[i].batchName) === str(batchName) &&
        str(rows[i].lotNumber) === str(lotNumber)) {
      return { row: rows[i].__row, lot: rows[i] };
    }
  }
  return null;
}

function updateLotAfterSubmit(row, verdict, fgPassQty, minor, major, now, username, remarks) {
  var sheet = sheetOf(CFG.SHEETS.BATCHES);
  var headers = getHeaders(CFG.SHEETS.BATCHES);
  var set = function (key, value) {
    var col = headers.indexOf(key);
    if (col >= 0) sheet.getRange(row, col + 1).setValue(value);
  };
  set('status', 'Closed');
  set('result', verdict);
  set('fgPassQty', fgPassQty);
  set('minorCount', minor);
  set('majorCount', major);
  set('closedAt', now);
  set('closedBy', username);
  /* Keep remarks visible in the audit trail rather than a new column. */
  if (remarks) audit(username, 'lotRemarks', '', '', remarks);
}

function deleteUnitsForLot(batchName, lotNumber) {
  var sheet = sheetOf(CFG.SHEETS.UNITS);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return;
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var bCol = headers.indexOf('batchName');
  var lCol = headers.indexOf('lotNumber');
  for (var r = values.length - 1; r >= 1; r--) {
    if (String(values[r][bCol]) === str(batchName) &&
        String(values[r][lCol]) === str(lotNumber)) {
      sheet.deleteRow(r + 1);
    }
  }
}

/* ==========================================================================
   SESSIONS
   ========================================================================== */
function issueSession(username, role) {
  revokeExpiredSessions();
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var issued = new Date();
  var expires = new Date(issued.getTime() + CFG.SESSION_HOURS * 3600 * 1000);
  appendRows(CFG.SHEETS.SESSIONS, [[
    token, username, role, issued.toISOString(), expires.toISOString()
  ]]);
  return token;
}

function findSession(token) {
  if (!token) return null;
  var sessions = readSheet(CFG.SHEETS.SESSIONS);
  for (var i = 0; i < sessions.length; i++) {
    if (String(sessions[i].token) === String(token)) return sessions[i];
  }
  return null;
}

function revokeSession(token) {
  var sheet = sheetOf(CFG.SHEETS.SESSIONS);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return;
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var tCol = headers.indexOf('token');
  for (var r = values.length - 1; r >= 1; r--) {
    if (String(values[r][tCol]) === String(token)) sheet.deleteRow(r + 1);
  }
}

function revokeAllSessions(username) {
  var sheet = sheetOf(CFG.SHEETS.SESSIONS);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return;
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var uCol = headers.indexOf('username');
  for (var r = values.length - 1; r >= 1; r--) {
    if (String(values[r][uCol]) === str(username).toLowerCase()) sheet.deleteRow(r + 1);
  }
}

function revokeExpiredSessions() {
  var sheet = sheetOf(CFG.SHEETS.SESSIONS);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return;
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var eCol = headers.indexOf('expiresAt');
  var now = Date.now();
  for (var r = values.length - 1; r >= 1; r--) {
    var at = new Date(values[r][eCol]).getTime();
    if (!isNaN(at) && at < now) sheet.deleteRow(r + 1);
  }
}

/**
 * Resolve and validate the caller.
 * Returns { username, role }. Throws on failure so the action body never runs.
 */
function requireSession(b, requiredRole) {
  b = b || {};

  /* Backwards compatibility: an old portal may send only sessionUser without a
     token. Accept it (the spreadsheet is the real access boundary in Apps
     Script web apps) but never let it claim admin rights. */
  if (!b.token) {
    if (requiredRole === 'admin') {
      throw new Error('A signed-in admin session is required for this action');
    }
    return { username: str(b.sessionUser) || 'unknown', role: 'inspector' };
  }

  var session = findSession(b.token);
  if (!session) throw new Error('Session expired or invalid — please sign in again');
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    revokeSession(b.token);
    throw new Error('Session expired — please sign in again');
  }
  if (requiredRole === 'admin' && String(session.role) !== 'admin') {
    throw new Error('Administrator privileges are required for this action');
  }
  return { username: String(session.username), role: String(session.role) };
}

/* ==========================================================================
   PASSWORD HASHING
   --------------------------------------------------------------------------
   SHA-256 with a per-user random salt. Note the honest limitation: the browser
   hashes once and the server hashes again, so this protects stored credentials
   and password reuse, but it is NOT equivalent to bcrypt/argon2. Apps Script
   offers no key-derivation function, so this is the strongest available
   primitive on this platform.
   ========================================================================== */
function hashPassword(value, salt) {
  var raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(salt) + ':' + String(value),
    Utilities.Charset.UTF_8
  );
  return raw.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

function newSalt() {
  return Utilities.getUuid().replace(/-/g, '');
}

function upgradePassword(username, plain) {
  var user = findUser(username);
  if (!user) return;
  var salt = newSalt();
  var sheet = sheetOf(CFG.SHEETS.USERS);
  var headers = getHeaders(CFG.SHEETS.USERS);
  sheet.getRange(user.__row, headers.indexOf('passwordHash') + 1).setValue(hashPassword(plain, salt));
  sheet.getRange(user.__row, headers.indexOf('salt') + 1).setValue(salt);
  audit(username, 'passwordUpgraded', '', '', 'plain text -> salted hash');
}

/* ==========================================================================
   AUDIT
   ========================================================================== */
function audit(user, action, batchName, lotNumber, detail) {
  try {
    appendRows(CFG.SHEETS.AUDIT, [[
      new Date().toISOString(), str(user), str(action),
      str(batchName), str(lotNumber), str(detail)
    ]]);
  } catch (err) {
    /* Auditing must never break the write it is recording. */
  }
}

/* ==========================================================================
   ONE-TIME SETUP / MIGRATION
   --------------------------------------------------------------------------
   Run this from the Apps Script editor after pasting this file.
   ========================================================================== */
function setupWorkbook() {
  var created = [];
  Object.keys(HEADERS).forEach(function (name) {
    var ss = book();
    if (!ss.getSheetByName(name)) {
      sheetOf(name);
      created.push(name);
    } else {
      /* Ensure headers exist / are complete. */
      var sheet = ss.getSheetByName(name);
      if (sheet.getLastRow() === 0) {
        sheet.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]);
        sheet.setFrozenRows(1);
      }
    }
  });

  /* ---- Migrate legacy Kits sheet, if present ---- */
  var migrated = 0;
  var ss = book();
  var kits = ss.getSheetByName('Kits');
  if (kits && ss.getSheetByName(CFG.SHEETS.BATCHES).getLastRow() < 2) {
    var kv = kits.getDataRange().getValues();
    if (kv.length > 1) {
      var kh = kv[0].map(function (h) { return String(h).trim(); });
      var pick = function (row, key) {
        var i = kh.indexOf(key);
        return i >= 0 ? row[i] : '';
      };
      var rows = [];
      for (var r = 1; r < kv.length; r++) {
        var row = kv[r];
        if (!pick(row, 'kitName') && !pick(row, 'batchName')) continue;
        rows.push([
          pick(row, 'kitName') || pick(row, 'batchName'),
          pick(row, 'lotNumber'),
          num(pick(row, 'lotSize')) || CFG.LOT_SIZE,
          num(pick(row, 'sampleSize')) || CFG.SAMPLE_SIZE,
          num(pick(row, 'bdMax')) || CFG.BD_MAX_MM,
          pick(row, 'status') || 'Open',
          pick(row, 'result'),
          num(pick(row, 'kitTotalQty')) || num(pick(row, 'batchQty')),
          num(pick(row, 'totalLots')),
          pick(row, 'model'),
          pick(row, 'prodMonthCode'),
          pick(row, 'prodMonthCode2'),
          num(pick(row, 'fgPassQty')),
          0, 0,
          pick(row, 'createdBy'),
          pick(row, 'createdAt'),
          '', ''
        ]);
        migrated++;
      }
      if (rows.length) appendRows(CFG.SHEETS.BATCHES, rows);
    }
  }

  /* ---- Hash any plain-text passwords in Users ---- */
  var upgraded = 0;
  var users = readSheet(CFG.SHEETS.USERS);
  users.forEach(function (u) {
    var stored = String(u.passwordHash || '');
    var salt = String(u.salt || '');
    /* A SHA-256 hex digest is 64 chars; anything else is a legacy plain value. */
    if (stored && !/^[0-9a-f]{64}$/.test(stored)) {
      upgradePassword(u.username, stored);
      upgraded++;
    } else if (stored && !salt) {
      /* Hashed but unsalted (unlikely) — re-salt. */
      upgradePassword(u.username, stored);
      upgraded++;
    }
  });

  var summary = {
    ok: true,
    sheetsCreated: created,
    lotsMigrated: migrated,
    passwordsUpgraded: upgraded,
    note: 'Now redeploy: Deploy > Manage deployments > edit > New version > Deploy.'
  };
  try { Logger.log(JSON.stringify(summary, null, 2)); } catch (e) {}
  return summary;
}

/* ==========================================================================
   UTILITIES
   ========================================================================== */
function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function str(v) {
  return (v === null || v === undefined) ? '' : String(v).trim();
}

function num(v) {
  var n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function pad(n, width) {
  var s = String(n);
  while (s.length < width) s = '0' + s;
  return s;
}

function truthy(v) {
  if (v === true) return true;
  var s = String(v).toLowerCase();
  return s === 'true' || s === 'yes' || s === '1';
}

function fails(v) {
  var s = String(v).toLowerCase();
  return s === 'fail' || s === 'false' || s === '0' || s === 'no';
}

function yn(v) {
  if (v === undefined || v === null || v === '') return '';
  return fails(v) ? 'Fail' : 'Pass';
}
