'use strict';
// Spreadsheet imports & duplicate review (ARCHITECTURE.md §7 "Imports & duplicates"). Mounted at /api/admin.
//   POST /imports                     multipart `file` (.xlsx/.csv) -> { batchId, filename, sheets, suggestedMapping, targetFields }
//   POST /imports/:id/preview         { sheet, mapping, options: { updateExisting } } -> { summary, rows, ... }
//   GET  /imports/:id/rows?outcome=&page=&pageSize=
//   GET  /imports/:id/errors.csv?severity=error,warning,notice
//   POST /imports/:id/commit          -> { summary }
//   POST /imports/:id/cancel
//   GET  /imports                     -> { items, total, page, pageSize }
//   GET  /imports/:id                 (addition) batch detail incl. sheets/headers for reloading the mapping screen
//   GET  /duplicates?status=open      -> { items, total, page, pageSize }
//   POST /duplicates/:id/resolve      { action: 'merge'|'keep_separate'|'dismiss', note }
// Permissions: `imports` for /imports*, `duplicates` for /duplicates*. All changes are audited.
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { requirePermission } = require('../lib/auth');
const { HttpError, validate, str, oneOf } = require('../lib/http');
const pipeline = require('../import/pipeline');
const duplicates = require('../import/duplicates');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxImportBytes, files: 1, fields: 5, parts: 6 },
});

const batchId = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(404, 'not_found', 'Import batch not found.');
  return id;
};

router.get('/imports', requirePermission('imports'), (req, res) => {
  res.json(pipeline.listBatches({ page: req.query.page, pageSize: req.query.pageSize }));
});

router.post('/imports', requirePermission('imports'), upload.single('file'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'file_required', 'Attach a .xlsx or .csv file in the "file" field.', { field: 'file' });
  const result = await pipeline.createBatch({ buffer: req.file.buffer, filename: req.file.originalname, userId: req.user.id, req });
  res.status(201).json(result);
});

router.get('/imports/:id', requirePermission('imports'), async (req, res) => {
  res.json(await pipeline.getBatchDetail(batchId(req)));
});

router.post('/imports/:id/preview', requirePermission('imports'), async (req, res) => {
  const body = req.body || {};
  if (body.sheet !== undefined && body.sheet !== null && typeof body.sheet !== 'string') throw new HttpError(400, 'invalid_input', 'sheet must be text', { field: 'sheet' });
  if (body.mapping !== undefined && body.mapping !== null && (typeof body.mapping !== 'object' || Array.isArray(body.mapping))) {
    throw new HttpError(400, 'invalid_input', 'mapping must be an object of { targetField: header }', { field: 'mapping' });
  }
  const result = await pipeline.previewBatch(batchId(req), {
    sheet: body.sheet || undefined, mapping: body.mapping || undefined, options: body.options || {},
    page: body.page, pageSize: body.pageSize, outcome: body.outcome || undefined,
  });
  res.json(result);
});

router.get('/imports/:id/rows', requirePermission('imports'), (req, res) => {
  res.json(pipeline.getRows(batchId(req), { outcome: req.query.outcome || undefined, page: req.query.page, pageSize: req.query.pageSize }));
});

router.get('/imports/:id/errors.csv', requirePermission('imports'), (req, res) => {
  const id = batchId(req);
  const csv = pipeline.errorsCsv(id, { severity: req.query.severity || undefined });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="import-${id}-errors.csv"`);
  res.send(csv);
});

router.post('/imports/:id/commit', requirePermission('imports'), async (req, res) => {
  const summary = await pipeline.commitBatch(batchId(req), { userId: req.user.id, req });
  res.json({ summary });
});

router.post('/imports/:id/cancel', requirePermission('imports'), (req, res) => {
  res.json(pipeline.cancelBatch(batchId(req), { req }));
});

router.get('/duplicates', requirePermission('duplicates'), (req, res) => {
  res.json(duplicates.listDuplicates({ status: req.query.status || 'open', page: req.query.page, pageSize: req.query.pageSize }));
});

router.post('/duplicates/:id/resolve', requirePermission('duplicates'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(404, 'not_found', 'Duplicate candidate not found.');
  const { action, note } = validate(req.body, {
    action: oneOf(['merge', 'keep_separate', 'dismiss']),
    note: str({ min: 3, max: 2000 }),
  });
  res.json(duplicates.resolveDuplicate(id, { action, note }, { req }));
});

module.exports = router;
