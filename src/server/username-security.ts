import type { UserStore } from '../auth-store';
import {
  SecurityAuditStore,
  USERNAME_SCAN_INTERVAL_MS,
  USERNAME_SCAN_START_DELAY_MS,
  UsernameScanResult,
} from './security-audit';
import { inspectUsername } from './username-policy';

export class UsernameSecurityService {
  private running?: Promise<UsernameScanResult>;
  private initialTimer?: NodeJS.Timeout;
  private intervalTimer?: NodeJS.Timeout;

  constructor(
    private readonly userStore: UserStore,
    private readonly audit: SecurityAuditStore,
    private readonly onAutoBanned: (username: string) => Promise<void>,
    private readonly onError: (error: unknown) => void = () => undefined,
    private readonly now = Date.now,
  ) {}

  scan(): Promise<UsernameScanResult> {
    if (this.running) return this.running;
    this.running = this.performScan().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  start(delayMs = USERNAME_SCAN_START_DELAY_MS): void {
    if (this.initialTimer || this.intervalTimer) return;
    this.initialTimer = setTimeout(() => {
      this.initialTimer = undefined;
      void this.scan().catch(this.onError);
      this.intervalTimer = setInterval(() => void this.scan().catch(this.onError), USERNAME_SCAN_INTERVAL_MS);
      this.intervalTimer.unref();
    }, delayMs);
    this.initialTimer.unref();
  }

  stop(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.initialTimer = undefined;
    this.intervalTimer = undefined;
  }

  private async performScan(): Promise<UsernameScanResult> {
    const users = this.userStore.listUsersForAdmin();
    const result: UsernameScanResult = {
      scanned: users.length,
      hits: 0,
      autoBanned: 0,
      skipped: 0,
      completedAt: 0,
    };
    for (const user of users) {
      const inspection = inspectUsername(user.username);
      if (!inspection.violated) continue;
      result.hits += 1;
      if (user.isSuperAdmin || user.bannedUntil !== null) {
        result.skipped += 1;
        if (user.isSuperAdmin) {
          await this.audit.record({
            at: this.now(),
            type: 'username_manual_review',
            action: 'skip_super_admin',
            reason: '超级管理员不可自动封禁，需人工复核',
            username: user.username,
            ip: user.lastIp ?? user.registeredIp ?? undefined,
          });
        }
        continue;
      }
      await this.userStore.applyBan(user.username, -1, {
        type: 'username',
        reason: '用户名违反社区规范',
        triggeredAt: this.now(),
        evidence: `自动用户名审查命中：${user.username}`,
      });
      await this.onAutoBanned(user.username);
      await this.audit.record({
        at: this.now(),
        type: 'username_auto_banned',
        action: 'permanent_ban',
        reason: '用户名违反社区规范',
        username: user.username,
        ip: user.lastIp ?? user.registeredIp ?? undefined,
      });
      result.autoBanned += 1;
    }
    result.completedAt = this.now();
    await this.audit.record({
      at: result.completedAt,
      type: 'username_scan_completed',
      action: 'complete_scan',
      reason: '用户名全量复查完成',
      result,
    });
    return result;
  }
}
