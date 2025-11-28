#!/usr/bin/env node
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const exePath = process.argv[2];
if (!exePath) {
  console.error('Usage: node extract-version.js <exe-path>');
  process.exit(1);
}

execFile('strings', [exePath], (err, stdout) => {
  if (err) {
    console.error('❌ strings failed:', err.message);
    process.exit(1);
  }

  // Ưu tiên bắt version dạng x.x.x.x
  const match = stdout.match(/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/);
  if (!match) {
    console.error('❌ No version found in file');
    process.exit(1);
  }

  const version = match[0];
  const outFile = exePath + '.version.txt';

  fs.writeFileSync(outFile, version + '\n', 'utf8');

  console.log('✅ FileVersion:', version);
  console.log('📄 Version file:', outFile);
});
