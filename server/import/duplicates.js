'use strict';
// Duplicate review queue.
//
//   listDuplicates({ status: 'open', page, pageSize }) -> { items, total, page, pageSize }
//   resolveDuplicate(id, { action: 'merge'|'keep_separate'|'dismiss', note }, { req })
//
// Two kinds of candidate:
//   * likely duplicate  (plant_id + other_plant_id): two plants that look like the same place under different codes.
//     merge keeps plant_id, moves every reference from other_plant_id onto it, snapshots the removed plant into the
//     audit log (before) and deletes it.
//   * in-file duplicate (import_row_id, other_plant_id NULL): a later row repeating a Plant ID; it was not imported.
//     keep_separate imports it anyway (under its code, or a derived "<code>-DUPn" code flagged for review if the code
//     is taken); dismiss leaves it out.
const { getDb, tx, parseJson } = require('../lib/db');
const { HttpError } = require('../lib/http');
const { audit } = require('../lib/audit');
const { nowIso } = require('../lib/time');
const { insertEntry, addExtras, makeAreaLinker, rowView, haversineM } = require('./pipeline');

const STATUSES = ['open', 'merged', 'kept_separate', 'dismissed'];
/** duplicate_candidates.reason codes. */
const REASONS = {
  duplicate_plant_code: 'The same Plant ID appears more than once in an imported file; the later row was held back.',
  same_name_and_area: 'Two plants have the same name in the same area.',
  nearby_position: 'Two plants are within 25 m of each other and have similar names.',
};

function reasonDetail(c, plant, other, row) {
  if (c.reason === 'duplicate_plant_code' && row) {
    const n = parseJson(row.normalized_json, {}) || {};
    return `Plant ID '${n.code}' appears more than once in '${c.source_filename || 'the file'}' (first at row ${n.duplicateOfRow ?? '?'}); row ${row.row_number} was not imported.`;
  }
  if (c.reason === 'nearby_position' && plant && other && plant.latitude !== null && other.latitude !== null) {
    return `About ${Math.round(haversineM(plant.latitude, plant.longitude, other.latitude, other.longitude))} m apart, with similar names (similarity ${Math.round((c.score || 0) * 100)}%).`;
  }
  if (c.reason === 'same_name_and_area' && plant && other) return `Both are named "${plant.name}" in ${plant.areaRaw || 'the same area'} (${plant.town || 'town not given'}).`;
  return REASONS[c.reason] || c.reason;
}

function plantKeyFields(db, id) {
  if (!id) return null;
  const p = db.prepare('SELECT * FROM plants WHERE id = ?').get(id);
  if (!p) return null;
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE plant_id = ?`).get(id).n;
  return {
    id: p.id, code: p.plant_code, name: p.name, town: p.town, areaRaw: p.area_raw, address: p.address, landmark: p.landmark,
    operatorType: p.operator_type, operatorName: p.operator_name, waterSource: p.water_source, technologyRaw: p.technology_raw,
    capacityRaw: p.capacity_raw, statusRaw: p.status_raw, status: p.status, statusSource: p.status_source,
    latitude: p.latitude, longitude: p.longitude, coordStatus: p.coord_status, lastVerifiedAt: p.last_verified_at,
    sourceFile: p.source_file, sourceSheet: p.source_sheet, sourceRow: p.source_row, sourceValues: parseJson(p.source_values_json, null),
    isDemo: !!p.is_demo, counts: { reports: count('reports'), waterTests: count('water_tests'), ratings: count('ratings'), sources: count('plant_sources') },
  };
}

function candidateView(db, c) {
  const row = c.import_row_id ? db.prepare('SELECT * FROM import_rows WHERE id = ?').get(c.import_row_id) : null;
  const rv = row ? rowView(row) : null;
  const plant = plantKeyFields(db, c.plant_id);
  const other = plantKeyFields(db, c.other_plant_id);
  const rowOut = rv ? { id: rv.id, rowNumber: rv.rowNumber, plantCode: rv.plantCode, values: rv.values, plant: rv.plant, warnings: rv.warnings, importedAsPlantId: rv.plantId } : null;
  return {
    id: c.id, kind: c.reason === 'duplicate_plant_code' ? 'duplicate_code_in_file' : 'likely_duplicate',
    status: c.status, reason: c.reason, reasonDetail: reasonDetail(c, plant, other, row), score: c.score,
    batchId: c.batch_id, sourceFile: c.source_filename ?? null, detectedAt: c.committed_at ?? null,
    resolutionNote: c.resolution_note, resolvedAt: c.resolved_at, resolvedBy: c.resolved_by_username ?? null,
    plant, other, row: rowOut, importRow: rowOut,
  };
}

function listDuplicates({ status = 'open', page = 1, pageSize = 25 } = {}) {
  const db = getDb();
  if (status !== 'all' && !STATUSES.includes(status)) throw new HttpError(400, 'invalid_input', `status must be one of: ${STATUSES.join(', ')}, all`, { field: 'status' });
  const pg = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 25));
  const where = status === 'all' ? '1 = 1' : 'dc.status = ?';
  const args = status === 'all' ? [] : [status];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM duplicate_candidates dc WHERE ${where}`).get(...args).n;
  const rows = db.prepare(`SELECT dc.*, b.source_filename, b.committed_at, u.username AS resolved_by_username
                           FROM duplicate_candidates dc
                           LEFT JOIN import_batches b ON b.id = dc.batch_id
                           LEFT JOIN admin_users u ON u.id = dc.resolved_by
                           WHERE ${where} ORDER BY dc.id DESC LIMIT ? OFFSET ?`).all(...args, size, (pg - 1) * size);
  return { items: rows.map((c) => candidateView(db, c)), total, page: pg, pageSize: size };
}

/** Move everything that references `removeId` onto `keepId`, then delete `removeId`. Returns move counts. */
function mergePlants(db, keepId, removeId, { candidateId, userId, now }) {
  const moved = {};
  const move = (table, col = 'plant_id') => {
    moved[col === 'plant_id' ? table : `${table}.${col}`] = Number(db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`).run(keepId, removeId).changes);
  };
  for (const t of ['water_tests', 'plant_sources', 'reports', 'ratings', 'investigations', 'plant_status_history', 'appeals', 'import_rows']) move(t);
  move('duplicate_candidates', 'plant_id');
  move('duplicate_candidates', 'other_plant_id');
  // Candidates that now point at the same plant on both sides are settled by this merge.
  db.prepare(`UPDATE duplicate_candidates SET other_plant_id = NULL,
                status = CASE WHEN status = 'open' THEN 'merged' ELSE status END,
                resolution_note = COALESCE(resolution_note, ?), resolved_by = COALESCE(resolved_by, ?), resolved_at = COALESCE(resolved_at, ?)
              WHERE plant_id = ? AND other_plant_id = ? AND id != ?`)
    .run(`Settled by merge in duplicate candidate ${candidateId}.`, userId, now, keepId, keepId, candidateId);
  // One rating per reporter per plant: after a merge the newest rating replaces older ones (ratings rule, §6).
  moved.ratingsSuperseded = Number(db.prepare(`DELETE FROM ratings WHERE plant_id = ? AND reporter_id IS NOT NULL AND id NOT IN (
      SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY reporter_id ORDER BY created_at DESC, id DESC) AS rn
                      FROM ratings WHERE plant_id = ? AND reporter_id IS NOT NULL) WHERE rn = 1)`).run(keepId, keepId).changes);
  db.prepare('DELETE FROM plants WHERE id = ?').run(removeId);
  return moved;
}

function freeDerivedCode(db, code) {
  const taken = db.prepare('SELECT 1 FROM plants WHERE plant_code = ?');
  for (let k = 2; k < 10000; k++) if (!taken.get(`${code}-DUP${k}`)) return `${code}-DUP${k}`;
  throw new HttpError(409, 'conflict', 'No free derived code is available.');
}

function resolveDuplicate(id, { action, note }, { req = null, actorLabel = null } = {}) {
  const db = getDb();
  const userId = req && req.user ? req.user.id : null;
  return tx(() => {
    const c = db.prepare('SELECT * FROM duplicate_candidates WHERE id = ?').get(Number(id));
    if (!c) throw new HttpError(404, 'not_found', 'Duplicate candidate not found.');
    if (c.status !== 'open') throw new HttpError(409, 'already_resolved', `This candidate is already ${c.status}.`);
    const now = nowIso();
    const before = { status: c.status, plantId: c.plant_id, otherPlantId: c.other_plant_id, importRowId: c.import_row_id, reason: c.reason };
    const close = (status, extra = {}) => {
      db.prepare('UPDATE duplicate_candidates SET status = ?, resolution_note = ?, resolved_by = ?, resolved_at = ?, other_plant_id = ? WHERE id = ?')
        .run(status, extra.note || note, userId, now, 'otherPlantId' in extra ? extra.otherPlantId : c.other_plant_id, c.id);
    };
    const inFile = c.reason === 'duplicate_plant_code' && !!c.import_row_id;
    let result;

    if (action === 'merge') {
      if (!c.plant_id || !c.other_plant_id) {
        throw new HttpError(400, 'merge_not_applicable', 'Only two existing plants can be merged. For a repeated Plant ID row use keep_separate or dismiss.');
      }
      const kept = db.prepare('SELECT * FROM plants WHERE id = ?').get(c.plant_id);
      const removed = db.prepare('SELECT * FROM plants WHERE id = ?').get(c.other_plant_id);
      if (!kept || !removed) throw new HttpError(409, 'conflict', 'One of the plants no longer exists.');
      // Detach before the removed plant is deleted (the FK would cascade-delete this candidate).
      close('merged', { otherPlantId: null, note: `${note} [Merged ${removed.plant_code} into ${kept.plant_code}.]` });
      const moved = mergePlants(db, kept.id, removed.id, { candidateId: c.id, userId, now });
      audit(req, {
        action: 'plant.merge', entityType: 'plant', entityId: kept.plant_code,
        before: { removedPlant: { ...removed } }, after: { keptPlant: kept.plant_code, removedPlant: removed.plant_code, moved }, reason: note, actorLabel,
      });
      result = { status: 'merged', keptPlant: kept.plant_code, removedPlant: removed.plant_code, moved };
    } else if (action === 'keep_separate') {
      if (inFile) {
        const row = db.prepare('SELECT * FROM import_rows WHERE id = ?').get(c.import_row_id);
        if (!row) throw new HttpError(409, 'conflict', 'The held import row no longer exists.');
        if (row.plant_id) throw new HttpError(409, 'conflict', 'This row has already been imported.');
        const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(row.batch_id);
        const entry = parseJson(row.normalized_json, {});
        const collides = !!db.prepare('SELECT 1 FROM plants WHERE plant_code = ?').get(entry.code);
        const code = collides ? freeDerivedCode(db, entry.code) : entry.code;
        const plantId = insertEntry(db, entry, {
          code, batchId: row.batch_id, now, linkArea: makeAreaLinker(db, now), extraReasons: collides ? ['duplicate_plant_code'] : [],
        });
        addExtras(db, plantId, entry, { userId, now, sourceFile: batch ? batch.source_filename : entry.plant.source_file, sheet: batch ? batch.sheet_name : entry.plant.source_sheet, rowNumber: row.row_number });
        db.prepare('UPDATE import_rows SET plant_id = ? WHERE id = ?').run(plantId, row.id);
        close('kept_separate');
        audit(req, {
          action: 'plant.import_create', entityType: 'plant', entityId: code,
          after: { batchId: row.batch_id, row: row.row_number, sourceCode: entry.code, derivedCode: collides ? code : null, duplicateCandidateId: c.id }, reason: note, actorLabel,
        });
        result = { status: 'kept_separate', importedPlant: code, derivedCode: collides, needsReview: collides };
      } else {
        close('kept_separate');
        result = { status: 'kept_separate' };
      }
    } else if (action === 'dismiss') {
      close('dismissed');
      result = { status: 'dismissed' };
    } else {
      throw new HttpError(400, 'invalid_input', 'action must be one of: merge, keep_separate, dismiss', { field: 'action' });
    }
    audit(req, { action: 'duplicate.resolve', entityType: 'duplicate_candidate', entityId: c.id, before, after: { action, ...result }, reason: note, actorLabel });
    return { id: c.id, ...result };
  });
}

module.exports = { listDuplicates, resolveDuplicate, mergePlants, STATUSES, REASONS };
