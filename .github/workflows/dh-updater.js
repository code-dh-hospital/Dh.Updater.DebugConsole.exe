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

function parseExcludePatterns(raw) {
  return raw
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// match đơn giản đủ dùng cho mấy pattern mình đang xài
function isExcluded(relPath, patterns) {
  const p = relPath.replace(/\\/g, "/");

  for (const pat of patterns) {
    if (!pat) continue;
    const pattern = pat.replace(/\\/g, "/");

    // thư mục: xxx/**  hoặc .git/**
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3); // bỏ /**
      if (p === prefix || p.startsWith(prefix + "/")) return true;
      continue;
    }

    // file theo đuôi: *.pdb
    if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1); // ".pdb"
      if (p.endsWith(ext)) return true;
      continue;
    }

    // khớp chính xác tên (ít dùng)
    if (p === pattern) return true;
  }

  return false;
}

function walkFiles(rootDir, patterns, extraExcludes = []) {
  const results = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(rootDir, full).replace(/\\/g, "/");

      // bỏ qua các file/thư mục thêm tay (vd: chính file zip)
      if (extraExcludes.includes(rel)) continue;

      if (e.isDirectory()) {
        if (isExcluded(rel + "/dummy", patterns)) continue; // nếu pattern dạng dir/** trúng
        walk(full);
      } else if (e.isFile()) {
        if (isExcluded(rel, patterns)) continue;
        results.push({ full, rel });
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
  const urlsArg = process.argv[5] || "";

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

  // 1. Lấy version từ EXE
  console.log("🔍 Đọc version từ:", absExePath);
  const { stdout: stringsOut } = await execFileAsync("strings", [absExePath]);
  const versionMatch = stringsOut.match(/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/);
  if (!versionMatch) {
    console.error("❌ Không tìm thấy version dạng x.x.x.x trong EXE");
    process.exit(1);
  }
  const version = versionMatch[0];
  console.log("✅ Version:", version);

  // 2. Chuẩn bị exclude
  const excludePatterns = parseExcludePatterns(process.env.EXCLUDE_PATTERNS || "");
  console.log("❗ EXCLUDE_PATTERNS:", excludePatterns.join(", ") || "(none)");

  // tự exclude luôn file zip nếu nó nằm trong ZIP_DIR
  let relZipInDir = null;
  if (absZipPath.startsWith(absZipDir)) {
    relZipInDir = path.relative(absZipDir, absZipPath).replace(/\\/g, "/");
    console.log("❗ Tự exclude file zip khỏi chính nó:", relZipInDir);
  }

  // 3. Tạo zip: chạy zip từ trong ZIP_DIR
  console.log("📦 Tạo zip:");
  console.log("  - CWD      :", absZipDir);
  console.log("  - Zip file :", absZipPath);
  const zipArgs = ["-r", absZipPath, "."];

  for (const pat of excludePatterns) {
    if (!pat) continue;
    // pattern dùng trực tiếp, vì đang ở trong ZIP_DIR
    zipArgs.push("-x", pat);
  }
  if (relZipInDir) {
    zipArgs.push("-x", relZipInDir);
  }

  await execFileAsync("zip", zipArgs, { cwd: absZipDir });
  console.log("✅ Đã tạo zip");

  // 4. SHA512 (base64) của zip
  const zipBuffer = fs.readFileSync(absZipPath);
  const sha512 = crypto.createHash("sha512").update(zipBuffer).digest("base64");
  console.log("🔐 SHA512 (base64) của zip:", sha512.substring(0, 32) + "...");

  // 5. Tính MD5 cho các file (đã exclude) trong ZIP_DIR
  console.log("🧮 Tính MD5 cho các file (đã áp dụng exclude) trong:", absZipDir);
  const files = walkFiles(absZipDir, excludePatterns, relZipInDir ? [relZipInDir] : []);
  const fileMd5 = {};
  for (const { full, rel } of files) {
    const buf = fs.readFileSync(full);
    const md5 = crypto.createHash("md5").update(buf).digest("hex");
    fileMd5[rel] = md5;
  }

  // 6. Build metadata JSON/XML
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

  // 7. In JSON output cho GH Actions
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
