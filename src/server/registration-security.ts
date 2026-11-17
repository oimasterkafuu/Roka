import type { UserStore } from '../auth-store';
import {
  REGISTRATION_DENIAL_MS,
  REGISTRATION_MAX_SUCCESSFUL_PER_WINDOW,
  REGISTRATION_WINDOW_MS,
  SecurityAuditStore,
} from './security-audit';
import { inspectUsername } from './username-policy';

export type RegistrationReview =
  | { allowed: true; relatedBannedUsernames: string[] }
  | { allowed: false; status: number; error: string; retryAfter?: number };

export class RegistrationSecurity {
  constructor(
    private readonly userStore: UserStore,
    private readonly audit: SecurityAuditStore,
    private readonly now = Date.now,
  ) {}

  async review(usernameInput: string, ip: string | null): Promise<RegistrationReview> {
    const username = usernameInput.trim();
    if (inspectUsername(username).violated) {
      await this.audit.record({
        at: this.now(),
        type: 'username_rejected',
        action: 'reject_registration',
        reason: '用户名违反社区规范',
        username: username.slice(0, 100),
        ip: ip ?? undefined,
      });
      return { allowed: false, status: 400, error: '用户名不符合社区规范，请更换。' };
    }
    if (!ip) return { allowed: true, relatedBannedUsernames: [] };

    const now = this.now();
    const latestDenial = this.audit.latest('registration_rate_limited', ip);
    if (latestDenial && now - latestDenial.at < REGISTRATION_DENIAL_MS) {
      return this.deny(ip, username, now, latestDenial.at + REGISTRATION_DENIAL_MS - now, true);
    }

    const successful = this.userStore
      .listUsersForAdmin()
      .filter(
        (user) =>
          user.registeredIp === ip && user.createdAt <= now && now - user.createdAt < REGISTRATION_WINDOW_MS,
      ).length;
    if (successful >= REGISTRATION_MAX_SUCCESSFUL_PER_WINDOW) {
      return this.deny(ip, username, now, REGISTRATION_DENIAL_MS, true);
    }

    const relatedBannedUsernames = this.userStore
      .listUsersForAdmin()
      .filter(
        (user) =>
          user.bannedUntil === -1 &&
          [user.registeredIp, user.lastIp, ...(user.ipHistory ?? []).map((item) => item.ip)].includes(ip),
      )
      .map((user) => user.username);
    return { allowed: true, relatedBannedUsernames };
  }

  async afterRegistration(
    username: string,
    ip: string | null,
    relatedBannedUsernames: string[],
  ): Promise<void> {
    if (!ip || relatedBannedUsernames.length === 0) return;
    await this.audit.record({
      at: this.now(),
      type: 'possible_ban_evasion',
      action: 'flag_for_review',
      reason: '新注册账号与有效永久封禁账号使用相同 IP',
      username,
      ip,
      relatedUsernames: relatedBannedUsernames,
    });
  }

  private async deny(
    ip: string,
    username: string,
    now: number,
    retryAfterMs: number,
    writeEvent: boolean,
  ): Promise<RegistrationReview> {
    if (writeEvent) {
      await this.audit.record({
        at: now,
        type: 'registration_rate_limited',
        action: 'reject_registration',
        reason: '同一真实 IP 在滚动 24 小时内注册账号过多',
        username: username.slice(0, 100),
        ip,
      });
    }
    return {
      allowed: false,
      status: 429,
      error: '注册过于频繁，请 24 小时后再试。',
      retryAfter: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    };
  }
}
