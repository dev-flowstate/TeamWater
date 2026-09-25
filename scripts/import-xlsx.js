'use strict';
// Import a plant spreadsheet from the command line.
//   npm run import:xlsx -- <path.xlsx|path.csv> [--sheet NAME] [--dry-run] [--errors out.csv] [--no-update]
//
//   --sheet NAME     sheet to import (default: the first sheet with data)
//   --dry-run        validate and report only; nothing is written to the database
//   --errors FILE    write every error/warning/notice to a CSV file
//   --no-update      leave plants that already exist unchanged
// Uses the same pipeline as the admin screen (server/import/pipeline.js); DATA_DIR / DB_PATH select the database.
const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const out = { file: null, sheet: null, dryRun: false, errors: null, updateExisting: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sheet') out.sheet = argv[++i];
    else if (a.startsWith('--sheet=')) out.sheet = a.slice(8);
    else if (a === '--errors') out.errors = argv[++i];
    else if (a.startsWith('--errors=')) out.errors = a.slice(9);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-update') out.updateExisting = false;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else if (!out.file) out.file = a;
    else throw new Error(`Unexpected argument ${a}`);
  }
  if ((out.sheet === undefined) || (out.errors === undefined)) throw new Error('--sheet and --errors need a value');
  return out;
}

function table(rows) {
  const w = Math.max(...rows.map(([k]) => String(k).length));
  return rows.map(([k, v]) => `  ${String(k).padEnd(w)}  ${v}`).join('\n');
}

function printSummary(s) {
  console.log(`\n${s.dryRun ? 'DRY RUN — nothing was written.' : 'Import committed.'}`);
  console.log(table([
    ['Source file', s.sourceFile], ['Sheet', s.sheet], ['Batch', s.batchId ?? '—'], ['Imported at', s.importedAt ?? '—'],
    ['Rows', s.total], ['New', s.new], ['Updated', s.update], ['Unchanged', s.unchanged], ['Rejected', s.rejected],
    ['Held (duplicate ID)', s.duplicateReview], ['Incomplete', s.incomplete],
    ['Likely duplicates', s.likelyDuplicates ?? 0], ...(s.dryRun ? [] : [['Geocoded (pending review)', s.geocoded ?? 0]]),
  ]));
  const issues = Object.entries(s.issues || {}).sort((a, b) => b[1] - a[1]);
  if (issues.length) {
    console.log('\nData issues (rows affected):');
    console.log(table(issues));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.file) {
    console.log('Usage: npm run import:xlsx -- <path.xlsx|path.csv> [--sheet NAME] [--dry-run] [--errors out.csv] [--no-update]');
    process.exit(args.help ? 0 : 1);
  }
  const filePath = path.resolve(args.file);
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const config = require('../server/config');
  const pipeline = require('../server/import/pipeline');
  if (!args.dryRun) console.log('Database:', config.dbPath);

  const summary = await pipeline.importFromFile({
    filePath, sheet: args.sheet || undefined, dryRun: args.dryRun, updateExisting: args.updateExisting, actorLabel: 'cli',
  });
  printSummary(summary);
  if (args.errors) {
    const csv = args.dryRun ? summary.errorsCsv : pipeline.errorsCsv(summary.batchId);
    fs.writeFileSync(path.resolve(args.errors), csv);
    console.log(`\nIssues written to ${path.resolve(args.errors)} (${csv.split('\r\n').length - 2} lines).`);
  }
}

main().catch((err) => {
  console.error(`Import failed: ${err.message}`);
  if (err.details) console.error(JSON.stringify(err.details));
  process.exit(1);
});
