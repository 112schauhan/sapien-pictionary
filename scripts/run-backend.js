const { spawn } = require("child_process")
const path = require("path")
const fs = require("fs")

const serverDir = path.join(__dirname, "..", "server")
const isWin = process.platform === "win32"
const venvPython = isWin
  ? path.join(serverDir, ".venv", "Scripts", "python.exe")
  : path.join(serverDir, ".venv", "bin", "python")

const python = fs.existsSync(venvPython) ? venvPython : isWin ? "python" : "python3"

const child = spawn(
  python,
  ["-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"],
  { cwd: serverDir, stdio: "inherit", shell: false },
)

child.on("exit", (code) => process.exit(code ?? 0))
