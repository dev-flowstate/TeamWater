'use strict';
// Text normalisation shared by the gazetteer, importer and search.
//   slug('Model Town') -> 'model-town'
//   areaKey('Model Town', 'Jinnah Town') -> 'model-town|jinnah-town'   (kind 'town': areaKey(name, null) -> 'town:jaranwala')
//   normalizeSearch('  ماڈل  ٹاؤن ') -> 'ماڈل ٹاؤن'  (lower-case Latin, unified Arabic-script letter variants, no diacritics)
//   parseAreaRaw('Model Town - Sector 9') -> { name: 'Model Town', sector: 'Sector 9' }
function normalizeSearch(input) {
  return String(input || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '') // zero-width & bidi controls
    .replace(/[ً-ٰٟۖ-ۭ]/g, '') // Arabic-script diacritics
    .replace(/ي/g, 'ی').replace(/ى/g, 'ی').replace(/ك/g, 'ک').replace(/ه/g, 'ہ').replace(/ة/g, 'ہ')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function slug(input) {
  return String(input || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function areaKey(name, town) {
  return town ? `${slug(name)}|${slug(town)}` : `town:${slug(name)}`;
}

function parseAreaRaw(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(.*?)\s*[-–—]\s*(Sector\s*\d+)\s*$/i);
  return m ? { name: m[1].trim(), sector: m[2].replace(/\s+/, ' ') } : { name: s || null, sector: null };
}

module.exports = { normalizeSearch, slug, areaKey, parseAreaRaw };
