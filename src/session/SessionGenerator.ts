import type { BotContext } from '../core/BotContext'
import type { Account } from '../core/Account'
import { executionContext } from '../core/ExecutionContext'
import { resolveAccountLocale } from '../util/Locale'
import { createAppIdentity } from '../rewards/app/AppIdentity'
import { loadResolvedRegion } from './SessionStore'
import {
    sessionPlatforms,
    type SessionGenerationOptions,
    type SessionPlatform,
    type SessionStatus
} from './SessionGeneration'

export class SessionGenerator {
    constructor(private readonly bot: BotContext) {}

    async run(accounts: Account[], options: SessionGenerationOptions): Promise<{ completed: number; failed: number }> {
        if (!accounts.length) throw new Error('No accounts configured for session regeneration')
        const platforms = sessionPlatforms(options.platform)
        let completed = 0
        let failed = 0
        this.bot.logger.info(
            'main',
            'SESSIONS-START',
            `正在创建登录会话 | accounts=${accounts.length} | platforms=${platforms.join(',')} | fresh=${options.fresh}`
        )

        for (const account of accounts) {
            this.bot.cancellation.signal.throwIfAborted()
            this.bot.accountState.reset()
            this.bot.cookies = { mobile: [], desktop: [] }
            this.bot.accessTokens = { mobile: '', desktop: '' }
            this.bot.appIdentity = createAppIdentity(account.email)
            this.bot.browser.userAgentManager.reset()
            this.bot.userData.userName = account.email
            this.bot.userData.timezone = ''
            this.bot.userData.timezoneOffset = ''
            const cachedRegion =
                account.geoLocale === 'auto'
                    ? loadResolvedRegion(this.bot.config.sessionPath, account.email)
                    : undefined
            this.bot.accountLocale = resolveAccountLocale(account, cachedRegion)
            this.bot.userData.geoLocale = this.bot.accountLocale.country ?? 'US'
            this.bot.userData.langCode = this.bot.accountLocale.language

            for (const platform of platforms) {
                this.bot.signal.throwIfAborted()
                await executionContext.run({ isMobile: platform === 'mobile', account }, async () => {
                    this.report(account.email, platform, 'running')
                    try {
                        await this.bot.sessions.signIn(account, platform === 'mobile', false, {
                            fresh: options.fresh,
                            sessionOnly: true
                        })
                        this.bot.signal.throwIfAborted()
                        completed++
                        this.report(account.email, platform, 'completed')
                    } catch (error) {
                        const reason = error instanceof Error ? error.message : String(error)
                        if (this.bot.signal.aborted) {
                            this.report(account.email, platform, 'cancelled', reason)
                            throw error
                        }
                        failed++
                        this.report(account.email, platform, 'failed', reason)
                    } finally {
                        await this.bot.sessions.closeAll()
                    }
                })
            }
        }

        this.bot.logger[failed ? 'warn' : 'success'](
            'main',
            'SESSIONS-END',
            `会话创建完成 | saved=${completed} | failed=${failed}`
        )
        return { completed, failed }
    }

    private report(
        email: string,
        platform: SessionPlatform,
        status: Exclude<SessionStatus, 'pending'>,
        reason?: string
    ): void {
        const message =
            status === 'running'
                ? `正在登录 ${email} (${platform})`
                : status === 'completed'
                  ? `已保存 ${platform} 会话用于 ${email}`
                  : `${platform} 会话 ${status} ${email}${reason ? ` | ${reason}` : ''}`
        this.bot.logger.event(platform === 'mobile', 'SESSION-GENERATION', message, {
            kind: 'session',
            email,
            platform,
            status,
            reason
        })
    }
}
