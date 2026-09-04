const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
function scripts(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? scripts(target) : /\.(?:js|cjs|mjs)$/.test(entry.name) ? [target] : [];
  });
}
const files = [path.join(root, "server.js"), ...scripts(path.join(root, "js")), ...scripts(path.join(root, "lib")), ...scripts(path.join(root, "scripts"))];
for (const file of files) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
console.log(`Syntax OK: ${files.length} application and script files.`);
