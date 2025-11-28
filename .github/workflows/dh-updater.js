#!/usr/bin/env node

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function execFileAsync(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, options, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

function walkFiles(rootDir) {
  const results = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        results.push(full);
      }
    }
  }
  walk(rootDir);
  return results;
}

async function main() {
  const exePath = process.argv[2];
  const zipDir = process.argv[3];
  const zipPath = process.argv[4];
  const urlsArg = process.argv[5] || ""; // ví dụ "https://...,https://..."

  if (!exePath || !zipDir || !zipPath) {
    console.error("Usage: node dh-updater.js <exePath> <zipDir> <zipPath> [urlsCommaSeparated]");
    process.exit(1);
  }

  const absExePath = path.resolve(exePath);
  const absZipDir = path.resolve(zipDir);
  const absZipPath = path.resolve(zipPath);

  if (!fs.existsSync(absExePath)) {
    console.error("❌ EXE không tồn tại:", absExePath);
    process.exit(1);
  }
  if (!fs.existsSync(absZipDir) || !fs.statSync(absZipDir).isDirectory()) {
    console.error("❌ Thư mục zipDir không tồn tại hoặc không phải thư mục:", absZipDir);
    process.exit(1);
  }

  // 1. Lấy version từ EXE bằng strings
  console.log("🔍 Đọc version từ:", absExePath);
  const { stdout: stringsOut } = await execFileAsync("strings", [absExePath]);
  const versionMatch = stringsOut.match(/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/);
  if (!versionMatch) {
    console.error("❌ Không tìm thấy version dạng x.x.x.x trong EXE");
    process.exit(1);
  }
  const version = versionMatch[0];
  console.log("✅ Version:", version);

  // 2. Zip thư mục
  const rootDir = path.dirname(absZipDir);
  const baseName = path.basename(absZipDir);

  const excludeRaw = process.env.EXCLUDE_PATTERNS || "";
  const excludePatterns = excludeRaw
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const zipArgs = ["-r", absZipPath, baseName];
  for (const p of excludePatterns) {
    // patterns relative to base folder: publish/**, bin/** ...
    zipArgs.push("-x", `${baseName}/${p}`);
  }

  console.log("📦 Tạo zip:");
  console.log("  - Từ thư mục:", absZipDir);
  console.log("  - Zip file  :", absZipPath);
  if (excludePatterns.length) {
    console.log("  - Excludes  :", excludePatterns.join(", "));
  }

  await execFileAsync("zip", zipArgs, { cwd: rootDir });
  console.log("✅ Đã tạo zip");

  // 3. Tính sha512 (base64) cho zip
  const zipBuffer = fs.readFileSync(absZipPath);
  const sha512 = crypto.createHash("sha512").update(zipBuffer).digest("base64");
  console.log("🔐 SHA512 (base64) của zip:", sha512.substring(0, 32) + "...");

  // 4. Tính md5 cho các file trong zipDir
  console.log("🧮 Tính MD5 cho các file trong:", absZipDir);
  const files = walkFiles(absZipDir);
  const fileMd5 = {};
  for (const f of files) {
    const rel = path.relative(absZipDir, f).replace(/\\/g, "/");
    const buf = fs.readFileSync(f);
    const md5 = crypto.createHash("md5").update(buf).digest("hex");
    fileMd5[rel] = md5;
  }

  // 5. Build metadata JSON/XML
  const urls = urlsArg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const exeBaseName = path.basename(absExePath);
  const jsonPath = path.resolve(`${exeBaseName}.dh.updater.json`);
  const xmlPath = path.resolve(`${exeBaseName}.dh.updater.xml`);

  const jsonMeta = {
    version,
    sha512,
    package_type: "zip",
    urls,
    file_md5: fileMd5,
  };

  fs.writeFileSync(jsonPath, JSON.stringify(jsonMeta, null, 2), "utf8");

  // XML
  function xmlEscape(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }

  let xml = "";
  xml += "<update>\n";
  xml += `  <version>${xmlEscape(version)}</version>\n`;
  xml += `  <sha512>${xmlEscape(sha512)}</sha512>\n`;
  xml += "  <package_type>zip</package_type>\n";
  xml += "  <urls>\n";
  for (const u of urls) {
    xml += `    <url>${xmlEscape(u)}</url>\n`;
  }
  xml += "  </urls>\n";
  xml += "  <file_md5>\n";
  for (const relPath in fileMd5) {
    xml += `    <file path="${xmlEscape(relPath)}" md5="${xmlEscape(fileMd5[relPath])}" />\n`;
  }
  xml += "  </file_md5>\n";
  xml += "</update>\n";

  fs.writeFileSync(xmlPath, xml, "utf8");

  console.log("📝 Đã tạo metadata:");
  console.log("  - JSON:", jsonPath);
  console.log("  - XML :", xmlPath);

  // 6. In JSON output cho GitHub Actions
  const output = {
    version,
    exe_path: absExePath,
    zip_dir: absZipDir,
    zip_path: absZipPath,
    json_path: jsonPath,
    xml_path: xmlPath,
    sha512,
    file_md5: fileMd5,
    urls,
  };

  console.log("UPDATER_OUTPUT_JSON:" + JSON.stringify(output));
}

main().catch((err) => {
  console.error("❌ Lỗi:", err.message || err);
  process.exit(1);
});
