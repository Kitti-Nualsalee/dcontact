import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IMPORT_MAX_BYTES,
  buildMapping,
  canResume,
  checkImportFile,
  filterPreviewRows,
  readCsvHeaders,
  suggestSelection,
} from './customer-import/model.js';

const bytes = (text: string) => new TextEncoder().encode(text);

test('read the header as strict UTF-8: BOM, quote, CRLF, and reject a file that is not CSV', () => {
  const thaiCsv = bytes('﻿name,"บริษัท, จำกัด",email\r\na,b,c'); // allow-thai: Thai header exercises UTF-8 decoding
  assert.deepEqual(readCsvHeaders(thaiCsv), [
    'name',
    'บริษัท, จำกัด', // allow-thai: Thai header exercises UTF-8 decoding
    'email',
  ]);
  assert.deepEqual(readCsvHeaders(bytes('"a""b",c')), ['a"b', 'c']);
  assert.equal(readCsvHeaders(new Uint8Array([0xff, 0xfe, 0x41])), null);
  assert.equal(readCsvHeaders(bytes('a,a\n1,2')), null, 'duplicate header');
  assert.equal(readCsvHeaders(bytes('a,,c')), null, 'empty header');
  assert.equal(readCsvHeaders(bytes('"a')), null, 'unclosed quote');
  assert.equal(readCsvHeaders(bytes('a"b,c')), null);
  assert.equal(readCsvHeaders(bytes('a\0b,c')), null);
});

test('check the file before sending: empty, too large, or unreadable', () => {
  assert.equal(checkImportFile(0, ['a']), 'EMPTY');
  assert.equal(checkImportFile(IMPORT_MAX_BYTES + 1, ['a']), 'TOO_LARGE');
  assert.equal(checkImportFile(IMPORT_MAX_BYTES, ['a']), 'OK');
  assert.equal(checkImportFile(10, null), 'NOT_CSV');
});

test('guess the mapping from Thai/English column headers without reusing a column', () => {
  const thaiHeaders = ['ชื่อ', 'บริษัท', 'เบอร์โทร', 'E-mail', 'VIP', 'other']; // allow-thai: Thai header aliases under test
  assert.deepEqual(suggestSelection(thaiHeaders), {
    displayName: 'ชื่อ', // allow-thai: Thai header aliases under test
    company: 'บริษัท', // allow-thai: Thai header aliases under test
    phone: 'เบอร์โทร', // allow-thai: Thai header aliases under test
    email: 'E-mail',
    vip: 'VIP',
  });
  assert.deepEqual(suggestSelection(['x', 'y']), {});
});

test('build the mapping only when there is a name, and do not select a duplicate header or one missing from the file', () => {
  const headers = ['name', 'phone', 'mail'];
  assert.equal(buildMapping({}, headers, 'TH'), null);
  assert.equal(buildMapping({ displayName: 'nope' }, headers, 'TH'), null);
  assert.equal(buildMapping({ displayName: 'name', phone: 'name' }, headers, 'TH'), null);
  assert.equal(buildMapping({ displayName: 'name' }, headers, 'ZZ'), null);
  assert.deepEqual(buildMapping({ displayName: 'name', phone: 'phone' }, headers, 'TH'), {
    version: 1,
    columns: { displayName: 'name', phone: 'phone' },
    defaultPhoneCountry: 'TH',
  });
  // no country given = must be an international number, defaultPhoneCountry is not sent
  assert.deepEqual(buildMapping({ displayName: 'name' }, headers, ''), {
    version: 1,
    columns: { displayName: 'name' },
  });
});

test('filter preview rows and decide it can continue when rows with unknown or not-started results remain', () => {
  const rows = [
    { rowNo: 1, cells: ['a'], valid: true, fieldErrors: [], warnings: [] },
    {
      rowNo: 2,
      cells: ['b'],
      valid: false,
      fieldErrors: [{ field: 'phone', code: 'X' }],
      warnings: [],
    },
    { rowNo: 3, cells: ['c'], valid: true, fieldErrors: [], warnings: ['READABLE_DUPLICATE'] },
  ];
  assert.deepEqual(filterPreviewRows(rows, 'ALL').length, 3);
  assert.deepEqual(
    filterPreviewRows(rows, 'INVALID').map((row) => row.rowNo),
    [2],
  );
  assert.deepEqual(
    filterPreviewRows(rows, 'WARNING').map((row) => row.rowNo),
    [3],
  );
  const done = { applied: 2, rejected: 1, notSelected: 1, pending: 0, unknown: 0, notAttempted: 0 };
  assert.equal(canResume(done), false);
  assert.equal(canResume({ ...done, unknown: 1 }), true);
  assert.equal(canResume({ ...done, notAttempted: 3 }), true);
  assert.equal(canResume({ ...done, pending: 1 }), true);
});
