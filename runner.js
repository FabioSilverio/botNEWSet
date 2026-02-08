/**
 * SUPERVISOR — Reinicia o bot automaticamente se ele cair.
 *
 * Uso: node runner.js
 *
 * - Monitora o processo do bot
 * - Se o bot crashar, espera 5s e reinicia
 * - Se crashar muitas vezes em sequência, aumenta o delay (backoff)
 * - Grava logs em .runner.log
 * - Mata processos zumbis antes de iniciar
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const BOT_SCRIPT = path.join(__dirname, 'dist', 'index.js');
const LOG_FILE = path.join(__dirname, '.runner.log');
const PID_FILE = path.join(__dirname, '.runner.pid');

// --- Config ---
const MIN_RESTART_DELAY = 3000;     // 3s
const MAX_RESTART_DELAY = 60000;    // 60s
const BACKOFF_MULTIPLIER = 2;
const CRASH_WINDOW = 60000;         // Se crashar 5x em 60s, aumenta delay
const MAX_CRASHES_IN_WINDOW = 5;

let currentDelay = MIN_RESTART_DELAY;
let crashTimestamps = [];
let botProcess = null;
let isQuitting = false;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

// --- Mata todos os processos node que rodam index.js (exceto este runner) ---
function killZombies() {
  try {
    // No Windows, usa tasklist pra achar processos node e mata se não for o runner
    if (process.platform === 'win32') {
      const list = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH', { encoding: 'utf-8' });
      const pids = list.split('\n')
        .filter(l => l.includes('node.exe'))
        .map(l => {
          const match = l.match(/"node\.exe","(\d+)"/);
          return match ? parseInt(match[1], 10) : null;
        })
        .filter(pid => pid && pid !== process.pid);

      for (const pid of pids) {
        // Verifica se é um processo do bot (checa a linha de comando)
        try {
          const cmdline = execSync(`wmic process where processid=${pid} get commandline /format:list`, { encoding: 'utf-8' });
          if (cmdline.includes('index.js') && !cmdline.includes('runner.js')) {
            log(`Matando processo zumbi PID ${pid}`);
            execSync(`taskkill /F /PID ${pid}`, { encoding: 'utf-8' });
          }
        } catch {}
      }
    }
  } catch (e) {
    log(`Erro ao matar zumbis: ${e.message}`);
  }
}

// --- Grava PID do runner ---
function writePid() {
  try {
    fs.writeFileSync(PID_FILE, process.pid.toString(), 'utf-8');
  } catch {}
}

function removePid() {
  try {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  } catch {}
}

// --- Inicia o bot ---
function startBot() {
  if (isQuitting) return;

  killZombies();

  log(`Iniciando bot... (delay atual: ${currentDelay}ms)`);

  botProcess = spawn('node', [BOT_SCRIPT], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: __dirname,
    env: { ...process.env },
  });

  log(`Bot iniciado PID: ${botProcess.pid}`);

  // Redireciona stdout/stderr do bot
  botProcess.stdout.on('data', (data) => {
    const lines = data.toString().trim();
    if (lines) {
      console.log(lines);
      try { fs.appendFileSync(LOG_FILE, lines + '\n'); } catch {}
    }
  });

  botProcess.stderr.on('data', (data) => {
    const lines = data.toString().trim();
    if (lines) {
      console.error(lines);
      try { fs.appendFileSync(LOG_FILE, '[ERR] ' + lines + '\n'); } catch {}
    }
  });

  // Quando o bot morre
  botProcess.on('exit', (code, signal) => {
    if (isQuitting) {
      log('Bot parado pelo runner. Não reiniciando.');
      return;
    }

    log(`Bot morreu! Code: ${code}, Signal: ${signal}`);

    // Tracked crash
    const now = Date.now();
    crashTimestamps.push(now);
    crashTimestamps = crashTimestamps.filter(t => now - t < CRASH_WINDOW);

    if (crashTimestamps.length >= MAX_CRASHES_IN_WINDOW) {
      currentDelay = Math.min(currentDelay * BACKOFF_MULTIPLIER, MAX_RESTART_DELAY);
      log(`Muitos crashes recentes (${crashTimestamps.length}x em ${CRASH_WINDOW / 1000}s). Aumentando delay para ${currentDelay}ms`);
    } else {
      // Reset delay se tá estável
      currentDelay = MIN_RESTART_DELAY;
    }

    log(`Reiniciando em ${currentDelay / 1000}s...`);
    setTimeout(startBot, currentDelay);
  });

  botProcess.on('error', (err) => {
    log(`Erro ao iniciar bot: ${err.message}`);
    setTimeout(startBot, currentDelay);
  });
}

// --- Graceful shutdown do runner ---
function quit(signal) {
  if (isQuitting) return;
  isQuitting = true;
  log(`Runner recebeu ${signal}. Parando bot...`);

  if (botProcess && !botProcess.killed) {
    botProcess.kill('SIGTERM');
    // Espera 3s e força
    setTimeout(() => {
      if (botProcess && !botProcess.killed) {
        botProcess.kill('SIGKILL');
      }
      removePid();
      process.exit(0);
    }, 3000);
  } else {
    removePid();
    process.exit(0);
  }
}

process.on('SIGINT', () => quit('SIGINT'));
process.on('SIGTERM', () => quit('SIGTERM'));
process.on('uncaughtException', (err) => {
  log(`Runner uncaught exception: ${err.message}`);
});

// --- Main ---
log('=== NEWS AGGREGATOR RUNNER INICIADO ===');
log(`Runner PID: ${process.pid}`);
writePid();
startBot();
