const { spawnSync } = require("child_process")
const path = require("path")
const fs = require("fs")

function run(cmd, args, cwd) {
  console.log(`\n> ${cmd} ${args.join(" ")}\n`)
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: true })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const root = path.join(__dirname, "..")
const serverDir = path.join(root, "server")
const clientDir = path.join(root, "client")
const isWin = process.platform === "win32"

run("npm", ["install"], root)
run("npm", ["install"], clientDir)

const venvPython = isWin
  ? path.join(serverDir, ".venv", "Scripts", "python.exe")
  : path.join(serverDir, ".venv", "bin", "python")

if (!fs.existsSync(venvPython)) {
  run(isWin ? "python" : "python3", ["-m", "venv", ".venv"], serverDir)
}

const pip = isWin
  ? path.join(serverDir, ".venv", "Scripts", "pip.exe")
  : path.join(serverDir, ".venv", "bin", "pip")

run(pip, ["install", "-r", "requirements.txt"], serverDir)

console.log("\nSetup complete. Run: npm start\n")
