import { execFile, spawn } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { FastifyBaseLogger } from 'fastify';

const execFileAsync = promisify(execFile);
const PNPM_BIN = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\"'\"'`)}'`;

/**
 * 重启宽限期：部署已触发但还有对局在跑时，进入「更新排队」状态等待对局
 * 自然结束；超过宽限期仍未结束的对局按当前排行榜名次强制清算后重启。
 * 可用 ROKA_DEPLOY_GRACE_MS 覆盖（主要用于测试）。
 */
const parsedGraceMs = Number.parseInt(String(process.env.ROKA_DEPLOY_GRACE_MS ?? ''), 10);
const UPDATE_GRACE_MS = Number.isFinite(parsedGraceMs) && parsedGraceMs > 0 ? parsedGraceMs : 120_000;

interface WebhookUpdaterHooks {
  /** 进入「更新排队」状态（有对局在跑、推迟重启）：广播禁开局与对局横幅；参数为宽限期毫秒数。 */
  onUpdateQueued?: (graceMs: number) => void;
  /** 宽限期到期：清算所有残余对局（按当前排行榜名次结算）。 */
  onGraceExpired?: () => void;
  /** 部署流程未执行重启而结束（更新失败或 dry-run 演练）：解除排队状态。 */
  onUpdateAborted?: () => void;
}

class WebhookUpdater {
  private isUpdating = false;

  private hasQueuedUpdate = false;

  private graceTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly logger: FastifyBaseLogger,
    private readonly webhookSecret: string,
    private readonly hasActiveGames: () => boolean,
    private readonly hooks: WebhookUpdaterHooks = {},
  ) {}

  isAuthorized(rawBody: Buffer, headers: Record<string, unknown>): boolean {
    const githubSignature = this.readHeader(headers, 'x-hub-signature-256');
    if (githubSignature) {
      return this.verifyGithubSignature(rawBody, githubSignature);
    }

    const directSecret =
      this.readHeader(headers, 'x-webhook-secret') ?? this.readHeader(headers, 'x-kana-webhook-secret');
    if (directSecret) {
      return this.safeEqual(directSecret, this.webhookSecret);
    }

    return false;
  }

  requestUpdate(): boolean {
    if (this.isUpdating) {
      this.hasQueuedUpdate = true;
      return true;
    }

    if (this.hasActiveGames()) {
      this.enterQueuedState();
      return true;
    }

    this.isUpdating = true;
    void this.runUpdatePipeline();
    return false;
  }

  /** 一局对局结束时调用；若已无进行中的对局且有排队中的更新，则立即开始更新。 */
  notifyGameEnded(): void {
    if (!this.hasQueuedUpdate || this.isUpdating || this.hasActiveGames()) {
      return;
    }
    this.clearGraceTimer();
    this.hasQueuedUpdate = false;
    this.requestUpdate();
  }

  /**
   * 进入「更新排队」状态：通知服务层广播（禁开局 + 对局横幅），并启动
   * 宽限期计时——到期后清算残余对局（清算完成的 endGame 会接力触发
   * notifyGameEnded 开始更新）。已在排队状态时不重置计时。
   */
  private enterQueuedState(): void {
    if (this.hasQueuedUpdate) {
      return;
    }
    this.hasQueuedUpdate = true;
    this.logger.info(
      `有对局正在进行，自动更新进入排队状态：${UPDATE_GRACE_MS / 1000} 秒宽限期内禁止开新局，到期按当前名次清算残余对局。`,
    );
    this.hooks.onUpdateQueued?.(UPDATE_GRACE_MS);
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.logger.info('更新宽限期到期，按当前名次清算残余对局。');
      this.hooks.onGraceExpired?.();
      // 清算是异步的：仍有对局在收尾时由 notifyGameEnded 接力；已清空时立即继续。
      this.notifyGameEnded();
    }, UPDATE_GRACE_MS);
    this.graceTimer.unref();
  }

  private clearGraceTimer(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  private async runUpdatePipeline(): Promise<void> {
    let shouldDequeue = true;
    try {
      this.logger.info('收到 webhook，开始自动更新。');
      if (process.env.ROKA_DEPLOY_DRY_RUN === '1') {
        // 演练模式（测试/验证用）：跳过实际部署命令与重启，仅走完整状态机。
        this.logger.info('ROKA_DEPLOY_DRY_RUN=1：跳过 git/pnpm 部署命令与进程重启。');
        shouldDequeue = false;
        this.hooks.onUpdateAborted?.();
        return;
      }
      await this.runCommand('git', ['fetch', 'origin', 'main'], 'git fetch origin main');
      await this.runCommand('git', ['checkout', '-f', 'main'], 'git checkout -f main');
      await this.runCommand('git', ['reset', '--hard', 'origin/main'], 'git reset --hard origin/main');
      await this.runCommand(PNPM_BIN, ['install', '--frozen-lockfile'], 'pnpm install --frozen-lockfile');
      await this.runCommand(PNPM_BIN, ['run', 'build'], 'pnpm run build');
      this.logger.info('自动更新完成，准备重启进程。');
      shouldDequeue = false;
      this.restartProcess();
    } catch (error) {
      this.logger.error({ err: error }, '自动更新失败。');
      // 没有重启发生：解除排队状态，恢复开新局与前端提示。
      this.hooks.onUpdateAborted?.();
    } finally {
      this.isUpdating = false;
      if (shouldDequeue && this.hasQueuedUpdate) {
        this.hasQueuedUpdate = false;
        this.requestUpdate();
      }
    }
  }

  private verifyGithubSignature(rawBody: Buffer, signature: string): boolean {
    if (!signature.startsWith('sha256=')) {
      return false;
    }

    const expected = `sha256=${createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex')}`;
    return this.safeEqual(signature, expected);
  }

  private safeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length) {
      return false;
    }
    return timingSafeEqual(leftBuffer, rightBuffer);
  }

  private readHeader(headers: Record<string, unknown>, key: string): string | null {
    const value = headers[key];
    if (typeof value === 'string') {
      return value;
    }
    if (Array.isArray(value) && typeof value[0] === 'string') {
      return value[0];
    }
    return null;
  }

  private async runCommand(command: string, args: string[], label: string): Promise<void> {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: process.cwd(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      });

      if (stdout.trim()) {
        this.logger.info({ output: this.limitOutput(stdout) }, `${label} 输出`);
      }
      if (stderr.trim()) {
        this.logger.warn({ output: this.limitOutput(stderr) }, `${label} 警告输出`);
      }
    } catch (error) {
      const commandText = [command, ...args].join(' ');
      if (error && typeof error === 'object') {
        const maybeOutput = error as { stdout?: string; stderr?: string };
        if (typeof maybeOutput.stdout === 'string' && maybeOutput.stdout.trim()) {
          this.logger.error({ output: this.limitOutput(maybeOutput.stdout) }, `${commandText} 标准输出`);
        }
        if (typeof maybeOutput.stderr === 'string' && maybeOutput.stderr.trim()) {
          this.logger.error({ output: this.limitOutput(maybeOutput.stderr) }, `${commandText} 错误输出`);
        }
      }
      throw error;
    }
  }

  private limitOutput(output: string): string {
    if (output.length <= 4000) {
      return output;
    }
    return `${output.slice(0, 4000)}\n...(truncated)`;
  }

  private restartProcess(): void {
    if (process.env.INVOCATION_ID || process.env.SYSTEMD_EXEC_PID) {
      process.exit(0);
      return;
    }

    const args = process.argv.slice(1);
    const command = [shellQuote(process.execPath), ...args.map(shellQuote)].join(' ');
    const script = `sleep 1; cd ${shellQuote(process.cwd())}; ${command}`;

    const child = spawn('sh', ['-c', script], {
      detached: true,
      env: process.env,
      stdio: 'ignore',
    });
    child.unref();

    process.exit(0);
  }
}

export { WebhookUpdater };
export type { WebhookUpdaterHooks };
